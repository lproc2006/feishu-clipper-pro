#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$HOME/.local/share/feishu-clipper-pro"
SERVER_DIR="$APP_DIR/server"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/feishu-clipper-pro.service"

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

mkdir -p "$SERVER_DIR"
cp "$ROOT_DIR/server/server.js" "$ROOT_DIR/server/package.json" "$SERVER_DIR/"

if command -v systemctl >/dev/null 2>&1; then
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Feishu Clipper Pro companion service
After=network-online.target

[Service]
ExecStart=$(command -v node) $SERVER_DIR/server.js
WorkingDirectory=$SERVER_DIR
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now feishu-clipper-pro.service
else
  nohup node "$SERVER_DIR/server.js" > "$APP_DIR/service.log" 2>&1 &
  echo "未检测到 systemd。服务已临时启动；重启电脑后请运行：node \"$SERVER_DIR/server.js\""
fi

echo "正在配置飞书应用。浏览器可能会打开授权页面。"
lark-cli config init
lark-cli auth login --recommend

echo "安装完成。服务状态：http://127.0.0.1:8787/health"
