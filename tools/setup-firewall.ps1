# Run PowerShell as Administrator on the OPERATOR PC.
# Allows the swarm's LAN ports through Windows Defender Firewall.
$ports = @(3000,3001,41234)
foreach ($p in $ports) {
  $name = "Computer Swarm V1 TCP $p"
  if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $p -Action Allow -Profile Private | Out-Null }
}
$name = 'Computer Swarm V1 UDP 41234'
if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol UDP -LocalPort 41234 -Action Allow -Profile Private | Out-Null }
Write-Host 'Computer Swarm firewall rules created.' -ForegroundColor Green
