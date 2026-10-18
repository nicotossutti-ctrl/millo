/**
 * Estimación mensual de "cuánto gano de verdad": resultado del mes menos los impuestos
 * que ese mes devenga aunque se paguen después (Ingresos Brutos, autónomos, Ganancias).
 */
import fs from 'node:fs';
import path from 'node:path';
import { provisionMensual } from './ganancias.js';
import { toCsv } from './csv.js';

const r2 = (x) => Math.round(x * 100) / 100;

export function cargarContribuyente(file = 'params/contribuyente.json') {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) {
    throw new Error(`Falta ${file}. Copiá params/contribuyente.example.json y completalo con los datos del contador.`);
  }
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  const avisos = [];
  const sumaCoef = (c.ingresosBrutos ?? []).reduce((s, j) => s + j.coeficiente, 0);
  if (!c.ingresosBrutos?.length) avisos.push('Sin jurisdicciones de Ingresos Brutos: la provisión de IIBB va a dar 0.');
  else if (Math.abs(sumaCoef - 1) > 0.001) avisos.push(`Los coeficientes de Convenio suman ${sumaCoef}, deberían sumar 1.`);
  if (!c.autonomosMensual) avisos.push('autonomosMensual en 0: no se descuenta la cuota de autónomos.');
  if (!c.deduccionesGeneralesAnuales) avisos.push('deduccionesGeneralesAnuales en 0: Ganancias queda levemente sobreestimado.');
  return { contribuyente: c, avisos };
}

/** Alícuota efectiva de IIBB sobre ventas netas, ponderada por coeficiente de Convenio. */
export function alicuotaIIBB(contribuyente) {
  return (contribuyente.ingresosBrutos ?? []).reduce((s, j) => s + j.coeficiente * j.alicuota, 0);
}

/**
 * meses: [{ mes: 'AAAA-MM', ventasNetas, gastosNetos }] del mismo año, en orden.
 */
export function estimar(anio, meses, contribuyente, { proyeccionAnual = null } = {}) {
  const iibb = alicuotaIIBB(contribuyente);
  const autonomos = contribuyente.autonomosMensual ?? 0;

  const base = meses.map((m) => {
    const resultadoBruto = m.ventasNetas - m.gastosNetos;
    const iibbMes = r2(m.ventasNetas * iibb);
    return { ...m, resultadoBruto: r2(resultadoBruto), iibb: iibbMes, autonomos, antesGanancias: r2(resultadoBruto - iibbMes - autonomos) };
  });

  // Para Ganancias, IIBB y autónomos son gasto deducible: se proyecta sobre el resultado neto de ellos.
  const prov = provisionMensual(anio, base.map((m) => m.antesGanancias), contribuyente, {
    deduccionesGenerales: contribuyente.deduccionesGeneralesAnuales ?? 0,
    proyeccionAnual,
  });

  return base.map((m, i) => {
    const g = prov[i];
    const gananciaReal = r2(m.antesGanancias - g.provisionMes);
    const impuestos = r2(m.iibb + m.autonomos + g.provisionMes);
    return {
      ...m,
      ganancias: g.provisionMes,
      gananciasAcumulada: g.provisionAcumulada,
      impuestosMes: impuestos,
      gananciaReal,
      cargaTributaria: m.resultadoBruto > 0 ? r2((impuestos / m.resultadoBruto) * 100) : 0,
      proyeccionAnual: g.proyeccionAnual,
      impuestoAnualProyectado: g.impuestoAnualProyectado,
      alicuotaMarginal: g.alicuotaMarginal,
    };
  });
}

export const COLUMNAS_ESTIMACION = [
  { header: 'Mes', value: (r) => r.mes },
  { header: 'Ventas netas', value: (r) => r.ventasNetas },
  { header: 'Gastos netos', value: (r) => r.gastosNetos },
  { header: 'Resultado bruto', value: (r) => r.resultadoBruto },
  { header: 'IIBB', value: (r) => r.iibb },
  { header: 'Autónomos', value: (r) => r.autonomos },
  { header: 'Provisión Ganancias', value: (r) => r.ganancias },
  { header: 'Impuestos del mes', value: (r) => r.impuestosMes },
  { header: 'Ganancia real', value: (r) => r.gananciaReal },
  { header: 'Carga tributaria %', value: (r) => r.cargaTributaria },
  { header: 'Ganancias acumulada', value: (r) => r.gananciasAcumulada },
  { header: 'Proyección anual neta', value: (r) => r.proyeccionAnual },
  { header: 'Ganancias anual proyectado', value: (r) => r.impuestoAnualProyectado },
  { header: 'Alícuota marginal', value: (r) => r.alicuotaMarginal },
];

/** Lee out/meses.csv: Mes;Ventas netas;Gastos netos (coma o punto decimal). */
export function leerMeses(file) {
  const num = (s) => Number(String(s).replace(/\./g, '').replace(',', '.')) || 0;
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const sep = lines[0].includes(';') ? ';' : ',';
  return lines.slice(1).map((l) => {
    const [mes, v, g] = l.split(sep);
    return { mes: mes.trim(), ventasNetas: num(v), gastosNetos: num(g ?? 0) };
  });
}

export function escribirEstimacion(rows, file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, toCsv(rows, COLUMNAS_ESTIMACION));
  return path.resolve(file);
}
