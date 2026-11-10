<#
.SYNOPSIS
  Keep an unpacked copy of Wtv on this computer in step with the LAN build served from the
  dev machine (scripts/lan/serve.ts in the Wtv repo). Dev only; Windows PowerShell 5.1+.

.DESCRIPTION
  Asks <Server>/build.json which build is current. When it isn't the one in -Target, it
  downloads <Server>/wtv.zip, unpacks it, and mirrors it into -Target, build.json last (that
  file is what Wtv watches to reload itself). The folder stays put, so Chrome keeps the same
  extension ID, and Wtv keeps its playlists and settings.

  First time (the server's front page has this line with its address filled in):
    powershell -ExecutionPolicy Bypass -File wtv-sync.ps1 -Server http://<dev-machine>:8788 -Install
  then once in Chrome: chrome://extensions > Developer mode > Load unpacked > the -Target folder.

.PARAMETER Server
  The LAN server, e.g. http://192.168.1.20:8788

.PARAMETER Target
  The unpacked extension folder. Default: %LOCALAPPDATA%\Wtv\extension

.PARAMETER Every
  Seconds between checks. 0 (the default) checks once.

.PARAMETER Install
  Copy this script to %LOCALAPPDATA%\Wtv, sync now, then keep checking every minute: from now
  on, and from each sign-in (a file in the Startup folder).

.PARAMETER Uninstall
  Stop checking (now and at sign-in). The extension folder is left alone.
#>
[CmdletBinding()]
param(
  [string]$Server,
  [string]$Target = (Join-Path $env:LOCALAPPDATA 'Wtv\extension'),
  [int]$Every = 0,
  [switch]$Install,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest crawls with the progress bar on.

$WtvDir = Join-Path $env:LOCALAPPDATA 'Wtv'
$Installed = Join-Path $WtvDir 'wtv-sync.ps1'
$StartupFile = Join-Path ([Environment]::GetFolderPath('Startup')) 'Wtv sync.cmd'
$LogFile = Join-Path $WtvDir 'wtv-sync.log'

function Write-Log([string]$Text) {
  $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $Text
  Write-Host $line
  try {
    New-Item -ItemType Directory -Force -Path $WtvDir | Out-Null
    Add-Content -LiteralPath $LogFile -Value $line
  } catch { }
}

# Other copies of this script that keep checking (from -Install or sign-in).
function Stop-Watchers {
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*wtv-sync.ps1*-Every*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Get-BuildId([string]$Folder) {
  $file = Join-Path $Folder 'build.json'
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try { return (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).id } catch { return $null }
}

# /MIR deletes whatever else is in -Target: only ever do that to a Wtv folder.
function Assert-Target {
  if (-not (Test-Path -LiteralPath $Target)) { return }
  $any = Get-ChildItem -LiteralPath $Target -Force | Select-Object -First 1
  if ($any -and -not (Test-Path -LiteralPath (Join-Path $Target 'manifest.json'))) {
    throw "$Target isn't empty and doesn't hold an extension: not replacing what's in it. Pick another -Target."
  }
}

# One check. True when it updated the folder.
function Sync-Once {
  $remote = Invoke-RestMethod -Uri "$Server/build.json" -TimeoutSec 15 -UseBasicParsing
  if (-not $remote.id) { throw "$Server/build.json has no build id" }
  if ($remote.id -eq (Get-BuildId $Target)) { return $false }

  Assert-Target
  $work = Join-Path ([IO.Path]::GetTempPath()) ('wtv-sync-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    $zip = Join-Path $work 'wtv.zip'
    $unpacked = Join-Path $work 'wtv'
    Invoke-WebRequest -Uri "$Server/wtv.zip" -OutFile $zip -TimeoutSec 300 -UseBasicParsing
    Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
    $id = Get-BuildId $unpacked
    if (-not $id -or -not (Test-Path -LiteralPath (Join-Path $unpacked 'manifest.json'))) {
      throw 'the download is not a whole Wtv build'
    }
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    # Everything but build.json, then build.json: Wtv only reloads once the rest is in place.
    robocopy $unpacked $Target /MIR /XF build.json /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copying into $Target failed (robocopy $LASTEXITCODE)" }
    Copy-Item -LiteralPath (Join-Path $unpacked 'build.json') -Destination (Join-Path $Target 'build.json') -Force
    Write-Log "updated to $id"
    return $true
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($Uninstall) {
  Stop-Watchers
  Remove-Item -LiteralPath $StartupFile -ErrorAction SilentlyContinue
  Write-Host "Stopped checking for Wtv builds. $Target is still there (and still loaded in Chrome)."
  exit 0
}

if (-not $Server -or $Server -notmatch '^https?://') {
  throw '-Server is needed, e.g. -Server http://192.168.1.20:8788'
}
$Server = $Server.TrimEnd('/')
$Target = [IO.Path]::GetFullPath($Target)

if ($Install) {
  New-Item -ItemType Directory -Force -Path $WtvDir | Out-Null
  if ($PSCommandPath -ne $Installed) { Copy-Item -LiteralPath $PSCommandPath -Destination $Installed -Force }
  Unblock-File -LiteralPath $Installed -ErrorAction SilentlyContinue
  $watch = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Installed`" -Server `"$Server`" -Target `"$Target`" -Every 60"
  Set-Content -LiteralPath $StartupFile -Encoding ASCII -Value "@echo off`r`nstart `"`" /min powershell.exe $watch"
  Stop-Watchers
  try { [void](Sync-Once) } catch { Write-Log "first sync failed: $($_.Exception.Message)" }
  Start-Process -FilePath 'powershell.exe' -ArgumentList $watch -WindowStyle Hidden
  Write-Host ''
  Write-Host 'Checking for new Wtv builds every minute (now, and from each sign-in).'
  Write-Host 'Once, in Chrome: chrome://extensions > Developer mode on > Load unpacked >'
  Write-Host "  $Target"
  Write-Host 'Never Remove the extension (that deletes its playlists); Reload is fine.'
  Write-Host "Log: $LogFile"
  exit 0
}

if ($Every -le 0) {
  try {
    if (-not (Sync-Once)) { Write-Host "Already up to date: $(Get-BuildId $Target)" }
    exit 0
  } catch {
    Write-Log "sync failed: $($_.Exception.Message)"
    exit 1
  }
}

$lastError = $null
while ($true) {
  try {
    [void](Sync-Once)
    $lastError = $null
  } catch {
    # The dev machine is often asleep or off: say so once, not every minute.
    $message = $_.Exception.Message
    if ($message -ne $lastError) { Write-Log "check failed: $message" }
    $lastError = $message
  }
  Start-Sleep -Seconds $Every
}
