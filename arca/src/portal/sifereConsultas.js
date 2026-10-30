/**
 * SIFERE WEB – Consultas (Comisión Arbitral): los PAGOS realizados de Ingresos Brutos de Convenio Multilateral.
 *
 * Lo confirmado por la documentación oficial de la Comisión Arbitral (preguntas frecuentes «SIFERE WEB Consultas»; guía
 * «¿Cómo consultar estados de DDJJ y de deuda en IIBB?», evento 85): menú «INICIO · PADRON WEB · SIFERE · DEDUCCIONES ·
 * SIRCAR · SALIR»; en «SIFERE», «DDJJ» (Mensuales, Anuales), «Pagos» y «Resumen de DDJJs y Pagos». Las consultas piden
 * el período con desplegables «Anticipo desde / hasta» (mes y año) y «Buscar»; la de pagos, además, la JURISDICCIÓN.
 * Las pantallas internas no se vieron todavía en una corrida (la del 28/10 no cargó el sitio), así que no hay
 * selectores: se sigue el menú por sus RÓTULOS, los filtros se reconocen por sus OPCIONES (meses, años, jurisdicciones)
 * y la grilla por sus COLUMNAS. Si un paso no es inequívoco, no se hace clic y se informa el motivo.
 *
 * Solo lectura: nunca se toca nada que diga pagar, VEP, generar, volante, presentar, crear, rectificar ni eliminar.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { esProhibido, extraerTablasEnDocumento } from './extractor.js';
import { columnasFaltantes } from './calidad.js';
import { claveJurisdiccion } from '../app/iibbConciliacion.js';

const NO_TOCAR = /pagar|vep|generar|volante|presentar|crear|nueva|rectific|eliminar|borrar|modificar/i;
const seguro = (t) => !esProhibido(t) && !NO_TOCAR.test(t);
const limpio = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** ¿Este rótulo lleva a la consulta de pagos? «Pagos», «Consulta de pagos», «Pagos realizados»… nunca «Pagar». Pura. */
export function esRotuloPagos(texto) {
  const t = limpio(texto).toLowerCase();
  return seguro(t) && /^(consulta(s)? de )?pagos( realizados| efectuados| mensuales)?$/.test(t);
}

/** Controles visibles u ocultos (menús desplegables) cuyo texto cumple `test`, en todos los frames. */
async function controles(pagina, test) {
  const out = [];
  for (const frame of pagina.frames()) {
    const loc = frame.locator('a, button, [role=menuitem], [role=tab], input[type=button], input[type=submit]');
    const n = Math.min(await loc.count().catch(() => 0), 300);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      const txt = limpio((await el.innerText().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || (await el.getAttribute('title').catch(() => '')));
      if (txt && test(txt)) out.push({ el, txt, visible: await el.isVisible().catch(() => false) });
    }
  }
  return out;
}

async function clic(pagina, el) {
  const nav = pagina.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await el.click({ timeout: 5000 }).catch(() => el.evaluate((x) => x.click()));
  await nav; await pagina.waitForTimeout(2000).catch(() => {});
}

/**
 * Dentro del módulo: abre «SIFERE» (si el menú lo pide) y luego la consulta de «Pagos»; si la pantalla tiene un botón de
 * consulta («Consultar», «Buscar», «Aplicar», «Ver»), lo toca. Lanza un error con el motivo si no encuentra un único
 * control inequívoco: el orquestador lo registra y no se pisa lo guardado. Devuelve la descripción del recorrido.
 */
export async function irAPagosConsultas(pagina, { log = () => {} } = {}) {
  const recorrido = [];
  let pagos = await controles(pagina, esRotuloPagos);
  if (!pagos.length) {
    // Menú «SIFERE» del módulo (no el título de la página): solo si es un control con ese texto exacto.
    const menu = await controles(pagina, (t) => /^sifere$/i.test(t));
    if (menu.length === 1) { recorrido.push('menú «SIFERE»'); await clic(pagina, menu[0].el); pagos = await controles(pagina, esRotuloPagos); }
  }
  const unicos = [...new Map(pagos.map((p) => [p.txt.toLowerCase(), p])).values()];
  if (!unicos.length) throw new Error(`SIFERE Consultas: no se encontró la consulta de «Pagos»${recorrido.length ? ` (después del ${recorrido.join(', ')})` : ''}`);
  if (unicos.length > 1) throw new Error(`SIFERE Consultas: hay ${unicos.length} controles de pagos distintos (${unicos.map((p) => `«${p.txt}»`).join(', ')}): no se elige uno a ciegas`);
  const elegido = pagos.find((p) => p.visible) ?? pagos[0];
  recorrido.push(`«${elegido.txt}»`);
  log(`  sifere-consultas: abro ${recorrido.join(' > ')} (solo lectura).`);
  await clic(pagina, elegido.el);
  return `SIFERE Consultas: ${recorrido.join(' > ')}`;
}

/**
 * Corre EN EL NAVEGADOR: los desplegables visibles del documento, en orden, con sus opciones y el texto cercano. Los marca
 * con data-fiscalos-filtro para poder elegirlos después. Autocontenida.
 */
