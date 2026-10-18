import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exportarEmitidos, buscarPrimero, validarComprobante, aplicarNotasDeCredito, consultarCached, COLUMNAS_EMITIDOS } from '../src/emitidos.js';
import { toCsv } from '../src/csv.js';
import { cfgDePrueba, wsfeSimulado } from './helpers.js';

/** Serie de 40 facturas A: 10 por mes de enero a abril 2026, con huecos (números 13 y 27 no existen). */
function serieMensual() {
  const arr = [];
  let nro = 1;
  for (const mes of ['01', '02', '03', '04']) {
    for (let d = 1; d <= 10; d++, nro++) {
      if (nro === 13 || nro === 27) { nro++; }
      arr.push({ nro, fch: `2026${mes}${String(d).padStart(2, '0')}`, total: 1000 + nro });
    }
  }
  return arr;
}

test('modo rango: encuentra exactamente los comprobantes del período y declara la corrida completa', async () => {
  const cfg = cfgDePrueba();
  const wsfe = wsfeSimulado({ '1-1': serieMensual() });
  const { rows, reporte } = await exportarEmitidos(wsfe, cfg, { desde: '2026-02-01', hasta: '2026-03-31', tipos: [1], ptos: [1] });
  assert.equal(rows.length, 20);
  assert.ok(rows.every((r) => r.cbteFch >= '20260201' && r.cbteFch <= '20260331'));
  assert.equal(reporte.completo, true);
  const s = reporte.series[0];
  assert.equal(s.primeroRecorrido, 11);   // primera factura de febrero
  assert.equal(s.ultimoRecorrido, 42);    // último autorizado
  assert.equal(s.consultados, 32);        // 11..42 consecutivos, sin saltear ninguno
  assert.deepEqual(s.inexistentes, [13, 27]);
  assert.equal(s.errores.length, 0);
  assert.equal(s.cobertura, 1);
  // ningún número del rango quedó sin consultar
  for (let n = 11; n <= 42; n++) assert.ok(wsfe.consultas.includes(`1-1-${n}`), `falta consultar ${n}`);
});

test('modo completo recorre desde el 1 y da el mismo resultado', async () => {
  const cfg = cfgDePrueba();
  const wsfe = wsfeSimulado({ '1-1': serieMensual() });
  const { rows, reporte } = await exportarEmitidos(wsfe, cfg, { desde: '2026-02-01', hasta: '2026-03-31', tipos: [1], ptos: [1], completo: true });
  assert.equal(rows.length, 20);
  assert.equal(reporte.series[0].primeroRecorrido, 1);
  assert.equal(reporte.series[0].consultados, 42);
  assert.equal(reporte.completo, true);
});

test('una fecha fuera de orden invalida la corrida en modo rango', async () => {
  const cfg = cfgDePrueba();
  const serie = serieMensual();
  serie[20].fch = '20250101'; // nro 22 (marzo) con fecha vieja: rompe la monotonía
  const wsfe = wsfeSimulado({ '1-1': serie });
  const { reporte } = await exportarEmitidos(wsfe, cfg, { desde: '2026-02-01', hasta: '2026-03-31', tipos: [1], ptos: [1] });
  assert.equal(reporte.completo, false);
  assert.ok(reporte.series[0].fueraDeOrden.length >= 1);
  assert.match(reporte.advertencias[0], /INCOMPLETO/);
});

test('un error de consulta queda registrado y la corrida no se declara completa', async () => {
  const cfg = cfgDePrueba();
  const wsfe = wsfeSimulado({ '1-1': serieMensual() }, { fallar: new Set(['1-1-30']) });
  const { rows, reporte } = await exportarEmitidos(wsfe, cfg, { desde: '2026-02-01', hasta: '2026-03-31', tipos: [1], ptos: [1] });
  assert.equal(rows.length, 19);
  assert.equal(reporte.completo, false);
  assert.deepEqual(reporte.series[0].errores.map((e) => e.nro), [30]);
  assert.ok(reporte.series[0].cobertura < 1);
  assert.equal(reporte.totales.errores, 1);
});

test('recorre puntos de venta bloqueados y series vacías sin fallar', async () => {
  const cfg = cfgDePrueba();
  const wsfe = wsfeSimulado({ '1-1': serieMensual() }, {
    ptosVenta: [{ nro: 1, emisionTipo: 'CAE', bloqueado: false, fchBaja: null }, { nro: 2, emisionTipo: 'CAE', bloqueado: true, fchBaja: '20240101' }],
    tiposCbte: [{ id: 1, desc: 'Factura A', fchDesde: '20100917', fchHasta: null }, { id: 3, desc: 'Nota de Crédito A', fchDesde: '20100917', fchHasta: null }],
  });
  const { reporte } = await exportarEmitidos(wsfe, cfg, { desde: '2026-01-01', hasta: '2026-12-31' });
  assert.deepEqual(reporte.puntosRecorridos, [1, 2]);
  assert.equal(reporte.series.length, 4);
  assert.ok(reporte.series.every((s) => s.completa));
  assert.equal(reporte.completo, true);
});

