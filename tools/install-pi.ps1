<#
  BTC Pattern Watch - move the bot to a Raspberry Pi, run from the Windows laptop (PowerShell as administrator).

  The Pi runs the same bot, but never stores your Polymarket key or autopilot password: it starts locked, and this
  laptop sends the secrets from its own polymarket.env over SSH, into the bot's memory only. A restricted SSH key
  (it can only check, unlock or park the bot) plus a laptop task that runs every 5 minutes unlock it again after
  a Pi reboot. The laptop's own bot is turned off so only one bot trades.

    irm https://raw.githubusercontent.com/arrakistacos/btc-patterns/main/tools/install-pi.ps1 -OutFile $env:TEMP\btc-pi.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\btc-pi.ps1

  Options:
    -PiHost   user@address of the Pi (default picactus@192.168.1.118)
    -Topic, -Target, -MinModel, -MinMarket, -Bankroll   default: the laptop bot's current settings
    -Status   just show whether the Pi bot is running / locked
    -Unlock   just unlock the Pi bot now
    -Back     move the bot back to this laptop: park the Pi bot, remove the unlock task, start the laptop bot
#>
param(
  [string]$PiHost = 'picactus@192.168.1.118',
  [string]$Topic = '',
  [int]$Target = 0,
  [int]$MinModel = 0,
  [int]$MinMarket = 0,
  [double]$Bankroll = -1,
  [switch]$Status,
  [switch]$Unlock,
  [switch]$Back
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Say($m, $c = 'Cyan') { Write-Host $m -ForegroundColor $c }
$Dir = Join-Path $env:USERPROFILE 'dev\btc-patterns-bot'
$EnvFile = Join-Path $Dir 'polymarket.env'
$Marker = Join-Path $Dir 'pi-host.txt'
$LaptopTask = 'BTC Pattern Watch signal bot'
$UnlockTask = 'BTC Pattern Watch Pi unlock'
$Ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$Keygen = Join-Path $env:WINDIR 'System32\OpenSSH\ssh-keygen.exe'
$Scp = Join-Path $env:WINDIR 'System32\OpenSSH\scp.exe'
$Key = Join-Path $env:USERPROFILE '.ssh\btc_pi_unlock'
$KnownHosts = Join-Path $env:USERPROFILE '.ssh\known_hosts'   # explicit: the background task may run without your profile loaded
$UnlockScript = Join-Path $Dir 'pi-unlock.ps1'

if (-not (Test-Path $Ssh)) { Say 'The Windows SSH client is missing. Settings > System > Optional features > Add "OpenSSH Client", then run this again.' 'Red'; exit 1 }
# talk to the Pi with the restricted key: status | unlock | park  (exit codes: 0 running, 3 locked, 5 parked, 4 down)
function PiCmd($cmd, $stdin) {
  $ErrorActionPreference = 'Continue'   # ssh writes notices to stderr; with 'Stop' Windows PowerShell would treat them as errors
  $a = @('-i', $Key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '-o', "UserKnownHostsFile=$KnownHosts", $PiHost, $cmd)
  if ($stdin) { $out = $stdin | & $Ssh @a 2>&1 } else { $out = & $Ssh @a 2>&1 }
  return @{ code = $LASTEXITCODE; text = (($out | ForEach-Object { "$_" }) -join ' ').Trim() }
}
function StopLaptopBot {
  Get-ScheduledTask -TaskName $LaptopTask -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -like '*run-bot.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*signal-bot.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
  Remove-Item (Join-Path $Dir 'bot.lock') -ErrorAction SilentlyContinue
}

if ($Status) { $r = PiCmd 'status'; Say "Pi bot: $($r.text)" ($(if ($r.code -eq 0) { 'Green' } else { 'Yellow' })); exit $r.code }
if ($Unlock) {
  if (-not (Test-Path $EnvFile)) { Say "No $EnvFile on this laptop." 'Red'; exit 1 }
  $r = PiCmd 'unlock' (Get-Content $EnvFile); Say "Pi bot: $($r.text)" ($(if ($r.code -eq 0) { 'Green' } else { 'Red' })); exit $r.code
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Say "Please run this from PowerShell opened with 'Run as administrator'. Nothing was changed." 'Red'; exit 1 }

if ($Back) {
  Say 'Moving the bot back to this laptop...'
  $r = PiCmd 'park'; Say "Pi bot: $($r.text)" ($(if ($r.code -eq 0) { 'Green' } else { 'Yellow' }))
  if ($r.code -ne 0) { Say 'Could not reach the Pi to park it. Make sure it is off or parked before the laptop bot trades, or two bots would place double trades.' 'Red'; exit 1 }
  Get-ScheduledTask -TaskName $UnlockTask -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
  Remove-Item $Marker -ErrorAction SilentlyContinue
  Enable-ScheduledTask -TaskName $LaptopTask -ErrorAction SilentlyContinue | Out-Null
  Start-ScheduledTask -TaskName $LaptopTask -ErrorAction SilentlyContinue
  Say 'The laptop bot is running again and the Pi bot is parked (it stays quiet until you run this setup again).' 'Green'
  Say 'Note: the Pi kept its own copy of the bot state; the laptop continues from the state it had when the bot moved.' 'DarkGray'
  exit 0
}

# ---------------------------------------------------------------- move the bot to the Pi
if (-not (Test-Path $EnvFile)) { Say "No $EnvFile yet. Set up autopilot on the laptop first (install-windows.ps1 -Autopilot), then run this." 'Red'; exit 1 }
# settings: the laptop bot's current ones unless given
$runBot = Join-Path $Dir 'run-bot.ps1'; $cur = @{}
if (Test-Path $runBot) { foreach ($l in Get-Content $runBot) { if ($l -match "^\`$env:([A-Z_]+) = '(.*)'$") { $cur[$Matches[1]] = $Matches[2] } } }
if (-not $Topic) { $Topic = $cur.NTFY_TOPIC }
if (-not $Target) { $Target = [int]($(if ($cur.TARGET) { $cur.TARGET } else { 80 })) }
if (-not $MinModel) { $MinModel = [int]($(if ($cur.MIN_MODEL) { $cur.MIN_MODEL } else { 80 })) }
if (-not $MinMarket) { $MinMarket = [int]($(if ($cur.MIN_MARKET) { $cur.MIN_MARKET } else { 80 })) }
if ($Bankroll -lt 0) { $Bankroll = [double]($(if ($cur.BANKROLL) { $cur.BANKROLL } else { 0 })) }
if ($Topic -notmatch '^[A-Za-z0-9_-]{8,64}$') { Say 'Pass your ntfy topic: -Topic btcpw-xxxxxxxx' 'Red'; exit 1 }
$first = -not (Test-Path $Marker)

# 1) the laptop's restricted key for the Pi (no passphrase: it can only check, unlock or park the bot)
if (-not (Test-Path $Key)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $Key) | Out-Null
  cmd /c "`"$Keygen`" -q -t ed25519 -f `"$Key`" -N `"`" -C btc-bot-unlock" | Out-Null   # via cmd: an empty passphrase survives
  if (-not (Test-Path "$Key.pub")) { Say 'Could not create the SSH key.' 'Red'; exit 1 }
}
$pub = ((Get-Content "$Key.pub" -Raw).Trim() -split ' ')[0..1] -join ' '

