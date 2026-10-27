/**
 * Costo de la mercadería según las reglas de PFOS, portadas de pfos-ml/lib/metrics_costs.js (commit 7ac8b62):
 * listFor, parseSku, proposeMapping, rowFor, mappingFor y el costo de una línea. Funciones puras (sin base ni red).
 *
 * Diferencias con PFOS, a propósito:
 *  - FiscalOS es de UN contribuyente responsable inscripto (PALERMO): el costo va siempre SIN IVA. No hay tabla de
 *    cuentas ni regímenes en el código (el repositorio es público).
 *  - Si no hay lista vigente a la fecha de la venta, se usa la PRIMERA lista posterior, marcada «lista posterior a la
 *    venta» (docs/rentabilidad-DISENO.md de PFOS, sección 13). Nunca se presenta como costo real de esa fecha.
 *  - La propuesta automática aplica TODAS las reglas de la sección 3.7 del diseño de PFOS (equivalencias confirmadas, código
 *    sin la última letra, xN, colores con «+», combos, par o paquete según el precio y discontinuados), no solo las de la
 *    v38.3. Lo que una regla no resuelve con certeza queda «para revisión», con el motivo; nunca se completa con supuestos.
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
const CODIGO = /^[A-ZÑ]+\d*[A-Z]?$/;

/**
 * SKU: códigos del primer bloque (uno, o varios unidos con «+» o pegados en un combo), sufijos xN, colores unidos con «+»
 * y talles. Ej.: ME62+ME19-AERO+NEGRO-M → códigos [ME62, ME19], colores 2, talle M.
 */
export function parseSku(sku) {
  const segs = String(sku || '').trim().toUpperCase().split('-').map((s) => s.trim()).filter(Boolean);
  const primero = (segs[0] || '').replace(/\s+/g, '');
  const codigos = primero ? primero.split('+').filter(Boolean) : [];
  const resto = segs.slice(1);
  const ns = resto.map((s) => /^X(\d{1,2})$/.exec(s)).filter(Boolean).map((x) => Number(x[1]));
  const sizes = resto.filter((s) => SIZE_TOKEN.test(s));
  for (let i = 0; i + 1 < resto.length; i++) if (/^M\d$/.test(resto[i]) && /^P\d$/.test(resto[i + 1])) sizes.push(resto[i] + resto[i + 1]);
  const conMas = resto.filter((s) => s.includes('+'));
  return { block: codigos.length === 1 && CODIGO.test(codigos[0]) ? codigos[0] : null, codigos, ns, sizes,
    colores: conMas.length ? conMas[0].split('+').filter(Boolean).length : null, gruposDeColores: conMas.length };
}

/**
 * Equivalencias confirmadas por Nicolás (PFOS, docs/rentabilidad-DISENO.md 3.7, regla 1): cada grupo son nombres del mismo
 * artículo de la lista. Una equivalencia dice QUÉ artículo es, no cuántas unidades de la lista lleva la venta.
 */
export const EQUIVALENCIAS = [['VINCHA', 'VINCHA01'], ['MUÑE', 'MUÑEQUERA01'], ['TE172', 'TE75C'], ['DE160A', 'DE160C']];

/**
 * Artículos «A CONFIRMAR» de la lista cuya unidad SÍ está confirmada, por CÓDIGO (en la lista real la descripción viene
 * vacía). El precio es el de la lista; cada unidad vendida lleva una unidad de la lista:
 *  - manguitas y pantorrilleras, por par (regla 1 de la 3.7 de PFOS). Los códigos son los que PFOS tiene confirmados como
 *    esas familias (AUTOMATIZACION_ML_REGLAS_FIJAS.md: manguitas MA01C/MA10C/MA20C/MA21C/MA26C; familia «Pantorrilleras
 *    SOX» PA01C/PA10C/PA21C/PA26C/FUPA01C/FUPA02C/HOCKEY01);
 *  - VINCHA01, por unidad, y MUÑEQUERA01, por par (Nicolás, 28/10/2026).
 * Cualquier otro «A CONFIRMAR» queda pendiente, sin costo, hasta confirmarlo.
 */
