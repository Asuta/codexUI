$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $env:LOCALAPPDATA "CodexUI"
$stdoutLog = Join-Path $logDir "codexui-tray.log"
$stderrLog = Join-Path $logDir "codexui-tray.err.log"
$pidFile = Join-Path $logDir "codexui-tray.pid"
$errorLog = Join-Path $logDir "codexui-tray-host.err.log"
$mutexName = "Local\CodexUITrayLauncher"
$script:mutex = New-Object System.Threading.Mutex($false, $mutexName)
$script:notifyIcon = $null

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

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

function Test-CodexUIRunning {
  return $null -ne (Get-TrackedProcess)
}

function Get-LocalUrl {
  if (Test-Path $stdoutLog) {
    $content = Get-Content $stdoutLog -Raw -ErrorAction SilentlyContinue
    $matches = [regex]::Matches($content, "http://localhost:\d+/")
    if ($matches.Count -gt 0) {
      return $matches[$matches.Count - 1].Value
    }
  }
  return "http://localhost:5174/"
}

function Update-Tooltip {
  if (Test-CodexUIRunning) {
    $script:notifyIcon.Text = "CodexUI running"
  } else {
    $script:notifyIcon.Text = "CodexUI stopped"
  }
}

function Start-CodexUI {
  if (Test-CodexUIRunning) {
    Update-Tooltip
    Show-Message "CodexUI" "CodexUI is already running."
    return
  }

  Remove-Item -LiteralPath $stdoutLog, $stderrLog -ErrorAction SilentlyContinue

  $cmd = "cd /d `"$projectDir`" && pnpm run dev -- --host 0.0.0.0 --port 5174"
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

function Stop-CodexUI {
  $process = Get-TrackedProcess
  if ($process) {
    Start-Process -FilePath "taskkill.exe" -ArgumentList @("/PID", "$($process.Id)", "/T", "/F") -WindowStyle Hidden -Wait
  }
  Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
  Update-Tooltip
}

function Restart-CodexUI {
  Stop-CodexUI
  Start-Sleep -Milliseconds 500
  Start-CodexUI
}

function Open-CodexUI {
  Start-Process (Get-LocalUrl)
}

function Open-Logs {
  Start-Process "explorer.exe" $logDir
}

if (-not $script:mutex.WaitOne(0, $false)) {
  Start-Process "http://localhost:5174/"
  exit 0
}

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
$restartItem = $menu.Items.Add("Restart service")
$logsItem = $menu.Items.Add("Open logs")
$menu.Items.Add("-") | Out-Null
$exitItem = $menu.Items.Add("Exit")

$openItem.add_Click({ Open-CodexUI })
$restartItem.add_Click({ Restart-CodexUI })
$logsItem.add_Click({ Open-Logs })
$exitItem.add_Click({
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
[System.Windows.Forms.Application]::Run($form)

$timer.Stop()
$script:mutex.ReleaseMutex()
$script:mutex.Dispose()
