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
- `cobertura.json` y `cobertura.md`, con el informe en **cuatro categorías**: *Descargado y
  validado*, *Descargado sin validar*, *Solo relevado* y *Sin acceso o bloqueo*.

**Mis Comprobantes** descarga un ZIP, lo descomprime (lector propio con `zlib`, sin
dependencias) y valida cada CSV contra cuatro controles: cantidad de filas, fechas dentro del
rango, duplicados por comprobante y **coincidencia con el total informado por ARCA** en la
tabla paginada (los 20 descargados tienen que ser los 20 que ARCA dice). Solo si los cuatro
pasan se da por verificado. Si ARCA no informa el total, el período queda como *descargado sin
validar* con el motivo "cantidad no verificada", nunca como cotejo completo.

Los archivos y el registro viven en una carpeta **persistente y compartida entre corridas**,
`out/datos/<servicio>/manifiesto.json`, con el hash de cada archivo. Un período ya verificado
no se vuelve a descargar salvo `--rehacer`, y el informe lo marca como reutilizado. Así el
histórico no se vuelve a bajar en cada ejecución.

**Validación** (`calidad.js`). Llegar a una pantalla no cuenta como éxito. Cada extracción queda en
uno de tres niveles:
- *obtenido*: se leyeron filas, pero algún control falló o no se pudo hacer. Es evidencia: se guarda
  como intento y nunca se usa como dato.
- *validado*: los **encabezados reales** tienen todas las columnas obligatorias de la sección (y no
  son los de una grilla rechazada, como Vencimientos de la home), la paginación terminó de forma
  **natural** (sin "siguiente"; una página repetida, una grilla que desaparece o el tope de seguridad
  no alcanzan), ningún total la contradice y, si la consulta filtra por período, el rango quedó
  confirmado en pantalla y **todas** las filas tienen fecha interpretable dentro del rango, según la
  columna de fecha que declara la sección. Un cero solo vale con la grilla propia presente y vacía.
- *apto para cálculos*: validado y con la cantidad cotejada contra el total que ARCA informa en el
  paginador (o un cero validado).

**Conservación** (`conservacion.js`). Cada intento se guarda aparte en
`out/datos/<fuente>/intentos/<corrida>/` (archivos + `intento.json` con su nivel y su error) y en
`intentos.jsonl`. A `out/datos/<fuente>/vigente/` (registro en `vigente.json`) solo llega lo
**validado o apto**, y antes se comprueba que los archivos existan, se puedan leer y sumen las filas.
Una grilla ajena o un intento sin validar nunca se promueve, ni siquiera como primer resultado, y un
intento nunca reemplaza a un vigente de mejor nivel. Si un intento de igual nivel trae **menos
filas**, solo reemplaza cuando el total que informa ARCA confirma la cantidad nueva; si no, el
vigente se conserva y el intento queda *pendiente de revisión* (se ve en la cobertura histórica).
La sustitución es segura: copia a una carpeta temporal, la verifica, mueve el vigente anterior a
`respaldos/<clave>/<corrida>/` (quedan los últimos 3) y recién entonces coloca la copia nueva. Si
algo falla, el anterior queda intacto o se restaura; un corte a mitad se repara en la corrida siguiente.

**Cobertura histórica.** `out/datos/cobertura-historica.md` (copia en cada corrida) muestra, con
lo conservado de todas las corridas, qué meses son aptos para cálculos, cuáles están validados,
cuáles solo tienen evidencia sin validar (no tapa huecos), cuáles faltan y qué fuentes son acumuladas (una foto de lo que ARCA lista ese día: no prueba el
histórico completo). Con `FISCALOS_HISTORICO_DESDE=aaaa-mm` en `.env` los faltantes se cuentan
desde esa fecha; si no, desde el primer mes validado.

**Informe de IVA** (`informe:iva --periodo AAAA-MM`, o `fiscalos.ps1 informe-iva -Periodo AAAA-MM`). No
abre ARCA: usa solo lo conservado. Muestra el IVA de los comprobantes emitidos (débito) y recibidos
(IVA facturado por proveedores, que no es crédito computable), lo **declarado** (detalle de la DJ que
la fuente `portal-iva-ddjj` lee de Portal IVA con "Ver declaración jurada"; también guarda el acuse),
lo **pagado** (pagos de Cuentas Tributarias imputados a IVA del período), las retenciones de IVA,
la presentación, el vencimiento y la deuda registrada. El saldo pendiente solo se calcula con cifras
existentes; "conciliado" solo si el saldo declarado coincide con los pagos. Lo que falta se lista con
cómo obtenerlo. El IVA de un mes se paga al mes siguiente: los pagos se consultan con esas fechas.

**Importe declarado de la DJ.** Es el saldo a pagar ("Saldo de impuesto a favor de ARCA"). Se toma
solo si aparece con su nombre y un único valor (pantalla y datos JSON tienen que coincidir); nunca se
deduce del saldo técnico ni se calcula. `dj:iva --periodo AAAA-MM` (o `fiscalos.ps1 reprocesar-dj
-Periodo AAAA-MM`) vuelve a interpretar la última captura ya bajada, sin abrir ARCA: deja el análisis
en `analisis-ddjj-iva-AAAA-MM.txt` (local) y, si queda validada, la conserva.

