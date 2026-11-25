#Requires -Version 5.1
# Stops Silt and puts this Windows user's proxy back.
$ErrorActionPreference = "Stop"
$Data = Join-Path $env:LOCALAPPDATA "Silt"
$RegPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"

function Refresh-WinInet {
  if (-not ("SiltWinInet" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SiltWinInet {
  [DllImport("wininet.dll", SetLastError = true)]
  public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
}
"@
  }
  [SiltWinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
  [SiltWinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
}

$pidFile = Join-Path $Data "silt.pid"
if (Test-Path $pidFile) {
  $procId = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($procId) {
    Stop-Process -Id ([int]$procId) -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
  $_.CommandLine -like "*silt-agent.mjs*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$backupPath = Join-Path $Data "proxy-backup.json"
if (Test-Path $backupPath) {
  $b = Get-Content $backupPath -Raw | ConvertFrom-Json
  Set-ItemProperty -Path $RegPath -Name ProxyEnable -Value ([int]$b.ProxyEnable)
  if ($b.HadProxyServer) {
    Set-ItemProperty -Path $RegPath -Name ProxyServer -Value $b.ProxyServer
  } else {
    Remove-ItemProperty -Path $RegPath -Name ProxyServer -ErrorAction SilentlyContinue
  }
  if ($b.HadProxyOverride) {
    Set-ItemProperty -Path $RegPath -Name ProxyOverride -Value $b.ProxyOverride
  } else {
    Remove-ItemProperty -Path $RegPath -Name ProxyOverride -ErrorAction SilentlyContinue
  }
  Remove-Item $backupPath -Force
  Refresh-WinInet
}

$envBackup = Join-Path $Data "env-backup.json"
if (Test-Path $envBackup) {
  # Only the names that were saved: an older backup must not wipe variables it never covered.
  $e = Get-Content $envBackup -Raw | ConvertFrom-Json
  foreach ($p in $e.PSObject.Properties) {
    $prev = $(if ($null -eq $p.Value -or $p.Value -eq "") { $null } else { [string]$p.Value })
    [Environment]::SetEnvironmentVariable($p.Name, $prev, "User")
  }
  Remove-Item $envBackup -Force
}

Write-Host "Silt is off. The Windows proxy is back to what it was."
Write-Host "The certificate is still trusted. Remove 'Silt Local Recorder' in certmgr.msc if you want it gone."
Write-Host "The tape is still at $Data\captures.jsonl"
