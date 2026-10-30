/**
 * Impuesto a las Ganancias, personas humanas: escala progresiva del art. 94 y
 * deducciones personales del art. 30, con los valores oficiales de params/ganancias.json.
 *
 * Calibrado contra la DDJJ 2025 presentada (F.2711): reproduce el impuesto determinado al centavo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PARAMS = JSON.parse(fs.readFileSync(path.join(here, '..', 'params', 'ganancias.json'), 'utf8'));

const r2 = (x) => Math.round(x * 100) / 100;

export function escala(anio) {
  const p = PARAMS[String(anio)];
  if (!p) throw new Error(`No hay escala de Ganancias cargada para ${anio}. Agregarla en params/ganancias.json.`);
  return p;
}

/** Impuesto determinado sobre la ganancia neta sujeta a impuesto. */
export function impuesto(anio, gananciaNetaSujeta) {
  if (gananciaNetaSujeta <= 0) return 0;
  const tramo = escala(anio).escala.find((t) => t.hasta === null || gananciaNetaSujeta <= t.hasta);
  return r2(tramo.fijo + (gananciaNetaSujeta - tramo.desde) * tramo.alicuota);
}

/** Alícuota marginal: cuánto de cada peso adicional se va en impuesto. */
export function alicuotaMarginal(anio, gananciaNetaSujeta) {
  if (gananciaNetaSujeta <= 0) return 0;
  return escala(anio).escala.find((t) => t.hasta === null || gananciaNetaSujeta <= t.hasta).alicuota;
}

/** Deducciones personales anuales según el perfil del contribuyente. */
export function deduccionesPersonales(anio, contribuyente = {}) {
  const d = escala(anio).deducciones;
  const especial = contribuyente.deduccionEspecial === 'nuevos'
    ? d.deduccionEspecialAp1NuevosProfesionales
    : d.deduccionEspecialAp1;
  const cf = contribuyente.cargasFamilia ?? {};
  return r2(d.gananciaNoImponible + especial + (cf.conyuge ? d.conyuge : 0) + (cf.hijos ?? 0) * d.hijo);
}

/**
 * Liquidación anual simplificada, misma estructura que el F.2711:
 * resultado neto − deducciones generales − deducciones personales → impuesto.
 */
export function liquidacionAnual(anio, { resultadoNeto, deduccionesGenerales = 0, dividendos = 0, pagosACuenta = 0 }, contribuyente = {}) {
  const personales = deduccionesPersonales(anio, contribuyente);
  const gananciaNetaSujeta = r2(Math.max(0, resultadoNeto - deduccionesGenerales - personales));
  const impEscala = impuesto(anio, gananciaNetaSujeta);
  const impDividendos = r2(dividendos * PARAMS.alicuotaDividendos);
  const impuestoDeterminado = r2(impEscala + impDividendos);
  return {
    anio,
    resultadoNeto: r2(resultadoNeto),
    deduccionesGenerales: r2(deduccionesGenerales),
    deduccionesPersonales: personales,
    gananciaNetaSujeta,
    impuestoEscala: impEscala,
    impuestoDividendos: impDividendos,
    impuestoDeterminado,
    alicuotaMarginal: alicuotaMarginal(anio, gananciaNetaSujeta),
    tasaEfectiva: resultadoNeto > 0 ? r2((impuestoDeterminado / resultadoNeto) * 100) : 0,
    pagosACuenta: r2(pagosACuenta),
    saldo: r2(impuestoDeterminado - pagosACuenta),
  };
}

/**
 * Provisión mensual. Recibe los meses cerrados del año (resultado neto de cada uno) y
 * proyecta el año completo a ritmo actual (run-rate). Como la escala es progresiva, la
 * provisión acumulada se recalcula cada mes sobre la proyección: la de cada mes es la
 * diferencia con la acumulada del mes anterior.
 */
export function provisionMensual(anio, meses, contribuyente = {}, { deduccionesGenerales = 0, proyeccionAnual = null } = {}) {
  const out = [];
  let acumulado = 0;
  let provisionPrev = 0;
  meses.forEach((neto, i) => {
    const n = i + 1;
    acumulado += neto;
    const proyectado = proyeccionAnual ?? (acumulado / n) * 12;
    const liq = liquidacionAnual(anio, { resultadoNeto: proyectado, deduccionesGenerales }, contribuyente);
    const provisionAcum = proyectado > 0 ? r2(liq.impuestoDeterminado * (acumulado / proyectado)) : 0;
    const provision = r2(provisionAcum - provisionPrev);
    provisionPrev = provisionAcum;
    out.push({
      mes: n,
      resultadoNeto: r2(neto),
      acumulado: r2(acumulado),
      proyeccionAnual: r2(proyectado),
      impuestoAnualProyectado: liq.impuestoDeterminado,
      tasaEfectiva: liq.tasaEfectiva,
      alicuotaMarginal: liq.alicuotaMarginal,
      provisionMes: provision,
      provisionAcumulada: provisionAcum,
    });
  });
  return out;
}
