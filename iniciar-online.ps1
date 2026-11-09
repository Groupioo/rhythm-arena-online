# Rhythm Arena Online - Arranca el servidor, abre un túnel gratuito de Cloudflare
# y publica la URL en GitHub para que la app la encuentre sola.
#
# Requisitos (una sola vez):
#   winget install Cloudflare.cloudflared
#   winget install Git.Git
#   Repositorio PÚBLICO en GitHub clonado en  .\url-repo  (ver instrucciones)
#
# Uso: doble clic en iniciar-online.bat  (déjalo abierto mientras se juega)

$ErrorActionPreference = 'Stop'
$Root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = Join-Path $Root 'url-repo'
$Log     = Join-Path $Root ('tunnel-' + (Get-Date -Format 'yyyyMMddHHmmss') + '.log')
$Port    = 3000

if (-not (Get-Command node -ErrorAction SilentlyContinue))        { throw 'Falta Node.js en el PATH.' }
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) { throw 'Falta cloudflared (winget install Cloudflare.cloudflared).' }
if (-not (Get-Command git -ErrorAction SilentlyContinue))         { throw 'Falta Git (winget install Git.Git).' }
if (-not (Test-Path (Join-Path $RepoDir '.git')))                 { throw "No existe el repo clonado en $RepoDir" }

# Configuración del servidor (detrás del túnel: IP real por X-Forwarded-For)
$env:NODE_ENV    = 'production'
$env:HOST        = '127.0.0.1'
$env:PORT        = "$Port"
$env:TRUST_PROXY = 'true'
$env:CORS_ORIGIN = '*'

# Limpieza de ejecuciones anteriores (si quedó un túnel o servidor abierto, bloquea el archivo de registro y el puerto)
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } |
    Where-Object { $_.ProcessName -eq 'node' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 1
Get-ChildItem -Path $Root -Filter 'tunnel*.log' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
$server = $null; $tunnel = $null
try {
    Write-Host '1/3 Arrancando servidor...'
    $server = Start-Process node -ArgumentList 'server.js' -WorkingDirectory $Root -PassThru -WindowStyle Minimized
    for ($i = 0; $i -lt 30; $i++) {
        try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { break } } catch { Start-Sleep 1 }
    }

    Write-Host '2/3 Abriendo túnel...'
    $tunnel = Start-Process cloudflared -ArgumentList 'tunnel','--url',"http://127.0.0.1:$Port",'--logfile',$Log -PassThru -WindowStyle Hidden
    $url = $null
    for ($i = 0; $i -lt 60 -and -not $url; $i++) {
        Start-Sleep 1
        if (Test-Path $Log) {
            $m = Select-String -Path $Log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($m) { $url = $m.Matches[0].Value }
        }
    }
    if (-not $url) { throw 'No se obtuvo la URL del túnel (mira el archivo tunnel-*.log).' }

    # Espera a que la URL pública responda
    for ($i = 0; $i -lt 30; $i++) {
        try { if ((Invoke-WebRequest "$url/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { break } } catch { Start-Sleep 2 }
    }

    Write-Host "3/3 Publicando URL: $url"
    Set-Location $RepoDir
    Set-Content -Path 'server-url.txt' -Value $url -NoNewline -Encoding ascii
    git add server-url.txt | Out-Null
    git commit -m "url $(Get-Date -Format s)" | Out-Null
    git push | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'git push falló: revisa que tengas sesión iniciada en GitHub.' }

    Write-Host ''
    Write-Host "LISTO. Servidor online en: $url"
    Write-Host '(GitHub puede tardar hasta ~5 min en servir la URL nueva.) No cierres esta ventana.'
    Wait-Process -Id $server.Id
}
finally {
    foreach ($p in @($tunnel, $server)) { if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
}
