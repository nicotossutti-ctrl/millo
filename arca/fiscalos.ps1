# FiscalOS - instalar, actualizar y ejecutar en Windows, sin Git.
# Uso:
#   .\fiscalos.ps1 actualizar     Baja la ultima version del codigo (ZIP) y la instala, sin tocar .env ni la sesion.
#   .\fiscalos.ps1 login          Inicia sesion en ARCA (ventana visible); la clave se tipea ahi, nunca aca.
#   .\fiscalos.ps1 correr         Recorre todos los servicios en modo lectura y genera el informe de cobertura.
#   .\fiscalos.ps1 correr -Desde 2026-09-01 -Hasta 2026-09-30
#   .\fiscalos.ps1 correr -Rehacer    Vuelve a descargar periodos ya verificados.
#   .\fiscalos.ps1 test           Corre las pruebas automatizadas.
param(
  [Parameter(Position=0)][ValidateSet('actualizar','login','correr','test','abrir-informe')]
  [string]$Accion = 'correr',
  [string]$Desde,
  [string]$Hasta,
  [switch]$Rehacer,
  [switch]$Oculto
)
$ErrorActionPreference = 'Stop'
$Rama = 'claude/elegant-gauss-djpghk'
$Raiz = $PSScriptRoot
if (-not $Raiz) { $Raiz = (Get-Location).Path }

function Fallar($msg) { Write-Host "FiscalOS: $msg" -ForegroundColor Red; exit 1 }

function Requiere-Node {
  try { node --version | Out-Null } catch {
    Fallar 'Node.js no esta instalado. Instalalo con: winget install OpenJS.NodeJS.LTS  (y reabri PowerShell).'
  }
}

# Ejecuta un comando externo y falla si su codigo de salida no es cero.
function Correr-Paso($desc, $exe, $argumentos) {
  Write-Host ">> $desc" -ForegroundColor Cyan
  & $exe @argumentos
  if ($LASTEXITCODE -ne 0) { Fallar "$desc fallo (codigo $LASTEXITCODE). No se completo la operacion." }
}

function Actualizar {
  $tmp = Join-Path $env:TEMP ('fiscalos-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'src.zip'
    $url = "https://github.com/nicotossutti-ctrl/millo/archive/refs/heads/$Rama.zip"
    Write-Host '>> Descargando la ultima version...' -ForegroundColor Cyan
    try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing } catch { Fallar "no se pudo descargar el codigo: $($_.Exception.Message)" }
    if (-not (Test-Path $zip) -or (Get-Item $zip).Length -lt 1000) { Fallar 'la descarga quedo vacia o incompleta.' }

    Write-Host '>> Descomprimiendo...' -ForegroundColor Cyan
    try { Expand-Archive $zip -DestinationPath $tmp -Force } catch { Fallar "no se pudo descomprimir el ZIP: $($_.Exception.Message)" }
    $origen = Get-ChildItem -Path $tmp -Directory | Where-Object { $_.Name -like 'millo-*' } | Select-Object -First 1
    if (-not $origen) { Fallar 'el ZIP no tiene la estructura esperada (falta la carpeta millo-*).' }
    $origenArca = Join-Path $origen.FullName 'arca'
    if (-not (Test-Path (Join-Path $origenArca 'package.json'))) { Fallar 'el ZIP no contiene arca\package.json.' }

    # Copia el codigo preservando .env, node_modules, la sesion, certificados y resultados.
    Write-Host '>> Copiando archivos...' -ForegroundColor Cyan
    robocopy $origenArca $Raiz /E /XD node_modules .sesion out certs /XF .env | Out-Null
    # robocopy: codigos 0-7 son exito; 8 o mas es error.
    if ($LASTEXITCODE -ge 8) { Fallar "la copia de archivos fallo (robocopy codigo $LASTEXITCODE)." }

    Push-Location $Raiz
    try {
      Correr-Paso 'Instalando dependencias (npm ci)' 'npm.cmd' @('ci')
      Correr-Paso 'Instalando Chromium para Playwright' 'npx.cmd' @('playwright','install','chromium')
    } finally { Pop-Location }
    Write-Host 'Actualizado correctamente.' -ForegroundColor Green
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Login {
  Push-Location $Raiz
  try { Correr-Paso 'Iniciando sesion en ARCA' 'npm.cmd' @('run','arca','--','portal:login','--visible') }
  finally { Pop-Location }
}

function Correr {
  Push-Location $Raiz
  try {
    $a = @('run','arca','--','portal:todo')
    if (-not $Oculto) { $a += '--visible' }
    if ($Rehacer) { $a += '--rehacer' }
    if ($Desde) { $a += @('--desde', $Desde) }
    if ($Hasta) { $a += @('--hasta', $Hasta) }
    Correr-Paso 'Recorriendo servicios fiscales' 'npm.cmd' $a
  } finally { Pop-Location }
  Abrir-Informe
}

function Abrir-Informe {
  $puntero = Join-Path $Raiz 'out\corridas\ultima.txt'
  if (Test-Path $puntero) {
    $dir = (Get-Content $puntero -Raw).Trim()
    # ultima.txt guarda una ruta relativa a la carpeta de arca; se resuelve desde ahí y no desde
    # la carpeta donde se llamó al script (si no, decía que no había cobertura.md aunque existiera).
    if (-not [System.IO.Path]::IsPathRooted($dir)) { $dir = Join-Path $Raiz $dir }
    $md = Join-Path $dir 'cobertura.md'
    if (Test-Path $md) { Write-Host "`nInforme: $md" -ForegroundColor Green; notepad $md }
    $hist = Join-Path $dir 'cobertura-historica.md'
    if (Test-Path $hist) { Write-Host "Cobertura historica: $hist" -ForegroundColor Green }
    else { Write-Host 'La corrida no genero cobertura.md.' -ForegroundColor Yellow }
  } else { Write-Host 'Todavia no hay corridas.' -ForegroundColor Yellow }
}

function Test {
  Push-Location $Raiz
  try { Correr-Paso 'Pruebas automatizadas' 'npm.cmd' @('test') }
  finally { Pop-Location }
}

Requiere-Node
switch ($Accion) {
  'actualizar'    { Actualizar }
  'login'         { Login }
  'correr'        { Correr }
  'test'          { Test }
  'abrir-informe' { Abrir-Informe }
}
