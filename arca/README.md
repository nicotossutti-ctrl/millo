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
| WSAA: TRA, firma CMS, ticket y cache | sí | sí (firma verificada con openssl) | parcial: formato aceptado, certificado de prueba rechazado por no ser de ARCA | no |
| WSFEv1: consultas, lista de solo lectura | sí | sí | `FEDummy` sí; el resto requiere certificado | no |
| Recorrido de emitidos y reporte de integridad | sí | sí (series simuladas con huecos, errores y desorden) | no | no |
| Validaciones de importes, IVA, moneda, fecha | sí | sí | no | no |
| Notas de crédito: signo y anulación | sí | sí | no | no |
| Reintentos controlados | sí | sí | no | no |
| Cache por entorno y CUIT | sí | sí | no | no |
| Ganancias: escala, deducciones, provisión | sí | sí (reproduce la DDJJ 2025 al centavo) | no aplica | calibrado contra DDJJ 2025 presentada |
| Estimación mensual (IIBB, autónomos, Ganancias) | sí | sí | no aplica | pendiente de parámetros del contador |

"Validado en producción" significa contrastado contra Mis Comprobantes de ARCA para un mes.
Hasta que esa columna diga "sí", el CSV de emitidos no se usa para conciliar.

## 1. Instalar

```bash
cd arca
npm install
cp .env.example .env   # completar ARCA_CUIT, ARCA_ENV
```

Requiere Node 20.6 o superior.

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

- `src/wsaa.js` arma el Ticket de Requerimiento de Acceso, lo firma en CMS (PKCS#7) con
  node-forge (o con `openssl cms` si `ARCA_SIGNER=openssl`) y lo manda a `loginCms`.
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
