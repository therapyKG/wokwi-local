<#
.SYNOPSIS
Sets up wokwi-local on Windows: installs whatever is missing, starts the server now and at every
login, and walks you through loading the browser extension. Safe to run again.

.DESCRIPTION
Missing tools are downloaded into %LOCALAPPDATA%\wokwi-local, never system-wide, so no admin
rights are needed. For testing, setting WOKWI_SETUP_FORCE_DOWNLOAD=1 downloads them even if
they're installed.

If Windows refuses to run the script, start it with:
  powershell -ExecutionPolicy Bypass -File setup.ps1

.PARAMETER Preload
Also download these boards' cores now, e.g. -Preload uno,pico,esp32 (ESP32 is a few GB).

.PARAMETER NoBrowser
Don't open the browser's extensions page.

.PARAMETER Uninstall
Stop the server and remove it from login.
#>
param(
  [string[]]$Preload = @(),
  [switch]$NoBrowser,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is far faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = $PSScriptRoot
$Tools = Join-Path $env:LOCALAPPDATA 'wokwi-local'
$Log = Join-Path $Tools 'server.log'
$Port = 9420
$NodeMajor = 22
$TaskName = 'wokwi-local'
$ForceDownload = [bool]$env:WOKWI_SETUP_FORCE_DOWNLOAD
if ($env:CI) { $NoBrowser = $true }

function Say($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Warning $msg }

# --- Downloads -------------------------------------------------------------------------------

function Get-File($url, $dest) {
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}

# Finds "<sha256>  <name>" in a checksum list and checks the downloaded file against it.
function Assert-Checksum($sumsFile, $name, $file) {
  $line = Get-Content $sumsFile | Where-Object { $_ -match "\s\*?$([regex]::Escape($name))$" } | Select-Object -First 1
  if (-not $line) { throw "no checksum listed for $name" }
  $expected = ($line -split '\s+')[0]
  if ((Get-FileHash $file -Algorithm SHA256).Hash -ne $expected.ToUpper()) { throw "checksum mismatch for $name" }
}

function New-TempDir {
  $dir = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $dir | Out-Null
  $dir
}

$Is64Arm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64'

# --- Node --------------------------------------------------------------------------------------

function Test-Node($path) {
  try {
    & $path -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)" 2>$null
    $LASTEXITCODE -eq 0
  } catch { $false }
}

function Find-Node {
  $candidates = @(Join-Path $Tools 'node\node.exe')
  if (-not $ForceDownload) {
    $candidates += @(Get-Command node.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    $candidates += @("$env:ProgramFiles\nodejs\node.exe")
  }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c) -and (Test-Node $c)) { return $c }
  }
  $null
}

function Install-Node {
  $arch = if ($Is64Arm) { 'arm64' } else { 'x64' }
  $base = "https://nodejs.org/dist/latest-v$NodeMajor.x"
  $tmp = New-TempDir
  Get-File "$base/SHASUMS256.txt" "$tmp\sums"
  $name = (Select-String -Path "$tmp\sums" -Pattern "node-v[0-9.]+-win-$arch\.zip").Matches | Select-Object -First 1
  if (-not $name) { throw "couldn't find a Node $NodeMajor download for win-$arch" }
  $file = $name.Value
  Get-File "$base/$file" "$tmp\$file"
  Assert-Checksum "$tmp\sums" $file "$tmp\$file"
  Expand-Archive "$tmp\$file" -DestinationPath "$tmp\x"
  $dest = Join-Path $Tools 'node'
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  New-Item -ItemType Directory -Path $Tools -Force | Out-Null
  Move-Item (Get-ChildItem "$tmp\x" | Select-Object -First 1).FullName $dest
  Remove-Item $tmp -Recurse -Force
}

# --- arduino-cli -------------------------------------------------------------------------------

