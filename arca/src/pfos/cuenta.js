/**
 * ¿La cuenta de Mercado Libre que entrega PFOS es del contribuyente de FiscalOS? Se comprueba por IDENTIFICADORES, no por
 * nombres: las facturas a clientes que PFOS tiene de la cuenta (API de facturación de ML o el reporte de comprobantes de
 * «Conciliación») tienen que estar en los comprobantes EMITIDOS que ARCA tiene del CUIT de FiscalOS (Mis Comprobantes),
 * por punto de venta + número, o por CAE. El punto de venta y el número solo son únicos dentro de un CUIT, y el CAE lo
 * otorga ARCA a ese CUIT: si coinciden, las ventas de la cuenta se facturaron con este CUIT. Funciones puras.
 */
import { tablaDe } from '../informeIva.js';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const entero = (v) => { const m = String(v ?? '').match(/\d+/g); return m ? Number(m.join('')) : null; };

/** Claves de los comprobantes emitidos en ARCA (texto CSV de Mis Comprobantes): { numeros: Set('pv-n'), caes: Set }. */
export function clavesArca(textos) {
  const numeros = new Set(); const caes = new Set();
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
      if (iCae >= 0 && String(f[iCae] ?? '').trim()) caes.add(String(f[iCae]).trim());
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
    const cae = d.cae ? String(d.cae).trim() : null;
    if ((pv != null && numero != null) || cae) out.push({ pv, numero, cae, origen: 'comprobante (reporte de ML)' });
  }
  return out;
}

/**
 * Verificación: con al menos `minimo` comprobantes comparables, ≥ `umbral` % tienen que estar en ARCA.
 * Devuelve { verificada, comparados, encontrados, porcentaje, motivo }.
 */
export function verificarCuenta(comprobantes, arca, { minimo = 20, umbral = 95 } = {}) {
  let comparados = 0; let encontrados = 0;
  for (const c of comprobantes) {
    const porNumero = c.pv != null && c.numero != null;
    if (!porNumero && !c.cae) continue;
    comparados++;
    if ((c.cae && arca.caes.has(c.cae)) || (porNumero && arca.numeros.has(`${c.pv}-${c.numero}`))) encontrados++;
  }
  const porcentaje = comparados ? Math.round((encontrados / comparados) * 1000) / 10 : null;
  if (!arca.numeros.size && !arca.caes.size) return { verificada: false, comparados, encontrados, porcentaje, motivo: 'no hay comprobantes emitidos de ARCA conservados para comparar (correr Mis Comprobantes emitidos)' };
  if (comparados < minimo) return { verificada: false, comparados, encontrados, porcentaje, motivo: `PFOS tiene solo ${comparados} factura(s) a clientes comparables de la cuenta (hacen falta ${minimo})` };
  if (porcentaje < umbral) return { verificada: false, comparados, encontrados, porcentaje, motivo: `solo ${porcentaje}% de las facturas de la cuenta están en los comprobantes emitidos de tu CUIT: la cuenta no es tuya o hay otro problema. No se usan sus datos.` };
  return { verificada: true, comparados, encontrados, porcentaje, motivo: `${encontrados} de ${comparados} facturas de la cuenta están en tus comprobantes emitidos de ARCA` };
}
