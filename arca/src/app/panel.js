/**
 * Modelo del panel mensual de FiscalOS: arma, para un mes de facturación, cada impuesto (IVA, IIBB,
 * Ganancias, autónomos), las obligaciones registradas en ARCA y la rentabilidad del mes, con los
 * datos YA conservados (out/datos) y los importados a mano (out/importados). No abre ARCA.
 *
 * Cada cifra lleva su NIVEL, que la interfaz muestra siempre:
 *   verificado -> leído de ARCA y validado por FiscalOS (fuente y fecha de consulta);
 *   importado  -> de un archivo que cargó la persona (nombre del archivo);
 *   estimado   -> cálculo de FiscalOS con supuestos explícitos (nunca se presenta como dato);
 *   faltante   -> no hay dato: se dice qué falta y cómo obtenerlo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { generarInformeIva, tablaDe, resumenComprobantes } from '../informeIva.js';
import { leerVigente } from '../portal/conservacion.js';
import { leerManifiesto, decodificar } from '../portal/misComprobantes.js';
import { leerZipDesdeArchivo } from '../portal/zip.js';
import { periodoDe, importeDe } from '../portal/ivaDdjj.js';
import { fechaIso } from '../portal/calidad.js';
import { estimar, alicuotaIIBB } from '../estimacion.js';
import { importadoDelMes, mesesImportados, CONCEPTOS } from './importar.js';
import { integraciones } from './integraciones.js';

const r2 = (x) => Math.round(x * 100) / 100;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const col = (headers, re) => headers.findIndex((h) => re.test(norm(h)));
const finDeMes = (mes) => { const [y, m] = mes.split('-'); return new Date(Date.UTC(+y, +m, 0)).toISOString().slice(0, 10); };

export const cifra = (valor, nivel, fuente = null, nota = null) => ({ valor: valor == null ? null : r2(valor), nivel: valor == null ? 'faltante' : nivel, fuente, nota });
const faltante = (nota) => ({ valor: null, nivel: 'faltante', fuente: null, nota });

/** Mes anterior a `hoy` ('AAAA-MM'): el que la persona quiere ver por defecto. */
export function mesAnterior(hoy) {
  const [y, m] = hoy.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Vigentes de una fuente con sus tablas: [{ clave, entrada, tablas: [{ nombre, headers, rows }] }]. */
function vigentes(datosDir, id) {
  return Object.entries(leerVigente(datosDir, id)).map(([clave, entrada]) => ({
    clave, entrada,
    tablas: (entrada.archivos ?? []).map((nombre) => {
      try { return { nombre, ...tablaDe(fs.readFileSync(path.join(datosDir, id, 'vigente', clave, nombre), 'utf8')) }; } catch { return { nombre, headers: [], rows: [] }; }
    }),
  }));
}

// Resumen de Mis Comprobantes por mes, con caché por archivo (el CSV de un mes tiene miles de filas).
const cacheMc = new Map();
function comprobantesMes(datosDir, id, tipo, mes) {
  const dirFuente = path.join(datosDir, id);
  const ini = `${mes}-01`; const fin = finDeMes(mes);
  for (const [k, v] of Object.entries(leerManifiesto(dirFuente))) {
    const [t, d, h] = k.split(':');
    if (t !== tipo || !v?.ok || !v.archivo || d > ini || h < fin) continue;
    const f = path.join(dirFuente, v.archivo);
    let mtime = 0; try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
    const clave = `${f}|${mtime}|${mes}`;
    if (!cacheMc.has(clave)) {
      const texto = /\.zip$/i.test(f) ? leerZipDesdeArchivo(f).filter((e) => /\.csv$/i.test(e.name)).map((e) => decodificar(e.data)).join('\n') : decodificar(fs.readFileSync(f));
      cacheMc.set(clave, { ...resumenComprobantes(texto, mes), fecha: v.fecha });
    }
    const r = cacheMc.get(clave);
    return r.error ? null : r;
  }
  return null;
}

/** Meses con datos (comprobantes, DJ, pagos, importaciones) más el mes anterior a hoy; del más nuevo al más viejo. */
export function mesesDisponibles(outDir, hoy) {
  const datosDir = path.join(outDir, 'datos');
  const s = new Set([mesAnterior(hoy)]);
  for (const id of ['comprobantes-emitidos', 'comprobantes-recibidos']) {
    for (const k of Object.keys(leerManifiesto(path.join(datosDir, id)))) {
      const [, d, h] = k.split(':');
      if (!d || !h) continue;
      for (let m = d.slice(0, 7); m <= h.slice(0, 7); ) {
        if (`${m}-01` >= d && finDeMes(m) <= h) s.add(m);
        const [y, mm] = m.split('-').map(Number);
        m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
      }
    }
  }
  for (const id of ['portal-iva-ddjj', 'mis-retenciones']) for (const v of Object.values(leerVigente(datosDir, id))) if (v.desde) s.add(v.desde.slice(0, 7));
  for (const m of mesesImportados(outDir)) s.add(m);
  return [...s].filter((m) => m <= hoy.slice(0, 7)).sort().reverse();
}

/** Contribuyente (params/contribuyente.json) si existe; si no, null (las estimaciones quedan faltantes). */
function contribuyente(paramsFile) {
  try { return JSON.parse(fs.readFileSync(paramsFile, 'utf8')); } catch { return null; }
}

/**
 * Período fiscal de un pago de Cuentas Tributarias: { tipo: 'mes', mes } | { tipo: 'anual', anio } | null. Pura.
 * Formatos de CT: AAAAMM, AAAAMM00 (DJ mensual), AAAA00 / AAAA0000 / AAAA (impuestos anuales).
 */
export function periodoFiscal(texto) {
  const s = String(texto ?? '').trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})?$/);
  if (m) {
    if (m[2] === '00') return { tipo: 'anual', anio: m[1] };
    return Number(m[2]) <= 12 ? { tipo: 'mes', mes: `${m[1]}-${m[2]}` } : null;
  }
  m = s.match(/^(\d{4})$/);
  if (m) return { tipo: 'anual', anio: m[1] };
  const mes = periodoDe(s);
  return mes ? { tipo: 'mes', mes } : null;
}

