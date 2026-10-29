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

/** CM03 sintética con tres jurisdicciones a pagar (Buenos Aires 100, Córdoba 200, Santa Fe 300) y CABA sin saldo. */
async function conCm03(out) {
  const { htmlCm03, pdfDeHtml } = await import('./helpers/cm03.js');
  const { importarCm03 } = await import('../src/app/cm03.js');
  const pdf = await pdfDeHtml(htmlCm03({ filas: [
    { jurisdiccion: '901 - CABA', determinado: 100, restan: 140, suman: 0, aFavorContribuyente: 40, aFavorFisco: 0, aPagar: 0 },
    { jurisdiccion: '902 - Buenos Aires', determinado: 120, restan: 20, suman: 0, aFavorContribuyente: 0, aFavorFisco: 100, aPagar: 100 },
    { jurisdiccion: '904 - Córdoba', determinado: 220, restan: 20, suman: 0, aFavorContribuyente: 0, aFavorFisco: 200, aPagar: 200 },
    { jurisdiccion: '921 - Santa Fe', determinado: 320, restan: 20, suman: 0, aFavorContribuyente: 0, aFavorFisco: 300, aPagar: 300 }] }));
  if (!pdf) return false;
  await importarCm03(out, { nombre: 'cm03.pdf', contenido: pdf, mes: '2026-09' });
  return true;
}

/** SIFERE Consultas SIMULADO como en la guía oficial: «SIFERE» > «Pagos» > período (mes/año desde-hasta) y jurisdicción > «Buscar». */
function moduloSimulado(ctx, { conFiltros = true } = {}) {
  const H = 'https://consultas.comarb.gob.ar/consultas/';
  const menu = `<nav><a href="Inicio.do">INICIO</a> <a href="Padron.do">PADRON WEB</a> <button onclick="document.getElementById('m').style.display='block'">SIFERE</button>
    <div id="m" style="display:none"><a href="DDJJ.do">Mensuales</a> <a href="Pagos.do">Pagos</a> <a href="Resumen.do">Resumen de DDJJs y Pagos</a></div>
    <a href="Deducciones.do">DEDUCCIONES</a> <a href="Pagar.do">Pagar</a> <a href="GenerarVep.do">Generar VEP</a></nav>`;
  const opciones = (xs) => xs.map((x) => `<option value="${x[0]}">${x[1]}</option>`).join('');
  const meses = opciones(Array.from({ length: 12 }, (_, i) => [String(i + 1).padStart(2, '0'), String(i + 1).padStart(2, '0')]));
  const anios = opciones([['2025', '2025'], ['2026', '2026']]);
  const jur = opciones([['', 'Seleccione'], ['901', '901 - CABA'], ['902', '902 - Buenos Aires'], ['904', '904 - Córdoba'], ['921', '921 - Santa Fe']]);
  const form = conFiltros ? `<form action="Pagos.do"><table><tr><td>Anticipo desde</td><td><select name="md">${meses}</select> / <select name="ad">${anios}</select></td>
    <td>Anticipo hasta</td><td><select name="mh">${meses}</select> / <select name="ah">${anios}</select></td></tr>
    <tr><td>Jurisdicción</td><td><select name="j">${jur}</select></td></tr></table><button type="submit">Buscar</button></form>` : '<p>Seleccione los datos</p>';
  const PAGOS = { 902: [['202609', '902 - Buenos Aires', '14/10/2026', '100,00', 'Pagado', '555000111']], 921: [['202609', '921 - Santa Fe', '15/10/2026', '300,00', 'Pagado', '555000113']] };
  const pedidos = [];
  return { H, pedidos, rutear: () => ctx.route(`${H}**`, (r) => {
    const u = new URL(r.request().url()); pedidos.push(u.pathname + u.search);
    const html = (cuerpo) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<html><body>${menu}${cuerpo}</body></html>` });
    if (/Exportar\.do/.test(u.pathname)) return r.fulfill({ status: 200, headers: { 'content-type': 'application/vnd.ms-excel', 'content-disposition': `attachment; filename="pagos-${u.searchParams.get('j')}.xls"` }, body: `pagos ${u.searchParams.get('j')}` });
    if (/Pagos\.do/.test(u.pathname)) {
      const q = Object.fromEntries(u.searchParams);
      if (!q.j) return html(form);
      // Solo responde con el período y la jurisdicción bien elegidos.
      if (q.md !== '09' || q.ad !== '2026' || q.mh !== '09' || q.ah !== '2026') return html(`${form}<p>Período inválido</p>`);
      const filas = PAGOS[q.j];
      if (!filas) return html(`${form}<p>No se encontraron pagos para la consulta.</p>`);
      return html(`${form}<table><thead><tr><th>Anticipo</th><th>Jurisdicción</th><th>Fecha de Pago</th><th>Importe</th><th>Estado</th><th>Número VEP</th></tr></thead><tbody>
        ${filas.map((f) => `<tr>${f.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table><a href="Exportar.do?j=${q.j}">Exportar a Excel</a>`);
    }
    return html('<h1>SIFERE Web - Consultas</h1>');
  }) };
}

