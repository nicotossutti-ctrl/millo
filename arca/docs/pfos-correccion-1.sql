-- FiscalOS ← PFOS: CORRECCIÓN PUNTUAL 1. No reinstala nada: reemplaza dos vistas del esquema «fiscalos».
--   a) fiscalos.ads_diario: la publicidad (Mercado Ads) volvía vacía.
--   b) fiscalos.costos_items: suma la descripción del artículo de la lista de costos (para reconocer las manguitas y
--      pantorrilleras «A CONFIRMAR», que van por par según la regla de PFOS).
--
-- Qué pasó: al pegar docs/pfos-acceso.sql en el SQL Editor, la «ñ» de 'campaña' llegó con otra codificación y la vista
-- quedó filtrando level = 'campaÃ±a'. Ninguna fila de PFOS tiene ese nivel, así que la vista devolvía 0 filas y la
-- publicidad se leía mal. Esta corrección escribe la ñ con su código Unicode (U&'campa\00F1a' = 'campaña'): el SQL solo
-- tiene caracteres ASCII y no depende de la codificación del archivo ni del editor.
--
-- Qué hace: reemplaza SOLO esas dos vistas. Ads, con las mismas columnas, el mismo filtro por cuenta y security_barrier;
-- costos_items, con las mismas columnas más dos al final (descripción y código como figura en la lista). Los permisos de
-- fiscalos_lectura sobre las vistas se conservan (CREATE OR REPLACE no los toca). No modifica ninguna tabla de PFOS ni
-- ningún otro objeto. Si la cuenta escrita no es la misma de las otras vistas (fiscalos.ordenes), se frena sin cambiar nada.
--
-- Cómo: en Neon, proyecto de PFOS Mercado Libre (NO «PFOS TASKS»), SQL Editor, conectado como dueño (el mismo usuario con
-- el que se corrió pfos-acceso.sql). Reemplazar <ID_CUENTA> (en todo el archivo) por el user_id de PALERMO FITNESS y correr el
-- bloque 1. Después, las consultas del bloque 2 (solo lectura) para comprobar el resultado.

-- ── 1. Corrección ────────────────────────────────────────────────────────────────────────────────────────────────────
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fiscalos.ordenes) OR EXISTS (SELECT 1 FROM fiscalos.ordenes WHERE user_id <> <ID_CUENTA>) THEN
    RAISE EXCEPTION 'la cuenta escrita no es la de las vistas de fiscalos (fiscalos.ordenes): no se cambio nada';
  END IF;
END $$;

CREATE OR REPLACE VIEW fiscalos.ads_diario WITH (security_barrier = true) AS
  SELECT user_id, day, level, key, campaign_id, metrics, quality FROM public.pfos_hist_ads_daily
  WHERE user_id = <ID_CUENTA> AND level = U&'campa\00F1a';

CREATE OR REPLACE VIEW fiscalos.costos_items WITH (security_barrier = true) AS
  SELECT list_id, row_no, code, size_label, presentation, pairs, price, price_suggested, discount_pct, factor, description, code_raw
  FROM public.pfos_cost_items;

COMMIT;

-- ── 2. Comprobación (solo lectura, como dueño) ────────────────────────────────────────────────────────────────────────
-- a) La definición guardada: tiene que decir level = 'campaña' (bien escrito).
--      SELECT pg_get_viewdef('fiscalos.ads_diario'::regclass, true);
-- b) Días y filas por mes que ahora devuelve la vista (septiembre: 30 días si PFOS los tiene; octubre: hasta ayer):
--      SELECT to_char(day, 'YYYY-MM') AS mes, count(DISTINCT day) AS dias, count(*) AS filas,
--             round(sum((metrics->>'cost')::numeric), 2) AS inversion
--      FROM fiscalos.ads_diario WHERE day >= DATE '2026-09-01' GROUP BY 1 ORDER BY 1;
-- c) El rol de FiscalOS sigue pudiendo leer las dos vistas (true, true) y nada más (false, false, false):
--      SELECT has_table_privilege('fiscalos_lectura', 'fiscalos.ads_diario', 'SELECT'),
--             has_table_privilege('fiscalos_lectura', 'fiscalos.costos_items', 'SELECT'),
--             has_table_privilege('fiscalos_lectura', 'fiscalos.ads_diario', 'INSERT'),
--             has_table_privilege('fiscalos_lectura', 'public.pfos_hist_ads_daily', 'SELECT'),
--             has_table_privilege('fiscalos_lectura', 'public.pfos_cost_items', 'SELECT');
-- d) Artículos de la lista que figuran «A CONFIRMAR», con su descripción:
--      SELECT code, presentation, description FROM fiscalos.costos_items WHERE presentation = 'A_CONFIRMAR' ORDER BY code;
--
-- Si b) devuelve 0 filas, mirar qué niveles tiene PFOS para la cuenta (el texto y sus bytes; «campaña» es 63616d7061c3b161):
--      SELECT level, encode(convert_to(level, 'UTF8'), 'hex') AS bytes, count(*) FROM public.pfos_hist_ads_daily
--      WHERE user_id = <ID_CUENTA> GROUP BY 1, 2 ORDER BY 3 DESC;
--
-- Volver atrás: no hace falta (la vista de Ads anterior no devolvía filas y las columnas nuevas de costos_items no cambian
-- nada para quien no las usa). FiscalOS funciona igual sin la parte b): esas filas quedan «para revisión».
