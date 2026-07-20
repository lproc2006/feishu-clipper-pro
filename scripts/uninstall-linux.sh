#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$HOME/.local/share/feishu-clipper-pro"
SERVICE_FILE="$HOME/.config/systemd/user/feishu-clipper-pro.service"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now feishu-clipper-pro.service >/dev/null 2>&1 || true
  rm -f "$SERVICE_FILE"
  systemctl --user daemon-reload
fi
rm -rf "$APP_DIR"

echo "飞书剪存pro 本机服务和本地关联数据已删除。"
echo "已保存在飞书中的内容和 lark-cli 不受影响。"
