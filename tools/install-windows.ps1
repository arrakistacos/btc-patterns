<#
  BTC Pattern Watch - signal bot installer for Windows
  Installs the phone-alert bot into %USERPROFILE%\dev\btc-patterns-bot and keeps it running in the
  background (starts at logon, restarts itself if it stops). Re-run any time to update or change settings.

  One-line install (PowerShell):
    irm https://raw.githubusercontent.com/arrakistacos/btc-patterns/main/tools/install-windows.ps1 -OutFile $env:TEMP\btc-bot.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\btc-bot.ps1 -Topic YOUR-NTFY-TOPIC

  Options:
    -Topic     your ntfy topic (required)
    -Target    confidence target 60-95 (default 80)
    -Bankroll  dollars, used for bet sizing (default 0)
    -MinModel  only alert when the model's win chance is at least this % (default 80)
    -MinMarket ...and Polymarket's odds for that side are at least this % (default 80)
    -KeepAwake set "plugged in: never sleep, closing the lid does nothing" (default on; use -KeepAwake:$false to skip)
    -Uninstall stop and remove the bot
#>
param(
  [string]$Topic = '',
  [int]$Target = 80,
  [double]$Bankroll = 0,
  [int]$MinModel = 80,
  [int]$MinMarket = 80,
  [bool]$KeepAwake = $true,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Windows PowerShell downloads are very slow with the progress bar on
$TaskName = 'BTC Pattern Watch signal bot'
$Dir = Join-Path $env:USERPROFILE 'dev\btc-patterns-bot'
function Say($m, $c = 'Cyan') { Write-Host $m -ForegroundColor $c }

if ($Uninstall) {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*signal-bot.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Say "Removed the scheduled task and stopped the bot. Files are still in $Dir (delete the folder if you like)." 'Green'
  exit 0
}
if (-not $Topic) { Say 'Please pass your ntfy topic:  -Topic btcpw-xxxxxxxx' 'Red'; exit 1 }
if ($Topic -notmatch '^[A-Za-z0-9_-]{8,64}$') { Say 'Topic must be 8-64 letters, digits, - or _' 'Red'; exit 1 }
if (@(60, 65, 70, 75, 80, 85, 90, 95) -notcontains $Target) { Say 'Target must be one of 60, 65, 70, 75, 80, 85, 90, 95' 'Red'; exit 1 }
if ($MinModel -lt 50 -or $MinModel -gt 99 -or $MinMarket -lt 50 -or $MinMarket -gt 99) { Say 'MinModel and MinMarket must be between 50 and 99' 'Red'; exit 1 }

# 1) Node.js 22+ (built-in fetch + WebSocket)
function NodeMajor { try { $v = (& node --version) 2>$null; if ($v -match '^v(\d+)') { return [int]$Matches[1] } } catch {} ; return 0 }
if ((NodeMajor) -lt 22) {
  Say 'Installing Node.js LTS with winget...'
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Say 'winget is not available. Install Node.js 22+ from https://nodejs.org and run this again.' 'Red'; exit 1 }
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if ((NodeMajor) -lt 22) { Say 'Node.js 22+ is still not available. Install it from https://nodejs.org and run this again.' 'Red'; exit 1 }
}
$Node = (Get-Command node).Source
Say "Node.js $(& node --version) at $Node" 'Green'

# 2) Download the latest code from GitHub (no git needed)
Say 'Downloading the latest code...'
$zip = Join-Path $env:TEMP 'btc-patterns-main.zip'
$tmp = Join-Path $env:TEMP 'btc-patterns-main'
Invoke-WebRequest 'https://github.com/arrakistacos/btc-patterns/archive/refs/heads/main.zip' -OutFile $zip -UseBasicParsing
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive $zip -DestinationPath $tmp -Force
$src = Join-Path $tmp 'btc-patterns-main'
if (-not (Test-Path (Join-Path $src 'tools\signal-bot.mjs'))) { Say 'The downloaded code has no tools\signal-bot.mjs yet. Merge the phone-alerts pull request first.' 'Red'; exit 1 }
New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'tools') | Out-Null
foreach ($f in 'engine.js', 'signal.js', 'tools\signal-bot.mjs') { Copy-Item (Join-Path $src $f) (Join-Path $Dir $f) -Force }
Remove-Item $tmp -Recurse -Force; Remove-Item $zip -Force

