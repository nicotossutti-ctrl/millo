/**
 * Cálculo del mes con los datos de PFOS (solo PALERMO, ya filtrados por las vistas de solo lectura). Funciones puras:
 * reciben filas y devuelven importes CON su cobertura y lo que falta. Reglas de PFOS (docs/rentabilidad-DISENO.md):
 *  - Mes en hora de Argentina (UTC−3) por la fecha de la venta (5.1).
 *  - Cargos de cada venta desde el cobro de MP (charges_details), netos de lo devuelto; pagos rechazados o cancelados no
 *    cuentan; un pago se cuenta una sola vez aunque cubra varias órdenes del paquete (3.2).
 *  - Retenciones de MP (type = tax): anticipos de impuestos, NO costo (4.3).
 *  - Costo de mercadería: lista vigente a la fecha (o la posterior, marcada), mapeo confirmado en PFOS o propuesta
 *    automática; canceladas sin costo; devoluciones recibidas restan en el mes en que se cierran (3.7).
 *  - Reportes de «Conciliación»: solo importaciones cerradas; por identidad, la versión vigente por frescura; pendientes y
 *    conflictos afuera y contados (PFOS finFacts).
 * Los importes de ML/MP vienen CON IVA. PALERMO es responsable inscripto: el neto se informa aparte (÷ 1,21) y marcado
 * como estimado hasta verificarlo contra las facturas de ML en ARCA.
 */
import { listaParaVenta, mapeoVigente, proponerMapeo, costoLinea } from './costos.js';

