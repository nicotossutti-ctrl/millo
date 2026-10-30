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
 * Verificación por CAE: con al menos `minimo` CAE DISTINTOS de la cuenta en el mes, ≥ `umbral` % tienen que estar en los
 * emitidos de ARCA con ese CAE (y el mismo punto de venta y número, si PFOS los trae). Se cuentan facturas, no filas: una
 * factura con 20 productos repetida en 20 filas es UN CAE. Si un CAE aparece con números distintos, no coincide. Sin CAE
 * suficientes, NO se valida. Devuelve { verificada, estado, comparados, encontrados, porcentaje, filas, soloNumero, motivo }.
 * estado: 'verificada' | 'sin evidencia' (faltan comprobantes de ARCA o CAE suficientes en el mes) | 'no coincide' (hay CAE
 * suficientes y no son del CUIT: la cuenta no se usa ni siquiera como provisoria).
 */
export function verificarCuenta(comprobantes, arca, { minimo = 20, umbral = 95 } = {}) {
  const porCae = new Map(); const soloNumeros = new Set(); let filas = 0;
  for (const c of comprobantes) {
    if (!c.cae) {
      if (c.pv != null && c.numero != null) soloNumeros.add(`${c.pv}-${c.numero}`);
      continue;
    }
    filas++;
    const numeros = porCae.get(c.cae) ?? new Set();
    if (c.pv != null && c.numero != null) numeros.add(`${c.pv}-${c.numero}`);
    porCae.set(c.cae, numeros);
  }
  let encontrados = 0;
  for (const [cae, numeros] of porCae) {
    const enArca = arca.caes.get(cae);
    if (enArca && [...numeros].every((n) => n === enArca)) encontrados++;
  }
  const comparados = porCae.size;
  const soloNumeroEnArca = [...soloNumeros].filter((n) => arca.numeros.has(n)).length;
  const porcentaje = comparados ? Math.round((encontrados / comparados) * 1000) / 10 : null;
  const base = { comparados, encontrados, porcentaje, filas, soloNumero: soloNumeros.size, soloNumeroEnArca };
  if (!arca.caes.size) return { ...base, verificada: false, estado: 'sin evidencia', motivo: 'no hay comprobantes emitidos de ARCA con CAE para este mes (correr Mis Comprobantes emitidos)' };
  if (comparados < minimo) {
    return { ...base, verificada: false, estado: 'sin evidencia', motivo: `PFOS tiene ${comparados} factura(s) distinta(s) con CAE de la cuenta en el mes (hacen falta ${minimo}): cargá en PFOS el reporte de comprobantes del mes. Punto de venta + número solos no alcanzan` };
  }
  if (porcentaje < umbral) return { ...base, verificada: false, estado: 'no coincide', motivo: `solo ${porcentaje}% de los CAE de la cuenta están en los comprobantes emitidos de tu CUIT: la cuenta no es tuya o hay otro problema. No se usan sus datos` };
  return { ...base, verificada: true, estado: 'verificada', motivo: `${encontrados} de ${comparados} CAE distintos de la cuenta están en tus comprobantes emitidos de ARCA` };
}

/**
 * Titularidad para usar los datos de un mes. El mes verificado por CAE se usa como siempre. Un mes SIN evidencia (por
 * ejemplo, el mes en curso, sin comprobantes emitidos de ARCA todavía) puede apoyarse en OTRO mes ya verificado por CAE con
 * la MISMA cuenta de Mercado Libre (user_id), leída por el mismo acceso filtrado: la titularidad es de la cuenta, no del
 * mes. Así se pueden mostrar sus datos (retenciones, ventas como control), pero la conciliación fiscal del mes sigue
 * pendiente hasta tener sus comprobantes emitidos. Un mes
 * cuyos CAE NO coinciden nunca se usa. `otras`: fotos de otros meses ({ mes, cuenta, cuentaPfos }).
 * Devuelve { usable, provisoria, mesVerificado, conciliacionFiscal: { estado, motivo }, motivo }.
 */
export function titularidad(foto, otras = []) {
  const c = foto?.cuenta ?? {};
  if (c.verificada) {
    return { usable: true, provisoria: false, mesVerificado: foto.mes, conciliacionFiscal: { estado: 'conciliada', motivo: c.motivo }, motivo: c.motivo };
  }
  const estado = c.estado ?? (/no hay comprobantes emitidos|hacen falta/.test(String(c.motivo ?? '')) ? 'sin evidencia' : 'no coincide');
  if (estado === 'no coincide') return { usable: false, provisoria: false, mesVerificado: null, conciliacionFiscal: { estado: 'no coincide', motivo: c.motivo }, motivo: c.motivo };
  const base = (foto?.cuentaPfos ?? null) != null ? String(foto.cuentaPfos) : null;
  const previa = base ? otras.filter((o) => o.mes !== foto.mes && o.cuenta?.verificada && String(o.cuentaPfos ?? '') === base).sort((a, b) => b.mes.localeCompare(a.mes))[0] : null;
  if (!previa) return { usable: false, provisoria: false, mesVerificado: null, conciliacionFiscal: { estado: 'pendiente', motivo: c.motivo }, motivo: c.motivo ?? 'cuenta sin verificar' };
  return {
    usable: true, provisoria: true, mesVerificado: previa.mes,
    conciliacionFiscal: { estado: 'pendiente', motivo: c.motivo ?? 'faltan los comprobantes emitidos del mes' },
    motivo: `cuenta verificada por CAE en ${previa.mes} (${previa.cuenta.encontrados} de ${previa.cuenta.comparados} CAE); este mes es la misma cuenta de Mercado Libre, leída con el mismo acceso filtrado. Conciliación fiscal del mes: pendiente`,
  };
}
