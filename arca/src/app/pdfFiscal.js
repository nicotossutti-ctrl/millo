/**
 * Importación de una DJ en PDF sin decir cuál es: la CM03 de SIFERE o la DJ anual de Ganancias. Se reconoce por su texto
 * («Jurisdicciones incluidas» es la CM03; «Ganancias» con el F.2711 o F.711, la anual) y se manda a su lector.
 */
import { importarCm03, lineasDePdf } from './cm03.js';
import { importarDdjjGanancias } from './ddjjGanancias.js';
import { lineasType3 } from './glifos.js';

const plano = (paginas) => paginas.flatMap((p) => p.lineas.map((l) => l.palabras.map((w) => w.texto).join(' '))).join('\n').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** ¿Qué DJ es este PDF? 'cm03' | 'ddjj-ganancias' | null. */
export async function reconocerPdf(buf) {
  const comun = plano(await lineasDePdf(buf).catch(() => []));
  if (/jurisdicciones incluidas/.test(comun)) return 'cm03';
  const t3 = plano(await lineasType3(buf).catch(() => []));
  if (/jurisdicciones incluidas/.test(t3)) return 'cm03';
  if (/ganancias/.test(`${comun}\n${t3}`) && /\bf\.?\s*(2711|711)(?!\d)/.test(`${comun}\n${t3}`)) return 'ddjj-ganancias';
  return null;
}

/** Importa el PDF con el lector que corresponda. `tipo` fuerza uno; sin `tipo`, se reconoce. Devuelve el registro + `documento`. */
export async function importarPdfFiscal(outDir, { tipo = null, nombre, contenido, mes = null, anio = null }) {
  const buf = Buffer.isBuffer(contenido) ? contenido : Buffer.from(String(contenido ?? ''), 'base64');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('el archivo no es un PDF');
  const doc = tipo ?? await reconocerPdf(buf);
  if (doc === 'cm03') return { documento: 'cm03', ...(await importarCm03(outDir, { nombre, contenido: buf, mes })) };
  if (doc === 'ddjj-ganancias') return { documento: 'ddjj-ganancias', ...(await importarDdjjGanancias(outDir, { nombre, contenido: buf, anio })) };
  throw new Error('no reconozco este PDF: por ahora se leen la CM03 de SIFERE («Reporte») y la DJ anual de Ganancias (F.2711 / F.711)');
}
