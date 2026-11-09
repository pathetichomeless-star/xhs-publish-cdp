#!/usr/bin/env bash
# 启动带调试端口的小红书发布专用 Chrome
# 用法: bash scripts/launch-chrome.sh [端口] [profile目录]
set -e
PORT="${1:-9333}"
PROFILE="${2:-~/xhs-cdp-profile}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ ! -x "$CHROME" ]; then
  echo "❌ 未找到 Chrome: $CHROME"; exit 1
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠️  端口 $PORT 已被占用，可能已在运行。直接使用即可。"; exit 0
fi

echo "启动 Chrome  (端口=$PORT, profile=$PROFILE)"
echo "首次使用请在新窗口里打开 creator.xiaohongshu.com 扫码登录"
"$CHROME" --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  "https://creator.xiaohongshu.com/publish/publish" >/dev/null 2>&1 &
echo "已在后台启动。保持此终端窗口不要关闭。"