/**
 * Qué impuesto es un pago, por el CÓDIGO de impuesto de Cuentas Tributarias ("11 - GANANCIAS ..."). Pura.
 * Importante: 217 (SICORE) y los regímenes de retención/percepción son pagos como AGENTE (retenciones
 * a terceros), no el impuesto propio, aunque digan "Ganancias".
 */
export function clasificarImpuesto(texto) {
  const t = norm(texto); const codigo = Number(t.match(/^\d+/)?.[0] ?? NaN);
  if ([217, 218, 767, 216, 787].includes(codigo) || /sicore|sire|retenc|percep/.test(t)) return { clave: 'agente', nombre: 'Retenciones/percepciones como agente', propio: false, codigo };
  if (codigo === 30 || (/\biva\b/.test(t) && Number.isNaN(codigo))) return { clave: 'iva', nombre: 'IVA', propio: true, codigo };
  if ([10, 11].includes(codigo) || (/ganancia/.test(t) && Number.isNaN(codigo))) return { clave: 'ganancias', nombre: 'Ganancias', propio: true, codigo };
  if (/autonom/.test(t)) return { clave: 'autonomos', nombre: 'Autónomos', propio: true, codigo };
  if (/bienes personales/.test(t)) return { clave: 'bienes-personales', nombre: 'Bienes Personales', propio: true, codigo };
  return { clave: 'otro', nombre: texto ? String(texto) : 'sin impuesto', propio: null, codigo };
}

/**
 * Pagos de Cuentas Tributarias con FECHA de pago en el mes (todos los impuestos), cada uno con su
 * impuesto, formulario, período fiscal al que se imputó y a qué corresponde. Es el flujo de caja
 * real del mes; NO es la carga atribuible al mes (un pago de septiembre puede ser de otro período).
 */
