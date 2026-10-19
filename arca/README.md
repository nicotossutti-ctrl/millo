# ARCA · conciliación

Cliente propio de los web services oficiales de ARCA (ex AFIP). Sin intermediarios:
se autentica con un certificado digital nuestro (WSAA) y consulta Factura Electrónica (WSFEv1)
para reconstruir los comprobantes emitidos de un período, con reporte de integridad, y
exportarlos a CSV. Incluye el motor de Ganancias para la estimación mensual.

**Solo lectura.** El cliente tiene una lista cerrada de métodos de consulta; cualquier método de
emisión o modificación (`FECAESolicitar`, `FECAEA*`) es rechazado por código antes de salir a la red.

Carpeta autónoma (package.json, parámetros, cache y credenciales propios): está en este repo de
forma provisoria y se extrae a su propio repositorio sin cambios.

## Estado por componente

| Componente | Implementado | Probado con mocks | Probado en homologación | Validado en producción |
|---|---|---|---|---|
| WSAA: TRA, firma CMS con crypto de Node, ticket y cache | sí | sí (firma verificada con openssl) | parcial: formato aceptado, certificado de prueba rechazado por no ser de ARCA | no |
| WSFEv1: consultas, lista de solo lectura | sí | sí | `FEDummy` sí; el resto requiere certificado | no |
| Recorrido de emitidos y reporte de integridad | sí | sí (series simuladas con huecos, errores y desorden) | no | no |
| Validaciones de importes, IVA, moneda, fecha | sí | sí | no | no |
| Notas de crédito: signo y anulación | sí | sí | no | no |
| Reintentos controlados | sí | sí | no | no |
| Cache por entorno y CUIT | sí | sí | no | no |
| Ganancias: escala, deducciones, provisión | sí | sí (reproduce la DDJJ 2025 al centavo) | no aplica | calibrado contra DDJJ 2025 presentada |
| Estimación mensual (IIBB, autónomos, Ganancias) | sí | sí | no aplica | pendiente de parámetros del contador |
| Portal: login, sesión persistida, detección de CAPTCHA/2FA | sí | no | paso 1 del login verificado contra el formulario real; paso 2 parcialmente | no |
| Portal: diagnóstico de pantallas | sí | no | no | no |
| Portal: Mis Comprobantes emitidos y recibidos | sí, selectores provisorios | no | no | no |

"Validado en producción" significa contrastado contra Mis Comprobantes de ARCA para un mes.
Hasta que esa columna diga "sí", el CSV de emitidos no se usa para conciliar.

## 1. Instalar

```bash
cd arca
npm install
cp .env.example .env   # completar ARCA_CUIT, ARCA_ENV
```

Requiere Node 20.6 o superior. En Windows, si PowerShell bloquea `npm`, usá `npm.cmd` y `npx.cmd`.

Dependencias: `playwright` y `fast-xml-parser`, nada más. `npm audit` debe dar cero
vulnerabilidades; si alguna vez no, actualizar antes de usar la capa de portal. Cada vez que
cambia la versión de Playwright hay que volver a correr `npx playwright install chromium`.

## 2. Generar el certificado (una sola vez)

Hace falta clave fiscal **nivel 3**.

```bash
openssl genrsa -out certs/arca.key 2048
openssl req -new -key certs/arca.key -out certs/arca.csr \
  -subj "/C=AR/O=Nombre y Apellido/CN=conciliacion/serialNumber=CUIT 20XXXXXXXXX"
```

Reemplazar `20XXXXXXXXX` por el CUIT sin guiones. Después, en el portal de ARCA:

1. Buscar el servicio **Administración de Certificados Digitales** (si no aparece, habilitarlo
   desde Administrador de Relaciones). Agregar alias, por ejemplo `conciliacion`, y subir `certs/arca.csr`.
2. Descargar el certificado y guardarlo como `certs/arca.crt`.
3. En **Administrador de Relaciones**: Nueva relación → ARCA → WebServices →
   **Facturación Electrónica** (`wsfe`) → representante: el alias del paso 1.