const r2 = (x) => Math.round(x * 100) / 100;
const num = (v) => { if (v == null || v === '' || v === '•••') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
export const IVA = 1.21;

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

const skuDe = (it) => it?.item?.seller_sku || it?.item?.seller_custom_field || null;
const variacionDe = (it) => (it?.item?.variation_attributes ?? []).map((a) => a?.value_name).filter(Boolean).join(' ');

/**
 * Costea una línea de venta: mapeo confirmado en PFOS (vigente al día) o propuesta automática; lista vigente o posterior.
 * Devuelve { valor, origen: 'confirmado'|'automático', posterior, motivo }.
 */
export function costearLinea({ sku, cantidad, precio, variacion, dia }, { listas, itemsPorLista, mapeos }) {
  const { lista, posterior } = listaParaVenta(listas, dia);
  if (!lista) return { valor: null, motivo: 'no hay ninguna lista de costos cargada en PFOS' };
  const items = itemsPorLista.get(String(lista.id)) ?? [];
  const decision = sku ? mapeoVigente(mapeos.get(sku) ?? [], dia) : null;
  if (decision?.status === 'excluido') return { valor: null, motivo: 'SKU excluido en PFOS', categoria: 'excluido en PFOS', posterior };
  let componentes; let origen; let reglas = [];
  if (decision?.status === 'confirmado' && decision.components?.length) { componentes = decision.components; origen = 'confirmado'; }
  else {
    const p = proponerMapeo({ sku, unitPrice: precio, variation: variacion }, items);
    if (p.estado !== 'automático') return { valor: null, motivo: p.motivo, categoria: p.categoria, revision: p.estado === 'dudoso', posterior };
    componentes = p.components; origen = 'automático'; reglas = p.reglas;
  }
  const c = costoLinea({ cantidad, componentes, items });
  return c.valor == null ? { valor: null, motivo: c.motivo, categoria: 'fila de la lista', posterior } : { valor: c.valor, porUnidad: c.porUnidad, origen, reglas, posterior };
}

/** Costo de la mercadería vendida en el mes (sin devoluciones). */
export function costoVendidoMes(ordenesMes, ctx) {
  let total = 0; let unidades = 0; let conCosto = 0; let confirmadas = 0; let automaticas = 0; let posteriores = 0; let revision = 0;
  const sinCosto = new Map(); const porDia = {}; const porRegla = {}; const motivos = {};
  for (const o of ordenesMes) {
    const d = (porDia[o.dia] ??= { unidades: 0, conCosto: 0, costo: 0 });
    for (const it of o.data?.order_items ?? []) {
      const cantidad = num(it.quantity) ?? 0;
      unidades += cantidad; d.unidades += cantidad;
      const sku = skuDe(it);
      const c = costearLinea({ sku, cantidad, precio: num(it.unit_price), variacion: variacionDe(it), dia: o.dia }, ctx);
      if (c.valor == null) {
        const k = sku || '(sin SKU)';
        const s = sinCosto.get(k) ?? { sku: k, unidades: 0, motivo: c.motivo, categoria: c.categoria ?? 'otro', revision: !!c.revision };
        s.unidades += cantidad; sinCosto.set(k, s);
        motivos[s.categoria] = (motivos[s.categoria] ?? 0) + cantidad;
        if (c.revision) revision += cantidad;
        continue;
      }
      total += c.valor; conCosto += cantidad; d.conCosto += cantidad; d.costo = r2(d.costo + c.valor);
      if (c.origen === 'confirmado') confirmadas += cantidad; else automaticas += cantidad;
      if (c.posterior) posteriores += cantidad;
      for (const g of c.reglas ?? []) { const k = g.replace(/^x\d+$/, 'xN').replace(/^\d+ colores.*/, 'colores con «+»'); porRegla[k] = (porRegla[k] ?? 0) + cantidad; }
    }
  }
  return {
    total: r2(total), unidades, unidadesConCosto: conCosto, cobertura: unidades ? r2((conCosto / unidades) * 100) : null,
    unidadesConfirmadas: confirmadas, unidadesAutomaticas: automaticas, unidadesListaPosterior: posteriores, unidadesParaRevision: revision,
    sinCosto: [...sinCosto.values()].sort((a, b) => b.unidades - a.unidades), motivos, porRegla, porDia,
  };
}

/**
 * Mercadería que volvió en el mes: devoluciones entregadas al vendedor (status 'delivered') cerradas en el mes, por la
 * cantidad devuelta, al costo de la línea original. Lo que no se puede costear se lista.
 */
export function devolucionesMes(devoluciones, ordenesPorId, mes, ctx) {
  let total = 0; let unidades = 0; let sinCostear = 0; const motivos = [];
  for (const d of devoluciones) {
    const x = d.data ?? {};
    if (x.status !== 'delivered') continue;
    const f = enArgentina(x.date_closed || x.last_updated);
    if (f?.mes !== mes) continue;
    for (const ro of x.orders ?? []) {
      const q = num(ro.return_quantity) ?? 0;
      if (!q) continue;
      unidades += q;
      const orden = ordenesPorId.get(String(ro.order_id));
      const linea = orden?.data?.order_items?.find((it) => String(it?.item?.id) === String(ro.item_id) && (!ro.variation_id || String(it?.item?.variation_id) === String(ro.variation_id)));
      if (!linea) { sinCostear += q; motivos.push(`orden ${ro.order_id}: no está en PFOS`); continue; }
      const dia = enArgentina(orden.data.date_created)?.dia;
      const c = costearLinea({ sku: skuDe(linea), cantidad: q, precio: num(linea.unit_price), variacion: variacionDe(linea), dia }, ctx);
      if (c.valor == null) { sinCostear += q; motivos.push(`orden ${ro.order_id}: ${c.motivo}`); continue; }
      total += c.valor;
    }
  }
  return { total: r2(total), unidades, sinCostear, motivos: motivos.slice(0, 20) };
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
 * Cargos al vendedor de las ventas del mes (con IVA, como los informa MP), netos de lo devuelto. Solo los cargos que
 * paga el vendedor (accounts.from = 'collector'). Cada pago, una sola vez.
 */
export function cargosMes(ordenesMes, cobrosPorId) {
  const suma = { comision: 0, cuotas: 0, cupon: 0, envio: 0, retencion: 0, otro: 0 };
  const otros = {}; const vistos = new Set();
  let conPago = 0; let pagosFaltantes = 0; const porDia = {};
  for (const o of ordenesMes) {
    const ids = (o.data?.payments ?? []).filter((p) => !['rejected', 'cancelled'].includes(p?.status)).map((p) => String(p.id));
    if (!ids.length) continue;
    let alguno = false;
    for (const id of ids) {
      const pago = cobrosPorId.get(id);
      if (!pago) { pagosFaltantes++; continue; }
      alguno = true;
      if (vistos.has(id) || ['rejected', 'cancelled'].includes(pago.status)) continue;
      vistos.add(id);
      for (const c of pago.charges_details ?? []) {
        if (c?.accounts?.from !== 'collector') continue;
        const v = (num(c?.amounts?.original) ?? 0) - (num(c?.amounts?.refunded) ?? 0);
        const k = claseCargo(c);
        suma[k] += v;
        if (o.dia && k !== 'retencion' && k !== 'otro') { const d = (porDia[o.dia] ??= { comision: 0, envio: 0 }); const kk = k === 'envio' ? 'envio' : 'comision'; d[kk] = r2(d[kk] + v); }
        if (k === 'otro') otros[c.name ?? c.type ?? '?'] = r2((otros[c.name ?? c.type ?? '?'] ?? 0) + v);
      }
    }
    if (alguno) conPago++;
  }
  const conPagos = ordenesMes.filter((o) => (o.data?.payments ?? []).some((p) => !['rejected', 'cancelled'].includes(p?.status))).length;
  return {
    ...Object.fromEntries(Object.entries(suma).map(([k, v]) => [k, r2(v)])), otros,
    pagos: vistos.size, ordenesConPago: conPago, ordenesConPagoEsperado: conPagos, pagosFaltantes,
    cobertura: conPagos ? r2((conPago / conPagos) * 100) : null, porDia,
  };
}

/**
 * Inversión de Mercado Ads del mes hasta el corte (nivel campaña, por día). Sin ningún día leído, el total es null (sin
 * datos), NUNCA 0: un día con inversión 0 leída sí cuenta como dato. diasEsperados: los días hasta el corte.
 */
export function adsMes(filas, mes, corte = finDelMes(mes)) {
  const porDia = {}; let total = 0;
  for (const f of filas) {
    const dia = String(f.day instanceof Date ? f.day.toISOString() : f.day).slice(0, 10);
    if (dia.slice(0, 7) !== mes || (corte && dia > corte)) continue;
    const m = typeof f.metrics === 'string' ? JSON.parse(f.metrics) : f.metrics;
    const c = num(m?.cost);
    if (c == null) continue;
    total += c; porDia[dia] = r2((porDia[dia] ?? 0) + c);
  }
  const esperados = diasHasta(mes, corte);
  const dias = Object.keys(porDia).length;
  return { total: dias ? r2(total) : null, dias, diasEsperados: esperados.length, diasMes: diasDelMes(mes), corte,
    faltan: esperados.filter((d) => !(d in porDia)), porDia };
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
 * Viajes de Luma sin contar dos veces: PFOS guarda las dos planillas (la quincenal, con número de viaje, y la de detalle,
 * con la referencia y la fecha del último estado) como identidades distintas. Si una venta (referencia) está en la quincenal,
 * se usan esos viajes; la de detalle solo suma las referencias que la quincenal no tiene.
 */
export function viajesSinDuplicar(viajes) {
  const conId = viajes.filter((d) => d.id_viaje != null && d.id_viaje !== '');
  const refs = new Set(conId.map((d) => String(d.referencia ?? '')).filter(Boolean));
  const resto = viajes.filter((d) => !(d.id_viaje != null && d.id_viaje !== ''));
  const nuevos = resto.filter((d) => !d.referencia || !refs.has(String(d.referencia)));
  return { viajes: [...conId, ...nuevos], repetidos: resto.length - nuevos.length };
}

/**
 * Flex (bonificaciones y anulaciones de ML, viajes de Luma) y cargos de Full del mes hasta el corte, por su fecha. Con IVA
 * según el reporte. Cada uno, con su total por día (para comparar períodos equivalentes).
 */
export function logisticaReportesMes(vigentes, mes, corte = finDelMes(mes)) {
  const sumar = (filas, campoFecha, campoImporte) => {
    let total = 0; let n = 0; let sinFecha = 0; const porDia = {};
    for (const d of filas) {
      const dia = diaReporte(typeof campoFecha === 'function' ? campoFecha(d) : d[campoFecha]);
      if (!dia) { sinFecha++; continue; }
      if (dia.slice(0, 7) !== mes || (corte && dia > corte)) continue;
      const v = num(d[campoImporte]) ?? 0;
      total += v; n++; porDia[dia] = r2((porDia[dia] ?? 0) + v);
    }
    return { total: r2(total), n, sinFecha, porDia };
  };
  const luma = viajesSinDuplicar(vigentes.porFuente.flex_viaje ?? []);
  return {
    bonificacionFlex: sumar(vigentes.porFuente.flex_bonificacion ?? [], 'fecha', 'valor'),
    anulacionFlex: sumar(vigentes.porFuente.flex_anulacion ?? [], 'fecha', 'valor'),
    cadete: { ...sumar(luma.viajes, (d) => d.fecha_creacion || d.fecha_estado, 'precio'), repetidos: luma.repetidos },
    full: sumar(vigentes.porFuente.full_cargo ?? [], 'fecha_cargo', 'monto'),
  };
}

/**
 * ¿Las importaciones cerradas de un formato cubren el mes hasta el corte? Mira el rango declarado al cargar (desde/hasta) y
 * la cobertura que PFOS le dio a cada archivo (una importación con filas descartadas al leer es «parcial»). Devuelve
 * { estado: 'completa' | 'parcial' | 'sin datos', rangos, cubreHasta, faltaDesde, descartadas }.
 */
export function coberturaReportes(importaciones, formatos, mes, corte = finDelMes(mes)) {
  const ini = `${mes}-01`; const fin = corte ?? finDelMes(mes);
  const rangos = importaciones.filter((i) => formatos.includes(i.format) && ['cerrada', 'reemplazando'].includes(i.status) && i.range_from && i.range_to)
    .map((i) => {
      const hasta = String(i.range_to).slice(0, 10);
      const h = i.range_to_exclusive ? sumarDias(hasta, -1) : hasta;
      return { desde: String(i.range_from).slice(0, 10), hasta: h, parcial: i.coverage === 'parcial' };
    })
    .filter((r) => r.desde <= fin && r.hasta >= ini).sort((a, b) => a.desde.localeCompare(b.desde));
  if (!rangos.length) return { estado: 'sin datos', rangos, cubreHasta: null, faltaDesde: ini, descartadas: 0 };
  let cubierto = ini; let hueco = null;
  for (const r of rangos) {
    if (r.desde > cubierto) { hueco = cubierto; break; }
    const sig = sumarDias(r.hasta, 1);
    if (sig > cubierto) cubierto = sig;
  }
  const descartadas = rangos.filter((r) => r.parcial).length;
  const completa = !hueco && cubierto > fin && !descartadas;
  return { estado: completa ? 'completa' : 'parcial', rangos, cubreHasta: sumarDias(cubierto, -1), faltaDesde: completa ? null : hueco ?? (cubierto > fin ? null : cubierto), descartadas };
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
