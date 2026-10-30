/**
 * Lo FISCAL que FiscalOS toma de PFOS (solo PALERMO, ya filtrado por las vistas de solo lectura). Funciones puras. No hay
 * cálculo comercial acá (costos, comisiones, publicidad, logística): eso es de PFOS.
 *  - Mes en hora de Argentina (UTC−3) por la fecha de la venta; el mes en curso, hasta el corte (ayer).
 *  - Ventas del mes con IVA, como CONTROL contra la facturación de ARCA (no reemplaza a la facturación).
 *  - Retenciones de impuestos que Mercado Pago hizo en los cobros de esas ventas (charges_details de tipo «tax» a cargo del
 *    vendedor): son anticipos de impuestos; cada pago se cuenta una sola vez.
 *  - Facturas a clientes de «Conciliación» (con su CAE), para verificar que la cuenta es del CUIT.
 */

const r2 = (x) => Math.round(x * 100) / 100;
const num = (v) => { if (v == null || v === '' || v === '•••') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

/** Fecha y mes en hora de Argentina de una fecha ISO (con o sin zona). */
export function enArgentina(iso) {
  if (!iso) return null;
  const s = String(iso);
  const conZona = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s);
  const t = Date.parse(conZona ? s : `${s.length === 10 ? `${s}T00:00:00` : s}-03:00`);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t - 3 * 3600000).toISOString();
  return { dia: d.slice(0, 10), mes: d.slice(0, 7) };
}

