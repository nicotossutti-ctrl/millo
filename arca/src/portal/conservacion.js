/**
 * Conservación de los datos extraídos. Separa sin ambigüedad la EVIDENCIA (todo intento, bueno o
 * malo, con su error) de los DATOS FISCALES UTILIZABLES (vigente). Reglas:
 *   - a vigente solo llega lo VALIDADO (nivel 'validado' o 'apto' de calidad.js); una grilla ajena,
 *     sin columnas propias confirmadas o con un control fundamental fallido queda solo como intento;
 *   - antes de promover se comprueba que los archivos existan, se puedan leer y sumen las filas;
 *   - un intento nunca reemplaza a un vigente mejor (una corrida fallida o parcial no pisa nada);
 *   - un intento de igual nivel con MENOS filas no reemplaza, salvo que el total de ARCA confirme
 *     la reducción: queda pendiente de revisión (el organismo puede haber cambiado registros, o la
 *     corrida pudo perder cobertura sin detectarlo);
 *   - si la fuente distingue registros reales de constancias (reduccionDeRegistros), una lectura con
 *     menos registros en algún grupo no reemplaza nunca, aunque tenga las mismas filas;
 *   - la sustitución es segura: se copia a una carpeta temporal, se verifica, el vigente anterior
 *     pasa a respaldos/ y recién entonces la copia nueva ocupa su lugar. Si algo falla, el anterior
 *     queda intacto o se restaura; una interrupción a mitad se repara en la corrida siguiente.
 *
 *   out/datos/<fuente>/intentos/<corrida>/   CSV del intento + intento.json (resumen y error)
 *   out/datos/<fuente>/intentos.jsonl        una línea por intento (trazabilidad)
 *   out/datos/<fuente>/vigente/<clave>/      copia de los archivos del mejor resultado
 *   out/datos/<fuente>/vigente.json          { <clave>: resumen del resultado vigente }
 *   out/datos/<fuente>/respaldos/<clave>/<corrida>/  vigentes anteriores (los últimos MAX_RESPALDOS)
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

/**
 * ¿El resultado nuevo reemplaza al vigente? Solo si está validado y es al menos tan bueno. Además,
 * si trae MENOS filas que el vigente, solo reemplaza cuando la cantidad nueva está cotejada contra
 * el total que informa ARCA (calidad.total === 'coincide'): eso prueba que la reducción es del
 * organismo y no una pérdida de cobertura de la corrida. Si no, devuelve `reduccion` sin confirmar
 * y el intento queda pendiente de revisión. Devuelve { reemplaza, motivo?, reduccion? }.
 */
export function evaluarReemplazo(nuevo, vigente) {
  const a = rangoResultado(nuevo);
  if (a < RANGO_MINIMO_VIGENTE) return { reemplaza: false, motivo: `queda solo como evidencia (nivel ${nuevo?.calidad?.nivel ?? 'sin evaluar'})` };
  if (!vigente) return { reemplaza: true };
  const b = vigente.rango ?? 0;
  if (a < b) return { reemplaza: false, motivo: `no es mejor que el vigente (nivel ${nuevo.calidad.nivel} < ${vigente.nivel ?? b})` };
  const grupos = reduccionDeRegistros(nuevo, vigente);
  if (grupos) {
    return { reemplaza: false, reduccion: { antes: vigente.registros ?? null, ahora: nuevo.registros ?? 0, confirmada: false, grupos },
      motivo: `trae menos registros reales que el vigente (${grupos.map((g) => `${g.grupo ?? 'total'}: ${g.antes} → ${g.ahora}`).join('; ')}): una lectura nueva sin esos registros no borra los guardados; queda pendiente de revisión` };
  }
  const antes = vigente.filas ?? 0; const ahora = nuevo.filas ?? 0;
  if (ahora < antes) {
    if (nuevo.calidad?.total === 'coincide') return { reemplaza: true, reduccion: { antes, ahora, confirmada: true } };
    return { reemplaza: false, reduccion: { antes, ahora, confirmada: false },
      motivo: `trae ${ahora} filas y el vigente ${antes}: una reducción sin el total de ARCA que la confirme no reemplaza datos; queda pendiente de revisión` };
  }
  return { reemplaza: true };
}

/**
 * Fuentes cuyas filas guardadas mezclan REGISTROS reales con constancias de cobertura (p. ej. SIFERE Consultas: los pagos
 * y una fila «sin pagos» por jurisdicción) declaran `registros` y `registrosPorGrupo`. Contar filas no alcanza: una
 * constancia no prueba que la lectura nueva sea tan completa como la anterior. Devuelve los grupos en que la lectura nueva
 * trae MENOS registros que el vigente, o null. Ninguna reducción se da por confirmada: no hay un total del organismo que
 * pruebe que un pago dejó de existir (una anulación tendría que identificarse). Pura.
 */
