/**
 * Lector del reporte en PDF de la DJ mensual CM03 de Convenio Multilateral (SIFERE WEB – Consultas > DDJJ Mensuales >
 * Listado > ícono «Reporte»). El PDF tiene texto: se lee con pdfjs-dist (biblioteca de Node, funciona igual en Windows),
 * sin OCR ni programas externos.
 *
 * Qué se guarda, por período y versión (original = 0, rectificativa N):
 *  - por jurisdicción, las seis columnas de «Jurisdicciones incluidas»: Anticipo Impuesto Determinado, Valores Restan,
 *    Valores Suman, A Favor Contribuyente, A Favor Fisco y A Pagar;
 *  - el impuesto determinado total (la carga del mes: NO es lo que se paga), el total a pagar declarado (lo que queda
 *    después de saldos a favor, retenciones y percepciones) y los saldos a favor del contribuyente, cada uno por
 *    jurisdicción y sin compensar unas con otras;
 *  - estado, fecha de presentación y los desgloses «Determinación del anticipo - …» como evidencia (no se suman).
 *
 * Validación: las filas tienen que sumar la fila TOTALES y el «Total a pagar», el período tiene que coincidir con el mes
 * de la carga y cada celda tiene que ser un importe argentino legible. Si algo falta o no se entiende, la CM03 queda «en
 * revisión» y no se usa: nunca se completa con 0. Presentar la CM03 no prueba que se pagó.
 *
 * Todo queda local, en out/importados/cm03/ (fuera del repositorio): el PDF original y lo leído.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const r2 = (x) => Math.round(x * 100) / 100;
const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Las seis columnas de «Jurisdicciones incluidas», en el orden del reporte, con la palabra que las identifica. */
export const COLUMNAS = [
  { campo: 'determinado', clave: 'determinado', titulo: 'Anticipo Impuesto Determinado' },
  { campo: 'restan', clave: 'restan', titulo: 'Valores Restan' },
  { campo: 'suman', clave: 'suman', titulo: 'Valores Suman' },
  { campo: 'aFavorContribuyente', clave: 'contribuyente', titulo: 'A Favor Contribuyente' },
  { campo: 'aFavorFisco', clave: 'fisco', titulo: 'A Favor Fisco' },
  { campo: 'aPagar', clave: 'pagar', titulo: 'A Pagar' },
];

// ---------------- PDF -> líneas ----------------

/**
 * Texto de un PDF en líneas, página por página: [{ pagina, lineas: [{ y, palabras: [{ x, x2, texto }] }] }]. Las palabras
 * se agrupan por renglón (misma altura) y se ordenan de izquierda a derecha, que es lo que hace falta para leer una tabla.
 */
export async function lineasDePdf(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  try {
    const paginas = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const tc = await (await doc.getPage(n)).getTextContent();
      const items = tc.items.filter((it) => typeof it.str === 'string' && it.str.trim())
        .map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width ?? 0, alto: Math.abs(it.transform[3]) || 8, str: it.str }));
      paginas.push({ pagina: n, lineas: agruparLineas(items) });
    }
    return paginas;
  } finally { await doc.destroy().catch(() => {}); }
}

/** Agrupa fragmentos de texto { x, y, w, alto, str } en renglones y palabras. Pura. */
export function agruparLineas(items) {
  const orden = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lineas = [];
  for (const it of orden) {
    const l = lineas.find((x) => Math.abs(x.y - it.y) <= Math.max(2, it.alto * 0.35));
    if (l) l.items.push(it); else lineas.push({ y: it.y, items: [it] });
  }
  return lineas.map((l) => {
    const palabras = []; let pegado = false;
    // Cada fragmento se parte en palabras; la posición de cada una se reparte en proporción a sus caracteres. Un
    // fragmento que sigue a otro sin espacio ni separación es la continuación de la misma palabra («1.234.» + «567,89»).
    for (const it of l.items.sort((a, b) => a.x - b.x)) {
      const ancho = it.str.length ? it.w / it.str.length : 0;
      for (const m of it.str.matchAll(/\S+/g)) {
        const x = it.x + m.index * ancho; const x2 = x + m[0].length * ancho;
        const prev = palabras.at(-1);
        if (prev && pegado && m.index === 0 && x - prev.x2 < Math.max(0.6, ancho * 0.2)) { prev.texto += m[0]; prev.x2 = x2; } else palabras.push({ x, x2, texto: m[0] });
        pegado = false;
      }
      pegado = !/\s$/.test(it.str);
    }
    return { y: l.y, palabras };
  });
}

