@echo off
setlocal EnableExtensions

if not defined HTTP_PORT set "HTTP_PORT=8839"
set "VISUAL_FM_START_URL=http://localhost:%HTTP_PORT%"

start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "$url = $env:VISUAL_FM_START_URL; for ($i = 0; $i -lt 120; $i++) { try { Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1 | Out-Null; break } catch { Start-Sleep -Milliseconds 250 } }; Start-Process $url"

if /I "%~1"=="local" (
  node scripts\serve.mjs
) else (
  docker compose up --build
)
