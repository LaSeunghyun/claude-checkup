# Claude 설정 점검 설치 스크립트 (Windows)
# 사용: PowerShell 에서 irm <이 파일 주소> | iex
$ErrorActionPreference = 'Stop'
# irm | iex 는 PowerShell 5.1 에서 UTF-8 을 깨뜨리므로 한글은 \u 이스케이프로 적고 실행 때 푼다
function T([string]$s) { [regex]::Unescape($s) }

$repo = if ($env:CHECKUP_REPO) { $env:CHECKUP_REPO } else { 'LaSeunghyun/claude-checkup' }
$base = if ($env:CHECKUP_BASE_URL) { $env:CHECKUP_BASE_URL } else { "https://github.com/$repo/releases/latest/download" }

$dir = Join-Path $HOME '.claude-checkup\bin'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$tmp = Join-Path $dir '.download'
$exe = Join-Path $dir 'claude-checkup.exe'

Write-Host (T 'Claude \uC124\uC815 \uC810\uAC80\uC744 \uB0B4\uB824\uBC1B\uACE0 \uC788\uC5B4\uC694...')
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -UseBasicParsing -Uri "$base/claude-checkup.exe" -OutFile $tmp
} catch {
  Remove-Item -Force -ErrorAction SilentlyContinue $tmp
  Write-Host (T '\uB0B4\uB824\uBC1B\uC9C0 \uBABB\uD588\uC5B4\uC694. \uC778\uD130\uB137 \uC5F0\uACB0\uC744 \uD655\uC778\uD558\uACE0 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.') -ForegroundColor Red
  return
}
Move-Item -Force $tmp $exe

Write-Host (T '\uC124\uCE58\uD588\uC5B4\uC694. \uB2E4\uC74C\uBD80\uD130\uB294 \uC544\uB798 \uD30C\uC77C\uC744 \uB354\uBE14\uD074\uB9AD\uD558\uAC70\uB098 PowerShell \uC5D0\uC11C \uC2E4\uD589\uD558\uBA74 \uB3FC\uC694.')
Write-Host "  $exe"
Write-Host ''
& $exe
