param(
  [string]$DeviceCode = "",
  [string]$CloudBase = "https://aimark.pages.dev",
  [switch]$AutoRun,
  [string]$RunnerProvider = "codex",
  [string]$RunnerCmd = "",
  [string]$RunnerModel = "",
  [string]$RunnerMode = "full-access"
)

$ErrorActionPreference = "Stop"

$InstallRoot = Join-Path $env:LOCALAPPDATA "AI Mark\bridge"
$LogRoot = Join-Path $env:LOCALAPPDATA "AI Mark\logs"
$BridgeScript = Join-Path $InstallRoot "aimark-local-bridge.mjs"
$OutLog = Join-Path $LogRoot "bridge.out.log"
$ErrLog = Join-Path $LogRoot "bridge.err.log"
$CloudBase = $CloudBase.TrimEnd("/")

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

if (-not $RunnerCmd) {
  if ($RunnerProvider -match "^(claude|anthropic)$") { $RunnerCmd = "claude" }
  else { $RunnerCmd = "codex" }
}

function Stop-AIMarkBridgePort {
  try {
    $listeners = Get-NetTCPConnection -LocalPort 8799 -State Listen -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
      if ($listener.OwningProcess) {
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    }
    Start-Sleep -Milliseconds 500
  } catch {
    Write-Output "Could not stop existing bridge process on port 8799."
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Output "Node.js is required for the AI Mark bridge."
  Write-Output "Install Node.js LTS from https://nodejs.org/ and run this launcher again."
  exit 1
}

Invoke-WebRequest -Uri ($CloudBase + "/downloads/aimark-local-bridge.mjs") -OutFile $BridgeScript

if (-not $DeviceCode) {
  $body = @{ device_name = ($env:COMPUTERNAME + " AI Mark bridge") } | ConvertTo-Json
  $pair = Invoke-RestMethod -Uri ($CloudBase + "/api/agent/pair/device/start/") -Method Post -ContentType "application/json" -Body $body
  $DeviceCode = $pair.device_code
  Write-Output ""
  Write-Output "Approve AI Mark Agent Bridge"
  Write-Output ("Open: " + $pair.verification_uri_complete)
  Write-Output ("Code: " + $pair.user_code)
  Write-Output ""
  Write-Output "After approval, keep this window open for a few seconds while the bridge pairs."
}

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:8799/health" -TimeoutSec 2
  $healthProvider = [string]$health.runner_provider
  $healthModel = [string]$health.runner_model
  if ($AutoRun -and (
    (-not $health.auto_run_enabled) -or
    (-not $healthProvider) -or
    ($RunnerProvider -and $healthProvider -and $healthProvider -ne $RunnerProvider) -or
    ($RunnerModel -and $healthModel -ne $RunnerModel) -or
    ($RunnerMode -and $health.runner_mode -ne $RunnerMode)
  )) {
    Write-Output "Existing bridge is not in the requested auto-run mode; restarting it."
    if ($health.service -eq "aimark-local-agent-bridge") { Stop-AIMarkBridgePort } else { Write-Output "Port 8799 is used by another service."; exit 1 }
  } else {
    try {
    $body = @{ device_code = $DeviceCode } | ConvertTo-Json
    $pair = Invoke-RestMethod -Uri "http://127.0.0.1:8799/cloud/pair" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 20
    Write-Output "AI Mark bridge is already running and waiting for cloud approval."
    Write-Output ("Inbox: " + $health.inbox)
    Write-Output ("Auto runner: " + $health.auto_run_enabled)
    Write-Output ("Runner: " + $health.runner_label)
    if ($pair.agent) { Write-Output ("Agent: " + $pair.agent.device_name) }
    exit 0
    } catch {
      Write-Output "Existing bridge is old; restarting it for cloud pairing."
      if ($health.service -eq "aimark-local-agent-bridge") { Stop-AIMarkBridgePort } else { Write-Output "Port 8799 is used by another service."; exit 1 }
    }
  }
} catch {
  # Not running yet.
}

$args = @("`"$BridgeScript`"", "--device-code", $DeviceCode, "--cloud-base", $CloudBase)
if ($AutoRun) { $args += "--auto-run" }
if ($RunnerProvider) { $args += @("--runner-provider", $RunnerProvider) }
if ($RunnerCmd) { $args += @("--runner-cmd", $RunnerCmd) }
if ($RunnerModel) { $args += @("--runner-model", $RunnerModel) }
if ($RunnerMode) { $args += @("--runner-mode", $RunnerMode) }
$process = Start-Process -FilePath "node" `
  -ArgumentList $args `
  -WorkingDirectory $InstallRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -PassThru

Start-Sleep -Milliseconds 900

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:8799/health" -TimeoutSec 4
  Write-Output ("AI Mark bridge started. PID: " + $process.Id)
  Write-Output ("URL: http://127.0.0.1:8799")
  Write-Output ("Inbox: " + $health.inbox)
  Write-Output ("Auto runner: " + $health.auto_run_enabled)
  Write-Output ("Runner: " + $health.runner_label)
  Write-Output ("Logs: " + $OutLog)
} catch {
  Write-Output ("Started process PID " + $process.Id + ", but health check failed.")
  Write-Output ("Stdout log: " + $OutLog)
  Write-Output ("Stderr log: " + $ErrLog)
  throw
}
