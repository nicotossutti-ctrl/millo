// Conexión FiscalOS ← PFOS, de punta a punta sobre Postgres real en memoria (PGlite): las tablas de PFOS con su estructura
// real (pfos-ml, lib/*_store.js), datos INVENTADOS de dos cuentas (la del contribuyente y otra de otro CUIT), el SQL de
// acceso de docs/pfos-acceso.sql y la lectura como el rol de solo lectura. Ningún dato real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fotosDesde } from '../src/pfos/actualizar.js';
import { controlarRol } from '../src/pfos/lectura.js';
import { proponerMapeo, listaParaVenta, costoLinea } from '../src/pfos/costos.js';
import { enArgentina, cargosMes, vigentesConciliacion, coberturaReportes, corteDelMes, diasCubiertos, adsMes, viajesSinDuplicar, logisticaReportesMes } from '../src/pfos/calculo.js';
import { clavesArca, verificarCuenta, titularidad } from '../src/pfos/cuenta.js';
import { compararAlCorte } from '../src/pfos/comparar.js';
import { armarMes } from '../src/pfos/mes.js';
import { dirFotos } from '../src/pfos/fotos.js';
import { obtenerPfos, integraciones } from '../src/app/integraciones.js';
import { resultadoOperativo } from '../src/app/rentabilidad.js';
import { verificadorScram, generarClave, scramClaves } from '../src/pfos/clave.js';
import { controlarConfiguracion } from '../src/pfos/actualizar.js';
import { urlDesdeEntorno } from '../src/pfos/lectura.js';