function Find-ArduinoCli {
  $candidates = @(Join-Path $Tools 'bin\arduino-cli.exe')
  if (-not $ForceDownload) {
    $candidates += @(Get-Command arduino-cli.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    $candidates += @("$env:LOCALAPPDATA\Microsoft\WinGet\Links\arduino-cli.exe", "$env:ProgramFiles\Arduino CLI\arduino-cli.exe")
  }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  $null
}

function Install-ArduinoCli {
  # arduino-cli has no ARM64 Windows build; the x64 one runs under Windows' built-in emulation.
  $tag = (Invoke-RestMethod 'https://api.github.com/repos/arduino/arduino-cli/releases/latest').tag_name
  $ver = $tag.TrimStart('v')
  $file = "arduino-cli_${ver}_Windows_64bit.zip"
  $base = "https://github.com/arduino/arduino-cli/releases/download/$tag"
  $tmp = New-TempDir
  Get-File "$base/$ver-checksums.txt" "$tmp\sums"
  Get-File "$base/$file" "$tmp\$file"
  Assert-Checksum "$tmp\sums" $file "$tmp\$file"
  Expand-Archive "$tmp\$file" -DestinationPath "$tmp\x"
  $bin = Join-Path $Tools 'bin'
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  Copy-Item "$tmp\x\arduino-cli.exe" $bin -Force
  Remove-Item $tmp -Recurse -Force
}

# --- Login task --------------------------------------------------------------------------------

function Test-Server {
  try {
    (Invoke-WebRequest "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200
  } catch { $false }
}

function Wait-Server {
  for ($i = 0; $i -lt 50; $i++) {
    if (Test-Server) { return $true }
    Start-Sleep -Milliseconds 200
  }
  $false
}

function Stop-Server {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  $script = Join-Path $Root 'server.js'
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($script) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
}

function Quote($s) { '"' + $s + '"' }

# --- Main --------------------------------------------------------------------------------------

if ($Uninstall) {
  Say 'Removing the wokwi-local login task'
  Stop-Server
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Write-Host "Done. The server is stopped and won't start at login."
  Write-Host "Downloaded tools (if any) are in $Tools, and board cores in arduino-cli's data folder"
  Write-Host '(arduino-cli config get directories.data). Delete them yourself if you no longer need them.'
  exit 0
}

Say 'Checking Node.js'
$Node = Find-Node
if ($Node) {
  Write-Host "Using $Node ($(& $Node --version))"
} else {
  Write-Host "Node 18+ not found; downloading Node $NodeMajor into $Tools\node"
  Install-Node
  $Node = Join-Path $Tools 'node\node.exe'
  Write-Host "Installed $(& $Node --version)"
}

Say 'Checking arduino-cli'
$Cli = Find-ArduinoCli
if ($Cli) {
  Write-Host "Using $Cli"
} else {
  Write-Host "arduino-cli not found; downloading it into $Tools\bin"
  Install-ArduinoCli
  $Cli = Join-Path $Tools 'bin\arduino-cli.exe'
}
& $Cli version

if ($Preload.Count -gt 0) {
  # Accept both -Preload uno,pico and -Preload "uno,pico".
  $boards = $Preload | ForEach-Object { $_ -split ',' } | Where-Object { $_ }
  Say "Downloading board cores: $($boards -join ', ')"
  $cores = foreach ($b in $boards) {
    switch -Wildcard ($b) {
      'uno' { 'arduino:avr' } 'mega' { 'arduino:avr' } 'nano' { 'arduino:avr' }
      'pico' { 'rp2040:rp2040' } 'pipico' { 'rp2040:rp2040' }
      'esp32*' { 'esp32:esp32' }
      'attiny85' { 'ATTinyCore:avr' }
      default { throw "unknown board `"$b`" for -Preload (use uno, mega, nano, pico, esp32 or attiny85)" }
    }
  }
  & $Node (Join-Path $Root 'server.js') --arduino-cli $Cli --install-cores (($cores | Select-Object -Unique) -join ',')
  if ($LASTEXITCODE -ne 0) { throw 'installing board cores failed' }
}

Say 'Starting the server now and at every login'
New-Item -ItemType Directory -Path $Tools -Force | Out-Null
# conhost --headless runs the server without a console window.
$arguments = '--headless ' + ((@($Node, (Join-Path $Root 'server.js'), '--arduino-cli', $Cli, '--log', $Log) | ForEach-Object { Quote $_ }) -join ' ')
Stop-Server
$portTaken = Test-Server

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $arguments -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'wokwi-local compile server for wokwi.com' -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
if ($portTaken) {
  Warn "another wokwi-local is already using port $Port (maybe one you started by hand)."
  Warn 'Stop it, and the login task takes over within 10 seconds.'
} else {
  if (-not (Wait-Server)) {
    # The task can't start outside an interactive login (e.g. over SSH); run the same command directly.
    Write-Host 'The login task did not start the server in this session; starting it directly.'
    Start-Process -FilePath 'conhost.exe' -ArgumentList $arguments -WorkingDirectory $Root -WindowStyle Hidden
  }
  if (Wait-Server) {
    Write-Host "Server is running on http://127.0.0.1:$Port"
  } else {
    Warn "the server didn't answer yet. Its log is $Log"
  }
}
Write-Host "Login task: $TaskName (Task Scheduler)"

Say 'Load the browser extension (one time)'
$ext = Join-Path $Root 'extension'
Write-Host @"
Browsers only let you add an unpacked extension by hand:
  1. In Chrome (or Edge, Brave), open chrome://extensions (in Edge: edge://extensions)
  2. Turn on "Developer mode"
  3. Click "Load unpacked" and choose this folder:
       $ext
     In the folder picker, paste the path into the address bar at the top.
  4. On wokwi.com, press play. If the browser asks to access devices on your local network, click Allow.
"@
if (-not $NoBrowser) {
  try { Set-Clipboard -Value $ext; Write-Host '(The folder path is on your clipboard.)' } catch {}
  try { Start-Process 'chrome.exe' 'chrome://extensions' } catch {
    try { Start-Process 'msedge.exe' 'edge://extensions' } catch {}
  }
}

Say 'Done'
Write-Host 'Builds now compile locally whenever this computer is on. Each one is logged in:'
Write-Host "  $Log"
Write-Host 'If you move this folder, run setup.ps1 again so the login task points at the new place.'
