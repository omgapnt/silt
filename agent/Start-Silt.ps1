#Requires -Version 5.1
# Starts Silt on this Windows user. Leaves this window open while recording.
# Closing the window, or running Stop-Silt, puts the proxy back.
param([switch]$Force)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Data = Join-Path $env:LOCALAPPDATA "Silt"
New-Item -ItemType Directory -Force -Path $Data | Out-Null
$RegPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
$script:ProxyApplied = $false
$script:AgentProcess = $null

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

function Restore-SiltProxy {
  if (-not $script:ProxyApplied) { return }
  $backupPath = Join-Path $Data "proxy-backup.json"
  if (Test-Path $backupPath) {
    $b = Get-Content $backupPath -Raw | ConvertFrom-Json
    Set-ItemProperty -Path $RegPath -Name ProxyEnable -Value ([int]$b.ProxyEnable)
    if ($b.HadProxyServer) {
      Set-ItemProperty -Path $RegPath -Name ProxyServer -Value ([string]$b.ProxyServer)
    } else {
      Remove-ItemProperty -Path $RegPath -Name ProxyServer -ErrorAction SilentlyContinue
    }
    if ($b.HadProxyOverride) {
      Set-ItemProperty -Path $RegPath -Name ProxyOverride -Value ([string]$b.ProxyOverride)
    } else {
      Remove-ItemProperty -Path $RegPath -Name ProxyOverride -ErrorAction SilentlyContinue
    }
    Remove-Item $backupPath -Force
    try { Refresh-WinInet } catch { }
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
  $script:ProxyApplied = $false
}

# Variables Silt sets for this user. Node ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY=1
# (Node 22.21+ / 24.5+). The CA ones make Node, Bun, Python and OpenSSL tools trust Silt; those
# ignore the Windows certificate store.
$EnvNames = @("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE")

function Find-Node {
  $candidates = @(
    (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LocalAppData\Programs\nodejs\node.exe"
  ) | Where-Object { $_ -and (Test-Path $_) }
  return @($candidates | Select-Object -First 1)[0]
}

function Enable-SiltProxy {
  $backupPath = Join-Path $Data "proxy-backup.json"
  if (-not (Test-Path $backupPath)) {
    $props = Get-ItemProperty -Path $RegPath
    $hadServer = $null -ne $props.ProxyServer
    $hadOverride = $null -ne $props.ProxyOverride
    @{
      ProxyEnable = $(if ($null -ne $props.ProxyEnable) { [int]$props.ProxyEnable } else { 0 })
      ProxyServer = $(if ($hadServer) { [string]$props.ProxyServer } else { "" })
      ProxyOverride = $(if ($hadOverride) { [string]$props.ProxyOverride } else { "" })
      HadProxyServer = [bool]$hadServer
      HadProxyOverride = [bool]$hadOverride
    } | ConvertTo-Json | Set-Content -Path $backupPath -Encoding ASCII
  }
  $script:ProxyApplied = $true

  $prevOverride = [string](Get-ItemProperty -Path $RegPath).ProxyOverride
  $override = "localhost;127.0.0.1;<local>"
  if ($prevOverride -and $prevOverride -notmatch "localhost") {
    $override = "$prevOverride;$override"
  }
  Set-ItemProperty -Path $RegPath -Name ProxyEnable -Value 1
  Set-ItemProperty -Path $RegPath -Name ProxyServer -Value "127.0.0.1:8877"
  Set-ItemProperty -Path $RegPath -Name ProxyOverride -Value $override
  Refresh-WinInet

  # Keep the first saved value of each name (a crashed run must not save Silt's own values as "before").
  $envBackup = Join-Path $Data "env-backup.json"
  $saved = @{}
  if (Test-Path $envBackup) {
    (Get-Content $envBackup -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $saved[$_.Name] = $_.Value }
  }
  foreach ($name in $EnvNames) {
    if (-not $saved.ContainsKey($name)) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, "User") }
  }
  $saved | ConvertTo-Json | Set-Content -Path $envBackup -Encoding UTF8

  [Environment]::SetEnvironmentVariable("HTTP_PROXY", "http://127.0.0.1:8877", "User")
  [Environment]::SetEnvironmentVariable("HTTPS_PROXY", "http://127.0.0.1:8877", "User")
  [Environment]::SetEnvironmentVariable("NO_PROXY", "localhost,127.0.0.1,::1", "User")
  [Environment]::SetEnvironmentVariable("NODE_USE_ENV_PROXY", "1", "User")
  $bundle = Join-Path $Data "ca-bundle.pem"
  if (Test-Path $bundle) {
    foreach ($name in @("NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE")) {
      [Environment]::SetEnvironmentVariable($name, $bundle, "User")
    }
  }
  $script:ProxyApplied = $true
}

