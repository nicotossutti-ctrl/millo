/**
 * Extractor de tabla genérico, SOLO LECTURA. Para servicios que muestran los datos en una
 * grilla (Mis Retenciones, Cuentas Tributarias dentro de un iframe, Mis Facilidades):
 *   1. abre el servicio,
 *   2. completa filtros de fecha (con selectores confirmados por servicio si existen) y consulta,
 *   3. elige la grilla REAL por encabezados esperados, no solo por tamaño,
 *   4. la lee recorriendo la paginación, con tope de seguridad y corte verificable,
 *   5. guarda un CSV propio y reporta estado diferenciado: validado | extraido | parcial | sin-datos.
 *
 * Nunca presenta, paga, emite ni modifica: los únicos clics son filtros de fecha,
 * Consultar/Buscar y la paginación. Todo control de trámite está vetado por lista (esProhibido).
 *
 * Importante: los datos acumulados (cuenta tributaria, planes) NO se atribuyen al mes consultado;
 * el resultado marca conFiltroPeriodo=false para que el panel no los lea como del período.
 */
import fs from 'node:fs';
import path from 'node:path';
import { relevarPagina } from './relevar.js';
import { totalInformado, resumenResultados } from './misComprobantes.js';
import { toCsv } from '../csv.js';

export const PROHIBIDO = /presentar|pagar|generar vep|\bvep\b|enviar|confirmar|eliminar|anular|modificar|dar de baja|adherir|solicitar plan/i;
/** true si un control no debe tocarse por ser de trámite, pago, emisión o modificación. */
export const esProhibido = (texto) => PROHIBIDO.test(texto ?? '');

export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const fechaArca = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

/**
 * Corre en el navegador. Elige la mejor tabla del documento. Si `expected` trae encabezados,
 * da prioridad fuerte a la tabla que los contiene (evita grillas de navegación/título).
 */
