# FiscalOS - instalar, actualizar y ejecutar en Windows, sin Git.
# Uso:
#   .\fiscalos.ps1 actualizar     Baja la ultima version del codigo (ZIP) y la instala, sin tocar .env ni la sesion.
#   .\fiscalos.ps1 login          Inicia sesion en ARCA (ventana visible); la clave se tipea ahi, nunca aca.
#   .\fiscalos.ps1 correr         Recorre todos los servicios en modo lectura y genera el informe de cobertura.
#   .\fiscalos.ps1 correr -Desde 2026-09-01 -Hasta 2026-09-30
#   .\fiscalos.ps1 test           Corre las pruebas automatizadas.
param(
  [Parameter(Position=0)][ValidateSet('actualizar','login','correr','test','abrir-informe')]
  [string]$Accion = 'correr',
  [string]$Desde,
  [string]$Hasta,
  [switch]$Oculto
)
$ErrorActionPreference = 'Stop'
$Rama = 'claude/elegant-gauss-djpghk'
$Raiz = $PSScriptRoot
if (-not $Raiz) { $Raiz = (Get-Location).Path }

function Requiere-Node {
  try { node --version | Out-Null } catch {
    Write-Host 'Node.js no esta instalado. Instalalo con: winget install OpenJS.NodeJS.LTS  (y reabri PowerShell).' -ForegroundColor Red
    exit 1
  }
}

function Actualizar {
  Write-Host 'Descargando la ultima version...' -ForegroundColor Cyan
  $tmp = Join-Path $env:TEMP ('fiscalos-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'src.zip'
  $url = "https://github.com/nicotossutti-ctrl/millo/archive/refs/heads/$Rama.zip"
  Invoke-WebRequest -Uri $url -OutFile $zip
  Expand-Archive $zip -DestinationPath $tmp -Force
  $origen = Get-ChildItem -Path $tmp -Directory | Where-Object { $_.Name -like 'millo-*' } | Select-Object -First 1
  $origenArca = Join-Path $origen.FullName 'arca'
  # Copia el codigo, preservando .env, node_modules, la sesion, certificados y resultados.
  robocopy $origenArca $Raiz /E /XD node_modules .sesion out certs /XF .env | Out-Null
  Remove-Item $tmp -Recurse -Force
  Write-Host 'Instalando dependencias...' -ForegroundColor Cyan
  Push-Location $Raiz
  npm.cmd install
  npx.cmd playwright install chromium
  Pop-Location
  Write-Host 'Actualizado.' -ForegroundColor Green
}

function Login {
  Push-Location $Raiz
  npm.cmd run arca -- portal:login --visible
  Pop-Location
}

function Correr {
  Push-Location $Raiz
  $args = @('run','arca','--','portal:todo')
  if (-not $Oculto) { $args += '--visible' }
  if ($Desde) { $args += @('--desde', $Desde) }
  if ($Hasta) { $args += @('--hasta', $Hasta) }
  npm.cmd @args
  Pop-Location
  Abrir-Informe
}

function Abrir-Informe {
  $puntero = Join-Path $Raiz 'out\corridas\ultima.txt'
  if (Test-Path $puntero) {
    $dir = Get-Content $puntero -Raw
    $md = Join-Path $dir.Trim() 'cobertura.md'
    if (Test-Path $md) { Write-Host "`nInforme: $md" -ForegroundColor Green; notepad $md }
  }
}

function Test {
  Push-Location $Raiz
  npm.cmd test
  Pop-Location
}

Requiere-Node
switch ($Accion) {
  'actualizar'    { Actualizar }
  'login'         { Login }
  'correr'        { Correr }
  'test'          { Test }
  'abrir-informe' { Abrir-Informe }
}
