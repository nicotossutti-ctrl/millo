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
import { fotosDesde, resumenFotoFiscal } from '../src/pfos/actualizar.js';
import { controlarRol } from '../src/pfos/lectura.js';
import { enArgentina, retencionesMes, vigentesConciliacion, corteDelMes, diasCubiertos } from '../src/pfos/calculo.js';
import { clavesArca, verificarCuenta, titularidad } from '../src/pfos/cuenta.js';
import { dirFotos } from '../src/pfos/fotos.js';
import { integraciones } from '../src/app/integraciones.js';
import { panelMes } from '../src/app/panel.js';
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

conPg('PFOS de punta a punta: solo lo fiscal de la cuenta propia (CAE, ventas como control, retenciones de MP)', async () => {
  const db = await armarBase();
  await db.exec('SET ROLE fiscalos_lectura');
  const [sep, oct] = await fotosDesde(comoPg(db), { meses: ['2026-09', '2026-10'], outDir: outConArca(), cuentaEsperada: String(PROPIA), generado: GENERADO });
  // Cuenta verificada por CAE en los emitidos de ARCA; octubre no tiene emitidos para comparar.
  assert.equal(sep.cuenta.verificada, true);
  assert.equal(sep.cuenta.encontrados, 25);
  assert.equal(oct.cuenta.verificada, false);
  assert.equal(oct.cuenta.estado, 'sin evidencia');
  // Ventas como control: la del 30/09 23:30 es de septiembre; la cancelada aparte; la otra cuenta no existe.
  assert.equal(sep.ventas.ordenes, 3);
  assert.equal(sep.ventas.canceladas, 1);
  assert.equal(sep.ventas.totalConIva, 20000);
  assert.equal(oct.ventas.ordenes, 1);
  // Retenciones de MP a cargo del vendedor (anticipos), una vez por pago; los cargos comerciales no se calculan acá.
  assert.equal(sep.retencionesMp.importe, 50);
  assert.deepEqual(sep.retencionesMp.porNombre, { iibb: 50 });
  assert.equal(sep.retencionesMp.cobertura, 100);
  // Nada comercial en la foto.
  for (const k of ['lineas', 'costo', 'cargos', 'ads', 'reportes', 'porDia']) assert.equal(sep[k], undefined, k);
  assert.deepEqual([sep.mesCerrado, oct.corte], [true, '2026-10-26']);
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

test('piezas: fecha argentina, retenciones por pago y versiones vigentes de «Conciliación»', () => {
  assert.deepEqual(enArgentina('2026-09-30T23:30:00.000-03:00'), { dia: '2026-09-30', mes: '2026-09' });
  assert.deepEqual(enArgentina('2026-10-01T02:30:00Z'), { dia: '2026-09-30', mes: '2026-09' });
  // Un pago que cubre dos órdenes del paquete se cuenta una vez; solo las retenciones a cargo del vendedor.
  const ord = [{ data: { payments: [{ id: 'p', status: 'approved' }] } }, { data: { payments: [{ id: 'p', status: 'approved' }] } }];
  const r = retencionesMes(ord, new Map([['p', { status: 'approved', charges_details: [cargo('iibb', 'tax', 'collector', 100, 10), cargo('iibb', 'tax', 'payer', 999), cargo('meli_percentage_fee', 'fee', 'collector', 500)] }]]));
  assert.deepEqual([r.total, r.pagos, r.cobertura], [90, 1, 100]);
  // Conciliación: dos versiones ordenables por frescura → la más nueva; identidad repetida → pendiente (afuera).
  const f = (key, sha, fr, st = 'identificada', def = 'd') => ({ source: 'comprobante', identity_key: key, identity_status: st, data_sha: sha, defining_sha: def, import_status: 'cerrada', freshness_at: fr, freshness_origin: 'contenido', data: { cae: sha } });
  const v = vigentesConciliacion([f('a', '1', '2026-10-01'), f('a', '2', '2026-10-05'), f('b', '3', '2026-10-01', 'pendiente'), { ...f('c', '4', null), import_status: 'abierta' }]);
  assert.deepEqual(v.porFuente.comprobante, [{ cae: '2' }]);
  assert.equal(v.pendientes.comprobante, 1);
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

conPg('corrección 1 (Ads): la vista con la «ñ» mal codificada no devuelve filas; el SQL la arregla sin tocar PFOS ni permisos', async () => {
  const db = await armarBase();
  const antes = (await db.query('SELECT count(*)::int AS n, sum((metrics->>\'cost\')::numeric)::text AS s FROM public.pfos_hist_ads_daily')).rows[0];
  // La vista como quedó en la base real: 'campaña' pegado con otra codificación.
  await db.exec(`CREATE OR REPLACE VIEW fiscalos.ads_diario WITH (security_barrier = true) AS
    SELECT user_id, day, level, key, campaign_id, metrics, quality FROM public.pfos_hist_ads_daily WHERE user_id = ${PROPIA} AND level = 'campaÃ±a'`);
  await db.exec('SET ROLE fiscalos_lectura');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM fiscalos.ads_diario')).rows[0].n, 0);
  await db.exec('RESET ROLE');
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


// ---------------- Mes en curso: corte, cuenta provisoria y comparación ----------------

test('corte: el mes en curso se mide hasta ayer; los días futuros no son atrasados', () => {
  assert.equal(corteDelMes('2026-10', GENERADO), '2026-10-26');
  assert.equal(corteDelMes('2026-09', GENERADO), '2026-09-30');
  assert.equal(corteDelMes('2026-11', GENERADO), null);
  const alc = Array.from({ length: 26 }, (_, i) => ({ source: 'orders', status: 'completa', scope: `hist|2026-10-${String(i + 1).padStart(2, '0')}` }));
  const d = diasCubiertos(alc, 'orders', '2026-10', '2026-10-26');
  assert.deepEqual([d.dias, d.diasEsperados, d.faltan.length], [26, 26, 0]);
  assert.equal(diasCubiertos(alc, 'orders', '2026-10').faltan.length, 5, 'sin corte, el mes entero');
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

conPg('octubre en curso: la cuenta se apoya en septiembre (misma cuenta, verificada por CAE) y la conciliación fiscal de octubre queda pendiente', async () => {
  const db = await armarBase();
  await db.exec('SET ROLE fiscalos_lectura');
  const out = outConArca();
  const [sep, oct] = await fotosDesde(comoPg(db), { meses: ['2026-09', '2026-10'], outDir: out, cuentaEsperada: String(PROPIA), generado: GENERADO });
  fs.mkdirSync(dirFotos(out), { recursive: true });
  for (const f of [sep, oct]) fs.writeFileSync(path.join(dirFotos(out), `${f.mes}.json`), JSON.stringify(f));
  const i = integraciones(out, '2026-10').pfos;
  assert.deepEqual([i.verificada, i.usable, i.titularidad.mesVerificado, i.conciliacionFiscal.estado], [false, true, '2026-09', 'pendiente']);
  assert.equal(i.control.ventasMl, 9000);
  assert.equal(i.control.facturado, null, 'sin comprobantes emitidos de octubre');
  const s = integraciones(out, '2026-09').pfos;
  assert.equal(s.conciliacionFiscal.estado, 'conciliada');
  assert.equal(s.retencionesMp.importe, 50);
  // El panel no arma rentabilidad con PFOS: la conciliación va aparte, en lo impositivo.
  const p = panelMes(out, '2026-10', { hoy: '2026-10-27', paramsFile: path.join(out, 'x.json') });
  assert.equal(p.rentabilidad, undefined);
  assert.equal(p.integraciones.pfos.conciliacionFiscal.estado, 'pendiente');
  // Una cuenta cuyos CAE no coinciden no se usa: sus datos no se muestran.
  fs.writeFileSync(path.join(dirFotos(out), '2026-10.json'), JSON.stringify({ ...oct, cuenta: { verificada: false, estado: 'no coincide', motivo: 'solo 3%' } }));
  const mala = integraciones(out, '2026-10').pfos;
  assert.equal(mala.usable, false); assert.equal(mala.control, undefined); assert.equal(mala.retencionesMp, undefined);
});


test('pfos:actualizar: el resumen de consola usa solo lo fiscal de la foto (cuenta, ventas, retenciones, cobertura)', async () => {
  const { armarMes } = await import('../src/pfos/mes.js');
  const foto = armarMes({ mes: '2026-09', datos: { ordenes: [], cobros: [], facturas: [], conciliacion: [], alcances: [] }, textosArca: [], generado: '2026-10-28T12:00:00Z' });
  const lineas = resumenFotoFiscal(foto);
  assert.match(lineas[0], /^2026-09 · cuenta NO verificada/);
  assert.match(lineas.join('\n'), /ventas de Mercado Libre.*0 órdenes/);
  assert.match(lineas.join('\n'), /retenciones de Mercado Pago/);
  assert.match(lineas.join('\n'), /cobertura: órdenes faltan 30 de 30/);
  assert.doesNotMatch(lineas.join('\n'), /costo|rentabilidad|undefined/i);
  // La consola del comando ya no lee campos comerciales que la foto fiscal no tiene.
  const cli = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js'), 'utf8');
  assert.doesNotMatch(cli, /f\.lineas|f\.costo|Rentabilidad/);
});
