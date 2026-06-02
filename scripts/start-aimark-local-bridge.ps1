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

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BridgeScript = Join-Path $RepoRoot "scripts\aimark-local-bridge.mjs"
$LogDir = Join-Path $RepoRoot ".aimark-agent"
$OutLog = Join-Path $LogDir "bridge.out.log"
$ErrLog = Join-Path $LogDir "bridge.err.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

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
  } elseif ($DeviceCode) {
    try {
      $body = @{ device_code = $DeviceCode } | ConvertTo-Json
      $pair = Invoke-RestMethod -Uri "http://127.0.0.1:8799/cloud/pair" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 15
      Write-Output "AI Mark local bridge is waiting for cloud approval."
      if ($pair.agent) { Write-Output ("Agent: " + $pair.agent.device_name) }
      exit 0
    } catch {
      Write-Output "Existing bridge is old; restarting it for cloud pairing."
      if ($health.service -eq "aimark-local-agent-bridge") { Stop-AIMarkBridgePort } else { Write-Output "Port 8799 is used by another service."; exit 1 }
    }
  } else {
    Write-Output "AI Mark local bridge already running."
    Write-Output ("Inbox: " + $health.inbox)
    Write-Output ("Auto runner: " + $health.auto_run_enabled)
    Write-Output ("Runner: " + $health.runner_label)
    exit 0
  }
} catch {
  # Not running yet.
}

$args = @("`"$BridgeScript`"")
if ($DeviceCode) { $args += @("--device-code", $DeviceCode) }
if ($CloudBase) { $args += @("--cloud-base", $CloudBase) }
if ($AutoRun) { $args += "--auto-run" }
if ($RunnerProvider) { $args += @("--runner-provider", $RunnerProvider) }
if ($RunnerCmd) { $args += @("--runner-cmd", $RunnerCmd) }
if ($RunnerModel) { $args += @("--runner-model", $RunnerModel) }
if ($RunnerMode) { $args += @("--runner-mode", $RunnerMode) }

$process = Start-Process -FilePath "node" `
  -ArgumentList $args `
  -WorkingDirectory $RepoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -PassThru

Start-Sleep -Milliseconds 700

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:8799/health" -TimeoutSec 4
  Write-Output ("AI Mark local bridge started. PID: " + $process.Id)
  Write-Output ("URL: http://127.0.0.1:8799")
  Write-Output ("Inbox: " + $health.inbox)
  Write-Output ("Auto runner: " + $health.auto_run_enabled)
  Write-Output ("Runner: " + $health.runner_label)
} catch {
  Write-Output ("Started process PID " + $process.Id + ", but health check failed.")
  Write-Output ("Stdout log: " + $OutLog)
  Write-Output ("Stderr log: " + $ErrLog)
  throw
}
