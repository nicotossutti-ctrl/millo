/**
 * Rentabilidad mensual de la distribuidora: cuánto ganó cada MES DE FACTURACIÓN, qué impuestos generó
 * esa actividad, qué pagos de impuestos salieron de caja en el mes (de cualquier período) y qué
 * obligaciones futuras dejó. No abre ARCA ni modifica extractores: usa lo conservado, lo importado y
 * lo cargado a mano.
 *
 * Reglas:
 *  - UNA fuente por concepto y mes, en este orden: carga manual > archivo importado > PFOS > ARCA
 *    (proveedores clasificados). Las demás fuentes disponibles se muestran como referencia y NUNCA se
 *    suman: así un mismo gasto que está en PFOS, en el reporte de Mercado Libre y en una factura de
 *    proveedor no se cuenta dos veces.
 *  - El costo de la mercadería vendida (CMV) NO se reemplaza por las compras del mes: con stock son
 *    cosas distintas. Las compras de mercadería se muestran solo como referencia.
 *  - El IVA no es gasto: va en "impuestos generados" y en caja, no en el resultado económico.
 *  - Con datos faltantes se muestran resultados PARCIALES, rotulados como tales; nunca como
 *    rentabilidad neta definitiva.
 */
import fs from 'node:fs';
import path from 'node:path';
import { tablaDe, resumenComprobantes } from '../informeIva.js';
import { leerManifiesto, decodificar } from '../portal/misComprobantes.js';
import { leerZipDesdeArchivo } from '../portal/zip.js';
import { importeDe } from '../portal/ivaDdjj.js';
import { fechaIso } from '../portal/calidad.js';
import { importadoDelMes, CONCEPTOS } from './importar.js';
import { manualesDelMes, leerClasificacion, CLASES_PROVEEDOR, sugerirClase } from './manuales.js';
import { obtenerPfos } from './integraciones.js';

const r2 = (x) => Math.round(x * 100) / 100;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const col = (headers, re) => headers.findIndex((h) => re.test(norm(h)));
const finDeMes = (mes) => { const [y, m] = mes.split('-'); return new Date(Date.UTC(+y, +m, 0)).toISOString().slice(0, 10); };
const NOTAS_CREDITO = new Set([3, 8, 13, 53, 113, 203, 208, 213]);

export const cifra = (valor, nivel, fuente = null, nota = null) => ({ valor: valor == null ? null : r2(valor), nivel: valor == null ? 'faltante' : nivel, fuente, nota });
const faltante = (nota) => ({ valor: null, nivel: 'faltante', fuente: null, nota });

// ---------------- Mis Comprobantes (texto del tramo que cubre el mes, con caché) ----------------

const cacheTexto = new Map();
/** Texto CSV del tramo verificado de Mis Comprobantes que cubre el mes completo; null si no hay. */
export function textoComprobantes(datosDir, id, tipo, mes) {
  const dirFuente = path.join(datosDir, id);
  const ini = `${mes}-01`; const fin = finDeMes(mes);
  for (const [k, v] of Object.entries(leerManifiesto(dirFuente))) {
    const [t, d, h] = k.split(':');
    if (t !== tipo || !v?.ok || !v.archivo || d > ini || h < fin) continue;
    const f = path.join(dirFuente, v.archivo);
    let mtime = 0; try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
    const clave = `${f}|${mtime}`;
    if (!cacheTexto.has(clave)) {
      cacheTexto.set(clave, /\.zip$/i.test(f) ? leerZipDesdeArchivo(f).filter((e) => /\.csv$/i.test(e.name)).map((e) => decodificar(e.data)).join('\n') : decodificar(fs.readFileSync(f)));
    }
    return { texto: cacheTexto.get(clave), fecha: v.fecha, fuente: `${id} (apto, ${v.fecha})` };
  }
  return null;
}

/** Resumen de IVA/neto de Mis Comprobantes del mes; null si no hay tramo. */
export function comprobantesMes(datosDir, id, tipo, mes) {
  const t = textoComprobantes(datosDir, id, tipo, mes);
  if (!t) return null;
  const r = resumenComprobantes(t.texto, mes);
  return r.error ? null : { ...r, fecha: t.fecha, fuente: t.fuente };
}

