$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $env:LOCALAPPDATA "CodexUI"
$stdoutLog = Join-Path $logDir "codexui-tray.log"
$stderrLog = Join-Path $logDir "codexui-tray.err.log"
$frpStdoutLog = Join-Path $logDir "codexui-frp.log"
$frpStderrLog = Join-Path $logDir "codexui-frp.err.log"
$publicProxyStdoutLog = Join-Path $logDir "codexui-public-proxy.log"
$publicProxyStderrLog = Join-Path $logDir "codexui-public-proxy.err.log"
$pidFile = Join-Path $logDir "codexui-tray.pid"
$frpPidFile = Join-Path $logDir "codexui-frp.pid"
$publicProxyPidFile = Join-Path $logDir "codexui-public-proxy.pid"
$errorLog = Join-Path $logDir "codexui-tray-host.err.log"
$configFile = Join-Path $logDir "tray-config.json"
$mutexName = "Local\CodexUITrayLauncher"
$script:mutex = New-Object System.Threading.Mutex($false, $mutexName)
$script:notifyIcon = $null
$script:config = $null

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Get-DefaultConfig {
  return [ordered]@{
    port = 5174
    host = "0.0.0.0"
    frpEnabled = $true
    frpExe = "C:\Users\youdo\Documents\Codex\2026-05-06\new-chat-2\frp\frp_0.68.1_windows_amd64\frpc.exe"
    frpConfig = "C:\Users\youdo\Documents\Codex\2026-05-06\new-chat-2\frpc-hk-5173.toml"
    publicUrl = "http://162.211.183.146:18080/"
    publicProxyPort = 5189
    publicPassword = ""
  }
}

