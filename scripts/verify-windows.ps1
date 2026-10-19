# Runs every automated check on a Windows machine and collects the output in smoke\windows-report,
# so the folder can be sent back as it is. Messages are ASCII on purpose: Windows PowerShell 5.1
# misreads a UTF-8 script without a BOM.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify-windows.ps1          # tests + smoke
#   powershell -ExecutionPolicy Bypass -File scripts\verify-windows.ps1 -Live    # also the real model
#   powershell -ExecutionPolicy Bypass -File scripts\verify-windows.ps1 -Package # also build the installer and smoke the built app
#
# -Live needs DEEPSEEK_API_KEY in the environment; the key is never written to the report.
param([switch]$Live, [switch]$Package)

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

# A built Viva.exe through the memory smoke run. The built app has no test folder: SMOKE_FIXTURES lends it
# the repository's fake model. A GUI program has no console, so its output goes to files and its exit
# code is passed on.
function SmokeApp($exe, $name) {
  $out = Join-Path $report $name
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  $env:SMOKE_PHASE = 'memory'; $env:SMOKE_OUT = $out; $env:SMOKE_FIXTURES = Join-Path $root 'test\fixtures'; $env:DEEPSEEK_API_KEY = 'smoke-fake-key'
  try {
    $app = Start-Process -FilePath $exe -Wait -PassThru -RedirectStandardOutput (Join-Path $out 'stdout.log') -RedirectStandardError (Join-Path $out 'stderr.log')
    Get-Content (Join-Path $out 'stdout.log'), (Join-Path $out 'stderr.log') -Encoding UTF8
    cmd /c exit $app.ExitCode
  } finally {
    Remove-Item env:SMOKE_PHASE, env:SMOKE_OUT, env:SMOKE_FIXTURES, env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  }
}

if ($Package) {
  Step 'package' { npm run dist:win }
  # Not dist\win-unpacked: inside the repository the app would find packages in the repo's node_modules.
  # The installer itself, as a user gets it: installed silently into a folder of its own, smoked, removed.
  $installer = Get-ChildItem (Join-Path $root 'dist\*-setup.exe') | Select-Object -First 1
  if ($installer) {
    "installer: $($installer.Name) $([math]::Round($installer.Length / 1MB)) MB" | Add-Content (Join-Path $report 'environment.txt')
    $installDir = Join-Path $env:TEMP 'viva-installed'
    Step 'install-app' {
      $started = Get-Date
      $setup = Start-Process -FilePath $installer.FullName -ArgumentList '/S', "/D=$installDir" -Wait -PassThru
      $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
      $count = (Get-ChildItem $installDir -Recurse -File -Force).Count
      "install took $seconds s, $count files" | Add-Content (Join-Path $report 'environment.txt')
      if (Test-Path (Join-Path $installDir 'Viva.exe')) { "installed into $installDir in $seconds s ($count files)" } else { 'Viva.exe not found after installing' }
      cmd /c exit $(if ($setup.ExitCode -eq 0 -and (Test-Path (Join-Path $installDir 'Viva.exe'))) { 0 } else { 1 })
    }
    Step 'installed-smoke' { SmokeApp (Join-Path $installDir 'Viva.exe') 'installed' }
    # What the licenses ask to travel with every copy (see THIRD_PARTY_NOTICES.txt).
    Step 'installed-licenses' {
      $files = 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources\LICENSE', 'resources\THIRD_PARTY_NOTICES.txt', 'resources\app.asar'
      $missing = $files | Where-Object { -not (Test-Path (Join-Path $installDir $_)) }
      if ($missing) { "missing: $($missing -join ', ')" } else { "all present: $($files -join ', ')" }
      cmd /c exit $(if ($missing) { 1 } else { 0 })
    }
    Step 'uninstall-app' {
      $uninstaller = Get-ChildItem (Join-Path $installDir 'Uninstall*.exe') | Select-Object -First 1
      $removed = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
      Start-Sleep -Seconds 3
      cmd /c exit $(if ($removed.ExitCode -eq 0 -and -not (Test-Path (Join-Path $installDir 'Viva.exe'))) { 0 } else { 1 })
    }
  } else {
    $results['install-app'] = 'FAIL (no installer built)'
  }
}

# Written by a real launch (npm start), not by the smoke runs: the plugin links must be junctions that resolve.
$profileModules = Join-Path $env:APPDATA 'Viva\dsh\profiles\viva\node_modules'
if (Test-Path $profileModules) {
  Get-ChildItem $profileModules | Select-Object Name, LinkType, Target | Format-Table -AutoSize | Out-String |
    Set-Content -Path (Join-Path $report 'profile-links.txt')
}
Get-ChildItem 'smoke\*.png' -ErrorAction SilentlyContinue | Copy-Item -Destination $report

$summary = $results.GetEnumerator() | ForEach-Object { "$($_.Key): $($_.Value)" }
$summary | Set-Content -Path (Join-Path $report 'summary.txt') -Encoding UTF8
$summary | Write-Host
Write-Host "Report: $report"
