/**
 * Navegación de SOLO LECTURA hacia la grilla de un servicio, por RUTA EXPLÍCITA.
 *
 * Aprendimos (corrida 2026-10-20T18-53-32) que elegir enlaces por palabras genéricas no sirve:
 * en la pantalla de inicio del portal "Envianos tu consulta", "¿Cómo consultar…?", "Ver todos"
 * y hasta un "CONSULTAR" de portada matchean un verbo pero NO son el servicio. Por eso acá no se
 * adivina: cada servicio declara su `ruta` (pasos concretos, tomados de la estructura real), y si
 * no la tiene, el drill no clickea nada: releva y deja la estructura capturada para escribir la
 * ruta. Nunca toca controles de trámite, pago, emisión ni modificación (esProhibido).
 */
import { esProhibido, norm } from './extractor.js';

const cssEscape = (id) => String(id).replace(/([^\w-])/g, '\\$1');
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Guard de seguridad: un paso de ruta nunca debe ser un control de trámite/pago/emisión. */
export function esPasoSeguro(texto) {
  return !esProhibido(String(texto ?? ''));
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

/**
 * Ejecuta un paso de ruta EXPLÍCITO en cualquier frame. El paso es uno de:
 *   { id }        -> por id exacto.
 *   { selector }  -> por selector CSS.
 *   { texto }     -> por texto EXACTO (no subcadena: así no cae en el chrome del portal que
 *                    apenas contiene la palabra). Devuelve true si clickeó.
 */
async function ejecutarPaso(pagina, paso, log) {
  for (const frame of pagina.frames()) {
    let loc = null;
    if (paso.id) {
      const l = frame.locator(`#${cssEscape(paso.id)}`);
      if (await l.count().catch(() => 0)) loc = l.first();
    } else if (paso.selector) {
      const l = frame.locator(paso.selector);
      if (await l.count().catch(() => 0)) loc = l.first();
    } else if (paso.texto) {
      const exacto = new RegExp(`^\\s*${escapeRegex(paso.texto)}\\s*$`, 'i');
      const l = frame.locator('a, button, [role=button], [role=menuitem], [role=tab], [role=option], li').filter({ hasText: exacto });
      if (await l.count().catch(() => 0)) loc = l.first();
    }
    if (!loc) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    const real = (await loc.innerText().catch(() => '')) || paso.texto || '';
    if (!esPasoSeguro(real)) throw new Error(`paso de ruta bloqueado por seguridad (parece trámite): ${JSON.stringify(real)}`);
    log(`  ruta (lectura): ${JSON.stringify(paso.texto ?? paso.id ?? paso.selector)}`);
    await loc.click().catch(() => {});
    await pagina.waitForLoadState('networkidle').catch(() => {});
    await pagina.waitForTimeout(2000);
    return true;
  }
  return false;
}

/**
 * Lleva la página hasta la grilla del servicio siguiendo su `ruta` explícita, en solo lectura.
 * Si ya hay grilla/filtros, no navega. Sin ruta, NO adivina: devuelve lista=false y deja la
 * estructura capturada para escribir la ruta. `relevar` es inyectable para test.
 */
export async function drillHaciaGrilla(pagina, { expected = [], ruta = [], log = () => {}, relevar } = {}) {
  const relevarPagina = relevar ?? (await import('./relevar.js')).relevarPagina;
  let señales = grillaLista(await relevarPagina(pagina), expected);
  if (señales.lista) return { lista: true, pasos: 0, señales };
  if (!ruta.length) return { lista: false, pasos: 0, señales, motivo: 'sin ruta de navegación confirmada' };

  let pasos = 0;
  for (const paso of ruta) {
    const ok = await ejecutarPaso(pagina, paso, log);
    if (!ok) return { lista: false, pasos, señales, motivo: `no se encontró el paso ${JSON.stringify(paso)}` };
    pasos++;
    señales = grillaLista(await relevarPagina(pagina), expected);
    if (señales.lista) return { lista: true, pasos, señales };
  }
  return { lista: señales.lista, pasos, señales, motivo: señales.lista ? undefined : 'la ruta terminó sin llegar a una grilla' };
}
