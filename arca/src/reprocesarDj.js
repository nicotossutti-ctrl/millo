/**
 * Reinterpreta la DJ de IVA de un mes con lo que YA se bajó (sin abrir ARCA): toma la última
 * captura de la vista "Ver declaración jurada" (texto de pantalla + respuestas JSON) guardada en
 * out/datos/portal-iva-ddjj/intentos/<corrida>/, la vuelve a analizar con las reglas actuales y la
 * registra como un intento nuevo ("<corrida>-reprocesado"). Si queda VALIDADA, la conservación
 * la promueve al vigente como cualquier intento. La captura original no se modifica.
 */
import fs from 'node:fs';
import path from 'node:path';
import { analizarDj, csvConceptosDj } from './portal/ivaDdjj.js';
import { conservarIntento } from './portal/conservacion.js';
import { norm } from './portal/extractor.js';

export const ID_DJ_IVA = 'portal-iva-ddjj';
const SUFIJO = '-reprocesado';

/** Últimas capturas de la vista de la DJ de `mes` (más nueva primero). No incluye reprocesos. */
export function capturasDj(datosDir, mes) {
  const base = path.join(datosDir, ID_DJ_IVA, 'intentos');
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base)
    .filter((d) => !d.endsWith(SUFIJO) && fs.existsSync(path.join(base, d, `vista-ddjj-iva-${mes}.txt`)))
    .sort().reverse()
    .map((d) => ({ corrida: d, dir: path.join(base, d) }));
}

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
// Conceptos que sirven para revisar a mano la liquidación (saldos, débito, crédito, totales).
const RELEVANTE = /saldo|debito|credito|a pagar|ingresar|liquidacion|total|retenc|percep|pago a cuenta|anticipo/;

/** Texto de análisis (queda solo local): identificados, motivos y conceptos relevantes con su origen. */
export function textoAnalisis({ mes, corrida, analisis, jsons }) {
  const l = [`Análisis de la DJ de IVA ${mes} — captura ${corrida}`, ''];
  l.push(`Nivel: ${analisis.calidad.nivel}${analisis.declarado ? ` · importe declarado (saldo a pagar): ${fmt(analisis.declarado.importe)} — "${analisis.declarado.concepto}"` : ''}`);
  for (const mo of analisis.motivos) l.push(`Motivo: ${mo}`);
  l.push('', 'Conceptos identificados:');
  const ids = Object.entries(analisis.ident);
  if (!ids.length) l.push('  (ninguno)');
  for (const [k, v] of ids) l.push(`  ${k}: ${v.ambiguo ? `AMBIGUO → ${v.ambiguo.map((a) => `"${a.concepto}" ${fmt(a.importe)}`).join(' | ')}` : `${fmt(v.importe)} — "${v.concepto}"`}`);
  l.push('', `Respuestas JSON capturadas: ${jsons.length}`);
  for (const j of jsons) l.push(`  ${String(j.url ?? '').replace(/^https?:\/\/[^/]+/, '')}`);
  const rel = analisis.conceptos.filter((c) => RELEVANTE.test(norm(c.concepto)));
  l.push('', `Conceptos relevantes (${rel.length} de ${analisis.conceptos.length}):`);
  for (const c of rel.slice(0, 200)) l.push(`  [${c.origen === 'json' ? 'json' : 'pantalla'}] ${c.concepto} = ${fmt(c.importe)}`);
  return l.join('\n') + '\n';
}

/**
 * Reprocesa la DJ de `mes` desde su última captura. Devuelve
 * { corrida, cuando, analisis, conservacion, archivoAnalisis } o lanza si no hay captura.
 */
export function reprocesarDjIva({ datosDir, mes }) {
  const [captura] = capturasDj(datosDir, mes);
  if (!captura) throw new Error(`no hay captura de la vista de la DJ de IVA ${mes} en ${path.join(datosDir, ID_DJ_IVA, 'intentos')} (correr una vez -Servicios portal-iva-ddjj con ese mes)`);
  const texto = fs.readFileSync(path.join(captura.dir, `vista-ddjj-iva-${mes}.txt`), 'utf8');
  const fJson = path.join(captura.dir, `datos-ddjj-iva-${mes}.json`);
  const jsons = fs.existsSync(fJson) ? JSON.parse(fs.readFileSync(fJson, 'utf8')) : [];
  const analisis = analizarDj(texto, Array.isArray(jsons) ? jsons : [], mes);

  const cuando = `${captura.corrida}${SUFIJO}`;
  const dirIntento = path.join(datosDir, ID_DJ_IVA, 'intentos', cuando);
  fs.mkdirSync(dirIntento, { recursive: true, mode: 0o700 });
  // Copia de la captura (la original no se toca) + CSV y análisis nuevos.
  for (const f of [`vista-ddjj-iva-${mes}.txt`, `datos-ddjj-iva-${mes}.json`]) {
    if (fs.existsSync(path.join(captura.dir, f))) fs.copyFileSync(path.join(captura.dir, f), path.join(dirIntento, f));
  }
  const csvNombre = `ddjj-iva-${mes}.csv`;
  fs.writeFileSync(path.join(dirIntento, csvNombre), csvConceptosDj(analisis.conceptos), { mode: 0o600 });
  const archivoAnalisis = path.join(dirIntento, `analisis-ddjj-iva-${mes}.txt`);
  fs.writeFileSync(archivoAnalisis, textoAnalisis({ mes, corrida: captura.corrida, analisis, jsons: Array.isArray(jsons) ? jsons : [] }), { mode: 0o600 });

  const [y, m] = mes.split('-');
  const desde = `${mes}-01`; const hasta = new Date(Date.UTC(Number(y), Number(m), 0)).toISOString().slice(0, 10);
  const previo = (() => { try { return JSON.parse(fs.readFileSync(path.join(captura.dir, 'intento.json'), 'utf8')); } catch { return null; } })();
  const resultado = { id: ID_DJ_IVA, estado: analisis.calidad.validado ? 'extraido' : 'parcial', filas: analisis.conceptos.length, archivos: [csvNombre],
    conFiltroPeriodo: true, rangoOk: analisis.delPeriodo, calidad: analisis.calidad, conceptosIdentificados: analisis.claves,
    declarado: analisis.declarado?.importe ?? null, reprocesadoDe: captura.corrida, dj: previo?.dj ?? null };
  const conservacion = conservarIntento({ datosDir, id: ID_DJ_IVA, cuando, clave: `${desde}_${hasta}`, resultado, dirIntento, desde, hasta });
  return { corrida: captura.corrida, cuando, analisis, conservacion, archivoAnalisis };
}
