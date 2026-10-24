/**
 * Matriz de cobertura HISTÓRICA: qué fuentes y períodos están realmente cubiertos, cuáles faltan y
 * cuáles no se pueden verificar. Se arma con lo CONSERVADO (out/datos/<fuente>/vigente.json y el
 * manifiesto de Mis Comprobantes), no con la última corrida: un fallo de hoy no borra lo de ayer.
 *
 * Criterio:
 *   - Fuentes por período (filtran por fecha): un mes cuenta como cubierto solo si un rango
 *     VALIDADO (vigente) lo contiene entero; "apto" si además se cotejó con el total de ARCA. Lo
 *     leído sin validar (evidencia, en intentos.jsonl) se muestra aparte y NO tapa el hueco.
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
      if (d && h && v?.ok) out[`${d}_${h}`] = { cuando: v.fecha, rango: 3, nivel: 'apto', estado: 'validado', filas: v.filas ?? 0, informados: v.informados ?? null, desde: d, hasta: h, acumulado: false };
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
  const rangoDeClave = (c) => { const [d, h] = String(c ?? '').split('_'); return /^\d{4}-\d{2}-\d{2}$/.test(d ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(h ?? '') ? [d, h] : null; };
  for (const f of fuentes) {
    const per = periodosDe(datosDir, f.id);
    const intentos = leerIntentos(datosDir, f.id);
    const ult = intentos.at(-1) ?? null;
    // Vigente = solo lo validado (rango ≥ 2); los niveles vienen de calidad.js vía conservacion.js.
    const regs = Object.entries(per).map(([clave, r]) => ({ clave, ...r })).filter((r) => (r.rango ?? 0) >= 2);
    const acum = regs.find((r) => r.clave === 'acumulado') ?? null;
    const porPeriodo = regs.filter((r) => r.clave !== 'acumulado');
    const mesesVal = porPeriodo.flatMap((r) => mesesCompletos(r.desde, r.hasta));
    const mesesApto = porPeriodo.filter((r) => r.rango >= 3).flatMap((r) => mesesCompletos(r.desde, r.hasta));
    // Evidencia: intentos con filas que NO llegaron a validarse. Se muestran, pero no tapan huecos.
    const evid = intentos.filter((i) => (i.filas ?? 0) > 0 && (i.rango ?? 0) < 2);
    const mesesEvid = evid.map((i) => rangoDeClave(i.clave)).filter(Boolean).flatMap(([d, h]) => mesesCompletos(d, h)).filter((m) => !mesesVal.includes(m));
    const evidAcum = evid.filter((i) => i.clave === 'acumulado').at(-1) ?? null;

    let faltantes = null;
    const hayPeriodos = porPeriodo.length || mesesEvid.length;
    const inicio = historicoDesde ?? [...mesesVal, ...mesesEvid].sort()[0] ?? null;
    if (hayPeriodos || historicoDesde) {
      faltantes = [];
      if (inicio) for (let m = inicio; m <= ultimoMes; m = sumarMes(m)) if (!mesesVal.includes(m)) faltantes.push(m);
    }

    const tipo = hayPeriodos ? 'por-periodo' : (acum || evidAcum) ? 'acumulado' : 'sin-datos';
    let nota;
    if (tipo === 'acumulado' && acum) {
      const tot = acum.rango >= 3 ? `cantidad cotejada con el total de ARCA (${acum.informados})` : 'sin total de ARCA en el paginador para cotejar la cantidad';
      nota = `foto del ${acum.cuando}: ${acum.filas} registros validados, ${tot}. Muestra lo que ARCA lista ese día; no demuestra el histórico completo.`;
    } else if (tipo === 'acumulado') {
      nota = `solo evidencia: el ${evidAcum.cuando} se leyeron ${evidAcum.filas} filas que NO se validaron (${evidAcum.motivo ?? evidAcum.conservacion ?? evidAcum.nivel ?? 'sin detalle'}). No hay datos utilizables.`;
    } else if (tipo === 'sin-datos') {
      nota = ult ? `sin datos conservados; último intento ${ult.cuando}: ${ult.error ?? ult.motivo ?? ult.estado}` : 'sin intentos registrados';
    } else {
      nota = historicoDesde ? `cobertura exigida desde ${historicoDesde}` : 'sin FISCALOS_HISTORICO_DESDE: los faltantes se cuentan desde el primer mes con datos';
    }
    // Reducciones sin confirmar: el vigente se conservó y el intento nuevo espera revisión.
    const pendientes = regs.filter((r) => r.pendienteRevision).map((r) => ({ clave: r.clave, vigente: r.filas, ...r.pendienteRevision }));
    if (pendientes.length) {
      nota += ` ⚠ Pendiente de revisión: ${pendientes.map((p) => `${p.clave}: el intento ${p.cuando} trajo ${p.filas} filas y el vigente tiene ${p.vigente} (no se reemplazó)`).join('; ')}.`;
    }
    filas.push({
      id: f.id, nombre: f.nombre, tipo, pendientesRevision: pendientes,
      mesesAptos: compactarMeses(mesesApto), mesesValidados: compactarMeses(mesesVal), mesesEvidencia: compactarMeses(mesesEvid),
      faltantes: faltantes == null ? null : compactarMeses(faltantes), cantidadFaltantes: faltantes?.length ?? null,
      acumulado: acum ? { cuando: acum.cuando, nivel: acum.nivel ?? null, filas: acum.filas, informados: acum.informados, rango: acum.rango } : null,
      evidenciaAcumulada: evidAcum ? { cuando: evidAcum.cuando, filas: evidAcum.filas, nivel: evidAcum.nivel ?? null } : null,
      ultimoIntento: ult ? { cuando: ult.cuando, clave: ult.clave ?? null, estado: ult.estado, nivel: ult.nivel ?? null, filas: ult.filas, promovido: ult.promovido, error: ult.error ?? null } : null,
      nota,
    });
  }
  const md = ['# Cobertura histórica FiscalOS', '',
    `Generada ${hoy}. Último mes completo: ${ultimoMes}.${historicoDesde ? ` Cobertura exigida desde ${historicoDesde}.` : ''}`,
    'Se arma con lo conservado (`out/datos/*/vigente.json` e `intentos.jsonl`), no solo con la última corrida.',
    'Niveles: **apto** = validado y cotejado con el total de ARCA (usable en cálculos); **validado** = controles OK pero sin total para cotejar; **evidencia** = se leyó, no se validó (no se usa).', '',
    '| Fuente | Tipo | Aptos para cálculo | Validados | Evidencia sin validar | Faltan / no verificable | Último intento |', '|---|---|---|---|---|---|---|'];
  const celda = (x) => String(x ?? '—').replace(/\|/g, '/');
  for (const r of filas) {
    const falta = r.tipo === 'acumulado' ? 'no verificable por período' : r.tipo === 'sin-datos' ? 'todo' : (r.faltantes || '—');
    const aptos = r.tipo === 'acumulado' ? (r.acumulado?.rango >= 3 ? `${r.acumulado.filas} registros (foto ${r.acumulado.cuando})` : '—') : (r.mesesAptos || '—');
    const val = r.tipo === 'acumulado' ? (r.acumulado ? `${r.acumulado.filas} registros (foto ${r.acumulado.cuando})` : '—') : (r.mesesValidados || '—');
    const ev = r.tipo === 'acumulado' ? (r.evidenciaAcumulada && !r.acumulado ? `${r.evidenciaAcumulada.filas} filas (${r.evidenciaAcumulada.cuando})` : '—') : (r.mesesEvidencia || '—');
    const u = r.ultimoIntento;
    const ult = u ? `${u.cuando} · ${u.nivel ?? u.estado ?? '?'}${u.promovido ? ' (vigente)' : u.error ? ' (falló)' : ' (no promovido)'}` : '—';
    md.push(`| ${celda(`${r.nombre} (${r.id})`)} | ${r.tipo} | ${celda(aptos)} | ${celda(val)} | ${celda(ev)} | ${celda(falta)} | ${celda(ult)} |`);
  }
  md.push('', '## Notas');
  for (const r of filas) md.push(`- **${r.id}**: ${r.nota}`);
  return { objeto: { hoy, ultimoMes, historicoDesde, fuentes: filas }, texto: md.join('\n') };
}