function extraerTablasEnDocumento() {
  const vis = (e) => { try { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
  const tx = (c) => (c.innerText || c.textContent || '').trim().replace(/\s+/g, ' ');
  const out = [];
  for (const t of document.querySelectorAll('table')) {
    if (!vis(t)) continue;
    const trs = [...t.querySelectorAll('tr')];
    const headerCells = (t.querySelectorAll('thead th, thead td')[0] ? [...t.querySelectorAll('thead th, thead td')] : [...(trs[0]?.querySelectorAll('th, td') ?? [])]);
    const headers = headerCells.map((c) => tx(c).replace(/\s*\(.*?sort.*?\)\s*/i, ''));
    const bodyTrs = t.querySelector('tbody') ? [...t.querySelectorAll('tbody tr')] : trs.slice(1);
    const rows = bodyTrs.map((tr) => [...tr.querySelectorAll('td, th')].map((c) => tx(c))).filter((r) => r.some((x) => x));
    if (rows.length) out.push({ headers, rows });
  }
  return out;
}

/**
 * Elige la grilla real entre varias candidatas. Puntaje = filas × columnas con nombre, con un
 * bonus fuerte por cada encabezado esperado presente. Si se esperan encabezados y ninguna
 * candidata coincide, devuelve null (era tabla de navegación/título, no la grilla fiscal).
 */
export function elegirTabla(tablas, expected = []) {
  let mejor = null;
  for (const t of tablas) {
    const cols = (t.headers ?? []).filter(Boolean).length;
    const hn = (t.headers ?? []).map(norm);
    const coincideCols = expected.filter((e) => hn.some((h) => h.includes(e))).length;
    const score = t.rows.length * Math.max(1, cols) + coincideCols * 100000;
    if (!mejor || score > mejor.score) mejor = { ...t, score, coincideCols };
  }
  if (mejor && expected.length && mejor.coincideCols === 0) return null;
  return mejor;
}

/** Elige la mejor tabla entre todos los frames. Con encabezados esperados, descarta la que no coincide. */
async function scrapearFrames(pagina, expected) {
  const todas = [];
  for (const frame of pagina.frames()) {
    const t = await frame.evaluate(extraerTablasEnDocumento).catch(() => []);
    for (const x of t) todas.push(x);
  }
  return elegirTabla(todas, expected);
}

/** Botón de paginación "siguiente" habilitado, en cualquier frame; null si no hay o está deshabilitado. */
async function botonSiguiente(pagina) {
  for (const frame of pagina.frames()) {
    const loc = frame.locator('a, button, [role=button], [role=menuitem], li').filter({ hasText: /siguiente|next|›|»/i });
    const n = Math.min(await loc.count(), 10);
    for (let i = 0; i < n; i++) {
      const b = loc.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      if (esProhibido((await b.innerText().catch(() => '')) || '')) continue;
      const dis = (await b.getAttribute('disabled').catch(() => null)) !== null
        || /disabled/.test((await b.getAttribute('class').catch(() => '')) || '')
        || (await b.getAttribute('aria-disabled').catch(() => null)) === 'true';
      if (!dis) return b;
    }
  }
  return null;
}

/**
 * Completa filtros de fecha y consulta. Con selectores por servicio NO silencia errores:
 * si un filtro o el botón Consultar fallan, devuelve { error } para que el extractor no siga
 * con datos potencialmente viejos. Devuelve rangoOk solo si el campo tomó realmente la fecha.
 */
export async function completarFiltros(pagina, desde, hasta, servicio, log) {
  const sel = servicio.selectores;
  // Fija una fecha y verifica que el campo la haya tomado. Lanza si falla; false si el
  // selector no está en este frame (para probar el siguiente).
  const fijar = async (frame, selector, valor) => {
    const inp = frame.locator(selector).first();
    if (!(await inp.count())) return false;
    await inp.waitFor({ state: 'visible', timeout: 8000 });
    await inp.fill('');
    await inp.fill(valor);
    const leido = await inp.inputValue();
    if (!String(leido).includes(valor)) throw new Error(`el campo ${selector} no tomó "${valor}" (quedó "${leido}")`);
    return true;
  };
  if (sel?.fechaDesde && sel?.fechaHasta) {
    for (const frame of pagina.frames()) {
      let a;
      try { a = await fijar(frame, sel.fechaDesde, fechaArca(desde)); }
      catch (e) { return { conFiltroPeriodo: true, error: `fecha desde: ${e.message}` }; }
      if (!a) continue; // los filtros no están en este frame
      try {
        await fijar(frame, sel.fechaHasta, fechaArca(hasta));
        const btn = frame.locator(sel.consultar ?? 'button:has-text("Consultar"), button:has-text("Buscar")').first();
        if (!(await btn.count())) throw new Error('no se encontró el botón Consultar');
        log('  consultando con selectores confirmados');
        await btn.click();
        await pagina.waitForLoadState('networkidle').catch(() => {});
        await pagina.waitForTimeout(2500);
        const leidoDesde = await frame.locator(sel.fechaDesde).first().inputValue().catch(() => '');
        const leidoHasta = await frame.locator(sel.fechaHasta).first().inputValue().catch(() => '');
        return { conFiltroPeriodo: true, rangoAplicado: `${leidoDesde} - ${leidoHasta}`, rangoOk: leidoDesde.includes(fechaArca(desde)) && leidoHasta.includes(fechaArca(hasta)) };
      } catch (e) { return { conFiltroPeriodo: true, error: `filtro/consulta: ${e.message}` }; }
    }
    return { conFiltroPeriodo: true, error: 'no se encontraron los filtros de fecha confirmados' };
  }
  // Genérico: inputs con placeholder dd/mm/aaaa o id/name con "fecha".
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
  if (!fechas) return { conFiltroPeriodo: false, rangoAplicado: null, rangoOk: null };
  for (const frame of pagina.frames()) {
    const btn = frame.locator('button, [role=button], input[type=submit]').filter({ hasText: /consultar|buscar/i });
    const k = Math.min(await btn.count(), 6);
    for (let i = 0; i < k; i++) {
      const b = btn.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      if (esProhibido((await b.innerText().catch(() => '')) || '')) continue;
      log('  consultando con el período');
      await b.click().catch(() => {});
      await pagina.waitForLoadState('networkidle').catch(() => {});
      await pagina.waitForTimeout(2500);
      return { conFiltroPeriodo: true, rangoAplicado: null, rangoOk: null };
    }
  }
  return { conFiltroPeriodo: true, rangoAplicado: null, rangoOk: null };
}

function escribirProtegido(file, contenido) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contenido, { mode: 0o600 });
}

export const COLUMNAS_LIBRES = (headers) => headers.map((h, i) => ({ header: h || `col${i + 1}`, value: (r) => r[i] ?? '' }));

/**
 * Decide el estado del extractor: validado (coteja con total informado), extraido (hay datos
 * sin total para cotejar), parcial (hay datos pero el rango aplicado no coincide con el pedido),
 * sin-datos (no se encontró la grilla).
 */
