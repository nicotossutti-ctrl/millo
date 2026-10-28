/**
 * Lectura de la base de PFOS. SOLO LECTURA y SOLO las vistas del esquema «fiscalos» (docs/pfos-acceso.sql), que ya
 * vienen filtradas por la cuenta del contribuyente.
 *
 * Antes de leer un solo dato, controlarRol() exige que la conexión sea de un rol mínimo y se NIEGA a seguir si:
 *  - el rol es superusuario, puede crear roles o bases, replicar o saltear la seguridad por filas;
 *  - es miembro de otro rol (p. ej. neon_superuser, pg_read_all_data): heredaría permisos;
 *  - es dueño de alguna tabla o vista (sería la credencial del dueño);
 *  - puede escribir (INSERT/UPDATE/DELETE/TRUNCATE) en cualquier tabla o vista;
 *  - puede crear objetos: esquemas en la base o tablas, vistas o funciones en algún esquema;
 *  - puede leer directamente alguna tabla de PFOS (en «public»): solo tiene que ver las vistas;
 *  - le falta alguna vista.
 * Además, la sesión se pone en «solo lectura» y cada fila leída tiene que ser de la cuenta configurada.
 */

// Las vistas que FiscalOS lee (lo fiscal). Las demás del esquema (Ads, costos, devoluciones) quedan instaladas sin uso
// hasta simplificar el acceso cuando PFOS exponga sus resultados consolidados.
export const VISTAS = ['ordenes', 'cobros_mp', 'facturas_clientes', 'cobertura', 'conciliacion'];
const CON_CUENTA = VISTAS;

/**
 * Cadena de conexión desde arca\.env. Preferido: FISCALOS_PFOS_HOST + FISCALOS_PFOS_BASE + FISCALOS_PFOS_CLAVE (la arma
 * FiscalOS, con el usuario fijo fiscalos_lectura y la clave codificada para URL). Alternativa: FISCALOS_PFOS_URL completa.
 * El usuario de la URL tiene que ser fiscalos_lectura: nunca el dueño.
 */
export function urlDesdeEntorno(env = process.env) {
  if (env.FISCALOS_PFOS_HOST && env.FISCALOS_PFOS_BASE && env.FISCALOS_PFOS_CLAVE) {
    return `postgresql://fiscalos_lectura:${encodeURIComponent(env.FISCALOS_PFOS_CLAVE)}@${env.FISCALOS_PFOS_HOST}/${encodeURIComponent(env.FISCALOS_PFOS_BASE)}?sslmode=require`;
  }
  if (env.FISCALOS_PFOS_URL) {
    const u = new URL(env.FISCALOS_PFOS_URL);
    if (decodeURIComponent(u.username) !== 'fiscalos_lectura') throw new Error(`FISCALOS_PFOS_URL usa el usuario «${decodeURIComponent(u.username)}»: tiene que ser fiscalos_lectura (nunca el dueño de la base)`);
    return env.FISCALOS_PFOS_URL;
  }
  return null;
}

/** Abre la conexión (cliente pg). La cadena sale de arca\.env, nunca del repositorio. */
export async function conectar(url = urlDesdeEntorno()) {
  if (!url) throw new Error('falta la conexión con PFOS en arca\\.env: FISCALOS_PFOS_HOST y FISCALOS_PFOS_BASE (con la clave de «fiscalos.ps1 pfos-clave»), o FISCALOS_PFOS_URL');
  let pg;
  try { pg = (await import('pg')).default; } catch { throw new Error('falta el módulo pg: corré fiscalos.ps1 actualizar'); }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15000, statement_timeout: 60000, application_name: 'fiscalos' });
  await client.connect();
  return client;
}

const q = async (db, sql, params = []) => (await db.query(sql, params)).rows;

/** Controles de seguridad del rol. Lanza un error explicativo si algo sobra. Devuelve el nombre del rol. */
export async function controlarRol(db) {
  const [rol] = await q(db, `SELECT current_user AS nombre, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
    FROM pg_roles WHERE rolname = current_user`);
  if (!rol) throw new Error('no se pudo leer el rol de la conexión');
  const sobra = ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls'].filter((k) => rol[k]);
  if (sobra.length) throw new Error(`el rol ${rol.nombre} tiene permisos de más (${sobra.join(', ')}): usá el rol de solo lectura de docs/pfos-acceso.sql`);
  const miembros = await q(db, `SELECT r.rolname FROM pg_roles r WHERE r.rolname <> current_user AND pg_has_role(current_user, r.oid, 'MEMBER')`);
  if (miembros.length) throw new Error(`el rol ${rol.nombre} hereda permisos de ${miembros.map((m) => m.rolname).join(', ')} (¿se creó desde la consola de Neon?): crealo con docs/pfos-acceso.sql`);
  const [{ propias }] = await q(db, `SELECT count(*)::int AS propias FROM pg_class c WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`);
  if (propias) throw new Error(`el rol ${rol.nombre} es dueño de ${propias} objeto(s) de la base: nunca se usa la credencial del dueño`);
  const escritura = await q(db, `SELECT n.nspname || '.' || c.relname AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))
    LIMIT 5`);
  if (escritura.length) throw new Error(`el rol ${rol.nombre} puede escribir en ${escritura.map((e) => e.rel).join(', ')}: tiene que ser solo de lectura`);
  const crea = await q(db, `SELECT n.nspname FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast%'
    AND has_schema_privilege(n.oid, 'CREATE')`);
  if (crea.length) throw new Error(`el rol ${rol.nombre} puede crear objetos en ${crea.map((c) => c.nspname).join(', ')}: tiene que poder solo leer`);
  const [{ base }] = await q(db, `SELECT has_database_privilege(current_database(), 'CREATE') AS base`);
  if (base) throw new Error(`el rol ${rol.nombre} puede crear esquemas en la base: tiene que poder solo leer`);
  const directas = await q(db, `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') AND has_table_privilege(c.oid, 'SELECT') LIMIT 5`);
  if (directas.length) throw new Error(`el rol ${rol.nombre} puede leer tablas de PFOS directamente (${directas.map((d) => d.relname).join(', ')}): solo tiene que ver las vistas de «fiscalos»`);
  const faltan = [];
  for (const v of VISTAS) {
    const [{ ok }] = await q(db, `SELECT to_regclass($1) IS NOT NULL AND has_table_privilege(to_regclass($1), 'SELECT') AS ok`, [`fiscalos.${v}`]);
    if (!ok) faltan.push(v);
  }
  if (faltan.length) throw new Error(`faltan vistas o permisos de lectura en «fiscalos»: ${faltan.join(', ')} (correr docs/pfos-acceso.sql)`);
  await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  const [{ transaction_read_only: ro }] = await q(db, 'SHOW transaction_read_only');
  if (ro !== 'on') throw new Error('no se pudo poner la sesión en solo lectura');
  return rol.nombre;
}

