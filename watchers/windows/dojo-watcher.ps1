# Starcraft Dojo watcher (Windows): sube replays nuevos de AutoSave a la plataforma.
# Compatible con Windows PowerShell 5.1 (usa curl.exe, incluido en Windows 10+).
# Config en $env:USERPROFILE\.starcraft-dojo\watcher.json  { "url": "...", "token": "..." }
$ErrorActionPreference = "Stop"

$configDir = Join-Path $env:USERPROFILE ".starcraft-dojo"
$configPath = Join-Path $configDir "watcher.json"
$statePath = Join-Path $configDir "uploaded.txt"
$replays = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "StarCraft\Maps\Replays"

if (-not (Test-Path $configPath)) { Write-Error "Falta $configPath"; exit 1 }
$config = Get-Content $configPath -Raw | ConvertFrom-Json
if (-not (Test-Path $statePath)) { New-Item -ItemType File -Path $statePath -Force | Out-Null }
$uploaded = @{}
Get-Content $statePath -ErrorAction SilentlyContinue | ForEach-Object { $uploaded[$_] = $true }

if (-not (Test-Path $replays)) { Write-Error "No existe $replays"; exit 1 }

Get-ChildItem -Path $replays -Filter *.rep -Recurse -File | ForEach-Object {
    $file = $_
    $hash = (Get-FileHash -Algorithm SHA256 -Path $file.FullName).Hash.ToLower().Substring(0, 16)
    if ($uploaded.ContainsKey($hash)) { return }
    # curl -F trata comas/; en el nombre como separadores: subir vía copia temporal sanitizada
    $safeName = ($file.Name -replace '[,;"]', '_')
    $tmp = Join-Path $env:TEMP $safeName
    Copy-Item $file.FullName $tmp -Force
    $status = & curl.exe -s -o NUL -w "%{http_code}" `
        -H "x-upload-token: $($config.token)" `
        -F "file=@$tmp" -F "source=autosave-win" `
        "$($config.url)/api/upload"
    Remove-Item $tmp -ErrorAction SilentlyContinue
    if ($status -eq "200") {
        Add-Content -Path $statePath -Value $hash
        Write-Host "subido: $($file.Name)"
    } else {
        Write-Warning "error ($status): $($file.Name)"
    }
}
