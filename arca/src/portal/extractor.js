/**
 * Extractor de tabla genérico, SOLO LECTURA. Para servicios que muestran los datos en una
 * grilla (Mis Retenciones, Cuentas Tributarias dentro de un iframe, Mis Facilidades):
 *   1. abre el servicio,
 *   2. si hay filtros de fecha, los completa con el período y pulsa Consultar/Buscar,
 *   3. lee la tabla de resultados recorriendo la paginación,
 *   4. guarda un CSV propio (formato estable, no depende de la exportación de ARCA) y,
 *      si ARCA informa un total, lo coteja.
 * Nunca presenta, paga, emite ni modifica: los únicos clics permitidos son filtros de fecha,
 * Consultar/Buscar y la paginación. Cualquier control de trámite está vetado por lista.
 */
import fs from 'node:fs';
import path from 'node:path';
import { relevarPagina } from './relevar.js';
import { totalInformado, resumenResultados } from './misComprobantes.js';
import { toCsv } from '../csv.js';

// Textos de controles que NUNCA se tocan (trámite, pago, emisión, modificación).
export const PROHIBIDO = /presentar|pagar|generar vep|\bvep\b|enviar|confirmar|eliminar|anular|modificar|dar de baja|adherir|solicitar plan/i;
/** true si un control no debe tocarse por ser de trámite, pago, emisión o modificación. */
export const esProhibido = (texto) => PROHIBIDO.test(texto ?? '');
const fechaArca = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

/** Elige la tabla con más filas de datos, en cualquier frame; devuelve {headers, rows}. */
function extraerTablaEnDocumento() {
  const visible = (e) => { try { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
  const texto = (c) => (c.innerText || c.textContent || '').trim().replace(/\s+/g, ' ');
  let mejor = null;
  for (const t of document.querySelectorAll('table')) {
    if (!visible(t)) continue;
    const trs = [...t.querySelectorAll('tr')];
    const headerCells = [...(t.querySelectorAll('thead th, thead td')[0] ? t.querySelectorAll('thead th, thead td') : (trs[0]?.querySelectorAll('th, td') ?? []))];
    const headers = headerCells.map((c) => texto(c).replace(/\s*\(.*?sort.*?\)\s*/i, ''));
    const bodyTrs = t.querySelector('tbody') ? [...t.querySelectorAll('tbody tr')] : trs.slice(1);
    const rows = bodyTrs.map((tr) => [...tr.querySelectorAll('td, th')].map((c) => texto(c))).filter((r) => r.some((x) => x));
    // Puntaje: filas por columnas con nombre. Evita elegir una tablita de título o layout.
    const cols = headers.filter(Boolean).length;
    const score = rows.length * Math.max(1, cols);
    if (rows.length && cols >= 2 && (!mejor || score > mejor.score)) mejor = { headers, rows, score };
  }
  return mejor;
}

/** Elige la MEJOR tabla entre todos los frames (no la primera): la grilla real suele estar en un iframe. */
async function scrapearFrames(pagina) {
  let mejor = null;
  for (const frame of pagina.frames()) {
    const r = await frame.evaluate(extraerTablaEnDocumento).catch(() => null);
    if (r && r.rows.length && (!mejor || r.score > mejor.score)) mejor = r;
  }
  return mejor;
}

/** Botón de paginación "siguiente" habilitado, en cualquier frame; null si no hay o está deshabilitado. */
async function botonSiguiente(pagina) {
  for (const frame of pagina.frames()) {
    const loc = frame.locator('a, button, [role=button], [role=menuitem], li').filter({ hasText: /siguiente|next|›|»/i });
    const n = Math.min(await loc.count(), 10);
    for (let i = 0; i < n; i++) {
      const b = loc.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      const txt = (await b.innerText().catch(() => '')) || '';
      if (PROHIBIDO.test(txt)) continue;
      const dis = (await b.getAttribute('disabled').catch(() => null)) !== null
        || /disabled/.test((await b.getAttribute('class').catch(() => '')) || '')
        || (await b.getAttribute('aria-disabled').catch(() => null)) === 'true';
      if (!dis) return b;
    }
  }
  return null;
}

async function completarFiltrosYConsultar(pagina, desde, hasta, log) {
  let fechas = 0;
  for (const frame of pagina.frames()) {
    const inputs = frame.locator('input[placeholder="dd/mm/aaaa" i], input[id*="fecha" i], input[name*="fecha" i]');
    const n = Math.min(await inputs.count(), 8);
    for (let i = 0; i < n && fechas < 2; i++) {
      const inp = inputs.nth(i);
      if (!(await inp.isVisible().catch(() => false))) continue;
      await inp.fill(fechas === 0 ? fechaArca(desde) : fechaArca(hasta)).catch(() => {});
      fechas++;
    }
    if (fechas) break;
  }
  if (!fechas) return false; // sin filtros de fecha: el servicio ya muestra sus datos
  for (const frame of pagina.frames()) {
    const btn = frame.locator('button, [role=button], input[type=submit]').filter({ hasText: /consultar|buscar/i });
    const n = Math.min(await btn.count(), 6);
    for (let i = 0; i < n; i++) {
      const b = btn.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      if (PROHIBIDO.test((await b.innerText().catch(() => '')) || '')) continue;
      log('  consultando con el período');
      await b.click();
      await pagina.waitForLoadState('networkidle').catch(() => {});
      await pagina.waitForTimeout(2500);
      return true;
    }
  }
  return true;
}

function escribirProtegido(file, contenido) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contenido, { mode: 0o600 });
}