Para probar primero contra homologación, el certificado se saca del servicio
**WSASS - Autogestión Certificados Homologación** y se usa `ARCA_ENV=homo`.

`certs/` y `.env` están en `.gitignore`. La clave privada no sale de tu máquina.

## 3. Usar

```bash
npm run arca -- dummy                                   # estado de los servidores, sin certificado
npm run arca -- login                                   # pide el ticket WSAA (se cachea 12 h en .ta/)
npm run arca -- ptos-venta
npm run arca -- tipos-cbte
npm run arca -- ultimo --pto 1 --tipo 11
npm run arca -- consultar --pto 1 --tipo 11 --nro 25
npm run arca -- emitidos --desde 2026-01-01 --hasta 2026-09-30
```

`emitidos` escribe dos archivos:

- `out/emitidos.csv` (separador `;`, coma decimal): fecha, tipo, número, CAE, receptor, importes
  originales, IVA por alícuota, **Total c/signo** y **Total ARS c/signo** (negativos en notas de
  crédito, convertidos a pesos si la moneda no es PES), comprobantes asociados, **Anulado por NC**
  cuando una nota de crédito cancela la factura por el total, y **Estado**: `OK`, `ANULADO` o
  `INCONSISTENTE` con el detalle en **Validaciones** (total ≠ suma de componentes, IVA ≠ detalle por
  alícuota, moneda sin cotización, fecha inválida).
- `out/integridad-<desde>-<hasta>.json`: el reporte de integridad. Por cada punto de venta y tipo:
  último autorizado, rango recorrido, números consultados, encontrados, inexistentes, errores,
  fuera de orden y cobertura. Arriba, `completo: true|false`. El comando termina con código 3 si
  la corrida no es completa, para que ningún paso posterior la tome por buena.

### Cómo garantiza que no falta nada

WSFE no lista por fecha: da el último número autorizado de cada serie (punto de venta + tipo) y
consulta de a uno. ARCA exige que la fecha de un comprobante sea mayor o igual a la del anterior
de la misma serie, así que la fecha es no decreciente con el número.

- **Modo rango** (default): búsqueda binaria del primer número con fecha ≥ `desde` y recorrido
  **consecutivo** de todos los números desde ahí hasta el último. Verifica el supuesto: el número
  anterior al primero debe ser más viejo que `desde`, y ninguna fecha puede retroceder. Cualquier
  contradicción marca `completo: false`.
- **Modo completo** (`--completo`): recorre cada serie desde el 1. Sin supuestos. Para la primera
  carga histórica y para verificar el modo rango.

Los puntos de venta bloqueados o dados de baja se recorren igual: tienen historia. Las consultas
con error no se cachean y quedan listadas en el reporte; se reintentan en la próxima corrida.

Lo que esto **no** cubre: comprobantes autorizados por WSMTXCA (con detalle de ítems), WSFEX
(exportación) o CAEA. Por eso la validación final es contra una exportación de Mis Comprobantes.

Por defecto recorre **todos** los tipos de comprobante vigentes que informa ARCA y todos los
puntos de venta habilitados, para no dejar afuera una Factura M o de crédito electrónico inesperada.
Para acotar: `--tipos 1,2,3,6,7,8` (A y B) o `--pto 2`.

Atención: el listado de puntos de venta del web service puede no incluir los que usan
Comprobantes en Línea ni los que Mercado Libre u otro sistema crearon para facturar en tu nombre.
Si tenés alguno así, pasalo con `--pto`. La cobertura se valida comparando contra una
exportación manual de Mis Comprobantes del mismo mes.
Con `--json` imprime los comprobantes completos, con detalle de IVA y tributos.

Cada comprobante consultado se guarda en `out/cache/<entorno>/<cuit>/`, así una segunda corrida
no vuelve a consultar a ARCA. Las entradas de otra versión o de otro CUIT se ignoran.

## FiscalOS: una corrida que recorre todo (orquestador)

`portal:todo` recorre en una sola corrida todos los servicios fiscales declarados en
`src/portal/servicios.js`, **en modo lectura**. Un servicio que falla no detiene a los demás.
Los servicios con selectores confirmados (Mis Comprobantes recibidos y emitidos) descargan y
validan; los demás se relevan y el informe dice qué les falta para escribir su extractor.

