# Runs every automated check on a Windows machine and collects the output in smoke\windows-report,
# so the folder can be sent back as it is. Messages are ASCII on purpose: Windows PowerShell 5.1
# misreads a UTF-8 script without a BOM.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify-windows.ps1          # tests + smoke
#   powershell -ExecutionPolicy Bypass -File scripts\verify-windows.ps1 -Live    # also the real model
#
# -Live needs DEEPSEEK_API_KEY in the environment; the key is never written to the report.
param([switch]$Live)

$ErrorActionPreference = 'Continue'
# node and npm print UTF-8; read it as such, and write every log as UTF-8 too.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$report = Join-Path $root 'smoke\windows-report'
New-Item -ItemType Directory -Force -Path $report | Out-Null
$results = [ordered]@{}

function Step($name, [scriptblock]$block) {
  Write-Host "== $name" -ForegroundColor Cyan
  $log = Join-Path $report "$name.log"
  $lines = & $block *>&1 | ForEach-Object { "$_" }
  $ok = $LASTEXITCODE -eq 0
  $lines | Set-Content -Path $log -Encoding UTF8
  $lines | Write-Host
  $results[$name] = if ($ok) { 'PASS' } else { "FAIL (exit $LASTEXITCODE)" }
  Write-Host "== $name -> $($results[$name])" -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
}

$nodeVersion = (node --version) 2>$null
if (-not $nodeVersion) {
  Write-Host 'Node.js not found: install Node 22 or later, then run again.' -ForegroundColor Red
  exit 1
}
@(
  "date: $(Get-Date -Format o)"
  "os: $([System.Environment]::OSVersion.VersionString)"
  "node: $nodeVersion"
  "npm: $(npm --version)"
  "commit: $(git rev-parse --short HEAD 2>$null)"
) | Set-Content -Path (Join-Path $report 'environment.txt')

Step 'install' { npm ci }
Step 'test' { npm test }
Step 'smoke-setup' { npm run smoke:setup }
Step 'smoke-walkthrough' { npm run smoke:walkthrough }
Step 'smoke-relaunch' { npm run smoke:relaunch }
Step 'smoke-memory' { npm run smoke:memory }

if ($Live) {
  if (-not $env:DEEPSEEK_API_KEY) {
    $results['live-memory'] = 'SKIPPED (no DEEPSEEK_API_KEY)'
  } else {
    Step 'live-memory' { npm run live:memory }
    if (Test-Path 'smoke\live-memory.json') { Copy-Item 'smoke\live-memory.json' $report }
  }
}

# Written by a real launch (npm start), not by the smoke runs: the plugin links must be junctions that resolve.
$profileModules = Join-Path $env:USERPROFILE '.dsh\profiles\viva\node_modules'
if (Test-Path $profileModules) {
  Get-ChildItem $profileModules | Select-Object Name, LinkType, Target | Format-Table -AutoSize | Out-String |
    Set-Content -Path (Join-Path $report 'profile-links.txt')
}
Get-ChildItem 'smoke\*.png' -ErrorAction SilentlyContinue | Copy-Item -Destination $report

$summary = $results.GetEnumerator() | ForEach-Object { "$($_.Key): $($_.Value)" }
$summary | Set-Content -Path (Join-Path $report 'summary.txt') -Encoding UTF8
$summary | Write-Host
Write-Host "Report: $report"
