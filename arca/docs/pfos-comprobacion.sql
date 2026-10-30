-- FiscalOS ← PFOS: COMPROBACIÓN PREVIA, SOLO LECTURA. Se corre ANTES de docs/pfos-acceso.sql, en el SQL Editor de Neon,
-- en el proyecto de PFOS Mercado Libre (NO en «PFOS TASKS»). Es una sola consulta SELECT: no crea, no cambia ni borra
-- nada. De los datos de la cuenta solo trae CANTIDADES.
--
-- Reemplazar antes de correrla:
--   <ID_CUENTA>    el user_id de Mercado Libre de PALERMO FITNESS (la cuenta que lee FiscalOS);
--   <ID_EXCLUIDA>  el user_id de la otra cuenta (otro CUIT), que tiene que quedar afuera.
--
-- Cada fila dice:
--   BLOQUEA      estructura incompatible, permisos inseguros o cuenta incorrecta: NO se corre pfos-acceso.sql;
--   advertencia  faltan datos (días, cobros, CAE, reportes): se puede instalar; el mes afectado queda incompleto o sin
--                verificar en FiscalOS, y se ve en su diagnóstico;
--   ok / info    nada que hacer.
-- Si la consulta falla con «relation "pfos_money_records" does not exist», es la base equivocada (p. ej. PFOS TASKS).

WITH
tablas(t) AS (VALUES ('pfos_money_records'), ('pfos_money_scopes'), ('pfos_hist_ads_daily'), ('pfos_fin_imports'), ('pfos_fin_observations'),
  ('pfos_fin_payloads'), ('pfos_cost_lists'), ('pfos_cost_items'), ('pfos_cost_sku_map'), ('pfos_cost_sku_components'), ('ml_accounts')),
columnas(t, c) AS (VALUES
  ('pfos_money_records', 'user_id'), ('pfos_money_records', 'source'), ('pfos_money_records', 'key'), ('pfos_money_records', 'data'),
  ('pfos_money_records', 'sha'), ('pfos_money_records', 'fetched_at'),
  ('pfos_money_scopes', 'user_id'), ('pfos_money_scopes', 'source'), ('pfos_money_scopes', 'scope'), ('pfos_money_scopes', 'status'),
  ('pfos_money_scopes', 'reason'), ('pfos_money_scopes', 'last_complete_at'), ('pfos_money_scopes', 'updated_at'),
  ('pfos_hist_ads_daily', 'user_id'), ('pfos_hist_ads_daily', 'day'), ('pfos_hist_ads_daily', 'level'), ('pfos_hist_ads_daily', 'key'),
  ('pfos_hist_ads_daily', 'campaign_id'), ('pfos_hist_ads_daily', 'metrics'), ('pfos_hist_ads_daily', 'quality'),
  ('pfos_fin_observations', 'user_id'), ('pfos_fin_observations', 'source'), ('pfos_fin_observations', 'identity_key'),
  ('pfos_fin_observations', 'identity_status'), ('pfos_fin_observations', 'data_sha'), ('pfos_fin_observations', 'defining_sha'),
  ('pfos_fin_observations', 'import_id'),
  ('pfos_fin_imports', 'id'), ('pfos_fin_imports', 'user_id'), ('pfos_fin_imports', 'format'), ('pfos_fin_imports', 'status'),
  ('pfos_fin_imports', 'freshness_at'), ('pfos_fin_imports', 'freshness_origin'), ('pfos_fin_imports', 'range_from'), ('pfos_fin_imports', 'range_to'),
  ('pfos_fin_imports', 'range_axis'), ('pfos_fin_imports', 'range_to_exclusive'), ('pfos_fin_imports', 'coverage'), ('pfos_fin_imports', 'created_at'),
  ('pfos_fin_imports', 'closed_at'),
  ('pfos_fin_payloads', 'user_id'), ('pfos_fin_payloads', 'sha'), ('pfos_fin_payloads', 'data'),
  ('pfos_cost_lists', 'id'), ('pfos_cost_lists', 'supplier'), ('pfos_cost_lists', 'valid_from'), ('pfos_cost_lists', 'valid_to'),
  ('pfos_cost_lists', 'cash_pct'), ('pfos_cost_lists', 'items'), ('pfos_cost_lists', 'loaded_at'),
  ('pfos_cost_items', 'list_id'), ('pfos_cost_items', 'row_no'), ('pfos_cost_items', 'code'), ('pfos_cost_items', 'size_label'),
  ('pfos_cost_items', 'presentation'), ('pfos_cost_items', 'pairs'), ('pfos_cost_items', 'price'), ('pfos_cost_items', 'price_suggested'),
  ('pfos_cost_items', 'discount_pct'), ('pfos_cost_items', 'factor'), ('pfos_cost_items', 'description'), ('pfos_cost_items', 'code_raw'),
  ('pfos_cost_sku_map', 'user_id'), ('pfos_cost_sku_map', 'seller_sku'), ('pfos_cost_sku_map', 'version'), ('pfos_cost_sku_map', 'valid_from'),
  ('pfos_cost_sku_map', 'status'), ('pfos_cost_sku_map', 'list_id'),
  ('pfos_cost_sku_components', 'user_id'), ('pfos_cost_sku_components', 'seller_sku'), ('pfos_cost_sku_components', 'version'),
  ('pfos_cost_sku_components', 'idx'), ('pfos_cost_sku_components', 'code'), ('pfos_cost_sku_components', 'presentation'),
  ('pfos_cost_sku_components', 'size_label'), ('pfos_cost_sku_components', 'row_no'), ('pfos_cost_sku_components', 'units'),
  ('pfos_cost_sku_components', 'pairs'),
  ('ml_accounts', 'user_id')),