export function decidirEstado({ filas, informados, conFiltroPeriodo, rangoOk, error }) {
  if (error) return { estado: 'parcial', verificado: false };            // fallo de interacción: nunca validado
  if (!filas) return { estado: 'sin-datos', verificado: false };
  if (conFiltroPeriodo) {
    // Con filtro de fechas, 'validado' exige que el rango aplicado esté CONFIRMADO (rangoOk===true).
    // Que el conteo coincida con el total informado no alcanza si no sabemos qué período quedó.
    if (rangoOk !== true) return { estado: 'parcial', verificado: false };
    if (informados != null) return filas === informados ? { estado: 'validado', verificado: true } : { estado: 'parcial', verificado: false };
    return { estado: 'extraido', verificado: false };
  }
  // Sin filtro de período (datos acumulados: cuenta tributaria, planes): no se atribuyen al mes
  // de la ejecución, así que nunca se marcan 'validado' por período.
  return { estado: 'extraido', verificado: false };
}

export async function extraerTabla(sesion, servicio, { desde, hasta, outDir = 'out/datos', log = () => {} }) {
  const dir = path.join(outDir, servicio.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const expected = (servicio.columnasEsperadas ?? []).map(norm);
  const resultado = { id: servicio.id, archivos: [], filas: 0, paginas: 0, informados: null, duplicadosEnTabla: 0, conFiltroPeriodo: false, rangoAplicado: null, estado: 'sin-datos', verificado: false };

  const pagina = await sesion.abrirServicio(servicio);
  await pagina.waitForTimeout(2500);

  const filtro = await completarFiltros(pagina, desde, hasta, servicio, log);
  resultado.conFiltroPeriodo = filtro.conFiltroPeriodo;
  resultado.rangoAplicado = filtro.rangoAplicado;

  // Si la consulta con selectores falló, no seguimos con datos potencialmente viejos.
  if (filtro.error) {
    const rel0 = await relevarPagina(pagina).catch(() => ({ frames: [] }));
    escribirProtegido(path.join(dir, `diagnostico-${desde}-${hasta}.json`), JSON.stringify({ error: filtro.error, resultados: resumenResultados(rel0) }, null, 2));
    const d0 = decidirEstado({ filas: 0, error: filtro.error });
    resultado.estado = d0.estado;
    resultado.verificado = d0.verificado;
    resultado.motivo = filtro.error;
    log(`  ${servicio.id}: parcial · ${filtro.error}`);
    if (pagina !== sesion.page) await pagina.close().catch(() => {});
    return resultado;
  }

  let headers = null;
  const filas = [];
  const vistas = new Set();
  for (let p = 0; p < 100; p++) {
    const tabla = await scrapearFrames(pagina, expected);
    if (!tabla) break;
    if (!headers) headers = tabla.headers;
    let nuevas = 0;
    for (const r of tabla.rows) {
      const firma = r.join('|');
      if (vistas.has(firma)) { resultado.duplicadosEnTabla++; continue; }
      vistas.add(firma); filas.push(r); nuevas++;
    }
    resultado.paginas = p + 1;
    if (!nuevas) break; // página repetida: corte verificable
    const sig = await botonSiguiente(pagina);
    if (!sig) break;
    await sig.click().catch(() => {});
    await pagina.waitForTimeout(1500);
  }

  const rel = await relevarPagina(pagina);
  resultado.informados = totalInformado(resumenResultados(rel));

  if (headers && filas.length) {
    const file = path.join(dir, `${servicio.id}-${desde}-${hasta}.csv`);
    escribirProtegido(file, toCsv(filas, COLUMNAS_LIBRES(headers)));
    resultado.archivos.push(path.basename(file));
    resultado.filas = filas.length;
    resultado.columnas = headers;
    resultado.coincideInformado = resultado.informados == null ? null : filas.length === resultado.informados;
  } else {
    escribirProtegido(path.join(dir, `diagnostico-${desde}-${hasta}.json`), JSON.stringify(resumenResultados(rel), null, 2));
  }
  const d = decidirEstado({ filas: resultado.filas, informados: resultado.informados, conFiltroPeriodo: resultado.conFiltroPeriodo, rangoOk: filtro.rangoOk, error: filtro.error });
  resultado.estado = d.estado;
  resultado.verificado = d.verificado;
  log(`  ${servicio.id}: ${resultado.estado} · ${resultado.filas} filas / informados ${resultado.informados ?? '?'} · ${resultado.paginas} páginas${resultado.conFiltroPeriodo ? '' : ' · sin filtro de período (datos acumulados)'}`);
  if (pagina !== sesion.page) await pagina.close().catch(() => {});
  return resultado;
}
