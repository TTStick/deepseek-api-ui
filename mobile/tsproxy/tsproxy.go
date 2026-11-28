// Package tsproxy 把 userspace 的 Tailscale 节点（tsnet）暴露成本机回环上的 TCP 代理。
//
// 这样 Android 客户端只要把请求发到 127.0.0.1:<port>，流量就会经 WireGuard 隧道
// 到达 tailnet 内的服务器，而无需建立系统级 VPN（VpnService），不会接管设备流量、
// 也不需要 VPN 授权弹窗，且可与其他 VPN/代理共存。
//
// 登录方式：
//   - 不传 authKey 时走交互登录（与官方客户端一致）：tsnet 生成 login.tailscale.com
//     链接，用户在任意浏览器完成授权后节点自动就绪；节点密钥落盘，之后无需再次登录。
//   - 传入 authKey 时用于无人值守注册（Auth Key 仅在首次注册时用到）。
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
	"os"
	"path/filepath"
	"regexp"
	"sync"

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
	cancelUp context.CancelFunc
	gen      int // 每次 Start/Stop 自增，避免旧协程覆盖新状态
	curState = stateStopped
	lastErr  = ""
	addr     = ""
	target   = ""
	selfIP   = ""
	loginURL = ""
)

// 从 tsnet 日志里抓登录链接（交互登录时由 tsnet 周期性打印）
var authURLPattern = regexp.MustCompile(`https://login\.tailscale\.com/[a-zA-Z0-9/_-]+`)

// Start 启动 userspace tailscale 节点，并在 127.0.0.1 上监听一个随机端口，
// 把每条连接转发到 target（tailnet 内的 host:port）。重复调用是幂等的。
//
// 未提供 authKey 时进入交互登录：state 保持 starting，loginURL 给出登录链接，
// 用户在浏览器完成授权后自动转为 ready。
func Start(stateDir, hostname, authKey, targetAddr string) error {
	mu.Lock()
	defer mu.Unlock()
	if curState == stateReady || curState == stateStarting {
		return nil
	}
	prepareDirs(stateDir)
	target = targetAddr
	addr = ""
	selfIP = ""
	loginURL = ""
	lastErr = ""
	curState = stateStarting
	gen++
	myGen := gen

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
				if myGen == gen {
					loginURL = url
				}
				mu.Unlock()
			}
		},
	}
	srv = s

	// 交互登录可能要等用户在浏览器里操作，这里不设超时；Stop 会取消。
	ctx, cancel := context.WithCancel(context.Background())
	cancelUp = cancel

	go func() {
		if _, err := s.Up(ctx); err != nil {
			failIfCurrent(myGen, err)
			return
		}
		ip4, ip6 := s.TailscaleIPs()
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			failIfCurrent(myGen, err)
			return
		}
		mu.Lock()
		if myGen != gen {
			mu.Unlock()
			_ = l.Close()
			return
		}
		ln = l
		addr = l.Addr().String()
		loginURL = ""
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

// prepareDirs 为 tailscale 准备可写的状态/缓存目录。
// Android 应用没有 HOME/TMPDIR，logpolicy 找不到落盘位置会直接 panic
// （"no safe place found to store log state"）。
func prepareDirs(stateDir string) {
	cacheDir := filepath.Join(stateDir, "cache")
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		return
	}
	_ = os.Setenv("HOME", stateDir)
	_ = os.Setenv("XDG_CACHE_HOME", cacheDir)
	_ = os.Setenv("TMPDIR", cacheDir)
}

func failIfCurrent(myGen int, err error) {
	mu.Lock()
	defer mu.Unlock()
	if myGen != gen {
		return
	}
	curState = stateError
	lastErr = err.Error()
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

// LoginURL 返回交互登录链接（未提供 authKey、或节点密钥过期需重新登录时出现）。
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
	c := cancelUp
	gen++
	srv, ln, cancelUp = nil, nil, nil
	addr = ""
	selfIP = ""
	loginURL = ""
	curState = stateStopped
	lastErr = ""
	mu.Unlock()
	if l != nil {
		_ = l.Close()
	}
	if c != nil {
		c()
	}
	if s != nil {
		_ = s.Close()
	}
}