```bash
npm run arca -- portal:todo --desde 2026-09-01 --hasta 2026-09-30 --visible
```

Cada corrida se guarda en `out/corridas/<fecha>/`:
- una carpeta por servicio (estructura, HTML saneado, resumen, archivos descargados o error),
- `cobertura.json` y `cobertura.md`: estado por servicio (validado, descargado, con-datos,
  relevado, sin-acceso, desafío, error), filas, exportación detectada y si está listo para
  extractor.

Los resultados quedan en disco: una segunda corrida no repite lo ya probado salvo que la pidas.

### Windows: un solo script, sin Git

`fiscalos.ps1` instala, actualiza, inicia sesión y ejecuta, sin necesitar Git:

```powershell
.\fiscalos.ps1 actualizar     # baja la última versión y reinstala, sin tocar .env ni la sesión
.\fiscalos.ps1 login          # inicia sesión en ARCA (ventana visible; la clave se tipea ahí)
.\fiscalos.ps1 correr         # recorre todos los servicios y abre el informe de cobertura
.\fiscalos.ps1 correr -Desde 2026-09-01 -Hasta 2026-09-30
.\fiscalos.ps1 test           # corre las pruebas
```

## Portal: descarga automática con sesión autenticada

Para todo lo que no tiene web service (comprobantes recibidos, DDJJ, retenciones, cuenta
tributaria, Convenio, autónomos) la app entra al portal como una persona, con un navegador
controlado por Playwright, y usa las exportaciones de cada servicio. Ver `COBERTURA.md` para el
detalle fuente por fuente.

```bash
npx playwright install chromium                      # una vez, baja el navegador
npm run arca -- portal:login --visible               # primera vez: tipeás la clave en la ventana
npm run arca -- portal:diagnostico --visible         # releva las pantallas de los 10 servicios
npm run arca -- portal:mis-comprobantes --tipo recibidos --desde 2026-01-01 --hasta 2026-09-30
```

Reglas de la capa de portal:

- **La clave fiscal no se guarda.** Se tipea en la ventana (modo `--visible`) o se pasa por la
  variable `ARCA_CLAVE` cargada desde el llavero del sistema. Las cookies de sesión sí se
  guardan, en `.sesion/` con permisos 0600, y se reutilizan hasta que ARCA las vence.
- **Nada se elude.** Si ARCA muestra CAPTCHA, segundo factor o cualquier verificación, el
  proceso se detiene con un error claro; en modo visible espera a que la resuelvas vos.
- **Nada se da por completo sin verificar.** Cada extractor devuelve `verificado: false` hasta
  que sus selectores se confirmaron con el diagnóstico y el primer archivo se validó a mano.

`portal:diagnostico` guarda en `out/diagnostico/<servicio>/` captura, HTML, inventario de
formularios y tráfico de red de cada servicio. Es lo que se usa para escribir los selectores
exactos de cada extractor sin adivinar, y lo que hay que volver a correr cuando ARCA rediseña
una pantalla.

Lo que guarda el diagnóstico sale de pantallas autenticadas, así que se protege:

- carpetas 0700 y archivos 0600 en Linux y macOS. En Windows esos permisos no existen: la
  protección es la ACL de tu carpeta de usuario, así que no instales el proyecto en una carpeta
  compartida. `out/` y `.sesion/` están en `.gitignore` y un test lo verifica en cada corrida,
  con git si está instalado y leyendo el `.gitignore` si no;
- el HTML se sanea: sin scripts, sin valores de inputs ni tokens de formulario, CUIT e importes
  enmascarados; la estructura nunca incluye el valor de un input;
- del tráfico de red se guarda solo método, host y ruta: sin query string, sin cookies ni
  encabezados;
- las capturas muestran lo que muestra la pantalla; `--sin-capturas` las omite;
- `portal:limpiar` borra diagnóstico, descargas y la sesión guardada.

Si me vas a pasar la carpeta de diagnóstico, pasala sin las capturas o revisándolas antes.

## Estimación mensual: cuánto gano de verdad

