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
import { relevarPagina, relevarTodasLasPaginas } from './relevar.js';
import { totalInformado, resumenResultados } from './misComprobantes.js';
import { sanitizarTexto } from './diagnostico.js';
import { toCsv } from '../csv.js';
import { verificarFechas, resumenEstados } from './calidad.js';

export const PROHIBIDO = /presentar|pagar|generar vep|\bvep\b|enviar|confirmar|eliminar|anular|modificar|dar de baja|adherir|solicitar plan/i;
/** true si un control no debe tocarse por ser de trámite, pago, emisión o modificación. */
export const esProhibido = (texto) => PROHIBIDO.test(texto ?? '');

export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const fechaArca = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

// Opciones que NO son un impuesto real (placeholders / agregados), para el desplegable de impuesto.
// Se compara sin acentos y en minúsculas, así "Seleccioná" cae igual que "selecciona".
const OPCION_PLACEHOLDER = /^$|selecciona|seleccione|elegi|^todos?$|^-+$/;
/** Primera opción "real" de un desplegable de impuesto (saltea placeholders). Pura, testeable. */
export function elegirOpcionImpuesto(opciones = []) {
  for (let i = 0; i < opciones.length; i++) {
    const t = String(opciones[i] ?? '').trim();
    if (!t || OPCION_PLACEHOLDER.test(norm(t))) continue;
    return { index: i, texto: t };
  }
  return null;
}

/**
 * Selecciona un impuesto. Soporta dos formas:
 *  1) Combo NO nativo (EJ2/Syncfusion) por selector confirmado del servicio (Mis Retenciones usa
 *     #selectImpuestos): clic en el combo y elección de una opción real del popup (.e-list-item).
 *  2) <select> nativo: elige la primera opción real. Solo lectura. Devuelve el impuesto elegido.
 */
const esGrupoImpuesto = (t) => /^(impositiv|aduaner|recursos de la seg|seguridad social)/i.test(norm(t));

/**
 * De una lista de opciones del combo, deja solo los impuestos REALES (código "NNN - ..."),
 * sin encabezados de grupo, filtrados por `relevantes` (regex opcional) y SIN duplicados.
 * El combo EJ2 repite ítems (popup + lista oculta), por eso dedup. Pura, testeable.
 */
export function impuestosDeItems(items = [], relevantes = null) {
  let labels = items
    .map((x) => (typeof x === 'string' ? x : x?.t))
    .filter((t) => typeof t === 'string' && /^\s*\d+\s*[-–]/.test(t) && !esGrupoImpuesto(t));
  if (relevantes) labels = labels.filter((t) => relevantes.test(t));
  return [...new Set(labels)];
}
/** Abre el combo EJ2 y devuelve [{ i, t }] con las opciones visibles. */
async function abrirComboImpuesto(frame, selector) {
  const combo = frame.locator(selector).first();
  if (!(await combo.count().catch(() => 0)) || !(await combo.isVisible().catch(() => false))) return null;
  await combo.click().catch(() => {});
  await frame.page().waitForTimeout(700).catch(() => {});
  const opciones = frame.locator('.e-list-item, [role="option"], li[role="option"], .e-ddl-item');
  const n = Math.min(await opciones.count().catch(() => 0), 80);
  const items = [];
  for (let i = 0; i < n; i++) {
    const o = opciones.nth(i);
    if (!(await o.isVisible().catch(() => false))) continue;
    const t = ((await o.innerText().catch(() => '')) || '').trim();
    if (t) items.push({ i, t });
  }
  return { opciones, items };
}

/** Lista los impuestos REALES (código "NNN - ...") del combo, en cualquier frame. Solo lectura.
 * Si el servicio define `impuestosRelevantes` (regex), filtra a esos (IVA, Ganancias, etc.). */
export async function listarImpuestos(pagina, servicio) {
  if (!servicio?.selectorImpuesto) return [];
  for (const frame of pagina.frames()) {
    const abierto = await abrirComboImpuesto(frame, servicio.selectorImpuesto);
    if (!abierto) continue;
    const labels = impuestosDeItems(abierto.items, servicio.impuestosRelevantes);
    await frame.page().keyboard.press('Escape').catch(() => {});
    if (labels.length) return labels;
  }
  return [];
}

/** Vuelve del resultado al formulario de consulta (botón "Volver a Consultar" / "Nueva Consulta"). */
async function volverAlFormulario(pagina) {
  for (const frame of pagina.frames()) {
    const b = frame.locator('a, button, [role=button]').filter({ hasText: /volver a consultar|nueva consulta/i }).first();
    if ((await b.count().catch(() => 0)) && (await b.isVisible().catch(() => false))) {
      await b.click().catch(() => {});
      await pagina.waitForLoadState('networkidle').catch(() => {});
      await pagina.waitForTimeout(1500);
      return true;
    }
  }
  return false;
}

