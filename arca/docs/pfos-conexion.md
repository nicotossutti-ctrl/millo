# FiscalOS ← PFOS: qué se puede obtener, qué falta y cómo se conecta

Relevamiento hecho sobre el código y el diseño de PFOS (`pfos-ml` en `7ac8b62`: `lib/money_specs.js`, `lib/money_store.js`,
`lib/metrics_store.js`, `lib/metrics_costs.js`, `lib/fin_formats.js`, `lib/fin_store.js`, `lib/metrics_adsdaily.js` y
`docs/rentabilidad-DISENO.md`). **No se modificó PFOS ni su base.** Todavía no hay acceso a los datos reales: la
cobertura real de septiembre y octubre la mide `fiscalos.ps1 pfos` la primera vez que se corra, y queda a la vista.

## 1. Qué aporta PFOS, concepto por concepto (solo PALERMO FITNESS)

| Concepto en FiscalOS | De dónde lo saca PFOS | Estado conocido | Qué falta o se verifica al conectar |
|---|---|---|---|
| Ventas (control; los ingresos salen de ARCA) | `orders` en `pfos_money_records`: fecha, estado, líneas con SKU, cantidad y precio, pagos | PFOS lo verificó el 25/10 con el reporte de ML del 22 al 30/09 | Días del mes con recolección completa (alcances `hist|día`): se miden |
| **Costo de la mercadería vendida** | Unidades vendidas × lista de costos (`pfos_cost_lists/items`) × factor de descuento, con el mapeo SKU → artículo confirmado en PFOS (`pfos_cost_sku_map`) o la propuesta automática de PFOS | Hay **una** lista, vigente desde el 01/10 | Septiembre usa esa lista **marcada «posterior a la venta»** (lo prevé el diseño de PFOS, 13). Unidades sin costo: listadas por SKU con el motivo. No se aplica nada por suposición |
| Mercadería que volvió | `claim_returns` entregadas, por la cantidad devuelta, al costo de la venta original | Recolectado desde la v39 | Se resta en el mes en que se cierra la devolución |
| **Comisiones y cargos de ML** | Cobro de MP de cada venta (`mp_payments.charges_details`): cargo por vender, costo fijo, cuotas y cupones a cargo del vendedor, netos de lo devuelto | Verificado por PFOS el 25/10 (97–100 %) | Vienen **con IVA**: el neto (÷ 1,21) queda *estimado* hasta cotejarlo con las facturas de ML que ARCA tiene en tus comprobantes recibidos |
| **Logística** | Envío a cargo del vendedor (cobro de MP) + Full (`full_cargo`) − bonificación Flex (`flex_bonificacion`) + anulaciones + cadete de Luma (`flex_viaje`) | Full y Flex dependen de los reportes cargados en «Conciliación» | Cobertura por rango declarado de cada reporte. Luma: su IVA no está verificado (se toma el importe entero) |
| **Publicidad** | Inversión diaria por campaña de Mercado Ads (`pfos_hist_ads_daily`, nivel campaña) | Recolectada desde la v37 | Días del mes con dato. El IVA de la factura de Ads está pendiente en PFOS (1,19 no cierra con 21 %) |
| Retenciones de MP | `charges_details` de tipo impuesto | — | Se muestran como **anticipos**, nunca como costo |

## 2. Qué no da PFOS (y queda en FiscalOS)

- Gastos operativos (contador, alquiler, etc.): proveedores clasificados en ARCA o carga manual.
- Ingresos Brutos determinado (CM03), cuota de autónomos y parámetros de Ganancias.
- La otra cuenta de Mercado Libre: **no se lee** (otro CUIT).

## 3. Cómo se evita contar dos veces

- **Una sola fuente por concepto y mes:** carga manual firme > archivo importado > PFOS **completo** > carga manual
  *estimada* > facturas de ARCA. Las otras fuentes quedan al lado como referencia y no se suman.
- PFOS **incompleto** (por ejemplo, ventas de algunos días sin recolectar) nunca es la fuente: se ve como referencia,
  con lo que le falta.
- Las facturas de **Mercado Libre** y de **Luma** en ARCA quedan como control cuando la fuente es PFOS. Si un mes mezcla
  PFOS y facturas de ML en ARCA para cargos y logística, la app lo avisa.
- Las facturas de **SOX** son compras de mercadería: van a stock y no son el costo de lo vendido.
- **Septiembre:** tu costo estimado de $66.500.000 sin IVA se mantiene como fuente mientras PFOS no esté completo para el
  mes. El costo reconstruido por PFOS se muestra al lado, con su cobertura, **sin forzar coincidencias**.

## 4. Separación de cuentas (solo PALERMO)

1. **En la base.** El rol de FiscalOS solo puede leer las vistas del esquema `fiscalos`, que filtran por el `user_id` de
   PALERMO (`docs/pfos-acceso.sql`):
   - las vistas tienen `security_barrier`: el filtro por cuenta se aplica antes que cualquier condición de una consulta;
   - para ese rol, las filas de la otra cuenta no existen;
   - tampoco puede leer las tablas de PFOS ni `ml_accounts` (los tokens).
2. **En FiscalOS, la configuración:**
   - `FISCALOS_PFOS_CUENTA` es **obligatoria**: sin ella no se abre ninguna conexión;
   - `FISCALOS_PFOS_EXCLUIDAS` (la otra cuenta) nunca se acepta como cuenta;
   - cada vista tiene que traer una sola cuenta, la configurada.
