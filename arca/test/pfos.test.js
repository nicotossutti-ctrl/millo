// Conexión FiscalOS ← PFOS, de punta a punta sobre Postgres real en memoria (PGlite): las tablas de PFOS con su estructura
// real (pfos-ml, lib/*_store.js), datos INVENTADOS de dos cuentas (la del contribuyente y otra de otro CUIT), el SQL de
// acceso de docs/pfos-acceso.sql y la lectura como el rol de solo lectura. Ningún dato real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fotosDesde } from '../src/pfos/actualizar.js';
import { controlarRol } from '../src/pfos/lectura.js';
import { proponerMapeo, listaParaVenta } from '../src/pfos/costos.js';
import { enArgentina, cargosMes, vigentesConciliacion, coberturaReportes } from '../src/pfos/calculo.js';
import { clavesArca, verificarCuenta } from '../src/pfos/cuenta.js';

let PGlite = null;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch { /* sin PGlite: las pruebas de base se saltean */ }
const conPg = PGlite ? test : test.skip;
const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROPIA = 111; const OTRA = 222; // cuentas de prueba (no son ids reales)

// Estructura de PFOS (solo las tablas que usan las vistas, tal como las crea PFOS).
const DDL = `
CREATE TABLE ml_accounts (user_id BIGINT PRIMARY KEY, nickname TEXT, access_token_enc TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE pfos_money_records (user_id BIGINT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL, scope TEXT NOT NULL, data JSONB NOT NULL, sha TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL, run_id BIGINT, pass_id TEXT, first_seen TIMESTAMPTZ NOT NULL, last_seen TIMESTAMPTZ NOT NULL, missing_since TIMESTAMPTZ,
  order_id TEXT, payment_id TEXT, shipping_id TEXT, pack_id TEXT, item_id TEXT, inventory_id TEXT, doc_id TEXT, kind TEXT, subkind TEXT,
  amount NUMERIC, at TEXT, PRIMARY KEY(user_id, source, key));
CREATE TABLE pfos_money_scopes (user_id BIGINT NOT NULL, source TEXT NOT NULL, scope TEXT NOT NULL, family TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
  pass_id TEXT, cursor TEXT, base INTEGER, received INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0, flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  next_due DATE, last_complete_at TIMESTAMPTZ, last_attempt_at TIMESTAMPTZ, meta JSONB NOT NULL DEFAULT '{}'::jsonb, priority INTEGER NOT NULL DEFAULT 100,
  updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(user_id, source, scope));
CREATE TABLE pfos_hist_ads_daily (user_id BIGINT NOT NULL, day DATE NOT NULL, level TEXT NOT NULL, key TEXT NOT NULL, campaign_id TEXT, ad_group_id TEXT, ad_group_type TEXT,
  item_id TEXT, family_id TEXT, user_product_id TEXT, metrics JSONB NOT NULL, seq INTEGER NOT NULL DEFAULT 0, quality TEXT,
  first_seen TIMESTAMPTZ NOT NULL, read_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(user_id, day, level, key));
CREATE TABLE pfos_fin_imports (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, format TEXT NOT NULL, format_version INTEGER NOT NULL, transport TEXT NOT NULL,
  file_name TEXT, file_sha256 TEXT NOT NULL, header_sha256 TEXT NOT NULL, parts JSONB NOT NULL, freshness_at TEXT, freshness_origin TEXT NOT NULL, freshness_tz TEXT,
  range_from TEXT, range_to TEXT, range_axis TEXT, range_to_exclusive BOOLEAN, range_origin TEXT, batches INTEGER NOT NULL, status TEXT NOT NULL, error TEXT,
  result JSONB, coverage TEXT, coverage_note TEXT, close_token TEXT, created_at TIMESTAMPTZ NOT NULL, closed_at TIMESTAMPTZ, replaces BIGINT);
CREATE TABLE pfos_fin_payloads (user_id BIGINT NOT NULL, sha TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY(user_id, sha));
CREATE TABLE pfos_fin_observations (import_id BIGINT NOT NULL, part INTEGER NOT NULL, row_no INTEGER NOT NULL, batch_no INTEGER NOT NULL, user_id BIGINT NOT NULL, source TEXT NOT NULL,
  data_sha TEXT NOT NULL, identity_key TEXT, identity_status TEXT NOT NULL, reason TEXT, defining_sha TEXT, issues JSONB, PRIMARY KEY(import_id, part, row_no));
CREATE TABLE pfos_cost_lists (id BIGSERIAL PRIMARY KEY, supplier TEXT NOT NULL, valid_from DATE NOT NULL, valid_to DATE, file_name TEXT NOT NULL, file_sha256 TEXT NOT NULL,
  sheet TEXT NOT NULL, discount_file TEXT, discount_sha256 TEXT, cash_pct NUMERIC NOT NULL, items INTEGER NOT NULL, loaded_at TIMESTAMPTZ NOT NULL, content_sha256 TEXT);
CREATE TABLE pfos_cost_items (list_id BIGINT NOT NULL, row_no INTEGER NOT NULL, code TEXT NOT NULL, code_raw TEXT, description TEXT, size_label TEXT, packaging TEXT,
  presentation TEXT NOT NULL, pairs INTEGER, price NUMERIC NOT NULL, price_box NUMERIC, price_suggested NUMERIC, line TEXT,
  discount_pct NUMERIC, discount_source TEXT, factor NUMERIC, notes JSONB NOT NULL DEFAULT '[]'::jsonb, PRIMARY KEY(list_id, row_no));
CREATE TABLE pfos_cost_sku_map (user_id BIGINT NOT NULL, seller_sku TEXT NOT NULL, version INTEGER NOT NULL, valid_from DATE, status TEXT NOT NULL, source TEXT NOT NULL,
  list_id BIGINT, note TEXT, decided_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(user_id, seller_sku, version));
CREATE TABLE pfos_cost_sku_components (user_id BIGINT NOT NULL, seller_sku TEXT NOT NULL, version INTEGER NOT NULL, idx INTEGER NOT NULL, code TEXT NOT NULL, presentation TEXT NOT NULL,
  size_label TEXT, row_no INTEGER, units INTEGER NOT NULL, pairs INTEGER, PRIMARY KEY(user_id, seller_sku, version, idx));
`;

