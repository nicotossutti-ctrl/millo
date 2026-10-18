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
| 2 | **Facturas recibidas** | Compras con CAE emitidas a tu CUIT: crédito fiscal, percepciones | Portal · Mis Comprobantes · Recibidos | Sí, con sesión | Mensual | Sin web service. No incluye facturas de proveedores que no te las emitieron a tu CUIT | **C** (mismo extractor) |
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
  ARCA, detección de CAPTCHA y 2FA con parada, cookies persistidas con permisos 0600, apertura
  de servicios por el buscador del portal.
- Modo diagnóstico: entra a cada servicio y guarda captura, HTML, inventario de formularios y
  tráfico de red, para escribir los selectores exactos sin adivinar.
- Extractor de Mis Comprobantes emitidos y recibidos (fuentes 1b y 2), con selectores
  provisorios hasta el diagnóstico.

**Orden de implementación, de mayor a menor valor para la estimación mensual**

1. Diagnóstico de los diez servicios (una corrida en tu máquina, con sesión visible).
2. Mis Comprobantes recibidos y emitidos: confirmar selectores, validar un mes contra WSFE.
3. Mis Retenciones y Cuentas Tributarias: pagos a cuenta, deuda, saldos.
4. Portal IVA: DDJJ mensuales.
5. SIFERE Web: CM03, CM05 y deducciones.
6. CCMA, Presentación de DDJJ y Pagos (Ganancias y Bienes Personales históricos), Mis Facilidades.
7. Web services de padrón, constatación y ventanilla con el certificado.