export function pagosDelMes(datosDir, mes) {
  const out = [];
  for (const v of vigentes(datosDir, 'ct-pagos')) {
    for (const t of v.tablas) {
      const ii = col(t.headers, /impuesto/); const im = col(t.headers, /importe/); const fe = col(t.headers, /fecha/); const ip = col(t.headers, /periodo/);
      const fo = col(t.headers, /formulario/); const ve = col(t.headers, /version/); const ob = col(t.headers, /observ/); const co = col(t.headers, /^concepto/);
      for (const f of t.rows) {
        const fechaIsoPago = fechaIso(f[fe]);
        if ((fechaIsoPago ?? '').slice(0, 7) !== mes) continue;
        const imp = clasificarImpuesto(f[ii]); const per = periodoFiscal(f[ip]);
        const imputadoA = !per ? `período "${f[ip] ?? ''}" (sin interpretar)` : per.tipo === 'anual' ? `período fiscal ${per.anio} (anual)` : `período ${per.mes.slice(5)}/${per.mes.slice(0, 4)}`;
        out.push({ fecha: fechaIsoPago, impuesto: f[ii] ?? '', clasificacion: imp, formulario: fo >= 0 ? f[fo] : null, version: ve >= 0 ? f[ve] : null,
          concepto: co >= 0 ? f[co] : null, observaciones: ob >= 0 ? f[ob] : null, periodoFiscal: f[ip] ?? null, periodo: per, imputadoA,
          delMismoPeriodo: per?.tipo === 'mes' && per.mes === mes, importe: importeDe(f[im]), fuente: `ct-pagos (${v.entrada.nivel ?? 'validado'}, ${v.entrada.cuando})` });
      }
    }
  }
  return out.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
}

/** Volantes de pago de SIFERE (IIBB) del anticipo `mes`, si se conservaron. Verificados. */
function volantesSifere(datosDir, mes) {
  const out = [];
  for (const v of vigentes(datosDir, 'sifere-consultas-volantes-pago')) {
    for (const t of v.tablas) {
      const ia = col(t.headers, /anticipo/); const im = col(t.headers, /monto total/); const ie = col(t.headers, /^estado/);
      if (ia < 0 || im < 0) continue;
      for (const f of t.rows) {
        if (periodoDe(f[ia]) !== mes || (ie >= 0 && /anulad|rechaz|vencid/.test(norm(f[ie])))) continue;
        out.push({ anticipo: f[ia], importe: importeDe(f[im]), estado: ie >= 0 ? f[ie] : null, fuente: `SIFERE volantes (${v.entrada.cuando})` });
      }
    }
  }
  return out;
}

const fechaDma = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');
const suma = (xs) => (xs.length ? r2(xs.reduce((n, x) => n + (x.importe ?? 0), 0)) : null);

/** Obligaciones registradas en Cuentas Tributarias (vencimientos y deudas de todos los impuestos). */
function obligaciones(datosDir, hoy) {
  const out = [];
  for (const [id, tipo] of [['cuentas-tributarias', 'vencimiento'], ['ct-deudas', 'deuda']]) {
    for (const v of vigentes(datosDir, id)) {
      for (const t of v.tablas) {
        const ii = col(t.headers, /^impuesto/); const ic = col(t.headers, /^concepto/); const ip = col(t.headers, /periodo/); const iv = col(t.headers, /vencimiento/); const is = col(t.headers, /^saldo/);
        for (const f of t.rows) {
          const venc = fechaIso(f[iv]);
          out.push({ tipo, impuesto: f[ii] ?? '', concepto: f[ic] ?? '', periodo: periodoDe(f[ip]) ?? f[ip] ?? '', vencimiento: venc, saldo: is >= 0 ? importeDe(f[is]) : null,
            estado: !venc ? 'sin fecha' : venc < hoy ? 'vencido' : 'por vencer', consultado: v.entrada.cuando });
        }
      }
    }
  }
  return out.sort((a, b) => String(a.vencimiento ?? '9999').localeCompare(String(b.vencimiento ?? '9999')));
}

/**
 * Panel de un mes. `hoy` ('AAAA-MM-DD') decide qué está vencido; `paramsFile` es params/contribuyente.json.
 */
