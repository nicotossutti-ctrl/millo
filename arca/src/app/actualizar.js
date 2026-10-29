/**
 * «Actualizar datos fiscales» desde la app: lanza la misma corrida que `fiscalos.ps1 correr` (portal:todo, con el
 * navegador visible, todas las fuentes de IVA, IIBB y Ganancias) como proceso aparte, y guarda su avance para mostrarlo.
 * Una sola a la vez. Solo lectura en ARCA y SIFERE; lo que se baja queda en out/ y nunca borra lo guardado antes.
 * Si ARCA o COMARB piden la clave fiscal, se escribe en la ventana del navegador (FiscalOS nunca la tipea).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizarTexto } from '../portal/diagnostico.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_LINEAS = 400;
let estado = { corriendo: false, inicio: null, fin: null, codigo: null, lineas: [] };

/** Estado de la última actualización: { corriendo, inicio, fin, codigo, lineas }. */
export const estadoActualizacion = () => ({ ...estado, lineas: [...estado.lineas] });

/** Arranca la actualización. `lanzar` es inyectable (pruebas). Error si ya hay una corriendo. */
export function iniciarActualizacion({ lanzar = spawn, raiz = RAIZ, argumentos = [] } = {}) {
  if (estado.corriendo) throw Object.assign(new Error('ya hay una actualización en curso'), { status: 409 });
  const hijo = lanzar(process.execPath, ['--env-file-if-exists=.env', path.join('src', 'cli.js'), 'portal:todo', '--visible', ...argumentos], { cwd: raiz, windowsHide: false });
  estado = { corriendo: true, inicio: new Date().toISOString(), fin: null, codigo: null, lineas: [] };
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
    Object.assign(actual, { corriendo: false, fin: new Date().toISOString(), codigo: codigo ?? 1 });
  };
  hijo.on('error', (e) => terminar(1, e));
  hijo.on('close', (codigo) => terminar(codigo));
  return estadoActualizacion();
}
