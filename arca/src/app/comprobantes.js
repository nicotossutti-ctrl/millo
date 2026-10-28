/**
 * Mis Comprobantes conservados (emitidos y recibidos): el texto del tramo verificado que cubre un mes entero y su resumen
 * de IVA y neto. Lo usan el panel fiscal, la estimación de Ganancias y la verificación de la cuenta de PFOS por CAE.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resumenComprobantes } from '../informeIva.js';
import { leerManifiesto, decodificar } from '../portal/misComprobantes.js';
import { leerZipDesdeArchivo } from '../portal/zip.js';

const finDeMes = (mes) => { const [y, m] = mes.split('-'); return new Date(Date.UTC(+y, +m, 0)).toISOString().slice(0, 10); };

const cacheTexto = new Map();
/** Texto CSV del tramo verificado de Mis Comprobantes que cubre el mes completo; null si no hay. */
export function textoComprobantes(datosDir, id, tipo, mes) {
  const dirFuente = path.join(datosDir, id);
  const ini = `${mes}-01`; const fin = finDeMes(mes);
  for (const [k, v] of Object.entries(leerManifiesto(dirFuente))) {
    const [t, d, h] = k.split(':');
    if (t !== tipo || !v?.ok || !v.archivo || d > ini || h < fin) continue;
    const f = path.join(dirFuente, v.archivo);
    let mtime = 0; try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
    const clave = `${f}|${mtime}`;
    if (!cacheTexto.has(clave)) {
      cacheTexto.set(clave, /\.zip$/i.test(f) ? leerZipDesdeArchivo(f).filter((e) => /\.csv$/i.test(e.name)).map((e) => decodificar(e.data)).join('\n') : decodificar(fs.readFileSync(f)));
    }
    return { texto: cacheTexto.get(clave), fecha: v.fecha, fuente: `${id} (apto, ${v.fecha})` };
  }
  return null;
}

/** Resumen de IVA/neto de Mis Comprobantes del mes; null si no hay tramo. */
export function comprobantesMes(datosDir, id, tipo, mes) {
  const t = textoComprobantes(datosDir, id, tipo, mes);
  if (!t) return null;
  const r = resumenComprobantes(t.texto, mes);
  return r.error ? null : { ...r, fecha: t.fecha, fuente: t.fuente };
}