export const UNIDAD_CONFIRMADA = new Map([
  ...['MA01C', 'MA10C', 'MA20C', 'MA21C', 'MA26C', 'PA01C', 'PA10C', 'PA21C', 'PA26C', 'FUPA01C', 'FUPA02C', 'HOCKEY01'].map((c) => [c, 'par']),
  ['VINCHA01', 'unidad'], ['MUÑEQUERA01', 'par'],
]);
const PACKS = new Set(['TRIPACK', 'BIPACK', 'PACK_SEMANAL', 'COMBO']);

/** Índice de la lista por código (sin espacios, en mayúsculas). */
export function indiceLista(items) {
  const codes = new Map();
  for (const it of items || []) { const k = keyOf(it.code); if (!codes.has(k)) codes.set(k, []); codes.get(k).push(it); }
  return codes;
}

const partesCodigo = (k) => { const m = /^([A-ZÑ]+)(\d+)([A-Z]?)$/.exec(k); return m ? { letras: m[1], numero: Number(m[2]) } : null; };
const firma = (rows) => rows.map((r) => [r.presentation, r.pairs ?? '', r.size ?? '', Number(r.price), r.factor ?? ''].join('|')).sort().join('#');

/**
 * Código del SKU → código de la lista (PFOS 3.7, reglas 1, 2 y 7). Devuelve { key, via } | { ambiguo } | null.
 *  1. El código tal cual, o un nombre equivalente confirmado.
 *  2. El código de la lista sin su última letra (ME23 = ME23C).
 *  7. Discontinuado: entre dos códigos de la lista (mismas letras, por número) con el mismo precio, presentación y
 *     descuento, toma ese costo.
 */
export function resolverCodigo(t, codes) {
  const k = keyOf(t);
  if (!k) return null;
  if (codes.has(k)) return { key: k, via: null };
  const sinLetra = (x) => [...codes.keys()].filter((c) => c.length === x.length + 1 && c.startsWith(x) && /[A-Z]$/.test(c));
  const grupo = EQUIVALENCIAS.find((g) => g.includes(k));
  if (grupo) {
    for (const otro of grupo.filter((x) => x !== k)) {
      if (codes.has(otro)) return { key: otro, via: `equivalencia ${k} = ${otro}` };
      const s = sinLetra(otro);
      if (s.length === 1) return { key: s[0], via: `equivalencia ${k} = ${otro}` };
    }
  }
  const s = sinLetra(k);
  if (s.length === 1) return { key: s[0], via: null };
  if (s.length > 1) return { ambiguo: s };
  const p = partesCodigo(k);
  if (p) {
    const vecinos = [...codes.keys()].map((c) => ({ c, p: partesCodigo(c) })).filter((x) => x.p && x.p.letras === p.letras && x.p.numero !== p.numero);
    const menores = vecinos.filter((x) => x.p.numero < p.numero); const mayores = vecinos.filter((x) => x.p.numero > p.numero);
    const nMenor = Math.max(...menores.map((x) => x.p.numero)); const nMayor = Math.min(...mayores.map((x) => x.p.numero));
    const abajo = menores.filter((x) => x.p.numero === nMenor); const arriba = mayores.filter((x) => x.p.numero === nMayor);
    if (abajo.length === 1 && arriba.length === 1 && firma(codes.get(abajo[0].c)) === firma(codes.get(arriba[0].c))) {
      return { key: abajo[0].c, via: `discontinuado entre ${abajo[0].c} y ${arriba[0].c} (mismo precio, presentación y descuento)` };
    }
  }
  return null;
}

/** Presentaciones utilizables de un código: [{ presentacion, pares, filas }]. «A CONFIRMAR» solo si su código tiene la unidad confirmada (una por unidad vendida). */
function presentaciones(rows) {
  const g = new Map(); const sinUsar = [];
  for (const r of rows) {
    let pares = null;
    if (r.presentation === 'PAR') pares = 1;
    else if (PACKS.has(r.presentation)) pares = Number.isInteger(r.pairs) && r.pairs > 0 ? r.pairs : null;
    else if (r.presentation === 'A_CONFIRMAR' && UNIDAD_CONFIRMADA.has(keyOf(r.code))) pares = 1;
    if (pares == null) { sinUsar.push(r.presentation); continue; }
    const k = `${r.presentation}|${pares}`;
    if (!g.has(k)) g.set(k, { presentacion: r.presentation, pares, filas: [] });
    g.get(k).filas.push(r);
  }
  return { grupos: [...g.values()], sinUsar: [...new Set(sinUsar)] };
}

