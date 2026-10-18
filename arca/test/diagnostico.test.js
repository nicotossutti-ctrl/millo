import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('git ignora todo lo que la capa de portal escribe en disco', () => {
  const rutas = ['out/diagnostico/x/pantalla.png', 'out/diagnostico/x/pagina.html', 'out/descargas/a.csv', 'out/portal/mis-comprobantes.csv', '.sesion/20111111112.json', 'certs/arca.key', '.env', '.ta/prod-wsfe.json', 'params/contribuyente.json'];
  for (const r of rutas) {
    const res = execFileSync('git', ['check-ignore', '-q', r], { cwd: raiz, stdio: ['ignore', 'ignore', 'ignore'], encoding: 'utf8', shell: false, env: process.env }) ?? '';
    assert.ok(res !== null, `${r} no está ignorado`);
  }
});