export function reduccionDeRegistros(nuevo, vigente) {
  if (vigente?.registros == null) return null;
  const antes = vigente.registrosPorGrupo ?? {}; const ahora = nuevo?.registrosPorGrupo ?? {};
  const grupos = Object.entries(antes).filter(([g, n]) => n > (ahora[g] ?? 0)).map(([grupo, n]) => ({ grupo, antes: n, ahora: ahora[grupo] ?? 0 }));
  if (!grupos.length && vigente.registros > (nuevo?.registros ?? 0)) grupos.push({ grupo: null, antes: vigente.registros, ahora: nuevo?.registros ?? 0 });
  return grupos.length ? grupos : null;
}

export function debeReemplazar(nuevo, vigente) { return evaluarReemplazo(nuevo, vigente).reemplaza; }

export const MAX_RESPALDOS = 3;

/** Escritura atómica de un archivo: a un temporal y rename encima (en Windows también reemplaza). */
function escribirAtomico(file, contenido) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contenido, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Sustitución segura de vigente/<clave>. Pasos:
 *   1. copiar los archivos a vigente/.nuevo-<clave>/ y VERIFICAR la copia (existencia, lectura, filas);
 *   2. mover el vigente anterior a respaldos/<clave>/<corrida anterior>/;
 *   3. mover la copia nueva a vigente/<clave>/.
 * Si falla 1, el vigente anterior no se tocó. Si falla 3, se restaura el anterior desde el respaldo.
 * `ops` permite inyectar fallas en los tests. Devuelve { ok, motivo?, respaldo? }.
 */