const orden = (id, fecha, status, items, pagos, total) => ({ id, status, date_created: fecha, total_amount: total,
  order_items: items.map(([sku, quantity, unit_price, itemId = 'MLA1']) => ({ item: { id: itemId, seller_sku: sku }, quantity, unit_price })),
  payments: pagos.map((p) => ({ id: p, status: 'approved' })) });
const cargo = (name, type, from, original, refunded = 0) => ({ name, type, accounts: { from, to: 'ml' }, amounts: { original, refunded } });

async function armarBase() {
  const db = new PGlite();
  await db.exec(DDL);
  const ins = (user, source, key, data) => db.query(`INSERT INTO pfos_money_records (user_id, source, key, scope, data, sha, fetched_at, first_seen, last_seen)
    VALUES ($1,$2,$3,'x',$4,'s',now(),now(),now())`, [user, source, key, JSON.stringify(data)]);
  await db.query(`INSERT INTO ml_accounts VALUES ($1,'A','token-secreto',now()), ($2,'B','token-secreto',now())`, [PROPIA, OTRA]);
  // Ventas de la cuenta propia: septiembre (una el 30/09 23:30 de Argentina, que en UTC ya es octubre), una cancelada, una
  // sin costo posible, y una de octubre.
  await ins(PROPIA, 'orders', '1', orden('1', '2026-09-10T15:00:00.000-03:00', 'paid', [['ME23-NEGRO-M-X2', 1, 9000]], ['p1'], 9000));
  await ins(PROPIA, 'orders', '2', orden('2', '2026-09-30T23:30:00.000-03:00', 'paid', [['TE251C', 2, 5000, 'MLA2']], ['p2'], 10000));
  await ins(PROPIA, 'orders', '3', orden('3', '2026-09-12T10:00:00.000-03:00', 'cancelled', [['ME23-NEGRO-M-X2', 5, 9000]], [], 45000));
  await ins(PROPIA, 'orders', '5', orden('5', '2026-09-14T10:00:00.000-03:00', 'paid', [['ZZ99', 1, 1000, 'MLA3']], ['p5'], 1000));
  await ins(PROPIA, 'orders', '4', orden('4', '2026-10-01T00:30:00.000-03:00', 'paid', [['ME23-NEGRO-M-X2', 1, 9000]], ['p4'], 9000));
  // La otra cuenta (otro CUIT): ventas enormes que NO pueden aparecer.
  await ins(OTRA, 'orders', '9', orden('9', '2026-09-11T10:00:00.000-03:00', 'paid', [['ME23-NEGRO-M-X2', 1000, 9000]], ['p9'], 9e6));
  // Cobros de MP: cargos del vendedor (con IVA), una retención (anticipo) y un cargo que paga el comprador (no cuenta).
  await ins(PROPIA, 'mp_payments', 'p1', { id: 'p1', status: 'approved', charges_details: [cargo('meli_percentage_fee', 'fee', 'collector', 1210), cargo('flat_fee', 'fee', 'collector', 121),
    cargo('shipping', 'shipping', 'collector', 605), cargo('iibb', 'tax', 'collector', 50), cargo('financing_fee', 'fee', 'payer', 999)] });
  await ins(PROPIA, 'mp_payments', 'p2', { id: 'p2', status: 'approved', charges_details: [cargo('meli_percentage_fee', 'fee', 'collector', 2420, 242)] });
  await ins(PROPIA, 'mp_payments', 'p5', { id: 'p5', status: 'approved', charges_details: [cargo('meli_percentage_fee', 'fee', 'collector', 121)] });
  await ins(OTRA, 'mp_payments', 'p9', { id: 'p9', status: 'approved', charges_details: [cargo('meli_percentage_fee', 'fee', 'collector', 1e6)] });
  // Devolución recibida en septiembre de la orden 1 (1 unidad).
  await ins(PROPIA, 'claim_returns', 'c1|r1', { id: 'r1', status: 'delivered', date_closed: '2026-09-20T12:00:00.000-03:00', orders: [{ order_id: '1', item_id: 'MLA1', return_quantity: 1 }] });
  // Cobertura de la recolección: los 30 días de septiembre completos para la cuenta propia.
  for (let d = 1; d <= 30; d++) {
    for (const src of ['orders', 'mp_payments']) {
      await db.query(`INSERT INTO pfos_money_scopes (user_id, source, scope, family, status, updated_at) VALUES ($1,$2,$3,'ml','completa',now())`, [PROPIA, src, `hist|2026-09-${String(d).padStart(2, '0')}`]);
    }
    await db.query(`INSERT INTO pfos_hist_ads_daily (user_id, day, level, key, metrics, first_seen, read_at) VALUES ($1,$2,'campaña','c1',$3,now(),now())`,
      [PROPIA, `2026-09-${String(d).padStart(2, '0')}`, JSON.stringify({ cost: 100, clicks: 1, prints: 10 })]);
    await db.query(`INSERT INTO pfos_hist_ads_daily (user_id, day, level, key, metrics, first_seen, read_at) VALUES ($1,$2,'publicación','g|MLA1',$3,now(),now())`,
      [PROPIA, `2026-09-${String(d).padStart(2, '0')}`, JSON.stringify({ cost: 100 })]);
    await db.query(`INSERT INTO pfos_hist_ads_daily (user_id, day, level, key, metrics, first_seen, read_at) VALUES ($1,$2,'campaña','c9',$3,now(),now())`,
      [OTRA, `2026-09-${String(d).padStart(2, '0')}`, JSON.stringify({ cost: 99999 })]);
  }
  // «Conciliación»: bonificaciones Flex del mes completo; Luma solo de la primera quincena; facturas a clientes.
  const imp = async (user, format, desde, hasta, filas) => {
    const { rows: [{ id }] } = await db.query(`INSERT INTO pfos_fin_imports (user_id, format, format_version, transport, file_sha256, header_sha256, parts, freshness_at, freshness_origin,
      range_from, range_to, range_axis, batches, status, created_at) VALUES ($1,$2,1,'navegador',$3,'h','[]','2026-10-20T10:00:00','contenido',$4,$5,'fecha',1,'cerrada',now()) RETURNING id`,
    [user, format, `${format}-${desde}-${user}`, desde, hasta]);
    let n = 0;
    for (const [source, key, data] of filas) {
      n++;
      await db.query('INSERT INTO pfos_fin_payloads VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [user, `${source}-${key}`, JSON.stringify(data)]);
      await db.query(`INSERT INTO pfos_fin_observations VALUES ($1,1,$2,1,$3,$4,$5,$6,'identificada',null,$7,null)`, [id, n, user, source, `${source}-${key}`, key, `def-${key}`]);
    }
  };
  await imp(PROPIA, 'flex_nc', '2026-09-01', '2026-09-30', [['flex_bonificacion', 'b1', { bonificacion: 'b1', fecha: '2026-09-15', valor: '121.00' }]]);
  await imp(PROPIA, 'luma_viajes', '2026-09-01', '2026-09-15', [['flex_viaje', 'v1', { id_viaje: 'v1', fecha_creacion: '2026-09-05T10:00:00', precio: '3000.00' }]]);
  await imp(PROPIA, 'comprobantes', '2026-09-01', '2026-09-30',
    Array.from({ length: 25 }, (_, i) => ['comprobante', `5-${i + 1}`, { punto_venta: '00005', numero: String(i + 1).padStart(8, '0'), cae: `7600000000000${i}`, fecha_emision: '2026-09-15T10:00:00' }]));
  await imp(OTRA, 'comprobantes', '2026-09-01', '2026-09-30', [['comprobante', '9-1', { punto_venta: '00009', numero: '00000001', fecha_emision: '2026-09-15T10:00:00' }]]);
  // Costos: una sola lista, vigente desde el 01/10 (septiembre usa la lista posterior, marcada).
  await db.query(`INSERT INTO pfos_cost_lists (id, supplier, valid_from, file_name, file_sha256, sheet, cash_pct, items, loaded_at) VALUES (1,'SOX','2026-10-01','l.xlsx','x','H',5,2,now())`);
  await db.query(`INSERT INTO pfos_cost_items (list_id, row_no, code, presentation, pairs, price, price_suggested, discount_pct, factor) VALUES
    (1, 10, 'ME23C', 'PAR', 1, 1000, 4000, 25, 0.7125), (1, 11, 'TE251C', 'PAR', 1, 2000, 5000, 30, 0.665)`);
  await db.query(`INSERT INTO pfos_cost_sku_map VALUES ($1,'TE251C',1,null,'confirmado','manual',1,null,now())`, [PROPIA]);
  await db.query(`INSERT INTO pfos_cost_sku_components VALUES ($1,'TE251C',1,0,'TE251C','PAR',null,11,1,1)`, [PROPIA]);
  // El acceso de solo lectura, tal cual el archivo (con la cuenta y una clave de prueba).
  const acceso = fs.readFileSync(path.join(RAIZ, 'docs', 'pfos-acceso.sql'), 'utf8').replace(/<ID_CUENTA>/g, String(PROPIA)).replace(/<CLAVE>/g, 'clave-de-prueba');
  await db.exec(acceso);
  return db;
}

/** Adaptador mínimo: PGlite con la interfaz de pg (query(sql, params) → { rows }). */
const comoPg = (db) => ({ query: (sql, params) => db.query(sql, params) });

function outConArca() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fiscalos-pfos-'));
  const dir = path.join(out, 'datos', 'comprobantes-emitidos');
  fs.mkdirSync(dir, { recursive: true });
  const cab = ['Fecha de Emisión', 'Tipo de Comprobante', 'Punto de Venta', 'Número Desde', 'Número Hasta', 'Cód. Autorización'];
  const filas = Array.from({ length: 25 }, (_, i) => ['2026-09-15', '6', '5', String(i + 1), String(i + 1), `7600000000000${i}`]);
  fs.writeFileSync(path.join(dir, 'mc.csv'), [cab, ...filas].map((f) => f.map((x) => `"${x}"`).join(';')).join('\r\n'));
  fs.writeFileSync(path.join(dir, 'manifiesto.json'), JSON.stringify({ 'emitidos:2026-09-01:2026-09-30': { ok: true, fecha: '2026-10-21', archivo: 'mc.csv' } }));
  return out;
}