/**
 * Elige Establecimiento = "0" en el formulario de DJ de Cuentas Tributarias (requisito confirmado).
 * Lo busca de forma robusta, sin depender de un id: por label "Establecimiento", por name/id que
 * contenga "establec", o por un <select> chico cuya única opción real sea "0". Deja Impuesto y
 * Formulario sin tocar (para traer todo). Devuelve true si pudo seleccionarlo. Solo lectura.
 */
export async function seleccionarEstablecimiento(frame) {
  const ponerCero = async (s) => {
    if (await s.selectOption('0').then(() => true).catch(() => false)) return true;
    const opts = await s.locator('option').allTextContents().catch(() => []);
    const op = elegirOpcionImpuesto(opts); // primera opción real (no placeholder)
    return op ? await s.selectOption({ index: op.index }).then(() => true).catch(() => false) : false;
  };
  // 1) Por label asociado ("Establecimiento *").
  if (typeof frame.getByLabel === 'function') {
    const byLabel = frame.getByLabel(/establecimiento/i);
    if ((await byLabel.count().catch(() => 0)) && await ponerCero(byLabel.first())) return true;
  }
  // 2) Por name/id/aria-label, o por forma (select chico con opción "0").
  const selects = frame.locator('select');
  const n = Math.min(await selects.count().catch(() => 0), 12);
  for (let i = 0; i < n; i++) {
    const s = selects.nth(i);
    if (!(await s.isVisible().catch(() => false))) continue;
    const marca = norm(`${await s.getAttribute('name').catch(() => '')} ${await s.getAttribute('id').catch(() => '')} ${await s.getAttribute('aria-label').catch(() => '')}`);
    const opts = await s.locator('option').allTextContents().catch(() => []);
    const esEstablecimiento = /establec/.test(marca) || (opts.length <= 3 && opts.some((o) => /^\s*0\s*$/.test(String(o))));
    if (esEstablecimiento && await ponerCero(s)) return true;
  }
  return false;
}

