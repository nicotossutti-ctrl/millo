/**
 * «Actualizar datos fiscales» desde la app: lanza la corrida DIRIGIDA (portal:todo --plan, con el navegador visible):
 * solo lo que falta de IVA, IIBB y Ganancias, cada fuente con su ventana de fechas (plan.js), como proceso aparte, y
 * guarda su avance para mostrarlo.
 * Una sola a la vez. Solo lectura en ARCA y SIFERE; lo que se baja queda en out/ y nunca borra lo guardado antes.
 * Si ARCA o COMARB piden la clave fiscal, se escribe en la ventana del navegador (FiscalOS nunca la tipea).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizarTexto } from '../portal/diagnostico.js';
import { planActualizacion } from './plan.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_LINEAS = 400;
let estado = { corriendo: false, inicio: null, fin: null, codigo: null, lineas: [], balance: null, plan: null };

const CON_DATOS = new Set(['validado', 'descargado']);
const CON_ERROR = new Set(['sin-acceso', 'desafio', 'error']);
/**
 * Qué consiguió la corrida, del informe que ella misma escribe (cobertura.json): fuentes CON DATOS (validadas o
 * descargadas; `nuevos` si algo se guardó como vigente), SIN DATOS (llegó pero no bajó nada) y CON ERROR, más los
 * reportes CM03 bajados. `titulo` dice la verdad: una corrida que terminó bien sin bajar nada no es un éxito. Pura.
 */
export function balanceCorrida(cobertura, codigo = 0) {
  const servicios = cobertura?.servicios ?? [];
  const motivo = (r) => String(r.motivo ?? r.error ?? '').slice(0, 200) || null;
  const conDatos = servicios.filter((r) => CON_DATOS.has(r.estado)).map((r) => ({ id: r.id, nombre: r.nombre, filas: r.filas ?? null,
    nuevos: (r.conservacion ?? []).some((c) => c.promovido), estado: r.estado }));
  const sinDatos = servicios.filter((r) => !CON_DATOS.has(r.estado) && !CON_ERROR.has(r.estado)).map((r) => ({ id: r.id, nombre: r.nombre, motivo: motivo(r) }));
  const errores = servicios.filter((r) => CON_ERROR.has(r.estado)).map((r) => ({ id: r.id, nombre: r.nombre, motivo: motivo(r) }));
  const cm03 = servicios.flatMap((r) => r.reportesCm03?.reportes ?? []).filter((x) => x.decision === 'bajada' && x.estado === 'valida').length;
  const conNuevos = conDatos.filter((x) => x.nuevos).length;
  const titulo = codigo !== 0 ? 'La actualización terminó con un error'
    : !cobertura ? 'La actualización terminó, pero no se encontró su informe: no se puede confirmar qué se guardó'
      : !conDatos.length && !cm03 ? `Corrida finalizada sin datos: 0 de ${servicios.length} fuentes trajeron datos. Revisá abajo por qué`
        : `Actualización terminada: ${conDatos.length} de ${servicios.length} fuentes con datos (${conNuevos} con datos nuevos guardados)${cm03 ? `, ${cm03} CM03 bajada(s)` : ''}`;
  return { titulo, total: servicios.length, conDatos, sinDatos, errores, cm03, conNuevos };
}

/** Estado de la última actualización: { corriendo, inicio, fin, codigo, lineas, balance }. */
export const estadoActualizacion = () => ({ ...estado, lineas: [...estado.lineas] });

/** Arranca la actualización. `lanzar` es inyectable (pruebas). Error si ya hay una corriendo. */
export function iniciarActualizacion({ lanzar = spawn, raiz = RAIZ, argumentos = [], leerInforme = (f) => JSON.parse(fs.readFileSync(f, 'utf8')), outDir = null, hoy = null } = {}) {
  if (estado.corriendo) throw Object.assign(new Error('ya hay una actualización en curso'), { status: 409 });
  // El mismo plan que va a seguir la corrida, para mostrar antes qué se reutiliza y qué se va a buscar.
  let plan = null;
  try { if (outDir && hoy) plan = planActualizacion(outDir, hoy); } catch { /* sin plan visible: la corrida igual lo arma */ }
  const hijo = lanzar(process.execPath, ['--env-file-if-exists=.env', path.join('src', 'cli.js'), 'portal:todo', '--visible', '--plan', ...argumentos], { cwd: raiz, windowsHide: false });
  estado = { corriendo: true, inicio: new Date().toISOString(), fin: null, codigo: null, lineas: [], balance: null, plan };
  const actual = estado;
  const agregar = (buf) => {
    for (const l of String(buf).split(/\r?\n/)) {
      if (!l.trim()) continue;
      actual.lineas.push(sanitizarTexto(l).slice(0, 400));
      if (actual.lineas.length > MAX_LINEAS) actual.lineas.splice(0, actual.lineas.length - MAX_LINEAS);
    }
  };
  hijo.stdout?.on('data', agregar); hijo.stderr?.on('data', agregar);
  const terminar = (codigo, error) => {
    if (!actual.corriendo) return;
    if (error) agregar(`No se pudo ejecutar la actualización: ${error.message}`);
    // La corrida avisa dónde guardó su informe («Corrida guardada en out/corridas/…»): de ahí sale el balance.
    const dir = [...actual.lineas].reverse().map((l) => l.match(/Corrida guardada en (.+)$/)?.[1]).find(Boolean);
    let cobertura = null;
    try { if (dir) cobertura = leerInforme(path.resolve(raiz, dir.trim(), 'cobertura.json')); } catch { /* sin informe */ }
    Object.assign(actual, { corriendo: false, fin: new Date().toISOString(), codigo: codigo ?? 1, balance: balanceCorrida(cobertura, codigo ?? 1) });
  };
  hijo.on('error', (e) => terminar(1, e));
  hijo.on('close', (codigo) => terminar(codigo));
  return estadoActualizacion();
}
