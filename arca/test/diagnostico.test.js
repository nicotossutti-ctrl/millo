import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { sanitizarHtml, sanitizarUrl, sanitizarTexto } from '../src/portal/diagnostico.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('el HTML saneado no conserva scripts, valores de inputs, ViewState, CUIT ni importes', () => {
  const html = `<html><script>var token="abc"</script><form><input name="javax.faces.ViewState" value="-123:-456"><input id="F1:password" value="secreta"><td>20-11111111-2</td><td>$ 12.345.678,90</td><td>CUIT 20111111112</td></form></html>`;
  const out = sanitizarHtml(html);
  assert.doesNotMatch(out, /abc|secreta|-123:-456|11111111|345\.678/);
  assert.match(out, /20-XXXXXXXX-2/);
  assert.match(out, /\[importe\]/);
  assert.match(out, /value="\[omitido\]"/);
});

test('las URLs de red se guardan sin query string', () => {
  assert.equal(sanitizarUrl('https://fes.afip.gob.ar/mcmp/jsp/x.do?token=abc&cuit=20111111112'), 'https://fes.afip.gob.ar/mcmp/jsp/x.do');
  assert.equal(sanitizarUrl('no es url'), '[url]');
});

test('el texto de estructura enmascara CUIT', () => {
  assert.equal(sanitizarTexto('Representado: 20111111112'), 'Representado: 20-XXXXXXXX-2');
  assert.equal(sanitizarTexto(null), null);
});

const RUTAS_SENSIBLES = ['out/diagnostico/x/pantalla.png', 'out/diagnostico/x/pagina.html', 'out/descargas/a.csv', 'out/portal/mis-comprobantes.csv', '.sesion/20111111112.json', 'certs/arca.key', '.env', '.ta/prod-wsfe.json', 'params/contribuyente.json'];

let hayGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hayGit = false; }

test('git ignora todo lo que la capa de portal escribe en disco', { skip: !hayGit && 'sin git en este equipo: se verifica el .gitignore directamente' }, () => {
  for (const r of RUTAS_SENSIBLES) {
    let ignorado = true;
    try { execFileSync('git', ['check-ignore', '-q', r], { cwd: raiz, stdio: 'ignore' }); } catch { ignorado = false; }
    assert.ok(ignorado, `${r} no está ignorado por git`);
  }
});