conPg('PFOS de punta a punta: solo la cuenta propia, costo con lista posterior, cargos netos, devoluciones y cobertura', async () => {
  const db = await armarBase();
  await db.exec('SET ROLE fiscalos_lectura');
  const [sep, oct] = await fotosDesde(comoPg(db), { meses: ['2026-09', '2026-10'], outDir: outConArca(), cuentaEsperada: String(PROPIA) });
  // Cuenta verificada por identificadores (punto de venta + número / CAE en los emitidos de ARCA).
  assert.equal(sep.cuenta.verificada, true);
  assert.equal(sep.cuenta.encontrados, 25);
  assert.equal(oct.cuenta.verificada, false, 'octubre no tiene emitidos de ARCA para comparar: no se usan sus datos');
  // Ventas: la del 30/09 23:30 es de septiembre; la cancelada aparte; la otra cuenta no existe.
  assert.equal(sep.ventas.ordenes, 3);
  assert.equal(sep.ventas.canceladas, 1);
  assert.equal(sep.ventas.totalConIva, 20000);
  assert.equal(oct.ventas.ordenes, 1);
  // Costo: ME23 x2 automático (2 × 1000 × 0,7125) + TE251C confirmado (2 × 2000 × 0,665); ZZ99 sin costo; lista posterior.
  assert.equal(sep.costo.total, 1425 + 2660);
  assert.equal(sep.costo.unidades, 4);
  assert.equal(sep.costo.unidadesConCosto, 3);
  assert.equal(sep.costo.unidadesListaPosterior, 3);
  assert.equal(sep.costo.unidadesAutomaticas, 1);
  assert.deepEqual(sep.costo.sinCosto.map((x) => x.sku), ['ZZ99']);
  // Devolución recibida en septiembre: resta el costo de 1 unidad de la orden 1.
  assert.equal(sep.costo.devoluciones.total, 1425);
  const cmv = sep.lineas['costo-mercaderia'];
  assert.equal(cmv.importe, 2660);
  assert.equal(cmv.nivel, 'estimado');
  assert.equal(cmv.completo, false, '75 % de unidades con costo: no alcanza');
  assert.match(cmv.faltan.join(' '), /75 %/);
  // Cargos del vendedor con IVA, netos de lo devuelto; retención aparte; el cargo del comprador no cuenta.
  assert.equal(sep.cargos.comision, 1210 + 121 + (2420 - 242) + 121);
  assert.equal(sep.cargos.envio, 605);
  assert.equal(sep.cargos.retencion, 50);
  assert.equal(sep.lineas['comisiones-ml'].importe, Math.round((3630 / 1.21) * 100) / 100);
  assert.equal(sep.lineas['comisiones-ml'].completo, true);
  // Publicidad: nivel campaña de la cuenta propia, 30 días.
  assert.equal(sep.lineas.publicidad.importe, 3000);
  assert.equal(sep.lineas.publicidad.completo, true);
  // Logística: Luma solo cubre la primera quincena y no hay reporte de Full: incompleta, dicho.
  assert.equal(sep.lineas.logistica.completo, false);
  assert.match(sep.lineas.logistica.faltan.join(' '), /viajes de Luma: reporte que no cubre todo el mes/);
  assert.match(sep.lineas.logistica.faltan.join(' '), /cargos de Full: sin reporte/);
  assert.equal(sep.reportes.bonificacionFlex.total, 121);
  assert.equal(sep.reportes.cadete.total, 3000);
});