export function desplegablesDelDocumento() {
  const out = [];
  for (const [i, el] of [...document.querySelectorAll('select')].entries()) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    el.setAttribute('data-fiscalos-filtro', String(i));
    const fila = el.closest('tr, div, td, label');
    out.push({ marca: String(i), opciones: [...el.options].map((o) => ({ valor: o.value, texto: (o.textContent || '').trim() })), contexto: (fila?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) });
  }
  return out;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const esMes = (o) => /^(0?[1-9]|1[0-2])$/.test(o.texto) || MESES.includes(o.texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace('setiembre', 'septiembre'));
const esAnio = (o) => /^(19|20)\d{2}$/.test(o.texto);
const vacia = (o) => !o.texto || /^(-+|selecc|elegi|todas?|todos?)/i.test(o.texto);

/**
 * Qué es cada desplegable, por sus OPCIONES (no por selectores): mes (01–12 o nombres), año (cuatro cifras) o
 * jurisdicción (al menos tres opciones que son jurisdicciones). { meses, anios, jurisdiccion, motivo }. Exige pares
 * mes/año (uno o dos: «Anticipo desde / hasta») y a lo sumo un desplegable de jurisdicción. Pura.
 */
export function clasificarFiltros(desplegables) {
  const meses = []; const anios = []; const jur = [];
  for (const d of desplegables) {
    const ops = d.opciones.filter((o) => !vacia(o));
    if (ops.length >= 12 && ops.every(esMes)) meses.push(d.marca);
    else if (ops.length && ops.every(esAnio)) anios.push(d.marca);
    else if (ops.filter((o) => claveJurisdiccion(o.texto, o.valor)).length >= 3) jur.push(d.marca);
  }
  if (!meses.length || meses.length !== anios.length || meses.length > 2) return { meses, anios, jurisdiccion: null, motivo: `no se reconoce el período de la consulta (${meses.length} desplegable(s) de mes y ${anios.length} de año)` };
  if (jur.length > 1) return { meses, anios, jurisdiccion: null, motivo: `hay ${jur.length} desplegables de jurisdicción: no se elige uno a ciegas` };
  return { meses, anios, jurisdiccion: jur[0] ?? null, motivo: null };
}

/** Elige en el desplegable la opción que cumple `test` y verifica que quedó elegida. */
async function elegir(pagina, marca, test) {
  for (const f of pagina.frames()) {
    const sel = f.locator(`select[data-fiscalos-filtro="${marca}"]`);
    if (!(await sel.count().catch(() => 0))) continue;
    const ops = await sel.locator('option').evaluateAll((os) => os.map((o) => ({ valor: o.value, texto: (o.textContent || '').trim() })));
    const op = ops.filter(test);
    if (op.length !== 1) return false;
    await sel.selectOption(op[0].valor);
    return (await sel.inputValue().catch(() => null)) === op[0].valor;
  }
  return false;
}

const SIN_RESULTADOS = /no se (encontraron|registran|hallaron)|no existen|sin resultados|no hay (pagos|datos|registros|informaci)/i;

/**
 * La consulta de pagos de SIFERE Consultas, para el anticipo `mes` ('AAAA-MM') y CADA jurisdicción pedida (las de la
 * CM03 con importe a pagar): abre «Pagos», elige el período (desde = hasta = el anticipo) y la jurisdicción, verifica que
 * quedaron elegidos y toca solo «Buscar» (o «Consultar») de ese formulario. Una consulta por jurisdicción.
 * Devuelve { headers, rows, consultas: [{ jurisdiccion, estado, filas, motivo }], exportaciones, recorrido }: a cada fila le
 * agrega la jurisdicción y el período CONSULTADOS (el filtro, no una suposición). Lanza un error si no llega a «Pagos».
 */