// ---------------- líneas -> CM03 ----------------

const RE_IMPORTE = /^\(?-?\$?-?\d{1,3}(?:\.\d{3})*,\d{2}\)?-?$/;
/** Importe argentino de una palabra («1.234.567,89», «-0,50», «$0,00»); null si no lo es. Pura. */
export function importeAr(texto) {
  const s = String(texto ?? '').trim();
  if (!RE_IMPORTE.test(s)) return null;
  const neg = /-|\(/.test(s);
  const n = Number(s.replace(/[()$-]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? r2(neg ? -n : n) : null;
}

/** Palabras de una línea con el «$» suelto pegado al importe siguiente. */
function tokens(linea) {
  const out = [];
  for (const p of linea.palabras) {
    const prev = out.at(-1);
    if (prev && prev.texto === '$') { prev.texto = `$${p.texto}`; prev.x2 = p.x2; } else out.push({ ...p });
  }
  return out;
}
const textoDe = (linea) => tokens(linea).map((p) => p.texto).join(' ');
const centro = (p) => (p.x + p.x2) / 2;

/**
 * Lee la CM03 de las líneas de su PDF. Pura. Devuelve { estado: 'valida' | 'revision', motivos, avisos, periodo,
 * rectificativa, estadoDj, fechaPresentacion, jurisdicciones, totales, impuestoDeterminadoTotal, totalAPagarDeclarado,
 * aFavorContribuyenteTotal, detalles }. `mes` ('AAAA-MM') es el mes para el que se carga: tiene que coincidir.
 */
export function leerCm03(paginas, { mes = null } = {}) {
  const motivos = []; const avisos = [];
  const todas = paginas.flatMap((p) => p.lineas.map((l) => ({ ...l, pagina: p.pagina })));
  const texto = todas.map(textoDe).join('\n');
  const plano = sinAcentos(texto);

  // Carátula: período, versión, estado y fecha de presentación.
  let periodo = null;
  let m = plano.match(/(?:periodo|anticipo)\s*(?:fiscal)?\s*:?\s*(\d{4})\s*[-/]?\s*(\d{2})\b/) ?? null;
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) periodo = `${m[1]}-${m[2]}`;
  else if ((m = plano.match(/(?:periodo|anticipo)\s*(?:fiscal)?\s*:?\s*(\d{2})\s*[-/]\s*(\d{4})\b/)) && Number(m[1]) >= 1 && Number(m[1]) <= 12) periodo = `${m[2]}-${m[1]}`;
  if (!periodo) motivos.push('no se encontró el período de la DJ');
  else if (mes && periodo !== mes) motivos.push(`la DJ es del período ${periodo}, no de ${mes}`);

  let rectificativa = null;
  const anticipoSec = plano.match(/(?:periodo|anticipo)\s*(?:fiscal)?\s*:?\s*\d{6}\s*-\s*(\d+)\b/);
  if ((m = plano.match(/rectificativa\s*(?:n(?:ro|umero)?\.?\s*[°º]?\s*)?:?\s*(\d+)\b/))) rectificativa = Number(m[1]);
  else if ((m = plano.match(/secuencia\s*:?\s*(\d+)\b/))) rectificativa = Number(m[1]);
  else if (anticipoSec) rectificativa = Number(anticipoSec[1]);
  else if (/\boriginal\b/.test(plano)) rectificativa = 0;
  if (rectificativa == null) motivos.push('no se encontró si es la original o una rectificativa');

  const estadoDj = /\bpresentada\b/.test(plano) ? 'PRESENTADA' : null;
  if (!estadoDj) motivos.push('el reporte no dice PRESENTADA (puede ser un borrador)');
  // «Fecha de Presentación: dd/mm/aaaa hh:mm» o, como rotula el reporte real, «DDJJ presentada el dd/mm/aaaa - hh:mm:ss».
  m = plano.match(/fecha\s*(?:de\s*)?presentacion\s*:?\s*(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?/)
    ?? plano.match(/ddjj\s+presentada\s+el\s+(\d{2})\/(\d{2})\/(\d{4})(?:\s*-?\s*(\d{2}:\d{2}(?::\d{2})?))?/);
  const fechaPresentacion = m ? `${m[3]}-${m[2]}-${m[1]}${m[4] ? ` ${m[4]}` : ''}` : null;
  if (!fechaPresentacion) avisos.push('no se encontró la fecha de presentación');

  // Tabla «Jurisdicciones incluidas»: filas con nombre + seis importes, hasta la fila TOTALES.
  const ini = todas.findIndex((l) => /jurisdicciones incluidas/.test(sinAcentos(textoDe(l))));
  const desde = ini >= 0 ? ini + 1 : 0;
  const iTot = todas.findIndex((l, i) => i >= desde && /^totales?\b/.test(sinAcentos(tokens(l)[0]?.texto ?? '')));
  if (ini < 0) motivos.push('no se encontró la tabla «Jurisdicciones incluidas»');
  if (iTot < 0) motivos.push('no se encontró la fila TOTALES');
  const jurisdicciones = []; let encabezado = null;
  const hasta = iTot >= 0 ? iTot : todas.length;
  for (let i = desde; i < hasta; i++) {
    const t = tokens(todas[i]);
    const imp = t.filter((p) => importeAr(p.texto) != null);
    if (!imp.length) {
      // Renglones de títulos: guardan la posición de cada columna (pueden ocupar dos o tres renglones).
      for (const p of t) {
        const k = COLUMNAS.find((c) => sinAcentos(p.texto).replace(/[^a-z]/g, '') === c.clave);
        if (k) (encabezado ??= {})[k.campo] = centro(p);
      }
      continue;
    }
    const nombre = t.filter((p) => importeAr(p.texto) == null);
    const primero = t.indexOf(imp[0]);
    if (imp.length !== 6 || nombre.some((p) => t.indexOf(p) > primero) || !nombre.length) {
      motivos.push(`renglón de la tabla que no se pudo leer (${imp.length} importe(s)${nombre.length ? '' : ', sin jurisdicción'}): «${textoDe(todas[i]).slice(0, 80)}»`);
      continue;
    }
    const fila = { jurisdiccion: nombre.map((p) => p.texto).join(' ') };
    COLUMNAS.forEach((c, k) => { fila[c.campo] = importeAr(imp[k].texto); });
    const cod = fila.jurisdiccion.match(/^(\d{3})\s*-?\s*(.*)$/);
    if (cod) { fila.codigo = cod[1]; fila.jurisdiccion = cod[2] || fila.jurisdiccion; }
    fila._x = imp.map(centro);
    jurisdicciones.push(fila);
  }
  // Orden de las columnas: los títulos tienen que estar todos y de izquierda a derecha, y cada importe debajo del suyo.
  if (!encabezado || COLUMNAS.some((c) => encabezado[c.campo] == null)) motivos.push(`no se reconocen las columnas de la tabla (${COLUMNAS.filter((c) => encabezado?.[c.campo] == null).map((c) => c.titulo).join(', ')})`);
  else if (COLUMNAS.some((c, k) => k && encabezado[c.campo] <= encabezado[COLUMNAS[k - 1].campo])) motivos.push('las columnas de la tabla no están en el orden esperado');
  else {
    // Los importes van alineados a la derecha: cada uno tiene que caer entre los títulos de las columnas vecinas.
    const cols = COLUMNAS.map((c) => encabezado[c.campo]);
    const enSuLugar = (x, k) => (k === 0 || x > cols[k - 1]) && (k === cols.length - 1 || x < cols[k + 1]);
    for (const f of jurisdicciones) if (f._x.some((x, k) => !enSuLugar(x, k))) motivos.push(`los importes de ${f.jurisdiccion} no caen debajo de sus columnas`);
  }
  if (!jurisdicciones.length && ini >= 0) motivos.push('la tabla no tiene jurisdicciones legibles');
  const nombres = jurisdicciones.map((f) => sinAcentos(f.jurisdiccion));
  if (new Set(nombres).size !== nombres.length) motivos.push('hay una jurisdicción repetida en la tabla');

  let totales = null;
  if (iTot >= 0) {
    const t = tokens(todas[iTot]); const imp = t.filter((p) => importeAr(p.texto) != null);
    if (imp.length !== 6) motivos.push(`la fila TOTALES tiene ${imp.length} importe(s), no 6`);
    else { totales = {}; COLUMNAS.forEach((c, k) => { totales[c.campo] = importeAr(imp[k].texto); }); }
  }
  if (totales && jurisdicciones.length) {
    const tol = 0.01 * (jurisdicciones.length + 1);
    for (const c of COLUMNAS) {
      const s = r2(jurisdicciones.reduce((n, f) => n + f[c.campo], 0));
      if (Math.abs(s - totales[c.campo]) > tol) motivos.push(`«${c.titulo}»: las jurisdicciones suman ${s} y la fila TOTALES dice ${totales[c.campo]}`);
    }
  }

  // «Total a pagar»: fuera de la tabla. Tiene que coincidir con la columna A Pagar de TOTALES.
  let totalAPagarLinea = null;
  for (let i = 0; i < todas.length; i++) {
    if (i === iTot || !/total a pagar/.test(sinAcentos(textoDe(todas[i])))) continue;
    const enLinea = tokens(todas[i]).map((p) => importeAr(p.texto)).filter((x) => x != null);
    const siguiente = !enLinea.length && todas[i + 1] ? tokens(todas[i + 1]).map((p) => importeAr(p.texto)).filter((x) => x != null) : [];
    const v = enLinea.length === 1 ? enLinea[0] : !enLinea.length && siguiente.length === 1 ? siguiente[0] : null;
    if (v != null) { totalAPagarLinea = v; break; }
  }
  if (totalAPagarLinea == null) avisos.push('no se encontró la línea «Total a pagar»: se usa la fila TOTALES');
  else if (totales && Math.abs(totalAPagarLinea - totales.aPagar) > 0.01) motivos.push(`el «Total a pagar» (${totalAPagarLinea}) no coincide con la columna A Pagar de TOTALES (${totales.aPagar})`);

  // Desgloses «Determinación del anticipo - <jurisdicción>»: evidencia, no se suman a nada.
  const detalles = [];
  for (let i = 0; i < todas.length; i++) {
    const tit = textoDe(todas[i]).match(/determinaci[oó]n del anticipo\s*[-–]\s*(.+)$/i);
    if (tit) { detalles.push({ jurisdiccion: tit[1].trim(), pagina: todas[i].pagina, conceptos: [] }); continue; }
    const d = detalles.at(-1);
    if (!d || todas[i].pagina !== d.pagina) continue;
    const t = tokens(todas[i]); const imp = t.filter((p) => importeAr(p.texto) != null);
    if (imp.length === 1 && t.at(-1) === imp[0] && t.length > 1) d.conceptos.push({ concepto: t.slice(0, -1).map((p) => p.texto).join(' '), importe: importeAr(imp[0].texto) });
  }

  const filas = jurisdicciones.map(({ _x, ...f }) => f);
  const valida = !motivos.length && !!totales;
  return {
    estado: valida ? 'valida' : 'revision', motivos, avisos, periodo, rectificativa, estadoDj, fechaPresentacion,
    jurisdicciones: filas, totales,
    impuestoDeterminadoTotal: totales?.determinado ?? null,
    totalAPagarDeclarado: totales?.aPagar ?? null,
    aFavorContribuyenteTotal: totales?.aFavorContribuyente ?? null,
    detalles,
  };
}

// ---------------- almacenamiento (out/importados/cm03) ----------------

const dirCm03 = (outDir) => path.join(outDir, 'importados', 'cm03');
const leerJson = (f, defecto) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return defecto; } };
function escribirAtomico(f, contenido) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contenido, { mode: 0o600 });
  fs.renameSync(tmp, f);
}
export const listarCm03 = (outDir) => leerJson(path.join(dirCm03(outDir), 'cm03.json'), []);
const importes = (c) => JSON.stringify([c.jurisdicciones, c.totales]);