/**
 * Compras del mes agrupadas por proveedor (comprobantes recibidos). Pura.
 * neto = neto gravado + no gravado + exento (sin IVA ni otros tributos, que son créditos o pagos a cuenta).
 */
export function proveedoresDelMes(texto, mes) {
  const t = tablaDe(texto, (f) => f.some((c) => /fecha de emisi/.test(norm(c))) && f.some((c) => /tipo de comprobante/.test(norm(c))));
  const h = t.headers;
  const iF = col(h, /^fecha de emision/); const iT = col(h, /^tipo de comprobante/);
  const iDoc = col(h, /^nro\. doc\. emisor/); const iNom = col(h, /^denominacion emisor/);
  const montos = [col(h, /^imp\. neto gravado total$/), col(h, /^imp\. neto no gravado$/), col(h, /^imp\. op\. exentas$/)].filter((i) => i >= 0);
  const iIva = col(h, /^total iva$/);
  if (iF < 0 || iT < 0 || (iDoc < 0 && iNom < 0)) return [];
  const porClave = new Map();
  for (const f of t.rows) {
    const fecha = fechaIso(f[iF]);
    if (!fecha || fecha.slice(0, 7) !== mes) continue;
    const signo = NOTAS_CREDITO.has(Number(String(f[iT]).match(/\d+/)?.[0])) ? -1 : 1;
    const val = (i) => { const x = importeDe(f[i]) ?? 0; return signo < 0 && x > 0 ? -x : x; };
    const clave = (iDoc >= 0 && String(f[iDoc] ?? '').trim()) || norm(f[iNom]);
    const p = porClave.get(clave) ?? { clave, nombre: iNom >= 0 ? String(f[iNom] ?? '').trim() : clave, comprobantes: 0, neto: 0, iva: 0 };
    p.comprobantes++;
    p.neto = r2(p.neto + montos.reduce((n, i) => n + val(i), 0));
    if (iIva >= 0) p.iva = r2(p.iva + val(iIva));
    porClave.set(clave, p);
  }
  return [...porClave.values()].sort((a, b) => Math.abs(b.neto) - Math.abs(a.neto));
}

// ---------------- conceptos y fuentes ----------------

/** Líneas del resultado económico, en orden. `signo` -1 = resta. */
export const LINEAS = [
  { clave: 'otros-ingresos', signo: 1, opcional: true },
  { clave: 'costo-mercaderia', signo: -1, ayuda: 'PFOS / eCom: costo de lo VENDIDO en el mes (no las compras)' },
  { clave: 'comisiones-ml', signo: -1, ayuda: 'facturas de Mercado Libre en ARCA (clasificá el proveedor), PFOS o el reporte de ML' },
  { clave: 'publicidad', signo: -1, ayuda: 'PFOS (Mercado Ads), facturas en ARCA o carga manual; 0 si no hubo' },
  { clave: 'logistica', signo: -1, ayuda: 'envíos y Full: PFOS, reporte de ML o facturas en ARCA; 0 si no hubo' },
  { clave: 'gastos-operativos', signo: -1, ayuda: 'proveedores de gastos en ARCA (clasificados) o carga manual de administración' },
];

/** Datos del mes de cada origen: manual, importado, PFOS y ARCA (proveedores clasificados). */
export function origenesDelMes(outDir, mes) {
  const datosDir = path.join(outDir, 'datos');
  const recibidos = textoComprobantes(datosDir, 'comprobantes-recibidos', 'recibidos', mes);
  const clasif = leerClasificacion(outDir);
  const proveedores = (recibidos ? proveedoresDelMes(recibidos.texto, mes) : []).map((p) => {
    const c = clasif[p.clave]?.clase ?? null;
    return { ...p, clase: c, sugerida: c ? null : sugerirClase(p.nombre) };
  });
  const arca = {};
  for (const p of proveedores) {
    const concepto = p.clase ? CLASES_PROVEEDOR[p.clase].concepto : null;
    if (!concepto) continue;
    const o = (arca[concepto] ??= { importe: 0, proveedores: [] });
    o.importe = r2(o.importe + p.neto); o.proveedores.push(p.nombre);
  }
  return {
    manual: manualesDelMes(outDir, mes), importado: importadoDelMes(outDir, mes), pfos: obtenerPfos(mes) ?? {},
    arca, proveedores, recibidosFuente: recibidos?.fuente ?? null,
  };
}

