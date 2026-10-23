/**
 * Matriz de cobertura HISTÓRICA: qué fuentes y períodos están realmente cubiertos, cuáles faltan y
 * cuáles no se pueden verificar. Se arma con lo CONSERVADO (out/datos/<fuente>/vigente.json y el
 * manifiesto de Mis Comprobantes), no con la última corrida: un fallo de hoy no borra lo de ayer.
 *
 * Criterio:
 *   - Fuentes por período (filtran por fecha): un mes cuenta como cubierto solo si un rango
 *     VALIDADO lo contiene entero. Uno extraído sin verificar se muestra aparte, no tapa el hueco.
 *   - Fuentes acumuladas (muestran todo sin filtro): son una foto de lo que ARCA lista ese día.
 *     Aunque coincida con el total que informa la pantalla, NO demuestra el histórico completo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { leerVigente, leerIntentos } from './conservacion.js';

const mes = (iso) => iso.slice(0, 7);
function sumarMes(m, n = 1) {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mm - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
function ultimoDia(m) {
  const [y, mm] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
}

/** Meses ENTEROS contenidos en [desde, hasta]. */
export function mesesCompletos(desde, hasta) {
  const out = [];
  let m = desde.slice(8, 10) === '01' ? mes(desde) : sumarMes(mes(desde));
  while (ultimoDia(m) <= hasta) { out.push(m); m = sumarMes(m); }
  return out;
}

/** ['2024-01','2024-02','2024-05'] -> '2024-01 a 2024-02, 2024-05'. */
export function compactarMeses(meses) {
  const s = [...new Set(meses)].sort();
  const partes = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && sumarMes(s[j]) === s[j + 1]) j++;
    partes.push(i === j ? s[i] : `${s[i]} a ${s[j]}`);
    i = j;
  }
  return partes.join(', ');
}

