#!/bin/sh
# 构建内置 Tailscale（tsnet userspace 隧道）的 iOS XCFramework。
#
# 依赖：
#   - Go 1.27+
#   - gomobile: go install golang.org/x/mobile/cmd/gomobile@latest && gomobile init
#   - Xcode 命令行工具
#
# 产物：ios/Frameworks/Tsproxy.xcframework
set -eu

IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$IOS_DIR/.." && pwd)"
GO_DIR="$REPO_DIR/mobile/tsproxy"
OUT="$IOS_DIR/Frameworks/Tsproxy.xcframework"

export PATH="$HOME/go/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# 与 Android 的 build-aar.sh 一致：国内网络走 goproxy.cn；go.sum 已锁定依赖版本。
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
export GOSUMDB="${GOSUMDB:-off}"

if ! command -v gomobile >/dev/null 2>&1; then
    echo "未找到 gomobile。请先执行：" >&2
    echo "  go install golang.org/x/mobile/cmd/gomobile@latest" >&2
    echo "  gomobile init" >&2
    exit 1
fi

cd "$GO_DIR"
mkdir -p "$(dirname "$OUT")"
rm -rf "$OUT"
gomobile bind \
    -target=ios,iossimulator \
    -iosversion=16.0 \
    -trimpath \
    -ldflags=-checklinkname=0 \
    -o "$OUT" \
    .
echo "已生成 $OUT"