export function panelMes(outDir, mes, { hoy = new Date().toISOString().slice(0, 10), paramsFile = path.resolve('params/contribuyente.json') } = {}) {
  const datosDir = path.join(outDir, 'datos');
  const [anio] = mes.split('-');
  const imp = importadoDelMes(outDir, mes);
  const importado = (k) => (imp[k] ? cifra(imp[k].importe, 'importado', `importado: ${imp[k].archivos.join(', ')}`, imp[k].incluyeIva ? 'el archivo incluye IVA' : null) : null);
  const contrib = contribuyente(paramsFile);

  // ---------- IVA ----------
  const inf = generarInformeIva(datosDir, mes, { hoy }).objeto;
  const idd = inf.declarado?.identificados ?? {};
  const em = inf.comprobantes.emitidos && !inf.comprobantes.emitidos.error ? inf.comprobantes.emitidos : null;
  const re = inf.comprobantes.recibidos && !inf.comprobantes.recibidos.error ? inf.comprobantes.recibidos : null;
  const ivaEstimado = em && re
    ? cifra(em.iva - re.iva - (inf.retencionesIva ?? 0), 'estimado', 'Mis Comprobantes + Mis Retenciones',
      'débito de emitidos − IVA de proveedores − percepciones de IVA sufridas; supone que todo el IVA de proveedores es crédito computable')
    : faltante('faltan los comprobantes emitidos y recibidos del mes (Mis Comprobantes)');
  const saldoPendienteIva = inf.conciliacion.saldoPendiente != null
    ? cifra(inf.conciliacion.saldoPendiente, 'verificado', 'Cuentas Tributarias (deuda registrada)')
    : inf.conciliacion.diferencia != null ? cifra(Math.max(0, inf.conciliacion.diferencia), 'verificado', 'declarado − pagos imputados')
      : faltante(inf.conciliacion.detalle);
  const presentacion = inf.presentaciones[0] ?? null;
  const iva = {
    impuesto: 'IVA', periodo: mes, estado: inf.conciliacion.estado, detalle: inf.conciliacion.detalle,
    declarado: idd.saldoAPagar?.importe != null ? cifra(idd.saldoAPagar.importe, 'verificado', inf.declarado.fuente, `"${idd.saldoAPagar.concepto}" (F.2051)`) : faltante('falta el detalle de la DJ de IVA (portal-iva-ddjj)'),
    estimado: ivaEstimado,
    pagos: inf.pagado != null ? cifra(inf.pagado, 'verificado', 'ct-pagos', `${inf.pagos.length} pago(s) imputados al período`)
      : cifra(null, 'faltante', null, `sin pagos imputados en las ventanas consultadas (${inf.ventanasPagos.join(', ') || 'ninguna'})`),
    saldoPendiente: saldoPendienteIva,
    presentacion: presentacion ? { fecha: presentacion.presentacion, nivel: 'verificado', fuente: presentacion.fuente } : { fecha: null, nivel: 'faltante', fuente: null },
    vencimientoPresentacion: { fecha: null, nivel: 'faltante', nota: 'no se conserva el vencimiento de presentación; se muestra la fecha real de presentación' },
    vencimientoPago: inf.vencimientoPago ? { fecha: inf.vencimientoPago, nivel: 'verificado', fuente: 'Cuentas Tributarias', nota: 'vencimiento del régimen del contribuyente (no se aplica el calendario general)' }
      : { fecha: null, nivel: 'faltante', nota: 'Cuentas Tributarias no registra vencimiento de pago para el período' },
    detalle_: {
      debitoComprobantes: em ? cifra(em.iva, 'verificado', em.fuente, `${em.comprobantes} comprobantes, ${em.notasCredito} notas de crédito`) : faltante('faltan los comprobantes emitidos'),
      ivaProveedores: re ? cifra(re.iva, 'verificado', re.fuente, 'IVA facturado por proveedores (no es crédito computable por sí solo)') : faltante('faltan los comprobantes recibidos'),
      debitoDeclarado: idd.debitoFiscal?.importe != null ? cifra(idd.debitoFiscal.importe, 'verificado', inf.declarado.fuente) : faltante('no identificado en la DJ'),
      creditoDeclarado: idd.creditoFiscal?.importe != null ? cifra(idd.creditoFiscal.importe, 'verificado', inf.declarado.fuente) : faltante(idd.creditoFiscal?.ambiguo ? 'ambiguo en la DJ' : 'no identificado en la DJ'),
      percepcionesDeclaradas: idd.retencionesPercepciones?.importe != null ? cifra(idd.retencionesPercepciones.importe, 'verificado', inf.declarado.fuente) : faltante(idd.retencionesPercepciones?.ambiguo ? 'ambiguo en la DJ' : 'no identificado en la DJ'),
      percepcionesSufridas: inf.retenciones.length ? cifra(inf.retencionesIva, 'verificado', 'Mis Retenciones') : faltante('sin retenciones/percepciones de IVA conservadas para el mes'),
      composicionDebito: inf.declarado?.composicionDebito ?? { disponible: false, componentes: [], motivo: 'falta el detalle de la DJ' },
    },
    avisos: inf.avisos, faltantes: inf.faltantes,
  };
  if (iva.detalle_.debitoDeclarado.valor != null && iva.detalle_.debitoComprobantes.valor != null) {
    iva.detalle_.diferenciaDebito = cifra(iva.detalle_.debitoDeclarado.valor - iva.detalle_.debitoComprobantes.valor, 'verificado', 'DJ − Mis Comprobantes',
      'diferencia todavía no explicada: puede deberse a operaciones sin comprobante electrónico, ajustes o restituciones; ver la composición del débito de la DJ');
  }

  // ---------- Ingresos Brutos ----------
  const alic = contrib ? alicuotaIIBB(contrib) : 0;
  const volantes = volantesSifere(datosDir, mes);
  const iibbPagos = [importado('iibb-pagado'), volantes.length ? cifra(suma(volantes), 'verificado', volantes[0].fuente, `${volantes.length} volante(s)`) : null].filter(Boolean);
  const iibbDeclarado = importado('iibb-declarado') ?? faltante('SIFERE no se lee todavía: importá la DJ de Convenio Multilateral (CM03) del mes');
  const iibbEstimado = em && alic > 0 ? cifra(em.netoGravado * alic, 'estimado', 'facturación neta × alícuota efectiva', `alícuota efectiva ${r2(alic * 100)}% (params/contribuyente.json)`)
    : faltante(em ? 'configurá las jurisdicciones y alícuotas en params/contribuyente.json' : 'faltan los comprobantes emitidos del mes');
  const iibbPagado = iibbPagos.length ? cifra(iibbPagos.reduce((n, c) => n + c.valor, 0), iibbPagos.every((c) => c.nivel === 'verificado') ? 'verificado' : 'importado', iibbPagos.map((c) => c.fuente).join(' + ')) : faltante('sin pagos de IIBB registrados ni importados');
  const iibb = {
    impuesto: 'Ingresos Brutos', periodo: mes, declarado: iibbDeclarado, estimado: iibbEstimado, pagos: iibbPagado,
    saldoPendiente: iibbDeclarado.valor != null ? cifra(Math.max(0, iibbDeclarado.valor - (iibbPagado.valor ?? 0)), iibbDeclarado.nivel, 'declarado − pagos', iibbPagado.valor == null ? 'sin pagos registrados' : null) : faltante('falta lo declarado'),
    vencimientoPresentacion: { fecha: null, nivel: 'faltante', nota: 'calendario de Convenio Multilateral no cargado' },
    vencimientoPago: { fecha: null, nivel: 'faltante', nota: 'calendario de Convenio Multilateral no cargado' },
    estado: iibbDeclarado.valor != null ? (iibbPagado.valor != null && iibbPagado.valor >= iibbDeclarado.valor - 1 ? 'pagado' : 'declarado') : iibbEstimado.valor != null ? 'solo estimado' : 'sin datos',
  };

  // ---------- Ganancias (provisión del mes) ----------
  let ganEstimado; let iibbParaGanancias = null;
  if (!contrib) ganEstimado = faltante('para estimar Ganancias falta params/contribuyente.json (deducciones, autónomos, IIBB)');
  else {
    const meses = []; const sinDatos = [];
    for (let i = 1; i <= Number(mes.slice(5)); i++) {
      const m = `${anio}-${String(i).padStart(2, '0')}`;
      const e = comprobantesMes(datosDir, 'comprobantes-emitidos', 'emitidos', m);
      const r = comprobantesMes(datosDir, 'comprobantes-recibidos', 'recibidos', m);
      if (!e || !r) { sinDatos.push(m); continue; }
      const im = importadoDelMes(outDir, m);
      const gastosImp = ['comisiones-ml', 'publicidad', 'logistica', 'gastos-operativos'].reduce((n, k) => n + Math.abs(im[k]?.importe ?? 0), 0);
      const costo = im['costo-mercaderia'] ? Math.abs(im['costo-mercaderia'].importe) : r.netoGravado;
      meses.push({ mes: m, ventasNetas: e.netoGravado + (im['otros-ingresos']?.importe ?? 0), gastosNetos: costo + gastosImp });
    }
    if (sinDatos.length) ganEstimado = faltante(`Ganancias se provisiona sobre el acumulado del año: faltan los comprobantes de ${sinDatos.join(', ')} (correr Mis Comprobantes con esas fechas)`);
    else {
      const est = estimar(Number(anio), meses, contrib).at(-1);
      iibbParaGanancias = est.iibb;
      ganEstimado = cifra(est.ganancias, 'estimado', 'escala de Ganancias sobre el resultado proyectado del año',
        `provisión del mes; resultado = facturación neta − ${imp['costo-mercaderia'] ? 'costo de mercadería importado' : 'compras netas facturadas (supone stock estable)'} − gastos importados − IIBB − autónomos; proyección anual ${est.proyeccionAnual}`);
    }
  }
  // Ganancias es ANUAL: un pago con fecha en el mes (anticipo o saldo de DJ) se imputa a un período
  // fiscal anual; no es la carga del mes. Se muestra con su período en "Pagos realizados en el mes".
  const pagosMes = pagosDelMes(datosDir, mes);
  const ganPagosMes = pagosMes.filter((x) => x.clasificacion.clave === 'ganancias');
  const ganImp = importado('ganancias-anticipo');
  const ganancias = {
    impuesto: 'Ganancias', periodo: mes, declarado: faltante('es anual: la DJ de Ganancias (F.711) no se lee todavía'), estimado: ganEstimado,
    pagos: faltante('impuesto anual: los pagos no se atribuyen a un mes'),
    pagosEnElMes: ganPagosMes.length || ganImp ? cifra((ganPagosMes.reduce((n, x) => n + (x.importe ?? 0), 0)) + (ganImp?.valor ?? 0), ganImp && !ganPagosMes.length ? 'importado' : 'verificado',
      'ct-pagos', ganPagosMes.map((x) => `${fechaDma(x.fecha)}: ${x.imputadoA}`).join(' · ') || null) : null,
    saldoPendiente: faltante('se determina en la DJ anual'),
    vencimientoPresentacion: { fecha: null, nivel: 'faltante', nota: 'DJ anual' }, vencimientoPago: { fecha: null, nivel: 'faltante', nota: 'ver obligaciones (anticipos) registradas en ARCA' },
    estado: ganEstimado.valor != null ? 'provisión estimada' : 'sin datos',
  };

  // ---------- Autónomos ----------
  const autPagosCt = pagosMes.filter((x) => x.clasificacion.clave === 'autonomos');
  const autImp = importado('autonomos');
  const autonomos = {
    impuesto: 'Autónomos', periodo: mes,
    declarado: contrib?.autonomosMensual ? cifra(contrib.autonomosMensual, 'estimado', 'params/contribuyente.json', 'cuota mensual configurada') : faltante('cuota no configurada (params/contribuyente.json)'),
    pagos: autPagosCt.length ? cifra(suma(autPagosCt), 'verificado', autPagosCt[0].fuente) : autImp ?? faltante('sin pagos registrados en el mes'),
  };

  // ---------- Rentabilidad del mes ----------
  const g = (k) => (imp[k] ? cifra(Math.abs(imp[k].importe), 'importado', `importado: ${imp[k].archivos.join(', ')}`, imp[k].incluyeIva ? 'incluye IVA' : null) : null);
  const ingresos = em ? cifra(em.netoGravado + (imp['otros-ingresos']?.importe ?? 0), 'verificado', em.fuente, 'facturación neta de IVA (neto gravado de comprobantes emitidos, notas de crédito restando)') : faltante('faltan los comprobantes emitidos');
  const lineasGasto = ['costo-mercaderia', 'comisiones-ml', 'publicidad', 'logistica', 'gastos-operativos'].map((k) => ({ concepto: k, nombre: CONCEPTOS[k].nombre, ...(g(k) ?? faltante('no importado')) }));
  const iibbAtribuible = iibb.declarado.valor != null ? iibb.declarado : iibb.estimado;
  const faltanRent = [];
  if (ingresos.valor == null) faltanRent.push('facturación del mes');
  if (!imp['costo-mercaderia']) faltanRent.push('costo de la mercadería vendida (importar)');
  if (iibbAtribuible.valor == null) faltanRent.push('Ingresos Brutos (declarado o estimado)');
  if (ganEstimado.valor == null) faltanRent.push('provisión de Ganancias');
  const gastosConocidos = lineasGasto.reduce((n, l) => n + (l.valor ?? 0), 0);
  const conIva = lineasGasto.some((l) => /incluye IVA/.test(l.nota ?? ''));
  const resultado = ingresos.valor != null && imp['costo-mercaderia']
    ? cifra(ingresos.valor - gastosConocidos - (iibbAtribuible.valor ?? 0) - (ganEstimado.valor ?? 0) - (contrib?.autonomosMensual ?? 0),
      [ingresos, ...lineasGasto, iibbAtribuible, ganEstimado].some((c) => c.nivel === 'estimado') ? 'estimado' : 'importado', 'cálculo de FiscalOS',
      [faltanRent.length ? `incompleto: falta ${faltanRent.join(', ')}` : null, conIva ? 'hay gastos importados con IVA incluido: el resultado queda subestimado' : null].filter(Boolean).join(' · ') || null)
    : faltante(`sin datos suficientes: falta ${faltanRent.join(', ')}`);
  const rentabilidad = {
    ingresos, gastos: lineasGasto,
    referencia: {
      comprasFacturadas: re ? cifra(re.netoGravado, 'verificado', re.fuente, 'compras netas de IVA facturadas por proveedores: no es el costo de lo vendido') : faltante('faltan los comprobantes recibidos'),
      ventasMercadoLibre: imp['ventas-ml'] ? cifra(imp['ventas-ml'].importe, 'importado', `importado: ${imp['ventas-ml'].archivos.join(', ')}`, 'referencia: ya incluidas en la facturación, no se suman') : null,
    },
    iibb: iibbAtribuible, ganancias: ganEstimado, autonomos: contrib?.autonomosMensual ? cifra(contrib.autonomosMensual, 'estimado', 'params/contribuyente.json') : null,
    resultado, faltantes: faltanRent,
    nota: 'El IVA no se resta: lo cobrás por cuenta de ARCA y lo compensás con el de tus compras. Afecta la caja (y cuándo pagás), no el resultado económico.',
  };

  // ---------- Caja fiscal (qué hay que pagar y cuándo) ----------
  const caja = [
    { impuesto: 'IVA', importe: iva.saldoPendiente.valor ?? iva.declarado.valor ?? iva.estimado.valor, nivel: iva.saldoPendiente.valor != null ? iva.saldoPendiente.nivel : iva.declarado.valor != null ? 'verificado' : iva.estimado.nivel, vence: iva.vencimientoPago.fecha },
    { impuesto: 'Ingresos Brutos', importe: iibb.saldoPendiente.valor ?? iibb.estimado.valor, nivel: iibb.saldoPendiente.valor != null ? iibb.saldoPendiente.nivel : iibb.estimado.nivel, vence: null },
    { impuesto: 'Ganancias (provisión)', importe: ganEstimado.valor, nivel: ganEstimado.nivel, vence: null },
  ];

  return {
    mes, hoy, iva, iibb, ganancias, autonomos, rentabilidad, caja, pagosDelMes: pagosMes,
    obligaciones: obligaciones(datosDir, hoy),
    importado: Object.fromEntries(Object.entries(imp).map(([k, v]) => [k, { ...v, nombre: CONCEPTOS[k]?.nombre ?? k }])),
    configuracion: { contribuyente: !!contrib, iibbEstimable: alic > 0, iibbParaGanancias },
    integraciones: integraciones(mes),
  };
}