falta_tabla AS (SELECT string_agg(t, ', ') AS x FROM tablas WHERE to_regclass('public.' || t) IS NULL),
falta_col AS (SELECT string_agg(c.t || '.' || c.c, ', ') AS x FROM columnas c
  WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns i WHERE i.table_schema = 'public' AND i.table_name = c.t AND i.column_name = c.c)),
-- Fecha de un campo JSON como timestamptz solo si tiene forma de fecha (un dato tapado no corta la consulta).
reg AS (SELECT source, CASE WHEN data->>'date_created' ~ '^\d{4}-\d{2}-\d{2}T' THEN (data->>'date_created')::timestamptz END AS creada,
          (data ? 'order_items') AS con_items, (data ? 'payments') AS con_pagos, (data ? 'charges_details') AS con_cargos
        FROM public.pfos_money_records WHERE user_id = <ID_CUENTA> AND source IN ('orders', 'mp_payments', 'claim_returns', 'invoices')),
alc AS (SELECT source, scope, status FROM public.pfos_money_scopes
        WHERE user_id = <ID_CUENTA> AND source IN ('orders', 'mp_payments') AND (scope LIKE 'hist|2026-09-%' OR scope LIKE 'hist|2026-10-%')),
ads AS (SELECT level, day FROM public.pfos_hist_ads_daily WHERE user_id = <ID_CUENTA> AND day >= DATE '2026-09-01' AND day < DATE '2026-11-01'),
cbte AS (SELECT left(pl.data->>'fecha_emision', 7) AS mes, nullif(regexp_replace(coalesce(pl.data->>'cae', ''), '\D', '', 'g'), '') AS cae
         FROM public.pfos_fin_observations o JOIN public.pfos_fin_imports i ON i.id = o.import_id
         JOIN public.pfos_fin_payloads pl ON pl.user_id = o.user_id AND pl.sha = o.data_sha
         WHERE o.user_id = <ID_CUENTA> AND o.source = 'comprobante' AND i.status IN ('cerrada', 'reemplazando')),
