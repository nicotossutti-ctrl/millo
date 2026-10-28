/**
 * Cargas manuales desde la interfaz (sin editar JSON a mano).
 *
 * Carga manual: un importe por concepto y mes, con su fuente y si es una ESTIMACIÓN (entonces se muestra
 * como estimado, nunca como dato firme), ("planilla de administración", "CM03
 * presentado", ...) y una nota. Se puede corregir o borrar. Para un concepto y mes puede haber varias
 * cargas (p. ej. dos pagos): se suman entre sí. La carga manual tiene prioridad sobre un archivo importado del mismo
 * concepto (ver panel.js): nunca se suma a él. Los conceptos comerciales viejos (legado) se conservan y se pueden
 * corregir o borrar, pero no se crean nuevos: los calcula PFOS.
 *
 * La clasificación de proveedores (out/importados/proveedores.json) era de la rentabilidad comercial: el archivo se
 * conserva, pero FiscalOS ya no la usa.
 *
 * Todo queda en out/importados/ (local, fuera del repositorio).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONCEPTOS } from './importar.js';

const dir = (outDir) => path.join(outDir, 'importados');
const leerJson = (f, defecto) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return defecto; } };
function escribirAtomico(f, contenido) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contenido, { mode: 0o600 });
  fs.renameSync(tmp, f);
}
const r2 = (x) => Math.round(x * 100) / 100;

// ---------------- cargas manuales ----------------

const archivoManuales = (outDir) => path.join(dir(outDir), 'manuales.json');
export const listarManuales = (outDir) => leerJson(archivoManuales(outDir), []);

/** Crea o corrige una carga manual. Devuelve la carga guardada. */
export function guardarManual(outDir, { id = null, mes, concepto, importe, fuente, nota = '', estimado = false }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes))) throw new Error('mes inválido (AAAA-MM)');
  if (!CONCEPTOS[concepto]) throw new Error('concepto desconocido');
  if (CONCEPTOS[concepto].legado && !id) throw new Error(`«${CONCEPTOS[concepto].nombre}» es un dato comercial: lo calcula PFOS`);
  const t = String(importe ?? '').trim().replace(/\s|\$/g, '');
  // "1234.56" (campo numérico) o "1.234,56" (escrito a mano).
  // "2.500" escrito a mano es dos mil quinientos (punto de miles), no 2,5.
  const n = typeof importe === 'number' ? importe
    : /^-?\d{1,3}(\.\d{3})+$/.test(t) ? Number(t.replace(/\./g, ''))
      : /^-?\d+(\.\d{1,2})?$/.test(t) ? Number(t)
        : t ? Number(t.replace(/\./g, '').replace(',', '.')) : NaN;
  if (!Number.isFinite(n)) throw new Error('importe inválido');
  const f = String(fuente ?? '').trim();
  if (!f) throw new Error('indicá de dónde sale el importe (fuente)');
  const lista = listarManuales(outDir);
  const ahora = new Date().toISOString();
  let carga;
  if (id) {
    const i = lista.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('no existe esa carga');
    carga = { ...lista[i], mes, concepto, importe: r2(n), fuente: f.slice(0, 200), nota: String(nota ?? '').slice(0, 500), estimado: !!estimado, actualizado: ahora,
      historial: [...(lista[i].historial ?? []), { importe: lista[i].importe, fuente: lista[i].fuente, cuando: lista[i].actualizado ?? lista[i].cuando }].slice(-10) };
    lista[i] = carga;
  } else {
    carga = { id: `${ahora.replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`, mes, concepto, importe: r2(n), fuente: f.slice(0, 200), nota: String(nota ?? '').slice(0, 500), estimado: !!estimado, cuando: ahora, actualizado: ahora };
    lista.push(carga);
  }
  escribirAtomico(archivoManuales(outDir), JSON.stringify(lista, null, 2));
  return carga;
}

export function eliminarManual(outDir, id) {
  const lista = listarManuales(outDir);
  if (!lista.some((x) => x.id === id)) throw new Error('no existe esa carga');
  escribirAtomico(archivoManuales(outDir), JSON.stringify(lista.filter((x) => x.id !== id), null, 2));
  return { eliminada: id };
}

/** Cargas manuales de un mes por concepto: { concepto: { importe, cargas: [...] } }. */
export function manualesDelMes(outDir, mes) {
  const out = {};
  for (const c of listarManuales(outDir).filter((x) => x.mes === mes)) {
    const o = (out[c.concepto] ??= { importe: 0, cargas: [], estimado: false });
    o.importe = r2(o.importe + c.importe); o.cargas.push(c); o.estimado ||= !!c.estimado;
  }
  return out;
}
