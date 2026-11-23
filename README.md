# finder-image-converter

macOS の Finder 右クリックメニュー（クイックアクション）から、複数画像のリサイズ・圧縮・形式変換・メタデータ削除をワンクリックで実行できるツールです。

- **Xcode 不要・常駐アプリ不要**：Node.js + `sharp` (libvips) と macOS 標準のクイックアクション（`~/Library/Services/*.workflow`）で動作します。
- **完全ローカル処理**：画像やファイル名を外部サービスへ送信しません。
- **元画像を保護**：元ファイルは一切変更・上書きせず、`Resized` フォルダへ安全に保存します（同名ファイルは自動で連番を付与）。

## 対応環境

- macOS（Apple Silicon 対応）
- Node.js 20 以上（`npm`）

## インストール

```bash
git clone https://github.com/hayatky/finder-image-converter.git
cd finder-image-converter
bash scripts/install.sh
```

`install.sh` は依存パッケージ（`sharp`）をインストールし、`~/Library/Services/` に以下の Finder クイックアクションを自動生成します。

| 右クリックメニュー | 初期設定 |
|---|---|
| `画像変換: SNS用に縮小` | JPEG / 長辺 2560px / 品質 85 / メタデータ削除 / sRGB |
| `画像変換: 軽量化` | WebP / 長辺 1920px / 品質 80 / メタデータ削除 / sRGB |
| `画像変換: 高圧縮` | AVIF / 長辺 2560px / 品質 50 / メタデータ削除 / sRGB |
| `画像変換: 詳細設定して変換` | ネイティブ設定ダイアログで形式・サイズ・品質・保存先・メタデータ等を任意指定（その場でプリセット保存も可能） |

> **Finder の右クリックメニューに表示されない場合**
> 「システム設定」→「一般」→「ログイン項目と機能拡張」→「Finder」を開き、追加されたクイックアクションが有効になっているか確認してください。

## 使い方

### 1. Finder から変換する（基本）

1. Finder で画像ファイルを 1 枚または複数枚選択します。
2. 右クリック → **「クイックアクション」** → 実行したいプリセット（例：`画像変換: SNS用に縮小`）をクリックします。
3. ターミナルやウィンドウは開かず、変換が完了すると macOS の通知バナーで結果（変換枚数・削減率・保存先）が表示されます。
4. 変換後の画像は元画像と同じフォルダ内の `Resized` フォルダに保存されます。

### 2. 詳細設定して変換・新しいプリセットを保存する

1. Finder で画像を選択し、右クリック → **「クイックアクション」** → **`画像変換: 詳細設定して変換`** をクリックします。
2. 表示される macOS ネイティブダイアログで、出力形式（JPEG / WebP / AVIF / PNG / TIFF / HEIC）、リサイズ方式（長辺 / 幅×高さ / リサイズなし）、圧縮品質、保存先フォルダ、メタデータ削除、sRGB 変換などを指定します。
3. **「プリセット保存名」** に名前を入力して実行すると、変換と同時に新しいプリセットとして保存され、Finder の右クリックメニューにも自動で追加されます。

### 3. プリセットの追加・編集・削除（CLI）

プリセット設定は `~/.config/mac-image-resizer/presets.json` に保存されています。CLI または JSON の直接編集で管理できます。

```bash
# プリセット一覧を表示
node bin/imgresize.mjs preset list

# プリセットを追加（Finder クイックアクションも自動同期）
node bin/imgresize.mjs preset add \
  --name "ブログ用WebP" \
  --format webp \
  --max-long-edge 1600 \
  --quality 82 \
  --output-dir Resized

# プリセットを削除（Finder クイックアクションも自動同期）
node bin/imgresize.mjs preset remove "ブログ用WebP"

# presets.json を手動編集した後に Finder メニューへ反映
node bin/imgresize.mjs sync-actions

# 初期プリセットに戻す
node bin/imgresize.mjs preset reset
```

### 4. CLI から直接変換する

```bash
# 保存済みプリセットで一括変換
node bin/imgresize.mjs convert --preset sns -- ~/Pictures/*.jpg

# オプションを直接指定して変換
node bin/imgresize.mjs convert \
  --format avif \
  --max-long-edge 2560 \
  --quality 50 \
  --output-dir ~/Pictures/Exported \
  -- ~/Pictures/*.jpg

# メタデータと元の ICC プロファイルを保持して PNG に変換
node bin/imgresize.mjs convert \
  --format png \
  --width 1920 \
  --keep-metadata \
  --keep-color-profile \
  -- ~/Pictures/photo.tiff
```

## 画像処理・安全性の仕様

- **対応形式**: JPEG / PNG / WebP / AVIF / TIFF / HEIC（HEIC の入出力は macOS 標準の `sips` を安全に連携して処理します）。
- **リサイズ**: Lanczos3 フィルタで高品質縮小。デフォルトでアスペクト比を維持し、元画像より拡大しません。
- **EXIF 回転とメタデータ**: 縮小前に EXIF の Orientation に従ってピクセルを物理回転するため、メタデータ（EXIF / GPS / XMP / IPTC）を削除しても向きが変わりません。メタデータ保持時は Orientation タグを `1` に正規化します。
- **色管理**: デフォルトで LittleCMS2 により Display P3 / Adobe RGB 等から sRGB へ変換し、sRGB ICC プロファイルを付与します。
- **透過処理**: PNG / WebP / AVIF / TIFF は透過を維持し、JPEG 出力時は透過領域を白背景で合成して黒潰れを防ぎます。
- **安全な書き込み**: 一時ファイルへ書き込んでから原子的リネーム（`rename`）で確定し、同名ファイルがある場合は `name (1).jpg` のように自動回避します。1 枚が破損していても他の画像の処理は継続され、失敗時はログ（`~/.config/mac-image-resizer/last-run.log`）を確認できます。

## テストの実行

```bash
npm test
```

## アンインストール

```bash
# Finder クイックアクションのみ削除（設定ファイルは保持）
bash scripts/uninstall.sh

# 設定ファイル（~/.config/mac-image-resizer）も含めて完全削除
bash scripts/uninstall.sh --purge-config
```

※ `uninstall.sh` は本ツールが生成したクイックアクションのみを削除し、ユーザーが作成した他のクイックアクションには一切触れません。
