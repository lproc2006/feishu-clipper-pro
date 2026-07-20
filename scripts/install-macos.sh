#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$HOME/Library/Application Support/FeishuClipperPro"
SERVER_DIR="$APP_DIR/server"
PLIST="$HOME/Library/LaunchAgents/io.github.feishu-clipper-pro.plist"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "需要 Node.js 18 或更高版本：https://nodejs.org/"
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "当前 Node.js 版本过低，需要 18 或更高版本。"
  exit 1
fi

echo "正在安装飞书官方 lark-cli..."
npx @larksuite/cli@latest install

mkdir -p "$SERVER_DIR" "$HOME/Library/LaunchAgents"
cp "$ROOT_DIR/server/server.js" "$ROOT_DIR/server/package.json" "$SERVER_DIR/"

NODE_BIN="$(command -v node)"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.github.feishu-clipper-pro</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>$SERVER_DIR/server.js</string></array>
  <key>WorkingDirectory</key><string>$SERVER_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP_DIR/service.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/service-error.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/io.github.feishu-clipper-pro"

echo "正在配置飞书应用。浏览器可能会打开授权页面。"
lark-cli config init
lark-cli auth login --recommend

echo "安装完成。服务状态：http://127.0.0.1:8787/health"
