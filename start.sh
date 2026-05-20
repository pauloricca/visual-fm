#!/usr/bin/env sh
set -eu

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

wifi_ip() {
  if [ -n "${PUBLIC_HOST:-}" ]; then
    printf '%s\n' "$PUBLIC_HOST"
    return
  fi

  if command -v networksetup >/dev/null 2>&1; then
    wifi_device="$(networksetup -listallhardwareports 2>/dev/null | awk '
      /Hardware Port: (Wi-Fi|AirPort)/ { found = 1; next }
      found && /Device:/ { print $2; exit }
    ' || true)"
    if [ -n "$wifi_device" ]; then
      ipconfig getifaddr "$wifi_device" 2>/dev/null && return
    fi
  fi

  if command -v ipconfig >/dev/null 2>&1; then
    ipconfig getifaddr en0 2>/dev/null && return
    ipconfig getifaddr en1 2>/dev/null && return
  fi

  if command -v ip >/dev/null 2>&1; then
    address="$(ip -o -4 addr show 2>/dev/null | awk '
      $2 ~ /^(wl|wlan|wifi|ath)/ {
        split($4, address, "/");
        print address[1];
        exit;
      }
    ')"
    if [ -n "$address" ]; then
      printf '%s\n' "$address"
      return
    fi
  fi
}

detected_wifi_ip="$(wifi_ip || true)"
if [ -n "$detected_wifi_ip" ]; then
  export PUBLIC_HOST="$detected_wifi_ip"
fi

url="http://localhost:${HTTP_PORT:-8839}"
wait_then_open "$url"

if [ "${1:-}" = "local" ]; then
  node scripts/serve.mjs
else
  docker compose up --build
fi