Los errores guardados y mostrados se sanean: nunca exponen CUIT, importes, cookies ni tokens.

### FiscalOS V1: la aplicación

`fiscalos.ps1 app` (o `npm run arca -- app`) abre FiscalOS en el navegador, en `http://127.0.0.1:4321`.
Solo escucha en esta computadora y no abre ARCA: muestra lo conservado en `out/datos` y lo importado
en `out/importados`. `fiscalos.ps1 acceso-directo` crea un ícono "FiscalOS" en el escritorio.

- **Impuestos del mes** (por defecto, el mes anterior): IVA, Ingresos Brutos, Ganancias y autónomos
  con declarado, estimado, pagos, saldo pendiente, vencimiento de presentación y de pago. Cada cifra
  dice si está *verificada* (ARCA), *importada* (archivo tuyo), *estimada* (con sus supuestos) o
  *faltante* (y cómo obtenerla). El vencimiento de pago del IVA es el que registra Cuentas
  Tributarias para el régimen del contribuyente (p. ej. IVA diferido a 90 días); no se aplica el
  calendario general.
  En la misma pestaña: los *pagos de impuestos con fecha en el mes* (de cualquier período, separando los propios de
  las retenciones depositadas como agente, con los que cargues a mano), *lo que el mes deja para pagar más adelante*
  (p. ej. el IVA diferido) y la *conciliación con PFOS*. Un impuesto declarado sin pago encontrado dice «pago no
  encontrado (sin cobertura)»: falta evidencia, no prueba que esté impago; un pago parcial no lo da por pagado.
- **FiscalOS es solo impositivo.** Ventas, costos, comisiones, publicidad, logística y rentabilidad los calcula PFOS.
  Para proyectar Ganancias, FiscalOS usa el *resultado comercial* de cada mes ya calculado por PFOS (antes de impuestos;
  hoy se carga a mano o por archivo, concepto «Resultado comercial del mes»), le resta IIBB y autónomos y aplica la
  escala; sin ese resultado de algún mes del año, la provisión dice «no estimable». Las cargas e importaciones
  comerciales viejas se conservan, pero no se crean nuevas.
- **Obligaciones**: vencimientos y deudas registrados en Cuentas Tributarias.
- **Importar archivo**: CSV o Excel (.xlsx). Vista previa, elección de columnas y concepto, simulación
  (totales por mes, filas descartadas y **duplicadas**) y confirmación. Un archivo idéntico no se
  importa dos veces y las filas ya importadas se omiten. Cada importación se puede deshacer.
- **CM03 en PDF** (Ingresos Brutos, Convenio Multilateral): el «Reporte» que baja SIFERE WEB – Consultas (DDJJ
  Mensuales > Listado > ícono de impresora) se sube desde el cartel o desde «Importar». Tiene texto: se lee con
  `pdfjs-dist`, sin OCR. Se guardan, por período y versión (original o rectificativa), las seis columnas de
  «Jurisdicciones incluidas» de cada jurisdicción, el **impuesto determinado** (la carga del mes, no lo que se paga), el
  **total a pagar** (después de saldos a favor, retenciones y percepciones) y los **saldos a favor**, cada uno por
  jurisdicción y sin compensar unos con otros; las páginas «Determinación del anticipo» quedan como evidencia, sin
  sumarse. Las filas tienen que cerrar con TOTALES y con el «Total a pagar», y el período con el mes; si algo no se
  entiende, la CM03 queda **en revisión** y no se usa (nunca se completa con 0). El mismo PDF no se importa dos veces,
  una rectificativa posterior no se reemplaza por una anterior y otra copia de la misma versión con otros importes se
  rechaza. El saldo de IIBB es el total a pagar menos los pagos comprobados del período; con varias jurisdicciones a
  pagar y un pago que no cubre el total, queda «sin conciliar». Presentar la CM03 no es pagarla. Todo queda en
  `out/importados/cm03/` (el PDF original incluido), fuera del repositorio.
- **DJ anual de Ganancias en PDF** (F.2711 simplificada o F.711, como la descarga ARCA): su texto viene en fuentes Type3
  «dibujadas» (cada letra es un dibujo y su código es el orden en que apareció), así que la extracción común devuelve
  basura. `src/app/glifos.js` reconoce cada letra por su dibujo contra un diccionario de formas
  (`src/app/glifos-arca.json`, solo formas de letras): primero por dibujo exacto y, si no, por parecido con umbral
  estricto; lo dudoso queda «?» y la DJ en revisión. Se guardan el impuesto determinado, los pagos a cuenta, el saldo a
  favor de ARCA o del contribuyente, el año, la secuencia y la fecha; la DJ es válida solo si determinado − pagos a
  cuenta = saldo, al centavo. El saldo es el que declaró la DJ, no la deuda de hoy: se concilia con los pagos de Cuentas
  Tributarias imputados a ese año desde la presentación, y sin ellos queda «sin conciliar». En `out/importados/ganancias/`.