function Save-Config($config) {
  $port = [int]$config.port
  $bindHost = if ($config.host) { [string]$config.host } else { "0.0.0.0" }
  $frpEnabled = if ($null -ne $config.frpEnabled) { [bool]$config.frpEnabled } else { $true }
  $frpExe = if ($config.frpExe) { [string]$config.frpExe } else { "" }
  $frpConfig = if ($config.frpConfig) { [string]$config.frpConfig } else { "" }
  $publicUrl = if ($config.publicUrl) { [string]$config.publicUrl } else { "" }
  $publicProxyPort = if ($config.publicProxyPort) { [int]$config.publicProxyPort } else { 5189 }
  $publicPassword = if ($config.publicPassword) { [string]$config.publicPassword } else { "" }
  [ordered]@{
    port = $port
    host = $bindHost
    frpEnabled = $frpEnabled
    frpExe = $frpExe
    frpConfig = $frpConfig
    publicUrl = $publicUrl
    publicProxyPort = $publicProxyPort
    publicPassword = $publicPassword
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configFile -Encoding UTF8
  Write-HostErrorLog "Saved config: port=$port host=$bindHost frpEnabled=$frpEnabled publicPasswordSet=$([bool]$publicPassword)"
}

function Read-Config {
  $defaultConfig = Get-DefaultConfig
  if (-not (Test-Path $configFile)) {
    Save-Config $defaultConfig
    return [pscustomobject]$defaultConfig
  }

  try {
    $loaded = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    $port = [int]($loaded.port)
    if ($port -lt 1 -or $port -gt 65535) {
      throw "Port must be between 1 and 65535."
    }
    $bindHost = if ($loaded.host) { [string]$loaded.host } else { "0.0.0.0" }
    $frpEnabled = if ($null -ne $loaded.frpEnabled) { [bool]$loaded.frpEnabled } else { $true }
    $frpExe = if ($loaded.frpExe) { [string]$loaded.frpExe } else { [string]$defaultConfig.frpExe }
    $frpConfig = if ($loaded.frpConfig) { [string]$loaded.frpConfig } else { [string]$defaultConfig.frpConfig }
    $publicUrl = if ($loaded.publicUrl) { [string]$loaded.publicUrl } else { [string]$defaultConfig.publicUrl }
    $publicProxyPort = if ($loaded.publicProxyPort) { [int]$loaded.publicProxyPort } else { [int]$defaultConfig.publicProxyPort }
    if ($publicProxyPort -lt 1 -or $publicProxyPort -gt 65535) {
      throw "Public proxy port must be between 1 and 65535."
    }
    $publicPassword = if ($loaded.publicPassword) { [string]$loaded.publicPassword } else { "" }
    $needsNormalize = $null -eq $loaded.frpEnabled -or -not $loaded.frpExe -or -not $loaded.frpConfig -or -not $loaded.publicUrl -or -not $loaded.publicProxyPort -or $null -eq $loaded.publicPassword
    $normalizedConfig = [pscustomobject]@{
      port = $port
      host = $bindHost
      frpEnabled = $frpEnabled
      frpExe = $frpExe
      frpConfig = $frpConfig
      publicUrl = $publicUrl
      publicProxyPort = $publicProxyPort
      publicPassword = $publicPassword
    }
    if ($needsNormalize) {
      Save-Config $normalizedConfig
    }
    return $normalizedConfig
  } catch {
    Write-HostErrorLog "Invalid config, resetting to defaults. $($_ | Out-String)"
    Save-Config $defaultConfig
    return [pscustomobject]$defaultConfig
  }
}

function Reload-Config {
  $script:config = Read-Config
}

function Write-HostErrorLog($message) {
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $errorLog -Value "[$stamp] $message"
}

trap {
  Write-HostErrorLog ($_ | Out-String)
  if ($script:notifyIcon) {
    $script:notifyIcon.Visible = $false
    $script:notifyIcon.Dispose()
  }
  throw
}

function Show-Message($title, $text, $icon = [System.Windows.Forms.ToolTipIcon]::Info) {
  if (-not $script:notifyIcon) {
    return
  }
  $script:notifyIcon.BalloonTipTitle = $title
  $script:notifyIcon.BalloonTipText = $text
  $script:notifyIcon.BalloonTipIcon = $icon
  $script:notifyIcon.ShowBalloonTip(2500)
}

function Get-TrackedProcess {
  if (-not (Test-Path $pidFile)) {
    return $null
  }

  $rawPid = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if (-not $rawPid) {
    return $null
  }

  try {
    return Get-Process -Id ([int]$rawPid) -ErrorAction Stop
  } catch {
    return $null
  }
}

function Get-TrackedFrpProcess {
  if (-not (Test-Path $frpPidFile)) {
    return $null
  }

  $rawPid = (Get-Content -LiteralPath $frpPidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if (-not $rawPid) {
    return $null
  }

  try {
    return Get-Process -Id ([int]$rawPid) -ErrorAction Stop
  } catch {
    return $null
  }
}

function Get-TrackedPublicProxyProcess {
  if (-not (Test-Path $publicProxyPidFile)) {
    return $null
  }

  $rawPid = (Get-Content -LiteralPath $publicProxyPidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if (-not $rawPid) {
    return $null
  }

  try {
    return Get-Process -Id ([int]$rawPid) -ErrorAction Stop
  } catch {
    return $null
  }
}

function Test-CodexUIRunning {
  return $null -ne (Get-TrackedProcess)
}

function Test-FrpRunning {
  return $null -ne (Get-TrackedFrpProcess)
}

function Test-PublicProxyRunning {
  return $null -ne (Get-TrackedPublicProxyProcess)
}

function Get-ConfiguredUrl {
  return "http://localhost:$($script:config.port)/"
}

function Get-LocalUrl {
  if (Test-Path $stdoutLog) {
    $content = Get-Content $stdoutLog -Raw -ErrorAction SilentlyContinue
    $matches = [regex]::Matches($content, "http://localhost:\d+/")
    if ($matches.Count -gt 0) {
      return $matches[$matches.Count - 1].Value
    }
  }
  return Get-ConfiguredUrl
}

function Update-Tooltip {
  if (Test-CodexUIRunning) {
    $frpState = if (Test-FrpRunning) { "FRP on" } else { "FRP off" }
    $script:notifyIcon.Text = "CodexUI :$($script:config.port), $frpState"
  } else {
    $script:notifyIcon.Text = "CodexUI stopped (:$($script:config.port))"
  }
}

function Sync-FrpConfigPort {
  if (-not $script:config.frpConfig -or -not (Test-Path $script:config.frpConfig)) {
    Write-HostErrorLog "FRP config not found: $($script:config.frpConfig)"
    return $false
  }

  $content = Get-Content -LiteralPath $script:config.frpConfig -Raw
  $frpLocalPort = [int]$script:config.publicProxyPort
  if ($content -match '(?m)^localPort\s*=') {
    $content = [regex]::Replace($content, '(?m)^localPort\s*=\s*\d+\s*$', "localPort = $frpLocalPort", 1)
  } else {
    $content = $content.TrimEnd() + "`r`nlocalPort = $frpLocalPort`r`n"
  }
  [System.IO.File]::WriteAllText($script:config.frpConfig, $content, [System.Text.UTF8Encoding]::new($false))
  Write-HostErrorLog "Synced FRP localPort=$frpLocalPort"
  return $true
}

function Start-CodexUI {
  if (Test-CodexUIRunning) {
    Update-Tooltip
    Show-Message "CodexUI" "CodexUI is already running."
    return
  }

  Remove-Item -LiteralPath $stdoutLog, $stderrLog -ErrorAction SilentlyContinue
  Reload-Config

  $cmd = "cd /d `"$projectDir`" && pnpm exec vite --host $($script:config.host) --port $($script:config.port)"
  $process = Start-Process -FilePath "cmd.exe" `
    -ArgumentList @("/d", "/s", "/c", $cmd) `
    -WorkingDirectory $projectDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

  Set-Content -LiteralPath $pidFile -Value $process.Id
  Update-Tooltip
  Show-Message "CodexUI" "Started in the background."
}

function Start-PublicProxy {
  Reload-Config
  if (Test-PublicProxyRunning) {
    return
  }

  Remove-Item -LiteralPath $publicProxyStdoutLog, $publicProxyStderrLog -ErrorAction SilentlyContinue
  $previousProxyPort = $env:CODEXUI_PUBLIC_PROXY_PORT
  $previousTargetPort = $env:CODEXUI_TARGET_PORT
  $previousPassword = $env:CODEXUI_PUBLIC_PASSWORD
  $previousSecret = $env:CODEXUI_PUBLIC_SESSION_SECRET
  $env:CODEXUI_PUBLIC_PROXY_PORT = [string]$script:config.publicProxyPort
  $env:CODEXUI_TARGET_PORT = [string]$script:config.port
  $env:CODEXUI_PUBLIC_PASSWORD = [string]$script:config.publicPassword
  if ([string]::IsNullOrWhiteSpace($previousSecret)) {
    $env:CODEXUI_PUBLIC_SESSION_SECRET = [guid]::NewGuid().ToString("N")
  }

  $process = Start-Process -FilePath "node.exe" `
    -ArgumentList @((Join-Path $projectDir "scripts\public-auth-proxy.cjs")) `
    -WorkingDirectory $projectDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $publicProxyStdoutLog `
    -RedirectStandardError $publicProxyStderrLog `
    -PassThru

  if ($null -eq $previousProxyPort) { Remove-Item Env:\CODEXUI_PUBLIC_PROXY_PORT -ErrorAction SilentlyContinue } else { $env:CODEXUI_PUBLIC_PROXY_PORT = $previousProxyPort }
  if ($null -eq $previousTargetPort) { Remove-Item Env:\CODEXUI_TARGET_PORT -ErrorAction SilentlyContinue } else { $env:CODEXUI_TARGET_PORT = $previousTargetPort }
  if ($null -eq $previousPassword) { Remove-Item Env:\CODEXUI_PUBLIC_PASSWORD -ErrorAction SilentlyContinue } else { $env:CODEXUI_PUBLIC_PASSWORD = $previousPassword }
  if ($null -eq $previousSecret) { Remove-Item Env:\CODEXUI_PUBLIC_SESSION_SECRET -ErrorAction SilentlyContinue } else { $env:CODEXUI_PUBLIC_SESSION_SECRET = $previousSecret }

  Set-Content -LiteralPath $publicProxyPidFile -Value $process.Id
}

function Start-Frp {
  Reload-Config
  if (-not $script:config.frpEnabled) {
    Remove-Item -LiteralPath $frpPidFile -ErrorAction SilentlyContinue
    Update-Tooltip
    return
  }
  if (Test-FrpRunning) {
    Update-Tooltip
    return
  }
  if (-not $script:config.frpExe -or -not (Test-Path $script:config.frpExe)) {
    Show-Message "CodexUI FRP" "frpc.exe not found. Open config to fix the path." ([System.Windows.Forms.ToolTipIcon]::Error)
    Write-HostErrorLog "frpc.exe not found: $($script:config.frpExe)"
    return
  }
  if (-not (Sync-FrpConfigPort)) {
    Show-Message "CodexUI FRP" "FRP config not found. Open config to fix the path." ([System.Windows.Forms.ToolTipIcon]::Error)
    return
  }

  Remove-Item -LiteralPath $frpStdoutLog, $frpStderrLog -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath $script:config.frpExe `
    -ArgumentList @("-c", $script:config.frpConfig) `
    -WorkingDirectory (Split-Path -Parent $script:config.frpExe) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $frpStdoutLog `
    -RedirectStandardError $frpStderrLog `
    -PassThru

  Set-Content -LiteralPath $frpPidFile -Value $process.Id
  Update-Tooltip
}

function Stop-CodexUI {
  $process = Get-TrackedProcess
  if ($process) {
    Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", "$($process.Id)", "/T", "/F") -WindowStyle Hidden -Wait
  }

  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -like "*$projectDir*" -and
      ($_.CommandLine -like "*pnpm exec vite*" -or $_.CommandLine -like "*node_modules*vite*bin*vite.js*")
    } |
    ForEach-Object {
      Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", "$($_.ProcessId)", "/T", "/F") -WindowStyle Hidden -Wait
    }

  Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
  Update-Tooltip
}

function Stop-PublicProxy {
  $process = Get-TrackedPublicProxyProcess
  if ($process) {
    Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", "$($process.Id)", "/T", "/F") -WindowStyle Hidden -Wait
  }
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -like "*public-auth-proxy.cjs*" -and
      $_.CommandLine -like "*$projectDir*"
    } |
    ForEach-Object {
      Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", "$($_.ProcessId)", "/T", "/F") -WindowStyle Hidden -Wait
    }
  Remove-Item -LiteralPath $publicProxyPidFile -ErrorAction SilentlyContinue
}

function Stop-Frp {
  $process = Get-TrackedFrpProcess
  if ($process) {
    Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", "$($process.Id)", "/T", "/F") -WindowStyle Hidden -Wait
  }

  if ($script:config.frpExe) {
    $frpExePath = [string]$script:config.frpExe
    Get-CimInstance Win32_Process |
      Where-Object { $_.CommandLine -like "*$frpExePath*" -or $_.CommandLine -like "*$($script:config.frpConfig)*" } |
      ForEach-Object {
        Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", "$($_.ProcessId)", "/T", "/F") -WindowStyle Hidden -Wait
      }
  }

  Remove-Item -LiteralPath $frpPidFile -ErrorAction SilentlyContinue
  Update-Tooltip
}

function Restart-CodexUI {
  Stop-CodexUI
  Stop-PublicProxy
  Start-Sleep -Milliseconds 500
  Start-CodexUI
  Start-PublicProxy
  Restart-Frp
}

function Restart-PublicProxy {
  Stop-PublicProxy
  Start-Sleep -Milliseconds 500
  Start-PublicProxy
  Restart-Frp
}

function Restart-Frp {
  Stop-Frp
  Start-Sleep -Milliseconds 500
  Start-Frp
}

function Open-CodexUI {
  Start-Process (Get-LocalUrl)
}

function Open-PublicUrl {
  Reload-Config
  if ([string]::IsNullOrWhiteSpace($script:config.publicUrl)) {
    Show-Message "CodexUI FRP" "Public URL is not configured. Open config to set it." ([System.Windows.Forms.ToolTipIcon]::Warning)
    return
  }
  Start-Process ([string]$script:config.publicUrl)
}

function Open-Logs {
  Start-Process "explorer.exe" $logDir
}

function Open-Config {
  if (-not (Test-Path $configFile)) {
    Save-Config (Get-DefaultConfig)
  }
  Start-Process "notepad.exe" $configFile
}

function Set-Port {
  Reload-Config
  $currentPort = [string]$script:config.port
  $inputPort = [Microsoft.VisualBasic.Interaction]::InputBox(
    "Enter the CodexUI port to use on next start.",
    "CodexUI Port",
    $currentPort
  )
  if ([string]::IsNullOrWhiteSpace($inputPort)) {
    return
  }

  $parsedPort = 0
  if (-not [int]::TryParse($inputPort.Trim(), [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) {
    Show-Message "CodexUI" "Invalid port. Use a number from 1 to 65535." ([System.Windows.Forms.ToolTipIcon]::Error)
    return
  }

  Save-Config ([ordered]@{
    port = $parsedPort
    host = $script:config.host
    frpEnabled = $script:config.frpEnabled
    frpExe = $script:config.frpExe
    frpConfig = $script:config.frpConfig
    publicUrl = $script:config.publicUrl
    publicProxyPort = $script:config.publicProxyPort
    publicPassword = $script:config.publicPassword
  })
  Reload-Config
  if ([int]$script:config.port -ne $parsedPort) {
    Show-Message "CodexUI" "Port save failed. Open logs for details." ([System.Windows.Forms.ToolTipIcon]::Error)
    Write-HostErrorLog "Port save verification failed. expected=$parsedPort actual=$($script:config.port)"
    return
  }

  Restart-CodexUI
  Show-Message "CodexUI" "Port changed to $parsedPort and service restarted."
}

function Set-PublicPassword {
  Reload-Config
  $inputPassword = [Microsoft.VisualBasic.Interaction]::InputBox(
    "Enter the password required for public FRP access. Leave empty to disable public password protection.",
    "CodexUI Public Password",
    [string]$script:config.publicPassword
  )
  if ($null -eq $inputPassword) {
    return
  }

  $nextPassword = $inputPassword.Trim()
  Save-Config ([ordered]@{
    port = $script:config.port
    host = $script:config.host
    frpEnabled = $script:config.frpEnabled
    frpExe = $script:config.frpExe
    frpConfig = $script:config.frpConfig
    publicUrl = $script:config.publicUrl
    publicPassword = $nextPassword
  })
  Reload-Config
  Restart-CodexUI
  Show-Message "CodexUI" "Public password updated. Localhost remains password-free."
}

function Toggle-Frp {
  Reload-Config
  $nextEnabled = -not [bool]$script:config.frpEnabled
  Save-Config ([ordered]@{
    port = $script:config.port
    host = $script:config.host
    frpEnabled = $nextEnabled
    frpExe = $script:config.frpExe
    frpConfig = $script:config.frpConfig
    publicUrl = $script:config.publicUrl
    publicProxyPort = $script:config.publicProxyPort
    publicPassword = $script:config.publicPassword
  })
  Reload-Config
  if ($script:config.frpEnabled) {
    Start-Frp
    Show-Message "CodexUI FRP" "FRP tunnel enabled."
  } else {
    Stop-Frp
    Show-Message "CodexUI FRP" "FRP tunnel disabled."
  }
}

if (-not $script:mutex.WaitOne(0, $false)) {
  Reload-Config
  Start-Process (Get-ConfiguredUrl)
  exit 0
}

Reload-Config
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$form.ShowInTaskbar = $false
$form.Visible = $false

$script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$script:notifyIcon.Text = "CodexUI starting"
$script:notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Open CodexUI")
$openPublicItem = $menu.Items.Add("Open public URL")
$setPortItem = $menu.Items.Add("Set port...")
$setPasswordItem = $menu.Items.Add("Set public password...")
$configItem = $menu.Items.Add("Open config")
$restartItem = $menu.Items.Add("Restart service")
$restartPublicProxyItem = $menu.Items.Add("Restart public proxy")
$restartFrpItem = $menu.Items.Add("Restart FRP tunnel")
$toggleFrpItem = $menu.Items.Add("Toggle FRP tunnel")
$logsItem = $menu.Items.Add("Open logs")
$menu.Items.Add("-") | Out-Null
$exitItem = $menu.Items.Add("Exit")

$openItem.add_Click({ Open-CodexUI })
$openPublicItem.add_Click({ Open-PublicUrl })
$setPortItem.add_Click({ Set-Port })
$setPasswordItem.add_Click({ Set-PublicPassword })
$configItem.add_Click({ Open-Config })
$restartItem.add_Click({ Restart-CodexUI })
$restartPublicProxyItem.add_Click({ Restart-PublicProxy })
$restartFrpItem.add_Click({ Restart-Frp })
$toggleFrpItem.add_Click({ Toggle-Frp })
$logsItem.add_Click({ Open-Logs })
$exitItem.add_Click({
  Stop-Frp
  Stop-PublicProxy
  Stop-CodexUI
  $script:notifyIcon.Visible = $false
  $script:notifyIcon.Dispose()
  $form.Close()
})

$script:notifyIcon.ContextMenuStrip = $menu
$script:notifyIcon.add_DoubleClick({ Open-CodexUI })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({ Update-Tooltip })
$timer.Start()

Start-CodexUI
Start-PublicProxy
Start-Frp
[System.Windows.Forms.Application]::Run($form)

$timer.Stop()
$script:mutex.ReleaseMutex()
$script:mutex.Dispose()
