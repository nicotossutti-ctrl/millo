/**
 * Reconstrucción de comprobantes emitidos con reporte de integridad.
 *
 * WSFEv1 no lista por fecha: da el último número autorizado por punto de venta y tipo, y
 * consulta de a uno. ARCA exige que la fecha de cada comprobante sea mayor o igual a la del
 * anterior de la misma serie, así que la fecha es no decreciente con el número. Eso permite:
 *
 *   modo "rango" (default): búsqueda binaria del primer número con fecha >= desde y recorrido
 *   CONSECUTIVO de todos los números desde ahí hasta el último. Se verifica el supuesto: el
 *   número anterior al primero debe ser más viejo que "desde", y ningún comprobante recorrido
 *   puede ser más viejo. Si algo lo contradice, el reporte marca completo=false.
 *
 *   modo "completo" (--completo): recorre 1..último. Sin supuestos, más lento, sirve para
 *   la primera carga histórica o para verificar el modo rango.
 *
 * En ambos modos el reporte dice exactamente qué series se recorrieron, qué números se
 * consultaron, cuáles no existen, cuáles fallaron y cuál es la cobertura. Una corrida sin
 * errores y sin contradicciones es la única que se considera completa, y aun así solo cubre
 * lo autorizado por WSFEv1 / Comprobantes en Línea: no cubre WSMTXCA ni WSFEX.
 */
import fs from 'node:fs';
import path from 'node:path';
import { toCsv, fechaArca } from './csv.js';

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
const CACHE_VERSION = 2;

// ---------- cache por entorno y CUIT ----------

function cacheFile(cfg, ptoVta, tipo, nro) {
  return path.join(cfg.outDir, 'cache', cfg.env, cfg.cuit, `${ptoVta}-${tipo}-${nro}.json`);
}

function cacheValido(entry, cfg) {
  if (!entry || entry.v !== CACHE_VERSION || entry.cuit !== cfg.cuit) return false;
  const c = entry.comprobante;
  if (c === null) return true;
  return typeof c?.cbteFch === 'string' && /^\d{8}$/.test(c.cbteFch) && typeof c.impTotal === 'number';
}

export async function consultarCached(wsfe, cfg, ptoVta, tipo, nro, stats) {
  const f = cacheFile(cfg, ptoVta, tipo, nro);
  if (fs.existsSync(f)) {
    try {
      const entry = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (cacheValido(entry, cfg)) {
        if (stats) stats.cache++;
        return entry.comprobante;
      }
    } catch { /* cache corrupto: se vuelve a consultar */ }
  }
  const c = await wsfe.consultar(ptoVta, tipo, nro); // los errores no se cachean
  if (stats) stats.arca++;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ v: CACHE_VERSION, cuit: cfg.cuit, env: cfg.env, consultadoEn: new Date().toISOString(), comprobante: c }));
  return c;
}

// ---------- validaciones por comprobante ----------

function fechaValida(s) {
  if (!/^\d{8}$/.test(s)) return false;
  const y = +s.slice(0, 4); const m = +s.slice(4, 6); const d = +s.slice(6, 8);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function validarComprobante(c) {
  const problemas = [];
  if (!fechaValida(c.cbteFch)) problemas.push(`fecha inválida ${c.cbteFch}`);
  const suma = c.impNeto + c.impIva + c.impTrib + c.impOpEx + c.impTotConc;
  if (Math.abs(suma - c.impTotal) > 0.02) problemas.push(`total ${c.impTotal} ≠ suma de componentes ${suma.toFixed(2)}`);
  if (c.iva.length) {
    const sumaIva = c.iva.reduce((s, a) => s + a.importe, 0);
    if (Math.abs(sumaIva - c.impIva) > 0.02) problemas.push(`IVA ${c.impIva} ≠ detalle por alícuota ${sumaIva.toFixed(2)}`);
  }
  if (!c.monId) problemas.push('sin moneda');
  else if (c.monId !== 'PES' && !(c.monCotiz > 0)) problemas.push(`moneda ${c.monId} sin cotización`);
  if (c.resultado && c.resultado !== 'A') problemas.push(`resultado ${c.resultado}`);
  if (c.cbteDesde !== c.cbteHasta) problemas.push(`lote ${c.cbteDesde}-${c.cbteHasta}`);
  return problemas;
}

// ---------- recorrido ----------

/**
 * Menor número con fecha >= desde, por búsqueda binaria (fecha no decreciente con el número).
 * Si un número no existe, se prueba hacia arriba hasta `salto` números antes de asumir que
 * ese tramo es anterior.
 */
export async function buscarPrimero(consultar, ultimo, desde, { salto = 25 } = {}) {
  let lo = 1; let hi = ultimo; let primero = ultimo + 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    let c = null; let n = mid;
    while (c === null && n <= Math.min(hi, mid + salto)) { c = await consultar(n); if (c === null) n++; }
    if (c === null) { lo = mid + salto + 1; continue; }
    if (c.cbteFch >= desde) { primero = n; hi = mid - 1; } else lo = n + 1;
  }
  return primero;
}

