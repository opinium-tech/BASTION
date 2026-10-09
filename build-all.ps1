$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$required = @('package.json','desktop/main.js','operator/server.js','agent/agent.js')
foreach ($file in $required) { if (!(Test-Path $file)) { throw "Required source file missing: $file" } }
Write-Host 'Computer Swarm Desktop - installing build dependencies...' -ForegroundColor Cyan
if (!(Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Node.js/npm is not installed. Install Node.js 22 LTS x64, then reopen PowerShell.' }
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
Write-Host 'Building the single-file Windows desktop app...' -ForegroundColor Cyan
npm run dist
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE" }
$exe = Join-Path $PSScriptRoot 'dist\Computer-Swarm-Setup-Free.exe'
if (!(Test-Path $exe)) { throw "Build command finished but expected single app was not found: $exe" }
Write-Host ''
Write-Host 'BUILD COMPLETE' -ForegroundColor Green
Write-Host "Single Windows app: $exe" -ForegroundColor Green
Write-Host 'Copy this one EXE to each authorized PC. No source folders are needed at runtime.'