test('SIFERE Consultas (simulado): «SIFERE» > «Pagos», septiembre y una consulta por jurisdicción de la CM03; nunca «Pagar» ni «Generar VEP»', async (t) => {
  const { esRotuloPagos } = await import('../src/portal/sifereConsultas.js');
  for (const x of ['Pagos', 'Consulta de pagos', 'Pagos realizados']) assert.equal(esRotuloPagos(x), true, x);
  for (const x of ['Pagar', 'Generar VEP', 'Volantes de Pago', 'Resumen de DDJJs y Pagos', '']) assert.equal(esRotuloPagos(x), false, x);
  const b = await navegador(t); if (!b) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-c-'));
  try {
    if (!(await conCm03(out))) { t.skip('sin navegador para la CM03'); return; }
    const ctx = await b.newContext({ acceptDownloads: true }); const pg = await ctx.newPage();
    const sim = moduloSimulado(ctx); await sim.rutear();
    await pg.goto(`${sim.H}Inicio.do`);
    const servicio = { ...SERVICIOS.find((s) => s.id === 'sifere-consultas-web') };
    const datosDir = path.join(out, 'datos');
    const r = await correrUno({ cfg: { outDir: out }, page: null, context: ctx, abrirServicio: async () => pg }, servicio,
      { baseDir: path.join(out, 'corrida'), periodo: { desde: '2026-09-01', hasta: '2026-10-28' }, datosDir });
    assert.ok(r.conservacion?.some((c) => c.promovido), JSON.stringify(r.conservacion) + JSON.stringify(r.validaciones?.[0]?.calidad));
    const consultas = r.validaciones[0].calidad ? JSON.parse(fs.readFileSync(path.join(out, 'corrida', 'sifere-consultas-web', 'resultado.json'), 'utf8')).sub[0].consultas : [];
    assert.deepEqual(consultas.map((c) => [c.jurisdiccion, c.estado, c.filas]), [['Buenos Aires', 'consultada', 1], ['Córdoba', 'consultada', 0], ['Santa Fe', 'consultada', 1]]);
    // Tres consultas independientes, cada una con septiembre 2026 y su jurisdicción; ninguna sin jurisdicción.
    const busquedas = sim.pedidos.filter((p) => /Pagos\.do\?/.test(p));
    assert.deepEqual(busquedas.map((p) => new URLSearchParams(p.split('?')[1]).get('j')), ['902', '904', '921']);
    assert.ok(busquedas.every((p) => /md=09&ad=2026&mh=09&ah=2026/.test(p)));
    assert.ok(!sim.pedidos.some((p) => /Pagar|GenerarVep|Resumen/.test(p)), sim.pedidos.join(', '));
    const { pagosConsultasIibb, panelMes } = await import('../src/app/panel.js');
    const pc = pagosConsultasIibb(datosDir, '2026-09');
    assert.deepEqual(pc.pagos.map((p) => [p.jurisdiccion, p.importe, p.verificado, p.comprobante]), [['902 - Buenos Aires', 100, true, '555000111'], ['921 - Santa Fe', 300, true, '555000113']]);
    assert.equal(pc.consultas.get('904').estado, 'consultada');
    const c = panelMes(out, '2026-09', { hoy: '2026-10-29', paramsFile: path.join(out, 'x.json') }).iibb.conciliacion;
    assert.deepEqual(c.filas.filter((f) => f.aPagar > 0).map((f) => [f.jurisdiccion, f.estado, f.saldo]),
      [['Buenos Aires', 'Pagado', 0], ['Córdoba', 'Sin pagos informados por SIFERE', null], ['Santa Fe', 'Pagado', 0]]);
    assert.equal(c.total.saldo, null, 'Córdoba sin verificar: el total no se afirma');
    assert.equal(fs.readdirSync(path.join(out, 'importados', 'sifere-pagos')).length, 2, 'una exportación por jurisdicción con pagos');
    // Otra corrida: no se duplica nada.
    const pg2 = await ctx.newPage(); await pg2.goto(`${sim.H}Inicio.do`);
    await correrUno({ cfg: { outDir: out }, page: null, context: ctx, abrirServicio: async () => pg2 }, servicio, { baseDir: path.join(out, 'corrida2'), periodo: { desde: '2026-09-01', hasta: '2026-10-28' }, datosDir });
    assert.equal(pagosConsultasIibb(datosDir, '2026-09').pagos.length, 2);
    assert.equal(fs.readdirSync(path.join(out, 'importados', 'sifere-pagos')).length, 2);
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('SIFERE Consultas (simulado): sin filtros de período y jurisdicción reconocibles no se busca nada y no se guarda «cero pagos»', async (t) => {
  const b = await navegador(t); if (!b) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-c-'));
  try {
    if (!(await conCm03(out))) { t.skip('sin navegador para la CM03'); return; }
    const ctx = await b.newContext(); const pg = await ctx.newPage();
    const sim = moduloSimulado(ctx, { conFiltros: false }); await sim.rutear();
    await pg.goto(`${sim.H}Inicio.do`);
    const datosDir = path.join(out, 'datos');
    const r = await correrUno({ cfg: { outDir: out }, page: null, context: ctx, abrirServicio: async () => pg }, { ...SERVICIOS.find((s) => s.id === 'sifere-consultas-web') },
      { baseDir: path.join(out, 'corrida'), periodo: { desde: '2026-09-01', hasta: '2026-10-28' }, datosDir });
    const sub = JSON.parse(fs.readFileSync(path.join(out, 'corrida', 'sifere-consultas-web', 'resultado.json'), 'utf8')).sub[0];
    assert.equal(r.conservacion?.some((c) => c.promovido), false);
    assert.ok(sub.consultas.every((c) => c.estado === 'sin consulta confirmada'), JSON.stringify(sub.consultas));
    assert.ok(!sim.pedidos.some((p) => /Pagos\.do\?/.test(p)), 'no se tocó «Buscar»');
    assert.ok(!fs.existsSync(path.join(datosDir, 'sifere-consultas-web-pagos', 'vigente.json')), 'no se guardó un cero');
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('SIFERE Consultas (simulado): sin una consulta de «Pagos» inequívoca no se toca nada y no se pisa lo guardado', async (t) => {
  const b = await navegador(t); if (!b) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-c-'));
  try {
    if (!(await conCm03(out))) { t.skip('sin navegador para la CM03'); return; }
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
