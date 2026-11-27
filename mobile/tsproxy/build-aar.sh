#!/bin/sh
# 构建内置 Tailscale（tsnet userspace 隧道）的 Android AAR。
#
# 依赖：
#   - Go 1.27+
#   - gomobile：go install golang.org/x/mobile/cmd/gomobile@latest && gomobile init
#   - ANDROID_HOME / ANDROID_NDK_HOME
#
# 产物：mobile/android/app/libs/tsproxy.aar
#       （Java 类 io.github.lijiahua1024.dsreplica.tsproxy.Tsproxy）
#
# 关于 Android 的 netlink 限制：
#   targetSdk >= 30 的应用不允许 bind NETLINK_ROUTE，Go 的 net.Interfaces() 会返回
#   "netlinkrib: permission denied"，tsnet 启动时 netmon.New 失败即整体退出。
#   这里把 tailscale.com 复制到 .build/ 下打一个容错补丁（netmon 不可用时退回静态
#   快照，官方 Android 客户端同样是「netmon 失败就继续」），再通过 -modfile 让 Go
#   使用这份本地副本。上游源码与 go.mod 都不会被修改。
set -eu

cd "$(dirname "$0")"
OUT="../android/app/libs/tsproxy.aar"
BUILD="$PWD/.build"
mkdir -p "$BUILD" "$(dirname "$OUT")"

export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
: "${ANDROID_HOME:?需要设置 ANDROID_HOME}"
: "${ANDROID_NDK_HOME:?需要设置 ANDROID_NDK_HOME}"

MODDIR="$(go list -m -f '{{.Dir}}' tailscale.com)"
rm -rf "$BUILD/tailscale.com"
cp -R "$MODDIR" "$BUILD/tailscale.com"
chmod -R u+w "$BUILD/tailscale.com"

python3 - "$BUILD/tailscale.com/tsnet/tsnet.go" <<'PY'
import sys

path = sys.argv[1]
text = open(path, encoding="utf-8").read()
needle = """\ts.netMon, err = netmon.New(sys.Bus.Get(), tsLogf)
\tif err != nil {
\t\treturn err
\t}
"""
replacement = """\ts.netMon, err = netmon.New(sys.Bus.Get(), tsLogf)
\tif err != nil {
\t\t// Android（targetSdk >= 30）禁止应用 bind NETLINK_ROUTE，netmon 无法枚举网卡。
\t\t// 退回静态快照（空接口状态），userspace 网络栈仍可经 DERP 建立连接。
\t\ttsLogf("tsproxy: netmon unavailable (%v); using static monitor", err)
\t\ts.netMon = netmon.NewStatic()
\t}
"""
if needle not in text:
    raise SystemExit("tsnet.go 结构已变化，补丁位置不存在：" + path)
open(path, "w", encoding="utf-8").write(text.replace(needle, replacement, 1))
print("patched:", path)
PY

# 临时把 replace 写进 go.mod（gomobile 的依赖检查不认 -modfile），结束时还原
cp go.mod "$BUILD/go.mod.bak"
restore() {
  if [ -f "$BUILD/go.mod.bak" ]; then
    cp "$BUILD/go.mod.bak" go.mod
    rm -f "$BUILD/go.mod.bak"
  fi
}
trap restore EXIT INT TERM
printf '\nreplace tailscale.com => ./.build/tailscale.com\n' >> go.mod

gomobile bind \
  -target=android/arm64,android/arm \
  -androidapi 28 \
  -ldflags=-checklinkname=0 \
  -javapkg=io.github.lijiahua1024.dsreplica \
  -o "$OUT" \
  .

restore
trap - EXIT INT TERM
ls -lh "$OUT"