3. **Por CAE.** Las facturas a clientes de la cuenta, del reporte de comprobantes cargado en «Conciliación» de PFOS, tienen
   que estar en **tus comprobantes emitidos de ARCA** con el **mismo CAE** y el mismo punto de venta y número:
   - hacen falta al menos 20 CAE **distintos** en el mes (se cuentan facturas, no filas de productos), y que coincida el
     95 %; un CAE que aparece con dos números distintos no cuenta;
   - punto de venta + número solos **nunca** validan, porque se repiten entre CUIT distintos;
   - sin evidencia suficiente, el mes queda «cuenta no verificada» y sus datos no se usan.

## 5. Seguridad del acceso

- **Rol propio, mínimo.** `fiscalos_lectura`:
  - solo tiene `SELECT` sobre las vistas, con la sesión en solo lectura;
  - se crea con SQL, **no** desde la consola de Neon (los roles de la consola heredan `neon_superuser`).
- **Controles antes de leer.** Si el rol no cumple con algo de esto, FiscalOS no lee nada:
  - no es superusuario;
  - no hereda permisos de otro rol;
  - no es dueño de ningún objeto;
  - no puede escribir en ninguna tabla;
  - **no puede crear** objetos en ningún esquema ni esquemas en la base;
  - no puede leer tablas de PFOS directamente.
- **Objetos temporales.** PostgreSQL deja crearlos a todos los roles (privilegio TEMP de PUBLIC). Duran lo que dura la
  sesión y no tocan datos de PFOS. Quitarlo afectaría a todos los roles de la base, así que se deja como está.
- **Clave.**
  - La genera `fiscalos.ps1 pfos-clave` con el generador criptográfico de Node (`crypto.randomBytes`, 256 bits, 64
    caracteres hexadecimales). Solo usa 0-9 y a-f, así que no hay que codificarla para la URL.
  - Queda **solo** en `arca\.env` (`FISCALOS_PFOS_CLAVE`).
  - El SQL lleva el **verificador SCRAM-SHA-256** (la clave cifrada, como la guarda PostgreSQL): la clave real no aparece
    en el SQL ni en el historial de Neon.
- **URL.** FiscalOS la arma desde `FISCALOS_PFOS_HOST`, `FISCALOS_PFOS_BASE` y la clave, con el usuario fijo
  `fiscalos_lectura`:
  - forma: `postgresql://fiscalos_lectura:<clave>@<host>/<base>?sslmode=require`;
  - si se usa `FISCALOS_PFOS_URL` a mano, la clave va codificada para URL (`encodeURIComponent`);
  - FiscalOS rechaza una URL con otro usuario (por ejemplo, el dueño).
- **Nada público.** Las fotos por mes quedan en `out/pfos/` (local, fuera de git). La app escucha solo en 127.0.0.1.

## 6. Instalación (cuando Nicolás lo apruebe)

1. **Proyecto correcto.** En Neon, abrir el proyecto de **PFOS Mercado Libre**: es la base con `pfos_money_records`, **no**
   «PFOS TASKS».
2. **Comprobación previa (solo lectura).** Abrir `docs/pfos-comprobacion.sql` y reemplazar `<ID_CUENTA>` (PALERMO) y
   `<ID_EXCLUIDA>` (la otra cuenta). Correrlo en el SQL Editor. Devuelve 16 filas, cada una con su resultado:
   - **BLOQUEA**: estructura incompatible (tablas o columnas), cuenta incorrecta o permisos inseguros (PUBLIC puede leer
     tablas de PFOS o crear en `public`). **No se instala**: se manda el resultado para revisarlo. El SQL de acceso no
     cambia permisos globales de la base;
   - **advertencia**: faltan datos (días de ventas, cobros o Ads; menos de 20 CAE distintos en septiembre u octubre;
     reportes). Se puede instalar: ese mes queda incompleto o «cuenta no verificada» en FiscalOS, con su diagnóstico a la
     vista;
   - si la consulta falla con «relation "pfos_money_records" does not exist», es la base equivocada.
3. **Clave.** En la PC: `fiscalos.ps1 actualizar` y después `fiscalos.ps1 pfos-clave`:
   - guarda la clave en `arca\.env`;
   - imprime el verificador (`SCRAM-SHA-256$4096:…`).
4. **Acceso.** Abrir `docs/pfos-acceso.sql`, reemplazar `<ID_CUENTA>` y `<VERIFICADOR>`, y correrlo **como dueño**:
   - si Neon rechaza el verificador, correr `fiscalos.ps1 pfos-clave -Nueva -Texto`, usar esa clave en su lugar y después
     borrar ese SQL del historial;
   - al final del archivo están las comprobaciones (todas `false`) y cómo deshacer.
5. **Configuración.** En `arca\.env` (ver `.env.example`):
   - `FISCALOS_PFOS_HOST`: el host del proyecto, de la cadena de conexión de Neon;
   - `FISCALOS_PFOS_BASE`;
   - `FISCALOS_PFOS_CUENTA` (PALERMO);
   - `FISCALOS_PFOS_EXCLUIDAS` (la otra cuenta).
6. **Prueba.** `fiscalos.ps1 pfos -Periodo "2026-09,2026-10"`. La consola dice:
   - qué rol se usó y que pasó los controles;
   - si la cuenta quedó verificada por CAE en cada mes;
   - cada concepto con su cobertura;
   - las unidades sin costo.
