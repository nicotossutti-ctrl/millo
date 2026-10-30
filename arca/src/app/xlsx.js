/**
 * Lector mínimo de planillas .xlsx (Office Open XML) sin dependencias: un .xlsx es un ZIP con XML.
 * Devuelve las hojas como filas de texto. Las fechas (números con formato de fecha) salen como
 * AAAA-MM-DD; los demás números, como texto con punto decimal ("1234.5").
 * No soporta el formato binario viejo .xls: hay que guardarlo como .xlsx o .csv.
 */
import { leerZip } from '../portal/zip.js';

const desescapar = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

/** Texto de un <si> o <is>: concatena todos sus <t> (texto enriquecido incluido). */
const textoDe = (xml) => [...String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => desescapar(m[1])).join('');

const attr = (tag, nombre) => tag.match(new RegExp(`\\s${nombre}="([^"]*)"`))?.[1] ?? null;

/** "B12" -> 1 (índice de columna desde 0). */
export function columnaDe(ref) {
  const letras = String(ref).match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? 'A';
  let n = 0;
  for (const c of letras) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** Número de serie de Excel (sistema 1900) -> 'AAAA-MM-DD'. */
export function fechaExcel(serie) {
  const ms = Math.round((Number(serie) - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

// Formatos de número de Excel que son fechas: integrados 14-22 y 45-47, o códigos con d/m/y.
const FORMATOS_FECHA = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const esCodigoFecha = (codigo) => /[dmy]/i.test(String(codigo).replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));

/** Índices de estilo (atributo s de la celda) cuyo formato es fecha. */
function estilosFecha(xmlEstilos) {
  if (!xmlEstilos) return new Set();
  const propios = new Map();
  for (const m of xmlEstilos.matchAll(/<numFmt\s[^>]*>/g)) propios.set(Number(attr(m[0], 'numFmtId')), desescapar(attr(m[0], 'formatCode') ?? ''));
  const xfs = xmlEstilos.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '';
  const out = new Set();
  [...xfs.matchAll(/<xf\s[^>]*?(?:\/>|>)/g)].forEach((m, i) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    if (FORMATOS_FECHA.has(id) || (propios.has(id) && esCodigoFecha(propios.get(id)))) out.add(i);
  });
  return out;
}

/** Lee un .xlsx (Buffer). Devuelve [{ nombre, filas: string[][] }] en el orden del libro. */
export function leerXlsx(buf) {
  const archivos = new Map(leerZip(buf).map((e) => [e.name.replace(/^\/+/, ''), e.data.toString('utf8')]));
  const libro = archivos.get('xl/workbook.xml');
  if (!libro) throw new Error('no es una planilla .xlsx válida (falta xl/workbook.xml)');
  const rels = archivos.get('xl/_rels/workbook.xml.rels') ?? '';
  const destino = new Map([...rels.matchAll(/<Relationship\s[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const compartidos = [...(archivos.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textoDe(m[1]));
  const fechas = estilosFecha(archivos.get('xl/styles.xml'));
  const hojas = [];
  for (const m of libro.matchAll(/<sheet\s[^>]*>/g)) {
    const nombre = desescapar(attr(m[0], 'name') ?? `Hoja ${hojas.length + 1}`);
    const rid = attr(m[0], 'r:id');
    let ruta = destino.get(rid) ?? '';
    ruta = ruta.startsWith('/') ? ruta.slice(1) : `xl/${ruta.replace(/^\.\//, '')}`;
    const xml = archivos.get(ruta);
    if (!xml) continue;
    const filas = [];
    for (const r of xml.matchAll(/<row\s[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const nFila = Number(attr(r[0], 'r') ?? filas.length + 1) - 1;
      const fila = [];
      for (const c of (r[1] ?? '').matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c ${c[1]}>`;
        const ref = attr(tag, 'r');
        const i = ref ? columnaDe(ref) : fila.length;
        const tipo = attr(tag, 't');
        const cuerpo = c[2] ?? '';
        const v = cuerpo.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let valor = '';
        if (tipo === 's') valor = compartidos[Number(v)] ?? '';
        else if (tipo === 'inlineStr') valor = textoDe(cuerpo);
        else if (tipo === 'str' || tipo === 'e') valor = desescapar(v ?? '');
        else if (tipo === 'b') valor = v === '1' ? 'VERDADERO' : 'FALSO';
        else if (v != null) valor = fechas.has(Number(attr(tag, 's') ?? -1)) ? fechaExcel(v) : String(Number(v));
        fila[i] = valor;
      }
      filas[nFila] = Array.from(fila, (x) => x ?? '');
    }
    hojas.push({ nombre, filas: Array.from(filas, (x) => x ?? []) });
  }
  if (!hojas.length) throw new Error('la planilla no tiene hojas legibles');
  return hojas;
}
