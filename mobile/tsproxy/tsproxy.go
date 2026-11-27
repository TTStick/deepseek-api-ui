// Package tsproxy 把 userspace 的 Tailscale 节点（tsnet）暴露成本机回环上的 TCP 代理。
//
// 这样 Android 客户端只要把请求发到 127.0.0.1:<port>，流量就会经 WireGuard 隧道
// 到达 tailnet 内的服务器，而无需建立系统级 VPN（VpnService），不会接管设备流量、
// 也不需要 VPN 授权弹窗，且可与其他 VPN/代理共存。
//
// 用法（Java/Kotlin 侧经 gomobile 生成的 Tsproxy 类）：
//
//	Tsproxy.start(stateDir, hostname, authKey, "100.104.209.43:8000")
//	Tsproxy.addr()  // "127.0.0.1:54321"，ready 之后才有值
//	Tsproxy.state() // stopped | starting | ready | error
package tsproxy

import (
	"context"
	"fmt"
	"io"
	"net"
	"regexp"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

const (
	stateStopped  = "stopped"
	stateStarting = "starting"
	stateReady    = "ready"
	stateError    = "error"
)

var (
	mu       sync.Mutex
	srv      *tsnet.Server
	ln       net.Listener
	curState = stateStopped
	lastErr  = ""
	addr     = ""
	target   = ""
	selfIP   = ""
	loginURL = ""
)

// 从 tsnet 日志里抓登录链接（无 authKey 的交互登录时需要）
var authURLPattern = regexp.MustCompile(`https://login\.tailscale\.com/[a-zA-Z0-9/_-]+`)

// Start 启动 userspace tailscale 节点，并在 127.0.0.1 上监听一个随机端口，
// 把每条连接转发到 target（tailnet 内的 host:port）。重复调用是幂等的。
func Start(stateDir, hostname, authKey, targetAddr string) error {
	mu.Lock()
	defer mu.Unlock()
	if curState == stateReady || curState == stateStarting {
		return nil
	}
	target = targetAddr
	addr = ""
	selfIP = ""
	loginURL = ""
	lastErr = ""
	curState = stateStarting

	s := &tsnet.Server{
		Dir:      stateDir,
		Hostname: hostname,
		AuthKey:  authKey,
		Logf: func(format string, args ...any) {
			msg := format
			if len(args) > 0 {
				msg = fmt.Sprintf(format, args...)
			}
			if url := authURLPattern.FindString(msg); url != "" {
				mu.Lock()
				loginURL = url
				mu.Unlock()
			}
		},
	}
	srv = s

	go func() {
		// 交互登录时 Up 会一直等到用户在浏览器里完成授权，因此超时给足
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if _, err := s.Up(ctx); err != nil {
			fail(err)
			return
		}
		ip4, ip6 := s.TailscaleIPs()
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fail(err)
			return
		}
		mu.Lock()
		ln = l
		addr = l.Addr().String()
		if ip4.IsValid() {
			selfIP = ip4.String()
		} else if ip6.IsValid() {
			selfIP = ip6.String()
		}
		curState = stateReady
		mu.Unlock()

		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go forward(conn)
		}
	}()
	return nil
}

func fail(err error) {
	mu.Lock()
	curState = stateError
	lastErr = err.Error()
	mu.Unlock()
}

func forward(conn net.Conn) {
	defer conn.Close()
	mu.Lock()
	s := srv
	t := target
	mu.Unlock()
	if s == nil || t == "" {
		return
	}
	remote, err := s.Dial(context.Background(), "tcp", t)
	if err != nil {
		return
	}
	defer remote.Close()

	done := make(chan struct{}, 1)
	go func() {
		_, _ = io.Copy(remote, conn)
		done <- struct{}{}
	}()
	_, _ = io.Copy(conn, remote)
	<-done
}

// Addr 返回回环代理地址（如 127.0.0.1:54321）；未就绪时为空。
func Addr() string {
	mu.Lock()
	defer mu.Unlock()
	return addr
}

// State 返回 stopped | starting | ready | error。
func State() string {
	mu.Lock()
	defer mu.Unlock()
	return curState
}

// SelfIP 返回本节点在 tailnet 内的 100.x 地址。
func SelfIP() string {
	mu.Lock()
	defer mu.Unlock()
	return selfIP
}

// LoginURL 返回交互登录链接（未配置 authKey 时由 tsnet 生成）。
func LoginURL() string {
	mu.Lock()
	defer mu.Unlock()
	return loginURL
}

// LastError 返回最近的错误信息。
func LastError() string {
	mu.Lock()
	defer mu.Unlock()
	return lastErr
}

// Stop 关闭监听与隧道。
func Stop() {
	mu.Lock()
	s := srv
	l := ln
	srv, ln = nil, nil
	addr = ""
	selfIP = ""
	loginURL = ""
	curState = stateStopped
	mu.Unlock()
	if l != nil {
		_ = l.Close()
	}
	if s != nil {
		_ = s.Close()
	}
}

