# Run PowerShell as Administrator to re-enable an agent released by the Operator.
$ErrorActionPreference = 'Stop'
$TaskName = 'Computer Swarm Agent Watchdog'
$ReleaseFile = Join-Path $env:ProgramData 'ComputerSwarm\release.flag'
if (Test-Path $ReleaseFile) { Remove-Item $ReleaseFile -Force }
Enable-ScheduledTask -TaskName $TaskName | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host 'Computer Swarm Agent re-enabled.' -ForegroundColor Green
