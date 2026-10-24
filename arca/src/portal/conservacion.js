/**
 * Conservación de los datos extraídos. Separa sin ambigüedad la EVIDENCIA (todo intento, bueno o
 * malo, con su error) de los DATOS FISCALES UTILIZABLES (vigente). Reglas:
 *   - a vigente solo llega lo VALIDADO (nivel 'validado' o 'apto' de calidad.js); una grilla ajena,
 *     sin columnas propias confirmadas o con un control fundamental fallido queda solo como intento;
 *   - antes de promover se comprueba que los archivos existan, se puedan leer y sumen las filas;
 *   - un intento nunca reemplaza a un vigente mejor (una corrida fallida o parcial no pisa nada).
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
 * Qué tan bueno es un resultado, según el nivel que le asignó la validación (calidad.js):
 *   3 apto para cálculos (validado y cantidad cotejada contra el total de ARCA, o cero validado)
 *   2 validado (sin total de ARCA para cotejar la cantidad)
 *   0 todo lo demás: evidencia (obtenido sin validar, grilla ajena, error). Nunca se promueve.
 * Sin calidad evaluada no hay nivel: 0. No hay un nivel intermedio "con filas": tener filas no
 * convierte un intento en dato utilizable.
 */
export const RANGO_MINIMO_VIGENTE = 2;
export function rangoResultado(r) {
  const nivel = r?.calidad?.nivel;
  if (nivel === 'apto') return 3;
  if (nivel === 'validado') return 2;
  return 0;
}

/** ¿El resultado nuevo reemplaza al vigente? Solo si está validado y es mejor, o igual de bueno (dato más reciente). */
export function debeReemplazar(nuevo, vigente) {
  const a = rangoResultado(nuevo);
  if (a < RANGO_MINIMO_VIGENTE) return false;
  if (!vigente) return true;
  const b = vigente.rango ?? 0;
  return a > b || a === b;
}

/**
 * Comprueba los archivos de un intento ANTES de promoverlo: que existan, que se puedan leer y que
 * sus filas de datos (líneas no vacías menos el encabezado) sumen exactamente `filas`. Los CSV los
 * escribe el extractor con toCsv (una fila por línea: las celdas no tienen saltos de línea).
 */
export function verificarArchivos(dir, archivos, filas) {
  let total = 0;
  for (const f of archivos ?? []) {
    const ruta = path.join(dir, path.basename(f));
    let txt;
    try { txt = fs.readFileSync(ruta, 'utf8'); } catch { return { ok: false, motivo: `no se puede leer ${path.basename(f)}` }; }
    const lineas = txt.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
    if (!lineas.length) return { ok: false, motivo: `${path.basename(f)} está vacío (ni encabezado)` };
    total += lineas.length - 1;
  }
  if (total !== (filas ?? 0)) return { ok: false, motivo: `los archivos tienen ${total} filas y la extracción informa ${filas ?? 0}` };
  return { ok: true, filas: total };
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
  let promovido = debeReemplazar(resultado, previo);
  let motivo;
  // Archivos: sin esto, un vigente podría apuntar a archivos que no están o que no tienen los datos.
  const archivosOk = promovido ? verificarArchivos(dirI, resultado.archivos, resultado.filas) : null;
  if (archivosOk && !archivosOk.ok) {
    promovido = false;
    motivo = `validado pero NO se promueve: ${archivosOk.motivo}`;
  }
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
      cuando, rango, nivel: resultado.calidad?.nivel ?? null, estado: resultado.estado, filas: resultado.filas ?? 0, informados: resultado.informados ?? null,
      desde: desde ?? null, hasta: hasta ?? null, acumulado: clave === 'acumulado', archivos,
      calidad: res.calidad ?? null, ceroConfirmado: resultado.ceroConfirmado ?? null,
    };
    escribir(manifFile, JSON.stringify(manif, null, 2));
    motivo = previo ? `reemplaza al vigente del ${previo.cuando} (rango ${previo.rango} → ${rango})` : `primer resultado ${resultado.calidad.nivel === 'apto' ? 'apto para cálculos' : 'validado'}`;
  } else if (!motivo) {
    const evidencia = rango < RANGO_MINIMO_VIGENTE ? `queda solo como evidencia (nivel ${resultado?.calidad?.nivel ?? 'sin evaluar'})` : 'no es mejor';
    motivo = previo
      ? `se conserva el vigente del ${previo.cuando} (${previo.nivel ?? previo.estado}, ${previo.filas} filas): este intento ${evidencia}`
      : `este intento ${evidencia}; no hay datos vigentes`;
  }
  const linea = { cuando, clave, estado: resultado?.estado ?? null, nivel: resultado?.calidad?.nivel ?? null, filas: resultado?.filas ?? 0, rango, promovido,
    error: res.error ?? null, motivo: res.motivo ?? null, conservacion: motivo };
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
  const linea = { cuando, clave: null, estado: resultado?.estado ?? null, nivel: resultado?.calidad?.nivel ?? null, filas: resultado?.filas ?? 0, rango, promovido: false, error: res.error ?? null, motivo: res.motivo ?? null };
  fs.appendFileSync(path.join(base, 'intentos.jsonl'), JSON.stringify(linea) + '\n', { mode: 0o600 });
  return linea;
}

export function leerVigente(datosDir, id) { return leerJson(path.join(datosDir, id, 'vigente.json'), {}); }

export function leerIntentos(datosDir, id) {
  try {
    return fs.readFileSync(path.join(datosDir, id, 'intentos.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
