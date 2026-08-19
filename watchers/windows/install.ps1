# Instala el watcher de Starcraft Dojo en Windows (tarea programada cada 5 min).
# Uso (PowerShell): .\install.ps1 -Url https://dojo.tudominio.com -Token TU_UPLOAD_TOKEN
param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Token
)
$ErrorActionPreference = "Stop"

$configDir = Join-Path $env:USERPROFILE ".starcraft-dojo"
New-Item -ItemType Directory -Path $configDir -Force | Out-Null

Copy-Item (Join-Path $PSScriptRoot "dojo-watcher.ps1") (Join-Path $configDir "dojo-watcher.ps1") -Force
@{ url = $Url; token = $Token } | ConvertTo-Json | Set-Content (Join-Path $configDir "watcher.json")

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$configDir\dojo-watcher.ps1`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "StarcraftDojoWatcher" -Action $action -Trigger $trigger -Force | Out-Null

Write-Host "Watcher instalado. Corre cada 5 minutos."
Write-Host "Prueba manual: powershell -File `"$configDir\dojo-watcher.ps1`""
