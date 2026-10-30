/**
 * Lector de la DJ anual de Ganancias en PDF (F.2711 simplificada y F.711), tal como la descarga ARCA. Su texto viene en
 * fuentes Type3 dibujadas: se lee con glifos.js (reconocimiento de cada letra por su dibujo), sin OCR.
 *
 * Qué se guarda, por año y secuencia (original = 0, rectificativa N): el impuesto determinado total, los pagos a cuenta
 * computables, el saldo a favor de ARCA o del contribuyente, la fecha de presentación, el formulario y todos los
 * renglones «concepto — importe» como evidencia. El saldo es el que DECLARA la DJ el día que se presentó: no es la deuda
 * de hoy (hay que conciliarlo con los pagos posteriores y los planes de pago).
 *
 * Validación: determinado − pagos a cuenta = saldo a favor de ARCA − saldo a favor del contribuyente (al centavo), el año
 * y la secuencia legibles, y ningún «?» (letra no reconocida) en lo que se usa. Si algo no cierra, la DJ queda «en
 * revisión» y no se usa: nunca se completa con 0.
 *
 * Todo queda local, en out/importados/ganancias/ (fuera del repositorio): el PDF original y lo leído.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { importeAr } from './cm03.js';
import { lineasType3 } from './glifos.js';

const r2 = (x) => Math.round(x * 100) / 100;
const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (l) => { const out = []; for (const p of l.palabras) { const prev = out.at(-1); if (prev?.texto === '$') { prev.texto = `$${p.texto}`; prev.x2 = p.x2; } else out.push({ ...p }); } return out; };
const textoDe = (l) => tokens(l).map((p) => p.texto).join(' ');

/** Valor que el formulario pone DEBAJO de un rótulo (encabezado en grilla: rótulo arriba, dato abajo, misma columna). */
function debajo(lineas, re) {
  for (let i = 0; i < lineas.length; i++) {
    const t = tokens(lineas[i]); const txt = sinAcentos(textoDe(lineas[i]));
    const m = txt.match(re);
    if (!m) continue;
    // Palabra donde empieza el rótulo: la primera cuyo texto inicia la coincidencia.
    let pos = 0; let x = null;
    for (const p of t) { if (pos >= m.index && x == null) x = p.x; pos += p.texto.length + 1; }
    for (const l of lineas.slice(i + 1, i + 4)) {
      if (lineas[i].y - l.y > 30) break;
      const ws = tokens(l); const k = ws.findIndex((p) => Math.abs(p.x - x) < 4);
      if (k < 0) continue;
      const out = [ws[k]];
      for (let j = k + 1; j < ws.length && ws[j].x - out.at(-1).x2 < 6; j++) out.push(ws[j]);
      return out.map((p) => p.texto).join(' ');
    }
  }
  return null;
}

/** Renglones «concepto … $ importe» (un solo importe al final). */
function conceptos(lineas) {
  const out = [];
  for (const l of lineas) {
    const t = tokens(l); const imp = t.filter((p) => importeAr(p.texto) != null);
    if (imp.length === 1 && t.at(-1) === imp[0] && t.length > 1) out.push({ concepto: t.slice(0, -1).map((p) => p.texto).join(' '), importe: importeAr(imp[0].texto), y: l.y });
  }
  return out;
}

/**
 * Lee la DJ anual de las líneas de su PDF. Pura. { estado: 'valida' | 'revision', motivos, avisos, formulario, version,
 * anio, secuencia, fechaPresentacion, impuestoDeterminado, pagosACuenta, saldoAFavorArca, saldoAFavorContribuyente,
 * conceptos }. `anio` (opcional) es el año para el que se carga: tiene que coincidir.
 */
