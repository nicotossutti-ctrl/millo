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
import { relevarPagina, resumenRelevamiento } from './relevar.js';
import { URL_PORTAL } from './sesion.js';

const MASCARA_CUIT = /\b(\d{2})-?\d{8}-?(\d)\b/g;
const MASCARA_IMPORTE = /\$?\s?\d{1,3}(\.\d{3})+(,\d{2})?/g;

// Datos personales ROTULADOS en las pantallas (CCMA: «Apellido y Nombre: …», «Domicilio: …»): se conserva el rótulo.
const DATO_PERSONAL = /\b(apellidos?\s+y\s+nombres?|nombres?\s+y\s+apellidos?|raz[oó]n\s+social|denominaci[oó]n|domicilio(?:\s+fiscal)?|direcci[oó]n|tel[eé]fono|e-?mail|correo(?:\s+electr[oó]nico)?)\s*:\s*[^|<>\n]+/gi;
// Nombre en mayúsculas pegado a un CUIT ya enmascarado, como en las barras de los sistemas («APELLIDO NOMBRE [20-XXXXXXXX-3]»).
const NOMBRE_JUNTO_A_CUIT = /[A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ,.'-]*(?:\s+[A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ,.'-]*){0,5}\s*\[\s*(?:CUIT\s*)?(\d{2}-X{8}-\d)/g;
const sinDatosPersonales = (t) => t.replace(DATO_PERSONAL, '$1: [omitido]').replace(NOMBRE_JUNTO_A_CUIT, '[nombre] [$1');

// Parámetros sueltos (?token=…, &vep=…) que quedan en texto o en referencias relativas.
const PARAMETRO = /([?&])[\w.\-[\]%]+=[^\s"'<>&]*/g;

/**
 * HTML sin scripts, valores, manejadores ni referencias con datos. Tolera fragmentos cortados (p. ej. los primeros
 * 200 caracteres de un elemento): un atributo sin comilla de cierre se sanea hasta el final igual.
 */
export function sanitizarHtml(html) {
  return String(html ?? '')
    // Manejadores en línea (onclick="generarVEP(…, número)"), con o sin comillas y aunque estén cortados.
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"?|'[^']*'?|[^\s>]*)/gi, '')
    // Referencias (href, src, srcset, action, formaction, data-url…): sin query, fragmento ni javascript:.
    .replace(/(\s)([\w:-]*?(?:href|src|srcset|action|url))\s*=\s*(?:"([^"]*)"?|'([^']*)'?|([^\s>"']+))/gi,
      (_, esp, at, a, b, c) => `${esp}${at}="${sanitizarReferencia(a ?? b ?? c)}"`)
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style>|$)/gi, '')
    .replace(/(<input\b[^>]*\s)value\s*=\s*(?:"[^"]*"?|'[^']*'?|[^\s>]*)/gi, '$1value="[omitido]"')
    .replace(/(name|id)="(javax\.faces\.ViewState|[^"]*token[^"]*|[^"]*csrf[^"]*)"([^>]*)value="[^"]*"/gi, '$1="$2"$3value="[omitido]"')
    .replace(PARAMETRO, '$1[omitido]')
    .replace(MASCARA_CUIT, '$1-XXXXXXXX-$2')
    .replace(MASCARA_IMPORTE, '[importe]')
    .replace(/>([^<]+)</g, (_, t) => `>${sinDatosPersonales(t)}<`);
}

export function sanitizarTexto(t) {
  return t == null ? t : String(t).replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1').replace(PARAMETRO, '$1[omitido]')
    .replace(MASCARA_CUIT, '$1-XXXXXXXX-$2').replace(MASCARA_IMPORTE, '[importe]').replace(/[^]*/, sinDatosPersonales);
}

export function sanitizarUrl(u) {
  try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return '[url]'; }
}

/**
 * Cualquier referencia (href, src, action, url) sin nada que pueda identificar una sesión o un dato: absolutas y
 * protocolo-relativas quedan en origen + ruta; relativas y fragmentos pierden query y fragmento (?token=…, #…);
 * javascript:, data:, blob:, mailto: y tel: no se conservan (pueden llevar números de VEP, CUIT o datos).
 */
export function sanitizarReferencia(v) {
  if (v == null) return v;
  const s = String(v).trim();
  if (!s) return s;
  if (/^https?:/i.test(s)) return sanitizarUrl(s);
  if (s.startsWith('//')) { const r = sanitizarUrl(`https:${s}`); return r === '[url]' ? r : r.replace(/^https:/, ''); }
  const esquema = s.match(/^([a-z][a-z0-9+.-]*):/i);
  if (esquema) return `${esquema[1].toLowerCase()}:[omitido]`;
  const base = s.split(/[?#]/)[0];
  return sanitizarTexto(base || (s.startsWith('#') ? '#' : ''));
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
      const estructura = await relevarPagina(pagina);
      escribirProtegido(path.join(dir, 'estructura.json'), JSON.stringify(estructura, null, 2));
      escribirProtegido(path.join(dir, 'resumen.txt'), resumenRelevamiento(estructura).join('\n'));
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

/**
 * Inspección de la página principal del portal, sin depender de ningún buscador ni menú:
 * releva documento, frames y shadow DOM, guarda estructura y HTML saneados en
 * out/diagnostico/portal/ y devuelve un resumen para pegar en el chat.
 */
export async function inspeccionarPortal(sesion, { outDir = 'out/diagnostico', sinCapturas = false, log = () => {} } = {}) {
  const dir = path.join(outDir, 'portal');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { page } = sesion;
  const red = [];
  const onReq = (req) => red.push({ method: req.method(), url: sanitizarUrl(req.url()), type: req.resourceType() });
  sesion.context.on('request', onReq);
  try {
    await page.goto(URL_PORTAL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(4000); // el portal es una SPA: dejamos que termine de pintar
    const rel = await relevarPagina(page);
    escribirProtegido(path.join(dir, 'estructura.json'), JSON.stringify(rel, null, 2));
    escribirProtegido(path.join(dir, 'pagina.html'), sanitizarHtml(await page.content()));
    for (const [i, frame] of page.frames().entries()) {
      if (frame === page.mainFrame()) continue;
      const html = await frame.content().catch(() => null);
      if (html) escribirProtegido(path.join(dir, `frame-${i}.html`), sanitizarHtml(html));
    }
    if (!sinCapturas) { await page.screenshot({ path: path.join(dir, 'pantalla.png'), fullPage: true }); fs.chmodSync(path.join(dir, 'pantalla.png'), 0o600); }
    const resumen = resumenRelevamiento(rel);
    escribirProtegido(path.join(dir, 'resumen.txt'), resumen.join('\n'));
    for (const l of resumen) log(l);
    return rel;
  } finally {
    sesion.context.off('request', onReq);
    escribirProtegido(path.join(dir, 'red.json'), JSON.stringify(red.filter((r) => !/\.(png|jpg|gif|css|woff2?|svg|ico)$/.test(r.url)), null, 2));
  }
}

/** Borra todo lo que la capa de portal guarda en disco: diagnóstico, descargas y sesión. */
export function limpiar({ outDir = 'out', sesionDir = '.sesion' } = {}) {
  const borrados = [];
  for (const d of [path.join(outDir, 'diagnostico'), path.join(outDir, 'descargas'), path.join(outDir, 'portal'), sesionDir]) {
    if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true, force: true }); borrados.push(d); }
  }
  return borrados;
}