# 2) stop the laptop bot (only one bot may trade), and carry its state over the first time
Say 'Stopping the laptop bot...'
StopLaptopBot
Disable-ScheduledTask -TaskName $LaptopTask -ErrorAction SilentlyContinue | Out-Null
$stateFiles = @()
if ($first) {
  $stage = Join-Path $env:TEMP 'btc-pi-state'; if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }; New-Item -ItemType Directory -Path $stage | Out-Null
  foreach ($f in 'autopilot-state.json', 'scoreboard.json', 'ntfy-budget.json') {
    $p = Join-Path $Dir $f
    if (Test-Path $p) { $d = Join-Path $stage "btc-incoming-$f"; Copy-Item $p $d; $stateFiles += $d }
  }
}
function Restore { Say 'Setup failed, so the laptop bot is starting again.' 'Yellow'; Enable-ScheduledTask -TaskName $LaptopTask -ErrorAction SilentlyContinue | Out-Null; Start-ScheduledTask -TaskName $LaptopTask -ErrorAction SilentlyContinue }

# 3) install / update on the Pi (asks for the Pi password, up to twice, unless this laptop already has SSH access)
Say "Setting up the Pi ($PiHost). Enter the Pi password if asked..."
if ($stateFiles.Count) {
  Say 'Copying the bot state (trades, ledger, settings) to the Pi...'
  & $Scp -q -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$KnownHosts" @stateFiles "$($PiHost):"
  if ($LASTEXITCODE -ne 0) { Restore; exit 1 }
  Remove-Item $stage -Recurse -Force
}
$remote = "curl -fsSL https://raw.githubusercontent.com/arrakistacos/btc-patterns/main/tools/pi-setup.sh -o /tmp/btc-pi-setup.sh && bash /tmp/btc-pi-setup.sh --topic $Topic --target $Target --min-model $MinModel --min-market $MinMarket --bankroll $Bankroll --unlock-key '$pub'$(if ($stateFiles.Count) { ' --state' } else { '' })"
& $Ssh -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$KnownHosts" $PiHost $remote
if ($LASTEXITCODE -ne 0) { Restore; exit 1 }

