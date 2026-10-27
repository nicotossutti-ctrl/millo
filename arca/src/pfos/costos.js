/**
 * Costo de la mercadería según las reglas de PFOS, portadas de pfos-ml/lib/metrics_costs.js (commit 7ac8b62):
 * listFor, parseSku, proposeMapping, rowFor, mappingFor y el costo de una línea. Funciones puras (sin base ni red).
 *
 * Diferencias con PFOS, a propósito:
 *  - FiscalOS es de UN contribuyente responsable inscripto (PALERMO): el costo va siempre SIN IVA. No hay tabla de
 *    cuentas ni regímenes en el código (el repositorio es público).
 *  - Si no hay lista vigente a la fecha de la venta, se usa la PRIMERA lista posterior, marcada «lista posterior a la
 *    venta» (docs/rentabilidad-DISENO.md de PFOS, sección 13). Nunca se presenta como costo real de esa fecha.
 *
 * Fórmula (PFOS 3.7): cantidad × Σ (unidades del componente × precio de lista sin IVA × factor), con
 * factor = (1 − descuento de fábrica) × (1 − contado).
 */

const keyOf = (code) => String(code ?? '').toUpperCase().replace(/\s+/g, '');
const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const PLAUSIBLE = [0.5, 2];

/** La lista vigente para un día AAAA-MM-DD: la de vigencia más reciente que no lo supere (PFOS listFor). */
export function listaVigente(listas, dia) {
  const ok = (listas ?? []).filter((l) => l.valid_from <= dia)
    .sort((a, b) => (a.valid_from < b.valid_from ? 1 : a.valid_from > b.valid_from ? -1 : Number(b.id) - Number(a.id)));
  return ok[0] ?? null;
}

/** La lista para costear una venta: la vigente, o la primera posterior (marcada). */
export function listaParaVenta(listas, dia) {
  const v = listaVigente(listas, dia);
  if (v) return { lista: v, posterior: false };
  const post = (listas ?? []).filter((l) => l.valid_from > dia).sort((a, b) => (a.valid_from < b.valid_from ? -1 : a.valid_from > b.valid_from ? 1 : Number(a.id) - Number(b.id)))[0];
  return post ? { lista: post, posterior: true } : { lista: null, posterior: false };
}

const SIZE_TOKEN = /^(XXS|XS|S|M|L|XL|XXL|XXXL|\d{1,2}|M\dP\d)$/;
const sizeTokens = (text) => String(text || '').toUpperCase().replace(/\s+/g, '').split(/[-/·,]/).filter((t) => SIZE_TOKEN.test(t));

/** SKU: primer bloque (código), sufijo xN (pares) y talles (PFOS parseSku). */
export function parseSku(sku) {
  const segs = String(sku || '').trim().toUpperCase().split('-').map((s) => s.trim()).filter(Boolean);
  const m = /^([A-Z]{2,6}\d{1,4}[A-Z]?)$/.exec((segs[0] || '').replace(/\s+/g, ''));
  const ns = segs.slice(1).map((s) => /^X(\d{1,2})$/.exec(s)).filter(Boolean).map((x) => Number(x[1]));
  const sizes = segs.slice(1).filter((s) => SIZE_TOKEN.test(s));
  for (let i = 1; i + 1 < segs.length; i++) if (/^M\d$/.test(segs[i]) && /^P\d$/.test(segs[i + 1])) sizes.push(segs[i] + segs[i + 1]);
  return { block: m ? m[1] : null, ns, sizes };
}

/**
 * Propuesta automática de PFOS (diseño v38.3, 4.4): { estado: 'automático'|'dudoso'|'excluido'|'sin datos', motivo, components }.
 * En PFOS nunca se guarda sola; FiscalOS la usa solo si es 'automático' y lo marca así en el costo.
 */
