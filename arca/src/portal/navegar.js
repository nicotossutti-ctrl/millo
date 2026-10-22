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
 *                    apenas contiene la palabra).
 *   { opcional }  -> si no se encuentra, no es error (p. ej. cerrar un modal que puede no estar).
 * Muchos servicios de ARCA abren la grilla en una PESTAÑA NUEVA; por eso, si el clic abre una
 * página nueva, la devolvemos en `nueva` para seguir ahí. Devuelve { clickeado, nueva }.
 */
// Primer elemento VISIBLE entre los que coinciden. No alcanza con `.first()`: el NavBar de Cuentas
// Tributarias (dynarch) guarda el menú como <a> OCULTOS (la fuente) y dibuja aparte los ítems
// visibles; `.first()` agarraba el <a> oculto y el paso se daba por no encontrado.
async function primeroVisible(l, max = 12) {
  const n = Math.min(await l.count().catch(() => 0), max);
  for (let i = 0; i < n; i++) {
    const it = typeof l.nth === 'function' ? l.nth(i) : l.first();
    if (await it.isVisible().catch(() => false)) return it;
  }
  return null;
}

async function ubicarPaso(pagina, paso) {
  for (const frame of pagina.frames()) {
    const candidatos = [];
    if (paso.id) {
      candidatos.push(frame.locator(`#${cssEscape(paso.id)}`));
    } else if (paso.selector) {
      candidatos.push(frame.locator(paso.selector));
    } else if (paso.texto) {
      // Exacto pero sin distinguir mayúsculas (la barra lateral muestra "DECLARACIONES JURADAS (DJ)").
      const exacto = new RegExp(`^\\s*${escapeRegex(paso.texto)}\\s*$`, 'i');
      candidatos.push(frame.locator('a, button, [role=button], [role=menuitem], [role=tab], [role=option], li').filter({ hasText: exacto }));
      // También tarjetas/paneles/celdas con ese texto (DDJJ "Presentaciones", Ganancias
      // "Declaración Jurada", ítems dibujados por el NavBar): no son <button>/<a> pero se clickean.
      if (typeof frame.getByText === 'function') candidatos.push(frame.getByText(exacto));
    }
    for (const l of candidatos) {
      // Con `oculto` se toma el primero aunque no esté visible y se clickea por DOM.
      if (paso.oculto) { if (await l.count().catch(() => 0)) return l.first(); continue; }
      const vis = await primeroVisible(l);
      if (vis) return vis;
    }
  }
  return null;
}

/** ¿Hay un control visible con ese texto exacto (sin mayúsculas) en algún frame? */
async function textoVisible(pagina, texto) {
  return (await ubicarPaso(pagina, { texto })) !== null;
}

async function ejecutarPaso(pagina, paso, log) {
  // Paso de SPA por hash (Portal IVA es Angular con rutas #/...): en vez de buscar un control,
  // navegamos la ruta interna. Es solo lectura (una vista de consulta) y usa la URL real vista.
  if (paso.hash) {
    log(`  ruta (lectura): hash ${JSON.stringify(paso.hash)}`);
    await pagina.evaluate((h) => { window.location.hash = h; }, paso.hash).catch(() => {});
    await pagina.waitForLoadState?.('networkidle').catch(() => {});
    await pagina.waitForTimeout?.(2500);
    return { clickeado: true, nueva: null };
  }
  // Reintentamos unas veces: muchos servicios renderizan el control tarde (SPA). Un paso
  // opcional (p. ej. un modal que puede no estar) no espera.
  const intentos = paso.opcional ? 1 : 5;
  let loc = null;
  for (let i = 0; i < intentos && !loc; i++) {
    loc = await ubicarPaso(pagina, paso);
    if (!loc && i < intentos - 1) await pagina.waitForTimeout?.(1200);
  }
  if (!loc) return { clickeado: false, nueva: null };
  const real = (await loc.innerText().catch(() => '')) || paso.texto || '';
  if (!esPasoSeguro(real)) throw new Error(`paso de ruta bloqueado por seguridad (parece trámite): ${JSON.stringify(real)}`);
  log(`  ruta (lectura): ${JSON.stringify(paso.texto ?? paso.id ?? paso.selector)}`);
  const nueva = await clickSiguiendoPestaña(pagina, loc, paso.oculto);
  return { clickeado: true, nueva };
}

/**
 * Clic que, si abre una pestaña nueva, la espera y la devuelve. Si no, devuelve null.
 * Con `oculto`, el control no está visible (enlace de menú colapsado): se dispara el clic real del
 * DOM (`el.click()`), que sigue el href del <a> igual que un clic del usuario. Solo lectura.
 */
