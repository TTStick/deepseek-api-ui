#!/bin/sh
set -eu

IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$IOS_DIR/.." && pwd)"
WEB_DIR="$REPO_DIR/mobile"
DEST="$IOS_DIR/WyDeepSeek/WebApp"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm 未安装，请先安装 Node.js 22+ 与 pnpm。" >&2
    exit 1
fi

cd "$WEB_DIR"
if [ ! -d node_modules ]; then
    pnpm install --no-frozen-lockfile
fi
pnpm build

mkdir -p "$DEST"
rsync -a --delete "$WEB_DIR/dist/" "$DEST/"
touch "$DEST/.gitkeep"
echo "Web 产物已复制到 $DEST"
