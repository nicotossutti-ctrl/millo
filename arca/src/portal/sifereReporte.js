/**
 * SIFERE WEB: descarga automática del «Reporte» (PDF) de las CM03 PRESENTADAS, desde el «Listado de Declaraciones
 * Juradas Mensuales» (MostrarListaDDJJController.do), y su lectura con src/app/cm03.js. Solo lectura.
 *
 * En «Acciones» cada fila tiene tres íconos: «Crear DJ a partir de copia», «Pago» y «Reporte» (impresora). Se hace clic
 * SOLO en un control que se identifique sin dudas como reporte o impresión de la DJ (por su título, texto, ícono o
 * función) y que no diga nada de pago, VEP, copia, crear, presentar ni modificar. Si en una fila no hay exactamente uno
 * así, no se hace clic: se guarda cómo es cada control (saneado) para escribir la regla con evidencia.
 */
import { esProhibido } from './extractor.js';
import { importarCm03, cm03DelPeriodo } from '../app/cm03.js';
import { sanitizarTexto } from './diagnostico.js';

// Lo que NUNCA se toca en la fila, además de lo prohibido en general (presentar, pagar, VEP, modificar…).
const NO_TOCAR = /pago|pagar|vep|copia|crear|nueva|duplicar|borrar|eliminar|editar|rectific|presentar|volante|billetera/i;
const ES_REPORTE = /reporte|imprimir|impresi[oó]n|print|pdf|impresora/i;

/** ¿Qué es un control de la columna Acciones, por su descripción? 'reporte' | 'no-tocar' | 'desconocido'. Pura. */
export function clasificarAccion(desc) {
  const d = String(desc ?? '');
  if (esProhibido(d) || NO_TOCAR.test(d)) return 'no-tocar';
  return ES_REPORTE.test(d) ? 'reporte' : 'desconocido';
}

/**
 * Corre EN EL NAVEGADOR: filas del listado con anticipo, estado y los controles de su columna Acciones (cada uno marcado
 * con data-fiscalos-accion para poder hacerle clic después). Autocontenida.
 */
