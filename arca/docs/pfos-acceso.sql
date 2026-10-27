-- FiscalOS ← PFOS: acceso de SOLO LECTURA y SOLO de la cuenta del contribuyente (PALERMO FITNESS).
--
-- ANTES de este archivo: correr docs/pfos-comprobacion.sql (solo lectura) en la MISMA base. Ninguna fila puede decir
-- «BLOQUEA» (las «advertencia» son faltantes de datos y no impiden instalar). Este archivo NO cambia permisos globales de
-- la base: si PUBLIC puede crear en el esquema public (control 14), se revisa antes con quien administra PFOS.
--
-- Lo corre Nicolás UNA vez en el SQL Editor de Neon, en el proyecto de PFOS Mercado Libre (NO en «PFOS TASKS»),
-- conectado con el usuario dueño de la base. No modifica ninguna tabla de PFOS: crea un esquema aparte («fiscalos») con
-- vistas filtradas por la cuenta y protegidas con security_barrier, y un rol que solo puede leer esas vistas. El rol NO
-- tiene acceso a las tablas de PFOS (ni a ml_accounts, con los tokens), ni a la otra cuenta de Mercado Libre (otro CUIT).
--
-- Reemplazar antes de correrlo:
--   <ID_CUENTA>      el user_id de Mercado Libre de PALERMO FITNESS.
--   <VERIFICADOR>    lo que imprime «fiscalos.ps1 pfos-clave» (SCRAM-SHA-256$4096:…). Es la clave CIFRADA: la clave
--                    real queda solo en arca\.env de tu PC y nunca aparece en este SQL ni en el historial de Neon.
--
-- IMPORTANTE (Neon): crear el rol con este SQL, NO desde la consola de Neon. Los roles creados desde la consola quedan
-- dentro de «neon_superuser», que puede leer y escribir todo. FiscalOS lo comprueba y se niega a usar un rol así.
--
-- Para deshacer todo: ver el final del archivo.

BEGIN;

CREATE SCHEMA fiscalos;               -- sin «IF NOT EXISTS»: si ya existe, se frena y se revisa antes de seguir
REVOKE ALL ON SCHEMA fiscalos FROM PUBLIC;

-- security_barrier: el filtro por cuenta se aplica ANTES que cualquier condición de quien consulta; ninguna función de
-- una consulta puede ver filas de la otra cuenta.
CREATE VIEW fiscalos.ordenes WITH (security_barrier = true) AS
  SELECT user_id, key, data, sha, fetched_at FROM public.pfos_money_records WHERE user_id = <ID_CUENTA> AND source = 'orders';
CREATE VIEW fiscalos.cobros_mp WITH (security_barrier = true) AS
  SELECT user_id, key, data, sha, fetched_at FROM public.pfos_money_records WHERE user_id = <ID_CUENTA> AND source = 'mp_payments';
CREATE VIEW fiscalos.devoluciones WITH (security_barrier = true) AS
  SELECT user_id, key, data, sha, fetched_at FROM public.pfos_money_records WHERE user_id = <ID_CUENTA> AND source = 'claim_returns';
CREATE VIEW fiscalos.facturas_clientes WITH (security_barrier = true) AS
  SELECT user_id, key, data, sha, fetched_at FROM public.pfos_money_records WHERE user_id = <ID_CUENTA> AND source = 'invoices';
CREATE VIEW fiscalos.cobertura WITH (security_barrier = true) AS
  SELECT user_id, source, scope, status, reason, last_complete_at, updated_at FROM public.pfos_money_scopes
  WHERE user_id = <ID_CUENTA> AND source IN ('orders', 'mp_payments', 'claim_returns', 'invoices');
CREATE VIEW fiscalos.ads_diario WITH (security_barrier = true) AS
  SELECT user_id, day, level, key, campaign_id, metrics, quality FROM public.pfos_hist_ads_daily
  WHERE user_id = <ID_CUENTA> AND level = U&'campa\00F1a';   -- 'campaña' escrito solo con ASCII
