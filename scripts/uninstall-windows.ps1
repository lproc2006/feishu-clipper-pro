$ErrorActionPreference = "Stop"

$TaskName = "FeishuClipperPro"
$AppDir = Join-Path $env:LOCALAPPDATA "FeishuClipperPro"

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item $AppDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "飞书剪存pro 本机服务和本地关联数据已删除。"
Write-Host "已保存在飞书中的内容和 lark-cli 不受影响。"
