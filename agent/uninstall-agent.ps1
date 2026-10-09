# Run PowerShell as Administrator to remove the Agent watchdog.
$ErrorActionPreference = 'SilentlyContinue'
$TaskName = 'Computer Swarm Agent Watchdog'
Stop-ScheduledTask -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Remove-Item (Join-Path $env:ProgramData 'ComputerSwarm\release.flag') -Force
Write-Host 'Computer Swarm Agent watchdog removed.' -ForegroundColor Green