/** Candidatos de un concepto en orden de prioridad: [{ origen, cifra }]. El primero es el que se usa. */
export function candidatos(origenes, concepto, { valorAbsoluto = true } = {}) {
  const v = (x) => (valorAbsoluto ? Math.abs(x) : x);
  const out = [];
  const m = origenes.manual[concepto];
  if (m) out.push({ origen: 'manual', cifra: cifra(v(m.importe), 'manual', `carga manual: ${[...new Set(m.cargas.map((c) => c.fuente))].join(', ')}`, m.cargas.length > 1 ? `${m.cargas.length} cargas` : m.cargas[0].nota || null), cargas: m.cargas });
  const i = origenes.importado[concepto];
  if (i) out.push({ origen: 'importado', cifra: cifra(v(i.importe), 'importado', `archivo: ${i.archivos.join(', ')}`, i.incluyeIva ? 'el archivo incluye IVA' : null) });
  const p = origenes.pfos[concepto];
  if (p?.importe != null) out.push({ origen: 'pfos', cifra: cifra(v(p.importe), 'importado', `PFOS${p.fuente ? ` (${p.fuente})` : ''}`, p.nota ?? null) });
  const a = origenes.arca[concepto];
  if (a) out.push({ origen: 'arca', cifra: cifra(v(a.importe), 'verificado', `facturas recibidas en ARCA: ${a.proveedores.slice(0, 4).join(', ')}${a.proveedores.length > 4 ? '…' : ''}`, 'neto de IVA') });
  return out;
}

// ---------------- resultado económico ----------------

/** Subtotal: suma lo disponible; lista lo que falta; estado parcial / con estimaciones / completo. */
function subtotal(nombre, base, lineas) {
  const usadas = [base, ...lineas].filter(Boolean);
  const faltan = usadas.filter((l) => l.cifra.valor == null).map((l) => l.nombre);
  const valor = usadas.reduce((n, l) => n + (l.cifra.valor == null ? 0 : (l.signo ?? 1) * l.cifra.valor), 0);
  const estado = faltan.length ? 'parcial' : usadas.some((l) => l.cifra.nivel === 'estimado') ? 'con estimaciones' : 'completo';
  return { nombre, valor: base?.cifra.valor == null && !lineas.some((l) => l.cifra.valor != null) ? null : r2(valor), estado, faltan };
}

/**
 * Resultado OPERATIVO del mes (sin impuestos): ingresos de ARCA y costos por concepto con su fuente.
 * Sirve también para estimar Ganancias de cada mes del año.
 */