async function clickSiguiendoPestaña(pagina, loc, oculto = false) {
  const hacerClick = () => (oculto
    ? loc.evaluate((el) => el.click()).catch(() => {})
    : loc.click().catch(() => {}));
  const ctx = typeof pagina.context === 'function' ? pagina.context() : null;
  if (ctx && typeof ctx.waitForEvent === 'function') {
    const [nueva] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 12000 }).catch(() => null),
      hacerClick(),
    ]);
    if (nueva) {
      await nueva.waitForLoadState('domcontentloaded').catch(() => {});
      await nueva.waitForLoadState('networkidle').catch(() => {});
      await nueva.waitForTimeout(1500).catch(() => {});
      return nueva;
    }
  } else {
    await hacerClick();
  }
  await pagina.waitForLoadState?.('networkidle').catch(() => {});
  await pagina.waitForTimeout?.(2000);
  return null;
}

/**
 * Lleva hasta la grilla del servicio siguiendo su `ruta` explícita, en solo lectura. Si ya hay
 * grilla/filtros, no navega. Sin ruta, NO adivina. Si un paso abre una pestaña nueva, sigue en
 * ella. Devuelve también `pagina` (la página final, que puede ser una pestaña nueva) para que
 * el extractor trabaje ahí. `relevar` es inyectable para test.
 */
// Espera a que la grilla/filtros aparezcan (tras navegar, la SPA puede renderizar tarde).
async function esperarLista(relevarPagina, pagina, expected, veces) {
  let señales = { lista: false };
  for (let i = 0; i < veces; i++) {
    señales = grillaLista(await relevarPagina(pagina), expected);
    if (señales.lista) return señales;
    if (i < veces - 1) await pagina.waitForTimeout?.(1500);
  }
  return señales;
}

export async function drillHaciaGrilla(pagina, { expected = [], ruta = [], log = () => {}, relevar } = {}) {
  const relevarPagina = relevar ?? (await import('./relevar.js')).relevarPagina;
  let actual = pagina;
  let señales = await esperarLista(relevarPagina, actual, expected, 1);
  // Sin ruta: si ya hay grilla, listo; si no, no adivinamos.
  if (!ruta.length) {
    return señales.lista
      ? { lista: true, pasos: 0, señales, pagina: actual }
      : { lista: false, pasos: 0, señales, pagina: actual, motivo: 'sin ruta de navegación confirmada' };
  }
  // Con ruta: la ejecutamos SIEMPRE. La grilla inicial puede NO ser la buscada (p. ej. la pestaña
  // Vencimientos de Cuentas Tributarias no es DJ/Pagos/Cuenta Corriente).
  let pasos = 0;
  for (const paso of ruta) {
    // `siNoVisible`: el paso solo PREPARA (abrir la barra lateral, expandir "Consultas") y se
    // saltea si el ítem buscado ya está a la vista. Si no, un hamburguesa que es TOGGLE cerraba
    // una barra que ya venía abierta.
    if (paso.siNoVisible && await textoVisible(actual, paso.siNoVisible)) {
      log(`  ruta: ${JSON.stringify(paso.siNoVisible)} ya visible, se omite ${JSON.stringify(paso.texto ?? paso.selector ?? paso.id)}`);
      continue;
    }
    const r = await ejecutarPaso(actual, paso, log);
    if (!r.clickeado) {
      if (paso.opcional) continue; // p. ej. un modal de novedades que puede no aparecer
      return { lista: false, pasos, señales, pagina: actual, motivo: `no se encontró el paso ${JSON.stringify(paso)}` };
    }
    if (r.nueva) actual = r.nueva;
    pasos++;
    // Tras navegar, damos tiempo generoso a que la grilla aparezca (iframe/SPA Angular/EJ2).
    señales = await esperarLista(relevarPagina, actual, expected, 6);
    // `continuar`: NO cortar acá aunque ya haya grilla. Lo usan los pasos que solo PREPARAN la
    // navegación (p. ej. abrir la barra lateral de Cuentas Tributarias): la home ya muestra la
    // grilla de Vencimientos, así que sin esto el drill se detenía ahí y nunca clickeaba el ítem
    // del menú (DJ/Pagos/…). Con `continuar` sigue hasta el paso que lleva de verdad a la sección.
    if (señales.lista && !paso.continuar) return { lista: true, pasos, señales, pagina: actual };
  }
  return { lista: señales.lista, pasos, señales, pagina: actual, motivo: señales.lista ? undefined : 'la ruta terminó sin llegar a una grilla' };
}
