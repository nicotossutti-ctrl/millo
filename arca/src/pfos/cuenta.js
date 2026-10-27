/**
 * ¿La cuenta de Mercado Libre que entrega PFOS es del contribuyente de FiscalOS? Se comprueba por el CAE, que es
 * inequívoco: lo otorga ARCA a UN comprobante de UN CUIT. Las facturas a clientes que PFOS tiene de la cuenta (reporte de
 * comprobantes de «Conciliación», que trae el CAE) tienen que estar en los comprobantes EMITIDOS que ARCA tiene del CUIT de
 * FiscalOS (Mis Comprobantes, «Cód. Autorización»), con el mismo CAE y, si los trae, el mismo punto de venta y número.
 * Punto de venta + número SOLOS no prueban nada (se repiten entre CUIT distintos): se informan, pero nunca validan.
 * Funciones puras.
 */
import { tablaDe } from '../informeIva.js';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const entero = (v) => { const m = String(v ?? '').match(/\d+/g); return m ? Number(m.join('')) : null; };

/** Comprobantes emitidos en ARCA (texto CSV de Mis Comprobantes): { numeros: Set('pv-n'), caes: Map(cae → 'pv-n') }. */
export function clavesArca(textos) {
  const numeros = new Set(); const caes = new Map();
  for (const texto of textos) {
    const t = tablaDe(texto, (f) => f.some((c) => /punto de venta/.test(norm(c))) && f.some((c) => /numero desde/.test(norm(c))));
    const h = t.headers.map(norm);
    const iPv = h.findIndex((x) => /^punto de venta/.test(x)); const iD = h.findIndex((x) => /^numero desde/.test(x));
    const iH = h.findIndex((x) => /^numero hasta/.test(x)); const iCae = h.findIndex((x) => /cod\. autorizacion|^cae/.test(x));
    if (iPv < 0 || iD < 0) continue;
    for (const f of t.rows) {
      const pv = entero(f[iPv]); const d = entero(f[iD]); const hh = iH >= 0 ? entero(f[iH]) ?? d : d;
      if (pv == null || d == null) continue;
      if (hh - d <= 1000) for (let n = d; n <= hh; n++) numeros.add(`${pv}-${n}`);
      const cae = iCae >= 0 ? String(f[iCae] ?? '').replace(/\D/g, '') : '';
      if (cae.length >= 10) caes.set(cae, `${pv}-${d}`);
    }
  }
  return { numeros, caes };
}

/** Comprobantes de la cuenta según PFOS: [{ pv, numero, cae }]. */
export function comprobantesPfos(facturasApi, comprobantesReporte) {
  const out = [];
  for (const f of facturasApi) {
    const d = f.data ?? f;
    if (d.status && /cancel|reject|error/i.test(String(d.status))) continue;
    const pv = entero(d.invoice_series); const numero = entero(d.invoice_number);
    if (pv != null && numero != null) out.push({ pv, numero, cae: null, origen: 'factura (API de ML)' });
  }
  for (const d of comprobantesReporte) {
    const pv = entero(d.punto_venta); const numero = entero(d.numero);
    const cae = d.cae ? String(d.cae).replace(/\D/g, '') || null : null;
    if ((pv != null && numero != null) || cae) out.push({ pv, numero, cae, origen: 'comprobante (reporte de ML)' });
  }
  return out;
}

/**
 * Verificación por CAE: con al menos `minimo` comprobantes de la cuenta CON CAE, ≥ `umbral` % tienen que estar en los
 * emitidos de ARCA con ese CAE (y el mismo punto de venta y número, si PFOS los trae). Sin CAE suficientes, NO se valida.
 * Devuelve { verificada, comparados, encontrados, porcentaje, soloNumero, motivo }.
 */
export function verificarCuenta(comprobantes, arca, { minimo = 20, umbral = 95 } = {}) {
  let comparados = 0; let encontrados = 0; let soloNumero = 0; let soloNumeroEnArca = 0;
  for (const c of comprobantes) {
    if (!c.cae) {
      if (c.pv != null && c.numero != null) { soloNumero++; if (arca.numeros.has(`${c.pv}-${c.numero}`)) soloNumeroEnArca++; }
      continue;
    }
    comparados++;
    const enArca = arca.caes.get(c.cae);
    if (enArca && (c.pv == null || c.numero == null || enArca === `${c.pv}-${c.numero}`)) encontrados++;
  }
  const porcentaje = comparados ? Math.round((encontrados / comparados) * 1000) / 10 : null;
  const base = { comparados, encontrados, porcentaje, soloNumero, soloNumeroEnArca };
  if (!arca.caes.size) return { ...base, verificada: false, motivo: 'no hay comprobantes emitidos de ARCA con CAE para este mes (correr Mis Comprobantes emitidos)' };
  if (comparados < minimo) {
    return { ...base, verificada: false, motivo: `PFOS tiene ${comparados} factura(s) a clientes de la cuenta con CAE en el mes (hacen falta ${minimo}): cargá en PFOS el reporte de comprobantes del mes. Punto de venta + número solos no alcanzan` };
  }
  if (porcentaje < umbral) return { ...base, verificada: false, motivo: `solo ${porcentaje}% de los CAE de la cuenta están en los comprobantes emitidos de tu CUIT: la cuenta no es tuya o hay otro problema. No se usan sus datos` };
  return { ...base, verificada: true, motivo: `${encontrados} de ${comparados} CAE de la cuenta están en tus comprobantes emitidos de ARCA` };
}
