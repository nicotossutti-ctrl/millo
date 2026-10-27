-- FiscalOS ← PFOS: acceso de SOLO LECTURA y SOLO de la cuenta del contribuyente (PALERMO FITNESS).
--
-- Lo corre Nicolás UNA vez en el SQL Editor de Neon, conectado con el usuario dueño de la base, DESPUÉS de revisarlo.
-- No modifica ninguna tabla de PFOS: crea un esquema aparte («fiscalos») con vistas filtradas por la cuenta, y un rol
-- que solo puede leer esas vistas. El rol NO tiene acceso a las tablas de PFOS (ni a ml_accounts, con los tokens), ni a
-- la otra cuenta de Mercado Libre (otro CUIT): las filas de esa cuenta no existen para él.
--
-- Antes de correrlo, reemplazar:
--   <ID_CUENTA>  el user_id de Mercado Libre de PALERMO FITNESS (está en CLAUDE.md de PFOS, tabla «Cuentas»).
--   <CLAVE>      una clave larga generada en tu PC (por ejemplo, en PowerShell:
--                  [Convert]::ToBase64String((1..32 | % { Get-Random -Max 256 }) -as [byte[]])
--                ). No pasa por el chat ni por GitHub. Va solo acá y en arca\.env de tu PC.
--
-- IMPORTANTE (Neon): crear el rol con este SQL, NO desde la consola de Neon. Los roles creados desde la consola quedan
-- dentro de «neon_superuser», que puede leer y escribir todo. FiscalOS lo comprueba y se niega a usar un rol así.
--
-- Para deshacer todo: ver el final del archivo.

BEGIN;

CREATE SCHEMA IF NOT EXISTS fiscalos;

-- Ventas, cobros de Mercado Pago, devoluciones, facturas a clientes y cobertura de la recolección (solo PALERMO).
CREATE OR REPLACE VIEW fiscalos.ordenes AS
  SELECT user_id, key, data, sha, fetched_at FROM public.pfos_money_records WHERE user_id = <ID_CUENTA> AND source = 'orders';
CREATE OR REPLACE VIEW fiscalos.cobros_mp AS
  SELECT user_id, key, data, sha, fetched_at FROM public.pfos_money_records WHERE user_id = <ID_CUENTA> AND source = 'mp_payments';
CREATE OR REPLACE VIEW fiscalos.devoluciones AS
  SELECT user_id, key, data, sha, fetched_at FROM public.pfos_money_records WHERE user_id = <ID_CUENTA> AND source = 'claim_returns';
CREATE OR REPLACE VIEW fiscalos.facturas_clientes AS
  SELECT user_id, key, data, sha, fetched_at FROM public.pfos_money_records WHERE user_id = <ID_CUENTA> AND source = 'invoices';
CREATE OR REPLACE VIEW fiscalos.cobertura AS
  SELECT user_id, source, scope, status, reason, last_complete_at, updated_at FROM public.pfos_money_scopes
  WHERE user_id = <ID_CUENTA> AND source IN ('orders', 'mp_payments', 'claim_returns', 'invoices');

-- Publicidad: inversión diaria por campaña (el nivel completo de Mercado Ads).
CREATE OR REPLACE VIEW fiscalos.ads_diario AS
  SELECT user_id, day, level, key, campaign_id, metrics, quality FROM public.pfos_hist_ads_daily
  WHERE user_id = <ID_CUENTA> AND level = 'campaña';

-- «Conciliación» de PFOS: reportes cargados por Nicolás (Flex, Luma, Full, facturas a clientes, campañas de Ads).
-- Solo las fuentes que usa FiscalOS; los datos del comprador nunca entraron a PFOS.
CREATE OR REPLACE VIEW fiscalos.conciliacion AS
  SELECT o.user_id, o.source, o.identity_key, o.identity_status, o.data_sha, o.defining_sha,
         i.id AS import_id, i.status AS import_status, i.freshness_at, i.freshness_origin, pl.data
  FROM public.pfos_fin_observations o
  JOIN public.pfos_fin_imports i ON i.id = o.import_id
  JOIN public.pfos_fin_payloads pl ON pl.user_id = o.user_id AND pl.sha = o.data_sha
  WHERE o.user_id = <ID_CUENTA>
    AND o.source IN ('flex_bonificacion', 'flex_anulacion', 'flex_viaje', 'full_cargo', 'comprobante', 'ads_campana_dia');
CREATE OR REPLACE VIEW fiscalos.importaciones AS
  SELECT id, format, status, freshness_at, freshness_origin, range_from, range_to, range_axis, range_to_exclusive, coverage, created_at, closed_at
  FROM public.pfos_fin_imports WHERE user_id = <ID_CUENTA>;

-- Costo de la mercadería: listas del proveedor (no son de una cuenta) y el mapeo SKU → artículos de PALERMO.
CREATE OR REPLACE VIEW fiscalos.costos_listas AS
  SELECT id, supplier, valid_from, valid_to, cash_pct, items, loaded_at FROM public.pfos_cost_lists;
CREATE OR REPLACE VIEW fiscalos.costos_items AS
  SELECT list_id, row_no, code, size_label, presentation, pairs, price, price_suggested, discount_pct, factor FROM public.pfos_cost_items;
CREATE OR REPLACE VIEW fiscalos.costos_sku AS
  SELECT seller_sku, version, valid_from, status, list_id FROM public.pfos_cost_sku_map WHERE user_id = <ID_CUENTA>;
CREATE OR REPLACE VIEW fiscalos.costos_sku_componentes AS
  SELECT seller_sku, version, idx, code, presentation, size_label, row_no, units, pairs FROM public.pfos_cost_sku_components WHERE user_id = <ID_CUENTA>;

-- El rol: entra, solo lee las vistas de «fiscalos», nunca escribe.
CREATE ROLE fiscalos_lectura LOGIN PASSWORD '<CLAVE>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE fiscalos_lectura SET default_transaction_read_only = on;
ALTER ROLE fiscalos_lectura SET statement_timeout = '60s';
GRANT USAGE ON SCHEMA fiscalos TO fiscalos_lectura;
GRANT SELECT ON ALL TABLES IN SCHEMA fiscalos TO fiscalos_lectura;

COMMIT;

-- Comprobación (como dueño): el rol no puede leer ninguna tabla de PFOS ni escribir nada.
--   SELECT has_table_privilege('fiscalos_lectura', 'public.pfos_money_records', 'SELECT');  -- tiene que dar false
--   SELECT has_table_privilege('fiscalos_lectura', 'public.ml_accounts', 'SELECT');         -- false
--   SELECT has_table_privilege('fiscalos_lectura', 'fiscalos.ordenes', 'INSERT');           -- false
--
-- Deshacer (como dueño):
--   DROP ROLE fiscalos_lectura;            -- antes: REVOKE ALL ON ALL TABLES IN SCHEMA fiscalos FROM fiscalos_lectura;
--                                          --        REVOKE USAGE ON SCHEMA fiscalos FROM fiscalos_lectura;
--   DROP SCHEMA fiscalos CASCADE;          -- borra solo las vistas; las tablas de PFOS no se tocan.
