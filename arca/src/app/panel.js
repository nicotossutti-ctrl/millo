/**
 * Modelo del panel mensual de FiscalOS: arma, para un mes de facturación, cada impuesto (IVA, IIBB,
 * Ganancias, autónomos), los pagos de impuestos del mes, lo que deja para pagar y las obligaciones registradas en ARCA,
 * con los datos YA conservados (out/datos) y los importados o cargados a mano (out/importados). No abre ARCA.
 * FiscalOS es solo impositivo: no calcula costos ni rentabilidad comercial (eso es de PFOS). Para proyectar Ganancias
 * recibe el resultado comercial de cada mes ya calculado por PFOS.
 *
 * Cada cifra lleva su NIVEL, que la interfaz muestra siempre:
 *   verificado -> leído de ARCA y validado por FiscalOS (fuente y fecha de consulta);
 *   importado  -> de un archivo que cargó la persona (nombre del archivo);
 *   estimado   -> cálculo de FiscalOS con supuestos explícitos (nunca se presenta como dato);
 *   faltante   -> no hay dato: se dice qué falta y cómo obtenerlo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { generarInformeIva, tablaDe } from '../informeIva.js';
import { leerVigente } from '../portal/conservacion.js';
import { leerManifiesto } from '../portal/misComprobantes.js';
import { periodoDe, importeDe } from '../portal/ivaDdjj.js';
import { fechaIso } from '../portal/calidad.js';
import { estimar, alicuotaIIBB } from '../estimacion.js';
import { importadoDelMes, mesesImportados, CONCEPTOS } from './importar.js';
import { manualesDelMes, listarManuales } from './manuales.js';
import { comprobantesMes } from './comprobantes.js';
import { leerFotos } from '../pfos/fotos.js';
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

/** Meses con datos (comprobantes, DJ, pagos, importaciones, fotos de PFOS) más el mes anterior a hoy; del más nuevo al más viejo. */
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
  for (const c of listarManuales(outDir)) if (!CONCEPTOS[c.concepto]?.anual) s.add(c.mes); // lo anual (DJ de Ganancias) no abre un mes
  for (const f of leerFotos(outDir)) s.add(f.mes); // meses con la conciliación de PFOS
  return [...s].filter((m) => m <= hoy.slice(0, 7)).sort().reverse();
}

