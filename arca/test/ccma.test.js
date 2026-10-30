import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leerCcma, esEncabezadoCcma, periodosCcma, calcularDeudaCcma } from '../src/portal/ccma.js';
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

test('CCMA: los períodos de la consulta son los doce meses que terminan en el mes final de la corrida (MM/AAAA)', () => {
  assert.deepEqual(periodosCcma({ desde: '2026-09-01', hasta: '2026-09-30' }), { desde: '10/2025', hasta: '09/2026' });
  assert.deepEqual(periodosCcma({ desde: '2026-01-01', hasta: '2026-01-31' }), { desde: '02/2025', hasta: '01/2026' });
});

test('CCMA en el navegador (simulado como la pantalla real): completa los períodos, toca solo «Calcular deuda», lee y conserva', async (t) => {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { t.skip('sin Playwright'); return; }
  let b;
  try { b = await chromium.launch(process.env.FISCALOS_CHROMIUM ? { executablePath: process.env.FISCALOS_CHROMIUM } : {}); } catch { t.skip('sin navegador'); return; }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-ccma-'));
  try {
    const pg = await b.newPage();
    // Al abrir: solo el formulario «Recálculo de deuda a fecha» (como la corrida real). La grilla aparece al calcular.
    await pg.setContent(`<form name="frm"><table class="CabeceraTablaBorde"><tr><td>RECÁLCULO DE DEUDA A FECHA</td></tr>
      <tr><td>PERÍODO DESDE (MM/AAAA)</td><td><input name="perdesde2"></td></tr><tr><td>PERÍODO HASTA (MM/AAAA)</td><td><input name="perhasta2"></td></tr>
      <tr><td>FECHA DE CÁLCULO</td><td><input name="feccalculo"></td></tr></table>
      <input type="button" name="CalDeud" value="Calcular Deuda" onclick="window.tocados=(window.tocados||[]).concat('CalDeud'); document.getElementById('res').innerHTML='<table><tr><td>Período</td><td>Concepto</td><td>Vencimiento</td><td>Importe</td><td>Saldo</td></tr><tr><td>09/2026</td><td>Aportes</td><td>05/10/2026</td><td>100,00</td><td>0,00</td></tr><tr><td>10/2026</td><td>Aportes</td><td>05/11/2026</td><td>100,00</td><td>100,00</td></tr></table>'">
      <input type="button" name="Pag_Princ" value="Pagar" onclick="window.tocados=(window.tocados||[]).concat('Pag_Princ')"><div id="res"></div></form>`);
    const servicio = { ...SERVICIOS.find((s) => s.id === 'ccma') };
    const datosDir = path.join(out, 'datos');
    const r = await correrUno({ cfg: { outDir: out }, page: pg, abrirServicio: async () => pg }, servicio, { baseDir: path.join(out, 'corrida'), periodo: { desde: '2026-09-01', hasta: '2026-09-30' }, datosDir });
    assert.equal(r.filas, 2, r.motivo);
    assert.deepEqual(await pg.evaluate(() => window.tocados ?? []), ['CalDeud'], 'solo «Calcular deuda»; nunca «Pagar»');
    assert.equal(await pg.inputValue('input[name="perdesde2"]'), '10/2025');
    assert.equal(await pg.inputValue('input[name="perhasta2"]'), '09/2026');
    assert.match(await pg.inputValue('input[name="feccalculo"]'), /^\d{2}\/\d{2}\/\d{4}$/);
    const vig = JSON.parse(fs.readFileSync(path.join(datosDir, 'ccma', 'vigente.json'), 'utf8'));
    assert.ok(Object.keys(vig).length, 'quedó conservado');
    const sep = ccmaDelPeriodo(datosDir, '2026-09');
    assert.equal(sep.filas.length, 1); assert.equal(sep.filas[0][0], '09/2026');
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('CCMA: si el botón CalDeud no dice «Calcular» (vacío, solo «Deuda» o prohibido), no se toca nada', async (t) => {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { t.skip('sin Playwright'); return; }
  let b;
  try { b = await chromium.launch(process.env.FISCALOS_CHROMIUM ? { executablePath: process.env.FISCALOS_CHROMIUM } : {}); } catch { t.skip('sin navegador'); return; }
  try {
    const pg = await b.newPage();
    for (const valor of ['Generar VEP', '', 'Deuda']) {
      await pg.setContent(`<input name="perdesde2"><input name="perhasta2"><input name="feccalculo"><input type="button" name="CalDeud" value="${valor}" onclick="window.tocado=1">`);
      const r = await calcularDeudaCcma(pg, { desde: '2026-09-01', hasta: '2026-09-30' });
      assert.equal(r.consultado, false, valor);
      assert.equal(await pg.evaluate(() => window.tocado ?? null), null, valor);
    }
  } finally { await b.close(); }
});