# 3) Launcher: sets the settings and restarts the bot if it ever exits
$runner = @'
$ErrorActionPreference = 'Continue'
$env:NTFY_TOPIC = '__TOPIC__'
$env:TARGET = '__TARGET__'
$env:BANKROLL = '__BANKROLL__'
$env:MIN_MODEL = '__MINMODEL__'
$env:MIN_MARKET = '__MINMARKET__'
$Node = '__NODE__'
$Dir = '__DIR__'
Set-Location $Dir
$log = Join-Path $Dir 'signal-bot.log'
$env:LOG_FILE = $log            # the bot appends its own log (UTF-8)
while ($true) {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) { Move-Item $log "$log.old" -Force }
  & $Node 'tools\signal-bot.mjs'
  Add-Content -Path $log -Encoding UTF8 -Value ("$(Get-Date -Format s) bot exited (code $LASTEXITCODE), restarting in 10s")
  Start-Sleep -Seconds 10
}
'@
$q = { param($v) "$v".Replace("'", "''") }
$runner = $runner.Replace('__TOPIC__', $Topic).Replace('__TARGET__', "$Target").Replace('__BANKROLL__', "$Bankroll").Replace('__MINMODEL__', "$MinModel").Replace('__MINMARKET__', "$MinMarket").Replace('__NODE__', (& $q $Node)).Replace('__DIR__', (& $q $Dir))
Set-Content -Path (Join-Path $Dir 'run-bot.ps1') -Value $runner -Encoding UTF8

# 4) Scheduled task: start at logon, hidden, restart if it stops, keep running on battery
Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*signal-bot.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dir\run-bot.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Sends ntfy phone alerts when BTC Pattern Watch says BUY NOW' -ErrorAction Stop | Out-Null
} catch { Say "Could not create the background task ($($_.Exception.Message)). Open PowerShell with 'Run as administrator' and run this again." 'Red'; exit 1 }
Start-ScheduledTask -TaskName $TaskName
Say "Bot installed in $Dir and running in the background." 'Green'

# 5) Keep the laptop awake while plugged in
if ($KeepAwake) {
  $codes = @()
  powercfg /change standby-timeout-ac 0 | Out-Null; $codes += $LASTEXITCODE
  powercfg /change hibernate-timeout-ac 0 | Out-Null; $codes += $LASTEXITCODE
  powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null; $codes += $LASTEXITCODE
  powercfg /setactive SCHEME_CURRENT | Out-Null; $codes += $LASTEXITCODE
  if ($codes | Where-Object { $_ -ne 0 }) {
    Say 'Could not change all power settings (may need administrator). Set them by hand: Settings > System > Power > "When plugged in, put my device to sleep after: Never", and Control Panel > Power Options > "Choose what closing the lid does" > Plugged in: Do nothing.' 'Yellow'
  } else {
    Say 'Power: while plugged in, the laptop no longer sleeps and closing the lid does nothing. (Battery settings unchanged.)' 'Green'
  }
}

# 6) Test push + show the first log lines
Say 'Sending a test alert to your phone...'
$env:NTFY_TOPIC = $Topic
& $Node (Join-Path $Dir 'tools\signal-bot.mjs') --test
Start-Sleep -Seconds 8
Say "`nFirst lines of the bot log ($Dir\signal-bot.log):"
if (Test-Path "$Dir\signal-bot.log") { Get-Content "$Dir\signal-bot.log" -Tail 6 -Encoding UTF8 }
Say "`nDone. To watch it:  Get-Content $Dir\signal-bot.log -Wait -Tail 20 -Encoding UTF8" 'Green'
Say "To change settings, run this installer again. To remove:  -Uninstall" 'Green'