export function resultadoOperativo(outDir, mes) {
  const datosDir = path.join(outDir, 'datos');
  const em = comprobantesMes(datosDir, 'comprobantes-emitidos', 'emitidos', mes);
  const origenes = origenesDelMes(outDir, mes);
  const ventas = { clave: 'ventas', nombre: 'Facturación neta de IVA', signo: 1,
    cifra: em ? cifra(em.netoGravado, 'verificado', em.fuente, `${em.comprobantes} comprobantes emitidos (${em.notasCredito} notas de crédito restando)`) : faltante('faltan los comprobantes emitidos del mes (Mis Comprobantes)') };
  const lineas = LINEAS.map((l) => {
    const cands = candidatos(origenes, l.clave, { valorAbsoluto: l.signo < 0 });
    const usada = cands[0] ?? null;
    return { clave: l.clave, nombre: CONCEPTOS[l.clave].nombre, signo: l.signo, opcional: !!l.opcional, ayuda: l.ayuda ?? null,
      cifra: usada ? usada.cifra : faltante(l.opcional ? 'sin otros ingresos cargados' : `falta: ${l.ayuda}`), origen: usada?.origen ?? null,
      cargas: cands.find((c) => c.origen === 'manual')?.cargas ?? [],
      alternativas: cands.slice(1).map((c) => ({ origen: c.origen, ...c.cifra })) };
  });
  const L = Object.fromEntries(lineas.map((l) => [l.clave, l]));
  const avisos = [];
  // Mercado Libre factura en un mismo comprobante comisiones, publicidad y envíos: si los cargos de ML
  // salen de sus facturas en ARCA y publicidad o envíos de otra fuente, puede haber doble conteo.
  if (L['comisiones-ml'].origen === 'arca' && ['publicidad', 'logistica'].some((k) => L[k].origen && L[k].origen !== 'arca' && (L[k].cifra.valor ?? 0) > 0)) {
    avisos.push('Los cargos de Mercado Libre salen de sus facturas en ARCA, que pueden incluir publicidad y envíos; publicidad o envíos vienen además de otra fuente: revisá que no estén contados dos veces.');
  }
  for (const l of lineas) {
    for (const a of l.alternativas) {
      if (l.cifra.valor != null && a.valor != null && Math.abs(a.valor - l.cifra.valor) >= 1) {
        avisos.push(`${l.nombre}: se usa ${etiquetaOrigen(l.origen)} (${l.cifra.valor}); ${etiquetaOrigen(a.origen)} dice ${a.valor}. No se suman: revisá cuál corresponde.`);
      }
    }
  }
  if (lineas.some((l) => /incluye IVA/.test(l.cifra.nota ?? ''))) avisos.push('Hay importes con IVA incluido: el resultado queda subestimado.');
  const sinClasificar = origenes.proveedores.filter((p) => !p.clase);
  const comprasMercaderia = origenes.proveedores.filter((p) => p.clase === 'mercaderia').reduce((n, p) => n + p.neto, 0);
  const margen = subtotal('Margen bruto', ventas, [L['otros-ingresos'].cifra.valor != null ? L['otros-ingresos'] : null, L['costo-mercaderia']].filter(Boolean));
  const operativo = subtotal('Resultado operativo', ventas, lineas.filter((l) => !l.opcional || l.cifra.valor != null));
  return {
    mes, ventas, lineas, margen, operativo, avisos,
    margenPct: margen.estado !== 'parcial' && ventas.cifra.valor ? r2((margen.valor / ventas.cifra.valor) * 100) : null,
    proveedores: origenes.proveedores, recibidosFuente: origenes.recibidosFuente,
    referencia: {
      comprasMercaderia: origenes.proveedores.some((p) => p.clase === 'mercaderia') ? cifra(comprasMercaderia, 'verificado', 'facturas de proveedores de mercadería (ARCA)', 'compras del mes: van a stock, NO son el costo de lo vendido') : null,
      sinClasificar: sinClasificar.length ? cifra(sinClasificar.reduce((n, p) => n + p.neto, 0), 'verificado', `${sinClasificar.length} proveedor(es) sin clasificar`, 'no entran al resultado hasta clasificarlos') : null,
      ventasMercadoLibre: origenes.importado['ventas-ml'] || origenes.manual['ventas-ml'] ? cifra((origenes.manual['ventas-ml'] ?? origenes.importado['ventas-ml']).importe, origenes.manual['ventas-ml'] ? 'manual' : 'importado', 'Mercado Libre', 'ya incluidas en la facturación: no se suman') : null,
    },
  };
}

export function etiquetaOrigen(o) {
  return { manual: 'la carga manual', importado: 'el archivo importado', pfos: 'PFOS', arca: 'las facturas en ARCA' }[o] ?? o ?? '—';
}

/**
 * Rentabilidad completa del mes: resultado económico (con impuestos atribuibles), impuestos generados,
 * pagos de impuestos realizados en el mes y obligaciones futuras. `fiscal` trae lo ya calculado por el
 * panel (IVA, IIBB, Ganancias, autónomos, pagos del mes).
 */