controles(orden, control, bloquea, ok, detalle) AS (
  SELECT 1, 'base', false, true, current_database() || ' · ' || split_part(version(), ' ', 2)
  UNION ALL SELECT 2, 'tablas de PFOS Mercado Libre', true, (SELECT x IS NULL FROM falta_tabla), coalesce('faltan: ' || (SELECT x FROM falta_tabla), 'las 11 están')
  UNION ALL SELECT 3, 'columnas que usan las vistas', true, (SELECT x IS NULL FROM falta_col), coalesce('faltan: ' || (SELECT x FROM falta_col), 'todas están')
  UNION ALL SELECT 4, 'la cuenta de FiscalOS existe en PFOS', true, EXISTS (SELECT 1 FROM public.ml_accounts WHERE user_id = <ID_CUENTA>), '<ID_CUENTA>'
  UNION ALL SELECT 5, 'la cuenta excluida es otra', true, <ID_EXCLUIDA> <> <ID_CUENTA>,
    CASE WHEN EXISTS (SELECT 1 FROM public.ml_accounts WHERE user_id = <ID_EXCLUIDA>) THEN 'existe en PFOS y queda afuera de las vistas' ELSE 'no está en PFOS' END
  UNION ALL SELECT 6, 'ventas de la cuenta (sept / oct)', false,
    (SELECT count(*) FILTER (WHERE creada >= '2026-09-01T00:00:00-03:00' AND creada < '2026-10-01T00:00:00-03:00') > 0
        AND count(*) FILTER (WHERE creada >= '2026-10-01T00:00:00-03:00' AND creada < '2026-11-01T00:00:00-03:00') > 0 FROM reg WHERE source = 'orders'),
    (SELECT count(*) FILTER (WHERE creada >= '2026-09-01T00:00:00-03:00' AND creada < '2026-10-01T00:00:00-03:00') || ' / ' ||
            count(*) FILTER (WHERE creada >= '2026-10-01T00:00:00-03:00' AND creada < '2026-11-01T00:00:00-03:00') || ' órdenes; ' ||
            count(*) FILTER (WHERE NOT con_items OR NOT con_pagos) || ' sin líneas o sin pagos' FROM reg WHERE source = 'orders')
  UNION ALL SELECT 7, 'cobros de MP, devoluciones y facturas de la cuenta', false, (SELECT count(*) > 0 FROM reg WHERE source = 'mp_payments'),
    (SELECT count(*) FILTER (WHERE source = 'mp_payments') || ' cobros (' || count(*) FILTER (WHERE source = 'mp_payments' AND NOT con_cargos) || ' sin cargos) · ' ||
            count(*) FILTER (WHERE source = 'claim_returns') || ' devoluciones · ' || count(*) FILTER (WHERE source = 'invoices') || ' facturas' FROM reg)
  UNION ALL SELECT 8, 'días con ventas y cobros completos en PFOS (sept / oct)', false,
    (SELECT count(*) FILTER (WHERE status = 'completa' AND scope LIKE 'hist|2026-09-%') = 60 AND count(*) FILTER (WHERE status = 'completa' AND scope LIKE 'hist|2026-10-%') = 62 FROM alc),
    (SELECT 'ventas ' || count(*) FILTER (WHERE source = 'orders' AND status = 'completa' AND scope LIKE 'hist|2026-09-%') || '/30 · ' ||
            count(*) FILTER (WHERE source = 'orders' AND status = 'completa' AND scope LIKE 'hist|2026-10-%') || '/31; cobros ' ||
            count(*) FILTER (WHERE source = 'mp_payments' AND status = 'completa' AND scope LIKE 'hist|2026-09-%') || '/30 · ' ||
            count(*) FILTER (WHERE source = 'mp_payments' AND status = 'completa' AND scope LIKE 'hist|2026-10-%') || '/31' FROM alc)
  UNION ALL SELECT 9, 'Mercado Ads por campaña (nivel «campaña»)', false,
    (SELECT count(DISTINCT day) FILTER (WHERE level = U&'campa\00F1a' AND day < DATE '2026-10-01') = 30 AND count(DISTINCT day) FILTER (WHERE level = U&'campa\00F1a' AND day >= DATE '2026-10-01') = 31 FROM ads),
    (SELECT 'días sept ' || count(DISTINCT day) FILTER (WHERE level = U&'campa\00F1a' AND day < DATE '2026-10-01') || '/30 · oct ' ||
            count(DISTINCT day) FILTER (WHERE level = U&'campa\00F1a' AND day >= DATE '2026-10-01') || '/31 · niveles: ' || coalesce(string_agg(DISTINCT level, ', '), 'ninguno') FROM ads)
  -- FiscalOS exige al menos 20 CAE DISTINTOS por mes para dar la cuenta por verificada en ese mes.
  UNION ALL SELECT 10, 'facturas distintas con CAE en «Conciliación»: septiembre (mínimo 20)', false,
    (SELECT count(DISTINCT cae) >= 20 FROM cbte WHERE mes = '2026-09'),
    (SELECT count(DISTINCT cae) || ' CAE distintos · ' || count(*) FILTER (WHERE cae IS NULL) || ' filas sin CAE' FROM cbte WHERE mes = '2026-09')
  UNION ALL SELECT 11, 'facturas distintas con CAE en «Conciliación»: octubre (mínimo 20)', false,
    (SELECT count(DISTINCT cae) >= 20 FROM cbte WHERE mes = '2026-10'),
    (SELECT count(DISTINCT cae) || ' CAE distintos · ' || count(*) FILTER (WHERE cae IS NULL) || ' filas sin CAE' FROM cbte WHERE mes = '2026-10')
  UNION ALL SELECT 12, 'reportes cerrados de la cuenta (Flex, Luma, Full, comprobantes)', false, true,
    (SELECT coalesce(string_agg(format || ' ' || coalesce(range_from, '?') || '→' || coalesce(range_to, '?'), ' · ' ORDER BY format, range_from), 'ninguno')
     FROM public.pfos_fin_imports WHERE user_id = <ID_CUENTA> AND status IN ('cerrada', 'reemplazando')
       AND format IN ('flex_nc', 'flex_nd', 'luma_viajes', 'luma_viajes_detalle', 'ml_cargos_full', 'comprobantes', 'comprobantes_2026_08'))
  UNION ALL SELECT 13, 'listas de costos y SKU confirmados de la cuenta', false, (SELECT count(*) > 0 FROM public.pfos_cost_lists),
    (SELECT coalesce(string_agg(supplier || ' desde ' || valid_from, ', ' ORDER BY valid_from), 'ninguna') FROM public.pfos_cost_lists) || ' · ' ||
    (SELECT count(DISTINCT seller_sku) FROM public.pfos_cost_sku_map WHERE user_id = <ID_CUENTA>) || ' SKU con decisión'
  UNION ALL SELECT 14, 'PUBLIC no puede leer tablas de PFOS (si pudiera, el rol nuevo también)', true,
    NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
      AND has_table_privilege('public', c.oid, 'SELECT')),
    coalesce((SELECT 'legibles por todos: ' || string_agg(c.relname, ', ') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND has_table_privilege('public', c.oid, 'SELECT')), 'ninguna')
  UNION ALL SELECT 15, 'PUBLIC no puede crear en el esquema public (si pudiera, el rol nuevo también)', true,
    NOT has_schema_privilege('public', 'public', 'CREATE'),
    CASE WHEN has_schema_privilege('public', 'public', 'CREATE')
      THEN 'hoy SÍ puede: hay que revisar con quien administra PFOS qué roles lo usan antes de quitarlo; no se instala hasta resolverlo'
      ELSE 'no puede' END
  UNION ALL SELECT 16, 'todavía no existen el esquema «fiscalos» ni el rol «fiscalos_lectura»', true,
    to_regnamespace('fiscalos') IS NULL AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fiscalos_lectura'),
    CASE WHEN to_regnamespace('fiscalos') IS NOT NULL THEN 'el esquema ya existe · ' ELSE '' END ||
    CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fiscalos_lectura') THEN 'el rol ya existe' ELSE 'libres' END
)
SELECT orden, control,
  CASE WHEN ok THEN 'ok' WHEN bloquea THEN 'BLOQUEA' ELSE 'advertencia' END AS resultado,
  detalle
FROM controles ORDER BY orden;
