$ErrorActionPreference = "Stop"

$RootDir = Split-Path $PSScriptRoot -Parent
$AppDir = Join-Path $env:LOCALAPPDATA "FeishuClipperPro"
$ServerDir = Join-Path $AppDir "server"
$TaskName = "FeishuClipperPro"

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
$Npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
if (-not $Node -or -not $Npm) {
  throw "需要 Node.js 18 或更高版本：https://nodejs.org/"
}

$NodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -lt 18) {
  throw "当前 Node.js 版本过低，需要 18 或更高版本。"
}

Write-Host "正在安装飞书官方 lark-cli..."
& npx.cmd "@larksuite/cli@latest" install

New-Item -ItemType Directory -Force -Path $ServerDir | Out-Null
Copy-Item (Join-Path $RootDir "server\server.js") $ServerDir -Force
Copy-Item (Join-Path $RootDir "server\package.json") $ServerDir -Force

$ServerScript = Join-Path $ServerDir "server.js"
$Action = New-ScheduledTaskAction -Execute $Node -Argument ('"' + $ServerScript + '"') -WorkingDirectory $ServerDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Feishu Clipper Pro companion service" -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "正在配置飞书应用。浏览器可能会打开授权页面。"
& lark-cli config init
& lark-cli auth login --recommend

Write-Host "安装完成。服务状态：http://127.0.0.1:8787/health"
