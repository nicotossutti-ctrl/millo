/**
 * Conservación de los datos extraídos. Regla: una corrida fallida o parcial NUNCA reemplaza el
 * último resultado bueno. Cada intento queda guardado aparte, con su error, y solo se PROMUEVE a
 * "vigente" si es al menos tan bueno como lo que ya había.
 *
 *   out/datos/<fuente>/intentos/<corrida>/   CSV del intento + intento.json (resumen y error)
 *   out/datos/<fuente>/intentos.jsonl        una línea por intento (trazabilidad)
 *   out/datos/<fuente>/vigente/<clave>/      copia de los archivos del mejor resultado
 *   out/datos/<fuente>/vigente.json          { <clave>: resumen del resultado vigente }
 *
 * <clave> es el período consultado ("aaaa-mm-dd_aaaa-mm-dd") o "acumulado" para las fuentes que
 * muestran todo sin filtro de fecha. Todo queda local (out/ no se sube al repo).
 */
import fs from 'node:fs';
import path from 'node:path';
import { sanitizarTexto } from './diagnostico.js';

function escribir(file, contenido) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contenido, { mode: 0o600 });
}
function leerJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}

/**
 * Qué tan bueno es un resultado, para decidir si reemplaza al vigente:
 *   3 validado (período y cantidad confirmados)
 *   2 extraído con columnas propias confirmadas, o cero confirmado (grilla presente y vacía)
 *   1 hay filas pero algo no se pudo verificar (parcial, columnas sin confirmar, grilla ajena)
 *   0 nada utilizable (error, sin grilla)
 */
export function rangoResultado(r) {
  if (!r || (r.error && !(r.filas > 0))) return 0;
  if (r.estado === 'validado') return r.calidad?.exito === false ? 1 : 3;
  if (r.estado === 'sin-datos' && r.ceroConfirmado) return 2;
  if ((r.filas ?? 0) > 0 && r.calidad?.exito) return 2;
  if ((r.filas ?? 0) > 0) return 1;
  return 0;
}

/** ¿El resultado nuevo reemplaza al vigente? Solo si es mejor, o igual de bueno y confiable (≥2: dato más reciente). */
export function debeReemplazar(nuevo, vigente) {
  const a = rangoResultado(nuevo);
  if (!vigente) return a > 0;
  const b = vigente.rango ?? 0;
  return a > b || (a === b && a >= 2);
}

export const claveDe = (r, { desde, hasta } = {}) => (r?.conFiltroPeriodo ? `${desde}_${hasta}` : 'acumulado');

/** Resumen sin datos fiscales (no lleva filas: solo conteos, estados y motivos saneados). */
function resumen(r) {
  const { estructura, ...resto } = r ?? {};
  // Se sanean los TEXTOS uno por uno (no el JSON entero: la máscara de importes podría romper un número).
  const sanear = (v) => (typeof v === 'string' ? sanitizarTexto(v)
    : Array.isArray(v) ? v.map(sanear)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanear(x)])) : v);
  return sanear(JSON.parse(JSON.stringify(resto)));
}

/**
 * Registra un intento (siempre) y lo promueve a vigente si corresponde. `dirIntento` es donde el
 * extractor dejó los archivos de ESTE intento (puede no existir si falló antes de escribir).
 * Devuelve { promovido, clave, motivo, vigente } para el informe.
 */
export function conservarIntento({ datosDir, id, cuando, clave, resultado, dirIntento, desde, hasta }) {
  // Sin clave (no se llegó a extraer nada): se registra el intento y su error, sin tocar el vigente.
  if (!clave) {
    registrarIntento({ datosDir, id, cuando, resultado });
    const algun = Object.values(leerVigente(datosDir, id)).sort((x, y) => String(y.cuando).localeCompare(String(x.cuando)))[0] ?? null;
    return { promovido: false, clave: null, vigente: algun,
      motivo: algun ? `intento fallido; se conserva lo obtenido el ${algun.cuando}` : 'intento fallido; no hay datos conservados de antes' };
  }
  const base = path.join(datosDir, id);
  const dirI = dirIntento ?? path.join(base, 'intentos', cuando);
  const rango = rangoResultado(resultado);
  const res = resumen(resultado);
  escribir(path.join(dirI, 'intento.json'), JSON.stringify({ cuando, clave, desde, hasta, rango, ...res }, null, 2));

  const manifFile = path.join(base, 'vigente.json');
  const manif = leerJson(manifFile, {});
  const previo = manif[clave] ?? null;
  const promovido = debeReemplazar(resultado, previo);
  let motivo;
  if (promovido) {
    const destino = path.join(base, 'vigente', clave);
    fs.rmSync(destino, { recursive: true, force: true });
    fs.mkdirSync(destino, { recursive: true, mode: 0o700 });
    const archivos = [];
    for (const f of resultado.archivos ?? []) {
      const src = path.join(dirI, path.basename(f));
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(destino, path.basename(f)));
      archivos.push(path.basename(f));
    }
    manif[clave] = {
      cuando, rango, estado: resultado.estado, filas: resultado.filas ?? 0, informados: resultado.informados ?? null,
      desde: desde ?? null, hasta: hasta ?? null, acumulado: clave === 'acumulado', archivos,
      calidad: res.calidad ?? null, ceroConfirmado: resultado.ceroConfirmado ?? null,
    };
    escribir(manifFile, JSON.stringify(manif, null, 2));
    motivo = previo ? `reemplaza al vigente del ${previo.cuando} (rango ${previo.rango} → ${rango})` : 'primer resultado utilizable';
  } else {
    motivo = previo
      ? `se conserva el vigente del ${previo.cuando} (${previo.estado}, ${previo.filas} filas): este intento (rango ${rango}) no es mejor`
      : 'intento sin datos utilizables: no hay vigente';
  }
  const linea = { cuando, clave, estado: resultado?.estado ?? null, filas: resultado?.filas ?? 0, rango, promovido, error: res.error ?? null, motivo: res.motivo ?? null };
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(base, 'intentos.jsonl'), JSON.stringify(linea) + '\n', { mode: 0o600 });
  return { promovido, clave, motivo, vigente: manif[clave] ?? null };
}

/**
 * Registra un intento SIN promoverlo (fuentes con conservación propia, como Mis Comprobantes, o
 * intentos que fallaron antes de extraer). Deja intento.json y la línea en intentos.jsonl.
 */
export function registrarIntento({ datosDir, id, cuando, resultado }) {
  const base = path.join(datosDir, id);
  const res = resumen(resultado);
  const rango = rangoResultado(resultado);
  escribir(path.join(base, 'intentos', cuando, 'intento.json'), JSON.stringify({ cuando, rango, ...res }, null, 2));
  const linea = { cuando, clave: null, estado: resultado?.estado ?? null, filas: resultado?.filas ?? 0, rango, promovido: false, error: res.error ?? null, motivo: res.motivo ?? null };
  fs.appendFileSync(path.join(base, 'intentos.jsonl'), JSON.stringify(linea) + '\n', { mode: 0o600 });
  return linea;
}

export function leerVigente(datosDir, id) { return leerJson(path.join(datosDir, id, 'vigente.json'), {}); }

export function leerIntentos(datosDir, id) {
  try {
    return fs.readFileSync(path.join(datosDir, id, 'intentos.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