export function sustituirVigente({ base, clave, dirOrigen, archivos, filas, meta, cuandoPrevio = null, ops = {} }) {
  const copiar = ops.copyFileSync ?? fs.copyFileSync;
  const mover = ops.renameSync ?? fs.renameSync;
  const vig = path.join(base, 'vigente');
  const destino = path.join(vig, clave);
  const temp = path.join(vig, `.nuevo-${clave}`);
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  try {
    for (const f of archivos ?? []) copiar(path.join(dirOrigen, path.basename(f)), path.join(temp, path.basename(f)));
    const v = verificarArchivos(temp, archivos, filas);
    if (!v.ok) throw new Error(`la copia no quedó bien: ${v.motivo}`);
    fs.writeFileSync(path.join(temp, '_meta.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
  } catch (e) {
    fs.rmSync(temp, { recursive: true, force: true });
    return { ok: false, motivo: `no se pudo preparar la copia nueva (${e.message}); el vigente anterior queda intacto` };
  }
  let respaldo = null;
  if (fs.existsSync(destino)) {
    const prevMeta = leerJson(path.join(destino, '_meta.json'), null);
    respaldo = path.join(base, 'respaldos', clave, String(prevMeta?.cuando ?? cuandoPrevio ?? 'anterior'));
    fs.rmSync(respaldo, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(respaldo), { recursive: true, mode: 0o700 });
    try { mover(destino, respaldo); } catch (e) {
      fs.rmSync(temp, { recursive: true, force: true });
      return { ok: false, motivo: `no se pudo resguardar el vigente anterior (${e.message}); queda intacto` };
    }
  }
  try { mover(temp, destino); } catch (e) {
    let restaurado = false;
    if (respaldo) { try { mover(respaldo, destino); restaurado = true; } catch { /* lo repara repararVigente */ } }
    fs.rmSync(temp, { recursive: true, force: true });
    return { ok: false, motivo: `no se pudo colocar la copia nueva (${e.message}); ${restaurado ? 'se restauró el vigente anterior' : 'el anterior está en respaldos/ y se restaura en la próxima corrida'}` };
  }
  podarRespaldos(base, clave);
  return { ok: true, respaldo };
}

function podarRespaldos(base, clave) {
  const dir = path.join(base, 'respaldos', clave);
  let hijos = [];
  try { hijos = fs.readdirSync(dir).sort(); } catch { return; }
  for (const h of hijos.slice(0, Math.max(0, hijos.length - MAX_RESPALDOS))) fs.rmSync(path.join(dir, h), { recursive: true, force: true });
}

/**
 * Repara una sustitución interrumpida (p. ej. Windows cortó a mitad). La carpeta vigente/<clave>
 * es la fuente de verdad (su _meta.json), porque se coloca con un rename:
 *   - borra copias temporales a medio hacer (vigente/.nuevo-*);
 *   - si vigente/<clave> no está pero hay respaldo, restaura el más reciente;
 *   - si el manifiesto no coincide con el _meta.json de la carpeta, lo actualiza.
 * Devuelve el manifiesto (reparado si hizo falta).
 */
export function repararVigente(base) {
  const manifFile = path.join(base, 'vigente.json');
  const manif = leerJson(manifFile, {});
  const vig = path.join(base, 'vigente');
  let cambio = false;
  let hijos = [];
  try { hijos = fs.readdirSync(vig); } catch { /* sin vigente todavía */ }
  for (const h of hijos) if (h.startsWith('.nuevo-')) fs.rmSync(path.join(vig, h), { recursive: true, force: true });
  const claves = new Set([...Object.keys(manif), ...hijos.filter((h) => !h.startsWith('.'))]);
  for (const clave of claves) {
    const destino = path.join(vig, clave);
    if (!fs.existsSync(destino)) {
      let resp = [];
      try { resp = fs.readdirSync(path.join(base, 'respaldos', clave)).sort(); } catch { /* sin respaldos */ }
      if (resp.length) {
        fs.mkdirSync(vig, { recursive: true, mode: 0o700 });
        fs.renameSync(path.join(base, 'respaldos', clave, resp.at(-1)), destino);
      } else continue;
    }
    const meta = leerJson(path.join(destino, '_meta.json'), null);
    if (meta && meta.cuando !== manif[clave]?.cuando) {
      manif[clave] = { ...meta, reparado: true };
      cambio = true;
    }
  }
  if (cambio) escribirAtomico(manifFile, JSON.stringify(manif, null, 2));
  return manif;
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
export function conservarIntento({ datosDir, id, cuando, clave, resultado, dirIntento, desde, hasta, ops }) {
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
  const manif = repararVigente(base);
  const previo = manif[clave] ?? null;
  const decision = evaluarReemplazo(resultado, previo);
  let promovido = decision.reemplaza;
  let motivo;
  // Archivos del intento: sin esto, un vigente podría apuntar a archivos que no están o que no tienen los datos.
  const archivosOk = promovido ? verificarArchivos(dirI, resultado.archivos, resultado.filas) : null;
  if (archivosOk && !archivosOk.ok) {
    promovido = false;
    motivo = `validado pero NO se promueve: ${archivosOk.motivo}`;
  }
  if (promovido) {
    const entrada = {
      cuando, rango, nivel: resultado.calidad?.nivel ?? null, estado: resultado.estado, filas: resultado.filas ?? 0, informados: resultado.informados ?? null,
      desde: desde ?? null, hasta: hasta ?? null, acumulado: clave === 'acumulado', archivos: (resultado.archivos ?? []).map((f) => path.basename(f)),
      calidad: res.calidad ?? null, ceroConfirmado: resultado.ceroConfirmado ?? null,
      ...(resultado.registros != null ? { registros: resultado.registros, registrosPorGrupo: resultado.registrosPorGrupo ?? null } : {}),
    };
    const sust = sustituirVigente({ base, clave, dirOrigen: dirI, archivos: entrada.archivos, filas: entrada.filas, meta: entrada, cuandoPrevio: previo?.cuando, ops });
    if (!sust.ok) {
      promovido = false;
      motivo = `validado pero NO se promueve: ${sust.motivo}`;
    } else {
      manif[clave] = entrada;
      escribirAtomico(manifFile, JSON.stringify(manif, null, 2));
      const red = decision.reduccion ? `; reducción ${decision.reduccion.antes} → ${decision.reduccion.ahora} filas confirmada por el total de ARCA` : '';
      motivo = (previo ? `reemplaza al vigente del ${previo.cuando} (rango ${previo.rango} → ${rango}; el anterior queda en respaldos/)` : `primer resultado ${resultado.calidad.nivel === 'apto' ? 'apto para cálculos' : 'validado'}`) + red;
    }
  } else if (!motivo) {
    motivo = previo
      ? `se conserva el vigente del ${previo.cuando} (${previo.nivel ?? previo.estado}, ${previo.filas} filas): este intento ${decision.motivo}`
      : `este intento ${decision.motivo}; no hay datos vigentes`;
  }
  // Reducción sin confirmar: el vigente sigue, y el intento queda marcado para revisión.
  if (!promovido && decision.reduccion && !decision.reduccion.confirmada && previo) {
    manif[clave] = { ...previo, pendienteRevision: { cuando, filas: resultado.filas ?? 0, nivel: resultado.calidad?.nivel ?? null, motivo: decision.motivo,
      ...(decision.reduccion.grupos ? { registros: resultado.registros ?? 0, grupos: decision.reduccion.grupos } : {}) } };
    escribirAtomico(manifFile, JSON.stringify(manif, null, 2));
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
