/**
 * Importación manual de archivos (CSV o Excel .xlsx) para lo que ARCA no entrega sola: Ingresos Brutos (CM03), anticipos
 * y pagos, autónomos, la DJ anual de Ganancias y el resultado comercial de PFOS para proyectar Ganancias.
 *
 * Flujo (tres pasos, nada se guarda hasta confirmar):
 *   1. analizar: se sube el archivo; queda en out/importados/pendientes/ y se devuelve una vista
 *      previa (hojas, fila de encabezado detectada, primeras filas, columnas sugeridas).
 *   2. simular: con el mapeo elegido (qué columna es la fecha, cuál el importe, qué concepto es)
 *      se calcula qué se incorporaría: totales por mes, filas descartadas con su motivo y filas
 *      DUPLICADAS (ya importadas antes, en este u otro archivo, para el mismo concepto).
 *   3. confirmar: se guarda la importación (solo filas nuevas) y una copia del archivo original.
 * Un archivo idéntico (mismo hash) no se importa dos veces. Una importación se puede deshacer.
 * Todo queda local, en out/importados/ (fuera del repositorio).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { leerXlsx } from './xlsx.js';
import { parsearCsv } from '../informeIva.js';
import { decodificar } from '../portal/misComprobantes.js';
import { periodoDe } from '../portal/ivaDdjj.js';

/**
 * Conceptos que se pueden importar. `grupo` decide cómo los usa el panel:
 *   impuesto   -> declarado o pagado de un impuesto;
 *   pfos       -> resultado comercial ya calculado por PFOS (base de la proyección de Ganancias);
 *   gasto, ingreso, referencia (legado: true) -> conceptos comerciales viejos: se conservan sus cargas, no se ofrecen.
 */
export const CONCEPTOS = {
  // Comerciales: ya no se usan (los calcula PFOS). Quedan definidos para conservar las cargas e importaciones viejas.
  'ventas-ml': { nombre: 'Ventas de Mercado Libre', grupo: 'referencia', legado: true },
  'comisiones-ml': { nombre: 'Comisiones y cargos de Mercado Libre', grupo: 'gasto', legado: true },
  publicidad: { nombre: 'Publicidad', grupo: 'gasto', legado: true },
  logistica: { nombre: 'Envíos y logística', grupo: 'gasto', legado: true },
  'costo-mercaderia': { nombre: 'Costo de la mercadería vendida', grupo: 'gasto', legado: true },
  'gastos-operativos': { nombre: 'Gastos operativos', grupo: 'gasto', legado: true },
  'otros-ingresos': { nombre: 'Otros ingresos', grupo: 'ingreso', legado: true },
  // De PFOS, para la proyección de Ganancias: el resultado comercial del mes ANTES de impuestos (ventas − mercadería −
  // cargos de ML − publicidad − logística − gastos generales), tal como lo calcula PFOS.
  'resultado-comercial': { nombre: 'Resultado comercial del mes (de PFOS, antes de impuestos)', grupo: 'pfos' },
  // De la CM03: el impuesto determinado (la carga del mes) y el total a pagar (después de saldos a favor, retenciones y
  // percepciones) son cosas distintas. Lo mejor es importar el PDF de la CM03, que trae los dos por jurisdicción.
  'iibb-declarado': { nombre: 'Ingresos Brutos: impuesto determinado (CM03)', grupo: 'impuesto', impuesto: 'iibb', tipo: 'declarado' },
  'iibb-a-pagar-segun-cm03': { nombre: 'Ingresos Brutos: total a pagar según la CM03', grupo: 'impuesto', impuesto: 'iibb', tipo: 'a-pagar' },
  'iibb-pagado': { nombre: 'Ingresos Brutos: pagos', grupo: 'impuesto', impuesto: 'iibb', tipo: 'pagado' },
  'ganancias-anticipo': { nombre: 'Ganancias: anticipos pagados', grupo: 'impuesto', impuesto: 'ganancias', tipo: 'pagado' },
  autonomos: { nombre: 'Autónomos: pagos', grupo: 'impuesto', impuesto: 'autonomos', tipo: 'pagado' },
  // Anual: se guarda en diciembre del período fiscal (la DJ de 2025 va en 2025-12).
  'ganancias-determinado': { nombre: 'Ganancias: impuesto determinado de la DJ anual', grupo: 'impuesto', impuesto: 'ganancias', tipo: 'declarado', anual: true },
  'autonomos-cuota': { nombre: 'Autónomos: cuota del mes', grupo: 'impuesto', impuesto: 'autonomos', tipo: 'declarado' },
  // Como empleador y como agente (no son impuestos propios): importe declarado del período y sus pagos.
  'f931-declarado': { nombre: 'F.931 (empleador): total declarado del período', grupo: 'terceros', impuesto: 'empleador', tipo: 'declarado' },
  'f931-pagado': { nombre: 'F.931 (empleador): pagos', grupo: 'terceros', impuesto: 'empleador', tipo: 'pagado' },
  'sicore-declarado': { nombre: 'SICORE (agente): total declarado del período (F.744)', grupo: 'terceros', impuesto: 'agente', tipo: 'declarado' },
  'sicore-pagado': { nombre: 'SICORE (agente): pagos', grupo: 'terceros', impuesto: 'agente', tipo: 'pagado' },
};

