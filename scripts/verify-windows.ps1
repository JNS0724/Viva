# Windows checks. -PackageOnly assumes npm ci has already run. -Live is opt-in and needs a key.
# The external runner owns temporary profiles; reports never include a raw profile or credentials.
param([switch]$Live, [ValidateSet('core', 'full')][string]$LiveSet = 'core', [switch]$Package, [switch]$PackageOnly)
if ($PackageOnly) { $Package = $true }
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$report = Join-Path $root 'smoke\windows-report'
New-Item -ItemType Directory -Force -Path $report | Out-Null
$results = [ordered]@{}

function Step($name, [scriptblock]$block) {
  Write-Host "== $name" -ForegroundColor Cyan
  $script:LASTEXITCODE = 0
  $ok = $false
  $previousErrorAction = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 turns native stderr into ErrorRecords; warnings alone are not a failed exit.
    $ErrorActionPreference = 'Continue'
    & $block *>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath (Join-Path $report "$name.log") | ForEach-Object { Write-Host $_ }
    $ok = $LASTEXITCODE -eq 0
  } catch {
    "$_" | Add-Content (Join-Path $report "$name.log") -Encoding UTF8
    Write-Host "$_" -ForegroundColor Red
  } finally { $ErrorActionPreference = $previousErrorAction }
  $results[$name] = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Host "== $name -> $($results[$name])"
  return $ok
}

@("date: $(Get-Date -Format o)", "os: $([Environment]::OSVersion.VersionString)", "node: $(node --version)", "npm: $(npm --version)", "commit: $(git rev-parse HEAD)") |
  Set-Content (Join-Path $report 'environment.txt') -Encoding UTF8

if (-not $PackageOnly) {
  if (Step 'install' { npm ci }) {
    [void](Step 'typecheck' { npm run typecheck })
    [void](Step 'test' { npm test })
    [void](Step 'smoke' { npm run smoke })
  }
}

if ($Live) {
  if (-not $env:DEEPSEEK_API_KEY) { $results['live'] = 'SKIPPED (no DEEPSEEK_API_KEY)' }
  else {
    [void](Step 'live-memory' { npm run live:memory })
    [void](Step 'live' { npm run live -- --set $LiveSet })
  }
}

if ($Package -and (Step 'package' { npm run dist:win })) {
  $installer = Get-ChildItem -LiteralPath (Join-Path $root 'dist') -Filter '*-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $installer) { $results['install-app'] = 'FAIL (no installer built)' }
  else {
    $installDir = Join-Path ([IO.Path]::GetTempPath()) ('viva-installed-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $installDir | Out-Null
    $previousExecutable = $env:VIVA_SMOKE_EXECUTABLE
    try {
      $installed = Step 'install-app' {
        $setup = Start-Process -FilePath $installer.FullName -ArgumentList '/S', "/D=$installDir" -WindowStyle Hidden -PassThru
        if (-not $setup.WaitForExit(120000)) { throw 'Installer did not finish within 120 seconds' }
        if ($setup.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $installDir 'Viva.exe'))) { throw 'Installer failed or Viva.exe is missing' }
        "installed: $($installer.Name) -> $installDir"
      }
      if ($installed) {
        $env:VIVA_SMOKE_EXECUTABLE = Join-Path $installDir 'Viva.exe'
        [void](Step 'installed-smoke' { npm run smoke:package })
        [void](Step 'installed-licenses' {
          $missing = 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources\LICENSE', 'resources\THIRD_PARTY_NOTICES.txt', 'resources\app.asar' |
            Where-Object { -not (Test-Path -LiteralPath (Join-Path $installDir $_)) }
          if ($missing) { throw "Missing: $($missing -join ', ')" }
          'All distribution licenses and app.asar are present.'
        })
      }
    } finally {
      $env:VIVA_SMOKE_EXECUTABLE = $previousExecutable
      # Only this invocation's unique install is uninstalled. Never enumerate another user's Viva install.
      $uninstaller = Get-ChildItem -LiteralPath $installDir -Filter 'Uninstall*.exe' | Select-Object -First 1
      if ($uninstaller) {
        [void](Step 'uninstall-app' {
          $removed = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -WindowStyle Hidden -PassThru
          if (-not $removed.WaitForExit(120000) -or $removed.ExitCode -ne 0) { throw 'Uninstaller failed or timed out' }
          $deadline = (Get-Date).AddSeconds(30)
          while ((Test-Path -LiteralPath (Join-Path $installDir 'Viva.exe')) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
          if (Test-Path -LiteralPath (Join-Path $installDir 'Viva.exe')) { throw 'Viva.exe remains after uninstall' }
        })
      } elseif ($installed) { $results['uninstall-app'] = 'FAIL (uninstaller missing)' }
    }
  }
}

$summary = $results.GetEnumerator() | ForEach-Object { "$($_.Key): $($_.Value)" }
$summary | Set-Content (Join-Path $report 'summary.txt') -Encoding UTF8
$summary | Write-Host
Write-Host "Report: $report"
if ($results.Values | Where-Object { $_ -like 'FAIL*' }) { exit 1 }
