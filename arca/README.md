# ARCA · conciliación

Cliente propio de los web services oficiales de ARCA (ex AFIP). Sin intermediarios:
se autentica con un certificado digital nuestro (WSAA) y consulta Factura Electrónica (WSFEv1)
para reconstruir todos los comprobantes emitidos de un período y exportarlos a CSV.

Es la primera capa de la conciliación. Lo que no tiene web service en ARCA
(Mis Comprobantes recibidos, Mis Retenciones, Cuentas Tributarias, Monotributo)
se resuelve en una segunda capa automatizando el portal, pendiente.

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

`emitidos` escribe `out/emitidos.csv` (separador `;`, coma decimal, listo para Excel o Sheets)
con fecha, tipo, número, CAE, receptor, importes y una columna **Signo** (−1 en notas de crédito)
para sumar directo.

Por defecto recorre **todos** los tipos de comprobante vigentes que informa ARCA y todos los
puntos de venta habilitados, para no dejar afuera una Factura M o de crédito electrónico inesperada.
Para acotar: `--tipos 1,2,3,6,7,8` (A y B) o `--pto 2`.

Atención: el listado de puntos de venta del web service puede no incluir los que usan
Comprobantes en Línea ni los que Mercado Libre u otro sistema crearon para facturar en tu nombre.
Si tenés alguno así, pasalo con `--pto`. La cobertura se valida comparando contra una
exportación manual de Mis Comprobantes del mismo mes.
Con `--json` imprime los comprobantes completos, con detalle de IVA y tributos.

Cada comprobante consultado se guarda en `out/cache/`, así una segunda corrida sobre el mismo
período no vuelve a consultar a ARCA.

## Cómo funciona

- `src/wsaa.js` arma el Ticket de Requerimiento de Acceso, lo firma en CMS (PKCS#7) con
  node-forge (o con `openssl cms` si `ARCA_SIGNER=openssl`) y lo manda a `loginCms`.
- `src/wsfe.js` envuelve los métodos de consulta de WSFEv1: `FEDummy`, `FEParamGetPtosVenta`,
  `FEParamGetTiposCbte`, `FECompUltimoAutorizado`, `FECompConsultar`.
- `src/emitidos.js`: WSFE no lista por fecha, así que para cada punto de venta y tipo pide el
  último autorizado y recorre hacia atrás de a uno hasta pasar la fecha de inicio.

## Próximos pasos

- Constatación de comprobantes recibidos (WSCDCV1) y constancia de inscripción de contrapartes.
- Capa 2: Playwright contra el portal para Mis Comprobantes recibidos, Mis Retenciones y
  Cuentas Tributarias.
- Cruce contra extracto bancario y Mercado Pago.