/** Períodos (clave → registro) de una fuente: vigente.json, o el manifiesto propio de Mis Comprobantes. */
function periodosDe(datosDir, id) {
  const vig = leerVigente(datosDir, id);
  if (Object.keys(vig).length) return vig;
  // Mis Comprobantes guarda solo los tramos VALIDADOS en su manifiesto: "tipo:aaaa-mm-dd:aaaa-mm-dd".
  try {
    const m = JSON.parse(fs.readFileSync(path.join(datosDir, id, 'manifiesto.json'), 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(m)) {
      const [, d, h] = k.split(':');
      if (d && h && v?.ok) out[`${d}_${h}`] = { cuando: v.fecha, rango: 3, estado: 'validado', filas: v.filas ?? 0, informados: v.informados ?? null, desde: d, hasta: h, acumulado: false };
    }
    return out;
  } catch { return {}; }
}

/**
 * Arma la matriz. `fuentes`: [{ id, nombre }] (los listados de SIFERE van como fuentes propias).
 * `hoy` (aaaa-mm-dd) define el último mes completo; `historicoDesde` (aaaa-mm), si se da, define
 * desde cuándo se exige cobertura. Sin él, los faltantes se cuentan desde el primer mes cubierto.
 */
export function generarMatrizCobertura(datosDir, fuentes, { hoy = new Date().toISOString().slice(0, 10), historicoDesde = null } = {}) {
  const ultimoMes = sumarMes(mes(hoy), -1);
  const filas = [];
  for (const f of fuentes) {
    const per = periodosDe(datosDir, f.id);
    const intentos = leerIntentos(datosDir, f.id);
    const ult = intentos.at(-1) ?? null;
    const regs = Object.entries(per).map(([clave, r]) => ({ clave, ...r }));
    const acum = regs.find((r) => r.clave === 'acumulado') ?? null;
    const porPeriodo = regs.filter((r) => r.clave !== 'acumulado');
    const validados = porPeriodo.filter((r) => (r.rango ?? 0) >= 3);
    const sinVerificar = porPeriodo.filter((r) => (r.rango ?? 0) < 3);
    const mesesVal = validados.flatMap((r) => mesesCompletos(r.desde, r.hasta));
    const mesesSinVer = sinVerificar.flatMap((r) => mesesCompletos(r.desde, r.hasta)).filter((m) => !mesesVal.includes(m));

    let faltantes = null;
    const inicio = historicoDesde ?? [...mesesVal].sort()[0] ?? null;
    if (porPeriodo.length || historicoDesde) {
      faltantes = [];
      if (inicio) for (let m = inicio; m <= ultimoMes; m = sumarMes(m)) if (!mesesVal.includes(m)) faltantes.push(m);
    }

    const tipo = porPeriodo.length ? 'por-periodo' : acum ? 'acumulado' : 'sin-datos';
    let nota;
    if (tipo === 'acumulado') {
      const tot = acum.informados == null ? 'ARCA no informó un total' : acum.informados === acum.filas ? `coincide con el total informado (${acum.informados})` : `NO coincide con el total informado (${acum.filas} ≠ ${acum.informados})`;
      nota = `foto del ${acum.cuando}: ${acum.filas} registros, ${tot}. Muestra lo que ARCA lista ese día; no demuestra el histórico completo.`;
    } else if (tipo === 'sin-datos') {
      nota = ult ? `sin datos conservados; último intento ${ult.cuando}: ${ult.error ?? ult.motivo ?? ult.estado}` : 'sin intentos registrados';
    } else {
      nota = historicoDesde ? `cobertura exigida desde ${historicoDesde}` : 'sin FISCALOS_HISTORICO_DESDE: los faltantes se cuentan desde el primer mes validado';
    }
    filas.push({
      id: f.id, nombre: f.nombre, tipo,
      mesesValidados: compactarMeses(mesesVal), mesesSinVerificar: compactarMeses(mesesSinVer),
      faltantes: faltantes == null ? null : compactarMeses(faltantes), cantidadFaltantes: faltantes?.length ?? null,
      acumulado: acum ? { cuando: acum.cuando, estado: acum.estado, filas: acum.filas, informados: acum.informados, rango: acum.rango } : null,
      ultimoIntento: ult ? { cuando: ult.cuando, clave: ult.clave ?? null, estado: ult.estado, filas: ult.filas, promovido: ult.promovido, error: ult.error ?? null } : null,
      nota,
    });
  }
  const md = ['# Cobertura histórica FiscalOS', '',
    `Generada ${hoy}. Último mes completo: ${ultimoMes}.${historicoDesde ? ` Cobertura exigida desde ${historicoDesde}.` : ''}`,
    'Se arma con lo conservado (`out/datos/*/vigente.json`), no solo con la última corrida.', '',
    '| Fuente | Tipo | Meses validados | Obtenido sin verificar | Faltan / no verificable | Último intento |', '|---|---|---|---|---|---|'];
  for (const r of filas) {
    const falta = r.tipo === 'acumulado' ? 'no verificable por período' : r.tipo === 'sin-datos' ? 'todo' : (r.faltantes || '—');
    const sinVer = r.tipo === 'acumulado' ? `${r.acumulado.filas} registros (foto ${r.acumulado.cuando})` : (r.mesesSinVerificar || '—');
    const u = r.ultimoIntento;
    const ult = u ? `${u.cuando} · ${u.estado ?? '?'}${u.promovido ? ' (vigente)' : u.error ? ' (falló, no reemplazó)' : u.clave ? ' (no reemplazó)' : ''}` : '—';
    md.push(`| ${r.nombre} (${r.id}) | ${r.tipo} | ${r.mesesValidados || '—'} | ${sinVer} | ${falta} | ${ult} |`);
  }
  md.push('', '## Notas');
  for (const r of filas) md.push(`- **${r.id}**: ${r.nota}`);
  return { objeto: { hoy, ultimoMes, historicoDesde, fuentes: filas }, texto: md.join('\n') };
}