async function recorrerSerie(wsfe, cfg, pto, tipo, d, h, modo, log, stats) {
  const serie = {
    ptoVta: pto, tipo, desc: TIPO_DESC[tipo] ?? '', ultimo: null,
    primeroRecorrido: null, ultimoRecorrido: null, consultados: 0,
    encontrados: 0, enRango: 0, inexistentes: [], errores: [], fueraDeOrden: [], inconsistentes: [],
    cobertura: null, completa: false, comprobantes: [],
  };
  try {
    serie.ultimo = await wsfe.ultimoAutorizado(pto, tipo);
  } catch (e) {
    serie.errores.push({ nro: null, paso: 'ultimoAutorizado', msg: e.message });
    return serie;
  }
  if (!serie.ultimo) { serie.completa = true; serie.cobertura = 1; return serie; }

  const consultar = async (n) => consultarCached(wsfe, cfg, pto, tipo, n, stats);
  let primero = 1;
  if (modo === 'rango') {
    try {
      primero = await buscarPrimero(consultar, serie.ultimo, d);
    } catch (e) {
      serie.errores.push({ nro: null, paso: 'buscarPrimero', msg: e.message });
      return serie;
    }
    // Verificación del supuesto de orden: el anterior al primero debe ser más viejo que "desde".
    if (primero > 1 && primero <= serie.ultimo) {
      try {
        const prev = await consultar(primero - 1);
        if (prev && prev.cbteFch >= d) serie.fueraDeOrden.push(primero - 1);
      } catch (e) {
        serie.errores.push({ nro: primero - 1, paso: 'verificacion', msg: e.message });
      }
    }
  }
  if (primero > serie.ultimo) {
    serie.primeroRecorrido = serie.ultimoRecorrido = null;
    serie.completa = serie.errores.length === 0;
    serie.cobertura = 1;
    log(`PV ${pto} ${serie.desc || `tipo ${tipo}`}: último ${serie.ultimo}, nada en el rango`);
    return serie;
  }

  serie.primeroRecorrido = primero;
  serie.ultimoRecorrido = serie.ultimo;
  log(`PV ${pto} ${serie.desc || `tipo ${tipo}`}: último ${serie.ultimo}, recorriendo ${primero}..${serie.ultimo}`);
  let fchAnterior = '';
  for (let n = primero; n <= serie.ultimo; n++) {
    serie.consultados++;
    let c;
    try {
      c = await consultar(n);
    } catch (e) {
      serie.errores.push({ nro: n, paso: 'consultar', msg: e.message });
      continue;
    }
    if (c === null) { serie.inexistentes.push(n); continue; }
    serie.encontrados++;
    // Monotonía: una fecha menor que la del número anterior, o (en modo rango) anterior a
    // "desde", contradice el supuesto con el que se eligió dónde empezar.
    if (c.cbteFch < fchAnterior || (modo === 'rango' && c.cbteFch < d)) serie.fueraDeOrden.push(n);
    fchAnterior = c.cbteFch > fchAnterior ? c.cbteFch : fchAnterior;
    if (c.cbteFch < d || c.cbteFch > h) continue;
    const problemas = validarComprobante(c);
    if (problemas.length) serie.inconsistentes.push(n);
    serie.enRango++;
    serie.comprobantes.push({ ...c, validaciones: problemas });
  }
  serie.cobertura = serie.consultados ? (serie.consultados - serie.errores.filter((e) => e.nro !== null).length) / serie.consultados : 1;
  serie.completa = serie.errores.length === 0 && serie.fueraDeOrden.length === 0;
  return serie;
}