export function proponerMapeo({ sku, unitPrice = null, variation = null }, items) {
  const out = (estado, motivo, extra = {}) => ({ estado, motivo, components: [], ratio: null, ...extra });
  if (!sku || !String(sku).trim()) return out('sin datos', 'la venta no tiene SKU');
  if (!items || !items.length) return out('sin datos', 'no hay una lista de precios cargada');
  const p = parseSku(sku);
  if (!p.block) return out('sin datos', 'el SKU no empieza con un código de la lista');
  const codes = new Map();
  for (const it of items) { const k = keyOf(it.code); if (!codes.has(k)) codes.set(k, []); codes.get(k).push(it); }
  const keys = codes.has(p.block) ? [p.block] : [...codes.keys()].filter((k) => k.length === p.block.length + 1 && k.startsWith(p.block) && /[A-Z]$/.test(k));
  if (!keys.length) return out('sin datos', `el código ${p.block} no está en la lista`);
  if (keys.length > 1) return out('dudoso', `más de un código de la lista coincide con ${p.block}: ${keys.join(', ')}`);
  const rows = codes.get(keys[0]);
  if (p.ns.length > 1) return out('dudoso', 'el SKU tiene más de un sufijo xN');
  const n = p.ns[0] || 1;
  const special = rows.filter((r) => r.presentation !== 'PAR');
  if (special.length) return out('excluido', `${rows[0].code} figura como ${[...new Set(special.map((r) => r.presentation))].join(', ')}: necesita la composición confirmada en PFOS`);
  let row = rows.length === 1 ? rows[0] : null;
  if (!row) {
    const want = new Set([...p.sizes, ...sizeTokens(variation)]);
    const hits = rows.filter((r) => sizeTokens(r.size).some((t) => want.has(t)));
    if (hits.length !== 1) return out('dudoso', `${rows[0].code} tiene precio por talle y no se pudo saber el talle de esta venta`);
    row = hits[0];
  }
  const components = [{ code: row.code, presentation: row.presentation, size: row.size, row: row.row, units: n, pairs: n }];
  const ratio = isNum(unitPrice) && isNum(row.price_suggested) && row.price_suggested > 0 ? round(unitPrice / (n * row.price_suggested), 3) : null;
  if (ratio !== null && (ratio < PLAUSIBLE[0] || ratio > PLAUSIBLE[1])) {
    return { estado: 'dudoso', motivo: `el precio de venta no coincide con ${n} par(es) de ${row.code} (relación ${ratio} con el sugerido)`, components, ratio };
  }
  return { estado: 'automático', motivo: `${row.code}, ${n} par(es)`, components, ratio };
}

/** Fila de la lista para un componente: mismo código y presentación; si hay varias, el mismo talle (PFOS rowFor). */
export function filaPara(componente, items) {
  const same = (items || []).filter((it) => keyOf(it.code) === keyOf(componente.code) && it.presentation === componente.presentation);
  if (same.length <= 1) return same[0] || null;
  return same.find((it) => (it.size || null) === (componente.size || null)) || null;
}

/** La decisión confirmada de un SKU vigente un día (PFOS mappingFor). */
export function mapeoVigente(versiones, dia) {
  const ok = (versiones || []).filter((v) => !v.valid_from || v.valid_from <= dia)
    .sort((a, b) => String(b.valid_from || '').localeCompare(String(a.valid_from || '')) || b.version - a.version);
  return ok[0] || null;
}

/** Costo SIN IVA de una línea: { valor, detalle } o { valor: null, motivo }. Nunca un 0 supuesto. */
export function costoLinea({ cantidad, componentes, items }) {
  if (!isNum(cantidad) || cantidad <= 0) return { valor: null, motivo: 'la línea no tiene cantidad' };
  if (!componentes || !componentes.length) return { valor: null, motivo: 'sin mapeo' };
  let porUnidad = 0;
  for (const c of componentes) {
    const row = filaPara(c, items);
    if (!row) return { valor: null, motivo: `${c.code} (${c.presentation}${c.size ? `, ${c.size}` : ''}) no está en la lista` };
    if (row.factor == null) return { valor: null, motivo: `${row.code}: la lista no tiene su descuento` };
    porUnidad += c.units * Number(row.price) * Number(row.factor);
  }
  return { valor: round(cantidad * porUnidad), porUnidad };
}