test('buscarPrimero salta huecos y encuentra el primer número del rango', async () => {
  const serie = new Map(serieMensual().map((c) => [c.nro, c]));
  const consultar = async (n) => (serie.has(n) ? { cbteFch: serie.get(n).fch } : null);
  assert.equal(await buscarPrimero(consultar, 42, '20260201'), 11);
  assert.equal(await buscarPrimero(consultar, 42, '20260301'), 22);
  assert.equal(await buscarPrimero(consultar, 42, '20260101'), 1);
  assert.equal(await buscarPrimero(consultar, 42, '20270101'), 43);
});

test('notas de crédito: signo negativo y anulación de la factura asociada por el total', async () => {
  const cfg = cfgDePrueba();
  const wsfe = wsfeSimulado({
    '1-1': [{ nro: 1, fch: '20260105', total: 1000 }, { nro: 2, fch: '20260110', total: 2000 }],
    '1-3': [{ nro: 1, fch: '20260120', total: 1000, cbtesAsoc: [{ tipo: 1, ptoVta: 1, nro: 1 }] }, { nro: 2, fch: '20260121', total: 500, cbtesAsoc: [{ tipo: 1, ptoVta: 1, nro: 2 }] }],
  });
  const { rows, reporte } = await exportarEmitidos(wsfe, cfg, { desde: '2026-01-01', hasta: '2026-01-31', tipos: [1, 3], ptos: [1] });
  const f1 = rows.find((r) => r.cbteTipo === 1 && r.cbteDesde === 1);
  const f2 = rows.find((r) => r.cbteTipo === 1 && r.cbteDesde === 2);
  assert.equal(f1.anulado, true);
  assert.deepEqual(f1.anuladoPor, ['3-1-1']);
  assert.equal(f2.anulado, false);   // NC parcial
  assert.equal(f2.totalAnulado, 500);
  assert.equal(reporte.totales.totalConSigno, 1500);
  assert.equal(reporte.totales.anulados, 1);
  const csv = toCsv(rows, COLUMNAS_EMITIDOS);
  assert.match(csv, /Total c\/signo/);
  assert.match(csv, /;-1000,00;/);   // la NC sale negativa
  assert.match(csv, /ANULADO/);
});

test('validaciones detectan importes, IVA y moneda inconsistentes', () => {
  const base = { cbteFch: '20260101', impNeto: 1000, impIva: 210, impTrib: 0, impOpEx: 0, impTotConc: 0, impTotal: 1210, iva: [{ id: 5, baseImp: 1000, importe: 210 }], monId: 'PES', monCotiz: 1, resultado: 'A', cbteDesde: 1, cbteHasta: 1 };
  assert.deepEqual(validarComprobante(base), []);
  assert.match(validarComprobante({ ...base, impTotal: 1300 })[0], /total/);
  assert.match(validarComprobante({ ...base, iva: [{ id: 5, baseImp: 1000, importe: 100 }] })[0], /IVA/);
  assert.match(validarComprobante({ ...base, monId: 'DOL', monCotiz: 0 })[0], /cotización/);
  assert.match(validarComprobante({ ...base, cbteFch: '20261301' })[0], /fecha/);
});

test('el cache está aislado por CUIT y entorno y no reutiliza entradas inválidas', async () => {
  const cfg = cfgDePrueba();
  const wsfe = wsfeSimulado({ '1-1': [{ nro: 1, fch: '20260105', total: 1000 }] });
  const stats = { cache: 0, arca: 0 };
  await consultarCached(wsfe, cfg, 1, 1, 1, stats);
  await consultarCached(wsfe, cfg, 1, 1, 1, stats);
  assert.deepEqual(stats, { cache: 1, arca: 1 });
  const f = path.join(cfg.outDir, 'cache', 'test', cfg.cuit, '1-1-1.json');
  assert.ok(fs.existsSync(f));
  // otro CUIT no ve el cache
  const otro = { ...cfg, cuit: '20222222223' };
  const stats2 = { cache: 0, arca: 0 };
  await consultarCached(wsfe, otro, 1, 1, 1, stats2);
  assert.deepEqual(stats2, { cache: 0, arca: 1 });
  // entrada corrupta: se vuelve a consultar
  fs.writeFileSync(f, '{"v":1}');
  const stats3 = { cache: 0, arca: 0 };
  await consultarCached(wsfe, cfg, 1, 1, 1, stats3);
  assert.deepEqual(stats3, { cache: 0, arca: 1 });
});