export function rentabilidadMes(outDir, mes, fiscal) {
  const op = resultadoOperativo(outDir, mes);
  const { iva, iibb, ganancias, autonomos, pagosMes, hoy } = fiscal;
  const iibbLinea = { clave: 'iibb', nombre: 'Ingresos Brutos', signo: -1, cifra: iibb.declarado.valor != null ? iibb.declarado : iibb.estimado, editable: 'iibb-declarado' };
  const autLinea = { clave: 'autonomos-cuota', nombre: 'Autónomos', signo: -1, cifra: autonomos.declarado };
  const ganLinea = { clave: 'ganancias', nombre: 'Provisión de Ganancias', signo: -1, cifra: ganancias.estimado };
  const operativoComoLinea = { nombre: 'Resultado operativo', signo: 1, cifra: { valor: op.operativo.valor, nivel: op.operativo.estado === 'parcial' ? 'faltante' : 'verificado' } };
  const antesGan = subtotal('Resultado antes de Ganancias', operativoComoLinea, [iibbLinea, autLinea]);
  antesGan.faltan = [...op.operativo.faltan, ...antesGan.faltan.filter((x) => x !== 'Resultado operativo')];
  antesGan.estado = antesGan.faltan.length ? 'parcial' : [iibbLinea, autLinea].some((l) => l.cifra.nivel === 'estimado') ? 'con estimaciones' : op.operativo.estado;
  const neto = subtotal('Resultado neto', { ...operativoComoLinea }, [iibbLinea, autLinea, ganLinea]);
  neto.faltan = [...antesGan.faltan, ...(ganLinea.cifra.valor == null ? ['Provisión de Ganancias'] : [])];
  neto.estado = neto.faltan.length ? 'parcial' : 'con estimaciones'; // Ganancias siempre es estimada

  const ventas = op.ventas.cifra.valor;
  const cargaAtribuible = [iibbLinea, autLinea, ganLinea].filter((l) => l.cifra.valor != null);
  const impuestos = {
    filas: [
      { impuesto: 'IVA', cifra: iva.declarado.valor != null ? iva.declarado : iva.estimado, tratamiento: 'no es costo: lo cobrás y lo pagás por cuenta de ARCA', vence: iva.vencimientoPago.fecha, estado: iva.estado },
      { impuesto: 'Ingresos Brutos', cifra: iibbLinea.cifra, tratamiento: 'costo del mes', vence: null, estado: iibb.estado, editable: 'iibb-declarado' },
      { impuesto: 'Autónomos', cifra: autLinea.cifra, tratamiento: 'costo del mes', vence: null },
      { impuesto: 'Ganancias', cifra: ganLinea.cifra, tratamiento: 'costo: provisión del impuesto anual', vence: null, estado: ganancias.estado },
    ],
    cargaAtribuible: cargaAtribuible.length ? cifra(cargaAtribuible.reduce((n, l) => n + l.cifra.valor, 0), cargaAtribuible.some((l) => l.cifra.nivel === 'estimado') ? 'estimado' : cargaAtribuible[0].cifra.nivel, 'IIBB + autónomos + Ganancias', cargaAtribuible.length < 3 ? 'incompleta' : null) : faltante('sin datos'),
    cargaPct: cargaAtribuible.length && ventas ? r2((cargaAtribuible.reduce((n, l) => n + l.cifra.valor, 0) / ventas) * 100) : null,
  };

  // Pagos de impuestos con fecha en el mes (cualquier período): ARCA + cargados a mano/importados.
  const pagos = (pagosMes ?? []).map((x) => ({ fecha: x.fecha, impuesto: x.clasificacion.nombre, detalle: x.impuesto, corresponde: x.imputadoA, importe: x.importe, propio: x.clasificacion.propio, nivel: 'verificado', fuente: 'Cuentas Tributarias' }));
  const origenes = { manual: manualesDelMes(outDir, mes), importado: importadoDelMes(outDir, mes) };
  for (const [k, nombre] of [['iibb-pagado', 'Ingresos Brutos'], ['ganancias-anticipo', 'Ganancias'], ['autonomos', 'Autónomos']]) {
    const src = origenes.manual[k] ? { nivel: 'manual', importe: origenes.manual[k].importe, fuente: 'carga manual' } : origenes.importado[k] ? { nivel: 'importado', importe: origenes.importado[k].importe, fuente: 'archivo importado' } : null;
    if (!src) continue;
    const yaEnArca = pagos.some((p) => p.impuesto === nombre && p.nivel === 'verificado');
    pagos.push({ fecha: null, impuesto: nombre, detalle: CONCEPTOS[k].nombre, corresponde: 'según la carga', importe: Math.abs(src.importe), propio: true, nivel: src.nivel, fuente: src.fuente, posibleDuplicado: yaEnArca });
  }
  const sumaPagos = (f) => r2(pagos.filter(f).reduce((n, p) => n + (p.importe ?? 0), 0));

  // Obligaciones futuras que dejó este mes.
  const obligaciones = [
    { impuesto: 'IVA', cifra: iva.saldoPendiente.valor != null ? iva.saldoPendiente : iva.declarado, vence: iva.vencimientoPago.fecha, nota: iva.vencimientoPago.fecha && iva.vencimientoPago.fecha >= hoy ? 'no vencido (régimen del contribuyente)' : iva.vencimientoPago.fecha ? 'vencido' : null },
    { impuesto: 'Ingresos Brutos', cifra: iibb.saldoPendiente.valor != null ? iibb.saldoPendiente : iibb.estimado, vence: null, nota: iibb.saldoPendiente.valor != null ? 'declarado − pagos' : 'estimado: falta lo declarado' },
    { impuesto: 'Ganancias', cifra: ganLinea.cifra, vence: null, nota: 'se paga con la DJ anual y sus anticipos' },
  ];

  const faltantes = [];
  const L = Object.fromEntries(op.lineas.map((l) => [l.clave, l]));
  if (op.ventas.cifra.valor == null) faltantes.push({ dato: 'Facturación del mes', como: 'correr Mis Comprobantes (emitidos) para el mes' });
  if (L['costo-mercaderia'].cifra.valor == null) faltantes.push({ dato: 'Costo de la mercadería vendida', como: 'cargá el importe o importá el reporte de costo de lo vendido (PFOS / eCom). No se reemplaza por las compras.' });
  for (const k of ['comisiones-ml', 'publicidad', 'logistica', 'gastos-operativos']) if (L[k].cifra.valor == null) faltantes.push({ dato: L[k].nombre, como: L[k].ayuda });
  if (op.referencia.sinClasificar) faltantes.push({ dato: 'Proveedores sin clasificar', como: `clasificalos una vez en "Proveedores del mes": ${op.referencia.sinClasificar.fuente}` });
  if (iibb.declarado.valor == null) faltantes.push({ dato: 'Ingresos Brutos declarado', como: 'cargá el impuesto determinado del CM03 del mes' });
  if (autLinea.cifra.valor == null) faltantes.push({ dato: 'Autónomos', como: 'cargá la cuota del mes (0 si no corresponde)' });
  if (ganLinea.cifra.valor == null) faltantes.push({ dato: 'Provisión de Ganancias', como: ganLinea.cifra.nota ?? 'requiere el resultado de todos los meses del año' });

  return {
    ...op, iibb: iibbLinea, autonomos: autLinea, ganancias: ganLinea, antesGanancias: antesGan, neto,
    impuestos, faltantes,
    pagos: { filas: pagos, propios: sumaPagos((p) => p.propio !== false), comoAgente: sumaPagos((p) => p.propio === false), total: sumaPagos(() => true) },
    obligaciones,
    nota: 'El IVA no se resta: lo cobrás por cuenta de ARCA y lo compensás con el de tus compras. Afecta la caja (y cuándo pagás), no el resultado económico.',
  };
}
