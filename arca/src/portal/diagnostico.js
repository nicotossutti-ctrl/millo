/**
 * Modo diagnóstico: entra a cada servicio del portal y guarda captura, HTML y las URLs de red
 * en out/diagnostico/<servicio>/. Con eso se escriben los selectores exactos de cada extractor
 * sin adivinar.
 *
 * Protección de lo que se guarda:
 * - Carpetas 0700 y archivos 0600. `out/` entero está en .gitignore (test/gitignore.test.js lo
 *   verifica en cada corrida de tests).
 * - HTML: se eliminan scripts, valores de inputs, cookies y tokens de formulario; los CUIT y
 *   los importes se enmascaran.
 * - Red: solo método, host y ruta. Sin query string, sin encabezados, sin cuerpos.
 * - Capturas: muestran lo que muestra la pantalla; se pueden omitir con --sin-capturas.
 */
import fs from 'node:fs';
import path from 'node:path';

const MASCARA_CUIT = /\b(\d{2})-?\d{8}-?(\d)\b/g;
const MASCARA_IMPORTE = /\$?\s?\d{1,3}(\.\d{3})+(,\d{2})?/g;

export function sanitizarHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/(<input\b[^>]*\s)value="[^"]*"/gi, '$1value="[omitido]"')
    .replace(/(name|id)="(javax\.faces\.ViewState|[^"]*token[^"]*|[^"]*csrf[^"]*)"([^>]*)value="[^"]*"/gi, '$1="$2"$3value="[omitido]"')
    .replace(MASCARA_CUIT, '$1-XXXXXXXX-$2')
    .replace(MASCARA_IMPORTE, '[importe]');
}

export function sanitizarTexto(t) {
  return t == null ? t : String(t).replace(MASCARA_CUIT, '$1-XXXXXXXX-$2').replace(MASCARA_IMPORTE, '[importe]');
}

export function sanitizarUrl(u) {
  try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return '[url]'; }
}

function escribirProtegido(file, contenido) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contenido, { mode: 0o600 });
}

export const SERVICIOS = [
  'Mis Comprobantes',
  'Portal IVA',
  'Mis Retenciones',
  'Sistema de Cuentas Tributarias',
  'Presentación de DDJJ y Pagos',
  'CCMA - Cuenta Corriente de Monotributistas y Autónomos',
  'Convenio Multilateral – SIFERE WEB - DDJJ',
  'Convenio Multilateral - SIFERE WEB - Consultas',
  'Mis Aplicaciones Web',
  'Ventanilla Electrónica',
];

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

export async function diagnosticar(sesion, { servicios = SERVICIOS, outDir = 'out/diagnostico', sinCapturas = false, log = () => {} } = {}) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const resumen = [];
  for (const nombre of servicios) {
    const dir = path.join(outDir, slug(nombre));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const red = [];
    const onReq = (req) => red.push({ method: req.method(), url: sanitizarUrl(req.url()), type: req.resourceType() });
    sesion.context.on('request', onReq);
    const item = { servicio: nombre, ok: false, url: null, error: null };
    try {
      const pagina = await sesion.abrirServicio(nombre);
      await pagina.waitForTimeout(3000);
      item.url = sanitizarUrl(pagina.url());
      if (!sinCapturas) { await pagina.screenshot({ path: path.join(dir, 'pantalla.png'), fullPage: true }); fs.chmodSync(path.join(dir, 'pantalla.png'), 0o600); }
      escribirProtegido(path.join(dir, 'pagina.html'), sanitizarHtml(await pagina.content()));
      // formularios, inputs, botones y links: lo que hace falta para escribir selectores
      const estructura = await pagina.evaluate(() => {
        const q = (sel) => [...document.querySelectorAll(sel)].slice(0, 300).map((e) => ({
          tag: e.tagName.toLowerCase(), id: e.id || null, name: e.getAttribute('name'), type: e.getAttribute('type'),
          // inputs: nunca su valor; botones y links: su texto
          text: /^(input|select|textarea)$/i.test(e.tagName) ? null : (e.innerText || '').trim().slice(0, 80) || null,
          placeholder: e.getAttribute('placeholder'), href: e.getAttribute('href'), cls: e.className?.toString().slice(0, 80) || null,
        }));
        return { title: document.title, forms: q('form'), inputs: q('input, select, textarea'), botones: q('button, input[type=submit], a.btn, [role=button]'), links: q('a[href]'), iframes: q('iframe') };
      });
      escribirProtegido(path.join(dir, 'estructura.json'), sanitizarTexto(JSON.stringify(estructura, null, 2)));
      item.ok = true;
      if (pagina !== sesion.page) await pagina.close();
    } catch (e) {
      item.error = e.message;
      if (!sinCapturas) await sesion.page.screenshot({ path: path.join(dir, 'error.png'), fullPage: true }).then(() => fs.chmodSync(path.join(dir, 'error.png'), 0o600)).catch(() => {});
    } finally {
      sesion.context.off('request', onReq);
      escribirProtegido(path.join(dir, 'red.json'), JSON.stringify(red.filter((r) => !/\.(png|jpg|gif|css|woff2?|svg|ico)$/.test(r.url)), null, 2));
    }
    log(`${item.ok ? 'OK ' : 'ERR'} ${nombre}${item.error ? `: ${item.error}` : ''}`);
    resumen.push(item);
  }
  escribirProtegido(path.join(outDir, 'resumen.json'), JSON.stringify(resumen.map((r) => ({ ...r, error: sanitizarTexto(r.error) })), null, 2));
  return resumen;
}

/** Borra todo lo que la capa de portal guarda en disco: diagnóstico, descargas y sesión. */
export function limpiar({ outDir = 'out', sesionDir = '.sesion' } = {}) {
  const borrados = [];
  for (const d of [path.join(outDir, 'diagnostico'), path.join(outDir, 'descargas'), path.join(outDir, 'portal'), sesionDir]) {
    if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true, force: true }); borrados.push(d); }
  }
  return borrados;
}
