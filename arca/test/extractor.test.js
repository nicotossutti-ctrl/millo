import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNAS_LIBRES, esProhibido } from '../src/portal/extractor.js';
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
