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

1. **En la base:** el rol de FiscalOS solo puede leer las vistas del esquema `fiscalos`, que filtran por el `user_id` de
   PALERMO (`docs/pfos-acceso.sql`). Para ese rol, las filas de la otra cuenta no existen. Tampoco puede leer las tablas de
   PFOS, ni `ml_accounts` (donde están los tokens).
2. **En FiscalOS:** cada vista tiene que traer una sola cuenta, la configurada en `FISCALOS_PFOS_CUENTA`.
3. **Por identificadores:** las facturas a clientes de la cuenta tienen que estar en tus comprobantes emitidos de ARCA,
   con el mismo punto de venta y número o el mismo CAE. El punto de venta y el número solo existen dentro de un CUIT, y el
   CAE lo otorga ARCA a ese CUIT. Si coinciden menos del 95 %, FiscalOS **no usa** los datos de ese mes.

## 5. Seguridad del acceso

- **Rol propio, mínimo.** `fiscalos_lectura` solo tiene `SELECT` sobre las vistas, con la sesión en solo lectura. Se crea
  con SQL, **no** desde la consola de Neon: los roles de la consola heredan `neon_superuser`.
- **Controles antes de leer.** Si el rol no cumple con algo de esto, FiscalOS no lee nada:
  - no es superusuario;
  - no hereda permisos de otro rol;
  - no es dueño de ningún objeto;
  - no puede escribir en ninguna tabla;
  - no puede leer tablas de PFOS directamente.
- **La clave** la genera Nicolás en su PC y va solo en `arca\.env` (`FISCALOS_PFOS_URL`), que nunca se sube. No pasa por
  el chat.
- **Nada público.** FiscalOS guarda una foto por mes en `out/pfos/` (local, ignorado por git). La app sigue escuchando
  solo en 127.0.0.1.

## 6. Pasos (cuando Nicolás lo apruebe)

1. Revisar `docs/pfos-acceso.sql`, completar `<ID_CUENTA>` y `<CLAVE>`, y correrlo en el SQL Editor de Neon (como dueño).
2. En `arca\.env`:
   - `FISCALOS_PFOS_URL=postgresql://fiscalos_lectura:<CLAVE>@<host>/<base>?sslmode=require`;
   - `FISCALOS_PFOS_CUENTA=<ID_CUENTA>`.
3. `fiscalos.ps1 actualizar` y después `fiscalos.ps1 pfos -Periodo "2026-09,2026-10"`. La consola muestra:
   - si la cuenta quedó verificada;
   - cada concepto, con su cobertura;
   - las unidades sin costo.
4. Abrir la app: **Rentabilidad** muestra:
   - la comparación septiembre / octubre;
   - el recuadro de PFOS, con la cobertura de cada fuente.