conPg('el rol se controla antes de leer: dueño o con acceso directo a tablas de PFOS, no', async () => {
  const db = await armarBase();
  await assert.rejects(controlarRol(comoPg(db)), /permisos de más|dueño/, 'la conexión del dueño (superusuario) no se acepta');
  await db.exec(`CREATE ROLE de_mas LOGIN NOSUPERUSER; GRANT USAGE ON SCHEMA fiscalos TO de_mas; GRANT SELECT ON ALL TABLES IN SCHEMA fiscalos TO de_mas;
    GRANT SELECT ON public.ml_accounts TO de_mas; SET ROLE de_mas`);
  await assert.rejects(controlarRol(comoPg(db)), /puede leer tablas de PFOS directamente \(ml_accounts\)/);
  await db.exec(`RESET ROLE; CREATE ROLE escribe LOGIN NOSUPERUSER; GRANT USAGE ON SCHEMA fiscalos TO escribe; GRANT SELECT ON ALL TABLES IN SCHEMA fiscalos TO escribe;
    GRANT INSERT ON public.pfos_money_records TO escribe; SET ROLE escribe`);
  await assert.rejects(controlarRol(comoPg(db)), /puede escribir/);
  await db.exec('RESET ROLE; SET ROLE fiscalos_lectura');
  assert.equal(await controlarRol(comoPg(db)), 'fiscalos_lectura');
  await assert.rejects(db.query("INSERT INTO fiscalos.ordenes VALUES (1,'x','{}','s',now())"), /read-only|permission denied|cannot insert/);
});