export async function consultarPagosConsultas(pagina, { mes, jurisdicciones = [], outDir = 'out', log = () => {} } = {}) {
  const recorrido = await irAPagosConsultas(pagina, { log });
  const [anio, mm] = mes.split('-');
  const consultas = []; let headers = null; const rows = []; const exportaciones = [];
  const objetivos = jurisdicciones.length ? jurisdicciones : [null];
  const leerFiltros = async () => clasificarFiltros(await pagina.evaluate(desplegablesDelDocumento).catch(() => []));
  for (const [n, j] of objetivos.entries()) {
    const nombre = j?.jurisdiccion ?? 'todas';
    let filtros = await leerFiltros();
    // El resultado de la búsqueda anterior puede estar en otra pantalla: se vuelve a abrir «Pagos».
    if (filtros.motivo && n > 0) { await irAPagosConsultas(pagina, { log }).catch(() => {}); filtros = await leerFiltros(); }
    if (filtros.motivo) { consultas.push({ jurisdiccion: nombre, estado: 'sin consulta confirmada', filas: 0, motivo: filtros.motivo }); continue; }
    if (j && !filtros.jurisdiccion) { consultas.push({ jurisdiccion: nombre, estado: 'sin consulta confirmada', filas: 0, motivo: 'la consulta no tiene un desplegable de jurisdicción reconocible' }); continue; }
    let ok = true;
    for (const m of filtros.meses) ok = ok && await elegir(pagina, m, (o) => esMes(o) && (Number(o.texto) === Number(mm) || MESES.indexOf(o.texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace('setiembre', 'septiembre')) + 1 === Number(mm)));
    for (const a of filtros.anios) ok = ok && await elegir(pagina, a, (o) => o.texto === anio);
    const cod = j ? claveJurisdiccion(j.jurisdiccion, j.codigo) : null;
    if (j) ok = ok && !!cod && await elegir(pagina, filtros.jurisdiccion, (o) => claveJurisdiccion(o.texto, o.valor) === cod);
    if (!ok) { consultas.push({ jurisdiccion: nombre, estado: 'sin consulta confirmada', filas: 0, motivo: `no se pudo elegir ${mm}/${anio}${j ? ` y ${nombre}` : ''} en los filtros` }); continue; }
    const buscar = (await controles(pagina, (t) => /^(buscar|consultar)$/i.test(t) && seguro(t))).filter((c) => c.visible);
    if (buscar.length !== 1) { consultas.push({ jurisdiccion: nombre, estado: 'sin consulta confirmada', filas: 0, motivo: buscar.length ? `hay ${buscar.length} botones de búsqueda` : 'no está el botón «Buscar»' }); continue; }
    log(`  sifere-consultas: pagos de ${mm}/${anio}${j ? ` · ${nombre}` : ''} («${buscar[0].txt}»).`);
    await clic(pagina, buscar[0].el);
    const leidas = [];
    for (const f of pagina.frames()) leidas.push(...await f.evaluate(extraerTablasEnDocumento).catch(() => []));
    const tablas = leidas.filter((t) => !columnasFaltantes(t.headers, ['Importe|Monto', 'Fecha']).length);
    if (!tablas.length) {
      const texto = await pagina.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      consultas.push(SIN_RESULTADOS.test(texto) ? { jurisdiccion: nombre, estado: 'consultada', filas: 0, motivo: 'SIFERE informa que no hay pagos para el filtro' }
        : { jurisdiccion: nombre, estado: 'sin consulta confirmada', filas: 0, motivo: 'después de «Buscar» no apareció una grilla de pagos ni un aviso de «sin resultados»' });
      continue;
    }
    headers ??= tablas[0].headers;
    const filas = tablas.flatMap((t) => t.rows).filter((f) => f.some((c) => String(c ?? '').trim()));
    for (const f of filas) rows.push([...headers.map((_, k) => f[k] ?? ''), j?.jurisdiccion ?? '', `${mes}-01`]);
    // Paginación: si la grilla tiene «Siguiente» activo, lo leído puede no ser todo (no se valida la cantidad).
    const siguiente = (await controles(pagina, (t) => /^(siguiente|>|»)$/i.test(t))).filter((c) => c.visible);
    consultas.push({ jurisdiccion: nombre, estado: 'consultada', filas: filas.length, motivo: siguiente.length ? 'la grilla tiene más páginas: se leyó la primera' : null, paginas: siguiente.length ? 'incompleta' : 'completa' });
    if (filas.length) exportaciones.push({ jurisdiccion: nombre, ...(await guardarExportacionPagos(pagina, outDir, { mes: `${mes}${cod ? `-${cod}` : ''}` }).catch((e) => ({ motivo: e.message }))) });
  }
  return { headers: headers ? [...headers, 'Jurisdicción consultada', 'Período consultado'] : [], rows, consultas, exportaciones, recorrido };
}

/**
 * Exportación de la consulta (Excel), si la pantalla la ofrece: es el respaldo original de los pagos leídos. Se guarda
 * tal cual en out/importados/sifere-pagos/ (el mismo archivo no se guarda dos veces). Devuelve { archivo } o { motivo }.
 */
export async function guardarExportacionPagos(pagina, outDir, { mes, esperaMs = 20000 } = {}) {
  const exp = (await controles(pagina, (t) => /excel|exportar|descargar|xls/i.test(t) && seguro(t))).filter((c) => c.visible);
  if (exp.length !== 1) return { motivo: exp.length ? `hay ${exp.length} controles de exportación: no se elige uno` : 'la consulta no muestra exportación' };
  const [descarga] = await Promise.all([pagina.waitForEvent('download', { timeout: esperaMs }).catch(() => null), clic(pagina, exp[0].el)]);
  if (!descarga) return { motivo: 'la exportación no descargó un archivo' };
  const tmp = await descarga.path().catch(() => null);
  if (!tmp) return { motivo: 'no se pudo leer el archivo exportado' };
  const buf = fs.readFileSync(tmp);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const ext = (path.extname(descarga.suggestedFilename?.() ?? '') || '.xls').toLowerCase().replace(/[^.a-z0-9]/g, '');
  const dir = path.join(outDir, 'importados', 'sifere-pagos');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const archivo = path.join(dir, `${mes ?? 'pagos'}-${hash.slice(0, 12)}${ext}`);
  if (!fs.existsSync(archivo)) fs.writeFileSync(archivo, buf, { mode: 0o600 });
  return { archivo: path.relative(outDir, archivo), hash };
}