/** Contribuyente (params/contribuyente.json) si existe; si no, null (las estimaciones quedan faltantes). */
export function contribuyente(paramsFile) {
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

/** Pagos de Cuentas Tributarias de un impuesto IMPUTADOS al período `mes` (cualquier fecha de pago). */
export function pagosDelPeriodo(datosDir, mes, clave) {
  const out = []; const vistos = new Set();
  for (const v of vigentes(datosDir, 'ct-pagos')) {
    for (const t of v.tablas) {
      const ii = col(t.headers, /impuesto/); const im = col(t.headers, /importe/); const fe = col(t.headers, /fecha/); const ip = col(t.headers, /periodo/);
      for (const f of t.rows) {
        const per = periodoFiscal(f[ip]);
        if (clasificarImpuesto(f[ii]).clave !== clave || per?.tipo !== 'mes' || per.mes !== mes) continue;
        const k = f.join('|'); if (vistos.has(k)) continue; vistos.add(k); // ventanas que se superponen
        out.push({ fecha: fechaIso(f[fe]), importe: importeDe(f[im]) });
      }
    }
  }
  return out;
}

/** Volantes de pago de SIFERE (IIBB) del anticipo `mes`, si se conservaron. Verificados. */
export function volantesSifere(datosDir, mes) {
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
  const man = manualesDelMes(outDir, mes);
  // Carga manual (corrige o completa) > archivo importado. Nunca se suman entre sí.
  const importado = (k) => (man[k] ? cifra(man[k].importe, man[k].estimado ? 'estimado' : 'manual', `carga manual: ${[...new Set(man[k].cargas.map((c) => c.fuente))].join(', ')}`, man[k].cargas[0].nota || null)
    : imp[k] ? cifra(imp[k].importe, 'importado', `importado: ${imp[k].archivos.join(', ')}`, imp[k].incluyeIva ? 'el archivo incluye IVA' : null) : null);
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
  const iibbDeclarado = importado('iibb-declarado') ?? faltante('cargá el impuesto determinado del CM03 del mes (SIFERE no se lee todavía)');
  const iibbEstimado = em && alic > 0 ? cifra(em.netoGravado * alic, 'estimado', 'facturación neta × alícuota efectiva', `alícuota efectiva ${r2(alic * 100)}% (params/contribuyente.json)`)
    : faltante(em ? 'configurá las jurisdicciones y alícuotas en params/contribuyente.json' : 'faltan los comprobantes emitidos del mes');
  const iibbPagado = iibbPagos.length ? cifra(iibbPagos.reduce((n, c) => n + c.valor, 0), iibbPagos.every((c) => c.nivel === 'verificado') ? 'verificado' : iibbPagos[0].nivel, iibbPagos.map((c) => c.fuente).join(' + ')) : faltante('sin pagos de IIBB registrados ni cargados');
  const iibb = {
    impuesto: 'Ingresos Brutos', periodo: mes, declarado: iibbDeclarado, estimado: iibbEstimado, pagos: iibbPagado,
    saldoPendiente: iibbDeclarado.valor != null ? cifra(Math.max(0, iibbDeclarado.valor - (iibbPagado.valor ?? 0)), iibbDeclarado.nivel, 'declarado − pagos', iibbPagado.valor == null ? 'sin pagos registrados' : null) : faltante('falta lo declarado'),
    vencimientoPresentacion: { fecha: null, nivel: 'faltante', nota: 'calendario de Convenio Multilateral no cargado' },
    vencimientoPago: { fecha: null, nivel: 'faltante', nota: 'calendario de Convenio Multilateral no cargado' },
    estado: iibbDeclarado.valor != null ? estadoPago(iibbDeclarado.valor, iibbPagos) : iibbEstimado.valor != null ? 'solo estimado' : 'sin datos',
  };

  // ---------- Ganancias (provisión del mes) ----------
  // Proyección impositiva: el resultado comercial de cada mes lo calcula PFOS (antes de impuestos); FiscalOS le aplica lo
  // fiscal (IIBB y autónomos deducibles, deducciones personales y la escala). Sin el resultado de PFOS de algún mes del
  // año, NO es estimable: nunca se reconstruye el resultado acá ni se usan las compras.
  let ganEstimado; let iibbParaGanancias = null;
  if (!contrib) ganEstimado = faltante('para estimar Ganancias falta params/contribuyente.json (deducciones, autónomos, IIBB)');
  else {
    const meses = []; const sinFacturacion = []; const sinResultado = [];
    for (let i = 1; i <= Number(mes.slice(5)); i++) {
      const m = `${anio}-${String(i).padStart(2, '0')}`;
      const em = comprobantesMes(datosDir, 'comprobantes-emitidos', 'emitidos', m);
      const rc = manualesDelMes(outDir, m)['resultado-comercial'] ?? importadoDelMes(outDir, m)['resultado-comercial'];
      if (!em) sinFacturacion.push(m);
      if (!rc) sinResultado.push(m);
      if (em && rc) meses.push({ mes: m, ventasNetas: em.netoGravado, resultadoBruto: rc.importe, gastosNetos: r2(em.netoGravado - rc.importe) });
    }
    if (sinFacturacion.length || sinResultado.length) {
      ganEstimado = faltante(`no estimable: la provisión se calcula sobre el resultado acumulado del año; ${[sinFacturacion.length ? `faltan los comprobantes emitidos de ${sinFacturacion.join(', ')}` : null, sinResultado.length ? `falta el resultado comercial de PFOS de ${sinResultado.join(', ')}` : null].filter(Boolean).join('; ')}`);
    } else {
      const est = estimar(Number(anio), meses, contrib).at(-1);
      iibbParaGanancias = est.iibb;
      ganEstimado = cifra(est.ganancias, 'estimado', 'escala de Ganancias sobre el resultado proyectado del año',
        `provisión del mes; base = resultado comercial de PFOS − IIBB − autónomos de cada mes; proyección anual ${est.proyeccionAnual}. No es la DJ anual (F.711) ni un anticipo`);
    }
  }
  // Ganancias es ANUAL: un pago con fecha en el mes (anticipo o saldo de DJ) se imputa a un período
  // fiscal anual; no es la carga del mes. Se muestra con su período en "Pagos realizados en el mes".
  const pagosMes = pagosDelMes(datosDir, mes);
  const ganPagosMes = pagosMes.filter((x) => x.clasificacion.clave === 'ganancias');
  const ganImp = importado('ganancias-anticipo');
  // DJ anual del año anterior (de ella salen los anticipos de este año): la carga el contribuyente, una vez por año.
  const djAnt = manualesDelMes(outDir, `${Number(anio) - 1}-12`)['ganancias-determinado'] ?? importadoDelMes(outDir, `${Number(anio) - 1}-12`)['ganancias-determinado'];
  const ganancias = {
    impuesto: 'Ganancias', periodo: mes, declarado: faltante('es anual: la DJ de Ganancias (F.711) no se lee todavía'), estimado: ganEstimado,
    djAnterior: djAnt ? cifra(djAnt.importe, djAnt.cargas ? 'manual' : 'importado', `DJ ${Number(anio) - 1}`, 'impuesto determinado del año anterior: base de los anticipos de este año') : faltante(`falta la DJ ${Number(anio) - 1} (cargala desde el cartel de pendientes)`),
    pagos: faltante('impuesto anual: los pagos no se atribuyen a un mes'),
    pagosEnElMes: ganPagosMes.length || ganImp ? cifra((ganPagosMes.reduce((n, x) => n + (x.importe ?? 0), 0)) + (ganImp?.valor ?? 0), ganImp && !ganPagosMes.length ? 'importado' : 'verificado',
      'ct-pagos', ganPagosMes.map((x) => `${fechaDma(x.fecha)}: ${x.imputadoA}`).join(' · ') || null) : null,
    saldoPendiente: faltante('se determina en la DJ anual'),
    vencimientoPresentacion: { fecha: null, nivel: 'faltante', nota: 'DJ anual' }, vencimientoPago: { fecha: null, nivel: 'faltante', nota: 'ver obligaciones (anticipos) registradas en ARCA' },
    estado: ganEstimado.valor != null ? 'provisión estimada' : 'sin datos',
  };

  // ---------- Autónomos ----------
  const autPagosCt = pagosMes.filter((x) => x.clasificacion.clave === 'autonomos');
  const autPeriodo = pagosDelPeriodo(datosDir, mes, 'autonomos');
  const autImp = importado('autonomos');
  const autonomos = {
    impuesto: 'Autónomos', periodo: mes,
    // Cuota del mes: carga manual > pagos registrados en ARCA imputados a ESTE período > params > faltante.
    declarado: importado('autonomos-cuota')
      ?? (autPeriodo.length ? cifra(suma(autPeriodo), 'verificado', 'Cuentas Tributarias', `${autPeriodo.length} pago(s) imputados al período`) : null)
      ?? (contrib?.autonomosMensual ? cifra(contrib.autonomosMensual, 'estimado', 'params/contribuyente.json', 'cuota mensual configurada') : faltante('sin pagos del período en ARCA: cargá la cuota del mes')),
    pagos: autPagosCt.length ? cifra(suma(autPagosCt), 'verificado', autPagosCt[0].fuente) : autImp ?? faltante('sin pagos registrados en el mes'),
  };

  // ---------- Pagos de impuestos con fecha en el mes (cualquier período) ----------
  const pagos = pagosDeCaja(outDir, mes, pagosMes, man, imp);

  // ---------- Lo que el mes deja para pagar más adelante ----------
  const deja = [
    { impuesto: 'IVA', cifra: iva.saldoPendiente.valor != null ? iva.saldoPendiente : iva.declarado, vence: iva.vencimientoPago.fecha,
      nota: iva.saldoPendiente.nivel === 'verificado' && inf.conciliacion.saldoPendiente != null ? 'saldo exigible confirmado (deuda registrada en Cuentas Tributarias)'
        : iva.vencimientoPago.fecha && iva.vencimientoPago.fecha >= hoy ? 'no vencido (régimen del contribuyente)' : iva.vencimientoPago.fecha ? 'vencido' : null },
    { impuesto: 'Ingresos Brutos', cifra: iibb.saldoPendiente.valor != null ? iibb.saldoPendiente : iibb.estimado, vence: null,
      nota: iibb.saldoPendiente.valor != null ? `declarado − pagos (${iibb.estado})` : 'estimado: falta lo declarado' },
    { impuesto: 'Ganancias', cifra: ganEstimado, vence: null, nota: 'provisión estimada; se paga con la DJ anual y sus anticipos' },
  ];

  return {
    mes, hoy, iva, iibb, ganancias, autonomos, pagos, deja, pagosDelMes: pagosMes,
    manuales: listarManuales(outDir).filter((c) => c.mes === mes),
    obligaciones: obligaciones(datosDir, hoy),
    importado: Object.fromEntries(Object.entries(imp).map(([k, v]) => [k, { ...v, nombre: CONCEPTOS[k]?.nombre ?? k }])),
    configuracion: { contribuyente: !!contrib, iibbEstimable: alic > 0, iibbParaGanancias },
    integraciones: integraciones(outDir, mes),
  };
}

/**
 * Estado del pago de un impuesto declarado. «No encontrado» = falta evidencia, NO prueba que esté impago. Un pago parcial
 * no silencia la obligación. `pagos`: [cifra] con su nivel ('verificado' = leído de ARCA o SIFERE; si no, cargado a mano).
 */
export function estadoPago(declarado, pagos = []) {
  if (declarado == null) return 'sin declarar';
  if (declarado <= 0) return 'sin saldo a pagar';
  const total = pagos.reduce((n, c) => n + (c.valor ?? 0), 0);
  if (!pagos.length || total <= 0) return 'pago no encontrado (sin cobertura)';
  if (total < declarado - 1) return 'pago parcial: falta conciliar';
  return pagos.every((c) => c.nivel === 'verificado') ? 'pagado verificado' : 'pago cargado a mano';
}

/** Pagos de impuestos con fecha en el mes (ARCA) y los cargados o importados a mano, sin sumar dos veces. */
function pagosDeCaja(outDir, mes, pagosMes, man, imp) {
  const filas = pagosMes.map((x) => ({ fecha: x.fecha, impuesto: x.clasificacion.nombre, detalle: x.impuesto, corresponde: x.imputadoA, importe: x.importe, propio: x.clasificacion.propio, nivel: 'verificado', fuente: 'Cuentas Tributarias' }));
  for (const [k, nombre] of [['iibb-pagado', 'Ingresos Brutos'], ['ganancias-anticipo', 'Ganancias'], ['autonomos', 'Autónomos']]) {
    const src = man[k] ? { nivel: 'manual', importe: man[k].importe, fuente: 'carga manual' } : imp[k] ? { nivel: 'importado', importe: imp[k].importe, fuente: 'archivo importado' } : null;
    if (!src) continue;
    const yaEnArca = filas.some((p) => p.impuesto === nombre && p.nivel === 'verificado');
    filas.push({ fecha: null, impuesto: nombre, detalle: CONCEPTOS[k].nombre, corresponde: 'según la carga', importe: Math.abs(src.importe), propio: true, nivel: src.nivel, fuente: src.fuente, posibleDuplicado: yaEnArca });
  }
  const sumar = (f) => r2(filas.filter(f).reduce((n, p) => n + (p.importe ?? 0), 0));
  return { filas, propios: sumar((p) => p.propio !== false), comoAgente: sumar((p) => p.propio === false), total: sumar(() => true) };
}
