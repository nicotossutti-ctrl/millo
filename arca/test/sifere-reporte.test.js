import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clasificarAccion, bajarReportesCm03 } from '../src/portal/sifereReporte.js';
import { cm03DelPeriodo } from '../src/app/cm03.js';
import { htmlCm03, pdfDeHtml } from './helpers/cm03.js';

// Página de SIFERE SIMULADA (sin datos reales) y CM03 sintéticas.
const FILAS = [
  { jurisdiccion: '901 - Uno', determinado: 100, restan: 140, suman: 0, aFavorContribuyente: 40, aFavorFisco: 0, aPagar: 0 },
  { jurisdiccion: '902 - Dos', determinado: 80, restan: 50, suman: 0, aFavorContribuyente: 0, aFavorFisco: 30, aPagar: 30 },
];

test('acciones de la fila: solo el reporte o la impresión de la DJ; pago, VEP, copia o crear nunca; lo demás es desconocido', () => {
  assert.equal(clasificarAccion('Reporte | fa fa-print'), 'reporte');
  assert.equal(clasificarAccion('Imprimir DJ'), 'reporte');
  assert.equal(clasificarAccion('Imprimir VEP Generado | generarVEP'), 'no-tocar');
  assert.equal(clasificarAccion('Pago | fa fa-dollar'), 'no-tocar');
  assert.equal(clasificarAccion('Crear DJ a partir de copia'), 'no-tocar');
  assert.equal(clasificarAccion('Rectificar'), 'no-tocar');
  assert.equal(clasificarAccion('fa fa-eye'), 'desconocido');
  assert.equal(clasificarAccion(''), 'desconocido');
});

test('listado de SIFERE (simulado): baja el Reporte de la CM03 presentada, lo lee y nunca pide «Pago» ni «Copia»', async (t) => {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { t.skip('sin Playwright'); return; }
  const pdf = await pdfDeHtml(htmlCm03({ filas: FILAS }));
  if (!pdf) { t.skip('sin navegador'); return; }
  const b = await chromium.launch(process.env.FISCALOS_CHROMIUM ? { executablePath: process.env.FISCALOS_CHROMIUM } : {});
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-'));
  try {
    const ctx = await b.newContext({ acceptDownloads: true }); const pg = await ctx.newPage();
    const pedidos = [];
    const iconos = (id) => `<a href="CrearCopia.do?id=${id}" title="Crear DJ a partir de copia"><i class="fa fa-copy"></i></a>
      <a href="javascript:pagar(${id})" title="Pago"><i class="fa fa-dollar"></i></a> <a href="Reporte.do?id=${id}" title="Reporte" target="_blank"><i class="fa fa-print"></i></a>`;
    const lista = `<html><body><table id="t"><thead><tr><th>Acciones</th><th>Anticipo</th><th>Estado</th><th>Fecha y Hora Presentación</th></tr></thead><tbody>
      <tr><td>${iconos(1)}</td><td>202609 - 0</td><td>Presentada</td><td>15/10/2026</td></tr>
      <tr><td>${iconos(2)}</td><td>202610 - 0</td><td>Borrador</td><td></td></tr>
      <tr><td><a href="Otro.do?id=3"><i class="fa fa-eye"></i></a></td><td>202608 - 0</td><td>Presentada</td><td>14/09/2026</td></tr>
      </tbody></table></body></html>`;
    await ctx.route('https://sifereweb.comarb.gob.ar/**', (r) => {
      const u = r.request().url(); pedidos.push(u);
      if (/Reporte\.do/.test(u)) return r.fulfill({ status: 200, contentType: 'application/pdf', body: pdf });
      if (/Lista/.test(u)) return r.fulfill({ status: 200, contentType: 'text/html', body: lista });
      return r.fulfill({ status: 200, contentType: 'text/html', body: '<p>no debería pedirse</p>' });
    });
    await pg.goto('https://sifereweb.comarb.gob.ar/sifereweb/MostrarListaDDJJController.do');
    const obtenerPdf = async (u) => (/Reporte\.do/.test(u) ? pdf : null);
    const r = await bajarReportesCm03(pg, { meses: ['2026-08', '2026-09', '2026-10'], outDir: out, esperaMs: 8000, obtenerPdf });
    const por = Object.fromEntries(r.reportes.map((x) => [x.anticipo, x]));
    assert.equal(por['202609 - 0'].decision, 'bajada'); assert.equal(por['202609 - 0'].estado, 'valida', por['202609 - 0'].motivo);
    assert.equal(cm03DelPeriodo(out, '2026-09').vigente.totalAPagarDeclarado, 30);
    assert.equal(por['202610 - 0'], undefined, 'un borrador no se toca');
    assert.equal(por['202608 - 0'].decision, 'sin clic', 'un control sin descripción no se toca');
    assert.ok(!pedidos.some((u) => /CrearCopia|pagar|Otro\.do/.test(u)), `pedidos: ${pedidos.join(', ')}`);
    // Otra corrida: ya está leída, no se vuelve a bajar.
    const r2 = await bajarReportesCm03(pg, { meses: ['2026-09'], outDir: out, esperaMs: 8000, obtenerPdf });
    assert.equal(r2.reportes[0].decision, 'ya leída');
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
