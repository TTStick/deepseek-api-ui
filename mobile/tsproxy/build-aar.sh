#!/bin/sh
# 构建内置 Tailscale（tsnet userspace 隧道）的 Android AAR。
#
# 依赖：
#   - Go 1.27+
#   - gomobile：go install golang.org/x/mobile/cmd/gomobile@latest && gomobile init
#   - ANDROID_HOME / ANDROID_NDK_HOME
#
# 产物：mobile/android/app/libs/tsproxy.aar（Java 类 io.github.lijiahua1024.dsreplica.tsproxy.Tsproxy）
set -eu

cd "$(dirname "$0")"
OUT="../android/app/libs/tsproxy.aar"
mkdir -p "$(dirname "$OUT")"

export GOFLAGS="${GOFLAGS:-}"
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"

: "${ANDROID_HOME:?需要设置 ANDROID_HOME}"
: "${ANDROID_NDK_HOME:?需要设置 ANDROID_NDK_HOME}"

gomobile bind \
  -target=android/arm64,android/arm \
  -androidapi 28 \
  -javapkg=io.github.lijiahua1024.dsreplica \
  -o "$OUT" \
  .

ls -lh "$OUT"