export const COLUMNAS_LIBRES = (headers) => headers.map((h, i) => ({ header: h || `col${i + 1}`, value: (r) => r[i] ?? '' }));

export async function extraerTabla(sesion, servicio, { desde, hasta, outDir = 'out/datos', log = () => {} }) {
  const dir = path.join(outDir, servicio.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const resultado = { id: servicio.id, archivos: [], filas: 0, paginas: 0, informados: null, verificado: false };
  const pagina = await sesion.abrirServicio(servicio);
  await pagina.waitForTimeout(2500);

  await completarFiltrosYConsultar(pagina, desde, hasta, log);

  let headers = null;
  const filas = [];
  const vistas = new Set();
  for (let p = 0; p < 100; p++) {
    const tabla = await scrapearFrames(pagina);
    if (!tabla) break;
    if (!headers) headers = tabla.headers;
    let nuevas = 0;
    for (const r of tabla.rows) {
      const firma = r.join('|');
      if (vistas.has(firma)) continue;
      vistas.add(firma); filas.push(r); nuevas++;
    }
    resultado.paginas = p + 1;
    if (!nuevas) break; // página repetida: fin
    const sig = await botonSiguiente(pagina);
    if (!sig) break;
    await sig.click().catch(() => {});
    await pagina.waitForTimeout(1500);
  }

  // Total informado (si hay paginación tipo "de N registros"), para cotejar.
  const rel = await relevarPagina(pagina);
  resultado.informados = totalInformado(resumenResultados(rel));

  if (headers && filas.length) {
    const file = path.join(dir, `${servicio.id}-${desde}-${hasta}.csv`);
    escribirProtegido(file, toCsv(filas, COLUMNAS_LIBRES(headers)));
    resultado.archivos.push(path.basename(file));
    resultado.filas = filas.length;
    resultado.columnas = headers;
    resultado.coincideInformado = resultado.informados == null ? null : filas.length === resultado.informados;
    resultado.verificado = resultado.coincideInformado === true;
    log(`  -> ${path.basename(file)} · ${filas.length} filas / informados ${resultado.informados ?? '?'} · ${resultado.verificado ? 'VALIDADO' : 'descargado sin cotejo'}`);
  } else {
    escribirProtegido(path.join(dir, `diagnostico-${desde}-${hasta}.json`), JSON.stringify(resumenResultados(rel), null, 2));
    log('  sin tabla de resultados; guardado diagnóstico');
  }
  if (pagina !== sesion.page) await pagina.close().catch(() => {});
  return resultado;
}
