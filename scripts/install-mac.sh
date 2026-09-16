#!/bin/sh
# デスクトップに kanri.app を作る。
#   sh scripts/install-mac.sh            → ~/Desktop に作成
#   sh scripts/install-mac.sh /Applications → 場所を指定
set -eu

APP_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
DEST_DIR="${1:-$HOME/Desktop}"
BUNDLE="${DEST_DIR}/kanri.app"

if [ "$(uname -s)" != "Darwin" ]; then
  printf 'このスクリプトは macOS 専用です（今の OS: %s）\n' "$(uname -s)" >&2
  exit 1
fi

command -v node > /dev/null 2>&1 || {
  printf 'Node.js が見つかりません。https://nodejs.org/ja から LTS 版を入れてください。\n' >&2
  exit 1
}

[ -d "$DEST_DIR" ] || {
  printf '置き場所が見つかりません: %s\n' "$DEST_DIR" >&2
  exit 1
}

printf 'kanri の場所: %s\n' "$APP_DIR"
printf 'アイコンの作成先: %s\n\n' "$BUNDLE"

# --- アイコン --------------------------------------------------------
node "${APP_DIR}/scripts/make-icon.js" "${APP_DIR}/assets"

# --- バンドルを組み立てる ---------------------------------------------
rm -rf "$BUNDLE"
mkdir -p "${BUNDLE}/Contents/MacOS" "${BUNDLE}/Contents/Resources"

cat > "${BUNDLE}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>kanri</string>
	<key>CFBundleDisplayName</key>
	<string>kanri</string>
	<key>CFBundleIdentifier</key>
	<string>local.kanri.launcher</string>
	<key>CFBundleVersion</key>
	<string>0.1.0</string>
	<key>CFBundleShortVersionString</key>
	<string>0.1.0</string>
	<key>CFBundleExecutable</key>
	<string>kanri</string>
	<key>CFBundleIconFile</key>
	<string>kanri</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<!-- ブラウザを開いたらすぐ終了するので、Dock には出さない -->
	<key>LSUIElement</key>
	<true/>
</dict>
</plist>
PLIST

# 起動用の実行ファイル。kanri の場所を埋め込む。
cat > "${BUNDLE}/Contents/MacOS/kanri" <<LAUNCHER
#!/bin/sh
# scripts/install-mac.sh が生成。直接編集しないでください。
KANRI_DIR='${APP_DIR}'
export KANRI_DIR
exec "\${KANRI_DIR}/scripts/launch.sh"
LAUNCHER
chmod +x "${BUNDLE}/Contents/MacOS/kanri"

if [ -f "${APP_DIR}/assets/kanri.icns" ]; then
  cp "${APP_DIR}/assets/kanri.icns" "${BUNDLE}/Contents/Resources/kanri.icns"
else
  printf '警告: .icns を作れなかったため、標準のアイコンになります\n' >&2
fi

# Finder にアイコンの更新を気づかせる
touch "$BUNDLE"

printf '\n完成しました。\n'
printf '  デスクトップの「kanri」をダブルクリックすると、ブラウザで開きます。\n'
printf '  終了するときは、画面右上の「終了」ボタンを押してください。\n\n'
printf '  ※ kanri のフォルダ（%s）を移動したら、\n' "$APP_DIR"
printf '     このスクリプトをもう一度実行してください。\n'