El contador liquida; esto solo provisiona. Para cada mes:

```
Ventas netas − Gastos netos          = Resultado bruto
− Ingresos Brutos (Convenio)         ventas × Σ(coeficiente × alícuota)
− Autónomos                          cuota mensual
− Provisión de Ganancias             ver abajo
= Ganancia real del mes
```

Ganancias es anual y progresivo, así que la provisión se recalcula cada mes: se proyecta el
año a ritmo actual (o con `--proyeccion`), se liquida el impuesto anual con la escala y las
deducciones personales oficiales de ese año, y la provisión acumulada es la parte proporcional
de ese impuesto. La del mes es la diferencia con el mes anterior.

```bash
cp params/contribuyente.example.json params/contribuyente.json   # completar con datos del contador
npm run arca -- ganancias --anio 2026 --neto 60000000           # liquidación anual para un neto dado
npm run arca -- estimar --anio 2026 --meses out/meses.csv        # tabla mensual (Mes;Ventas netas;Gastos netos)
```

`params/ganancias.json` tiene la escala del art. 94 y las deducciones del art. 30 de 2025 y 2026,
copiadas de las tablas de liquidación anual de ARCA:

- [Escala 2025](https://www.afip.gob.ar/gananciasYBienes/ganancias/personas-humanas-sucesiones-indivisas/declaracion-jurada/documentos/Tabla-Art-94-LIG-liquidacion-anual-y-final-2025.pdf) ·
  [Deducciones 2025](https://www.afip.gob.ar/gananciasYBienes/ganancias/personas-humanas-sucesiones-indivisas/deducciones/documentos/Deducciones-personales-art-30-liq-anual-2025.pdf)
- [Escala 2026](https://www.afip.gob.ar/gananciasYBienes/ganancias/personas-humanas-sucesiones-indivisas/declaracion-jurada/documentos/Tabla-Art-94-LIG-liquidacion-anual-y-final-2026.pdf) ·
  [Deducciones 2026](https://www.afip.gob.ar/gananciasYBienes/ganancias/personas-humanas-sucesiones-indivisas/deducciones/documentos/Deducciones-personales-art-30-liq-anual-2026.pdf)

`npm test` verifica que el motor reproduzca al centavo la DDJJ 2025 presentada (F.2711):
deducciones personales, ganancia neta sujeta a impuesto, impuesto determinado y saldo.

## Tests

```bash
npm test          # 32 tests, sin red ni credenciales reales
npm run test:cov  # con informe de cobertura
```

Los tests simulan ARCA: respuestas SOAP enlatadas para WSAA y WSFE, un WSFE en memoria con
series que tienen huecos, errores y fechas fuera de orden, y un certificado autofirmado
descartable que se genera en el momento para probar la firma CMS. No usan certificados reales.

## Cómo funciona

- `src/wsaa.js` arma el Ticket de Requerimiento de Acceso, lo firma en CMS (PKCS#7) y lo manda
  a `loginCms`. La firma la hace `src/cms.js` con el módulo `crypto` de Node, sin dependencias
  (o `openssl cms` si `ARCA_SIGNER=openssl`); los tests la verifican con openssl cuando está
  instalado.
- `src/wsfe.js` envuelve los métodos de consulta de WSFEv1: `FEDummy`, `FEParamGetPtosVenta`,
  `FEParamGetTiposCbte`, `FECompUltimoAutorizado`, `FECompConsultar`.
- `src/emitidos.js`: recorrido por serie, validaciones, notas de crédito y reporte de integridad.
- `src/ganancias.js` y `src/estimacion.js`: motor de Ganancias y estimación mensual.

## Próximos pasos

- Constatación de comprobantes recibidos (WSCDCV1) y constancia de inscripción de contrapartes.
- Parsers de las exportaciones del portal: Mis Comprobantes recibidos (gastos), Mis Retenciones
  (pagos a cuenta) y deducciones de SIFERE, para alimentar `estimar` sin cargar nada a mano.
- Anticipos de Ganancias 2026 en el flujo de caja.
- Cruce contra extracto bancario y Mercado Pago.