async function seleccionarImpuesto(frame, servicio, impuestoLabel = null) {
  if (servicio?.selectorImpuesto) {
    const abierto = await abrirComboImpuesto(frame, servicio.selectorImpuesto);
    if (abierto) {
      const { opciones, items } = abierto;
      // Con un impuesto pedido, elegimos exactamente ese; si no, un impuesto REAL (código "NNN - "),
      // nunca un encabezado de grupo ("Impositivas", "Aduaneras", "Recursos de la Seguridad Social").
      const reales = items.filter((x) => /^\s*\d+\s*[-–]/.test(x.t) && !esGrupoImpuesto(x.t));
      const elegido = impuestoLabel
        ? items.find((x) => norm(x.t) === norm(impuestoLabel)) || items.find((x) => norm(x.t).includes(norm(impuestoLabel)))
        : (reales.find((x) => /\biva\b/i.test(x.t)) || reales.find((x) => /ganancia/i.test(x.t)) || reales[0]
          || items.find((x) => !OPCION_PLACEHOLDER.test(norm(x.t)) && !esGrupoImpuesto(x.t)));
      if (elegido) { await opciones.nth(elegido.i).click().catch(() => {}); return elegido.t; }
    }
  }
  const selects = frame.locator('select');
  const n = Math.min(await selects.count().catch(() => 0), 10);
  for (let i = 0; i < n; i++) {
    const s = selects.nth(i);
    if (!(await s.isVisible().catch(() => false))) continue;
    const textos = await s.locator('option').allTextContents().catch(() => []);
    const op = elegirOpcionImpuesto(textos);
    if (!op) continue;
    await s.selectOption({ index: op.index }).catch(() => {});
    return op.texto;
  }
  return null;
}

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
    // Solo filas y celdas PROPIAS de la tabla (t.rows / tr.cells), no las de tablas anidadas. Las
    // pantallas legacy (Cuentas Tributarias, CCMA) maquetan con tablas dentro de tablas: con
    // querySelectorAll('tr') la tabla contenedora "se tragaba" las filas de la grilla real y ganaba
    // con encabezados de maquetación (nombre, domicilio). Corrida 2026-10-24T19-39-01.
    const trs = [...t.rows];
    const head = t.tHead?.rows?.[0] ?? null;
    const filaEncabezado = head ?? trs[0] ?? null;
    const headers = [...(filaEncabezado?.cells ?? [])].map((c) => tx(c).replace(/\s*\(.*?sort.*?\)\s*/i, ''));
    const cuerpo = t.tBodies.length ? [...t.tBodies].flatMap((b) => [...b.rows]) : trs;
    // Sin <thead>, la fila de encabezado es la primera del cuerpo: no se cuenta como dato.
    const bodyTrs = cuerpo.filter((tr) => tr !== filaEncabezado && tr.parentElement?.tagName !== 'THEAD');
    const rows = bodyTrs.map((tr) => [...tr.cells].map((c) => tx(c))).filter((r) => r.some((x) => x));
    // Incluimos también grillas con encabezados pero SIN filas: sirven para confirmar un cero real
    // (grilla presente y vacía) y distinguirlo de "no encontré la grilla" (pestaña/consulta falló).
    if (rows.length || headers.filter(Boolean).length) out.push({ headers, rows });
  }
  // Grillas de componente (no <table>): ARIA role=grid y Syncfusion EJ2 (.e-grid), usadas por los
  // portales nuevos de ARCA (IVA, Bienes Personales, DDJJ y Pagos: clases e-*). Mismo formato.
  for (const g of document.querySelectorAll('[role="grid"], [role="table"], .e-grid, .ag-root-wrapper, .k-grid')) {
    if (!vis(g)) continue;
    const headers = [...g.querySelectorAll('[role="columnheader"], .e-headercelldiv, .e-headertext, th')].map((c) => tx(c).replace(/\s*\(.*?sort.*?\)\s*/i, ''));
    const rowEls = [...g.querySelectorAll('[role="row"], .e-row')].filter((r) => r.querySelector('[role="gridcell"], [role="cell"], .e-rowcell, td'));
    const rows = rowEls.map((r) => [...r.querySelectorAll('[role="gridcell"], [role="cell"], .e-rowcell, td')].map((c) => tx(c))).filter((r) => r.some((x) => x));
    if (rows.length || headers.filter(Boolean).length) out.push({ headers, rows });
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
    // Bonus a las tablas con encabezados reales (≥2): sin columnas esperadas, una tabla de maquetación
    // sin encabezados (p. ej. las secciones del menú lateral de Cuentas Tributarias, 10 filas) no debe
    // ganarle a una grilla de datos chica.
    const score = t.rows.length * Math.max(1, cols) + (cols >= 2 ? 50000 : 0) + coincideCols * 100000;
    if (!mejor || score > mejor.score) mejor = { ...t, score, coincideCols };
  }
  if (mejor && expected.length && mejor.coincideCols === 0) return null;
  return mejor;
}

/**
 * Como elegirTabla, pero cuando hay VARIAS tablas con los encabezados esperados las UNE en un solo
 * dataset. Caso real: Portal IVA pinta cada DDJJ presentada en su propia <table> de 1 fila (mismos
 * encabezados Período/Formulario/Secuencia/Presentación); elegirTabla devolvía una sola → 1 fila.
 * Sin encabezados esperados, se comporta como elegirTabla (la mejor única). Pura, testeable.
 */
export function recolectarTablas(tablas, expected = []) {
  const exp = expected.map(norm);
  if (!exp.length) return elegirTabla(tablas, expected);
  const coincide = (t) => {
    const hn = (t.headers ?? []).map(norm);
    return exp.every((e) => hn.some((h) => h.includes(e)));
  };
  const match = tablas.filter(coincide);
  if (!match.length) return null; // ninguna coincide: era navegación/título
  return { headers: match[0].headers, rows: match.flatMap((t) => t.rows), coincideCols: exp.length };
}

