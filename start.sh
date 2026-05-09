#!/usr/bin/env sh
set -eu

url="http://localhost:8839"

open_browser() {
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

(
  if command -v curl >/dev/null 2>&1; then
    tries=0
    until curl -fsS "$url" >/dev/null 2>&1 || [ "$tries" -ge 120 ]; do
      tries=$((tries + 1))
      sleep 0.25
    done
  else
    sleep 2
  fi
  open_browser
) &

docker compose up --build
