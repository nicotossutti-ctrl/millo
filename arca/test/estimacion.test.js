import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimar, alicuotaIIBB, leerMeses } from '../src/estimacion.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const contribuyente = {
  deduccionEspecial: 'ap1', cargasFamilia: { conyuge: 0, hijos: 0 }, deduccionesGeneralesAnuales: 1500000,
  autonomosMensual: 100000,
  ingresosBrutos: [{ jurisdiccion: 'CABA', coeficiente: 0.6, alicuota: 0.03 }, { jurisdiccion: 'PBA', coeficiente: 0.4, alicuota: 0.035 }],
};

test('alícuota de IIBB ponderada por coeficientes de Convenio', () => {
  assert.equal(Math.round(alicuotaIIBB(contribuyente) * 10000) / 10000, 0.032);
});

test('la ganancia real descuenta IIBB, autónomos y la provisión de Ganancias', () => {
  const rows = estimar(2026, [{ mes: '2026-01', ventasNetas: 6000000, gastosNetos: 800000 }], contribuyente);
  const r = rows[0];
  assert.equal(r.resultadoBruto, 5200000);
  assert.equal(r.iibb, 192000);
  assert.equal(r.autonomos, 100000);
  assert.equal(r.antesGanancias, 4908000);
  assert.ok(r.ganancias > 0);
  assert.equal(r.gananciaReal, Math.round((r.antesGanancias - r.ganancias) * 100) / 100);
  assert.equal(r.proyeccionAnual, 4908000 * 12);
});

test('con proyección fija, la suma de provisiones de 12 meses iguales es el impuesto anual', () => {
  const meses = Array.from({ length: 12 }, (_, i) => ({ mes: `2026-${String(i + 1).padStart(2, '0')}`, ventasNetas: 6000000, gastosNetos: 800000 }));
  const rows = estimar(2026, meses, contribuyente);
  const suma = rows.reduce((s, r) => s + r.ganancias, 0);
  assert.ok(Math.abs(suma - rows.at(-1).impuestoAnualProyectado) < 0.1);
});

test('leerMeses acepta separador ; y coma decimal', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arca-est-')), 'meses.csv');
  fs.writeFileSync(f, '﻿Mes;Ventas netas;Gastos netos\r\n2026-01;6.000.000,50;800.000\r\n2026-02;5500000;700000\r\n');
  assert.deepEqual(leerMeses(f), [
    { mes: '2026-01', ventasNetas: 6000000.5, gastosNetos: 800000 },
    { mes: '2026-02', ventasNetas: 5500000, gastosNetos: 700000 },
  ]);
});
