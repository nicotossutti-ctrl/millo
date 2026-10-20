/**
 * Navegación de SOLO LECTURA para hubs: pantallas que no muestran la grilla directamente sino
 * botones tipo INGRESAR / CONSULTAR / VER que hay que atravesar un nivel para llegar a los datos
 * (Portal IVA, Presentación de DDJJ y Pagos, SIFERE, Ganancias Personas Humanas).
 *
 * El drill hace clic SOLO en controles de avance de lectura (consultar, ingresar, ver, detalle,
 * continuar, siguiente, buscar…), nunca en trámite, pago, emisión ni modificación (esProhibido).
 * No completa formularios de alta ni confirma nada. Si no encuentra por dónde avanzar, se detiene
 * y deja un diagnóstico saneado para escribir el extractor real en la próxima tanda.
 */
import { esProhibido, norm } from './extractor.js';

// Verbos que SÍ son navegación de lectura. "aceptar/confirmar/guardar" quedan fuera a propósito.
const AVANCE = /\b(consultar|consulta|ingresar|ingreso|ver|detalle|detalles|continuar|siguiente|buscar|mostrar|desplegar|listar|seleccionar)\b/i;

/** true si el texto de un control es un avance de lectura seguro (y no un trámite prohibido). */
export function esAvanceLectura(texto) {
  const t = String(texto ?? '').trim();
  if (!t) return false;
  if (esProhibido(t)) return false;
  // "volver", "salir", "cerrar", "cancelar" navegan hacia afuera: no son avance.
  if (/\b(volver|salir|cerrar|cancelar|atr[aá]s|inicio)\b/i.test(t)) return false;
  return AVANCE.test(t);
}

// Rango de prioridad: cuanto más abajo, antes se intenta.
const RANKS = ['consultar', 'consulta', 'ingresar', 'ingreso', 'ver detalle', 'detalle', 'ver', 'listar', 'mostrar', 'continuar', 'siguiente', 'buscar', 'seleccionar', 'desplegar'];
function rango(texto) {
  const t = norm(texto);
  for (let i = 0; i < RANKS.length; i++) if (t.includes(RANKS[i])) return i;
  return RANKS.length;
}

/**
 * A partir de un relevamiento (relevarPagina), devuelve los controles por los que conviene
 * avanzar, ordenados por prioridad, sin repetir textos ya visitados ni controles prohibidos.
 * Pura: no toca el navegador. Cada candidato trae { texto, id, tag, frame }.
 */
export function elegirAvances(rel, { yaVistas = [] } = {}) {
  const vistos = new Set(yaVistas.map(norm));
  const out = [];
  const porTexto = new Set();
  const frames = rel?.frames ?? [];
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    const controles = [...(f.botones ?? []), ...(f.enlaces ?? []), ...(f.conRol ?? [])];
    for (const c of controles) {
      if (c.visible === false) continue;
      const texto = (c.text ?? c.ariaLabel ?? c.title ?? '').trim();
      if (!esAvanceLectura(texto)) continue;
      const clave = norm(texto);
      if (vistos.has(clave) || porTexto.has(clave)) continue;
      porTexto.add(clave);
      out.push({ texto, id: c.id ?? null, tag: c.tag ?? null, frame: fi });
    }
  }
  return out.sort((a, b) => rango(a.texto) - rango(b.texto));
}

/**
 * ¿La página ya muestra una grilla de datos o al menos los filtros para consultarla? Pura.
 * - hayGrillaConDatos: alguna tabla visible con filas.
 * - hayGrillaEsperada: alguna tabla cuyos encabezados coinciden con los esperados del servicio.
 * - hayFiltroFecha: inputs de fecha para que el extractor complete el período y consulte.
 */
export function grillaLista(rel, expected = []) {
  const exp = expected.map(norm);
  let hayGrillaConDatos = false, hayGrillaEsperada = false, hayFiltroFecha = false;
  for (const f of rel?.frames ?? []) {
    for (const t of f.tablas ?? []) {
      if (t.visible === false) continue;
      if ((t.filas ?? 0) > 0) hayGrillaConDatos = true;
      const enc = (t.encabezados ?? []).map(norm);
      if (exp.length && exp.every((e) => enc.some((h) => h.includes(e)))) hayGrillaEsperada = true;
    }
    for (const i of f.inputs ?? []) {
      const marca = norm(`${i.placeholder ?? ''} ${i.id ?? ''} ${i.name ?? ''}`);
      if (/dd\/mm\/aaaa/.test(i.placeholder ?? '') || /fecha|periodo|desde|hasta/.test(marca)) hayFiltroFecha = true;
    }
  }
  return { hayGrillaConDatos, hayGrillaEsperada, hayFiltroFecha, lista: hayGrillaConDatos || hayGrillaEsperada || hayFiltroFecha };
}

/** Hace clic en un control de avance (por id si lo tiene, si no por texto) en cualquier frame. Solo lectura. */
async function clickAvance(pagina, cand, log) {
  for (const frame of pagina.frames()) {
    let loc = null;
    if (cand.id) {
      const porId = frame.locator(`#${String(cand.id).replace(/([^\w-])/g, '\\$1')}`);
      if (await porId.count().catch(() => 0)) loc = porId.first();
    }
    if (!loc) {
      const porTexto = frame.locator('a, button, [role=button], [role=menuitem], [role=tab]').filter({ hasText: cand.texto });
      if (await porTexto.count().catch(() => 0)) loc = porTexto.first();
    }
    if (!loc) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    // Doble chequeo de seguridad: el texto real del control no debe ser un trámite.
    const real = (await loc.innerText().catch(() => '')) || cand.texto;
    if (!esAvanceLectura(real)) return false;
    log(`  avanzando (lectura): ${JSON.stringify(cand.texto)}`);
    await loc.click().catch(() => {});
    await pagina.waitForLoadState('networkidle').catch(() => {});
    await pagina.waitForTimeout(2000);
    return true;
  }
  return false;
}

/**
 * Atraviesa un hub en solo lectura hasta encontrar una grilla o sus filtros, con tope de niveles.
 * Devuelve { lista, niveles, visitados, señales } usando relevarPagina (inyectable para test).
 * No extrae: deja la página en el nivel alcanzado para que el extractor de tabla siga desde ahí.
 */
export async function drillHaciaGrilla(pagina, { expected = [], log = () => {}, maxNiveles = 3, relevar } = {}) {
  const relevarPagina = relevar ?? (await import('./relevar.js')).relevarPagina;
  const visitados = [];
  let niveles = 0;
  let señales = { lista: false };
  for (let i = 0; i <= maxNiveles; i++) {
    const rel = await relevarPagina(pagina);
    señales = grillaLista(rel, expected);
    if (señales.lista) return { lista: true, niveles, visitados, señales };
    if (i === maxNiveles) break;
    const avances = elegirAvances(rel, { yaVistas: visitados });
    let avanzó = false;
    for (const cand of avances) {
      if (await clickAvance(pagina, cand, log)) { visitados.push(cand.texto); niveles++; avanzó = true; break; }
    }
    if (!avanzó) break; // no hay por dónde seguir en lectura
  }
  return { lista: señales.lista, niveles, visitados, señales };
}
