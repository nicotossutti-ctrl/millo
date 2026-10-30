/** Fotos de PFOS guardadas por `pfos:actualizar` (out/pfos/AAAA-MM.json). Sin dependencias, para no crear ciclos. */
import fs from 'node:fs';
import path from 'node:path';

export const dirFotos = (outDir) => path.join(outDir, 'pfos');

/** La foto de un mes; null si no hay. */
export function leerFoto(outDir, mes) {
  try { return JSON.parse(fs.readFileSync(path.join(dirFotos(outDir), `${mes}.json`), 'utf8')); } catch { return null; }
}

/** Todas las fotos guardadas (las que se pueden leer), por mes. */
export function leerFotos(outDir) {
  let nombres = [];
  try { nombres = fs.readdirSync(dirFotos(outDir)).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort(); } catch { return []; }
  return nombres.map((f) => leerFoto(outDir, f.slice(0, 7))).filter(Boolean);
}