// ---------- notas de crédito ----------

/** Marca facturas anuladas por notas de crédito que las referencian por el total. */
export function aplicarNotasDeCredito(rows) {
  const key = (t, p, n) => `${t}-${p}-${n}`;
  const porClave = new Map(rows.map((r) => [key(r.cbteTipo, r.ptoVta, r.cbteDesde), r]));
  for (const r of rows) { r.anuladoPor = []; r.totalAnulado = 0; r.anulado = false; }
  for (const nc of rows) {
    if (signo(nc.cbteTipo) !== -1) continue;
    for (const a of nc.cbtesAsoc) {
      const f = porClave.get(key(a.tipo, a.ptoVta, a.nro));
      if (!f) continue;
      f.anuladoPor.push(key(nc.cbteTipo, nc.ptoVta, nc.cbteDesde));
      f.totalAnulado += nc.impTotal;
    }
  }
  for (const r of rows) if (r.totalAnulado >= r.impTotal - 0.01 && r.anuladoPor.length) r.anulado = true;
  return rows;
}

// ---------- entrada principal ----------

export async function exportarEmitidos(wsfe, cfg, { desde, hasta, tipos, ptos, completo = false, log = () => {} }) {
  const d = ymd(desde); const h = ymd(hasta);
  if (d > h) throw new Error('--desde es posterior a --hasta');
  const modo = completo ? 'completo' : 'rango';
  const stats = { cache: 0, arca: 0 };

  const puntosVenta = await wsfe.ptosVenta();
  // Bloqueados y dados de baja se recorren igual: pueden tener historia en el período.
  const puntos = ptos?.length ? ptos : puntosVenta.map((p) => p.nro);
  const advertencias = [];
  for (const p of ptos ?? []) if (!puntosVenta.some((x) => x.nro === p)) advertencias.push(`Punto de venta ${p} pedido por parámetro pero no informado por WSFE.`);
  if (!puntos.length) throw new Error('WSFE no informa puntos de venta y no se pasó --pto.');

  const tiposArca = await wsfe.tiposCbte();
  const tiposARecorrer = tipos?.length ? tipos : tiposArca.filter((t) => !t.fchHasta).map((t) => t.id);
  if (!tipos?.length) advertencias.push('Se recorrieron todos los tipos vigentes informados por WSFE; los tipos no vigentes en el período quedaron afuera.');
  advertencias.push('WSFEv1 solo cubre comprobantes autorizados por WSFEv1 y Comprobantes en Línea. No cubre WSMTXCA (detalle de ítems), WSFEX (exportación) ni CAEA. Validar contra Mis Comprobantes.');

  const series = [];
  for (const pto of puntos) {
    for (const tipo of tiposARecorrer) {
      series.push(await recorrerSerie(wsfe, cfg, pto, tipo, d, h, modo, log, stats));
    }
  }

  const rows = aplicarNotasDeCredito(series.flatMap((s) => s.comprobantes));
  rows.sort((a, b) => a.cbteFch.localeCompare(b.cbteFch) || a.ptoVta - b.ptoVta || a.cbteTipo - b.cbteTipo || a.cbteDesde - b.cbteDesde);

  const reporte = {
    cuit: cfg.cuit, entorno: cfg.env, desde, hasta, modo, generado: new Date().toISOString(),
    puntosVenta, puntosRecorridos: puntos,
    tipos: tiposARecorrer.map((id) => ({ id, desc: tiposArca.find((t) => t.id === id)?.desc ?? TIPO_DESC[id] ?? '' })),
    consultas: stats,
    series: series.map(({ comprobantes, ...s }) => s),
    totales: {
      series: series.length,
      consultados: series.reduce((n, s) => n + s.consultados, 0),
      encontrados: series.reduce((n, s) => n + s.encontrados, 0),
      enRango: rows.length,
      inexistentes: series.reduce((n, s) => n + s.inexistentes.length, 0),
      errores: series.reduce((n, s) => n + s.errores.length, 0),
      fueraDeOrden: series.reduce((n, s) => n + s.fueraDeOrden.length, 0),
      inconsistentes: series.reduce((n, s) => n + s.inconsistentes.length, 0),
      anulados: rows.filter((r) => r.anulado).length,
      totalConSigno: Math.round(rows.reduce((s, r) => s + r.impTotal * signo(r.cbteTipo), 0) * 100) / 100,
    },
    completo: series.every((s) => s.completa),
    advertencias,
  };
  if (!reporte.completo) advertencias.unshift('HISTORIAL INCOMPLETO: hay series con errores o con fechas fuera de orden. No usar para conciliar hasta resolverlo (ver series[].errores y fueraDeOrden; probar --completo).');
  return { rows, reporte };
}