/** Fecha de un dato de los reportes de «Conciliación» ("2026-09-30", "2026-09-30T12:00:00", "30/09/2026"). */
export function diaReporte(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

export const diasDelMes = (mes) => { const [y, m] = mes.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
export const finDelMes = (mes) => `${mes}-${String(diasDelMes(mes)).padStart(2, '0')}`;
const sumarDias = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const ANULADAS = new Set(['cancelled', 'invalid']);

/**
 * Corte del mes: el último día que PFOS ya puede tener completo. Un mes terminado, su último día; el mes en curso, AYER
 * (hora de Argentina) respecto de cuándo se generó la foto. Los días posteriores al corte no son «atrasados»: todavía no
 * pasaron. null si el mes todavía no empezó.
 */
export function corteDelMes(mes, generado = new Date().toISOString()) {
  const hoy = enArgentina(generado)?.dia ?? new Date().toISOString().slice(0, 10);
  const fin = finDelMes(mes); const ayer = sumarDias(hoy, -1);
  const corte = ayer < fin ? ayer : fin;
  return corte < `${mes}-01` ? null : corte;
}

/** Días del mes hasta el corte (inclusive): ['AAAA-MM-01', …]. */
export const diasHasta = (mes, corte) => (corte ? Array.from({ length: Number(corte.slice(8, 10)) }, (_, i) => `${mes}-${String(i + 1).padStart(2, '0')}`) : []);

/**
 * Órdenes (data de PFOS) del mes por su fecha de creación en hora de Argentina, separando las canceladas. Con corte, las
 * de días posteriores (hoy, en el mes en curso) quedan afuera y se cuentan aparte: el mes se mide entero hasta el corte.
 */
export function ordenesDelMes(ordenes, mes, corte = finDelMes(mes)) {
  const vigentes = []; const canceladas = []; let posteriores = 0;
  for (const o of ordenes) {
    const f = enArgentina(o.data?.date_created);
    if (f?.mes !== mes) continue;
    if (corte && f.dia > corte) { posteriores++; continue; }
    (ANULADAS.has(o.data?.status) ? canceladas : vigentes).push({ ...o, dia: f.dia });
  }
  return { vigentes, canceladas, posteriores };
}

/** Clasificación de un cargo del cobro de MP (PFOS 3.2). */
export function claseCargo(c) {
  if (c?.type === 'tax') return 'retencion';
  if (c?.type === 'shipping') return 'envio';
  const n = String(c?.name ?? '');
  if (n === 'meli_percentage_fee' || n === 'flat_fee') return 'comision';
  if (n === 'financing_add_on_fee') return 'cuotas';
  if (n === 'coupon_fee') return 'cupon';
  return 'otro';
}

/**
 * Retenciones de Mercado Pago en los cobros de las ventas del mes (a cargo del vendedor), por nombre del cargo. Cada pago
 * una vez. cobertura: % de las ventas con pago cuyo cobro está en PFOS.
 */
export function retencionesMes(ordenesMes, cobrosPorId) {
  const porNombre = {}; const vistos = new Set(); let total = 0; let conPago = 0; let esperadas = 0;
  for (const o of ordenesMes) {
    const ids = (o.data?.payments ?? []).filter((p) => !['rejected', 'cancelled'].includes(p?.status)).map((p) => String(p.id));
    if (!ids.length) continue;
    esperadas++;
    let alguno = false;
    for (const id of ids) {
      const pago = cobrosPorId.get(id);
      if (!pago) continue;
      alguno = true;
      if (vistos.has(id) || ['rejected', 'cancelled'].includes(pago.status)) continue;
      vistos.add(id);
      for (const c of pago.charges_details ?? []) {
        if (c?.accounts?.from !== 'collector' || claseCargo(c) !== 'retencion') continue;
        const v = (num(c?.amounts?.original) ?? 0) - (num(c?.amounts?.refunded) ?? 0);
        total += v; const k = String(c.name ?? 'sin nombre'); porNombre[k] = r2((porNombre[k] ?? 0) + v);
      }
    }
    if (alguno) conPago++;
  }
  return { total: r2(total), porNombre, pagos: vistos.size, cobertura: esperadas ? r2((conPago / esperadas) * 100) : null };
}

/**
 * Hechos vigentes de «Conciliación» (mismas reglas que PFOS finFacts): solo importaciones cerradas (o «reemplazando»);
 * identidad repetida en una descarga = pendiente; un dato que define el hecho distinto = conflicto; varias versiones:
 * la de frescura conocida más reciente si es única. Devuelve { porFuente: { fuente: [data] }, conflictos, pendientes, provisionales }.
 */
export function vigentesConciliacion(filas) {
  const grupos = new Map(); const provisionales = {};
  for (const f of filas) {
    if (!['cerrada', 'reemplazando'].includes(f.import_status)) continue;
    if (f.identity_key == null) { provisionales[f.source] = (provisionales[f.source] ?? 0) + 1; continue; }
    const k = `${f.source}\u0000${f.identity_key}`;
    const g = grupos.get(k) ?? { source: f.source, filas: [] };
    g.filas.push(f); grupos.set(k, g);
  }
  const porFuente = {}; const conflictos = {}; const pendientes = {};
  for (const g of grupos.values()) {
    const dup = g.filas.some((f) => f.identity_status === 'pendiente');
    const defs = new Set(g.filas.map((f) => f.defining_sha));
    const versiones = new Map();
    for (const f of g.filas) {
      const v = versiones.get(f.data_sha) ?? { data: f.data, fr: null };
      const fr = f.freshness_origin !== 'desconocida' && f.freshness_at ? String(f.freshness_at instanceof Date ? f.freshness_at.toISOString() : f.freshness_at) : null;
      if (fr && (!v.fr || fr > v.fr)) v.fr = fr;
      versiones.set(f.data_sha, v);
    }
    const lista = [...versiones.values()];
    const max = lista.reduce((m, v) => (v.fr && (!m || v.fr > m) ? v.fr : m), null);
    const top = lista.filter((v) => v.fr && v.fr === max);
    let vigente = null;
    if (dup || (defs.size > 1 && g.source === 'mp_movimiento')) pendientes[g.source] = (pendientes[g.source] ?? 0) + 1;
    else if (defs.size > 1) conflictos[g.source] = (conflictos[g.source] ?? 0) + 1;
    else if (lista.length === 1) vigente = lista[0].data;
    else if (lista.some((v) => !v.fr) || top.length !== 1) conflictos[g.source] = (conflictos[g.source] ?? 0) + 1;
    else vigente = top[0].data;
    if (vigente) (porFuente[g.source] ??= []).push(typeof vigente === 'string' ? JSON.parse(vigente) : vigente);
  }
  return { porFuente, conflictos, pendientes, provisionales };
}

/**
 * Días del mes con la recolección de una fuente completa en PFOS (alcances «hist|día» con estado «completa»), hasta el
 * corte: los días que todavía no pasaron no son «faltantes». diasEsperados = días hasta el corte.
 */
export function diasCubiertos(alcances, fuente, mes, corte = finDelMes(mes)) {
  const dias = new Set();
  for (const a of alcances) {
    if (a.source !== fuente || a.status !== 'completa') continue;
    const m = String(a.scope).match(/^hist\|(\d{4}-\d{2}-\d{2})$/);
    if (m && m[1].slice(0, 7) === mes && (!corte || m[1] <= corte)) dias.add(m[1]);
  }
  const esperados = diasHasta(mes, corte);
  return { dias: dias.size, diasEsperados: esperados.length, diasMes: diasDelMes(mes), corte, faltan: esperados.filter((d) => !dias.has(d)) };
}