export function leerDdjjGanancias(paginas, { anio = null } = {}) {
  const motivos = []; const avisos = [];
  const lineas = paginas.flatMap((p) => p.lineas);
  const plano = sinAcentos(lineas.map(textoDe).join('\n'));
  const dudosos = paginas.reduce((n, p) => n + (p.dudosos ?? 0), 0);
  if (!/ganancias/.test(plano)) motivos.push('no parece una DJ de Ganancias');
  const fm = plano.match(/\bf\.?\s*(2711|711)\s*v\.?\s*(\d+)/);
  const formulario = fm ? fm[1] : null; const version = fm ? fm[2] : null;
  if (!formulario) motivos.push('no se encontró el formulario (F.2711 o F.711)');

  const per = debajo(lineas, /\bperiodo\b/);
  const anioDj = per && /^\d{4}$/.test(per.trim()) ? per.trim() : null;
  if (!anioDj) motivos.push('no se encontró el período (año) de la DJ');
  else if (anio && String(anio) !== anioDj) motivos.push(`la DJ es del período ${anioDj}, no de ${anio}`);
  const sec = sinAcentos(debajo(lineas, /\bsecuencia\b/) ?? '');
  const secuencia = /^original$/.test(sec) ? 0 : (sec.match(/^(?:rectificativa\s*)?(\d+)$/) ? Number(sec.match(/(\d+)$/)[1]) : null);
  if (secuencia == null) motivos.push('no se encontró la secuencia (original o rectificativa)');
  const fp = (debajo(lineas, /fecha de presentacion/) ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  const fechaPresentacion = fp ? `${fp[3]}-${fp[2]}-${fp[1]}` : null;
  if (!fechaPresentacion) avisos.push('no se encontró la fecha de presentación');

  const cs = conceptos(lineas);
  const uno = (re, nombre, obligatorio = true) => {
    const xs = cs.filter((c) => re.test(sinAcentos(c.concepto)));
    if (xs.length > 1) { motivos.push(`«${nombre}» aparece ${xs.length} veces`); return null; }
    if (!xs.length && obligatorio) motivos.push(`no se encontró «${nombre}»`);
    return xs[0] ?? null;
  };
  const det = uno(/^impuesto determinado total$/, 'Impuesto determinado total');
  const pac = uno(/^pagos a cuenta computables\b/, 'Pagos a cuenta computables');
  // «Saldos a favor»: renglones ARCA y/o Contribuyente debajo de ese título.
  const iSal = lineas.findIndex((l) => /^saldos? a favor$/.test(sinAcentos(textoDe(l))));
  const yTitulo = iSal >= 0 ? lineas[iSal].y : null;
  const enSaldos = (c) => yTitulo != null && c.y < yTitulo;
  const arca = cs.filter((c) => enSaldos(c) && /^(arca|afip|fisco)$/.test(sinAcentos(c.concepto)));
  const contrib = cs.filter((c) => enSaldos(c) && /^contribuyente$/.test(sinAcentos(c.concepto)));
  if (iSal < 0) motivos.push('no se encontró «Saldos a favor»');
  else if (!arca.length && !contrib.length) motivos.push('no se encontró el saldo a favor (ARCA o contribuyente)');
  if (arca.length > 1 || contrib.length > 1) motivos.push('saldo a favor repetido');
  const saldoAFavorArca = arca.length === 1 ? arca[0].importe : arca.length ? null : 0;
  const saldoAFavorContribuyente = contrib.length === 1 ? contrib[0].importe : contrib.length ? null : 0;
  if (det && pac && saldoAFavorArca != null && saldoAFavorContribuyente != null && (arca.length || contrib.length)) {
    const dif = r2(det.importe - pac.importe - (saldoAFavorArca - saldoAFavorContribuyente));
    if (Math.abs(dif) > 0.02) motivos.push(`determinado − pagos a cuenta no da el saldo de la DJ (diferencia ${dif})`);
  }
  if (dudosos) avisos.push(`${dudosos} letra(s) no reconocida(s) en el PDF (fuera de lo que se usa, si la DJ es válida)`);

  return {
    estado: motivos.length ? 'revision' : 'valida', motivos, avisos, formulario, version, anio: anioDj, secuencia, fechaPresentacion,
    impuestoDeterminado: det?.importe ?? null, pagosACuenta: pac?.importe ?? null,
    saldoAFavorArca: (arca.length || contrib.length) ? saldoAFavorArca : null, saldoAFavorContribuyente: (arca.length || contrib.length) ? saldoAFavorContribuyente : null,
    conceptos: cs.map(({ concepto, importe }) => ({ concepto, importe })),
  };
}

// ---------------- almacenamiento (out/importados/ganancias) ----------------

const dirGan = (outDir) => path.join(outDir, 'importados', 'ganancias');
const leerJson = (f, defecto) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return defecto; } };
function escribirAtomico(f, contenido) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contenido, { mode: 0o600 });
  fs.renameSync(tmp, f);
}
export const listarDdjjGanancias = (outDir) => leerJson(path.join(dirGan(outDir), 'ddjj.json'), []);
const importes = (d) => JSON.stringify([d.impuestoDeterminado, d.pagosACuenta, d.saldoAFavorArca, d.saldoAFavorContribuyente]);

