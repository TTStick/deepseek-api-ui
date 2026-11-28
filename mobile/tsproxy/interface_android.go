//go:build android

package tsproxy

import (
	"github.com/wlynxg/anet"
	"tailscale.com/net/netmon"
)

// SetAndroidRelease 传入 Android 主版本号（11、12…），
// 供 anet 选择基于 ioctl 的实现来绕开 netlink 限制。
func SetAndroidRelease(major int) {
	anet.SetAndroidVersion(uint(major))
}

// Android（targetSdk >= 30）不允许应用 bind NETLINK_ROUTE，Go 的 net.Interfaces()
// 会返回 "netlinkrib: permission denied"。tailscale 为此提供了 RegisterInterfaceGetter
// 钩子，这里用 anet 基于 ioctl 枚举网卡与地址，绕开 netlink。
// iOS 没有该限制，使用 tailscale 默认的网卡枚举。
func init() {
	netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
		ifaces, err := anet.Interfaces()
		if err != nil {
			return nil, err
		}
		out := make([]netmon.Interface, 0, len(ifaces))
		for i := range ifaces {
			addrs, err := anet.InterfaceAddrsByInterface(&ifaces[i])
			if err != nil {
				addrs = nil
			}
			out = append(out, netmon.Interface{Interface: &ifaces[i], AltAddrs: addrs})
		}
		return out, nil
	})
}
