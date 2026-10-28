import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leerCcma, esEncabezadoCcma } from '../src/portal/ccma.js';
import { correrUno } from '../src/portal/orquestador.js';
import { SERVICIOS } from '../src/portal/servicios.js';
import { ccmaDelPeriodo } from '../src/app/panel.js';

// Tablas SINTÉTICAS con la forma de la pantalla vieja de CCMA (sin <th>, con título y fila de totales).
test('CCMA: encuentra la fila de encabezados por sus palabras, toma las filas con período y aparta los totales', () => {
  const tablas = [
    { headers: ['CUENTA CORRIENTE', ''], rows: [['Apellido y nombre', 'X'], ['Período desde', '01/2026']] }, // maquetación
    { headers: ['Detalle de la deuda'], rows: [['Período', 'Concepto', 'Vencimiento', 'Capital', 'Intereses', 'Saldo'],
      ['01/2026', 'Aportes', '05/02/2026', '100,00', '0,00', '0,00'], ['02/2026', 'Aportes', '05/03/2026', '100,00', '2,50', '102,50'],
      ['Total', '', '', '200,00', '2,50', '102,50']] },
  ];
  const g = leerCcma(tablas);
  assert.deepEqual(g.headers, ['Período', 'Concepto', 'Vencimiento', 'Capital', 'Intereses', 'Saldo']);
  assert.equal(g.rows.length, 2); assert.equal(g.totales.length, 1);
  assert.equal(esEncabezadoCcma(['Período desde', '01/2026']), false, 'un campo de búsqueda no es un encabezado');
  assert.equal(leerCcma([{ headers: ['a', 'b'], rows: [['1', '2']] }]), null, 'sin encabezados reconocibles no se inventan columnas');
});

test('CCMA en el navegador (simulado): lee la grilla, la conserva y no toca «Calcular deuda» ni «Pagar»', async (t) => {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { t.skip('sin Playwright'); return; }
  let b;
  try { b = await chromium.launch(process.env.FISCALOS_CHROMIUM ? { executablePath: process.env.FISCALOS_CHROMIUM } : {}); } catch { t.skip('sin navegador'); return; }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-ccma-'));
  try {
    const pg = await b.newPage();
    await pg.setContent(`<form><table><tr><td>Período desde <input name="perdesde2"> hasta <input name="perhasta2"></td></tr></table>
      <input type="button" name="CalDeud" value="Calcular Deuda" onclick="window.tocado='CalDeud'"> <input type="button" name="Pag_Princ" value="Pagar" onclick="window.tocado='Pag_Princ'">
      <table class="CabeceraTablaBorde"><tr><td>Período</td><td>Concepto</td><td>Vencimiento</td><td>Importe</td><td>Saldo</td></tr>
      <tr><td>09/2026</td><td>Aportes</td><td>05/10/2026</td><td>100,00</td><td>0,00</td></tr><tr><td>10/2026</td><td>Aportes</td><td>05/11/2026</td><td>100,00</td><td>100,00</td></tr></table></form>`);
    const servicio = { ...SERVICIOS.find((s) => s.id === 'ccma') };
    const datosDir = path.join(out, 'datos');
    const r = await correrUno({ cfg: { outDir: out }, page: pg, abrirServicio: async () => pg }, servicio, { baseDir: path.join(out, 'corrida'), periodo: { desde: '2026-09-01', hasta: '2026-10-27' }, datosDir });
    assert.equal(r.filas, 2, r.motivo);
    assert.equal(await pg.evaluate(() => window.tocado ?? null), null, 'no se tocó ningún botón');
    const vig = JSON.parse(fs.readFileSync(path.join(datosDir, 'ccma', 'vigente.json'), 'utf8'));
    assert.ok(Object.keys(vig).length, 'quedó conservado');
    const sep = ccmaDelPeriodo(datosDir, '2026-09');
    assert.equal(sep.filas.length, 1); assert.equal(sep.filas[0][0], '09/2026');
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
