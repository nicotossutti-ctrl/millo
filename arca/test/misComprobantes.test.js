import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rangos, candidatos, validarArchivo } from '../src/portal/misComprobantes.js';

test('rangos parte el período en tramos de hasta 365 días', () => {
  assert.deepEqual(rangos('2026-01-01', '2026-03-31'), [['2026-01-01', '2026-03-31']]);
  const r = rangos('2025-01-01', '2026-10-19');
  assert.equal(r[0][0], '2025-01-01');
  assert.equal(r.at(-1)[1], '2026-10-19');
  assert.ok(r.every(([a, b]) => (new Date(b) - new Date(a)) / 86400000 <= 364));
});

test('candidatos elige fecha, buscar y exportar a partir del relevamiento', () => {
  const rel = { frames: [{ principal: true, inputs: [
    { tag: 'input', id: 'fechaEmision', visible: true, type: 'text' },
    { tag: 'input', id: 'nroDoc', visible: true, type: 'text' },
    { tag: 'input', id: 'fechaOculta', visible: false, type: 'hidden' },
  ], botones: [{ tag: 'button', id: 'buscarComprobantes', text: 'Buscar', visible: true }, { tag: 'button', text: 'Volver', visible: true }],
  enlaces: [{ tag: 'a', text: 'CSV', cls: 'buttons-csv', visible: true }], conRol: [{ role: 'grid' }] }] };
  const c = candidatos(rel);
  assert.deepEqual(c.fecha.map((x) => x.id), ['fechaEmision']);
  assert.deepEqual(c.buscar.map((x) => x.id), ['buscarComprobantes']);
  assert.deepEqual(c.exportar.map((x) => x.text), ['CSV']);
  assert.equal(c.tabla, 1);
});

test('validarArchivo acepta un CSV con fechas dentro del rango y rechaza uno fuera', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-mc-'));
  const f = path.join(dir, 'a.csv');
  fs.writeFileSync(f, '﻿Fecha de Emisión;Tipo de Comprobante;Punto de Venta;Número Desde;Imp. Total\r\n05/03/2026;1;1;10;1210,00\r\n20/03/2026;3;1;2;-100,00\r\n');
  const ok = validarArchivo(f, '2026-03-01', '2026-03-31');
  assert.equal(ok.ok, true);
  assert.equal(ok.filas, 2);
  assert.equal(ok.separador, ';');
  assert.equal(ok.columnaFecha, 'Fecha de Emisión');
  const mal = validarArchivo(f, '2026-04-01', '2026-04-30');
  assert.equal(mal.ok, false);
  assert.equal(mal.fueraDelRango, 2);
  fs.writeFileSync(f, 'Fecha\r\n');
  assert.equal(validarArchivo(f, '2026-03-01', '2026-03-31').ok, false);
});
