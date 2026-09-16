#!/bin/sh
# kanri のランチャー。
# すでに起動していればブラウザを開くだけ、起動していなければサーバーを立ち上げる。
# Finder からのダブルクリック（PATH がほぼ空）でも動くよう、node を自力で探す。
set -u

APP_DIR="${KANRI_DIR:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}"
PORT="${PORT:-7788}"
URL="http://localhost:${PORT}"
LOG_DIR="${APP_DIR}/data"
LOG_FILE="${LOG_DIR}/server.log"

# --- 画面への通知 -------------------------------------------------
notify_error() {
  title="$1"
  body="$2"
  printf '%s\n%s\n' "$title" "$body" >&2
  if [ "$(uname -s)" = "Darwin" ] && command -v osascript > /dev/null 2>&1; then
    # AppleScript の文字列に入れるため " と \ を退避する
    escaped=$(printf '%s\n\n%s' "$title" "$body" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    osascript -e "display dialog \"${escaped}\" with title \"kanri\" buttons {\"OK\"} default button 1 with icon caution" > /dev/null 2>&1
  fi
}

open_browser() {
  if command -v open > /dev/null 2>&1; then
    open "$URL"
  elif command -v xdg-open > /dev/null 2>&1; then
    xdg-open "$URL" > /dev/null 2>&1 &
  else
    printf 'ブラウザで %s を開いてください\n' "$URL"
  fi
}

# --- node を探す ---------------------------------------------------
find_node() {
  if command -v node > /dev/null 2>&1; then
    command -v node
    return 0
  fi
  # Homebrew / 公式インストーラ / MacPorts / Volta の標準的な場所
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    /opt/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/bin/node"
  do
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  # nvm や fnm は複数バージョンが並ぶので、名前順で最後のものを使う
  for dir in "$HOME/.nvm/versions/node" "$HOME/.local/share/fnm/node-versions" "$HOME/Library/Application Support/fnm/node-versions"; do
    [ -d "$dir" ] || continue
    found=$(ls -1 "$dir" 2>/dev/null | sort -V | tail -1)
    [ -n "$found" ] && [ -x "$dir/$found/bin/node" ] && { printf '%s\n' "$dir/$found/bin/node"; return 0; }
    [ -n "$found" ] && [ -x "$dir/$found/installation/bin/node" ] && { printf '%s\n' "$dir/$found/installation/bin/node"; return 0; }
  done
  return 1
}

# --- すでに起動しているか --------------------------------------------
health() {
  curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null
}

if health | grep -q '"app":"kanri"'; then
  printf 'kanri はすでに起動しています。ブラウザを開きます。\n'
  open_browser
  exit 0
fi

NODE_BIN=$(find_node) || {
  notify_error "Node.js が見つかりませんでした" \
"kanri を動かすには Node.js が必要です。

https://nodejs.org/ja から LTS 版をインストールしてから、
もう一度このアイコンを開いてください。

（Claude Code を使っていれば、たいていは既に入っています。
　その場合はターミナルで which node を実行し、
　表示されたパスを教えてください。）"
  exit 1
}

[ -f "${APP_DIR}/server.js" ] || {
  notify_error "kanri のファイルが見つかりません" \
"次の場所を見に行きましたが、server.js がありませんでした。

${APP_DIR}

kanri のフォルダを移動した場合は、
scripts/install-mac.sh をもう一度実行してください。"
  exit 1
}

# --- 起動 -----------------------------------------------------------
mkdir -p "$LOG_DIR"
printf '\n===== %s に起動 =====\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"

# ブラウザはこのスクリプトが開くので、サーバー側では開かせない
KANRI_NO_OPEN=1 PORT="$PORT" nohup "$NODE_BIN" "${APP_DIR}/server.js" >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# 起動を待つ（最大約20秒）
i=0
while [ "$i" -lt 100 ]; do
  if health | grep -q '"app":"kanri"'; then
    printf 'kanri を起動しました（PID %s）。%s\n' "$SERVER_PID" "$URL"
    open_browser
    exit 0
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break   # プロセスが落ちた
  fi
  sleep 0.2
  i=$((i + 1))
done

notify_error "kanri を起動できませんでした" \
"ポート ${PORT} で応答がありませんでした。
別のアプリが同じポートを使っている可能性があります。

ログの末尾:
$(tail -n 8 "$LOG_FILE" 2>/dev/null)"
exit 1