/** Elige la mejor tabla entre todos los frames. Con encabezados esperados, descarta la que no coincide. */
// `frameDatos`: si la sección declara en qué frame está su grilla (p. ej. 'scripts/vue/' en Cuentas
// Tributarias), solo se leen las tablas de ESE frame: la maquetación del frame principal queda afuera.
async function scrapearFrames(pagina, expected, frameDatos = null) {
  const todas = [];
  for (const frame of pagina.frames()) {
    if (frameDatos && !String(frame.url?.() ?? '').includes(frameDatos)) continue;
    const t = await frame.evaluate(extraerTablasEnDocumento).catch(() => []);
    for (const x of t) todas.push(x);
  }
  return recolectarTablas(todas, expected);
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
export async function completarFiltros(pagina, desde, hasta, servicio, log, impuesto = null) {
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
  // Formulario de Declaraciones Juradas (DJ) de Cuentas Tributarias: EXIGE elegir Establecimiento
  // (valor "0" en esta clave fiscal) antes de SIGUIENTE; Impuesto/Formulario se dejan en "Nada
  // seleccionado" para traer TODAS las DJ. Solo lectura.
  // Formulario con un combo de opción obligatoria y CONSULTAR (Detalle de Deuda Consolidada de
  // Cuentas Tributarias: "Trámite"). Se elige la opción declarada por la sección y se consulta.
  if (servicio.seleccionarOpcion) {
    const buscada = norm(servicio.seleccionarOpcion);
    for (const frame of pagina.frames()) {
      const selects = frame.locator('select');
      const n = Math.min(await selects.count().catch(() => 0), 10);
      for (let i = 0; i < n; i++) {
        const sel = selects.nth(i);
        if (!(await sel.isVisible().catch(() => false))) continue;
        const opciones = await sel.locator('option').allTextContents().catch(() => []);
        const label = opciones.find((o) => norm(o) === buscada);
        if (!label) continue;
        await sel.selectOption({ label });
        log(`  opción elegida: ${label}`);
        const btn = frame.locator('button, [role=button], input[type=submit]').filter({ hasText: /consultar|buscar/i }).first();
        if (!(await btn.count().catch(() => 0))) return { conFiltroPeriodo: false, error: `se eligió "${label}" pero no se encontró CONSULTAR` };
        if (esProhibido((await btn.innerText().catch(() => '')) || '')) return { conFiltroPeriodo: false, error: 'el botón de consulta parece un trámite: no se toca' };
        await btn.click();
        await pagina.waitForLoadState('networkidle').catch(() => {});
        await pagina.waitForTimeout(3000);
        return { conFiltroPeriodo: false, rangoAplicado: null, rangoOk: null, opcion: label };
      }
    }
    return { conFiltroPeriodo: false, error: `no se encontró el combo con la opción "${servicio.seleccionarOpcion}"` };
  }
  if (servicio.requiereEstablecimiento) {
    for (const frame of pagina.frames()) {
      if (!(await seleccionarEstablecimiento(frame))) continue;
      log('  Establecimiento seleccionado (0)');
      const btn = frame.locator('button, [role=button], input[type=submit]').filter({ hasText: /siguiente|consultar|buscar/i }).first();
      if (!(await btn.count().catch(() => 0))) return { conFiltroPeriodo: false, error: 'DJ: no se encontró Siguiente/Consultar tras elegir Establecimiento' };
      await btn.click();
      await pagina.waitForLoadState('networkidle').catch(() => {});
      await pagina.waitForTimeout(2500);
      return { conFiltroPeriodo: false, rangoAplicado: null, rangoOk: null };
    }
    return { conFiltroPeriodo: false, error: 'DJ: no se encontró el control de Establecimiento para elegir "0"' };
  }
  if (sel?.fechaDesde && sel?.fechaHasta) {
    // Tras "Volver a Consultar" la SPA tarda en volver a pintar el formulario. Sin esta espera los
    // campos no aparecían todavía, el impuesto se salteaba con "no se encontraron los filtros" y
    // pasaba uno sí / uno no (se perdían justo los que traían filas). Esperamos hasta ~10 s.
    for (let i = 0; i < 20; i++) {
      let hay = false;
      for (const frame of pagina.frames()) {
        if (await frame.locator(sel.fechaDesde).first().count().catch(() => 0)) { hay = true; break; }
      }
      if (hay) break;
      await pagina.waitForTimeout?.(500);
    }
    for (const frame of pagina.frames()) {
      let a;
      try { a = await fijar(frame, sel.fechaDesde, fechaArca(desde)); }
      catch (e) { return { conFiltroPeriodo: true, error: `fecha desde: ${e.message}` }; }
      if (!a) continue; // los filtros no están en este frame
      try {
        await fijar(frame, sel.fechaHasta, fechaArca(hasta));
        // Algunos servicios (Mis Retenciones) exigen elegir un impuesto antes de Consultar.
        if (servicio.requiereImpuesto) {
          const imp = await seleccionarImpuesto(frame, servicio, impuesto);
          if (!imp) return { conFiltroPeriodo: true, error: `requiere elegir un impuesto y no se pudo${impuesto ? ` (buscado "${impuesto}")` : ''}: revisar el combo` };
          log(`  impuesto seleccionado: ${imp}`);
        }
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
  // Genérico: SOLO si la sección declara que su consulta filtra por período (filtroPeriodo). Antes se
  // completaba cualquier campo "fecha" que apareciera: en la home de Cuentas Tributarias llenó un
  // campo ajeno y la pestaña Deudas quedó con el período "sin confirmar" (corrida 2026-10-24).
  if (!servicio?.filtroPeriodo) return { conFiltroPeriodo: false, rangoAplicado: null, rangoOk: null };
  // Inputs con placeholder dd/mm/aaaa o id/name con "fecha". Después de completarlos se
  // RELEEN: si los dos campos tomaron el período pedido, el rango queda confirmado (rangoOk); si no,
  // queda sin confirmar y la extracción no se valida por período.
  let fechas = 0; const llenados = [];
  for (const frame of pagina.frames()) {
    const inputs = frame.locator('input[placeholder="dd/mm/aaaa" i], input[id*="fecha" i], input[name*="fecha" i]');
    const n = Math.min(await inputs.count(), 8);
    for (let i = 0; i < n && fechas < 2; i++) {
      const inp = inputs.nth(i);
      if (!(await inp.isVisible().catch(() => false))) continue;
      const valor = fechas === 0 ? fechaArca(desde) : fechaArca(hasta);
      await inp.fill(valor).catch(() => {});
      llenados.push({ inp, valor });
      fechas++;
    }
    if (fechas) break;
  }
  if (!fechas) return { conFiltroPeriodo: false, rangoAplicado: null, rangoOk: null };
  const leidos = [];
  for (const { inp } of llenados) leidos.push(await inp.inputValue().catch(() => ''));
  const rangoAplicado = leidos.join(' - ');
  const rangoOk = llenados.length === 2 && llenados.every(({ valor }, i) => String(leidos[i]).includes(valor));
  for (const frame of pagina.frames()) {
    // "Siguiente" cubre el formulario de Declaraciones Juradas (DJ) de Cuentas Tributarias, que
    // avanza con ese botón (consulta de solo lectura; esProhibido igual veta cualquier trámite).
    const btn = frame.locator('button, [role=button], input[type=submit]').filter({ hasText: /consultar|buscar|siguiente/i });
    const k = Math.min(await btn.count(), 6);
    for (let i = 0; i < k; i++) {
      const b = btn.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      if (esProhibido((await b.innerText().catch(() => '')) || '')) continue;
      log(`  consultando con el período (campos: ${rangoAplicado}${rangoOk ? '' : ', NO tomaron el rango pedido'})`);
      await b.click();
      await pagina.waitForLoadState('networkidle').catch(() => {});
      await pagina.waitForTimeout(2500);
      return { conFiltroPeriodo: true, rangoAplicado, rangoOk };
    }
  }
  // Se completaron fechas pero no hubo botón de consulta: se lee lo que haya, pero el período NO queda
  // confirmado (la grilla puede no estar filtrada).
  return { conFiltroPeriodo: true, rangoAplicado, rangoOk: false, sinConsulta: true };
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
export function decidirEstado({ filas, informados, conFiltroPeriodo, rangoOk, error, gridPresente }) {
  if (error) return { estado: 'parcial', verificado: false };            // fallo de interacción: nunca validado
  if (!filas) {
    // 0 filas: NO afirmar "no hay datos" salvo que la grilla esperada esté presente y vacía
    // (cero confirmado) y, si hay filtro de fechas, el rango aplicado esté confirmado. Si no se
    // encontró la grilla (pestaña/consulta falló), queda 'parcial': ausencia incierta, no un cero.
    const ceroConfirmado = gridPresente === true && (!conFiltroPeriodo || rangoOk === true);
    return ceroConfirmado
      ? { estado: 'sin-datos', verificado: false, ceroConfirmado: true }
      : { estado: 'parcial', verificado: false, ceroConfirmado: false };
  }
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

const slugImpuesto = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase();

/** ¿La pantalla ya muestra un cartel de "sin resultados"? Para no esperar una grilla que no vendrá. */
async function hayMensajeSinResultados(pagina) {
  for (const frame of pagina.frames()) {
    const loc = frame.locator(':text("No hay resultados"), :text("no se encontraron resultados"), :text("importe en cero"), :text("sin resultados")');
    if ((await loc.count().catch(() => 0)) && (await loc.first().isVisible().catch(() => false))) return true;
  }
  return false;
}

/** ¿Está visible alguno de los carteles declarados por la sección, en su frame? Devuelve el texto o null. */
async function cartelDeLaSeccion(pagina, textos, frameDatos) {
  for (const frame of pagina.frames()) {
    if (frameDatos && !String(frame.url?.() ?? '').includes(frameDatos)) continue;
    for (const t of textos) {
      const loc = frame.locator(`:text("${String(t).replace(/"/g, '')}")`);
      if ((await loc.count().catch(() => 0)) && (await loc.first().isVisible().catch(() => false))) return t;
    }
  }
  return null;
}

/** Lee la grilla actual (espera a que aparezca, recorre la paginación y deduplica). Solo lectura. */
async function leerGrilla(pagina, expected, frameDatos = null) {
  // La grilla puede tardar (iframe/SPA/pestaña nueva): esperamos hasta ~9s a que aparezca, pero
  // cortamos de inmediato si ARCA ya avisó "no hay resultados" (así no colgamos impuesto por impuesto).
  for (let i = 0; i < 6; i++) {
    const t = await scrapearFrames(pagina, expected, frameDatos);
    if (t && (t.rows.length > 0 || (expected.length && (t.coincideCols ?? 0) > 0))) break;
    if (await hayMensajeSinResultados(pagina)) break;
    await pagina.waitForTimeout(1500);
  }
  let headers = null; const filas = []; const vistas = new Set();
  let gridPresente = false; let paginas = 0; let duplicadosEnTabla = 0;
  // Cómo terminó la paginación. Solo 'sin-siguiente' es un fin NATURAL (no hay control "siguiente"
  // habilitado). Los demás no prueban que se leyó todo: 'pagina-repetida' (el "siguiente" no avanzó:
  // puede ser una falla de navegación), 'grilla-desaparecio' (tras pasar de página ya no había
  // grilla), 'tope' (corte de seguridad) y 'sin-grilla' (nunca hubo grilla).
  let finPaginacion = 'tope';
  for (let p = 0; p < TOPE_PAGINAS; p++) {
    const tabla = await scrapearFrames(pagina, expected, frameDatos);
    if (!tabla) { finPaginacion = p === 0 ? 'sin-grilla' : 'grilla-desaparecio'; break; }
    if (p === 0) gridPresente = expected.length ? (tabla.coincideCols ?? 0) > 0 : true;
    if (!headers) headers = tabla.headers;
    let nuevas = 0;
    for (const r of tabla.rows) {
      const firma = r.join('|');
      if (vistas.has(firma)) { duplicadosEnTabla++; continue; }
      vistas.add(firma); filas.push(r); nuevas++;
    }
    paginas = p + 1;
    if (!nuevas) { finPaginacion = p === 0 ? 'sin-siguiente' : 'pagina-repetida'; break; } // corte verificable
    const sig = await botonSiguiente(pagina);
    if (!sig) { finPaginacion = 'sin-siguiente'; break; }
    await sig.click().catch(() => {});
    await pagina.waitForTimeout(1500);
  }
  return { headers, filas, gridPresente, paginas, duplicadosEnTabla, finPaginacion };
}

export const TOPE_PAGINAS = 100;

/** Abre el servicio, extrae su grilla y cierra la página. Envuelve a extraerTablaEnPagina. */
export async function extraerTabla(sesion, servicio, opts = {}) {
  const pagina = await sesion.abrirServicio(servicio);
  await pagina.waitForTimeout(2500);
  try {
    const r = await extraerTablaEnPagina(pagina, servicio, opts);
    // Diagnóstico integral: DOM real de todas las pestañas abiertas (antes de cerrarlas).
    try { r.estructura = await relevarTodasLasPaginas(sesion, pagina); } catch { /* best-effort */ }
    return r;
  } finally {
    if (pagina !== sesion.page) await pagina.close().catch(() => {});
  }
}

/**
 * Núcleo del extractor sobre una página YA abierta (no la abre ni la cierra: el que llama es
 * dueño de la página). Lo usa tanto extraerTabla como el drill de hubs, que llega a la grilla
 * navegando en solo lectura y después extrae acá mismo, sin reabrir el servicio.
 */
export async function extraerTablaEnPagina(pagina, servicio, { desde, hasta, outDir = 'out/datos', dirSalida = null, log = () => {} }) {
  // dirSalida: carpeta del INTENTO (out/datos/<fuente>/intentos/<corrida>). Así un intento malo no
  // pisa los archivos buenos: la conservación decide después si se promueve a vigente.
  const dir = dirSalida ?? path.join(outDir, servicio.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const expected = (servicio.columnasEsperadas ?? []).map(norm);
  const resultado = { id: servicio.id, archivos: [], filas: 0, paginas: 0, informados: null, duplicadosEnTabla: 0, conFiltroPeriodo: false, rangoAplicado: null, estado: 'sin-datos', verificado: false };

  // Impuestos a consultar: Retenciones itera TODOS los impuestos reales del combo y guarda cada
  // uno por separado; el resto de los servicios hace una sola pasada (impuesto = null).
  let impuestos = [null];
  if (servicio.requiereImpuesto && servicio.selectorImpuesto) {
    impuestos = await listarImpuestos(pagina, servicio);
    if (!impuestos.length) {
      const rel0 = await relevarPagina(pagina).catch(() => ({ frames: [] }));
      escribirProtegido(path.join(dir, `diagnostico-${desde}-${hasta}.json`), JSON.stringify({ error: 'no se pudo listar el combo de impuesto', estructura: rel0 }, null, 2));
      resultado.estado = 'parcial';
      resultado.motivo = `requiere elegir un impuesto y no se pudo abrir/leer el combo (${servicio.selectorImpuesto})`;
      log(`  ${servicio.id}: parcial · combo de impuesto no disponible`);
      return resultado;
    }
    log(`  ${servicio.id}: ${impuestos.length} impuesto(s) a consultar`);
  }

  let gridPresente = false; let rangoOk = null; let errorUlt = null; let headersGuardados = null;
  let informadosTot = null; const mensajes = new Set(); const porImpuesto = [];
  const todasLasFilas = []; let finPaginacion = null; let encabezadosGrilla = null;
  // De dónde sale el total: 'paginador' (ARCA lo informa en el texto de la paginación) o 'tabla-unica'
  // (no hay paginador y se toman las filas de la única tabla visible: no es un cotejo independiente).
  const fuentesTotal = [];
  const PEOR_FIN = { tope: 4, 'grilla-desaparecio': 3, 'pagina-repetida': 2, 'sin-grilla': 1, 'sin-siguiente': 0 };

  for (let idx = 0; idx < impuestos.length; idx++) {
    const imp = impuestos[idx];
    // Cada impuesto está AISLADO: si uno se cuelga o tira error (frame que se desprende, timeout,
    // la pantalla /resultados que cambia), se registra y se sigue con el siguiente. Nunca propaga,
    // para que un impuesto problemático no tumbe la consulta ni, menos, la corrida entera.
    try {
      // Tras consultar, Mis Retenciones salta a /resultados; para la próxima consulta hay que
      // volver al formulario ("Volver a Consultar"), si no el combo y las fechas ya no están.
      if (idx > 0) await volverAlFormulario(pagina);
      const filtro = await completarFiltros(pagina, desde, hasta, servicio, log, imp);
      resultado.conFiltroPeriodo = filtro.conFiltroPeriodo;
      if (filtro.rangoAplicado) resultado.rangoAplicado = filtro.rangoAplicado;
      if (filtro.rangoOk === true) rangoOk = true; else if (rangoOk == null) rangoOk = filtro.rangoOk;
      if (filtro.error) {
        errorUlt = filtro.error;
        const rel0 = await relevarPagina(pagina).catch(() => ({ frames: [] }));
        escribirProtegido(path.join(dir, `diagnostico-${desde}-${hasta}${imp ? '-' + slugImpuesto(imp) : ''}.json`), JSON.stringify({ impuesto: imp, error: filtro.error, resultados: resumenResultados(rel0), estructura: rel0 }, null, 2));
        continue;
      }
      const g = await leerGrilla(pagina, expected, servicio.frameDatos ?? null);
      resultado.paginas += g.paginas; resultado.duplicadosEnTabla += g.duplicadosEnTabla;
      if (g.filas.length && (finPaginacion == null || PEOR_FIN[g.finPaginacion] > PEOR_FIN[finPaginacion])) finPaginacion = g.finPaginacion;
      // Encabezados reales de la grilla, aunque venga vacía: con ellos se valida la identidad de la sección.
      if (!encabezadosGrilla && g.headers?.length) encabezadosGrilla = g.headers;
      const res = resumenResultados(await relevarPagina(pagina));
      // ARCA avisa explícitamente cuando no hay datos: es un CERO confirmado, no una ausencia incierta.
      // El cartel puede venir como mensaje relevado o como texto suelto en la pantalla (Compensaciones
      // de Cuentas Tributarias: "No se encontraron resultados", corrida 2026-10-24).
      const sinResultados = (res.mensajes ?? []).some((m) => /no hay resultados|importe en cero|no se encontraron/i.test(m))
        || (!g.filas.length && await hayMensajeSinResultados(pagina));
      if (sinResultados && !g.filas.length) mensajes.add('ARCA informa: no se encontraron resultados');
      // Cero por CARTEL DE LA SECCIÓN: solo el texto que la sección declara (mensajesCero), visible en
      // SU frame (frameDatos). Ej.: Detalle de Deuda Consolidada -> "No registra deudas" (corrida 2026-10-25).
      if (!g.filas.length && servicio.mensajesCero?.length) {
        const cartel = await cartelDeLaSeccion(pagina, servicio.mensajesCero, servicio.frameDatos ?? null);
        if (cartel) { resultado.ceroPorCartel = cartel; mensajes.add(`ARCA informa: ${cartel}`); }
      }
      if (g.gridPresente || sinResultados || resultado.ceroPorCartel) gridPresente = true;
      for (const m of (res.mensajes ?? [])) { const s = String(m).trim(); if (s) mensajes.add(s); }
      const informados = totalInformado(res);
      if (informados != null) informadosTot = (informadosTot ?? 0) + informados;
      if (g.filas.length) fuentesTotal.push(totalInformado({ ...res, tablasVisibles: [] }) != null ? 'paginador' : informados != null ? 'tabla-unica' : null);
      if (g.headers && g.filas.length) {
        if (!headersGuardados) headersGuardados = g.headers;
        const suf = imp ? `-${slugImpuesto(imp)}` : '';
        const file = path.join(dir, `${servicio.id}${suf}-${desde}-${hasta}.csv`);
        escribirProtegido(file, toCsv(g.filas, COLUMNAS_LIBRES(g.headers)));
        resultado.archivos.push(path.basename(file));
        resultado.filas += g.filas.length;
        for (const f of g.filas) todasLasFilas.push(f);
        porImpuesto.push({ impuesto: imp, filas: g.filas.length, informados });
      } else {
        porImpuesto.push({ impuesto: imp, filas: 0, cero: sinResultados });
        if (impuestos.length === 1 && !sinResultados) escribirProtegido(path.join(dir, `diagnostico-${desde}-${hasta}.json`), JSON.stringify(res, null, 2));
      }
    } catch (e) {
      errorUlt = sanitizarTexto(`impuesto ${imp ?? '(único)'}: ${e?.message ?? String(e)}`);
      porImpuesto.push({ impuesto: imp, filas: 0, error: errorUlt });
      log(`  ${servicio.id}: impuesto ${imp ?? ''} falló (aislado): ${errorUlt}`);
    }
  }

  resultado.informados = informadosTot;
  resultado.gridPresente = gridPresente;
  if (porImpuesto.length > 1) resultado.porImpuesto = porImpuesto;
  if (headersGuardados) resultado.columnas = headersGuardados;
  if (encabezadosGrilla) resultado.encabezadosGrilla = encabezadosGrilla;
  resultado.finPaginacion = finPaginacion;
  // Cotejado contra ARCA solo si TODAS las consultas con filas traían el total en el paginador.
  resultado.totalFuente = !fuentesTotal.length ? null
    : fuentesTotal.every((f) => f === 'paginador') ? 'paginador'
    : fuentesTotal.some((f) => f) ? 'tabla-unica' : null;
  resultado.rangoOk = rangoOk;
  // Controles sobre las filas (sin guardarlas en el resultado: solo conteos).
  if (resultado.filas) {
    if (resultado.conFiltroPeriodo) resultado.fechas = verificarFechas(headersGuardados, todasLasFilas, desde, hasta, servicio.columnaFecha);
    const est = resumenEstados(headersGuardados, todasLasFilas);
    if (Object.keys(est).length) resultado.resumenEstados = est;
  }
  resultado.coincideInformado = informadosTot == null ? null : resultado.filas === informadosTot;
  const d = decidirEstado({ filas: resultado.filas, informados: informadosTot, conFiltroPeriodo: resultado.conFiltroPeriodo, rangoOk, error: resultado.filas ? null : errorUlt, gridPresente });
  resultado.estado = d.estado;
  resultado.verificado = d.verificado;
  if (d.ceroConfirmado != null) resultado.ceroConfirmado = d.ceroConfirmado;
  if (resultado.filas === 0) {
    resultado.motivo = errorUlt
      ? errorUlt
      : d.ceroConfirmado
        ? 'grilla presente y vacía: 0 filas confirmado para el rango'
        : 'no se confirmó la grilla de resultados (pestaña/consulta sin verificar): ausencia incierta, no es un cero';
    if (mensajes.size) { resultado.mensajes = [...mensajes]; resultado.motivo += ` · pantalla: ${[...mensajes].join(' / ')}`; }
  }
  log(`  ${servicio.id}: ${resultado.estado} · ${resultado.filas} filas / informados ${resultado.informados ?? '?'} · ${resultado.paginas} páginas${resultado.conFiltroPeriodo ? '' : ' · sin filtro de período (datos acumulados)'}${resultado.motivo ? ` · ${resultado.motivo}` : ''}`);
  return resultado;
}
