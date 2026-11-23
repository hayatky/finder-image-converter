#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "==> Installing mac-image-resizer from ${PROJECT_DIR}"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js (>= 20) is required." >&2
  exit 1
fi

cd "${PROJECT_DIR}"

if [ ! -d node_modules/sharp ]; then
  echo "==> Installing dependencies (sharp)..."
  npm install --omit=dev
fi

chmod +x "${PROJECT_DIR}/bin/imgresize.mjs"

echo "==> Installing Finder Quick Actions..."
node "${PROJECT_DIR}/bin/imgresize.mjs" sync-actions

echo ""
echo "インストールが完了しました！"
echo "Finderで画像を選択し、右クリック →「クイックアクション」から以下を実行できます："
echo "  - 画像変換: SNS用に縮小"
echo "  - 画像変換: 軽量化"
echo "  - 画像変換: 高圧縮"
echo "  - 画像変換: 詳細設定して変換"
echo ""
echo "※ メニューに表示されない場合は「システム設定 → 一般 → ログイン項目と機能拡張 → Finder」で有効化してください。"