test('el .gitignore declara cada ruta sensible (no requiere git)', () => {
  const reglas = fs.readFileSync(path.join(raiz, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
  const cubre = (ruta) => reglas.some((regla) => {
    const base = regla.replace(/\/\*?$/, '');          // "out/*" y ".sesion/" -> "out", ".sesion"
    return ruta === regla || ruta === base || ruta.startsWith(`${base}/`);
  });
  for (const r of RUTAS_SENSIBLES) assert.ok(cubre(r), `${r} no está cubierto por .gitignore`);
});

// ---------------- Muestra de filas en el relevamiento (navegador real, si hay) ----------------
test('relevamiento: muestra enmascarada de las primeras filas y de las acciones de cada fila', async (t) => {
  const { relevarPagina, enmascararMuestra, resumenRelevamiento } = await import('../src/portal/relevar.js');
  assert.equal(enmascararMuestra('$ 45.000,00 · 1234,56 · 20-12345678-3 · 14/10/2026 · 202609 · Trans 1234567890'), '[importe] · [importe] · 20-XXXXXXXX-3 · 14/10/2026 · 202609 · Trans [número]');
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { t.skip('sin Playwright'); return; }
  let b;
  try { b = await chromium.launch(process.env.FISCALOS_CHROMIUM ? { executablePath: process.env.FISCALOS_CHROMIUM } : {}); } catch { t.skip('sin navegador'); return; }
  try {
    const pg = await b.newPage();
    // Como CCMA (sin <th>: el encabezado es la primera fila) y como la lista de DJ de SIFERE (acciones con imágenes).
    await pg.setContent(`<table id="cc"><tr><td>Período</td><td>Concepto</td><td>Debe</td></tr><tr><td>09/2026</td><td>Cuota</td><td>95000,00</td></tr></table>
      <table id="dj"><thead><tr><th>Acciones</th><th>Anticipo</th></tr></thead><tbody><tr><td><a href="#"><img src="/img/lupa.gif" title="Ver DDJJ"></a><img src="x/imprimir.png" alt="Imprimir"></td><td>202609 - 0</td></tr></tbody></table>`);
    const rel = await relevarPagina(pg);
    const [cc, dj] = rel.frames[0].tablas;
    assert.deepEqual(cc.muestra.map((f) => f.map((c) => c.texto)), [['Período', 'Concepto', 'Debe'], ['09/2026', 'Cuota', '[importe]']]);
    const acciones = dj.muestra[1][0].controles;
    assert.deepEqual(acciones.filter((x) => x.tag === 'img').map((x) => x.title ?? x.alt), ['Ver DDJJ', 'Imprimir']);
    assert.ok(resumenRelevamiento(rel).some((l) => /fila: .*\[img: Ver DDJJ\]/.test(l)));
  } finally { await b.close(); }
});

test('referencias saneadas: absolutas y relativas sin query ni fragmento; javascript:, data: y onclick no se conservan', async () => {
  const { sanitizarReferencia } = await import('../src/portal/diagnostico.js');
  assert.equal(sanitizarReferencia('https://sifereweb.comarb.gob.ar/x/Lista.do?token=SECRETO&cuit=20123456783#a'), 'https://sifereweb.comarb.gob.ar/x/Lista.do');
  assert.equal(sanitizarReferencia('/consulta?token=SECRETO&cuit=20123456783'), '/consulta');
  assert.equal(sanitizarReferencia('detalle.aspx?id=555000111#top'), 'detalle.aspx');
  assert.equal(sanitizarReferencia('#/declaraciones?sesion=abc'), '#');
  assert.equal(sanitizarReferencia('//cdn.afip.gob.ar/a.js?v=1'), '//cdn.afip.gob.ar/a.js');
  assert.equal(sanitizarReferencia('javascript:generarVEP(window.document.formu,555000111);'), 'javascript:[omitido]');
  assert.equal(sanitizarReferencia('data:image/png;base64,AAAA'), 'data:[omitido]');
  assert.equal(sanitizarReferencia('mailto:alguien@ejemplo.com'), 'mailto:[omitido]');
  assert.equal(sanitizarTexto('ver https://x.gob.ar/a?token=SECRETO y listo'), 'ver https://x.gob.ar/a y listo');
  const html = sanitizarHtml(`<a href="/p?token=SECRETO">x</a><a href='javascript:generarVEP(f,555000111)' onclick="generarVEP(f,555000111)">v</a><form action="enviar.do?sesion=1"></form><img src="i.png?k=2">`);
  assert.doesNotMatch(html, /SECRETO|555000111|sesion=|k=2/);
  assert.match(html, /href="\/p"/); assert.match(html, /action="enviar\.do"/); assert.match(html, /href="javascript:\[omitido\]"/);
});

test('relevamiento: ninguna URL del diagnóstico conserva query, fragmento ni javascript (navegador real, si hay)', async (t) => {
  const { relevarPagina, resumenRelevamiento } = await import('../src/portal/relevar.js');
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { t.skip('sin Playwright'); return; }
  let b;
  try { b = await chromium.launch(process.env.FISCALOS_CHROMIUM ? { executablePath: process.env.FISCALOS_CHROMIUM } : {}); } catch { t.skip('sin navegador'); return; }
  try {
    const pg = await b.newPage();
    await pg.setContent(`<a href="/consulta?token=SECRETO&cuit=20123456783">Consulta</a><a href="#/x?sesion=SECRETO">Ancla</a>
      <a href="javascript:generarVEP(f,555000111)">VEP</a><form action="/enviar?token=SECRETO"><input type="text" value="SECRETO"></form>
      <iframe src="/frame?token=SECRETO"></iframe><table><tr><td><a href="detalle.do?id=555000111" title="Ver"><img src="lupa.gif?token=SECRETO" alt="Ver"></a></td></tr></table>`);
    const rel = await relevarPagina(pg);
    const todo = JSON.stringify(rel) + resumenRelevamiento(rel).join('\n');
    assert.doesNotMatch(todo, /SECRETO|555000111|20123456783|sesion=|token=/);
  } finally { await b.close(); }
});

test('paso de ruta no encontrado: el bloque de candidatos no conserva parámetros de enlaces relativos (estructura.json y diagnóstico integral)', async (t) => {
  const { ejecutarTodo } = await import('../src/portal/orquestador.js');
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { t.skip('sin Playwright'); return; }
  let b;
  try { b = await chromium.launch(process.env.FISCALOS_CHROMIUM ? { executablePath: process.env.FISCALOS_CHROMIUM } : {}); } catch { t.skip('sin navegador'); return; }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiscalos-paso-'));
  try {
    const pg = await b.newPage();
    // El texto de la ruta está solo en elementos ocultos (el paso no se encuentra) y sus enlaces llevan datos: relativos,
    // con fragmento, javascript:, onclick y un HTML largo que se corta en el medio del href (sin comilla de cierre).
    const relleno = 'A'.repeat(300);
    await pg.setContent(`<div style="display:none">
      <a class="m" href="consultas.do?token=SECRETO&vep=555000111&relleno=${relleno}">Consultas</a>
      <a href="#/consultas?sesion=SECRETO" onclick="ir(555000111)">Consultas</a>
      <a href="javascript:abrir('SECRETO', 1234567890)">Consultas</a>
      <span data-url="/x/consultas?token=SECRETO">Consultas</span></div><p>Inicio</p>`);
    const sesion = { page: pg, cfg: { outDir }, abrirServicio: async () => pg };
    const servicio = { id: 'prueba-paso', nombre: 'Prueba', fuente: 'prueba', confirmado: false, ruta: [{ texto: 'Consultas' }] };
    const { baseDir, resultados } = await ejecutarTodo(sesion, { servicios: [servicio], outDir: path.join(outDir, 'corridas'), datosDir: path.join(outDir, 'datos'), periodo: { desde: '2026-09-01', hasta: '2026-09-30' } });
    assert.match(resultados[0].motivo ?? resultados[0].error ?? JSON.stringify(resultados[0]), /no se encontró el paso/);
    const estructura = fs.readFileSync(path.join(baseDir, 'prueba-paso', 'estructura.json'), 'utf8');
    const integral = fs.readFileSync(path.join(baseDir, 'diagnostico-integral.json'), 'utf8');
    const paso = JSON.parse(estructura).find((x) => x.diagnosticoPaso)?.diagnosticoPaso;
    assert.ok(paso && Object.values(paso.frames[0].candidatos)[0].length >= 3, 'el bloque de candidatos se guardó');
    for (const txt of [estructura, integral]) {
      assert.doesNotMatch(txt, /SECRETO|555000111|1234567890|token=|vep=|sesion=|onclick=/);
      assert.match(txt, /consultas\.do/);
    }
  } finally { await b.close(); fs.rmSync(outDir, { recursive: true, force: true }); }
});

test('HTML cortado: un atributo sin comilla de cierre igual pierde query, manejadores y protocolos con datos', () => {
  const corte = (s) => sanitizarHtml(s);
  assert.doesNotMatch(corte('<a class="x" href="detalle.do?token=SECRETO&id=1'), /SECRETO|token=/);
  assert.doesNotMatch(corte('<a href=\'/r?vep=SECRETO'), /SECRETO/);
  assert.doesNotMatch(corte('<a href=/r?vep=SECRETO>x</a>'), /SECRETO/);
  assert.doesNotMatch(corte('<a onclick="generarVEP(f, SECRETO'), /SECRETO|onclick/);
  assert.doesNotMatch(corte('<button formaction="/a?token=SECRETO" data-url="b?x=SECRETO">'), /SECRETO/);
  assert.doesNotMatch(corte('<a href="javascript:ir(SECRETO'), /SECRETO/);
  assert.doesNotMatch(corte('texto suelto /ruta.do?token=SECRETO'), /SECRETO/);
  assert.match(corte('<a href="detalle.do?token=SECRETO'), /href="detalle\.do"/);
});

test('datos personales rotulados (CCMA) y el nombre junto al CUIT en las barras: no quedan en el diagnóstico', async (t) => {
  // Datos inventados.
  assert.equal(sanitizarTexto('Apellido y Nombre: PEREZ, JUAN'), 'Apellido y Nombre: [omitido]');
  assert.equal(sanitizarTexto('Domicilio: CALLE FALSA 123 - CAPITAL FEDERAL - 0'), 'Domicilio: [omitido]');
  assert.doesNotMatch(sanitizarTexto('PRESENTACIÓN DE DDJJ Y PAGOS PEREZ JUAN[20111111112] TN'), /PEREZ|JUAN/);
  assert.doesNotMatch(sanitizarTexto('PORTAL INTEGRADO PEREZ JUAN [CUIT 20-11111111-2]'), /PEREZ|JUAN/);
  assert.equal(sanitizarTexto('Tipo de Contribuyente: MONOTRIBUTISTA | AUTONOMO'), 'Tipo de Contribuyente: MONOTRIBUTISTA | AUTONOMO', 'lo no personal queda');
  assert.doesNotMatch(sanitizarHtml('<td>Apellido y Nombre: PEREZ, JUAN</td><td>Domicilio: CALLE 1</td>'), /PEREZ|CALLE 1/);
  const { relevarPagina, resumenRelevamiento } = await import('../src/portal/relevar.js');
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { t.skip('sin Playwright'); return; }
  let b;
  try { b = await chromium.launch(process.env.FISCALOS_CHROMIUM ? { executablePath: process.env.FISCALOS_CHROMIUM } : {}); } catch { t.skip('sin navegador'); return; }
  try {
    const pg = await b.newPage();
    await pg.setContent(`<nav>SISTEMA PEREZ JUAN[20111111112]</nav><table><tr><td>CUIT: 20-11111111-2</td><td>Tipo de Contribuyente: AUTONOMO</td></tr>
      <tr><td>Apellido y Nombre: PEREZ, JUAN</td><td></td></tr><tr><td>Domicilio: CALLE FALSA 123 - CAPITAL FEDERAL - 0</td></tr></table>`);
    const rel = await relevarPagina(pg);
    assert.doesNotMatch(JSON.stringify(rel) + resumenRelevamiento(rel).join('\n'), /PEREZ|JUAN|FALSA|11111111/);
  } finally { await b.close(); }
});

test('CUIT pegado a texto (como en las opciones de SETI): también se enmascara, en texto, HTML y relevamiento', async (t) => {
  // CUIT inventados.
  for (const x of ['TODOS20999999991', 'CUIT 20999999991', '20-99999999-1', 'x20999999991y']) assert.doesNotMatch(sanitizarTexto(x), /99999999/, x);
  assert.doesNotMatch(sanitizarHtml('<option>TODOS20999999991</option>'), /99999999/);
  assert.match(sanitizarTexto('202609 y 1234567890123'), /202609/, 'un período o un número de otra longitud no se toca');
  const { relevarPagina } = await import('../src/portal/relevar.js');
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { t.skip('sin Playwright'); return; }
  let b;
  try { b = await chromium.launch(process.env.FISCALOS_CHROMIUM ? { executablePath: process.env.FISCALOS_CHROMIUM } : {}); } catch { t.skip('sin navegador'); return; }
  try {
    const pg = await b.newPage();
    await pg.setContent('<select><option>TODOS20999999991</option></select><ul role="listbox"><li>TODOS20999999991</li></ul><p>20-99999999-1</p>');
    assert.doesNotMatch(JSON.stringify(await relevarPagina(pg)), /99999999/);
  } finally { await b.close(); }
});