let PGlite = null;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch { /* sin PGlite: las pruebas de base se saltean */ }
const conPg = PGlite ? test : test.skip;
const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROPIA = 111111; const OTRA = 222222; // cuentas de prueba (no son ids reales)
// Fecha fija de generación de las fotos (no el reloj real): octubre queda «en curso», con corte el 26/10.
const GENERADO = '2026-10-27T15:00:00-03:00';

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
      range_from, range_to, range_axis, batches, status, coverage, created_at) VALUES ($1,$2,1,'navegador',$3,'h','[]','2026-10-20T10:00:00','contenido',$4,$5,'fecha',1,'cerrada','completa',now()) RETURNING id`,
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
  const acceso = fs.readFileSync(path.join(RAIZ, 'docs', 'pfos-acceso.sql'), 'utf8').replace(/<ID_CUENTA>/g, String(PROPIA)).replace(/<VERIFICADOR>/g, verificadorScram('clave-de-prueba'));
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
  const [sep, oct] = await fotosDesde(comoPg(db), { meses: ['2026-09', '2026-10'], outDir: outConArca(), cuentaEsperada: String(PROPIA), generado: GENERADO });
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
  assert.deepEqual(sep.costo.motivos, { 'código fuera de la lista': 1 });
  // Devolución recibida en septiembre: resta el costo de 1 unidad de la orden 1.
  assert.equal(sep.costo.devoluciones.total, 1425);
  const cmv = sep.lineas['costo-mercaderia'];
  // Lo que no tiene costo (ZZ99, 1 u. a $ 1.000) no es cero: sus ventas × la relación costo/venta de lo costeado (4085 / 19000).
  assert.equal(cmv.conocido, 4085);
  assert.equal(cmv.estimadoFaltante, 215);
  assert.equal(cmv.importe, 4085 + 215 - 1425);
  assert.match(cmv.nota, /215 ESTIMADO para 1 unidad/);
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
  const imps = [{ format: 'luma_viajes', status: 'cerrada', coverage: 'completa', range_from: '2026-09-01', range_to: '2026-09-15' }, { format: 'luma_viajes', status: 'cerrada', coverage: 'completa', range_from: '2026-09-16', range_to: '2026-09-30' }];
  assert.equal(coberturaReportes(imps, ['luma_viajes'], '2026-09').estado, 'completa');
  assert.equal(coberturaReportes(imps.slice(0, 1), ['luma_viajes'], '2026-09').estado, 'parcial');
});

test('titularidad por CAE: punto de venta + número solos nunca validan; CAE con otro número tampoco', () => {
  const cab = '"Fecha de Emisión";"Tipo de Comprobante";"Punto de Venta";"Número Desde";"Número Hasta";"Cód. Autorización"';
  const filas = Array.from({ length: 30 }, (_, i) => `"2026-09-01";"6";"5";"${i + 1}";"${i + 1}";"7600000000${String(i).padStart(4, '0')}"`);
  const arca = clavesArca([[cab, ...filas].join('\r\n')]);
  const cae = (i) => `7600000000${String(i).padStart(4, '0')}`;
  // Mismo punto de venta y número que tus emitidos, pero sin CAE: puede ser otro CUIT con la misma numeración.
  const sinCae = verificarCuenta(Array.from({ length: 30 }, (_, i) => ({ pv: 5, numero: i + 1 })), arca);
  assert.equal(sinCae.verificada, false);
  assert.equal(sinCae.soloNumeroEnArca, 30);
  assert.match(sinCae.motivo, /solos no alcanzan/);
  // CAE de tus emitidos con el mismo número: verificada.
  const ok = verificarCuenta(Array.from({ length: 30 }, (_, i) => ({ pv: 5, numero: i + 1, cae: cae(i) })), arca);
  assert.equal(ok.verificada, true); assert.equal(ok.encontrados, 30);
  // CAE que existe pero atado a otro número: no cuenta como coincidencia.
  assert.equal(verificarCuenta(Array.from({ length: 30 }, (_, i) => ({ pv: 9, numero: i + 1, cae: cae(i) })), arca).verificada, false);
  // Una factura con 30 productos (30 filas, el mismo CAE) es UNA factura: no alcanza el mínimo.
  const una = verificarCuenta(Array.from({ length: 30 }, () => ({ pv: 5, numero: 1, cae: cae(0) })), arca);
  assert.equal(una.comparados, 1); assert.equal(una.filas, 30); assert.equal(una.verificada, false);
  assert.match(una.motivo, /1 factura\(s\) distinta/);
  // Un CAE que aparece con dos números distintos no coincide.
  const doble = verificarCuenta([...Array.from({ length: 25 }, (_, i) => ({ pv: 5, numero: i + 1, cae: cae(i) })), { pv: 5, numero: 2, cae: cae(0) }], arca);
  assert.equal(doble.comparados, 25); assert.equal(doble.encontrados, 24);
  // Pocos CAE: no alcanza aunque coincidan todos.
  assert.equal(verificarCuenta(Array.from({ length: 5 }, (_, i) => ({ pv: 5, numero: i + 1, cae: cae(i) })), arca).verificada, false);
});

test('configuración: la cuenta es obligatoria y no puede ser una excluida; la URL no puede ser del dueño', () => {
  assert.throws(() => controlarConfiguracion(undefined), /falta FISCALOS_PFOS_CUENTA/);
  assert.throws(() => controlarConfiguracion('abc'), /falta FISCALOS_PFOS_CUENTA/);
  assert.throws(() => controlarConfiguracion('222222', ['222222']), /otro CUIT/);
  assert.doesNotThrow(() => controlarConfiguracion('111111', ['222222']));
  assert.throws(() => urlDesdeEntorno({ FISCALOS_PFOS_URL: 'postgresql://neondb_owner:x@h/db' }), /tiene que ser fiscalos_lectura/);
  const u = urlDesdeEntorno({ FISCALOS_PFOS_HOST: 'ep-x.aws.neon.tech', FISCALOS_PFOS_BASE: 'neondb', FISCALOS_PFOS_CLAVE: 'a/b@c:d' });
  assert.equal(new URL(u).username, 'fiscalos_lectura');
  assert.equal(decodeURIComponent(new URL(u).password), 'a/b@c:d', 'la clave se codifica para la URL');
});

test('clave: aleatoria criptográfica y verificador SCRAM-SHA-256 correcto (vector del RFC 7677)', () => {
  const c = generarClave();
  assert.match(c, /^[0-9a-f]{64}$/);
  assert.notEqual(c, generarClave());
  // RFC 7677: usuario «user», clave «pencil», sal y 4096 iteraciones; la prueba del cliente y la firma del servidor.
  const { claveCliente, claveGuardada, claveServidor } = scramClaves('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'), 4096);
  const auth = 'n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
  const hmac = (k, m) => crypto.createHmac('sha256', k).update(m).digest();
  const firmaCliente = hmac(claveGuardada, auth);
  const prueba = Buffer.from(claveCliente.map((b, i) => b ^ firmaCliente[i]));
  assert.equal(prueba.toString('base64'), 'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=');
  assert.equal(hmac(claveServidor, auth).toString('base64'), '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
  assert.match(verificadorScram(c), /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
});

conPg('comprobación previa: una sola consulta de lectura; separa lo que bloquea de las advertencias de datos', async () => {
  const db = await armarBase();
  // Base de PFOS con la estructura pero sin datos ni acceso: las faltas de datos son advertencias, nada bloquea.
  const limpia = new PGlite(); await limpia.exec(DDL);
  await limpia.query(`INSERT INTO ml_accounts VALUES ($1,'A','t',now()), ($2,'B','t',now())`, [PROPIA, OTRA]);
  const sql = fs.readFileSync(path.join(RAIZ, 'docs', 'pfos-comprobacion.sql'), 'utf8').replace(/<ID_CUENTA>/g, String(PROPIA)).replace(/<ID_EXCLUIDA>/g, String(OTRA));
  const sinComentarios = sql.replace(/--.*$/gm, '').trim();
  assert.match(sinComentarios, /^WITH\b/, 'es una consulta (WITH … SELECT)');
  assert.equal(sinComentarios.replace(/'[^']*'/g, '').split(';').filter((x) => x.trim()).length, 1, 'una sola sentencia');
  const { rows } = await limpia.query(sql);
  const por = Object.fromEntries(rows.map((r) => [r.orden, r]));
  assert.equal(rows.length, 16);
  assert.ok(!rows.some((r) => r.resultado === 'BLOQUEA'), JSON.stringify(rows.filter((r) => r.resultado === 'BLOQUEA')));
  for (const n of [6, 7, 10, 11, 13]) assert.equal(por[n].resultado, 'advertencia', `${por[n].control}: ${por[n].detalle}`);
  // Con datos y el acceso ya instalado: septiembre con 25 CAE distintos (ok), octubre sin CAE (advertencia), y el
  // esquema/rol ya existentes BLOQUEAN una segunda instalación.
  const { rows: r2 } = await db.query(sql);
  const p2 = Object.fromEntries(r2.map((r) => [r.orden, r]));
  assert.match(p2[6].detalle, /^4 \/ 1 órdenes/, 'las 4 de septiembre (con la cancelada) y 1 de octubre, solo de la cuenta');
  assert.equal(p2[10].resultado, 'ok'); assert.match(p2[10].detalle, /^25 CAE distintos/);
  assert.equal(p2[11].resultado, 'advertencia'); assert.match(p2[11].detalle, /^0 CAE distintos/);
  assert.equal(p2[16].resultado, 'BLOQUEA');
  // CAE repetidos en varias filas cuentan una vez.
  await db.exec('RESET ROLE');
  await db.query(`INSERT INTO pfos_fin_payloads VALUES ($1,'rep','{"punto_venta":"5","numero":"999","cae":"76999","fecha_emision":"2026-10-02T10:00:00"}')`, [PROPIA]);
  const { rows: [{ id }] } = await db.query(`SELECT id FROM pfos_fin_imports WHERE user_id = $1 AND format = 'comprobantes'`, [PROPIA]);
  for (let k = 0; k < 30; k++) await db.query(`INSERT INTO pfos_fin_observations VALUES ($1,9,$2,1,$3,'comprobante','rep','5-999','identificada',null,'d',null)`, [id, k, PROPIA]);
  const { rows: r3 } = await db.query(sql);
  assert.match(r3.find((r) => r.orden === 11).detalle, /^1 CAE distintos/);
  assert.equal(r3.find((r) => r.orden === 11).resultado, 'advertencia');
  // PUBLIC con CREATE en el esquema public: BLOQUEA (se revisa antes; el SQL de acceso ya no lo cambia solo).
  await limpia.exec('GRANT CREATE ON SCHEMA public TO PUBLIC');
  const { rows: r4 } = await limpia.query(sql);
  assert.equal(r4.find((r) => r.orden === 15).resultado, 'BLOQUEA');
  assert.match(r4.find((r) => r.orden === 15).detalle, /revisar/);
  // Una base equivocada (sin las tablas de PFOS) no pasa: la consulta falla al no encontrarlas.
  await assert.rejects(new PGlite().query(sql), /pfos_money_records|does not exist/);
  // El SQL de acceso no toca permisos globales de la base.
  const acceso = fs.readFileSync(path.join(RAIZ, 'docs', 'pfos-acceso.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.doesNotMatch(acceso, /ON SCHEMA public/i);
});

conPg('el rol no puede crear objetos: con CREATE en un esquema, FiscalOS no lee', async () => {
  const db = await armarBase();
  await db.exec(`CREATE ROLE crea LOGIN NOSUPERUSER; GRANT USAGE ON SCHEMA fiscalos TO crea; GRANT SELECT ON ALL TABLES IN SCHEMA fiscalos TO crea;
    GRANT CREATE ON SCHEMA fiscalos TO crea; SET ROLE crea`);
  await assert.rejects(controlarRol(comoPg(db)), /puede crear objetos en fiscalos/);
  // Crear esquemas en la base (PGlite no permite otorgarlo): conexión simulada con todo en orden salvo eso.
  const fake = { query: async (sql) => ({ rows: /FROM pg_roles WHERE rolname = current_user/.test(sql) ? [{ nombre: 'x', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false }]
    : /AS propias/.test(sql) ? [{ propias: 0 }] : /has_database_privilege/.test(sql) ? [{ base: true }] : [] }) };
  await assert.rejects(controlarRol(fake), /puede crear esquemas en la base/);
});

// ---------------- Corrección 1: Ads y descripción de la lista ----------------

const correccion = (cuenta) => fs.readFileSync(path.join(RAIZ, 'docs', 'pfos-correccion-1.sql'), 'utf8').replace(/<ID_CUENTA>/g, String(cuenta));
const sinComentariosSql = (sql) => sql.replace(/--.*$/gm, '');

conPg('Ads: la vista con la «ñ» mal codificada no devuelve filas (publicidad faltante, nunca 0); la corrección puntual la arregla sin tocar PFOS ni permisos', async () => {
  const db = await armarBase();
  const antes = (await db.query('SELECT count(*)::int AS n, sum((metrics->>\'cost\')::numeric)::text AS s FROM public.pfos_hist_ads_daily')).rows[0];
  // La vista como quedó en la base real: 'campaña' pegado con otra codificación.
  await db.exec(`CREATE OR REPLACE VIEW fiscalos.ads_diario WITH (security_barrier = true) AS
    SELECT user_id, day, level, key, campaign_id, metrics, quality FROM public.pfos_hist_ads_daily WHERE user_id = ${PROPIA} AND level = 'campaÃ±a'`);
  await db.exec('SET ROLE fiscalos_lectura');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM fiscalos.ads_diario')).rows[0].n, 0);
  const [mal] = await fotosDesde(comoPg(db), { meses: ['2026-09'], outDir: outConArca(), cuentaEsperada: String(PROPIA), generado: GENERADO });
  assert.equal(mal.lineas.publicidad.importe, null, 'sin días leídos: sin datos, no $ 0');
  assert.equal(mal.lineas.publicidad.nivel, 'faltante');
  assert.equal(mal.lineas.publicidad.completo, false);
  assert.match(mal.lineas.publicidad.faltan.join(' '), /sin datos de Mercado Ads.*pfos-correccion-1\.sql/);
  // FiscalOS dejó su sesión en solo lectura: el dueño vuelve a la suya para correr la corrección.
  await db.exec('RESET ROLE; SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');
  // Con la cuenta equivocada (la otra), la corrección se frena y no cambia nada.
  await assert.rejects(db.exec(correccion(OTRA)), /no es la de las vistas/);
  await db.exec('ROLLBACK').catch(() => {});
  assert.match((await db.query("SELECT pg_get_viewdef('fiscalos.ads_diario'::regclass) AS d")).rows[0].d, /campaÃ±a/);
  // La corrección real.
  await db.exec(correccion(PROPIA));
  assert.match((await db.query("SELECT pg_get_viewdef('fiscalos.ads_diario'::regclass) AS d")).rows[0].d, /'campaña'/);
  await db.exec('SET ROLE fiscalos_lectura');
  assert.equal(await controlarRol(comoPg(db)), 'fiscalos_lectura', 'el rol sigue mínimo y con permiso de lectura');
  const { rows: [r] } = await db.query(`SELECT count(DISTINCT day)::int AS dias, count(*)::int AS filas, count(DISTINCT user_id)::int AS cuentas FROM fiscalos.ads_diario
    WHERE day >= '2026-09-01' AND day < '2026-10-01'`);
  assert.deepEqual(r, { dias: 30, filas: 30, cuentas: 1 }, 'solo nivel campaña y solo la cuenta propia');
  assert.ok((await db.query('SELECT description FROM fiscalos.costos_items LIMIT 1')).rows.length, 'la descripción de la lista ya se puede leer');
  const [bien] = await fotosDesde(comoPg(db), { meses: ['2026-09'], outDir: outConArca(), cuentaEsperada: String(PROPIA), generado: GENERADO });
  assert.equal(bien.lineas.publicidad.importe, 3000);
  assert.equal(bien.lineas.publicidad.completo, true);
  await db.exec('RESET ROLE');
  // Nada de PFOS cambió; el rol no ganó acceso a las tablas.
  assert.deepEqual((await db.query('SELECT count(*)::int AS n, sum((metrics->>\'cost\')::numeric)::text AS s FROM public.pfos_hist_ads_daily')).rows[0], antes);
  for (const t of ['public.pfos_hist_ads_daily', 'public.pfos_cost_items']) {
    assert.equal((await db.query(`SELECT has_table_privilege('fiscalos_lectura', '${t}', 'SELECT') AS x`)).rows[0].x, false);
  }
});

test('los SQL no dependen de la codificación del archivo: el código (sin comentarios) es ASCII y la «ñ» va como U&', () => {
  for (const f of ['pfos-acceso.sql', 'pfos-correccion-1.sql']) {
    const codigo = sinComentariosSql(fs.readFileSync(path.join(RAIZ, 'docs', f), 'utf8'));
    assert.doesNotMatch(codigo, /[^\x00-\x7F]/, `${f}: hay caracteres no ASCII fuera de los comentarios`);
  }
  for (const f of ['pfos-acceso.sql', 'pfos-correccion-1.sql', 'pfos-comprobacion.sql']) {
    const codigo = sinComentariosSql(fs.readFileSync(path.join(RAIZ, 'docs', f), 'utf8'));
    assert.doesNotMatch(codigo, /level\s*=\s*'[^']*[^\x00-\x7F]/, `${f}: un filtro de nivel con caracteres no ASCII`);
    assert.match(codigo, /level = U&'campa\\00F1a'/);
  }
  // La corrección solo reemplaza las dos vistas: nada de tablas, roles ni permisos.
  const c = sinComentariosSql(fs.readFileSync(path.join(RAIZ, 'docs', 'pfos-correccion-1.sql'), 'utf8'));
  assert.deepEqual(c.match(/CREATE OR REPLACE VIEW fiscalos\.\w+/g), ['CREATE OR REPLACE VIEW fiscalos.ads_diario', 'CREATE OR REPLACE VIEW fiscalos.costos_items']);
  assert.doesNotMatch(c, /\b(GRANT|REVOKE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|CREATE (TABLE|ROLE|SCHEMA))\b/i);
});

// ---------------- Costo de la mercadería: reglas de PFOS (3.7) ----------------

test('costos: reglas de PFOS sin inventar cantidades (equivalencias, xN, colores, combos, par o tripack por precio, discontinuados, «a confirmar»)', () => {
  const it = (row, code, presentation, pairs, price, price_suggested, extra = {}) => ({ row, code, presentation, pairs, price, price_suggested, factor: 0.7125, ...extra });
  const items = [
    it(1, 'ME23C', 'PAR', 1, 1000, 4000), it(2, 'TE1C', 'PAR', 1, 1000, 4000), it(3, 'TE1C', 'TRIPACK', 3, 2700, 10000),
    // Como en la lista real: vinchas, muñequeras, manguitas y pantorrilleras «A CONFIRMAR», sin descripción.
    it(4, 'VINCHA01', 'A_CONFIRMAR', null, 500, 2000, { code_raw: 'ART. VINCHA01' }), it(5, 'MUÑEQUERA01', 'A_CONFIRMAR', null, 600, 2400, { code_raw: 'ART. MUÑEQUERA01' }),
    it(6, 'TE75C', 'PAR', 1, 900, 3600), it(7, 'ME62C', 'PAR', 1, 1200, 5000), it(8, 'ME19C', 'PAR', 1, 1100, 4500),
    it(9, 'MA01C', 'A_CONFIRMAR', null, 800, 3000, { code_raw: 'ART. MA01C' }), it(10, 'PA01C', 'A_CONFIRMAR', null, 900, 3500, { code_raw: 'ART. PA01C' }),
    it(11, 'XX01', 'A_CONFIRMAR', null, 900, 3500, { description: 'MANGUITAS DE PRUEBA' }), it(20, 'ME40C', 'PAR', 1, 1000, 4000), it(21, 'ME40C', 'A_CONFIRMAR', null, 2500, 9000),
    it(12, 'DE20C', 'PAR', 1, 700, 3000), it(13, 'DE24C', 'PAR', 1, 700, 3000), it(14, 'DE30C', 'PAR', 1, 900, 3000),
    it(15, 'TR5', 'TRIPACK', 3, 2700, 10000), it(16, 'IN04C', 'PAR', 1, 1000, 4000, { size: 'S-M' }), it(17, 'IN04C', 'PAR', 1, 1000, 4000, { size: 'L-XL' }),
    it(18, 'IN09C', 'PAR', 1, 1000, 4000, { size: 'S-M' }), it(19, 'IN09C', 'PAR', 1, 1200, 4000, { size: 'L-XL' }),
  ];
  const p = (sku, unitPrice) => proponerMapeo({ sku, unitPrice }, items);
  const comp = (r) => r.components.map((c) => `${c.code}×${c.units}`).join(' + ');
  // Código sin la última letra y xN.
  assert.equal(comp(p('ME23-NEGRO-M-X2', 9000)), 'ME23C×2');
  // Equivalencias confirmadas, con la unidad confirmada de cada «A CONFIRMAR» (Nicolás, 28/10): vincha por unidad,
  // muñequera por par, al precio de la lista.
  assert.equal(comp(p('VINCHA-ROSA', 2000)), 'VINCHA01×1');
  assert.equal(p('VINCHA-ROSA', 2000).motivo, '1 unidad(es) de VINCHA01');
  assert.match(p('VINCHA-ROSA', 2000).reglas.join(), /equivalencia VINCHA = VINCHA01.*VINCHA01 «a confirmar»: por unidad/);
  assert.equal(comp(p('VINCHA01-ROSA-X2', 4000)), 'VINCHA01×2');
  assert.equal(comp(p('MUÑE-NEGRO', 2400)), 'MUÑEQUERA01×1');
  assert.equal(p('MUÑE-NEGRO', 2400).motivo, '1 par(es) de MUÑEQUERA01');
  assert.equal(costoLinea({ cantidad: 3, componentes: p('VINCHA-ROSA', 2000).components, items }).valor, 3 * 500 * 0.7125);
  assert.equal(comp(p('TE172-NEGRO-M', 3600)), 'TE75C×1');
  // Colores con «+»: uno por color.
  assert.equal(comp(p('ME19-AERO+NEGRO-M', 9000)), 'ME19C×2');
  // Combos: la suma de sus partes (con «+» y pegados).
  assert.equal(comp(p('ME62+ME19-AERO+NEGRO-M', 9500)), 'ME62C×1 + ME19C×1');
  // Manguitas y pantorrilleras «A CONFIRMAR»: por par, reconocidas por CÓDIGO (la descripción real viene vacía).
  assert.equal(comp(p('MA01PA01-NEGRO-M1-P1', 6500)), 'MA01C×1 + PA01C×1');
  assert.equal(comp(p('MA01-NEGRO-M1-P1-X2', 6000)), 'MA01C×2');
  assert.match(p('MA01-NEGRO-M1-P1-X2', 6000).reglas.join(), /MA01C «a confirmar»: por par/);
  // Un «a confirmar» de otro código queda pendiente, aunque su descripción diga «manguitas».
  assert.equal(p('XX01-NEGRO', 3500).estado, 'dudoso');
  assert.equal(p('XX01-NEGRO', 3500).categoria, 'a confirmar en la lista');
  // Un código con una fila por par y otra «a confirmar»: la venta puede ser la no confirmada; no se elige la otra.
  assert.equal(p('ME40-NEGRO', 4000).estado, 'dudoso');
  assert.equal(p('ME40C+ME19-NEGRO+AERO', 9000).estado, 'dudoso', 'tampoco dentro de un combo');
  // Par o tripack: el precio decide solo si la otra lectura queda claramente lejos.
  assert.equal(p('TE1-NEGRO-M', 4200).components[0].presentation, 'PAR');
  assert.equal(p('TE1-NEGRO-M', 10500).components[0].presentation, 'TRIPACK');
  assert.equal(p('TE1-NEGRO-M', 6500).estado, 'dudoso', 'precio entre un par y un tripack: para revisión');
  assert.equal(p('TE1-NEGRO-M', 6500).categoria, 'presentación ambigua');
  assert.equal(p('TE1-NEGRO-M', null).estado, 'dudoso', 'sin precio no se elige entre par y tripack');
  // xN con un código que solo viene en tripack: 3 pares = 1 tripack (no 3 tripacks), por precio.
  assert.equal(comp(p('TR5-X3', 10000)), 'TR5×1');
  assert.equal(comp(p('TR5-X3', 30000)), 'TR5×3');
  // Discontinuado: entre dos códigos con el mismo precio, presentación y descuento; si los vecinos difieren, no.
  assert.equal(comp(p('DE22-NEGRO', 3000)), 'DE20C×1');
  assert.equal(p('DE26-NEGRO', 3000).estado, 'sin datos');
  // Talles: con el mismo costo da igual; con costos distintos hace falta el talle.
  assert.equal(p('IN04-NEGRO', 4000).estado, 'automático');
  assert.equal(p('IN09-NEGRO', 4000).categoria, 'talle');
  assert.equal(comp(p('IN09-NEGRO-L', 4000)), 'IN09C×1');
  // Cantidades que no se reparten: para revisión, nunca inventadas.
  assert.equal(p('ME23-NEGRO-X2-X3', 9000).estado, 'dudoso');
  assert.equal(p('ME19-AERO+NEGRO+ROJO-X2', 9000).estado, 'dudoso');
  assert.equal(p('ME62+ME19-NEGRO-X2', 9000).estado, 'dudoso', 'combo con xN');
  assert.equal(p('ZZ99', 1000).estado, 'sin datos');
  // El costo de la línea usa la fila elegida (tripack: su precio, no 3 pares).
  assert.equal(costoLinea({ cantidad: 2, componentes: p('TE1-NEGRO-M', 10500).components, items }).valor, 2 * 2700 * 0.7125);
});

// ---------------- Mes en curso: corte, cuenta provisoria y comparación ----------------

test('corte: el mes en curso se mide hasta ayer; los días futuros no son atrasados', () => {
  assert.equal(corteDelMes('2026-10', GENERADO), '2026-10-26');
  assert.equal(corteDelMes('2026-09', GENERADO), '2026-09-30');
  assert.equal(corteDelMes('2026-11', GENERADO), null);
  const alc = Array.from({ length: 26 }, (_, i) => ({ source: 'orders', status: 'completa', scope: `hist|2026-10-${String(i + 1).padStart(2, '0')}` }));
  const d = diasCubiertos(alc, 'orders', '2026-10', '2026-10-26');
  assert.deepEqual([d.dias, d.diasEsperados, d.faltan.length], [26, 26, 0]);
  assert.equal(diasCubiertos(alc, 'orders', '2026-10').faltan.length, 5, 'sin corte, el mes entero');
  // Ads: sin días, sin datos (null); con 0 leído, es dato.
  assert.equal(adsMes([], '2026-10', '2026-10-26').total, null);
  assert.equal(adsMes([{ day: '2026-10-02', metrics: { cost: 0 } }], '2026-10', '2026-10-26').total, 0);
  // Reportes: el rango declarado hasta el corte alcanza solo si PFOS validó la cobertura del archivo.
  const imp = [{ format: 'flex_nc', status: 'cerrada', coverage: 'completa', range_from: '2026-10-01', range_to: '2026-10-26' }];
  assert.equal(coberturaReportes(imp, ['flex_nc'], '2026-10', '2026-10-26').estado, 'completa');
  assert.equal(coberturaReportes(imp, ['flex_nc'], '2026-10').faltaDesde, '2026-10-27');
  assert.equal(coberturaReportes([{ ...imp[0], coverage: 'parcial' }], ['flex_nc'], '2026-10', '2026-10-26').estado, 'parcial');
});

test('Luma: la planilla de detalle no duplica los viajes que ya están en la quincenal', () => {
  const v = viajesSinDuplicar([
    { id_viaje: '1', referencia: '2000001', fecha_creacion: '2026-09-02T10:00:00', precio: '3000' },
    { referencia: '2000001', fecha_estado: '2026-09-02T18:00:00', precio: '3000' },
    { referencia: '2000002', fecha_estado: '2026-09-03T18:00:00', precio: '3100' },
  ]);
  assert.equal(v.viajes.length, 2); assert.equal(v.repetidos, 1);
  const l = logisticaReportesMes({ porFuente: { flex_viaje: [{ id_viaje: '1', referencia: '2000001', fecha_creacion: '2026-09-02T10:00:00', precio: '3000' },
    { referencia: '2000001', fecha_estado: '2026-09-02T18:00:00', precio: '3000' }] } }, '2026-09');
  assert.equal(l.cadete.total, 3000);
});

test('titularidad: el mes sin comprobantes se apoya en otro mes verificado de la MISMA cuenta; si los CAE no coinciden, nunca', () => {
  const sep = { mes: '2026-09', cuentaPfos: '111111', cuenta: { verificada: true, estado: 'verificada', encontrados: 25, comparados: 25 } };
  const oct = { mes: '2026-10', cuentaPfos: '111111', cuenta: { verificada: false, estado: 'sin evidencia', motivo: 'no hay comprobantes emitidos de ARCA con CAE para este mes' } };
  const t = titularidad(oct, [sep, oct]);
  assert.deepEqual([t.usable, t.provisoria, t.mesVerificado, t.conciliacionFiscal.estado], [true, true, '2026-09', 'pendiente']);
  assert.equal(titularidad({ ...oct, cuentaPfos: '999999' }, [sep]).usable, false, 'otra cuenta: no');
  assert.equal(titularidad({ ...oct, cuenta: { verificada: false, estado: 'no coincide', motivo: 'solo 3%' } }, [sep]).usable, false, 'CAE que no coinciden: no');
  assert.equal(titularidad(oct, [oct]).usable, false, 'sin un mes verificado: no');
  assert.equal(titularidad(sep, []).conciliacionFiscal.estado, 'conciliada');
});

conPg('octubre en curso: rentabilidad operativa provisoria al corte, conciliación fiscal pendiente y comparación con los mismos días de septiembre', async () => {
  const db = await armarBase();
  const ins = (key, data) => db.query(`INSERT INTO pfos_money_records (user_id, source, key, scope, data, sha, fetched_at, first_seen, last_seen)
    VALUES ($1,'orders',$2,'x',$3,'s',now(),now(),now())`, [PROPIA, key, JSON.stringify(data)]);
  await ins('6', orden('6', '2026-10-26T12:00:00.000-03:00', 'paid', [['ME23-NEGRO-M-X2', 1, 9000]], [], 9000));
  await ins('7', orden('7', '2026-10-27T09:00:00.000-03:00', 'paid', [['ME23-NEGRO-M-X2', 1, 9000]], [], 9000)); // hoy: después del corte
  for (let d = 1; d <= 26; d++) {
    for (const src of ['orders', 'mp_payments']) {
      await db.query(`INSERT INTO pfos_money_scopes (user_id, source, scope, family, status, updated_at) VALUES ($1,$2,$3,'ml','completa',now())`, [PROPIA, src, `hist|2026-10-${String(d).padStart(2, '0')}`]);
    }
  }
  await db.exec('SET ROLE fiscalos_lectura');
  const out = outConArca();
  const [sep, oct] = await fotosDesde(comoPg(db), { meses: ['2026-09', '2026-10'], outDir: out, cuentaEsperada: String(PROPIA), generado: GENERADO });
  assert.deepEqual([oct.corte, oct.mesCerrado, sep.mesCerrado], ['2026-10-26', false, true]);
  assert.equal(oct.ventas.ordenes, 2); assert.equal(oct.ventas.posterioresAlCorte, 1);
  assert.deepEqual([oct.cobertura.ordenes.diasEsperados, oct.cobertura.ordenes.faltan.length], [26, 0], 'los días 27 a 31 no son atrasados');
  assert.equal(oct.lineas.publicidad.importe, null, 'octubre sin Ads leídos: faltante');
  fs.mkdirSync(dirFotos(out), { recursive: true });
  for (const f of [sep, oct]) fs.writeFileSync(path.join(dirFotos(out), `${f.mes}.json`), JSON.stringify(f));
  // Titularidad por septiembre; conciliación fiscal de octubre aparte, pendiente.
  const i = integraciones(out, '2026-10').pfos;
  assert.deepEqual([i.verificada, i.usable, i.provisoria, i.titularidad.mesVerificado, i.conciliacionFiscal.estado], [false, true, true, '2026-09', 'pendiente']);
  assert.ok(Object.keys(obtenerPfos(out, '2026-10')).length, 'octubre se puede usar como provisorio');
  // Rentabilidad operativa provisoria: ventas de PFOS al corte, sin IVA; marcada.
  const op = resultadoOperativo(out, '2026-10');
  assert.ok(op.provisional); assert.equal(op.provisional.alCorte, '2026-10-26');
  assert.equal(op.ventas.cifra.valor, Math.round((18000 / 1.21) * 100) / 100);
  assert.equal(op.ventas.cifra.nivel, 'estimado');
  assert.match(op.provisional.nota, /Conciliación fiscal del mes: pendiente/);
  // Septiembre (mes cerrado, con sus comprobantes) no es provisorio.
  assert.equal(resultadoOperativo(out, '2026-09').provisional, null);
  // Comparación entre períodos equivalentes: del 1 al 26 de cada mes.
  const c = i.comparacion;
  assert.equal(c.dia, 26);
  assert.deepEqual([c.anterior.desde, c.anterior.hasta, c.actual.hasta], ['2026-09-01', '2026-09-26', '2026-10-26']);
  assert.equal(c.anterior.ordenes, 2, 'las del 10 y el 14; la del 30/09 no entra');
  assert.equal(c.anterior.ads, 2600, '26 días de Ads de septiembre');
  assert.equal(c.actual.ordenes, 2);
  assert.equal(c.actual.ads, null);
  assert.equal(compararAlCorte(oct, { mes: '2026-09' }).motivo.includes('detalle por día'), true);
});

test('reportes: completa, parcial y desconocida; las fechas declaradas del mes entero no alcanzan sin cobertura validada', () => {
  const r = (coverage, desde = '2026-09-01', hasta = '2026-09-30') => ({ format: 'ml_cargos_full', status: 'cerrada', coverage, range_from: desde, range_to: hasta });
  const est = (imps) => coberturaReportes(imps, ['ml_cargos_full'], '2026-09');
  assert.equal(est([r('completa')]).estado, 'completa');
  assert.equal(est([r('parcial')]).estado, 'parcial', 'filas descartadas al leer');
  assert.equal(est([r('desconocida')]).estado, 'desconocida', 'mes entero declarado, cobertura sin validar');
  assert.equal(est([r(null)]).estado, 'desconocida', 'sin dato de cobertura');
  assert.equal(est([r('completa', '2026-09-01', '2026-09-15'), r('desconocida', '2026-09-16', '2026-09-30')]).estado, 'desconocida');
  assert.equal(est([r('completa', '2026-09-01', '2026-09-15'), r('parcial', '2026-09-16', '2026-09-30')]).estado, 'parcial');
  assert.equal(est([r('desconocida', '2026-09-01', '2026-09-15')]).estado, 'parcial', 'faltan días: parcial');
  assert.equal(est([]).estado, 'sin datos');
  // En la foto: Full con cobertura sin validar deja la logística incompleta, dicho.
  const datos = { ordenes: [], ordenesDevueltas: [], devoluciones: [], cobros: new Map(), facturas: [], ads: [], alcances: [], conciliacion: [] };
  const comunes = { listas: [], itemsPorLista: new Map(), mapeos: new Map(),
    importaciones: ['flex_nc', 'flex_nd', 'luma_viajes'].map((format) => ({ ...r('completa'), format })).concat([r('desconocida')]) };
  const f = armarMes({ mes: '2026-09', datos, comunes, textosArca: [], generado: GENERADO });
  assert.equal(f.lineas.logistica.completo, false);
  assert.match(f.lineas.logistica.faltan.join(' '), /cargos de Full: 1 reporte\(s\) con la cobertura sin validar/);
});

test('costo con el 95 % de las unidades: lo que falta no es cero; se estima a la vista o no se da por completo', () => {
  const items = [{ row: 1, code: 'ME23C', presentation: 'PAR', pairs: 1, price: 1000, price_suggested: 4000, factor: 0.7 }];
  const comunes = { listas: [{ id: '1', valid_from: '2026-01-01' }], itemsPorLista: new Map([['1', items]]), mapeos: new Map(), importaciones: [] };
  const o = (id, sku, q, precio) => ({ key: id, data: { id, status: 'paid', date_created: '2026-09-10T10:00:00.000-03:00', total_amount: q * (precio ?? 0),
    order_items: [{ item: { id: 'MLA1', seller_sku: sku }, quantity: q, ...(precio == null ? {} : { unit_price: precio }) }], payments: [] } });
  const alcances = Array.from({ length: 30 }, (_, i) => ({ source: 'orders', status: 'completa', scope: `hist|2026-09-${String(i + 1).padStart(2, '0')}` }));
  const datos = (ordenes) => ({ ordenes, ordenesDevueltas: [], devoluciones: [], cobros: new Map(), facturas: [], ads: [], alcances, conciliacion: [] });
  // 19 unidades costeadas (19 × 700 = 13.300, vendidas a 4.000 c/u) y 1 sin costo vendida a 5.000: 95 %.
  const base = [o('1', 'ME23-NEGRO', 19, 4000)];
  const f = armarMes({ mes: '2026-09', datos: datos([...base, o('2', 'ZZ99', 1, 5000)]), comunes, textosArca: [], generado: GENERADO });
  const l = f.lineas['costo-mercaderia'];
  assert.equal(f.costo.cobertura, 95);
  assert.equal(l.conocido, 13300);
  assert.equal(l.estimadoFaltante, 875, '5.000 × (13.300 / 76.000)');
  assert.equal(l.importe, 14175, 'el importe incluye lo estimado: nunca el costeado solo');
  assert.equal(l.nivel, 'estimado');
  assert.match(l.nota, /875 ESTIMADO para 1 unidad\(es\) sin costo \(ventas de las unidades sin costo × \(costo ÷ ventas de las unidades con costo\)/);
  assert.equal(l.completo, true, 'con el 95 % costeado y lo demás estimado a la vista');
  // Si lo que falta no tiene precio, no se puede estimar: el costo no se da por completo.
  const g = armarMes({ mes: '2026-09', datos: datos([...base, o('2', 'ZZ99', 1, null)]), comunes, textosArca: [], generado: GENERADO });
  assert.equal(g.lineas['costo-mercaderia'].estimadoFaltante, null);
  assert.equal(g.lineas['costo-mercaderia'].completo, false);
  assert.match(g.lineas['costo-mercaderia'].faltan.join(' '), /1 unidad\(es\) sin costo que no se pueden estimar \(1 sin precio de venta\)/);
  // Todo costeado: sin estimación.
  const h = armarMes({ mes: '2026-09', datos: datos(base), comunes, textosArca: [], generado: GENERADO });
  assert.equal(h.lineas['costo-mercaderia'].estimadoFaltante, 0);
  assert.equal(h.lineas['costo-mercaderia'].importe, 13300);
});
