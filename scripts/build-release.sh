#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT_DIR/extension/manifest.json').version")"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_DIR="$DIST_DIR/extension"

rm -rf "$DIST_DIR"
mkdir -p "$PACKAGE_DIR"
cp -R "$ROOT_DIR/extension/." "$PACKAGE_DIR/"

(
  cd "$PACKAGE_DIR"
  zip -qr "$DIST_DIR/feishu-clipper-pro-extension-$VERSION.zip" . -x "*.DS_Store"
)

(
  cd "$ROOT_DIR"
  zip -qr "$DIST_DIR/feishu-clipper-pro-companion-$VERSION.zip" \
    server scripts INSTALL.md PRIVACY.md SECURITY.md LICENSE README.md \
    -x "*/.DS_Store" "scripts/build-release.sh"
)

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$DIST_DIR" && sha256sum ./*.zip > SHA256SUMS.txt)
else
  (cd "$DIST_DIR" && shasum -a 256 ./*.zip > SHA256SUMS.txt)
fi

echo "已生成："
echo "  $DIST_DIR/feishu-clipper-pro-extension-$VERSION.zip"
echo "  $DIST_DIR/feishu-clipper-pro-companion-$VERSION.zip"
echo "  $DIST_DIR/SHA256SUMS.txt"
