# Run PowerShell as Administrator once on each Agent PC.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = 'Computer Swarm Agent Watchdog'
$ReleaseDir = Join-Path $env:ProgramData 'ComputerSwarm'
$ReleaseFile = Join-Path $ReleaseDir 'release.flag'
New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null
if (Test-Path $ReleaseFile) { Remove-Item $ReleaseFile -Force }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Root 'watchdog.ps1') + '"')
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Computer Swarm Agent installed and started." -ForegroundColor Green
Write-Host "Agent ID defaults to this PC hostname; no per-PC config edit is required." -ForegroundColor Cyan