/** Fila de una presentación para la venta: una sola, todas con el mismo costo, o la del talle. */
function filaDelTalle(filas, talles) {
  if (filas.length === 1) return { fila: filas[0] };
  if (new Set(filas.map((f) => `${Number(f.price)}|${f.factor}`)).size === 1) return { fila: filas[0] };
  const hits = filas.filter((r) => sizeTokens(r.size).some((t) => talles.has(t)));
  return hits.length === 1 ? { fila: hits[0] } : { motivo: `${filas[0].code} tiene precio por talle y no se pudo saber el talle de esta venta` };
}

const lejania = (r) => Math.abs(Math.log(r));
const costoDe = (comps) => comps.reduce((n, c) => n + c.units * Number(c._fila.price) * (c._fila.factor ?? NaN), 0);
const sugeridoDe = (comps) => (comps.every((c) => isNum(c._fila.price_suggested) && c._fila.price_suggested > 0) ? comps.reduce((n, c) => n + c.units * c._fila.price_suggested, 0) : null);

/**
 * Propuesta automática con las reglas de PFOS (docs/rentabilidad-DISENO.md 3.7). No inventa cantidades: cada lectura posible
 * del SKU (pares sueltos o paquetes, y cuántos) se compara con el precio de venta, y solo se elige si es la única plausible o
 * si las otras quedan claramente lejos. Devuelve { estado: 'automático'|'dudoso'|'sin datos', motivo, categoria, reglas,
 * components, ratio }. 'dudoso' = queda para revisión (presentación, cantidad, talle o precio que no cierra).
 */
