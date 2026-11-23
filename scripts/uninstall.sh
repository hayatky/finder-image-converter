#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "==> Removing Finder Quick Actions..."
node "${PROJECT_DIR}/bin/imgresize.mjs" uninstall-actions

if [ "${1:-}" = "--purge-config" ]; then
  CONFIG_DIR="${HOME}/.config/mac-image-resizer"
  if [ -d "${CONFIG_DIR}" ]; then
    rm -rf "${CONFIG_DIR}"
    echo "==> Removed config directory: ${CONFIG_DIR}"
  fi
fi

echo "アンインストールが完了しました。"
