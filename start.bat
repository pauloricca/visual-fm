@echo off
setlocal EnableExtensions

if not defined HTTP_PORT set "HTTP_PORT=8839"
set "VISUAL_FM_START_URL=http://localhost:%HTTP_PORT%"

if not defined PUBLIC_HOST (
  for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ip = Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.NetAdapter.Status -eq 'Up' -and ($_.InterfaceAlias -match 'Wi-Fi|Wireless|WLAN' -or $_.NetAdapter.InterfaceDescription -match 'Wi-Fi|Wireless|WLAN|802\.11') } | ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object { $_ -notmatch '^169\.254\.' } | Select-Object -First 1; if ($ip) { Write-Output $ip }"`) do set "PUBLIC_HOST=%%I"
)

start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "$url = $env:VISUAL_FM_START_URL; for ($i = 0; $i -lt 120; $i++) { try { Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1 | Out-Null; break } catch { Start-Sleep -Milliseconds 250 } }; Start-Process $url"

if /I "%~1"=="local" (
  node scripts\serve.mjs
) else (
  docker compose up --build
)