export function proponerMapeo({ sku, unitPrice = null, variation = null }, items) {
  const out = (estado, categoria, motivo, extra = {}) => ({ estado, categoria, motivo, components: [], ratio: null, reglas: [], ...extra });
  if (!sku || !String(sku).trim()) return out('sin datos', 'sin SKU', 'la venta no tiene SKU');
  if (!items || !items.length) return out('sin datos', 'sin lista', 'no hay una lista de precios cargada');
  const codes = indiceLista(items);
  const p = parseSku(sku);
  if (!p.codigos.length) return out('sin datos', 'código fuera de la lista', 'el SKU no empieza con un código');
  if (p.ns.length > 1) return out('dudoso', 'cantidad ambigua', 'el SKU tiene más de un sufijo xN');
  if (p.gruposDeColores > 1) return out('dudoso', 'cantidad ambigua', 'el SKU tiene más de un grupo de colores con «+»');
  const reglas = [];
  // Códigos: cada parte del combo; una parte que no está puede ser un combo pegado (MA01PA01 = MA01 + PA01).
  const partes = [];
  for (const c of p.codigos) {
    if (!CODIGO.test(c) && !/^[A-ZÑ0-9]+$/.test(c)) return out('sin datos', 'código fuera de la lista', `el código ${c} no tiene la forma de un código de la lista`);
    const r = CODIGO.test(c) ? resolverCodigo(c, codes) : null;
    if (r?.ambiguo) return out('dudoso', 'código ambiguo', `más de un código de la lista coincide con ${c}: ${r.ambiguo.join(', ')}`);
    if (r) { partes.push(r.key); if (r.via) reglas.push(r.via); continue; }
    const cortes = [];
    for (let i = 2; i < c.length - 1; i++) {
      const a = c.slice(0, i); const b = c.slice(i);
      if (!CODIGO.test(a) || !CODIGO.test(b) || !/\d/.test(a) || !/\d/.test(b)) continue;
      const ra = resolverCodigo(a, codes); const rb = resolverCodigo(b, codes);
      if (ra?.key && rb?.key) cortes.push([ra, rb]);
    }
    if (cortes.length === 1) { partes.push(cortes[0][0].key, cortes[0][1].key); reglas.push(`combo ${c} = ${cortes[0][0].key} + ${cortes[0][1].key}`); continue; }
    if (cortes.length > 1) return out('dudoso', 'combo', `el combo ${c} se puede partir de más de una forma`);
    return out('sin datos', 'código fuera de la lista', `el código ${c} no está en la lista`);
  }
  const combo = partes.length > 1;
  if (combo && p.codigos.length > 1) reglas.push(`combo ${p.codigos.join(' + ')}`);
  const N = p.ns[0] ?? null; const C = p.colores && p.colores > 1 ? p.colores : null;
  if (combo && N) return out('dudoso', 'combo', 'combo con sufijo xN: no se sabe si multiplica el combo o una parte');
  if (combo && C && C !== partes.length) return out('dudoso', 'combo', `combo de ${partes.length} artículos con ${C} colores`);
  if (!combo && N && C && N % C !== 0) return out('dudoso', 'cantidad ambigua', `x${N} con ${C} colores: no se reparte en partes iguales`);
  if (N) reglas.push(`x${N}`);
  if (!combo && C && !N) reglas.push(`${C} colores con «+», uno por color`);
  const talles = new Set([...p.sizes, ...sizeTokens(variation)]);

  // Lecturas posibles de cada parte: [{ comps }]. Pares pedidos: xN, o un par por color, o sin cantidad (una unidad).
  const lecturasParte = (key, paresPedidos, explicito) => {
    const { grupos, sinUsar } = presentaciones(codes.get(key));
    const lecturas = []; let motivoTalle = null;
    for (const g of grupos) {
      const unidades = new Set();
      if (!explicito) unidades.add(1); // sin cantidad en el SKU: una unidad de la presentación
      else {
        if (g.pares === 1) unidades.add(paresPedidos);
        else {
          if (paresPedidos % g.pares === 0) unidades.add(paresPedidos / g.pares); // xN = pares, en paquetes
          if (N) unidades.add(N); // xN = paquetes
        }
      }
      const t = filaDelTalle(g.filas, talles);
      if (!t.fila) { motivoTalle = t.motivo; continue; }
      for (const u of unidades) {
        lecturas.push({ code: t.fila.code, presentation: t.fila.presentation, size: t.fila.size ?? null, row: t.fila.row, units: u, pairs: u * g.pares, _fila: t.fila });
      }
    }
    return { lecturas, sinUsar, motivoTalle };
  };

  let opciones;
  if (combo) {
    // Combo: un par de cada parte (o un color por parte): la suma de sus partes.
    const porParte = partes.map((k) => ({ k, ...lecturasParte(k, 1, true) }));
    for (const x of porParte) {
      if (x.sinUsar.length) return out('dudoso', 'a confirmar en la lista', `${x.k} figura en la lista como ${x.sinUsar.join(', ')} y su unidad no está confirmada: queda pendiente hasta confirmarlo en PFOS`, { reglas });
      const pares = x.lecturas.filter((l) => l.pairs === 1);
      if (!pares.length) {
        if (x.motivoTalle) return out('dudoso', 'talle', x.motivoTalle);
        return out('dudoso', 'presentación ambigua', `${x.k} no está por par en la lista${x.sinUsar.length ? ` (figura como ${x.sinUsar.join(', ')})` : ''}`);
      }
      if (new Set(pares.map((l) => `${Number(l._fila.price)}|${l._fila.factor}`)).size > 1) return out('dudoso', 'presentación ambigua', `${x.k} tiene más de una fila por par con costos distintos`);
      x.elegida = pares[0];
    }
    opciones = [porParte.map((x) => x.elegida)];
  } else {
    const explicito = N != null || C != null;
    const r = lecturasParte(partes[0], N ?? C ?? 1, explicito);
    // Una fila de la lista sin unidad confirmada («A CONFIRMAR» que no es manguita ni pantorrillera, o un paquete sin pares)
    // puede ser justo lo que se vendió: no se elige otra fila en su lugar.
    if (!r.lecturas.length || r.sinUsar.length) {
      if (r.motivoTalle && !r.sinUsar.length) return out('dudoso', 'talle', r.motivoTalle);
      return out('dudoso', 'a confirmar en la lista', `${partes[0]} figura en la lista como ${r.sinUsar.join(', ') || 'una presentación sin pares'} y su unidad no está confirmada: queda pendiente hasta confirmarlo en PFOS (Costos de la mercadería)`, { reglas });
    }
    opciones = r.lecturas.map((l) => [l]);
  }

  // Elección por precio (regla 6): la lectura con el precio de venta más parecido al sugerido de la lista; las otras, si dan
  // otro costo u otra cantidad de pares, tienen que quedar claramente lejos (1,5 veces más lejos o más).
  const evaluadas = opciones.map((comps) => {
    const sug = sugeridoDe(comps);
    return { comps, costo: costoDe(comps), pares: comps.reduce((n, c) => n + c.pairs, 0), ratio: isNum(unitPrice) && sug ? round(unitPrice / sug, 3) : null };
  });
  if (evaluadas.some((e) => !Number.isFinite(e.costo))) {
    const sinDesc = evaluadas.find((e) => !Number.isFinite(e.costo)).comps.find((c) => c._fila.factor == null);
    if (evaluadas.length === 1) return out('sin datos', 'lista sin descuento', `${sinDesc._fila.code}: la lista no tiene su descuento`);
  }
  const validas = evaluadas.filter((e) => Number.isFinite(e.costo));
  const limpiar = (comps) => comps.map(({ _fila, ...c }) => c);
  const iguales = (a, b) => a.pares === b.pares && Math.abs(a.costo - b.costo) <= 0.1 * Math.max(a.costo, b.costo);
  let elegida;
  if (validas.length === 1) elegida = validas[0];
  else {
    if (validas.some((e) => e.ratio == null)) {
      if (validas.every((e) => iguales(e, validas[0]))) elegida = validas[0];
      else return out('dudoso', 'presentación ambigua', `${partes[0]}: par o paquete, y la lista no tiene precio sugerido para decidir`);
    } else {
      const orden = [...validas].sort((a, b) => lejania(a.ratio) - lejania(b.ratio));
      const [mejor, ...otras] = orden;
      const lejos = otras.every((o) => iguales(o, mejor) || lejania(o.ratio) - lejania(mejor.ratio) >= Math.log(1.5));
      if (!lejos) {
        const desc = orden.slice(0, 2).map((e) => `${e.comps.map((c) => `${c.units} ${c.presentation.toLowerCase()}`).join(' + ')} (relación ${e.ratio})`).join(' o ');
        return out('dudoso', 'presentación ambigua', `${partes[0]}: el precio no distingue entre ${desc}`);
      }
      elegida = mejor;
      if (otras.some((o) => !iguales(o, mejor))) reglas.push(`${mejor.comps.map((c) => c.presentation.toLowerCase()).join(' + ')} por precio`);
    }
  }
  if (elegida.ratio !== null && (elegida.ratio < PLAUSIBLE[0] || elegida.ratio > PLAUSIBLE[1])) {
    return { ...out('dudoso', 'precio no coincide', `el precio de venta no coincide con ${elegida.pares} par(es) de ${partes.join(' + ')} (relación ${elegida.ratio} con el sugerido)`),
      components: limpiar(elegida.comps), ratio: elegida.ratio, reglas };
  }
  for (const c of elegida.comps.filter((x) => x.presentation === 'A_CONFIRMAR')) reglas.push(`${keyOf(c.code)} «a confirmar»: por ${UNIDAD_CONFIRMADA.get(keyOf(c.code))} (confirmado)`);
  const unidad = (c) => (c.presentation === 'PAR' ? 'par(es)' : c.presentation === 'A_CONFIRMAR' ? (UNIDAD_CONFIRMADA.get(keyOf(c.code)) === 'unidad' ? 'unidad(es)' : 'par(es)') : c.presentation.toLowerCase());
  const desc = elegida.comps.map((c) => `${c.units} ${unidad(c)} de ${c.code}`).join(' + ');
  return { estado: 'automático', categoria: null, motivo: desc, components: limpiar(elegida.comps), ratio: elegida.ratio, reglas };
}

/** Fila de la lista para un componente: mismo código y presentación; si hay varias, el mismo talle (PFOS rowFor). */
export function filaPara(componente, items) {
  const same = (items || []).filter((it) => keyOf(it.code) === keyOf(componente.code) && it.presentation === componente.presentation);
  const porFila = componente.row != null ? same.find((it) => it.row === componente.row) : null;
  if (porFila) return porFila;
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
