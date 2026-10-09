# Computer Swarm Agent watchdog. Run elevated via the installer task.
$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentExe = Join-Path $Root 'Agent.exe'
$ReleaseFile = Join-Path $env:ProgramData 'ComputerSwarm\release.flag'
$TaskName = 'Computer Swarm Agent Watchdog'

while ($true) {
    if (Test-Path $ReleaseFile) { break }
    $running = Get-Process -Name 'Agent' -ErrorAction SilentlyContinue
    if (-not $running -and (Test-Path $AgentExe)) {
        Start-Process -FilePath $AgentExe -WorkingDirectory $Root -WindowStyle Hidden
    }
    Start-Sleep -Seconds 3
}