export function filasDelListado() {
  const out = [];
  const limpio = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  for (const [ti, t] of [...document.querySelectorAll('table')].entries()) {
    const ths = [...t.querySelectorAll('thead th, tr:first-child th')].map((th) => limpio(th.textContent).toLowerCase());
    const ia = ths.findIndex((h) => /^anticipo/.test(h)); const ie = ths.findIndex((h) => /^estado/.test(h)); const ic = ths.findIndex((h) => /^acciones/.test(h));
    if (ia < 0 || ie < 0 || ic < 0) continue;
    for (const [ri, tr] of [...t.querySelectorAll('tbody tr')].entries()) {
      const tds = tr.querySelectorAll('td');
      if (tds.length <= Math.max(ia, ie, ic)) continue;
      const acciones = [];
      const vistos = new Set();
      for (const el of tds[ic].querySelectorAll('a, button, [onclick], input[type=button], input[type=image], img, i, span[role=button]')) {
        // El control clickeable es el <a>/<button> que contiene al ícono, si lo hay.
        const ctrl = el.closest('a, button, [onclick], input') ?? el;
        if (vistos.has(ctrl)) continue; vistos.add(ctrl);
        const img = ctrl.querySelector('img') ?? (ctrl.tagName === 'IMG' ? ctrl : null);
        const icono = ctrl.querySelector('i, span[class]');
        const desc = [ctrl.getAttribute('title'), ctrl.getAttribute('aria-label'), ctrl.getAttribute('alt'), ctrl.getAttribute('data-original-title'), ctrl.getAttribute('data-bs-original-title'),
          limpio(ctrl.textContent), img?.getAttribute('alt'), img?.getAttribute('title'), img ? String(img.getAttribute('src') ?? '').split(/[?#]/)[0].split('/').pop() : null,
          icono?.className, ctrl.className, String(ctrl.getAttribute('onclick') ?? '').replace(/\(.*$/s, ''), String(ctrl.getAttribute('href') ?? '').startsWith('javascript:') ? String(ctrl.getAttribute('href')).slice(11).replace(/\(.*$/s, '') : String(ctrl.getAttribute('href') ?? '').split(/[?#]/)[0]]
          .filter(Boolean).join(' | ');
        const marca = `t${ti}f${ri}a${acciones.length}`;
        ctrl.setAttribute('data-fiscalos-accion', marca);
        acciones.push({ marca, desc: desc.slice(0, 300) });
      }
      out.push({ anticipo: limpio(tds[ia].textContent), estado: limpio(tds[ie].textContent), acciones });
    }
  }
  return out;
}

/** Espera un PDF que llegue por descarga o como respuesta (pestaña nueva o la misma). Devuelve Buffer o null. */
async function esperarPdf(contexto, pagina, disparar, ms = 25000, obtener = null) {
  let resolver; const listo = new Promise((ok) => { resolver = ok; });
  const alResponder = async (r) => {
    if (!/application\/pdf/i.test(r.headers()['content-type'] ?? '')) return;
    try {
      // Abierto en el visor de PDF del navegador, el cuerpo de la respuesta ya no es el PDF: se vuelve a pedir la misma
      // dirección (GET, con la misma sesión). Si no fue un GET, se toma el cuerpo solo si es un PDF.
      const traer = obtener ?? (contexto?.request ? async (u) => (await contexto.request.get(u)).body() : null);
      if (r.request().method() === 'GET' && traer) { const b = await traer(r.url()); if (b?.subarray(0, 5).toString('latin1') === '%PDF-') { resolver(b); return; } }
      const b = await r.body(); if (b.subarray(0, 5).toString('latin1') === '%PDF-') resolver(b);
    } catch { /* el cuerpo no se puede leer: sigue esperando */ }
  };
  const alDescargar = async (d) => { try { const s = await d.createReadStream(); const partes = []; for await (const c of s) partes.push(c); resolver(Buffer.concat(partes)); } catch { resolver(null); } };
  const paginasNuevas = [];
  const alAbrir = (p) => { paginasNuevas.push(p); p.on('download', alDescargar); };
  contexto?.on?.('response', alResponder); contexto?.on?.('page', alAbrir); pagina.on('download', alDescargar);
  if (!contexto) pagina.on('response', alResponder);
  try {
    await disparar();
    return await Promise.race([listo, new Promise((ok) => setTimeout(() => ok(null), ms))]);
  } finally {
    contexto?.off?.('response', alResponder); contexto?.off?.('page', alAbrir); pagina.off('download', alDescargar);
    if (!contexto) pagina.off('response', alResponder);
    for (const p of paginasNuevas) await p.close().catch(() => {});
  }
}

/**
 * En el listado ya abierto: baja el Reporte de cada CM03 PRESENTADA de los `meses` pedidos que todavía no tenga leída esa
 * versión (o una posterior), y la importa. Devuelve { reportes: [{ anticipo, mes, rectificativa, decision, motivo,
 * estado? }], filas }. No toca nada si el control no es inequívoco. `obtenerPdf(url)` trae de nuevo el PDF abierto en el
 * visor (por defecto, un GET con la sesión del navegador).
 */
export async function bajarReportesCm03(pagina, { meses, outDir, log = () => {}, maximo = 8, esperaMs = 25000, obtenerPdf = null } = {}) {
  // Mostrar todas las filas de la lista (DataTables muestra 10 por página): es solo la cantidad visible.
  const largo = pagina.locator('select[name$="_length"]');
  if (await largo.count().catch(() => 0)) { await largo.first().selectOption('100').catch(() => {}); await pagina.waitForTimeout(800).catch(() => {}); }
  const filas = await pagina.evaluate(filasDelListado).catch(() => []);
  const quiero = new Set(meses);
  const reportes = [];
  for (const f of filas) {
    const m = f.anticipo.match(/^(\d{4})(\d{2})\s*-\s*(\d+)/);
    if (!m) continue;
    const mes = `${m[1]}-${m[2]}`; const rectificativa = Number(m[3]);
    if (!quiero.has(mes) || !/presentada/i.test(f.estado)) continue;
    const base = { anticipo: `${m[1]}${m[2]} - ${m[3]}`, mes, rectificativa };
    const ya = cm03DelPeriodo(outDir, mes).vigente;
    if (ya && ya.rectificativa >= rectificativa) { reportes.push({ ...base, decision: 'ya leída', motivo: `ya está la ${ya.rectificativa ? `rectificativa ${ya.rectificativa}` : 'original'}` }); continue; }
    if (reportes.filter((r) => r.decision === 'bajada').length >= maximo) { reportes.push({ ...base, decision: 'pospuesta', motivo: `tope de ${maximo} reportes por corrida` }); continue; }
    const tipos = f.acciones.map((a) => ({ ...a, tipo: clasificarAccion(a.desc) }));
    const rep = tipos.filter((a) => a.tipo === 'reporte');
    const controles = tipos.map((a) => ({ tipo: a.tipo, desc: sanitizarTexto(a.desc) }));
    if (rep.length !== 1) {
      reportes.push({ ...base, decision: 'sin clic', motivo: rep.length ? `${rep.length} controles parecen reporte: no se elige uno` : 'ningún control se identifica sin dudas como «Reporte»', controles });
      continue;
    }
    log(`  sifere: bajo el Reporte de la CM03 ${base.anticipo} (solo lectura).`);
    // Clic normal; si el ícono no tiene tamaño visible, el clic del DOM sobre ese mismo control (ya identificado).
    const ctrl = pagina.locator(`[data-fiscalos-accion="${rep[0].marca}"]`).first();
    const clic = () => ctrl.click({ timeout: 5000 }).catch(() => ctrl.evaluate((el) => el.click()));
    const pdf = await esperarPdf(pagina.context?.(), pagina, clic, esperaMs, obtenerPdf).catch(() => null);
    if (!pdf || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') { reportes.push({ ...base, decision: 'sin PDF', motivo: 'el Reporte no devolvió un PDF', controles }); continue; }
    try {
      // El mes y la versión se verifican ANTES de guardar: un PDF de otra versión queda en revisión, nunca vigente.
      const r = await importarCm03(outDir, { nombre: `cm03-${m[1]}${m[2]}-${m[3]}-sifere.pdf`, contenido: pdf, mes, rectificativaEsperada: rectificativa });
      // El mismo PDF ya importado antes (p. ej. a mano) vuelve tal como estaba: si es de otra versión, se avisa.
      const coincide = r.estado !== 'valida' || (r.periodo === mes && r.rectificativa === rectificativa);
      reportes.push({ ...base, decision: 'bajada', estado: coincide ? r.estado : 'revision',
        motivo: r.estado !== 'valida' ? r.motivos.join('; ') : coincide ? (r.yaImportado ? 'ya estaba importado' : 'leída') : `el PDF (ya importado antes) dice ${r.periodo} rectificativa ${r.rectificativa}, la lista ${base.anticipo}` });
    } catch (e) { reportes.push({ ...base, decision: 'bajada', estado: 'error', motivo: sanitizarTexto(e.message) }); }
  }
  return { reportes, filas: filas.length };
}
