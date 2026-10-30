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
    assert.match(r.motivo, /no se llegó al módulo: portal de ARCA: el navegador no pudo cargar app1\.comarb\.invalid\/.*; acceso oficial \(SSO\): /);
    assert.deepEqual(r.acceso.map((a) => [a.via, a.estado]), [['portal de ARCA', 'error-red'], ['acceso oficial (SSO)', 'error-red']]);
    assert.ok(!/caíd|no funciona/i.test(r.motivo), 'no se afirma que el sitio esté caído');
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
function moduloSimulado(ctx, { conFiltros = true, sinOpcion = null } = {}) {
  const H = 'https://consultas.comarb.gob.ar/consultas/';
  const menu = `<nav><a href="Inicio.do">INICIO</a> <a href="Padron.do">PADRON WEB</a> <button onclick="document.getElementById('m').style.display='block'">SIFERE</button>
    <div id="m" style="display:none"><a href="DDJJ.do">Mensuales</a> <a href="Pagos.do">Pagos</a> <a href="Resumen.do">Resumen de DDJJs y Pagos</a></div>
    <a href="Deducciones.do">DEDUCCIONES</a> <a href="Pagar.do">Pagar</a> <a href="GenerarVep.do">Generar VEP</a></nav>`;
  const opciones = (xs) => xs.map((x) => `<option value="${x[0]}">${x[1]}</option>`).join('');
  const meses = opciones(Array.from({ length: 12 }, (_, i) => [String(i + 1).padStart(2, '0'), String(i + 1).padStart(2, '0')]));
  const anios = opciones([['2025', '2025'], ['2026', '2026']]);
  const jur = opciones([['', 'Seleccione'], ['901', '901 - CABA'], ['902', '902 - Buenos Aires'], ['904', '904 - Córdoba'], ['921', '921 - Santa Fe']].filter((x) => x[0] !== sinOpcion));
  const form = conFiltros ? `<form action="Pagos.do"><table><tr><td>Anticipo desde</td><td><select name="md">${meses}</select> / <select name="ad">${anios}</select></td>
    <td>Anticipo hasta</td><td><select name="mh">${meses}</select> / <select name="ah">${anios}</select></td></tr>
    <tr><td>Jurisdicción</td><td><select name="j">${jur}</select></td></tr></table><button type="submit">Buscar</button></form>` : '<p>Seleccione los datos</p>';
  const sim = { H, pedidos: [], pagos: { 902: [['202609', '902 - Buenos Aires', '14/10/2026', '100,00', 'Pagado', '555000111']], 921: [['202609', '921 - Santa Fe', '15/10/2026', '300,00', 'Pagado', '555000113']] } };
  const pedidos = sim.pedidos;
  sim.rutear = () => ctx.route(`${H}**`, (r) => {
    const u = new URL(r.request().url()); pedidos.push(u.pathname + u.search);
    const html = (cuerpo) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<html><body>${menu}${cuerpo}</body></html>` });
    if (/Exportar\.do/.test(u.pathname)) return r.fulfill({ status: 200, headers: { 'content-type': 'application/vnd.ms-excel', 'content-disposition': `attachment; filename="pagos-${u.searchParams.get('j')}.xls"` }, body: `pagos ${u.searchParams.get('j')}` });
    if (/Pagos\.do/.test(u.pathname)) {
      const q = Object.fromEntries(u.searchParams);
      if (!q.j) return html(form);
      // Solo responde con el período y la jurisdicción bien elegidos.
      if (q.md !== '09' || q.ad !== '2026' || q.mh !== '09' || q.ah !== '2026') return html(`${form}<p>Período inválido</p>`);
      const filas = sim.pagos[q.j];
      if (!filas) return html(`${form}<p>No se encontraron pagos para la consulta.</p>`);
      return html(`${form}<table><thead><tr><th>Anticipo</th><th>Jurisdicción</th><th>Fecha de Pago</th><th>Importe</th><th>Estado</th><th>Número VEP</th></tr></thead><tbody>
        ${filas.map((f) => `<tr>${f.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table><a href="Exportar.do?j=${q.j}">Exportar a Excel</a>`);
    }
    return html('<h1>SIFERE Web - Consultas</h1>');
  });
  return sim;
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

/** Una corrida de SIFERE Consultas sobre el módulo simulado, con la conservación real en out/datos. */
async function correrConsultas(ctx, sim, out, nombre) {
  const pg = await ctx.newPage(); await pg.goto(`${sim.H}Inicio.do`);
  const r = await correrUno({ cfg: { outDir: out }, page: null, context: ctx, abrirServicio: async () => pg }, { ...SERVICIOS.find((s) => s.id === 'sifere-consultas-web') },
    { baseDir: path.join(out, nombre), periodo: { desde: '2026-09-01', hasta: '2026-10-28' }, datosDir: path.join(out, 'datos') });
  await pg.close();
  return r;
}

test('SIFERE Consultas (simulado): una consulta nueva «sin pagos» en las tres jurisdicciones NO reemplaza los pagos guardados', async (t) => {
  const b = await navegador(t); if (!b) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-c-'));
  try {
    if (!(await conCm03(out))) { t.skip('sin navegador para la CM03'); return; }
    const ctx = await b.newContext({ acceptDownloads: true });
    const sim = moduloSimulado(ctx); await sim.rutear();
    const { pagosConsultasIibb, panelMes } = await import('../src/app/panel.js');
    const datosDir = path.join(out, 'datos');
    // 1.ª corrida: [pago Buenos Aires, sin pagos Córdoba, pago Santa Fe] = 3 filas guardadas, 2 pagos reales.
    const r1 = await correrConsultas(ctx, sim, out, 'corrida1');
    assert.ok(r1.conservacion.some((c) => c.promovido), JSON.stringify(r1.conservacion));
    const vig = path.join(datosDir, 'sifere-consultas-web-pagos', 'vigente.json');
    const antes = JSON.parse(fs.readFileSync(vig, 'utf8'));
    assert.deepEqual(Object.keys(antes), ['2026-09-01_2026-09-30'], 'la clave es el anticipo consultado');
    assert.equal(antes['2026-09-01_2026-09-30'].filas, 3);
    assert.equal(antes['2026-09-01_2026-09-30'].registros, 2);
    // 2.ª corrida: SIFERE responde «sin pagos» en las tres = también 3 filas, 0 pagos. Mismo nivel, mismas filas.
    sim.pagos = {};
    const r2 = await correrConsultas(ctx, sim, out, 'corrida2');
    const c2 = r2.conservacion.find((c) => c.id === 'sifere-consultas-web-pagos');
    assert.equal(c2.promovido, false, JSON.stringify(c2));
    assert.match(c2.motivo, /Buenos Aires: 1 → 0; Santa Fe: 1 → 0/);
    const despues = JSON.parse(fs.readFileSync(vig, 'utf8'))['2026-09-01_2026-09-30'];
    assert.equal(despues.cuando, 'corrida1', 'el vigente sigue siendo la primera lectura');
    assert.deepEqual(despues.pendienteRevision.grupos, [{ grupo: 'Buenos Aires', antes: 1, ahora: 0 }, { grupo: 'Santa Fe', antes: 1, ahora: 0 }]);
    // La segunda lectura queda como evidencia (intento) y como aviso; los dos pagos siguen.
    assert.ok(fs.existsSync(path.join(datosDir, 'sifere-consultas-web-pagos', 'intentos', 'corrida2', 'sifere-consultas-web-pagos.csv')));
    assert.deepEqual(pagosConsultasIibb(datosDir, '2026-09').pagos.map((p) => [p.jurisdiccion, p.importe, p.verificado]), [['902 - Buenos Aires', 100, true], ['921 - Santa Fe', 300, true]]);
    const c = panelMes(out, '2026-09', { hoy: '2026-10-29', paramsFile: path.join(out, 'x.json') }).iibb.conciliacion;
    assert.deepEqual(c.filas.filter((f) => f.aPagar > 0).map((f) => [f.jurisdiccion, f.estado]), [['Buenos Aires', 'Pagado'], ['Córdoba', 'Sin pagos informados por SIFERE'], ['Santa Fe', 'Pagado']]);
    assert.equal(c.avisos.length, 1); assert.match(c.avisos[0], /trajo menos pagos.*se conservan/);
    // Una lectura con MÁS pagos (Córdoba aparece) sí reemplaza, sin perder los anteriores.
    sim.pagos = { 902: [['202609', '902 - Buenos Aires', '14/10/2026', '100,00', 'Pagado', '555000111']], 904: [['202609', '904 - Córdoba', '16/10/2026', '200,00', 'Pagado', '555000112']],
      921: [['202609', '921 - Santa Fe', '15/10/2026', '300,00', 'Pagado', '555000113']] };
    const r3 = await correrConsultas(ctx, sim, out, 'corrida3');
    assert.equal(r3.conservacion.find((x) => x.id === 'sifere-consultas-web-pagos').promovido, true);
    assert.equal(pagosConsultasIibb(datosDir, '2026-09').pagos.length, 3);
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('SIFERE Consultas (simulado): con una jurisdicción sin consulta confirmada la lectura no queda validada ni vigente', async (t) => {
  const b = await navegador(t); if (!b) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-c-'));
  try {
    if (!(await conCm03(out))) { t.skip('sin navegador para la CM03'); return; }
    const ctx = await b.newContext({ acceptDownloads: true });
    const sim = moduloSimulado(ctx, { sinOpcion: '921' }); await sim.rutear(); // Santa Fe no se puede elegir
    const r = await correrConsultas(ctx, sim, out, 'corrida');
    const sub = JSON.parse(fs.readFileSync(path.join(out, 'corrida', 'sifere-consultas-web', 'resultado.json'), 'utf8')).sub[0];
    assert.deepEqual(sub.consultas.map((c) => [c.jurisdiccion, c.estado]), [['Buenos Aires', 'consultada'], ['Córdoba', 'consultada'], ['Santa Fe', 'sin consulta confirmada']]);
    assert.equal(sub.calidad.validado, false); assert.equal(sub.calidad.nivel, 'obtenido');
    assert.ok(sub.calidad.motivos.some((m) => /Santa Fe/.test(m)), JSON.stringify(sub.calidad.motivos));
    assert.equal(r.conservacion.find((c) => c.id === 'sifere-consultas-web-pagos').promovido, false);
    assert.ok(!fs.existsSync(path.join(out, 'datos', 'sifere-consultas-web-pagos', 'vigente.json')), 'nada vigente');
    assert.ok(fs.existsSync(path.join(out, 'datos', 'sifere-consultas-web-pagos', 'intentos', 'corrida', 'sifere-consultas-web-pagos.csv')), 'queda como evidencia');
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

/**
 * Portal de ARCA SIMULADO con la sesión REAL (Sesion._abrirServicio): un enlace «SIFERE WEB - CONSULTAS» que abre una
 * pestaña nueva hacia el login de clave fiscal de ARCA (`href`), y el SSO, que redirige según `destinoSso(n)`.
 */
async function portalSimulado(b, out, { href, destinoSso }) {
  const { Sesion, URL_PORTAL } = await import('../src/portal/sesion.js');
  const ctx = await b.newContext({ acceptDownloads: true });
  const s = new Sesion({ outDir: out }, {}); s.browser = b; s.context = ctx; s.page = await ctx.newPage(); s.esperaLoginMs = 1000;
  // Primero (la de menor prioridad): nada de ARCA ni de COMARB sale a la red real; lo que no está simulado se corta.
  await ctx.route(/(afip|comarb|ca)\.gob\.ar/, (r) => r.abort());
  await ctx.route(URL_PORTAL, (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
    body: `<html><body><h1>Portal</h1><a href="https://auth.afip.gob.ar/contribuyente_/login.xhtml?action=SYSTEM&system=comarb_sifereweb_ddjj" target="_blank">SIFERE WEB - DDJJ</a>
      <a href="${href}" target="_blank">SIFERE WEB - CONSULTAS</a></body></html>` }));
  const sso = [];
  // El SSO entrega el acceso con un formulario que se envía solo (POST al sistema). Una redirección 302 no serviría: la
  // navegación redirigida no pasa por las rutas simuladas y saldría a la red real.
  await ctx.route('https://auth.afip.gob.ar/**', (r) => { const u = new URL(r.request().url()); sso.push(u.searchParams.get('system'));
    return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
      body: `<form method="post" action="${destinoSso(sso.length, u.searchParams.get('system'))}"><input type="hidden" name="token" value="simulado"></form><script>document.forms[0].submit()</script>` }); });
  return { s, ctx, sso };
}
const SSO_CONSULTAS = 'https://auth.afip.gob.ar/contribuyente_/login.xhtml?action=SYSTEM&system=comarb_sifereweb_consultas';

test('acceso a SIFERE Consultas: clasificación por pestaña propia, sin query ni datos en el recorrido', async () => {
  const { urlDeAcceso, tipoErrorRed, clasificarAcceso, paginaDeLaAccion } = await import('../src/portal/acceso.js');
  assert.equal(urlDeAcceso(`${SSO_CONSULTAS}&token=abc#x`), 'https://auth.afip.gob.ar/contribuyente_/login.xhtml?system=comarb_sifereweb_consultas');
  assert.equal(urlDeAcceso('https://app1.comarb.gob.ar/consultas/Pagos.do?cuit=20999999991&sign=xyz'), 'https://app1.comarb.gob.ar/consultas/Pagos.do');
  assert.equal(urlDeAcceso('chrome-error://chromewebdata/'), 'chrome-error');
  assert.deepEqual(['net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CONNECTION_RESET', 'net::ERR_FOO', null].map(tipoErrorRed),
    ['dns', 'tiempo agotado', 'certificado', 'conexión', 'otro', 'desconocido']);
  const host = /^https?:\/\/(?!www\.)[^/]+\.comarb\.gob\.ar\//i; const sistema = 'comarb_sifereweb_consultas';
  const ev = (url) => ({ tipo: 'respuesta', url });
  // El sistema de DDJJ cuando se pidió Consultas: acceso equivocado. Un sistema desconocido no se juzga.
  assert.equal(clasificarAcceso({ url: 'https://sifereweb.comarb.gob.ar/sifereweb/Inicio.do', eventos: [ev('https://auth.afip.gob.ar/contribuyente_/login.xhtml?system=comarb_sifereweb_ddjj')], hostModulo: host, sistema }).estado, 'acceso-equivocado');
  assert.equal(clasificarAcceso({ url: 'https://app1.comarb.gob.ar/c/Inicio.do', eventos: [ev('https://auth.afip.gob.ar/contribuyente_/login.xhtml?system=otro_nombre')], hostModulo: host, sistema }).estado, 'en-modulo');
  const e = clasificarAcceso({ url: 'chrome-error://chromewebdata/', eventos: [ev('https://auth.afip.gob.ar/contribuyente_/login.xhtml?system=comarb_sifereweb_consultas'),
    { tipo: 'fallo', url: 'https://app1.comarb.gob.ar/consultas/Login.do', metodo: 'POST', error: 'net::ERR_CONNECTION_TIMED_OUT' }], hostModulo: host, sistema });
  assert.deepEqual([e.estado, e.tipo, e.host, e.metodo], ['error-red', 'tiempo agotado', 'app1.comarb.gob.ar', 'POST']);
  assert.match(e.detalle, /app1\.comarb\.gob\.ar\/consultas\/Login\.do \(ERR_CONNECTION_TIMED_OUT: tiempo agotado\)/);
  assert.equal(clasificarAcceso({ url: 'https://auth.afip.gob.ar/contribuyente_/login.xhtml', hostModulo: host, sistema }).estado, 'login-pendiente');
  assert.equal(clasificarAcceso({ url: 'https://www.ca.gob.ar/', hostModulo: host, sistema }).estado, 'fuera-del-modulo', 'el sitio institucional no es el módulo');
  assert.equal(clasificarAcceso({ url: null, hostModulo: host, sistema }).estado, 'sin-pestana');
  assert.equal(clasificarAcceso({ url: 'https://app1.comarb.gob.ar/c/Inicio.do', hostModulo: host, sistema, titulo: 'SIFERE - Mantenimiento' }).estado, 'mantenimiento');
  // La pestaña de la acción: nunca una que ya estaba abierta.
  const vieja = { isClosed: () => false }; const nueva = { isClosed: () => false }; const portal = {};
  assert.equal(paginaDeLaAccion(portal, [nueva]), nueva, 'la pestaña nueva tardó y se devolvió la del portal');
  assert.equal(paginaDeLaAccion(nueva, [nueva]), nueva);
  assert.equal(paginaDeLaAccion(portal, []), portal, 'sin pestaña nueva: la que devolvió la apertura');
  assert.notEqual(paginaDeLaAccion(portal, [nueva]), vieja);
});

test('SIFERE Consultas (portal simulado): una pestaña de error AJENA (de antes) no hace fallar al servicio; se sigue el SSO de Consultas', async (t) => {
  const b = await navegador(t); if (!b) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-a-'));
  try {
    if (!(await conCm03(out))) { t.skip('sin navegador para la CM03'); return; }
    const { s, ctx, sso } = await portalSimulado(b, out, { href: SSO_CONSULTAS, destinoSso: () => 'https://consultas.comarb.gob.ar/consultas/Inicio.do' });
    const sim = moduloSimulado(ctx); await sim.rutear();
    // Una pestaña de COMARB que no cargó, abierta ANTES (como la que quedó de la corrida del 28/10).
    const vieja = await ctx.newPage(); await vieja.goto('http://app1.comarb.invalid/', { timeout: 15000 }).catch(() => {});
    await vieja.waitForURL(/^chrome-error:/, { timeout: 10000 }).catch(() => {});
    assert.match(vieja.url(), /^chrome-error:/);
    const logs = [];
    const r = await correrUno(s, { ...SERVICIOS.find((x) => x.id === 'sifere-consultas-web') },
      { baseDir: path.join(out, 'corrida'), periodo: { desde: '2026-09-01', hasta: '2026-10-28' }, datosDir: path.join(out, 'datos'), log: (m) => logs.push(m) });
    assert.deepEqual(sso, ['comarb_sifereweb_consultas'], 'se pidió el sistema de Consultas, no el de DDJJ');
    assert.deepEqual(r.acceso.map((a) => [a.via, a.estado]), [['portal de ARCA', 'en-modulo']], logs.join('\n'));
    const res = JSON.parse(fs.readFileSync(path.join(out, 'corrida', 'sifere-consultas-web', 'resultado.json'), 'utf8'));
    assert.deepEqual(res.acceso[0].cadena, ['https://auth.afip.gob.ar/contribuyente_/login.xhtml?system=comarb_sifereweb_consultas', 'https://consultas.comarb.gob.ar/consultas/Inicio.do']);
    assert.ok(r.conservacion.some((c) => c.promovido), JSON.stringify(r.validaciones));
    assert.ok(!vieja.isClosed(), 'la pestaña ajena no se toca');
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('SIFERE Consultas (portal simulado): si el acceso del portal no carga, se prueba UNA vez el acceso oficial (SSO) y se informa el error de red', async (t) => {
  const b = await navegador(t); if (!b) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-a-'));
  try {
    if (!(await conCm03(out))) { t.skip('sin navegador para la CM03'); return; }
    // La primera redirección del SSO va a un host que no carga; la segunda, al módulo.
    const { s, ctx, sso } = await portalSimulado(b, out, { href: SSO_CONSULTAS,
      destinoSso: (n) => (n === 1 ? 'https://app1.comarb.invalid/consultas/Login.do' : 'https://consultas.comarb.gob.ar/consultas/Inicio.do') });
    const sim = moduloSimulado(ctx); await sim.rutear();
    const r = await correrUno(s, { ...SERVICIOS.find((x) => x.id === 'sifere-consultas-web') },
      { baseDir: path.join(out, 'corrida'), periodo: { desde: '2026-09-01', hasta: '2026-10-28' }, datosDir: path.join(out, 'datos') });
    assert.deepEqual(sso, ['comarb_sifereweb_consultas', 'comarb_sifereweb_consultas']);
    assert.deepEqual(r.acceso.map((a) => [a.via, a.estado]), [['portal de ARCA', 'error-red'], ['acceso oficial (SSO)', 'en-modulo']]);
    assert.match(r.acceso[0].detalle, /app1\.comarb\.invalid\/consultas\/Login\.do \(ERR_/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'corrida', 'sifere-consultas-web', 'resultado.json'), 'utf8')).acceso[0].metodo, 'POST');
    assert.ok(r.conservacion.some((c) => c.promovido));
    assert.ok(!ctx.pages().some((p) => /^chrome-error:/.test(p.url())), 'la pestaña con error de ESTE acceso se cerró');
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('SIFERE Consultas (portal simulado): un acceso que pide el sistema de DDJJ es un acceso equivocado; se usa el de Consultas', async (t) => {
  const b = await navegador(t); if (!b) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-a-'));
  try {
    if (!(await conCm03(out))) { t.skip('sin navegador para la CM03'); return; }
    const { s, ctx, sso } = await portalSimulado(b, out, { href: 'https://auth.afip.gob.ar/contribuyente_/login.xhtml?action=SYSTEM&system=comarb_sifereweb_ddjj',
      destinoSso: (n, sistema) => (sistema === 'comarb_sifereweb_ddjj' ? 'https://sifereweb.comarb.gob.ar/sifereweb/Inicio.do' : 'https://consultas.comarb.gob.ar/consultas/Inicio.do') });
    await ctx.route('https://sifereweb.comarb.gob.ar/**', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<h1>SIFERE WEB - DDJJ</h1>' }));
    const sim = moduloSimulado(ctx); await sim.rutear();
    const r = await correrUno(s, { ...SERVICIOS.find((x) => x.id === 'sifere-consultas-web') },
      { baseDir: path.join(out, 'corrida'), periodo: { desde: '2026-09-01', hasta: '2026-10-28' }, datosDir: path.join(out, 'datos') });
    assert.deepEqual(sso, ['comarb_sifereweb_ddjj', 'comarb_sifereweb_consultas']);
    assert.deepEqual(r.acceso.map((a) => [a.via, a.estado]), [['portal de ARCA', 'acceso-equivocado'], ['acceso oficial (SSO)', 'en-modulo']]);
    assert.ok(r.conservacion.some((c) => c.promovido));
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