export function resumenReporte(r) {
  const l = [];
  l.push(`${r.completo ? 'COMPLETO' : 'INCOMPLETO'} · ${r.entorno} · ${r.desde} a ${r.hasta} · modo ${r.modo}`);
  l.push(`Puntos de venta recorridos: ${r.puntosRecorridos.join(', ')} (WSFE informa ${r.puntosVenta.map((p) => `${p.nro}${p.bloqueado ? ' bloqueado' : ''}${p.fchBaja ? ' baja' : ''}`).join(', ') || 'ninguno'})`);
  l.push(`Tipos: ${r.tipos.map((t) => t.id).join(', ')}`);
  const t = r.totales;
  l.push(`Consultados ${t.consultados} números en ${t.series} series (${r.consultas.arca} a ARCA, ${r.consultas.cache} de cache): ${t.encontrados} encontrados, ${t.enRango} en el rango, ${t.inexistentes} inexistentes, ${t.errores} errores, ${t.fueraDeOrden} fuera de orden, ${t.inconsistentes} inconsistentes, ${t.anulados} anulados por NC.`);
  for (const s of r.series.filter((x) => x.consultados || x.errores.length)) {
    l.push(`  PV ${s.ptoVta} ${s.desc || `tipo ${s.tipo}`}: último ${s.ultimo}, recorrido ${s.primeroRecorrido ?? '-'}..${s.ultimoRecorrido ?? '-'}, en rango ${s.enRango}, cobertura ${(100 * (s.cobertura ?? 0)).toFixed(1)}%${s.errores.length ? `, ERRORES ${s.errores.length}` : ''}${s.fueraDeOrden.length ? `, FUERA DE ORDEN ${s.fueraDeOrden.join(',')}` : ''}`);
  }
  for (const a of r.advertencias) l.push(`! ${a}`);
  return l;
}

// ---------- salida ----------

const totalArs = (r) => (r.monId === 'PES' || !r.monCotiz ? r.impTotal : r.impTotal * r.monCotiz);

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
  { header: 'IVA 21%', value: (r) => r.iva.filter((a) => a.id === 5).reduce((s, a) => s + a.importe, 0) },
  { header: 'IVA 10,5%', value: (r) => r.iva.filter((a) => a.id === 4).reduce((s, a) => s + a.importe, 0) },
  { header: 'IVA 27%', value: (r) => r.iva.filter((a) => a.id === 6).reduce((s, a) => s + a.importe, 0) },
  { header: 'Otros Tributos', value: (r) => r.impTrib },
  { header: 'Total', value: (r) => r.impTotal },
  { header: 'Signo', value: (r) => signo(r.cbteTipo) },
  { header: 'Total c/signo', value: (r) => r.impTotal * signo(r.cbteTipo) },
  { header: 'Total ARS c/signo', value: (r) => totalArs(r) * signo(r.cbteTipo) },
  { header: 'Asociados', value: (r) => r.cbtesAsoc.map((a) => `${a.tipo}-${a.ptoVta}-${a.nro}`).join(' ') },
  { header: 'Anulado por NC', value: (r) => (r.anuladoPor ?? []).join(' ') },
  { header: 'Estado', value: (r) => (r.validaciones?.length ? 'INCONSISTENTE' : r.anulado ? 'ANULADO' : 'OK') },
  { header: 'Validaciones', value: (r) => (r.validaciones ?? []).join(' | ') },
  { header: 'Resultado', value: (r) => r.resultado },
];

export function escribirCsv(cfg, rows, file) {
  const out = path.resolve(file ?? path.join(cfg.outDir, 'emitidos.csv'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, toCsv(rows, COLUMNAS_EMITIDOS));
  return out;
}

export function escribirReporte(cfg, reporte, file) {
  const out = path.resolve(file ?? path.join(cfg.outDir, `integridad-${reporte.desde}-${reporte.hasta}.json`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(reporte, null, 2));
  return out;
}