try { $Host.UI.RawUI.WindowTitle = "Silt recorder" } catch { }
Get-ChildItem -Path $Root -File | Unblock-File -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Silt records messages this PC sends to AI agents."
Write-Host "Keys are stripped. Other sites are passed through, not saved."
Write-Host ""

if (-not $Force) {
  $answer = Read-Host "Turn Silt on for this Windows user? [y/N]"
  if ($answer -notmatch "^[Yy]") {
    Write-Host "Left everything as it was."
    exit 0
  }
}

try {
  $node = Find-Node
  if (-not $node) {
    $install = Read-Host "Node.js is not installed. Install the LTS release with winget? [y/N]"
    if ($install -match "^[Yy]") {
      winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
      $node = Find-Node
    }
    if (-not $node) {
      throw "Install Node.js from https://nodejs.org and run Silt again."
    }
  }

  $env:SILT_DATA_DIR = $Data
  & $node (Join-Path $Root "silt-agent.mjs") --init
  if ($LASTEXITCODE -ne 0) { throw "Could not create the local certificate." }

  $cer = Join-Path $Data "silt-ca.cer"
  if (-not (Test-Path $cer)) { throw "Certificate file was not written." }
  Write-Host ""
  Write-Host "Approve the Windows prompt for Silt Local Recorder if it appears."
  Write-Host "Without that trust, agent calls cannot be read, so the proxy stays off."
  try {
    Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
  } catch {
    throw "Windows did not trust the certificate. Proxy was not changed. $($_.Exception.Message)"
  }
  # Older Silt certificates with the same name confuse apps that pick the wrong one.
  $current = (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $cer).Thumbprint
  $stale = Get-ChildItem Cert:\CurrentUser\Root | Where-Object {
    $current -and $_.Subject -like "*CN=Silt Local Recorder*" -and $_.Thumbprint -ne $current
  }
  if ($stale) {
    Write-Host "Approve removing $(@($stale).Count) old Silt certificate(s) if Windows asks."
    foreach ($c in $stale) {
      try { Remove-Item -Path "Cert:\CurrentUser\Root\$($c.Thumbprint)" -ErrorAction Stop } catch { Write-Host "Kept an old Silt certificate: $($_.Exception.Message)" }
    }
  }

  $agentJs = Join-Path $Root "silt-agent.mjs"
  $script:AgentProcess = Start-Process -FilePath $node -ArgumentList "`"$agentJs`"" -WorkingDirectory $Root -PassThru -NoNewWindow
  $ready = $false
  for ($i = 0; $i -lt 50; $i++) {
    if ($script:AgentProcess.HasExited) { break }
    try {
      $health = Invoke-WebRequest -Uri "http://127.0.0.1:8878/api/health" -UseBasicParsing -TimeoutSec 2
      if ($health.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 200
  }
  if (-not $ready) {
    throw "The recorder did not start. Nothing was changed in your proxy. See the messages above."
  }

  Enable-SiltProxy
  Write-Host ""
  Write-Host "Recording. Leave this window open."
  Write-Host "Now, not before: reload open AI tabs (Grok, ChatGPT...), quit and reopen AI apps from the tray"
  Write-Host "(Claude, ChatGPT, VS Code, Cursor...) and open new terminals. Anything started earlier skips Silt."
  Write-Host "Desk on this PC: http://127.0.0.1:8878"
  Write-Host "Tape file: $Data\captures.jsonl"
  Write-Host "Stop: close this window, or run Stop-Silt."
  Write-Host ""
  Wait-Process -Id $script:AgentProcess.Id
} catch {
  Write-Host ""
  Write-Host "Silt did not stay on."
  Write-Host $_.Exception.Message
  exit 1
} finally {
  $wasOn = [bool]$script:ProxyApplied
  if ($script:AgentProcess -and -not $script:AgentProcess.HasExited) {
    Stop-Process -Id $script:AgentProcess.Id -Force -ErrorAction SilentlyContinue
  }
  Restore-SiltProxy
  if ($wasOn) {
    Write-Host "Proxy restored."
  } else {
    Write-Host "Proxy was not changed."
  }
}
