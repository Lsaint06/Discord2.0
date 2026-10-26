<#
.SYNOPSIS
  Runs a local LiveKit server on Windows for development, wired to the local backend.

.DESCRIPTION
  Reads LIVEKIT_API_KEY / LIVEKIT_API_SECRET from server/.env (untracked) and starts the
  official livekit-server Windows binary with a LAN/loopback configuration and webhooks
  pointing at the local backend (http://127.0.0.1:3001).

  Download the binary from https://github.com/livekit/livekit/releases
  (livekit_<version>_windows_amd64.zip) and either put livekit-server.exe on PATH or pass -Binary.

.EXAMPLE
  ./scripts/livekit-dev.ps1
  ./scripts/livekit-dev.ps1 -Binary C:\tools\livekit\livekit-server.exe -NodeIp 192.168.68.42
#>
param(
  [string]$Binary = 'livekit-server.exe',
  # Address advertised to clients. 127.0.0.1 = clients on this PC only; use this PC's LAN IP to test across machines.
  [string]$NodeIp = '127.0.0.1',
  [string]$BackendUrl = 'http://127.0.0.1:3001'
)

$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '..\.env'
if (-not (Test-Path $envFile)) { throw "Missing $envFile. Copy .env.example to .env and set LIVEKIT_* first." }

$vars = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$') { $vars[$Matches[1]] = $Matches[2] }
}
$key = $vars['LIVEKIT_API_KEY']
$secret = $vars['LIVEKIT_API_SECRET']
if (-not $key -or -not $secret) { throw 'LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set in server/.env' }
if ($key -notmatch '^[A-Za-z0-9]+$' -or $secret -notmatch '^[A-Za-z0-9]+$') { throw 'Use letters and digits only for LiveKit credentials.' }

# Passed through the environment (not the command line) so the secret doesn't show up in process listings.
$env:LIVEKIT_CONFIG = @"
port: 7880
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: false
  node_ip: $NodeIp
keys:
  ${key}: $secret
webhook:
  api_key: $key
  urls:
    - $BackendUrl/api/livekit/webhook
room:
  auto_create: true
  empty_timeout: 300
  departure_timeout: 20
  # LiveKit's default codec list, plus H.264 profile 42001f: Chromium on Windows only uses the
  # GPU (e.g. NVENC via Media Foundation) for that profile; the default 42e01f falls back to
  # software OpenH264. See docs/screen-sharing-jetson.md.
  enabled_codecs:
    - mime: audio/pcmu
    - mime: audio/pcma
    - mime: audio/opus
    - mime: audio/red
    - mime: video/vp8
    - mime: video/h264
      fmtp_line: level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f
    - mime: video/h264
    - mime: video/vp9
    - mime: video/av1
    - mime: video/h265
    - mime: video/rtx
logging:
  level: info
"@

Write-Host "Starting LiveKit on ws://${NodeIp}:7880 (webhooks -> $BackendUrl)"
& $Binary
