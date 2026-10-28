/**
 * Pagos de impuestos: período fiscal ≠ fecha de pago, y nunca el mismo pago dos veces.
 *  - Un pago cargado a mano lleva el PERÍODO al que corresponde (`mes` de la carga) y su FECHA DE PAGO (`fechaPago`). El
 *    período descuenta la obligación de ese período; la fecha lo ubica en la caja del mes en que salió. El CM03 de
 *    septiembre pagado el 20/10 baja la obligación de septiembre y sale de la caja de octubre.
 *  - Cargas viejas sin fecha de pago: cuentan contra su período, pero no se ubican en ninguna caja (se avisan).
 *  - Archivos importados de pagos: su mes es el de la fecha de cada fila (fecha de pago); se ubican en esa caja y no
 *    descuentan una obligación (el período no se conoce).
 *  - Conciliación con lo verificado (Cuentas Tributarias, volantes de SIFERE pagados): un pago cargado que coincide con
 *    uno verificado (mismo impuesto, mismo período, mismo importe ±1 y fechas a 5 días o sin fecha) es un DUPLICADO y no
 *    se suma. Si coincide en todo pero el período de alguno no se conoce, queda SIN CONCILIAR y no se suma. Uno sin fecha
 *    de un impuesto que ya tiene pagos verificados del mismo período es INCIERTO: tampoco se suma. Los demás (también el
 *    mismo importe el mismo día para otro período) son pagos distintos y se suman.
 */
import { listarManuales } from './manuales.js';
import { listarImportaciones, CONCEPTOS } from './importar.js';

const r2 = (x) => Math.round(x * 100) / 100;

/** Conceptos de pago cargables y a qué impuesto (clave de clasificarImpuesto) corresponden. */
export const CONCEPTOS_PAGO = {
  'iibb-pagado': { clave: 'iibb', nombre: 'Ingresos Brutos', propio: true },
  'ganancias-anticipo': { clave: 'ganancias', nombre: 'Ganancias', propio: true },
  autonomos: { clave: 'autonomos', nombre: 'Autónomos', propio: true },
  'f931-pagado': { clave: 'empleador', nombre: 'Seguridad social (empleador)', propio: 'empleador' },
  'sicore-pagado': { clave: 'agente', nombre: 'Retenciones/percepciones como agente', propio: false },
};

const dias = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
const desdeCarga = (c, nivel = 'manual') => ({ id: c.id, concepto: c.concepto, clave: CONCEPTOS_PAGO[c.concepto].clave, impuesto: CONCEPTOS_PAGO[c.concepto].nombre,
  propio: CONCEPTOS_PAGO[c.concepto].propio, fecha: c.fechaPago ?? null, periodo: c.mes, importe: Math.abs(Number(c.importe) || 0), nivel,
  fuente: c.fuente ? `carga manual: ${c.fuente}` : 'carga manual', comprobante: c.comprobante ?? null });

/** Pagos cargados a mano con fecha de pago en `mesCaja`, y filas de archivos importados de pagos de ese mes. */
export function pagosCargadosEnCaja(outDir, mesCaja) {
  const out = listarManuales(outDir).filter((c) => CONCEPTOS_PAGO[c.concepto] && String(c.fechaPago ?? '').slice(0, 7) === mesCaja).map((c) => desdeCarga(c));
  for (const imp of listarImportaciones(outDir)) {
    const m = imp.porMes?.[mesCaja];
    if (!m || !CONCEPTOS_PAGO[imp.concepto]) continue;
    out.push({ id: imp.id, concepto: imp.concepto, clave: CONCEPTOS_PAGO[imp.concepto].clave, impuesto: CONCEPTOS_PAGO[imp.concepto].nombre, propio: CONCEPTOS_PAGO[imp.concepto].propio,
      fecha: null, mesPago: mesCaja, periodo: null, importe: Math.abs(m.importe), nivel: 'importado', fuente: `archivo importado: ${imp.archivo}` });
  }
  return out;
}

/** Pagos cargados a mano para el PERÍODO (descuentan su obligación), tengan o no fecha de pago. */
export const pagosCargadosDelPeriodo = (outDir, periodo, concepto) => listarManuales(outDir).filter((c) => c.concepto === concepto && c.mes === periodo).map((c) => desdeCarga(c));