- **Recolección automática (solo lectura), lo nuevo de la corrida:**
  - *SIFERE*: además de los listados, baja el «Reporte» (PDF) de cada CM03 presentada de los meses de la corrida y los
    seis anteriores, y lo lee como si lo hubieras subido. Solo hace clic en un control que se identifique sin dudas
    como reporte o impresión de la DJ; nunca en «Pago», «Crear DJ a partir de copia», VEP ni nada de presentar. Si no
    lo identifica, no hace clic y guarda cómo es cada control (en `resultado.json` de la corrida).
  - *Presentación de DDJJ y Pagos*: entra por las rutas de lectura «Consulta de DDJJ presentadas» y «Consulta de VEP»
    (nunca «Presentación» ni «Gestión de VEP») y releva sus grillas, con muestra enmascarada de las filas.
  - *CCMA (autónomos)*: lee las tablas que muestra la cuenta corriente reconociendo la fila de encabezados por sus
    palabras (las tablas no tienen encabezados HTML). No completa campos ni toca «Calcular deuda» ni «Pagar». Las filas
    del período se muestran como evidencia, sin sacar importes hasta confirmar las columnas reales.
  - Para una corrida acotada a lo que falta: `.\fiscalos.ps1 correr -Desde 2026-09-01 -Hasta 2026-09-30 -Servicios "sifere-consultas,ccma,ddjj-y-pagos,ddjj-y-pagos-veps"`
    (las fuentes van separadas por coma o espacio).
- **Pruebas con datos reales, solo privadas**: las pruebas del repositorio usan cifras inventadas.
  `test/ganancias-privada.test.js` compara el cálculo de Ganancias con las DJ que importaste en la app (leídas de
  `out/importados/ganancias/`, que Git ignora), al centavo; sin ninguna DJ importada, se saltea.
- **Pagos**: cada pago cargado a mano lleva el *período* al que corresponde y su *fecha de pago*: el período descuenta
  esa obligación y la fecha lo ubica en la caja del mes en que salió (el CM03 de septiembre pagado en octubre sale de la
  caja de octubre). Un pago cargado que coincide con uno de ARCA o de SIFERE no se suma dos veces; uno sin fecha que puede
  ser el mismo queda sin sumar hasta aclararlo. Un volante de SIFERE generado no es un pago.
- **Como empleador y agente de retención** (aparte de los impuestos propios): F.931 (seguridad social) y F.744 / SICORE
  (retenciones y percepciones practicadas a terceros), con su DJ presentada, importe declarado, pagos del período, estado
  y vencimiento. Presentar la DJ no es pagarla.
- **DJ presentadas**: el estado de presentación sale de lo ya bajado: las DJ de Cuentas Tributarias (todas las
  nacionales del período: IVA, retenciones como agente, cargas sociales, y la DJ anual de Ganancias) y la lista de CM03
  de SIFERE (con su rectificativa). Esas listas no traen el impuesto determinado de IIBB ni de Ganancias: se pide en el
  cartel, ya diciendo cuál DJ presentada hay que mirar.
- **Pendientes de carga** (cartel arriba de todo): lo que ARCA no entrega sola, por mes cerrado (la CM03 de SIFERE, mejor
  su PDF, y el pago de su total a pagar; la cuota de autónomos sin pagos en ARCA) y una vez por año (impuesto determinado
  de la DJ de Ganancias). Se sube el PDF o se carga el importe ahí mismo, o el archivo en «Importar»; el pedido
  desaparece cuando está cargado. Con la CM03 importada sale el pedido de la CM03, pero no el del pago; si SIFERE
  muestra una rectificativa posterior, se pide su reporte.
- **Simulador**: crédito fiscal y desembolso de una compra real con factura (versión inicial).
- Estimaciones de IIBB, Ganancias y autónomos: requieren `params/contribuyente.json`.
- **PFOS** (Mercado Libre, solo la cuenta del CUIT del contribuyente): `fiscalos.ps1 pfos -Periodo "2026-09,2026-10"`
  lee de PFOS **solo lo fiscal**, en **solo lectura**, y guarda una foto por mes en `out/pfos/`: la cuenta verificada por
  CAE contra tus comprobantes emitidos de ARCA, las ventas de Mercado Libre con IVA como control contra la facturación y
  las retenciones de Mercado Pago (anticipos). El mes en curso se mide al corte (hasta ayer); sin sus comprobantes
  emitidos, la cuenta se apoya en otro mes verificado y la conciliación fiscal del mes queda «pendiente».
  Instalación y seguridad (`docs/pfos-conexion.md`): comprobación previa de solo lectura (`docs/pfos-comprobacion.sql`),
  clave criptográfica con `fiscalos.ps1 pfos-clave` (queda solo en `.env`; el SQL lleva el verificador SCRAM) y acceso
  (`docs/pfos-acceso.sql`). La cuenta es obligatoria (`FISCALOS_PFOS_CUENTA`).

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