/** Comprueba que todas las vistas con cuenta tengan UNA sola cuenta y que sea la configurada (obligatoria). Devuelve el user_id. */
export async function controlarCuenta(db, esperada) {
  if (!/^\d{6,12}$/.test(String(esperada ?? ''))) throw new Error('falta FISCALOS_PFOS_CUENTA (el user_id de Mercado Libre de la cuenta de tu CUIT): sin ella no se lee nada');
  const cuentas = new Set();
  for (const v of CON_CUENTA) for (const r of await q(db, `SELECT DISTINCT user_id::text AS u FROM fiscalos.${v}`)) cuentas.add(r.u);
  if (cuentas.size > 1) throw new Error(`las vistas de «fiscalos» devuelven ${cuentas.size} cuentas: tienen que filtrar una sola (revisar docs/pfos-acceso.sql)`);
  const [cuenta] = [...cuentas];
  if (cuenta && cuenta !== String(esperada)) throw new Error(`las vistas son de la cuenta ${cuenta} y FiscalOS espera ${esperada} (FISCALOS_PFOS_CUENTA)`);
  if (!cuenta) throw new Error('las vistas de «fiscalos» no devuelven datos de ninguna cuenta');
  return cuenta;
}

const limites = (mes) => {
  const [y, m] = mes.split('-').map(Number);
  const sig = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [`${mes}-01T00:00:00-03:00`, `${sig}-01T00:00:00-03:00`];
};
// Fecha de un campo JSON como timestamptz, o NULL si no tiene forma de fecha (un dato tapado no corta la consulta).
const ts = (campo) => `(CASE WHEN ${campo} ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN (${campo})::timestamptz END)`;
const lotes = (xs, n = 1000) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const json = (x) => (typeof x === 'string' ? JSON.parse(x) : x);

/** Lee lo fiscal de un mes. Solo SELECT sobre las vistas de «fiscalos». */
export async function leerMes(db, mes) {
  const [desde, hasta] = limites(mes);
  const ordenes = (await q(db, `SELECT key, data FROM fiscalos.ordenes
    WHERE ${ts("data->>'date_created'")} >= $1::timestamptz AND ${ts("data->>'date_created'")} < $2::timestamptz`, [desde, hasta]))
    .map((r) => ({ key: r.key, data: json(r.data) }));
  const idsPago = [...new Set(ordenes.flatMap((o) => (o.data.payments ?? []).map((p) => String(p.id))))];
  const cobros = new Map();
  for (const l of lotes(idsPago)) for (const r of await q(db, 'SELECT key, data FROM fiscalos.cobros_mp WHERE key = ANY($1)', [l])) cobros.set(String(r.key), json(r.data));
  const facturas = (await q(db, `SELECT data FROM fiscalos.facturas_clientes
    WHERE ${ts("data->>'issued_date'")} >= $1::timestamptz AND ${ts("data->>'issued_date'")} < $2::timestamptz`, [desde, hasta])).map((r) => json(r.data));
  const alcances = await q(db, `SELECT source, scope, status FROM fiscalos.cobertura WHERE scope LIKE $1`, [`hist|${mes}-%`]);
  // Facturas a clientes del reporte de «Conciliación» (con su CAE), por fecha de emisión. Se trae ±1 mes para no partir versiones.
  const conciliacion = (await q(db, `SELECT source, identity_key, identity_status, data_sha, defining_sha, import_status, freshness_at, freshness_origin, data
    FROM fiscalos.conciliacion WHERE import_status IN ('cerrada','reemplazando') AND source = 'comprobante'
      AND data->>'fecha_emision' >= $1 AND data->>'fecha_emision' < $2`,
  [`${mes}-01`, `${hasta.slice(0, 7)}-01`])).map((r) => ({ ...r, data: json(r.data) }));
  return { mes, ordenes, cobros, facturas, alcances, conciliacion };
}