# 4) unlock it now
Say 'Unlocking the Pi bot...'
$r = $null
for ($i = 0; $i -lt 10; $i++) { $r = PiCmd 'status'; if ($r.code -eq 3 -or $r.code -eq 5 -or $r.code -eq 0) { break }; Start-Sleep -Seconds 3 }
$r = PiCmd 'unlock' (Get-Content $EnvFile)
if ($r.code -ne 0) { Say "Could not unlock the Pi bot: $($r.text)" 'Red'; Restore; exit 1 }
Say "Pi bot: $($r.text)" 'Green'
Set-Content -Path $Marker -Value $PiHost -Encoding ASCII

# 5) auto-unlock: every 5 minutes, also when nobody is logged in (no password stored: S4U)
$u = @'
$Ssh = '__SSH__'; $Key = '__KEY__'; $PiHost = '__HOST__'; $EnvFile = '__ENV__'; $Log = '__LOG__'; $Known = '__KNOWN__'
function Note($m) { if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 1MB)) { Move-Item $Log "$Log.old" -Force }; Add-Content -Path $Log -Value "$(Get-Date -Format s) $m" }
$a = @('-i', $Key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '-o', "UserKnownHostsFile=$Known", $PiHost)
$s = (& $Ssh @a status 2>&1 | ForEach-Object { "$_" }) -join ' '
if ($LASTEXITCODE -eq 3) { $r = (Get-Content $EnvFile | & $Ssh @a unlock 2>&1 | ForEach-Object { "$_" }) -join ' '; Note "Pi was locked; unlock: $r" }
elseif ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 5) { Note "Pi check: $s" }
'@
$q = { param($v) "$v".Replace("'", "''") }
$u = $u.Replace('__SSH__', (& $q $Ssh)).Replace('__KEY__', (& $q $Key)).Replace('__HOST__', (& $q $PiHost)).Replace('__ENV__', (& $q $EnvFile)).Replace('__LOG__', (& $q (Join-Path $Dir 'pi-unlock.log'))).Replace('__KNOWN__', (& $q $KnownHosts))
Set-Content -Path $UnlockScript -Value $u -Encoding UTF8
Get-ScheduledTask -TaskName $UnlockTask -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$UnlockScript`""
$t1 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$t2 = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $UnlockTask -Action $action -Trigger @($t1, $t2) -Principal $principal -Settings $settings -Description 'Unlocks the BTC Pattern Watch bot on the Raspberry Pi after it restarts (secrets stay on this laptop)' | Out-Null

Say "`nDone. The bot now runs on the Pi ($PiHost); the laptop bot is off." 'Green'
Say "  Check:      powershell -ExecutionPolicy Bypass -File $env:TEMP\btc-pi.ps1 -Status" 'DarkGray'
Say "  Move back:  powershell -ExecutionPolicy Bypass -File $env:TEMP\btc-pi.ps1 -Back   (as administrator)" 'DarkGray'
Say "  Pi log:     ssh $PiHost tail -f btc-bot/signal-bot.log" 'DarkGray'
