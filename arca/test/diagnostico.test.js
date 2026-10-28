import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizarHtml, sanitizarUrl, sanitizarTexto } from '../src/portal/diagnostico.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('el HTML saneado no conserva scripts, valores de inputs, ViewState, CUIT ni importes', () => {
  const html = `<html><script>var token="abc"</script><form><input name="javax.faces.ViewState" value="-123:-456"><input id="F1:password" value="secreta"><td>20-35354477-3</td><td>$ 63.871.446,29</td><td>CUIT 20353544773</td></form></html>`;
  const out = sanitizarHtml(html);
  assert.doesNotMatch(out, /abc|secreta|-123:-456|35354477|871\.446/);
  assert.match(out, /20-XXXXXXXX-3/);
  assert.match(out, /\[importe\]/);
  assert.match(out, /value="\[omitido\]"/);
});

test('las URLs de red se guardan sin query string', () => {
  assert.equal(sanitizarUrl('https://fes.afip.gob.ar/mcmp/jsp/x.do?token=abc&cuit=20353544773'), 'https://fes.afip.gob.ar/mcmp/jsp/x.do');
  assert.equal(sanitizarUrl('no es url'), '[url]');
});

test('el texto de estructura enmascara CUIT', () => {
  assert.equal(sanitizarTexto('Representado: 20353544773'), 'Representado: 20-XXXXXXXX-3');
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
  assert.equal(enmascararMuestra('$ 45.000,00 · 1234,56 · 20-12345678-3 · 14/10/2026 · 202609 · Trans 1199249012'), '[importe] · [importe] · 20-XXXXXXXX-3 · 14/10/2026 · 202609 · Trans [número]');
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
