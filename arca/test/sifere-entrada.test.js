import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { correrUno } from '../src/portal/orquestador.js';
import { SERVICIOS } from '../src/portal/servicios.js';

// SIFERE SIMULADO (sin datos reales).
async function navegador(t) {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { t.skip('sin Playwright'); return null; }
  try { return await chromium.launch(process.env.FISCALOS_CHROMIUM ? { executablePath: process.env.FISCALOS_CHROMIUM } : {}); } catch { t.skip('sin navegador'); return null; }
}

test('SIFERE: los listados se abren desde el menú del módulo (por la dirección, este SIFERE simulado da «Sesión expirada»)', async (t) => {
  const b = await navegador(t); if (!b) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-e-'));
  try {
    const ctx = await b.newContext(); const pg = await ctx.newPage();
    const menu = ['MostrarListaDDJJController.do', 'MostrarListaDDJJAnualController.do', 'MostrarListaVolantesPagoController.do'].map((c) => `<a class="dropdown-item" style="display:none" href="${c}">${c}</a>`).join('');
    const tabla = (enc, filas) => `<html><body>${menu}<table><thead><tr>${enc.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${filas.map((f) => `<tr>${f.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
    const pedidas = [];
    await ctx.route('https://sifereweb.comarb.gob.ar/**', (r) => {
      const u = r.request().url(); const desdeElMenu = !!r.request().headers().referer; pedidas.push(u);
      if (/Lista/.test(u) && !desdeElMenu) return r.fulfill({ status: 302, headers: { location: 'https://sifereweb.comarb.gob.ar/sifereweb/MostrarSesionExpiradaController.do' } });
      if (/SesionExpirada/.test(u)) return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<p>Sesión Expirada</p>' });
      if (/ListaDDJJController/.test(u)) return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: tabla(['Acciones', 'Anticipo', 'Estado', 'Fecha y Hora Presentación'], [['', '202609 - 0', 'Presentada', '15/10/2026 10:00']]) });
      if (/ListaDDJJAnual/.test(u)) return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: tabla(['Acciones', 'Año', 'Estado', 'Fecha y Hora Presentación'], [['', '2025', 'Presentada', '10/06/2026 10:00']]) });
      if (/VolantesPago/.test(u)) return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: tabla(['Acciones', 'Anticipo', 'Fecha Generación', 'Monto Total', 'Medio de Pago', 'Estado'], [['', '202609 - 0', '14/10/2026', '10,00', 'VEP', 'Pagado']]) });
      return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<html><body><h1>Portada</h1>${menu}</body></html>` });
    });
    await pg.goto('https://sifereweb.comarb.gob.ar/sifereweb/MostrarPortadaController.do');
    const servicio = { ...SERVICIOS.find((s) => s.id === 'sifere-consultas') };
    const sesion = { cfg: { outDir: out }, page: null, context: ctx, abrirServicio: async () => pg };
    const logs = [];
    const r = await correrUno(sesion, servicio, { log: (m) => logs.push(m), baseDir: path.join(out, 'corrida'), periodo: { desde: '2026-09-01', hasta: '2026-09-30' }, datosDir: path.join(out, 'datos') });
    assert.ok(r.filas >= 3, `${r.filas} filas · ${JSON.stringify(r.validaciones?.map((v) => [v.sub, v.filas, v.motivo]))} · ${JSON.stringify(pedidas)} · ${logs.join(' | ')}`);
    assert.ok(!pedidas.some((u) => /SesionExpirada/.test(u)), 'nunca se abrió un listado por la dirección');
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('SIFERE: si la pestaña de COMARB no carga, se informa como conexión (no como login) y no se esperan 3 minutos', async (t) => {
  const b = await navegador(t); if (!b) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-e-'));
  try {
    const ctx = await b.newContext(); const principal = await ctx.newPage();
    await principal.setContent('<p>Portal</p>');
    // El acceso abre una pestaña a un host de COMARB que no responde (dominio inexistente: el navegador muestra su error).
    const abrirServicio = async () => { const p = await ctx.newPage(); await p.goto('http://app1.comarb.invalid/', { timeout: 15000 }).catch(() => {}); return principal; };
    const logs = [];
    const inicio = Date.now();
    const r = await correrUno({ cfg: { outDir: out }, page: principal, context: ctx, abrirServicio }, { ...SERVICIOS.find((s) => s.id === 'sifere-consultas-web') },
      { baseDir: path.join(out, 'corrida'), periodo: { desde: '2026-09-01', hasta: '2026-09-30' }, datosDir: path.join(out, 'datos'), log: (m) => logs.push(m) });
    assert.ok(Date.now() - inicio < 60000, 'no esperó los 3 minutos del login');
    assert.match(r.motivo, /no se pudo conectar con COMARB/);
    assert.ok(!logs.some((l) => /pide login/.test(l)), logs.join('\n'));
    assert.ok(!ctx.pages().some((p) => /^chrome-error:/.test(p.url())), 'la pestaña de error se cerró');
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('SIFERE Consultas (simulado): menú «SIFERE» > «Pagos» > «Consultar», lee la grilla, guarda la exportación y nunca toca «Pagar» ni «Generar VEP»', async (t) => {
  const { esRotuloPagos } = await import('../src/portal/sifereConsultas.js');
  for (const x of ['Pagos', 'Consulta de pagos', 'Pagos realizados']) assert.equal(esRotuloPagos(x), true, x);
  for (const x of ['Pagar', 'Generar VEP', 'Volantes de Pago', 'Pagos y VEP', '']) assert.equal(esRotuloPagos(x), false, x);
  const b = await navegador(t); if (!b) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-c-'));
  try {
    const ctx = await b.newContext({ acceptDownloads: true }); const pg = await ctx.newPage();
    const H = 'https://consultas.comarb.gob.ar/consultas/';
    const menu = `<nav><a href="Padron.do">PADRON WEB</a> <button onclick="document.getElementById('m').style.display='block'">SIFERE</button>
      <div id="m" style="display:none"><a href="DDJJ.do">Declaraciones Juradas</a> <a href="Pagos.do">Pagos</a></div> <a href="Deducciones.do">DEDUCCIONES</a>
      <a href="Pagar.do">Pagar</a> <a href="GenerarVep.do">Generar VEP</a></nav>`;
    const pedidos = [];
    await ctx.route(`${H}**`, (r) => {
      const u = r.request().url(); pedidos.push(u);
      const html = (cuerpo) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<html><body>${menu}${cuerpo}</body></html>` });
      if (/Pagos\.do\?consultar/.test(u)) {
        return html(`<table><thead><tr><th>Anticipo</th><th>Jurisdicción</th><th>Fecha de Pago</th><th>Importe</th><th>Estado</th></tr></thead><tbody>
          <tr><td>202609</td><td>902 - Buenos Aires</td><td>14/10/2026</td><td>100,00</td><td>Pagado</td></tr>
          <tr><td>202609</td><td>904 - Córdoba</td><td>15/10/2026</td><td>200,00</td><td>Pagado</td></tr></tbody></table>
          <a href="Exportar.do">Exportar a Excel</a>`);
      }
      if (/Pagos\.do/.test(u)) return html('<form action="Pagos.do"><input type="hidden" name="consultar" value="1"><select name="anio"><option>2026</option></select><button type="submit">Consultar</button></form>');
      if (/Exportar\.do/.test(u)) return r.fulfill({ status: 200, headers: { 'content-type': 'application/vnd.ms-excel', 'content-disposition': 'attachment; filename="pagos.xls"' }, body: 'Anticipo\tImporte\n202609\t100,00\n' });
      return html('<h1>SIFERE WEB - Consultas</h1>');
    });
    await pg.goto(`${H}Portada.do`);
    const servicio = { ...SERVICIOS.find((s) => s.id === 'sifere-consultas-web') };
    const datosDir = path.join(out, 'datos');
    const r = await correrUno({ cfg: { outDir: out }, page: null, context: ctx, abrirServicio: async () => pg }, servicio,
      { baseDir: path.join(out, 'corrida'), periodo: { desde: '2026-09-01', hasta: '2026-10-28' }, datosDir });
    assert.equal(r.filas, 2, JSON.stringify(r.validaciones));
    assert.ok(!pedidos.some((u) => /Pagar\.do|GenerarVep/.test(u)), `pedidos: ${pedidos.join(', ')}`);
    const vig = JSON.parse(fs.readFileSync(path.join(datosDir, 'sifere-consultas-web-pagos', 'vigente.json'), 'utf8'));
    assert.ok(Object.keys(vig).length, 'los pagos quedaron conservados');
    const { pagosConsultasIibb } = await import('../src/app/panel.js');
    assert.deepEqual(pagosConsultasIibb(datosDir, '2026-09').pagos.map((p) => [p.jurisdiccion, p.importe, p.verificado]), [['902 - Buenos Aires', 100, true], ['904 - Córdoba', 200, true]]);
    const exportados = fs.readdirSync(path.join(out, 'importados', 'sifere-pagos'));
    assert.equal(exportados.length, 1, 'la exportación (respaldo original) quedó guardada');
    // Otra vez la misma consulta: no se duplica nada.
    const pg2 = await ctx.newPage(); await pg2.goto(`${H}Portada.do`);
    await correrUno({ cfg: { outDir: out }, page: null, context: ctx, abrirServicio: async () => pg2 }, servicio,
      { baseDir: path.join(out, 'corrida2'), periodo: { desde: '2026-09-01', hasta: '2026-10-28' }, datosDir });
    assert.equal(pagosConsultasIibb(datosDir, '2026-09').pagos.length, 2);
    assert.equal(fs.readdirSync(path.join(out, 'importados', 'sifere-pagos')).length, 1);
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('SIFERE Consultas (simulado): sin una consulta de «Pagos» inequívoca no se toca nada y no se pisa lo guardado', async (t) => {
  const b = await navegador(t); if (!b) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-c-'));
  try {
    const ctx = await b.newContext(); const pg = await ctx.newPage(); const pedidos = [];
    await ctx.route('https://consultas.comarb.gob.ar/**', (r) => { pedidos.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
      body: '<a href="A.do">Pagos</a> <a href="B.do">Consulta de pagos</a> <a href="Pagar.do">Pagar</a>' }); });
    await pg.goto('https://consultas.comarb.gob.ar/consultas/Portada.do');
    const r = await correrUno({ cfg: { outDir: out }, page: null, context: ctx, abrirServicio: async () => pg }, { ...SERVICIOS.find((s) => s.id === 'sifere-consultas-web') },
      { baseDir: path.join(out, 'corrida'), periodo: { desde: '2026-09-01', hasta: '2026-10-28' }, datosDir: path.join(out, 'datos') });
    assert.equal(r.filas, 0);
    assert.match(JSON.stringify(r.validaciones), /no se elige uno a ciegas/);
    assert.deepEqual(pedidos, ['https://consultas.comarb.gob.ar/consultas/Portada.do'], 'no se hizo ningún clic');
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
