#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$HOME/Library/Application Support/FeishuClipperPro"
PLIST="$HOME/Library/LaunchAgents/io.github.feishu-clipper-pro.plist"

launchctl bootout "gui/$UID" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"
rm -rf "$APP_DIR"

echo "飞书剪存pro 本机服务和本地关联数据已删除。"
echo "已保存在飞书中的内容和 lark-cli 不受影响。"