/**
 * Lee un PDF de CM03 y lo guarda (con una copia del PDF). Un PDF idéntico no se guarda dos veces. Una CM03 en revisión se
 * guarda como evidencia, pero no se usa. Otra copia de la misma versión con otros importes se rechaza: hay que ver cuál
 * es la correcta. Con `rectificativaEsperada` (la versión de la fila de SIFERE que se bajó), un PDF de otra versión
 * queda en revisión.
 */
export async function importarCm03(outDir, { nombre, contenido, mes = null, rectificativaEsperada = null }) {
  const buf = Buffer.isBuffer(contenido) ? contenido : Buffer.from(String(contenido ?? ''), 'base64');
  if (!buf.length) throw new Error('el archivo está vacío');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('el archivo no es un PDF: subí el «Reporte» de la CM03 que descarga SIFERE');
  if (mes != null && !/^\d{4}-\d{2}$/.test(String(mes))) throw new Error('mes inválido');
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const lista = listarCm03(outDir);
  const igual = lista.find((c) => c.hash === hash);
  if (igual) return { ...igual, yaImportado: true };
  let leido;
  try { leido = leerCm03(await lineasDePdf(buf), { mes }); } catch (e) { throw new Error(`no se pudo leer el PDF: ${String(e?.message ?? e).slice(0, 120)}`); }
  // Bajada de una fila del listado de SIFERE: tiene que ser ESA versión. Otra queda como evidencia en revisión, sin
  // tocar la vigente (se verifica antes de guardar).
  const version = (n) => (n ? `rectificativa ${n}` : 'original');
  if (leido.estado === 'valida' && rectificativaEsperada != null && leido.rectificativa !== Number(rectificativaEsperada)) {
    leido = { ...leido, estado: 'revision', motivos: [...leido.motivos, `el PDF es la ${version(leido.rectificativa)} y se pidió la ${version(Number(rectificativaEsperada))}`] };
  }
  if (leido.estado === 'valida') {
    const misma = lista.find((c) => c.estado === 'valida' && c.periodo === leido.periodo && c.rectificativa === leido.rectificativa);
    if (misma && importes(misma) !== importes(leido)) {
      throw new Error(`ya hay una CM03 ${leido.rectificativa ? `rectificativa ${leido.rectificativa}` : 'original'} de ${leido.periodo} con otros importes (${misma.archivo}): revisá cuál es la correcta y eliminá la otra antes de importar`);
    }
  }
  const cuando = new Date().toISOString();
  const registro = { id: `${cuando.replace(/[:.]/g, '-')}-${hash.slice(0, 8)}`, hash, archivo: path.basename(String(nombre ?? 'cm03.pdf')), cuando, mesCarga: mes, ...leido };
  escribirAtomico(path.join(dirCm03(outDir), 'archivos', `${hash}.pdf`), buf);
  escribirAtomico(path.join(dirCm03(outDir), 'cm03.json'), JSON.stringify([...lista, registro], null, 2));
  return registro;
}

/** Quita una CM03 importada de la lista (el PDF queda guardado en archivos/). */
export function eliminarCm03(outDir, id) {
  const lista = listarCm03(outDir);
  if (!lista.some((c) => c.id === id)) throw new Error('no existe esa CM03 importada');
  escribirAtomico(path.join(dirCm03(outDir), 'cm03.json'), JSON.stringify(lista.filter((c) => c.id !== id), null, 2));
  return { eliminada: id };
}

/**
 * La CM03 vigente de un período: la versión válida más alta (una rectificativa posterior nunca se reemplaza por una
 * anterior, importe lo que se importe después). { vigente, anteriores, enRevision }. Pura sobre la lista guardada.
 */
export function cm03DelPeriodo(outDir, mes) {
  const del = listarCm03(outDir).filter((c) => c.periodo === mes || (c.periodo == null && c.mesCarga === mes));
  const validas = del.filter((c) => c.estado === 'valida').sort((a, b) => b.rectificativa - a.rectificativa || b.cuando.localeCompare(a.cuando));
  return { vigente: validas[0] ?? null, anteriores: validas.slice(1), enRevision: del.filter((c) => c.estado !== 'valida') };
}