const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Mes 'AAAA-MM' de una celda de fecha o período en los formatos habituales; null si no es. Pura. */
export function mesDe(valor) {
  const s = String(valor ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})(-\d{2})?/);
  if (m) return Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${m[2]}` : null;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const mm = Number(m[2]);
    return mm >= 1 && mm <= 12 ? `${y}-${String(mm).padStart(2, '0')}` : null;
  }
  // Mercado Libre: "15 de septiembre de 2026 10:20 hs."
  m = sinAcentos(s).match(/(\d{1,2}) de ([a-z]+) de (\d{4})/);
  if (m && MESES[m[2]]) return `${m[3]}-${String(MESES[m[2]]).padStart(2, '0')}`;
  m = sinAcentos(s).match(/^([a-z]+)\s+(?:de\s+)?(\d{4})$/);
  if (m && MESES[m[1]]) return `${m[2]}-${String(MESES[m[1]]).padStart(2, '0')}`;
  return periodoDe(s);
}

/** ¿La columna usa coma decimal? (algún valor termina en ,d o ,dd). Pura. */
export function usaComaDecimal(valores) {
  return valores.some((v) => /,\d{1,2}\s*$/.test(String(v ?? '').trim()));
}

/** Importe de una celda: "$ -1.234,56", "1234.56", "(1.234,56)", "1,234.56". null si no es número. Pura. */
export function importeImportado(valor, comaDecimal = true) {
  let s = String(valor ?? '').trim().replace(/\s|\$|ARS|AR\$/gi, '');
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s);
  s = s.replace(/[()]/g, '').replace(/^-|-$/g, '');
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  if (s.includes(',') && s.includes('.')) {
    // El último separador es el decimal.
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = comaDecimal ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (comaDecimal && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // "1.234.567" con coma decimal en la columna: puntos de miles
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round((neg ? -n : n) * 100) / 100 : null;
}

/** Hojas de un archivo: [{ nombre, filas }]. CSV (; , o tabulador) o .xlsx. */
export function leerArchivo(nombre, buf) {
  const ext = path.extname(String(nombre)).toLowerCase();
  if (ext === '.xlsx' || (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50)) return leerXlsx(buf);
  if (ext === '.xls') throw new Error('el formato .xls (Excel 97-2003) no se puede leer: abrilo en Excel y guardalo como .xlsx o .csv');
  const texto = decodificar(buf);
  const primera = texto.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const cuenta = (c) => primera.split(c).length - 1;
  const sep = [';', '\t', ','].sort((a, b) => cuenta(b) - cuenta(a))[0];
  return [{ nombre: path.basename(String(nombre)), filas: parsearCsv(texto, sep) }];
}

/** Fila de encabezado: la primera (de las 30 primeras) con 3+ celdas de texto no numérico. Pura. */
export function detectarEncabezado(filas) {
  const esTexto = (c) => String(c ?? '').trim() && !/^[-\d.,$()\s]+$/.test(String(c));
  for (let i = 0; i < Math.min(filas.length, 30); i++) if ((filas[i] ?? []).filter(esTexto).length >= 3) return i;
  return Math.max(0, filas.findIndex((f) => (f ?? []).some((c) => String(c ?? '').trim())));
}

/** Columnas sugeridas por nombre (el usuario las confirma o cambia). Pura. */
export function sugerirColumnas(encabezados) {
  const h = encabezados.map(sinAcentos);
  const buscar = (...res) => { for (const re of res) { const i = h.findIndex((x) => re.test(x)); if (i >= 0) return i; } return -1; };
  return {
    colFecha: buscar(/^fecha de venta/, /^fecha/, /fecha/, /^periodo/, /^mes$/, /anticipo/),
    colImporte: buscar(/^total \(ars\)/, /^total$/, /importe total/, /monto total/, /^importe/, /^monto/, /total/, /neto/),
    colDescripcion: buscar(/^descripcion/, /^titulo/, /concepto/, /detalle/, /producto/, /^#? ?de venta/),
  };
}

// ---------------- almacenamiento (out/importados) ----------------

const dirImportados = (outDir) => path.join(outDir, 'importados');
function escribirAtomico(f, contenido) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contenido, { mode: 0o600 });
  fs.renameSync(tmp, f);
}
const leerJson = (f, defecto) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return defecto; } };
export const listarImportaciones = (outDir) => leerJson(path.join(dirImportados(outDir), 'importaciones.json'), []);
const filasDe = (outDir, id) => leerJson(path.join(dirImportados(outDir), 'filas', `${id}.json`), []);
const extSegura = (nombre) => (/^\.(csv|txt|xlsx|tsv)$/i.test(path.extname(String(nombre))) ? path.extname(String(nombre)).toLowerCase() : '.dat');
const hashDe = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function pendiente(outDir, hash) {
  if (!/^[0-9a-f]{64}$/.test(String(hash))) throw new Error('identificador de archivo inválido');
  const dir = path.join(dirImportados(outDir), 'pendientes');
  const f = fs.existsSync(dir) ? fs.readdirSync(dir).find((x) => x.startsWith(`${hash}.`) && !x.endsWith('.json')) : null;
  if (!f) throw new Error('el archivo ya no está pendiente: volvé a subirlo');
  const meta = leerJson(path.join(dir, `${hash}.json`), {});
  return { archivo: path.join(dir, f), nombre: meta.nombre ?? f };
}

/** Paso 1: guarda el archivo como pendiente y devuelve la vista previa. */
export function analizarArchivo(outDir, { nombre, contenido }) {
  const buf = Buffer.isBuffer(contenido) ? contenido : Buffer.from(String(contenido ?? ''), 'base64');
  if (!buf.length) throw new Error('el archivo está vacío');
  const hojas = leerArchivo(nombre, buf);
  const hash = hashDe(buf);
  const dir = path.join(dirImportados(outDir), 'pendientes');
  escribirAtomico(path.join(dir, `${hash}${extSegura(nombre)}`), buf);
  escribirAtomico(path.join(dir, `${hash}.json`), JSON.stringify({ nombre: path.basename(String(nombre)), cuando: new Date().toISOString() }));
  const previa = listarImportaciones(outDir).find((i) => i.hash === hash);
  return { hash, nombre: path.basename(String(nombre)), yaImportado: previa ? { id: previa.id, cuando: previa.cuando, concepto: previa.concepto } : null, ...vistaPrevia(hojas, 0, null) };
}

/** Vista previa de una hoja: encabezados, primeras filas y columnas sugeridas. Pura. */
export function vistaPrevia(hojas, hoja = 0, filaEncabezado = null) {
  const h = hojas[hoja] ?? hojas[0];
  const fe = filaEncabezado ?? detectarEncabezado(h.filas);
  const encabezados = (h.filas[fe] ?? []).map((x, i) => String(x ?? '').trim() || `Columna ${i + 1}`);
  const datos = h.filas.slice(fe + 1).filter((f) => (f ?? []).some((c) => String(c ?? '').trim()));
  return { hojas: hojas.map((x) => x.nombre), hoja: hojas.indexOf(h), filaEncabezado: fe, encabezados, filas: datos.slice(0, 15), totalFilas: datos.length, sugeridas: sugerirColumnas(encabezados) };
}

/**
 * Filas normalizadas según el mapeo: [{ mes, importe, descripcion, hash }] + descartadas. Pura.
 * mapeo: { concepto, hoja, filaEncabezado, colFecha, colImporte, colDescripcion, mesFijo }.
 */
export function normalizar(hojas, mapeo) {
  const concepto = CONCEPTOS[mapeo.concepto];
  if (!concepto) throw new Error('elegí qué representa el archivo (concepto)');
  if (concepto.legado) throw new Error(`«${concepto.nombre}» es un dato comercial: lo calcula PFOS, no se importa en FiscalOS`);
  const h = hojas[mapeo.hoja ?? 0] ?? hojas[0];
  const fe = mapeo.filaEncabezado ?? detectarEncabezado(h.filas);
  const datos = h.filas.slice(fe + 1).filter((f) => (f ?? []).some((c) => String(c ?? '').trim()));
  const ci = mapeo.colImporte == null || mapeo.colImporte === '' ? -1 : Number(mapeo.colImporte); const cf = mapeo.colFecha == null || mapeo.colFecha === '' ? -1 : Number(mapeo.colFecha);
  const cd = mapeo.colDescripcion == null || mapeo.colDescripcion === '' ? -1 : Number(mapeo.colDescripcion);
  if (!(ci >= 0)) throw new Error('elegí la columna del importe');
  const mesFijo = mapeo.mesFijo && /^\d{4}-\d{2}$/.test(mapeo.mesFijo) ? mapeo.mesFijo : null;
  if (cf < 0 && !mesFijo) throw new Error('elegí la columna de fecha/período o indicá a qué mes corresponde todo el archivo');
  const coma = usaComaDecimal(datos.map((f) => f[ci]));
  const filas = []; const descartadas = [];
  datos.forEach((f, i) => {
    const importe = importeImportado(f[ci], coma);
    const mes = mesFijo ?? mesDe(f[cf]);
    if (importe == null) { descartadas.push({ fila: fe + 2 + i, motivo: `importe ilegible: "${String(f[ci] ?? '').slice(0, 30)}"` }); return; }
    if (!mes) { descartadas.push({ fila: fe + 2 + i, motivo: `fecha/período ilegible: "${String(f[cf] ?? '').slice(0, 30)}"` }); return; }
    const hash = crypto.createHash('sha256').update(`${mapeo.concepto}|${f.map((c) => String(c ?? '').trim()).join('␟')}`).digest('hex');
    filas.push({ mes, importe, descripcion: cd >= 0 ? String(f[cd] ?? '').slice(0, 120) : '', hash });
  });
  return { filas, descartadas, comaDecimal: coma };
}

const r2 = (x) => Math.round(x * 100) / 100;
function resumenPorMes(filas) {
  const porMes = {};
  for (const f of filas) { porMes[f.mes] ??= { importe: 0, filas: 0 }; porMes[f.mes].importe = r2(porMes[f.mes].importe + f.importe); porMes[f.mes].filas++; }
  return porMes;
}

/** Hashes de filas ya importadas para un concepto. */
function hashesImportados(outDir, concepto) {
  const s = new Set();
  for (const imp of listarImportaciones(outDir).filter((i) => i.concepto === concepto)) for (const f of filasDe(outDir, imp.id)) s.add(f.hash);
  return s;
}

/** Paso 2: qué se incorporaría con este mapeo (sin guardar nada). */
export function simularImportacion(outDir, { hash, ...mapeo }) {
  const p = pendiente(outDir, hash);
  const hojas = leerArchivo(p.nombre, fs.readFileSync(p.archivo));
  const { filas, descartadas, comaDecimal } = normalizar(hojas, mapeo);
  const previas = hashesImportados(outDir, mapeo.concepto);
  const vistas = new Set(); const nuevas = []; let duplicadas = 0; let repetidasEnArchivo = 0;
  for (const f of filas) {
    if (previas.has(f.hash)) { duplicadas++; continue; }
    if (vistas.has(f.hash)) { repetidasEnArchivo++; continue; }
    vistas.add(f.hash); nuevas.push(f);
  }
  const yaImportado = listarImportaciones(outDir).find((i) => i.hash === hash) ?? null;
  return { hash, nombre: p.nombre, concepto: mapeo.concepto, conceptoNombre: CONCEPTOS[mapeo.concepto].nombre, filasValidas: filas.length, nuevas: nuevas.length,
    duplicadas, repetidasEnArchivo, descartadas: descartadas.length, ejemplosDescartadas: descartadas.slice(0, 5), comaDecimal,
    porMes: resumenPorMes(nuevas), yaImportado: yaImportado ? { id: yaImportado.id, cuando: yaImportado.cuando, concepto: yaImportado.concepto } : null, _nuevas: nuevas };
}

/** Paso 3: guarda la importación (solo filas nuevas). Devuelve el registro. */
export function confirmarImportacion(outDir, { hash, incluyeIva = false, ...mapeo }) {
  const sim = simularImportacion(outDir, { hash, ...mapeo });
  if (sim.yaImportado) throw new Error(`este archivo ya se importó el ${sim.yaImportado.cuando.slice(0, 10)} como "${CONCEPTOS[sim.yaImportado.concepto]?.nombre ?? sim.yaImportado.concepto}"`);
  if (!sim.nuevas) throw new Error(sim.duplicadas ? 'todas las filas ya estaban importadas: no hay nada nuevo' : 'no hay filas válidas para importar');
  const base = dirImportados(outDir);
  const p = pendiente(outDir, hash);
  const cuando = new Date().toISOString();
  const id = `${cuando.replace(/[:.]/g, '-')}-${hash.slice(0, 8)}`;
  const registro = { id, hash, archivo: sim.nombre, cuando, concepto: mapeo.concepto, incluyeIva: !!incluyeIva,
    mapeo: { hoja: mapeo.hoja ?? 0, filaEncabezado: mapeo.filaEncabezado ?? null, colFecha: mapeo.colFecha ?? null, colImporte: mapeo.colImporte, colDescripcion: mapeo.colDescripcion ?? null, mesFijo: mapeo.mesFijo ?? null },
    filas: sim.nuevas, duplicadas: sim.duplicadas, descartadas: sim.descartadas, porMes: sim.porMes };
  escribirAtomico(path.join(base, 'filas', `${id}.json`), JSON.stringify(sim._nuevas));
  fs.mkdirSync(path.join(base, 'archivos'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(p.archivo, path.join(base, 'archivos', `${hash}${path.extname(p.archivo)}`));
  escribirAtomico(path.join(base, 'importaciones.json'), JSON.stringify([...listarImportaciones(outDir), registro], null, 2));
  for (const f of [p.archivo, path.join(base, 'pendientes', `${hash}.json`)]) fs.rmSync(f, { force: true });
  return registro;
}

/** Deshace una importación (el archivo original queda guardado en archivos/). */
export function eliminarImportacion(outDir, id) {
  const lista = listarImportaciones(outDir);
  if (!lista.some((i) => i.id === id)) throw new Error('no existe esa importación');
  escribirAtomico(path.join(dirImportados(outDir), 'importaciones.json'), JSON.stringify(lista.filter((i) => i.id !== id), null, 2));
  fs.rmSync(path.join(dirImportados(outDir), 'filas', `${id}.json`), { force: true });
  return { eliminada: id };
}

/** Totales importados de un mes por concepto: { concepto: { importe, filas, archivos, incluyeIva } }. */
export function importadoDelMes(outDir, mes) {
  const out = {};
  for (const imp of listarImportaciones(outDir)) {
    const m = imp.porMes?.[mes];
    if (!m) continue;
    const o = (out[imp.concepto] ??= { importe: 0, filas: 0, archivos: [], incluyeIva: false });
    o.importe = r2(o.importe + m.importe); o.filas += m.filas; o.archivos.push(imp.archivo); o.incluyeIva ||= imp.incluyeIva;
  }
  return out;
}

/** Meses con algún dato importado. */
export const mesesImportados = (outDir) => [...new Set(listarImportaciones(outDir).flatMap((i) => Object.keys(i.porMes ?? {})))];

/** Vista previa de un archivo pendiente con otra hoja o fila de encabezado. */
export function vistaPendiente(outDir, { hash, hoja = 0, filaEncabezado = null }) {
  const p = pendiente(outDir, hash);
  const hojas = leerArchivo(p.nombre, fs.readFileSync(p.archivo));
  return { hash, nombre: p.nombre, ...vistaPrevia(hojas, Number(hoja) || 0, filaEncabezado == null || filaEncabezado === '' ? null : Number(filaEncabezado)) };
}
