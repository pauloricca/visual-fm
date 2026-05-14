#!/usr/bin/env sh
set -eu

mode="${1:-http}"

open_browser() {
  url="$1"
  if command -v open >/dev/null 2>&1; then
    open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  elif command -v start >/dev/null 2>&1; then
    start "$url"
  else
    printf 'Open %s in your browser.\n' "$url"
  fi
}

wait_then_open() {
  url="$1"
  (
    if command -v curl >/dev/null 2>&1; then
      tries=0
      until curl -kfsS "$url" >/dev/null 2>&1 || [ "$tries" -ge 120 ]; do
        tries=$((tries + 1))
        sleep 0.25
      done
    else
      sleep 2
    fi
    open_browser "$url"
  ) &
}

case "$mode" in
  http)
    url="http://localhost:8839"
    wait_then_open "$url"
    docker compose up --build
    ;;
  https)
    url="https://localhost:${PORT:-8843}"
    wait_then_open "$url"
    node scripts/serve-https.mjs
    ;;
  *)
    printf 'Usage: %s [http|https]\n' "$0" >&2
    exit 2
    ;;
esac