test('piezas: fecha argentina, propuesta de SKU, lista posterior, cargos por pago, conciliación y cobertura de reportes', () => {
  assert.deepEqual(enArgentina('2026-09-30T23:30:00.000-03:00'), { dia: '2026-09-30', mes: '2026-09' });
  assert.deepEqual(enArgentina('2026-10-01T02:30:00Z'), { dia: '2026-09-30', mes: '2026-09' });
  const items = [{ row: 1, code: 'ME23C', presentation: 'PAR', price: 1000, price_suggested: 4000, factor: 0.7 }];
  assert.equal(proponerMapeo({ sku: 'ME23-NEGRO-M-X2', unitPrice: 9000 }, items).components[0].units, 2);
  assert.equal(proponerMapeo({ sku: 'ME23-NEGRO-M-X2', unitPrice: 100 }, items).estado, 'dudoso', 'precio que no cierra con 2 pares');
  assert.deepEqual(listaParaVenta([{ id: '1', valid_from: '2026-10-01' }], '2026-09-15').posterior, true);
  // Un pago que cubre dos órdenes del paquete se cuenta una vez.
  const ord = [{ data: { payments: [{ id: 'p', status: 'approved' }] } }, { data: { payments: [{ id: 'p', status: 'approved' }] } }];
  const c = cargosMes(ord, new Map([['p', { status: 'approved', charges_details: [cargo('meli_percentage_fee', 'fee', 'collector', 100)] }]]));
  assert.equal(c.comision, 100); assert.equal(c.cobertura, 100);
  // Conciliación: dos versiones ordenables por frescura → la más nueva; identidad repetida → pendiente (afuera).
  const f = (key, sha, fr, st = 'identificada', def = 'd') => ({ source: 'full_cargo', identity_key: key, identity_status: st, data_sha: sha, defining_sha: def, import_status: 'cerrada', freshness_at: fr, freshness_origin: 'contenido', data: { monto: sha } });
  const v = vigentesConciliacion([f('a', '1', '2026-10-01'), f('a', '2', '2026-10-05'), f('b', '3', '2026-10-01', 'pendiente'), { ...f('c', '4', null), import_status: 'abierta' }]);
  assert.deepEqual(v.porFuente.full_cargo, [{ monto: '2' }]);
  assert.equal(v.pendientes.full_cargo, 1);
  // Cobertura de reportes por rango declarado: dos quincenas seguidas cubren el mes.
  const imps = [{ format: 'luma_viajes', status: 'cerrada', range_from: '2026-09-01', range_to: '2026-09-15' }, { format: 'luma_viajes', status: 'cerrada', range_from: '2026-09-16', range_to: '2026-09-30' }];
  assert.equal(coberturaReportes(imps, ['luma_viajes'], '2026-09').estado, 'completa');
  assert.equal(coberturaReportes(imps.slice(0, 1), ['luma_viajes'], '2026-09').estado, 'parcial');
  // Cuenta: sin coincidencias suficientes, no se verifica.
  const arca = clavesArca(['"Fecha de Emisión";"Tipo de Comprobante";"Punto de Venta";"Número Desde";"Número Hasta"\r\n"2026-09-01";"6";"5";"1";"30"']);
  assert.equal(verificarCuenta(Array.from({ length: 30 }, (_, i) => ({ pv: 5, numero: i + 1 })), arca).verificada, true);
  assert.equal(verificarCuenta(Array.from({ length: 30 }, (_, i) => ({ pv: 9, numero: i + 1 })), arca).verificada, false);
});