/**
 * Lee un PDF de la DJ anual de Ganancias y lo guarda (con una copia del PDF). Un PDF idéntico no se guarda dos veces;
 * una DJ en revisión se guarda como evidencia, pero no se usa; otra copia de la misma secuencia con otros importes se
 * rechaza.
 */
export async function importarDdjjGanancias(outDir, { nombre, contenido, anio = null }) {
  const buf = Buffer.isBuffer(contenido) ? contenido : Buffer.from(String(contenido ?? ''), 'base64');
  if (!buf.length) throw new Error('el archivo está vacío');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('el archivo no es un PDF: subí la DJ de Ganancias que descarga ARCA');
  if (anio != null && !/^\d{4}$/.test(String(anio))) throw new Error('año inválido');
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const lista = listarDdjjGanancias(outDir);
  const igual = lista.find((d) => d.hash === hash);
  if (igual) return { ...igual, yaImportado: true };
  let leido;
  try { leido = leerDdjjGanancias(await lineasType3(buf), { anio }); } catch (e) { throw new Error(`no se pudo leer el PDF: ${String(e?.message ?? e).slice(0, 120)}`); }
  if (leido.estado === 'valida') {
    const misma = lista.find((d) => d.estado === 'valida' && d.anio === leido.anio && d.secuencia === leido.secuencia);
    if (misma && importes(misma) !== importes(leido)) {
      throw new Error(`ya hay una DJ de Ganancias ${leido.anio} ${leido.secuencia ? `rectificativa ${leido.secuencia}` : 'original'} con otros importes (${misma.archivo}): revisá cuál es la correcta y eliminá la otra antes de importar`);
    }
  }
  const cuando = new Date().toISOString();
  const registro = { id: `${cuando.replace(/[:.]/g, '-')}-${hash.slice(0, 8)}`, hash, archivo: path.basename(String(nombre ?? 'ganancias.pdf')), cuando, anioCarga: anio, ...leido };
  escribirAtomico(path.join(dirGan(outDir), 'archivos', `${hash}.pdf`), buf);
  escribirAtomico(path.join(dirGan(outDir), 'ddjj.json'), JSON.stringify([...lista, registro], null, 2));
  return registro;
}

/** Quita una DJ importada de la lista (el PDF queda guardado en archivos/). */
export function eliminarDdjjGanancias(outDir, id) {
  const lista = listarDdjjGanancias(outDir);
  if (!lista.some((d) => d.id === id)) throw new Error('no existe esa DJ importada');
  escribirAtomico(path.join(dirGan(outDir), 'ddjj.json'), JSON.stringify(lista.filter((d) => d.id !== id), null, 2));
  return { eliminada: id };
}

/** La DJ vigente de un año: la secuencia válida más alta. { vigente, anteriores, enRevision }. */
export function ddjjGananciasDelAnio(outDir, anio) {
  const del = listarDdjjGanancias(outDir).filter((d) => d.anio === String(anio) || (d.anio == null && String(d.anioCarga) === String(anio)));
  const validas = del.filter((d) => d.estado === 'valida').sort((a, b) => b.secuencia - a.secuencia || b.cuando.localeCompare(a.cuando));
  return { vigente: validas[0] ?? null, anteriores: validas.slice(1), enRevision: del.filter((d) => d.estado !== 'valida') };
}
