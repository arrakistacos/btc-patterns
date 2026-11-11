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
    -Autopilot set up autopilot: asks for your Polymarket US API key (polymarket.us/developer) and a password
               for the autopilot page, saves them in polymarket.env next to the bot, and checks the key
    -Uninstall stop and remove the bot
#>
param(
  [string]$Topic = '',
  [int]$Target = 80,
  [double]$Bankroll = 0,
  [int]$MinModel = 80,
  [int]$MinMarket = 80,
  [bool]$KeepAwake = $true,
  [switch]$Autopilot,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Windows PowerShell downloads are very slow with the progress bar on
$TaskName = 'BTC Pattern Watch signal bot'
$Dir = Join-Path $env:USERPROFILE 'dev\btc-patterns-bot'
function Say($m, $c = 'Cyan') { Write-Host $m -ForegroundColor $c }
# Stop every running copy: the scheduled task, its hidden restart loop (run-bot.ps1) and the bot itself.
# Killing only node.exe is not enough: the old loop restarts it 10 s later with its old settings.
function StopBot {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -like '*run-bot.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*signal-bot.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
  Remove-Item (Join-Path $Dir 'bot.lock') -ErrorAction SilentlyContinue   # so the new copy doesn't wait for the stopped one's lock to expire
}

# The background task was created as administrator, so replacing it needs administrator too. Check before changing anything.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Say "Please run this from PowerShell opened with 'Run as administrator' (right-click PowerShell > Run as administrator). Nothing was changed." 'Red'; exit 1 }
if ($Uninstall) {
  StopBot
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
  Say "Removed the scheduled task and stopped the bot. Files are still in $Dir (delete the folder if you like)." 'Green'
  exit 0
}
if (-not $Topic) { Say 'Please pass your ntfy topic:  -Topic btcpw-xxxxxxxx' 'Red'; exit 1 }
if ($Topic -notmatch '^[A-Za-z0-9_-]{8,64}$') { Say 'Topic must be 8-64 letters, digits, - or _' 'Red'; exit 1 }
if ($Topic -match '^(your|my)[-_]?(real[-_]?)?topic' -or $Topic -match 'topic[-_]?here') { Say "'$Topic' is the example from the instructions. Use the topic you subscribed to in the ntfy app on your phone." 'Red'; exit 1 }
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
foreach ($f in 'engine.js', 'signal.js', 'apcrypto.js', 'tools\signal-bot.mjs', 'tools\autopilot.mjs') { Copy-Item (Join-Path $src $f) (Join-Path $Dir $f) -Force }
Remove-Item $tmp -Recurse -Force; Remove-Item $zip -Force

# 2b) Autopilot secrets: Polymarket US API key + autopilot page password, kept only on this laptop
$EnvFile = Join-Path $Dir 'polymarket.env'
function Plain($sec) { $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) } }
if ($Autopilot) {
  $old = @{}
  if (Test-Path $EnvFile) { foreach ($l in Get-Content $EnvFile) { if ($l -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $old[$Matches[1]] = $Matches[2] } } }
  Say "`nAutopilot setup. Create an API key at https://polymarket.us/developer (sign in the same way as in the app)."
  if ($old.PM_KEY_ID) { Say '(Press Enter to keep the saved value.)' 'DarkGray' }
  $keyId = Read-Host 'Polymarket US Key ID'
  if (-not $keyId) { $keyId = $old.PM_KEY_ID }
  $secret = Plain (Read-Host 'Polymarket US Secret Key (hidden)' -AsSecureString)
  if (-not $secret) { $secret = $old.PM_SECRET_KEY }
  if ($secret) { try { $n = [Convert]::FromBase64String($secret.Trim()).Length; if ($n -ne 32 -and $n -ne 64) { throw "length $n" } } catch { Say "That secret key doesn't look right (it should be the base64 text shown once when you created the key)." 'Red'; exit 1 } }
  $pw = $old.AUTOPILOT_PASSWORD
  for (;;) {
    $p1 = Plain (Read-Host 'Choose a password for the autopilot page (8+ characters, hidden)' -AsSecureString)
    if (-not $p1 -and $pw) { break }
    if ($p1.Length -lt 8) { Say 'At least 8 characters, please.' 'Yellow'; continue }
    $p2 = Plain (Read-Host 'Type it again' -AsSecureString)
    if ($p1 -ne $p2) { Say "They don't match, try again." 'Yellow'; continue }
    $pw = $p1; break
  }
  $lines = @('# BTC Pattern Watch autopilot secrets. Keep this file private.')
  if ($keyId) { $lines += "PM_KEY_ID=$keyId" }
  if ($secret) { $lines += "PM_SECRET_KEY=$($secret.Trim())" }
  $lines += "AUTOPILOT_PASSWORD=$pw"
  Set-Content -Path $EnvFile -Value $lines -Encoding ASCII
  icacls $EnvFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 2>&1 | Out-Null   # only your account can read it (already locked down after the first install)
  Say "Saved to $EnvFile (readable only by $env:USERNAME)." 'Green'
}

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
StopBot
Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
Start-Sleep -Seconds 1
StopBot   # in case a loop restarted node in the meantime
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dir\run-bot.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Sends ntfy phone alerts when BTC Pattern Watch says BUY NOW' -ErrorAction Stop | Out-Null
} catch { Say "Could not create the background task ($($_.Exception.Message)). Open PowerShell with 'Run as administrator' and run this again." 'Red'; exit 1 }
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$n = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -like '*run-bot.ps1*' }).Count
if ($n -gt 1) { Say "Warning: $n copies of the bot are running. Restart the laptop to clear the old one." 'Yellow' }
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

# 5b) Check the Polymarket US key
if ($Autopilot -and (Test-Path $EnvFile)) {
  Say "`nChecking your Polymarket US key..."
  $env:NTFY_TOPIC = $Topic
  $out = & $Node (Join-Path $Dir 'tools\signal-bot.mjs') --check-autopilot 2>&1 | Out-String
  if ($out -match 'Key works') {
    if ($out -match '"buyingPower":\s*([\d.]+)') { Say "Key works. Buying power: `$$($Matches[1])" 'Green' } else { Say 'Key works.' 'Green' }
  } elseif ($out -match 'No Polymarket US key') { Say 'No API key saved: autopilot will run in practice mode only.' 'Yellow' }
  else { Say 'Polymarket did not accept the key. Details:' 'Red'; Write-Host $out }
  Set-Content -Path (Join-Path $Dir 'autopilot-check.txt') -Value $out -Encoding UTF8
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
if (Test-Path $EnvFile) { Say "Autopilot page: https://arrakistacos.github.io/btc-patterns/autopilot.html?topic=$Topic  (log in with your autopilot password)" 'Green' }
else { Say "Autopilot runs in practice mode. To control it from your phone and add your Polymarket key, run this again with -Autopilot." 'DarkGray' }
