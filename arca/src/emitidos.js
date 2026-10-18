/**
 * Reconstruye los comprobantes emitidos en un rango de fechas.
 * WSFE no lista por fecha: solo da el último número autorizado y consulta de a uno.
 * Como la numeración es correlativa en el tiempo, recorremos desde el último hacia
 * atrás y cortamos al pasar la fecha "desde". Cada comprobante se cachea en disco
 * para que una segunda corrida no vuelva a pegarle a ARCA.
 */
import fs from 'node:fs';
import path from 'node:path';
import { toCsv, fechaArca } from './csv.js';

// Tipos que emite un monotributista: Factura C, ND C, NC C, Recibo C.
export const TIPOS_C = [11, 12, 13, 15];

/** Notas de crédito: restan en la conciliación. */
export const TIPOS_NC = [3, 8, 13, 21, 53, 203, 208, 213];
export const signo = (tipo) => (TIPOS_NC.includes(tipo) ? -1 : 1);

export const TIPO_DESC = {
  1: 'Factura A', 2: 'Nota de Débito A', 3: 'Nota de Crédito A', 4: 'Recibo A',
  6: 'Factura B', 7: 'Nota de Débito B', 8: 'Nota de Crédito B', 9: 'Recibo B',
  11: 'Factura C', 12: 'Nota de Débito C', 13: 'Nota de Crédito C', 15: 'Recibo C',
  19: 'Factura E', 20: 'Nota de Débito E', 21: 'Nota de Crédito E',
  51: 'Factura M', 52: 'Nota de Débito M', 53: 'Nota de Crédito M',
  201: 'FCE A', 202: 'ND FCE A', 203: 'NC FCE A',
  206: 'FCE B', 207: 'ND FCE B', 208: 'NC FCE B',
  211: 'FCE C', 212: 'ND FCE C', 213: 'NC FCE C',
};

const ymd = (iso) => iso.replace(/-/g, '');

function cacheFile(cfg, ptoVta, tipo, nro) {
  return path.join(cfg.outDir, 'cache', cfg.env, `${ptoVta}-${tipo}-${nro}.json`);
}

async function consultarCached(wsfe, cfg, ptoVta, tipo, nro) {
  const f = cacheFile(cfg, ptoVta, tipo, nro);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const c = await wsfe.consultar(ptoVta, tipo, nro);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(c));
  return c;
}

export async function exportarEmitidos(wsfe, cfg, { desde, hasta, tipos, ptos, log = () => {} }) {
  const d = ymd(desde);
  const h = ymd(hasta);
  const puntos = ptos?.length ? ptos : (await wsfe.ptosVenta()).filter((p) => !p.bloqueado).map((p) => p.nro);
  if (!puntos.length) throw new Error('No hay puntos de venta habilitados para web services.');

  const rows = [];
  for (const pto of puntos) {
    for (const tipo of tipos) {
      const ultimo = await wsfe.ultimoAutorizado(pto, tipo);
      log(`PV ${pto} tipo ${tipo} (${TIPO_DESC[tipo] ?? '?'}): último autorizado ${ultimo}`);
      let fuera = 0;
      for (let nro = ultimo; nro >= 1; nro--) {
        const c = await consultarCached(wsfe, cfg, pto, tipo, nro);
        if (!c) continue;
        if (c.cbteFch < d) {
          // numeración correlativa: ya pasamos el rango. Toleramos algún desorden.
          if (++fuera > 3) break;
          continue;
        }
        fuera = 0;
        if (c.cbteFch > h) continue;
        rows.push(c);
      }
    }
  }

  rows.sort((a, b) => a.cbteFch.localeCompare(b.cbteFch) || a.ptoVta - b.ptoVta || a.cbteTipo - b.cbteTipo || a.cbteDesde - b.cbteDesde);
  return rows;
}

export const COLUMNAS_EMITIDOS = [
  { header: 'Fecha', value: (r) => fechaArca(r.cbteFch) },
  { header: 'Tipo', value: (r) => r.cbteTipo },
  { header: 'Comprobante', value: (r) => TIPO_DESC[r.cbteTipo] ?? '' },
  { header: 'Punto de Venta', value: (r) => String(r.ptoVta).padStart(5, '0') },
  { header: 'Número', value: (r) => String(r.cbteDesde).padStart(8, '0') },
  { header: 'CAE', value: (r) => r.codAutorizacion },
  { header: 'Vto CAE', value: (r) => fechaArca(r.fchVto) },
  { header: 'Tipo Doc Receptor', value: (r) => r.docTipo },
  { header: 'Nro Doc Receptor', value: (r) => r.docNro },
  { header: 'Concepto', value: (r) => ({ 1: 'Productos', 2: 'Servicios', 3: 'Productos y Servicios' })[r.concepto] ?? r.concepto },
  { header: 'Moneda', value: (r) => r.monId },
  { header: 'Cotización', value: (r) => r.monCotiz },
  { header: 'Neto Gravado', value: (r) => r.impNeto },
  { header: 'No Gravado', value: (r) => r.impTotConc },
  { header: 'Exento', value: (r) => r.impOpEx },
  { header: 'IVA', value: (r) => r.impIva },
  { header: 'Otros Tributos', value: (r) => r.impTrib },
  { header: 'Total', value: (r) => r.impTotal },
  { header: 'Signo', value: (r) => signo(r.cbteTipo) },
  { header: 'Asociados', value: (r) => r.cbtesAsoc.map((a) => `${a.tipo}-${a.ptoVta}-${a.nro}`).join(' ') },
  { header: 'Resultado', value: (r) => r.resultado },
];

export function escribirCsv(cfg, rows, file) {
  const out = path.resolve(file ?? path.join(cfg.outDir, 'emitidos.csv'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, toCsv(rows, COLUMNAS_EMITIDOS));
  return out;
}