CREATE VIEW fiscalos.conciliacion WITH (security_barrier = true) AS
  SELECT o.user_id, o.source, o.identity_key, o.identity_status, o.data_sha, o.defining_sha,
         i.id AS import_id, i.status AS import_status, i.freshness_at, i.freshness_origin, pl.data
  FROM public.pfos_fin_observations o
  JOIN public.pfos_fin_imports i ON i.id = o.import_id AND i.user_id = o.user_id
  JOIN public.pfos_fin_payloads pl ON pl.user_id = o.user_id AND pl.sha = o.data_sha
  WHERE o.user_id = <ID_CUENTA>
    AND o.source IN ('flex_bonificacion', 'flex_anulacion', 'flex_viaje', 'full_cargo', 'comprobante', 'ads_campana_dia');
CREATE VIEW fiscalos.importaciones WITH (security_barrier = true) AS
  SELECT user_id, id, format, status, freshness_at, freshness_origin, range_from, range_to, range_axis, range_to_exclusive, coverage, created_at, closed_at
  FROM public.pfos_fin_imports WHERE user_id = <ID_CUENTA>;
-- Listas de costos del proveedor (no son de una cuenta) y el mapeo SKU → artículos de la cuenta.
CREATE VIEW fiscalos.costos_listas WITH (security_barrier = true) AS
  SELECT id, supplier, valid_from, valid_to, cash_pct, items, loaded_at FROM public.pfos_cost_lists;
CREATE VIEW fiscalos.costos_items WITH (security_barrier = true) AS
  SELECT list_id, row_no, code, size_label, presentation, pairs, price, price_suggested, discount_pct, factor, description, code_raw FROM public.pfos_cost_items;
CREATE VIEW fiscalos.costos_sku WITH (security_barrier = true) AS
  SELECT user_id, seller_sku, version, valid_from, status, list_id FROM public.pfos_cost_sku_map WHERE user_id = <ID_CUENTA>;
CREATE VIEW fiscalos.costos_sku_componentes WITH (security_barrier = true) AS
  SELECT user_id, seller_sku, version, idx, code, presentation, size_label, row_no, units, pairs FROM public.pfos_cost_sku_components WHERE user_id = <ID_CUENTA>;

-- El rol: entra y solo lee las vistas de «fiscalos». Nunca escribe ni crea nada.
CREATE ROLE fiscalos_lectura LOGIN PASSWORD '<VERIFICADOR>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2;
ALTER ROLE fiscalos_lectura SET default_transaction_read_only = on;
ALTER ROLE fiscalos_lectura SET statement_timeout = '60s';
ALTER ROLE fiscalos_lectura SET search_path = fiscalos;
GRANT USAGE ON SCHEMA fiscalos TO fiscalos_lectura;
GRANT SELECT ON ALL TABLES IN SCHEMA fiscalos TO fiscalos_lectura;

COMMIT;

-- Comprobación (como dueño), todas tienen que dar false:
--   SELECT has_table_privilege('fiscalos_lectura', 'public.pfos_money_records', 'SELECT');
--   SELECT has_table_privilege('fiscalos_lectura', 'public.ml_accounts', 'SELECT');
--   SELECT has_table_privilege('fiscalos_lectura', 'fiscalos.ordenes', 'INSERT');
--   SELECT has_schema_privilege('fiscalos_lectura', 'public', 'CREATE');
--   SELECT has_schema_privilege('fiscalos_lectura', 'fiscalos', 'CREATE');
--   SELECT has_database_privilege('fiscalos_lectura', current_database(), 'CREATE');
-- Y esta tiene que devolver UNA sola fila, con el user_id de PALERMO:
--   SELECT DISTINCT user_id FROM fiscalos.ordenes;
--
-- Deshacer (como dueño):
--   REVOKE ALL ON ALL TABLES IN SCHEMA fiscalos FROM fiscalos_lectura;
--   REVOKE USAGE ON SCHEMA fiscalos FROM fiscalos_lectura;
--   DROP ROLE fiscalos_lectura;
--   DROP SCHEMA fiscalos CASCADE;          -- borra solo las vistas; las tablas de PFOS no se tocan.