/** Cargas viejas de pagos sin fecha de pago (no se ubican en la caja de ningún mes). */
export const pagosSinFecha = (outDir) => listarManuales(outDir).filter((c) => CONCEPTOS_PAGO[c.concepto] && !c.fechaPago).map((c) => desdeCarga(c));

/**
 * ¿Dos pagos corresponden al mismo período? Pura. 'igual', 'distinto' o 'desconocido'. Los períodos son 'AAAA-MM'
 * (mensual) o 'AAAA' (anual: Ganancias en Cuentas Tributarias). Dos mensuales o dos anuales se comparan enteros; uno
 * anual con uno mensual, por el año, y si el año no coincide no se sabe (un anticipo de Ganancias se paga en el año
 * siguiente al del período). Sin período en alguno de los dos, tampoco se sabe.
 */
export function mismoPeriodo(a, b) {
  if (!a || !b) return 'desconocido';
  const anualA = /^\d{4}$/.test(a); const anualB = /^\d{4}$/.test(b);
  if (anualA === anualB) return a === b ? 'igual' : 'distinto';
  return a.slice(0, 4) === b.slice(0, 4) ? 'igual' : 'desconocido';
}

/**
 * Concilia pagos verificados ({ clave, importe, fecha?, periodo? }) con cargados. Devuelve { computados, duplicados,
 * inciertos } con cada cargado marcado: computados = verificados + cargados distintos; los otros no se suman.
 *  - duplicado: mismo impuesto, mismo importe (±1), mismo período y fechas a 5 días (o sin fecha en alguno).
 *  - sin conciliar (en inciertos): coincide en impuesto, importe y fecha con uno verificado, pero el período de alguno
 *    no se conoce (o no se puede comparar): puede ser el mismo pago; no se suma hasta aclararlo.
 *  - incierto: sin fecha de pago, y hay pagos verificados del mismo impuesto que pueden ser del mismo período.
 *  - distinto: todo lo demás, también el mismo importe el mismo día para OTRO período (septiembre y octubre).
 */
export function conciliarPagos(verificados, cargados) {
  const computados = [...verificados]; const duplicados = []; const inciertos = [];
  const usados = new Set();
  for (const c of cargados) {
    const mismos = verificados.filter((v) => v.clave === c.clave);
    const coincide = (v) => !usados.has(v) && Math.abs((v.importe ?? 0) - c.importe) <= 1 && (!c.fecha || !v.fecha || dias(c.fecha, v.fecha) <= 5);
    const dup = mismos.find((v) => coincide(v) && mismoPeriodo(c.periodo, v.periodo) === 'igual');
    if (dup) { usados.add(dup); duplicados.push({ ...c, estadoConciliacion: 'duplicado', nota: `coincide con un pago verificado (${dup.fuente ?? 'ARCA'}${dup.fecha ? `, ${dup.fecha}` : ''}): no se suma` }); continue; }
    const dudoso = mismos.find((v) => coincide(v) && mismoPeriodo(c.periodo, v.periodo) === 'desconocido');
    if (dudoso) {
      inciertos.push({ ...c, estadoConciliacion: 'sin conciliar', nota: `mismo importe y fecha que un pago verificado (${dudoso.fuente ?? 'ARCA'}${dudoso.fecha ? `, ${dudoso.fecha}` : ''}), pero no se puede saber si es del mismo período: no se suma hasta aclararlo (revisá el período del pago)` });
      continue;
    }
    if (!c.fecha && mismos.some((v) => mismoPeriodo(c.periodo, v.periodo) !== 'distinto')) {
      inciertos.push({ ...c, estadoConciliacion: 'incierto', nota: 'sin fecha de pago y hay pagos verificados del mismo impuesto: puede ser el mismo; no se suma hasta aclararlo (cargale la fecha de pago)' });
      continue;
    }
    computados.push({ ...c, estadoConciliacion: 'distinto' });
  }
  return { computados, duplicados, inciertos, total: r2(computados.reduce((n, x) => n + (x.importe ?? 0), 0)) };
}

/** Nombre del concepto (para avisos). */
export const nombrePago = (concepto) => CONCEPTOS[concepto]?.nombre ?? concepto;
