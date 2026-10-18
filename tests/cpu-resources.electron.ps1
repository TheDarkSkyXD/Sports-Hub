param([string]$Label = 'app', [ValidateRange(1, 300)][int]$Seconds = 30)
if ($Label -notmatch '^[a-z0-9-]+$') { throw 'Use a lowercase measurement label' }
$binary = Join-Path (Get-Location) '.desktop-runtime/electron/electron.exe'
$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$previous = @{}
$rows = @()
$cpuSeconds = 0.0
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$last = 0.0
for ($index = 0; $index -le $Seconds; $index++) {
  $now = $clock.Elapsed.TotalSeconds
  $current = @(Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $binary })
  if ($index -eq 0 -and $current.Count -eq 0) { throw 'The local Electron app must be running' }
  foreach ($item in $current) {
    $key = "$($item.Id):$($item.StartTime.Ticks)"
    $cpu = $item.CPU
    if ($index -gt 0) {
      $delta = if ($previous.ContainsKey($key)) { $cpu - $previous[$key] } else { $cpu }
      $cpuSeconds += $delta
      $rows += [pscustomobject]@{sample=$index; pid=$item.Id; machinePercent=100*$delta/($now-$last)/$cores; bytes=$item.WorkingSet64}
    }
    $previous[$key] = $cpu
  }
  $last = $now
  if ($index -lt $Seconds) { Start-Sleep -Milliseconds 1000 }
}
$result = [pscustomobject]@{label=$Label; cores=$cores; elapsed=$last; machineCpuPercent=100*$cpuSeconds/$last/$cores; rows=$rows}
New-Item -ItemType Directory -Path .scratch/performance -Force | Out-Null
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath ".scratch/performance/cpu-$Label.json"
$rows | Group-Object pid | ForEach-Object { [pscustomobject]@{pid=$_.Name; machinePercent=($_.Group | Measure-Object machinePercent -Sum).Sum/$Seconds} } | Sort-Object machinePercent -Descending | Select-Object -First 8 | Format-Table
"Sampled total machine CPU % = $($result.machineCpuPercent)"
