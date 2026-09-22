param([string]$PortableRoot = 'artifacts/agent-upgrade/20260910-portable/CostHub-Portable', [string]$OldDb = 'artifacts/agent-upgrade/20260910-p00/database-copy.db')
$portable = (Resolve-Path $PortableRoot).Path
$runs = @()
foreach ($case in @(@{ Name = 'clean'; Database = $null }, @{ Name = 'old-db-copy'; Database = (Resolve-Path $OldDb).Path })) {
  $runDir = Join-Path $portable $case.Name
  New-Item -ItemType Directory -Force -Path $runDir | Out-Null
  Copy-Item (Join-Path $portable 'CostHub.exe') (Join-Path $runDir 'CostHub.exe') -Force
  if ($case.Database) { Copy-Item $case.Database (Join-Path $runDir 'costhub.db') -Force }
  $process = Start-Process -FilePath (Join-Path $runDir 'CostHub.exe') -WorkingDirectory $runDir -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 8
  $alive = -not $process.HasExited
  $exitCode = if ($process.HasExited) { $process.ExitCode } else { $null }
  if ($alive) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() }
  $runs += [ordered]@{ name = $case.Name; directory = $runDir; started = $true; aliveAfter8s = $alive; exitCode = $exitCode; databaseCreated = Test-Path (Join-Path $runDir 'costhub.db') }
}
$result = [ordered]@{ mode = 'portable'; runs = $runs; note = 'isolated launch; no formal database; old-db-copy uses a SQLite copy.' }
$json = $result | ConvertTo-Json -Depth 5
$json | Set-Content -LiteralPath (Join-Path $portable "portable-launch.json") -Encoding UTF8
$json
