# Informe de cobertura de fuentes · FiscalOS

Contribuyente: persona humana, responsable inscripto en IVA, Ganancias y autónomos, Ingresos Brutos
por Convenio Multilateral. Clave fiscal nivel 3. Objetivo: que la aplicación obtenga sola toda la
información fiscal del CUIT, sin descargas manuales.

Fecha del relevamiento: 18/10/2026. Fuentes: catálogo oficial de web services de ARCA
(https://www.afip.gob.ar/ws/documentacion/catalogo.asp), manuales de cada servicio, normativa
citada en cada fila y pruebas propias contra el entorno de homologación y la pantalla de login.

## Cómo leer el estado

| Estado | Significa |
|---|---|
| **A · validado** | Recupera datos reales del CUIT, verificado contra el registro oficial. |
| **B · probado** | Corre contra ARCA (homologación o producción) pero sin contraste con datos reales. |
| **C · implementado** | Código escrito y probado con simulaciones; falta correrlo contra ARCA. |
| **D · relevado** | Mecanismo identificado y documentado; sin código. |
| **E · sin mecanismo** | No existe forma de obtenerlo sin intervención humana o no existe la fuente. |

## Mecanismos de acceso disponibles

Hay exactamente tres, y conviene tenerlos claros porque definen todo lo demás:

1. **Web services SOAP con certificado digital (WSAA).** Oficiales, documentados, estables. Se
   autoriza cada servicio al certificado desde Administrador de Relaciones. Solo existen para
   facturación, padrón y algunos regímenes específicos. **No existe ningún web service para
   consultar DDJJ, pagos, retenciones sufridas, cuenta tributaria ni comprobantes recibidos.**
2. **Portal con clave fiscal, sesión de navegador.** Es lo que hace una persona. Se automatiza con
   un navegador controlado por código (Playwright) que inicia sesión con CUIT y clave, abre el
   servicio y usa las exportaciones que el propio servicio ofrece. Es el único mecanismo para el
   80 % de las fuentes. Verificado el 18/10/2026 contra el formulario real: el primer paso
   (CUIT) no tiene CAPTCHA; en el segundo paso (clave) apareció en una de dos pruebas un
   elemento de tipo CAPTCHA, así que hay que asumir que ARCA puede pedirlo. La automatización lo
   detecta, se detiene y lo muestra en una ventana para que lo resuelvas; no lo elude.
3. **COMARB (SIFERE Web).** Portal distinto, de la Comisión Arbitral, pero se entra con la misma
   clave fiscal de ARCA a través del portal de ARCA. Mismo mecanismo 2.

Terceros como Afip SDK no tienen un cuarto mecanismo: usan el 2 con tu clave en sus servidores.

## Cobertura por fuente

| # | Fuente | Qué contiene | Mecanismo | Automatizable | Frecuencia útil | Limitaciones | Estado |
|---|---|---|---|---|---|---|---|
| 1 | **Facturas emitidas** | Todo comprobante autorizado con CAE: tipo, número, fecha, receptor, importes, IVA por alícuota, asociados | **WSFEv1** (web service, certificado) | Sí, sin intervención | Diaria | Solo lo autorizado por WSFEv1 y Comprobantes en Línea; no cubre WSMTXCA, WSFEX ni CAEA. No lista por fecha: se reconstruye por número con reporte de integridad | **C** (código + 32 tests; `FEDummy` probado en homologación; falta certificado real) |
| 1b | Facturas emitidas (control) | Lo mismo, visto desde Mis Comprobantes | Portal · Mis Comprobantes · exportación CSV/Excel, hasta 365 días por consulta | Sí, con sesión | Mensual | Pantalla, puede cambiar | **C** (extractor escrito, selectores a confirmar con diagnóstico) |
| 2 | **Facturas recibidas** | Compras con CAE emitidas a tu CUIT: crédito fiscal, percepciones | Portal · Mis Comprobantes · Recibidos | Sí, con sesión | Mensual | Sin web service. No incluye facturas de proveedores que no te las emitieron a tu CUIT | **A · validado** (descarga real: ZIP+CSV, 20 registros = 20 informados por ARCA, 19/10/2026) |
| 3 | **DDJJ mensuales de IVA** | F.2051 (IVA Simple, desde 11/2025) y F.2002 anteriores: débito, crédito, saldo técnico y de libre disponibilidad | Portal · Portal IVA (F.2051) y Presentación de DDJJ y Pagos · Consulta de presentaciones (acuses y formularios) | Sí, con sesión | Mensual | Sin web service. El Portal IVA es nuevo (RG 5705/2025) y su exportación hay que relevarla en diagnóstico | **D** |
| 4 | **Libro IVA Digital** | Registro de ventas y compras hasta 05/2025 | Portal · Libro IVA Digital · exportación | Sí, con sesión | Histórico, ya no se alimenta si presentás F.2051 | Solo períodos anteriores a la migración | **D** |
| 5 | **Convenio Multilateral CM03 (mensual)** | Base imponible, coeficiente, impuesto por jurisdicción, pagos | Portal → COMARB · SIFERE WEB · Consultas (DDJJ presentadas, pagos) | Sí, con sesión | Mensual | Sistema de otro organismo, pantallas propias; sin API para contribuyentes | **D** |
| 6 | **Convenio Multilateral CM05 (anual)** | Coeficientes unificados por jurisdicción | SIFERE WEB · Consultas | Sí, con sesión | Anual | Ídem | **D** |
| 7 | **Retenciones y percepciones de IIBB, SIRCREB** | Lo que bancos y agentes te retuvieron por Ingresos Brutos | SIFERE WEB · Consultas · deducciones | Sí, con sesión | Mensual | Ídem | **D** |
| 8 | **DDJJ anual de Ganancias** | F.2711/F.711: rentas, deducciones, impuesto, pagos a cuenta, saldo | Portal · Presentación de DDJJ y Pagos · Consulta (acuse y PDF) y Ganancias Personas Humanas (borrador y presentada) | Sí, con sesión | Anual | Sin web service. El PDF del F.2711 viene con fuente codificada: se lee por OCR o desde la pantalla, no por texto | **D** (la DDJJ 2025 ya se cargó a mano para calibrar) |
| 9 | **Bienes Personales** | F.762/A: patrimonio al 31/12 e impuesto | Mismo camino que 8 | Sí, con sesión | Anual | Solo si estás inscripto; se detecta en Cuentas Tributarias | **D** |
| 10 | **Pagos y anticipos** | VEP pagados, anticipos de Ganancias y Bienes, cuotas de planes | Portal · Sistema de Cuentas Tributarias (pagos imputados y sin imputar) y Presentación de DDJJ y Pagos · Consulta de VEP | Sí, con sesión | Mensual | Sin web service | **D** |
| 11 | **Retenciones y percepciones nacionales** | IVA y Ganancias retenidos por tus clientes y agentes | Portal · Mis Retenciones (versión nueva 11/2025) · exportación | Sí, con sesión | Mensual | Sin web service; pantalla rediseñada hace poco | **D** |
| 12 | **Saldos a favor, deudas, compensaciones** | Estado de cuenta por impuesto y período, intereses, DDJJ faltantes, vencimientos | Portal · Sistema de Cuentas Tributarias | Sí, con sesión | Semanal | Sin web service | **D** |
| 13 | **Autónomos** | Cuenta corriente: categoría, cuotas, pagos, deuda | Portal · CCMA (Cuenta Corriente de Monotributistas y Autónomos) | Sí, con sesión | Mensual | Sin web service | **D** |
| 14 | **Otras obligaciones** | Todo impuesto y régimen en que estés inscripto, con vencimientos | Web service `ws_sr_padron_a4` o constancia de inscripción (certificado); detalle en Cuentas Tributarias | Sí, sin intervención | Mensual | El padrón dice en qué estás inscripto; la cuenta tributaria dice qué debés | **D** |
| 15 | **Planes de pago** | Mis Facilidades: planes vigentes, cuotas | Portal · Mis Facilidades | Sí, con sesión | Mensual | Sin web service | **D** |
| 16 | **Notificaciones** | Domicilio Fiscal Electrónico: intimaciones, avisos | Web service `WSCCOMU` (Ventanilla Electrónica, certificado) o portal | Sí, sin intervención | Diaria | Hay que autorizar el servicio al certificado | **D** |
| 17 | **Constatación de comprobantes recibidos** | Validez de cada factura de proveedor | Web service `WSCDCV1` (certificado) | Sí, sin intervención | Al recibir | Verifica, no lista | **D** |
| 18 | **Condición fiscal de contrapartes** | Constancia de inscripción de clientes y proveedores | Web service `ws_sr_constancia_inscripcion` (certificado) | Sí, sin intervención | Al facturar | Requiere autorización del servicio | **D** |

## Intervención humana que no se puede eliminar

- **Login.** La clave fiscal no se guarda en disco. Se toma de una variable de entorno cargada
  desde el llavero del sistema, o se tipea a mano en modo visible. Las cookies de sesión se
  guardan y reutilizan; cuando ARCA las vence, hay que volver a loguear. Con la clave en el
  llavero, el relogin es automático.
- **Verificaciones.** Si ARCA agrega CAPTCHA o segundo factor, la automatización se detiene y lo
  muestra en un navegador visible para que lo resuelvas. No se elude.
- **Certificado digital.** Se genera una vez, con clave fiscal nivel 3, y dura dos años.
- **Cambios de pantalla.** Cada rediseño de un servicio del portal rompe su extractor hasta que
  se actualiza. Por eso cada extractor valida lo que descargó y nunca da por completo lo que no
  pudo verificar.

## Qué está hecho y qué sigue

**Hecho**

- WSAA + WSFEv1 con reporte de integridad, solo lectura por código, 32 tests (fuente 1).
- Motor de Ganancias calibrado contra la DDJJ 2025 (para la fila 8, estimaciones).
- Capa de sesión del portal: login en dos pasos con los selectores reales del formulario de
  ARCA. Ante CAPTCHA o segundo factor, en modo oculto falla y en modo visible espera a que la
  persona lo resuelva; si la sesión queda iniciada, termina ahí y no vuelve a tocar el
  formulario. Las cookies se guardan recién después de confirmar que el portal carga con sesión.
  Apertura de servicios por el buscador del portal.
- Modo diagnóstico: entra a cada servicio y guarda captura, HTML saneado (sin scripts, valores,
  tokens, CUIT ni importes), inventario de formularios y rutas de red sin parámetros, todo con
  permisos 0600 y fuera de git, para escribir los selectores exactos sin adivinar.
- Extractor de Mis Comprobantes emitidos y recibidos (fuentes 1b y 2). Recibidos de 09/2026
  descargado y validado (62/62) y con reutilización por manifiesto.
- Extractor de tabla de solo lectura (Mis Retenciones, Cuentas Tributarias dentro de iframe,
  Mis Facilidades): completa filtros confirmados, elige la grilla por encabezados esperados,
  recorre la paginación y diferencia estados (validado / extraído / parcial / sin-datos). Para
  0 filas distingue el **cero confirmado** (grilla presente y vacía) de la **ausencia incierta**
  (no se encontró la grilla): nunca muestra un cero como certeza sin confirmarlo.
- Navegación de hubs en solo lectura (`navegar.js`): Portal IVA, Presentación de DDJJ y Pagos,
  SIFERE, Ganancias y Bienes Personales son pantallas con botones INGRESAR/CONSULTAR. El drill
  los atraviesa haciendo clic solo en controles de lectura (consultar/ingresar/ver/continuar…,
  nunca trámite ni pago) hasta llegar a una grilla o sus filtros; si llega, extrae ahí mismo, y
  si no, guarda la estructura saneada para escribir el extractor exacto. Así una sola corrida
  integral avanza todas las fuentes sin pedir pruebas pantalla por pantalla.

**Estado real por fuente (acceso ≠ descarga ≠ validación), al 20/10/2026**

- **Descargado y validado**: Facturas recibidas (2) — 62/62 en 09/2026.
- **Descargado sin cotejo (datos acumulados)**: Cuentas Tributarias (12, 7 filas), CCMA/Autónomos
  (13, 11 filas), Mis Facilidades (15, 14 filas), Ventanilla/DFE (16, 5 filas).
- **Con ruta de navegación escrita, a probar en la próxima corrida**:
  - Portal IVA (3): botón CONSULTAR de "Declaraciones juradas presentadas" (aria-label
    `…declaraciones.anteriores.portal`), abre en pestaña nueva.
  - DDJJ y Pagos (10): cerrar modal "Entendido" (si está) y abrir pestaña "Presentaciones".
  - Bienes Personales (9): botón CONSULTAR de "Mis declaraciones juradas presentadas".
- **Mis Retenciones (11)**: la consulta exige **elegir un impuesto** ("Seleccioná un impuesto");
  0 filas era un error de filtro, no un cero. Se agregó la selección de impuesto; si el control no
  es un `<select>` nativo, el diagnóstico ahora captura las opciones del desplegable para afinarlo.
- **Facturas emitidas (1b)**: la pantalla de resultados da 0 tablas; se captura diagnóstico
  saneado en cada corrida, sin asumir cero ventas.
- **Ganancias Personas Humanas (8)**: la portada no expone controles clickeables en el
  relevamiento; falta un diagnóstico de la estructura de sus tarjetas para escribir la ruta.
- **SIFERE / Convenio Multilateral (5-7, CM03/CM05/SIRCREB)**: **bloqueo real** — no está entre los
  servicios adheridos a la clave fiscal (no aparece en el listado del portal). Requiere adherirlo
  en Administrador de Relaciones, paso manual del contribuyente; no se automatiza.
- **Sin web service para el dato**: DDJJ, pagos, retenciones sufridas, cuenta tributaria y
  comprobantes recibidos solo salen por portal (mecanismo 2).

**Orden de implementación, de mayor a menor valor**

1. Una corrida integral en tu máquina (sesión visible): extrae lo que ya tiene extractor y
   captura la estructura de cada hub que el drill atraviese.
2. Con esa estructura: confirmar columnas/selectores de Portal IVA (DDJJ), DDJJ y Pagos
   (presentaciones y VEP pagados), SIFERE (CM03, CM05, SIRCREB) y Ganancias/Bienes Personales.
3. Emitidos: resolver por qué la grilla da 0 tablas a partir del diagnóstico saneado.
4. Web services de padrón, constatación y ventanilla con el certificado.
