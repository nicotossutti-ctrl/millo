import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNAS_LIBRES, esProhibido, elegirTabla, decidirEstado } from '../src/portal/extractor.js';
import { toCsv } from '../src/csv.js';

test('COLUMNAS_LIBRES arma el CSV a partir de headers y filas de la tabla scrapeada', () => {
  const headers = ['Impuesto', 'Período', 'Fecha Vencimiento'];
  const filas = [['IVA', '2026-09', '21/10/2026'], ['Ganancias', '2026', '12/08/2026']];
  const csv = toCsv(filas, COLUMNAS_LIBRES(headers));
  assert.match(csv, /Impuesto;Período;Fecha Vencimiento/);
  assert.match(csv, /IVA;2026-09;21\/10\/2026/);
  // columna sin nombre toma col<n>
  const csv2 = toCsv([['a', 'b']], COLUMNAS_LIBRES(['', 'X']));
  assert.match(csv2, /col1;X/);
});

test('esProhibido bloquea trámites, pagos, emisión y modificación', () => {
  for (const t of ['Presentar', 'Pagar', 'Generar VEP', 'Confirmar', 'Eliminar', 'Anular', 'Adherir', 'Solicitar plan']) {
    assert.equal(esProhibido(t), true, t);
  }
  for (const t of ['Consultar', 'Buscar', 'Siguiente', 'EXPORTAR', 'CSV', 'Vencimientos', '']) {
    assert.equal(esProhibido(t), false, t);
  }
});

test('elegirTabla prefiere la grilla fiscal por encabezados esperados, no por tamaño', () => {
  const navegacion = { headers: ['Inicio'], rows: Array.from({ length: 30 }, () => ['x']) }; // grande pero no es la grilla
  const grilla = { headers: ['Impuesto', 'Concepto', 'Periodo', 'Vencimiento'], rows: [['IVA', 'Saldo', '2026-09', '21/10/2026']] };
  const esperados = ['impuesto', 'concepto', 'periodo', 'vencimiento'];
  const elegida = elegirTabla([navegacion, grilla], esperados);
  assert.deepEqual(elegida.headers, grilla.headers);
});

test('elegirTabla descarta todo si se esperan encabezados y ninguna tabla coincide', () => {
  const soloNavegacion = [{ headers: ['Inicio', 'Ayuda'], rows: [['a', 'b']] }];
  assert.equal(elegirTabla(soloNavegacion, ['impuesto', 'concepto']), null);
});

test('elegirTabla sin encabezados esperados cae al puntaje por tamaño', () => {
  const chica = { headers: ['A', 'B'], rows: [['1', '2']] };
  const grande = { headers: ['A', 'B', 'C'], rows: [['1', '2', '3'], ['4', '5', '6']] };
  assert.deepEqual(elegirTabla([chica, grande], []).headers, grande.headers);
});

test('decidirEstado diferencia validado / extraido / parcial / sin-datos', () => {
  assert.deepEqual(decidirEstado({ filas: 0, informados: null, conFiltroPeriodo: true, rangoOk: true }), { estado: 'sin-datos', verificado: false });
  assert.deepEqual(decidirEstado({ filas: 20, informados: 20, conFiltroPeriodo: true, rangoOk: true }), { estado: 'validado', verificado: true });
  assert.deepEqual(decidirEstado({ filas: 18, informados: 20, conFiltroPeriodo: true, rangoOk: true }), { estado: 'parcial', verificado: false });
  assert.deepEqual(decidirEstado({ filas: 7, informados: null, conFiltroPeriodo: false, rangoOk: null }), { estado: 'extraido', verificado: false });
  assert.deepEqual(decidirEstado({ filas: 5, informados: null, conFiltroPeriodo: true, rangoOk: false }), { estado: 'parcial', verificado: false });
});
