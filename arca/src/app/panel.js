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
import { cm03Sifere, djAnualGanancias, djDelPeriodo } from './presentaciones.js';
import { conciliarPagos, pagosCargadosEnCaja, pagosCargadosDelPeriodo, pagosSinFecha } from './pagos.js';
import { cm03DelPeriodo } from './cm03.js';
import { ddjjGananciasDelAnio } from './ddjjGanancias.js';
import { conciliarIibb, claveJurisdiccion } from './iibbConciliacion.js';

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
export function vigentes(datosDir, id) {
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
  // Seguridad social como EMPLEADOR (F.931): aportes retenidos al personal y contribuciones del empleador. Categoría aparte:
  // ni impuesto propio sobre la actividad ni retenciones como agente de un impuesto.
  if ([301, 302, 312, 351, 352, 28, 360].includes(codigo) || /empleador|contribuc|obra social|riesgo.*trabajo|seg\.? ?social/.test(t)) return { clave: 'empleador', nombre: 'Seguridad social (empleador)', propio: 'empleador', codigo };
  if (/bienes personales/.test(t)) return { clave: 'bienes-personales', nombre: 'Bienes Personales', propio: true, codigo };
  return { clave: 'otro', nombre: texto ? String(texto) : 'sin impuesto', propio: null, codigo };
}

/**
 * Pagos de Cuentas Tributarias con FECHA de pago en el mes (todos los impuestos), cada uno con su
 * impuesto, formulario, período fiscal al que se imputó y a qué corresponde. Es el flujo de caja
 * real del mes; NO es la carga atribuible al mes (un pago de septiembre puede ser de otro período).
 */
export function pagosDelMes(datosDir, mes) {
  const out = []; const vistos = new Set();
  for (const v of vigentes(datosDir, 'ct-pagos')) {
    for (const t of v.tablas) {
      const ii = col(t.headers, /impuesto/); const im = col(t.headers, /importe/); const fe = col(t.headers, /fecha/); const ip = col(t.headers, /periodo/);
      const fo = col(t.headers, /formulario/); const ve = col(t.headers, /version/); const ob = col(t.headers, /observ/); const co = col(t.headers, /^concepto/);
      for (const f of t.rows) {
        const fechaIsoPago = fechaIso(f[fe]);
        if ((fechaIsoPago ?? '').slice(0, 7) !== mes) continue;
        const k = f.join('|'); if (vistos.has(k)) continue; vistos.add(k); // ventanas de consulta que se superponen
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

/**
 * Filas de la cuenta corriente de CCMA (autónomos) del período `mes`, tal como las leyó ccma.js: { columnas, filas,
 * fuente } o null. Las columnas todavía no están confirmadas con una corrida real: se muestran como evidencia y no se
 * deriva de ellas ningún importe.
 */
export function ccmaDelPeriodo(datosDir, mes) {
  const [y, m] = mes.split('-');
  const del = (c) => new RegExp(`\\b(${m}/${y}|${y}${m}|${y}-${m}|${y}/${m})\\b`).test(String(c ?? ''));
  for (const v of vigentes(datosDir, 'ccma')) {
    for (const t of v.tablas) {
      const ip = col(t.headers, /periodo/);
      if (ip < 0) continue;
      const filas = t.rows.filter((f) => del(f[ip]));
      return { columnas: t.headers, filas, fuente: `CCMA (${v.entrada.cuando}, columnas sin confirmar)` };
    }
  }
  return null;
}

/** Pagos de Cuentas Tributarias de un impuesto imputados al período fiscal ANUAL `anio` (Ganancias: anticipos y saldo). */
export function pagosDelAnio(datosDir, anio, clave) {
  const out = []; const vistos = new Set();
  for (const v of vigentes(datosDir, 'ct-pagos')) {
    for (const t of v.tablas) {
      const ii = col(t.headers, /impuesto/); const im = col(t.headers, /importe/); const fe = col(t.headers, /fecha/); const ip = col(t.headers, /periodo/);
      for (const f of t.rows) {
        const per = periodoFiscal(f[ip]);
        if (clasificarImpuesto(f[ii]).clave !== clave || per?.tipo !== 'anual' || per.anio !== String(anio)) continue;
        const k = f.join('|'); if (vistos.has(k)) continue; vistos.add(k);
        out.push({ fecha: fechaIso(f[fe]), importe: importeDe(f[im]) });
      }
    }
  }
  return out;
}

/**
 * DJ anual de Ganancias de `anio` leída de su PDF, con el saldo que DECLARÓ y los pagos de Cuentas Tributarias imputados
 * a ese período con fecha desde la presentación (los anticipos anteriores ya son «pagos a cuenta» de la DJ). El saldo
 * declarado no es la deuda de hoy: «restante» es una conciliación con lo bajado, no un saldo exigible confirmado (puede
 * haber planes de pago o pagos fuera de la cobertura de lo bajado). null si no hay DJ leída.
 */
export function djAnualLeida(outDir, datosDir, anio) {
  const d = ddjjGananciasDelAnio(outDir, anio).vigente;
  if (!d) return null;
  const fuente = `F.${d.formulario} ${d.anio} ${d.secuencia ? `rectificativa ${d.secuencia}` : 'original'} (PDF${d.fechaPresentacion ? `, presentada el ${fechaDma(d.fechaPresentacion)}` : ''})`;
  const saldo = r2((d.saldoAFavorArca ?? 0) - (d.saldoAFavorContribuyente ?? 0));
  const posteriores = d.fechaPresentacion ? pagosDelAnio(datosDir, anio, 'ganancias').filter((p) => p.fecha && p.fecha >= d.fechaPresentacion) : [];
  const pagado = suma(posteriores) ?? 0;
  return {
    anio: d.anio, formulario: d.formulario, secuencia: d.secuencia, fecha: d.fechaPresentacion, fuente,
    determinado: cifra(d.impuestoDeterminado, 'importado', fuente, 'impuesto determinado del año: base de los anticipos del año siguiente'),
    pagosACuenta: cifra(d.pagosACuenta, 'importado', fuente, 'anticipos, retenciones y percepciones computados en la DJ'),
    saldoDeclarado: cifra(saldo, 'importado', fuente, saldo >= 0 ? 'saldo a favor de ARCA que declaró la DJ: no es necesariamente la deuda de hoy' : 'saldo a favor del contribuyente que declaró la DJ'),
    pagosPosteriores: posteriores.length ? cifra(pagado, 'verificado', 'Cuentas Tributarias', `${posteriores.length} pago(s) imputados al período ${anio} desde la presentación`) : faltante(`sin pagos imputados al período ${anio} desde la presentación en lo bajado de Cuentas Tributarias (no prueba que esté impago: puede haber un plan de pagos)`),
    restante: saldo <= 0 ? cifra(0, 'importado', fuente, 'la DJ no dejó saldo a pagar') : pagado >= saldo - 1 ? cifra(0, 'verificado', 'saldo de la DJ − pagos posteriores', 'cubierto por los pagos registrados en Cuentas Tributarias')
      : { ...faltante(pagado ? `saldo sin conciliar: la DJ declaró ${saldo} y se encontraron pagos posteriores por ${pagado}`
        : `saldo sin conciliar: la DJ declaró ${saldo} y no se encontraron pagos posteriores imputados al período (no prueba que esté impago: puede haber un plan de pagos o pagos fuera de lo bajado)`), diferencia: r2(saldo - pagado) },
  };
}

/**
 * Volantes de pago de SIFERE (IIBB) del anticipo `mes`, si se conservaron. Un volante GENERADO no es un pago: solo
 * cuenta como pagado si su estado lo dice (pagado, abonado, acreditado). `pagado` lo indica; los demás se muestran como
 * «volante generado, pago sin verificar» y no se descuentan.
 */
/**
 * ¿El estado de un volante de SIFERE dice, sin ambigüedad, que está pagado? Pura. Solo un estado entero positivo
 * («Pagado», «Abonada», «Acreditado», «Pagado total»): «NO PAGADO», «Impagado», «Pago parcial», «Pendiente de pago»,
 * «Generado», «Sin pagar», «Rechazado» o «Anulado» no cuentan, y un estado desconocido tampoco (pago sin verificar).
 */
export function volantePagado(estado) {
  const e = norm(estado).replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!e || /\b(no|sin|im|in|des|parcial|pendiente|generad|rechaz|anulad|vencid|revertid|devuelt|a pagar|por pagar)/.test(e)) return false;
  return /^(pagad[oa]|abonad[oa]|acreditad[oa])( (total|totalmente))?$/.test(e);
}

/**
 * Pagos de IIBB del período `mes` según SIFERE WEB – Consultas (sifereConsultas.js: una consulta por jurisdicción). Un
 * pago cuenta como VERIFICADO solo con evidencia positiva: un estado que diga pagado (volantePagado) o, si la consulta no
 * tiene estado, una columna de FECHA DE PAGO con una fecha válida; una fecha genérica (emisión, generación) no alcanza.
 * Devuelve { pagos, consultado, consultas } — consultas: por código de jurisdicción, si SIFERE se consultó y con qué
 * resultado ('consultada' o 'sin consulta confirmada', con su motivo), según las filas de constancia que se guardan.
 */
export function pagosConsultasIibb(datosDir, mes) {
  const out = []; const vistos = new Set(); let consultado = false; const consultas = new Map(); const avisos = [];
  const marcar = (cod, estado, motivo) => { if (cod && (consultas.get(cod)?.estado !== 'consultada')) consultas.set(cod, { estado, motivo }); };
  for (const v of vigentes(datosDir, 'sifere-consultas-web-pagos')) {
    consultado = true;
    // Una lectura posterior con menos pagos no reemplazó a esta (conservación): se avisa, sin borrar ni sumar nada.
    const pr = v.entrada.pendienteRevision;
    if (pr?.grupos && v.clave.startsWith(`${mes}-`)) avisos.push(`La consulta del ${pr.cuando} trajo menos pagos (${pr.grupos.map((g) => `${g.grupo ?? 'total'}: ${g.antes} → ${g.ahora}`).join('; ')}); se conservan los pagos guardados el ${v.entrada.cuando}: revisar en SIFERE.`);
    for (const t of v.tablas) {
      const h = t.headers.map(norm);
      const idx = (re, no = null) => h.findIndex((x) => re.test(x) && !(no && no.test(x)));
      const ip = idx(/anticipo|periodo/, /consultad/); const ipc = idx(/periodo consultad/);
      const ij = idx(/jurisdic/, /consultad/); const ijc = idx(/jurisdiccion consultad/); const ires = idx(/resultado de la consulta/);
      const im = idx(/importe|monto/); const ifp = idx(/fecha.*pago|pago.*fecha|acreditaci/); const ie = idx(/^estado/);
      const ic = idx(/vep|comprobante|transacci|numero|nro/);
      for (const f of t.rows) {
        const crudo = (ip >= 0 && String(f[ip] ?? '').trim()) || (ipc >= 0 ? f[ipc] : null); // constancias: sin anticipo, con el período consultado
        const ant = String(crudo ?? '').match(/^(\d{4})(\d{2})\b/);
        const iso = String(crudo ?? '').match(/^(\d{4})-(\d{2})(-\d{2})?$/); // «Período consultado»: AAAA-MM-01
        if ((iso ? `${iso[1]}-${iso[2]}` : ant ? `${ant[1]}-${ant[2]}` : periodoDe(crudo)) !== mes) continue;
        const jurisdiccion = (ij >= 0 ? String(f[ij] ?? '').trim() : '') || (ijc >= 0 ? String(f[ijc] ?? '').trim() : '') || null;
        const cod = jurisdiccion ? claveJurisdiccion(jurisdiccion) : null;
        const resultado = ires >= 0 ? String(f[ires] ?? '').trim() : 'pago';
        if (resultado !== 'pago') { marcar(cod, /^sin pagos informados/.test(resultado) ? 'consultada' : 'sin consulta confirmada', resultado); continue; }
        if (im < 0) continue;
        const k = f.join('|'); if (vistos.has(k)) continue; vistos.add(k); // ventanas que se superponen
        marcar(cod, 'consultada', null);
        const estado = ie >= 0 ? f[ie] : null;
        const fechaPago = ifp >= 0 ? fechaIso(f[ifp]) : null;
        const verificado = ie >= 0 ? volantePagado(estado) : !!fechaPago;
        out.push({ importe: importeDe(f[im]), fecha: fechaPago, jurisdiccion, comprobante: ic >= 0 ? String(f[ic] ?? '').trim() || null : null, estado, verificado, nivel: 'verificado',
          motivo: verificado ? null : ie >= 0 ? `estado «${estado ?? ''}»: no dice pagado` : 'sin estado ni fecha de pago: no se confirma que esté pagado',
          fuente: `SIFERE Consultas · pagos (${v.entrada.cuando})` });
      }
    }
  }
  return { pagos: out, consultado, consultas, avisos };
}

export function volantesSifere(datosDir, mes) {
  const out = [];
  for (const v of vigentes(datosDir, 'sifere-consultas-volantes-pago')) {
    for (const t of v.tablas) {
      const ia = col(t.headers, /anticipo/); const im = col(t.headers, /monto total/); const ie = col(t.headers, /^estado/); const iv = col(t.headers, /vep/);
      if (ia < 0 || im < 0) continue;
      for (const f of t.rows) {
        // Anticipo como lo muestra SIFERE («202609 - 0») u otros formatos de período.
        const ant = String(f[ia] ?? '').match(/^(\d{4})(\d{2})\b/);
        if ((ant ? `${ant[1]}-${ant[2]}` : periodoDe(f[ia])) !== mes || (ie >= 0 && /anulad|rechaz|vencid/.test(norm(f[ie])))) continue;
        const estado = ie >= 0 ? f[ie] : null;
        out.push({ anticipo: f[ia], importe: importeDe(f[im]), estado, pagado: volantePagado(estado), vep: iv >= 0 ? String(f[iv] ?? '').trim() || null : null, fuente: `SIFERE volantes (${v.entrada.cuando})` });
      }
    }
  }
  return out;
}

const fechaDma = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');
const suma = (xs) => (xs.length ? r2(xs.reduce((n, x) => n + (x.importe ?? 0), 0)) : null);

/** Obligaciones registradas en Cuentas Tributarias (vencimientos y deudas de todos los impuestos). */
export function obligaciones(datosDir, hoy) {
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
  // Tres cosas distintas: el impuesto DETERMINADO (la carga del mes), el TOTAL A PAGAR de la CM03 (lo que queda después
  // de saldos a favor, retenciones y percepciones, jurisdicción por jurisdicción) y los PAGOS comprobados. Presentar la
  // CM03 no es pagarla; un saldo a favor de una jurisdicción no cancela lo que se debe en otra.
  const alic = contrib ? alicuotaIIBB(contrib) : 0;
  const ip = pagosIibbDelPeriodo(outDir, datosDir, mes);
  const iibbPagos = ip.computados.map((x) => cifra(x.importe, x.nivel, x.fuente, x.fecha ? `pagado el ${fechaDma(x.fecha)}` : null));
  const cm = cm03DelPeriodo(outDir, mes); const cmv = cm.vigente;
  const listaSifere = cm03Sifere(datosDir, mes);
  const fuenteCm = cmv ? `CM03 ${cmv.rectificativa ? `rectificativa ${cmv.rectificativa}` : 'original'} (PDF de SIFERE${cmv.fechaPresentacion ? `, presentada el ${fechaDma(cmv.fechaPresentacion.slice(0, 10))}` : ''})` : null;
  const iibbAvisos = [];
  const detManual = importado('iibb-declarado'); const aPagarManual = importado('iibb-a-pagar-segun-cm03');
  const iibbDeclarado = cmv ? cifra(cmv.impuestoDeterminadoTotal, 'importado', fuenteCm, 'impuesto determinado de todas las jurisdicciones: es la carga del mes, no lo que se paga')
    : detManual ?? faltante('importá el PDF de la CM03 del mes (SIFERE: DDJJ Mensuales > Listado > «Reporte») o cargá su impuesto determinado');
  const iibbAPagar = cmv ? cifra(cmv.totalAPagarDeclarado, 'importado', fuenteCm, 'lo que queda para pagar después de saldos a favor, retenciones y percepciones, sumando solo las jurisdicciones con saldo a pagar')
    : aPagarManual ?? faltante('falta el total a pagar de la CM03: el impuesto determinado no es lo que se paga');
  if (cmv && detManual && Math.abs(detManual.valor - cmv.impuestoDeterminadoTotal) > 1) iibbAvisos.push(`la carga del impuesto determinado (${detManual.valor}) no coincide con la CM03 importada (${cmv.impuestoDeterminadoTotal}): se usa la CM03`);
  if (cmv && aPagarManual && Math.abs(aPagarManual.valor - cmv.totalAPagarDeclarado) > 1) iibbAvisos.push(`la carga del total a pagar (${aPagarManual.valor}) no coincide con la CM03 importada (${cmv.totalAPagarDeclarado}): se usa la CM03`);
  const ultimaSifere = listaSifere?.presentada?.rectificativa;
  if (cmv && ultimaSifere != null && ultimaSifere > cmv.rectificativa) iibbAvisos.push(`SIFERE muestra presentada la rectificativa ${ultimaSifere} y la CM03 importada es la ${cmv.rectificativa ? `rectificativa ${cmv.rectificativa}` : 'original'}: importá el reporte de la rectificativa ${ultimaSifere}`);
  for (const r of cm.enRevision) iibbAvisos.push(`el PDF «${r.archivo}» quedó en revisión y no se usa: ${r.motivos.join('; ')}`);
  const iibbEstimado = em && alic > 0 ? cifra(em.netoGravado * alic, 'estimado', 'facturación neta × alícuota efectiva', `alícuota efectiva ${r2(alic * 100)}% (params/contribuyente.json)`)
    : faltante(em ? 'configurá las jurisdicciones y alícuotas en params/contribuyente.json' : 'faltan los comprobantes emitidos del mes');
  const iibbPagado = iibbPagos.length ? cifra(iibbPagos.reduce((n, c) => n + c.valor, 0), iibbPagos.every((c) => c.nivel === 'verificado') ? 'verificado' : iibbPagos[0].nivel, iibbPagos.map((c) => c.fuente).join(' + ')) : faltante('sin pagos de IIBB registrados ni cargados');
  const conciliacion = cmv ? (() => {
    // Pagos con jurisdicción de SIFERE Consultas; los demás pagos del período ya sin duplicados (volantes pagados, sin
    // jurisdicción); las cargas a mano (no verificadas por el organismo); volantes sin pago o inciertos (no cuentan).
    const pc = pagosConsultasIibb(datosDir, mes);
    const otros = ip.computados.filter((x) => !String(x.fuente ?? '').startsWith('SIFERE Consultas'))
      .map((x) => ({ importe: x.importe, fecha: x.fecha ?? null, jurisdiccion: null, comprobante: x.comprobante ?? null, verificado: x.nivel === 'verificado', manual: x.nivel !== 'verificado', nivel: x.nivel, fuente: x.fuente }));
    const sinConfirmar = [...ip.volantesSinPago.map((v) => ({ importe: v.importe, estado: v.estado, verificado: false, fuente: 'SIFERE: volante generado' })),
      ...ip.volantesInciertos.map((v) => ({ importe: v.importe, estado: `${v.estado} · posible mismo pago que uno de SIFERE Consultas`, comprobante: v.vep, verificado: false, fuente: v.fuente }))];
    return { ...conciliarIibb({ jurisdicciones: cmv.jurisdicciones, pagos: [...pc.pagos, ...otros, ...sinConfirmar], consultado: pc.consultado, consultas: pc.consultas }), avisos: pc.avisos };
  })() : null;
  const iibb = {
    impuesto: 'Ingresos Brutos', periodo: mes, declarado: iibbDeclarado, aPagar: iibbAPagar, estimado: iibbEstimado, pagos: iibbPagado,
    aFavorContribuyente: cmv ? cifra(cmv.aFavorContribuyenteTotal, 'importado', fuenteCm, 'saldos a favor de cada jurisdicción: no cancelan lo que se debe en otras') : faltante('sin la CM03 importada'),
    porJurisdiccion: cmv ? cmv.jurisdicciones.map(({ jurisdiccion, codigo, determinado, aFavorContribuyente, aFavorFisco, aPagar }) => ({ jurisdiccion, codigo: codigo ?? null, determinado, aFavorContribuyente, aFavorFisco, aPagar })) : null,
    // Conciliación por jurisdicción: a pagar según la CM03 contra los pagos verificados que dicen su jurisdicción.
    conciliacion,
    // Con la CM03 leída, el saldo sale de la conciliación POR JURISDICCIÓN (no se compensan provincias ni se imputan pagos
    // sin jurisdicción); sin CM03 (total a pagar cargado a mano), del total.
    saldoPendiente: conciliacion ? (conciliacion.total.saldo != null
      ? cifra(conciliacion.total.saldo, 'verificado', 'CM03 − pagos verificados por jurisdicción', 'cada jurisdicción con importe a pagar está conciliada')
      : { ...faltante(`sin conciliar por jurisdicción: ${conciliacion.total.motivo}`), diferencia: conciliacion.total.aPagar - (conciliacion.total.pagadoVerificado ?? 0) })
      : saldoIibb(iibbAPagar, iibbPagos, cmv?.jurisdicciones ?? null),
    // Presentación: la lista de DJ CM03 de SIFERE (fecha y rectificativa) o el reporte importado.
    presentacion: (() => {
      const c = listaSifere;
      if (c?.presentada) return { fecha: fechaIso(String(c.presentada.fechaPresentacion ?? '').slice(0, 10)), nivel: 'verificado', fuente: c.fuente,
        nota: `CM03 ${c.presentada.rectificativa ? `rectificativa ${c.presentada.rectificativa}` : 'original'} presentada${c.presentada.resultado ? ` (${c.presentada.resultado})` : ''}` };
      if (cmv) return { fecha: cmv.fechaPresentacion ? cmv.fechaPresentacion.slice(0, 10) : null, nivel: 'importado', fuente: fuenteCm, nota: `CM03 ${cmv.rectificativa ? `rectificativa ${cmv.rectificativa}` : 'original'} presentada (reporte importado)` };
      return { fecha: null, nivel: 'faltante', nota: c ? `la lista de SIFERE conservada no tiene la CM03 de ${mes} presentada${c.borradores.length ? ' (hay un borrador)' : ''}` : 'no hay listas de SIFERE conservadas' };
    })(),
    vencimientoPresentacion: { fecha: null, nivel: 'faltante', nota: 'calendario de Convenio Multilateral no cargado' },
    vencimientoPago: { fecha: null, nivel: 'faltante', nota: 'calendario de Convenio Multilateral no cargado' },
    estado: iibbAPagar.valor != null ? estadoPago(iibbAPagar.valor, iibbPagos) : iibbDeclarado.valor != null ? 'falta el total a pagar' : iibbEstimado.valor != null ? 'solo estimado' : 'sin datos',
    volantesSinPago: ip.volantesSinPago, pagosNoSumados: [...ip.duplicados, ...ip.inciertos], avisos: iibbAvisos,
    cm03: { vigente: cmv ? { id: cmv.id, archivo: cmv.archivo, rectificativa: cmv.rectificativa, fechaPresentacion: cmv.fechaPresentacion, avisos: cmv.avisos, detalles: cmv.detalles } : null,
      anteriores: cm.anteriores.map((c) => ({ id: c.id, archivo: c.archivo, rectificativa: c.rectificativa })), enRevision: cm.enRevision.map((c) => ({ id: c.id, archivo: c.archivo, motivos: c.motivos })) },
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
      // IIBB y autónomos reales del mes cuando existen (CM03 cargado; cuota cargada o pagos de ARCA imputados al período).
      const cmM = cm03DelPeriodo(outDir, m).vigente;
      const iibbM = cmM ? { importe: cmM.impuestoDeterminadoTotal } : manualesDelMes(outDir, m)['iibb-declarado'] ?? importadoDelMes(outDir, m)['iibb-declarado'];
      const autM = manualesDelMes(outDir, m)['autonomos-cuota'] ?? importadoDelMes(outDir, m)['autonomos-cuota'];
      const autCt = pagosDelPeriodo(datosDir, m, 'autonomos');
      const autonomosReal = autM ? autM.importe : autCt.length ? suma(autCt) : null;
      if (em && rc) meses.push({ mes: m, ventasNetas: em.netoGravado, resultadoBruto: rc.importe, gastosNetos: r2(em.netoGravado - rc.importe), iibbReal: iibbM ? iibbM.importe : null, autonomosReal });
    }
    if (sinFacturacion.length || sinResultado.length) {
      ganEstimado = faltante(`no estimable: la provisión se calcula sobre el resultado acumulado del año; ${[sinFacturacion.length ? `faltan los comprobantes emitidos de ${sinFacturacion.join(', ')}` : null, sinResultado.length ? `falta el resultado comercial de PFOS de ${sinResultado.join(', ')}` : null].filter(Boolean).join('; ')}`);
    } else {
      const est = estimar(Number(anio), meses, contrib).at(-1);
      iibbParaGanancias = est.iibb;
      const iibbHip = meses.filter((x) => x.iibbReal == null).map((x) => x.mes); const autHip = meses.filter((x) => x.autonomosReal == null).map((x) => x.mes);
      ganEstimado = cifra(est.ganancias, 'estimado', 'escala de Ganancias sobre el resultado proyectado del año',
        `provisión del mes; base = resultado comercial de PFOS − IIBB − autónomos de cada mes; proyección anual ${est.proyeccionAnual}. No es la DJ anual (F.711) ni un anticipo. ${[
          iibbHip.length ? `IIBB por alícuota (hipótesis) en ${iibbHip.join(', ')}` : 'IIBB real (CM03) en todos los meses',
          autHip.length ? `autónomos de params (hipótesis) en ${autHip.join(', ')}` : 'autónomos reales en todos los meses'].join('; ')}`);
    }
  }
  // Ganancias es ANUAL: un pago con fecha en el mes (anticipo o saldo de DJ) se imputa a un período
  // fiscal anual; no es la carga del mes. Se muestra con su período en "Pagos realizados en el mes".
  const pagosMes = pagosDelMes(datosDir, mes);
  const pagos = pagosDeCaja(outDir, mes, pagosMes);
  const deCaja = (clave) => pagos.filas.filter((x) => x.computado && x.clave === clave);
  const ganPagosMes = deCaja('ganancias');
  // DJ anual del año anterior (de ella salen los anticipos de este año): la carga el contribuyente, una vez por año.
  // Primero la DJ leída de su PDF (determinado, pagos a cuenta y saldo); si no, la carga a mano del determinado.
  const djLeida = djAnualLeida(outDir, datosDir, Number(anio) - 1);
  const djAnt = manualesDelMes(outDir, `${Number(anio) - 1}-12`)['ganancias-determinado'] ?? importadoDelMes(outDir, `${Number(anio) - 1}-12`)['ganancias-determinado'];
  const ganancias = {
    impuesto: 'Ganancias', periodo: mes, declarado: faltante('es anual: la DJ de Ganancias (F.711) no se lee todavía'), estimado: ganEstimado,
    djAnteriorPresentada: (() => { const d = djAnualGanancias(datosDir, Number(anio) - 1); return d ? { fecha: d.fechaIso, formulario: d.formulario, version: d.version, nivel: 'verificado', fuente: d.fuente } : null; })(),
    djAnual: djLeida,
    djAnterior: djLeida ? djLeida.determinado : djAnt ? cifra(djAnt.importe, djAnt.cargas ? 'manual' : 'importado', `DJ ${Number(anio) - 1}`, 'impuesto determinado del año anterior: base de los anticipos de este año') : faltante(`falta la DJ ${Number(anio) - 1} (cargala desde el cartel de pendientes)`),
    pagos: faltante('impuesto anual: los pagos no se atribuyen a un mes'),
    pagosEnElMes: ganPagosMes.length ? cifra(ganPagosMes.reduce((n, x) => n + (x.importe ?? 0), 0), ganPagosMes.every((x) => x.nivel === 'verificado') ? 'verificado' : 'manual',
      [...new Set(ganPagosMes.map((x) => x.fuente))].join(' + '), ganPagosMes.map((x) => `${fechaDma(x.fecha)}: ${x.corresponde}`).join(' · ') || null) : null,
    saldoPendiente: faltante('se determina en la DJ anual'),
    vencimientoPresentacion: { fecha: null, nivel: 'faltante', nota: 'DJ anual' }, vencimientoPago: { fecha: null, nivel: 'faltante', nota: 'ver obligaciones (anticipos) registradas en ARCA' },
    estado: ganEstimado.valor != null ? 'provisión estimada' : 'sin datos',
  };

  // ---------- Autónomos ----------
  const autPagosCaja = deCaja('autonomos');
  const autPeriodo = pagosDelPeriodo(datosDir, mes, 'autonomos');
  const autonomos = {
    impuesto: 'Autónomos', periodo: mes,
    // Cuota del mes: carga manual > pagos registrados en ARCA imputados a ESTE período > params > faltante.
    declarado: importado('autonomos-cuota')
      ?? (autPeriodo.length ? cifra(suma(autPeriodo), 'verificado', 'Cuentas Tributarias', `${autPeriodo.length} pago(s) imputados al período`) : null)
      ?? (contrib?.autonomosMensual ? cifra(contrib.autonomosMensual, 'estimado', 'params/contribuyente.json', 'cuota mensual configurada') : faltante('sin pagos del período en ARCA: cargá la cuota del mes')),
    pagos: autPagosCaja.length ? cifra(suma(autPagosCaja), autPagosCaja.every((x) => x.nivel === 'verificado') ? 'verificado' : 'manual', [...new Set(autPagosCaja.map((x) => x.fuente))].join(' + ')) : faltante('sin pagos registrados en el mes'),
    ccma: ccmaDelPeriodo(datosDir, mes),
  };


  // ---------- Como empleador (F.931) y como agente de retención (F.744 / SICORE) ----------
  const terceros = obligacionesDeTerceros(outDir, datosDir, mes, hoy);

  // ---------- Lo que el mes deja para pagar más adelante ----------
  const deja = [
    { impuesto: 'IVA', cifra: iva.saldoPendiente.valor != null ? iva.saldoPendiente : iva.declarado, vence: iva.vencimientoPago.fecha,
      nota: iva.saldoPendiente.nivel === 'verificado' && inf.conciliacion.saldoPendiente != null ? 'saldo exigible confirmado (deuda registrada en Cuentas Tributarias)'
        : iva.vencimientoPago.fecha && iva.vencimientoPago.fecha >= hoy ? 'no vencido (régimen del contribuyente)' : iva.vencimientoPago.fecha ? 'vencido' : null },
    { impuesto: 'Ingresos Brutos', cifra: iibb.saldoPendiente.valor != null ? iibb.saldoPendiente : iibb.saldoPendiente.diferencia != null ? cifra(iibb.saldoPendiente.diferencia, 'estimado', 'a pagar según CM03 − pagos', 'saldo sin conciliar') : iibb.estimado, vence: null,
      nota: iibb.saldoPendiente.valor != null ? `a pagar según CM03 − pagos (${iibb.estado})` : iibb.saldoPendiente.diferencia != null ? iibb.saldoPendiente.nota
        : iibb.declarado.valor != null ? 'falta el total a pagar de la CM03 (el impuesto determinado no es lo que se paga): se muestra la estimación' : 'estimado: falta la CM03' },
    { impuesto: 'Ganancias', cifra: ganEstimado, vence: null, nota: 'provisión estimada; se paga con la DJ anual y sus anticipos' },
  ];

  return {
    mes, hoy, iva, iibb, ganancias, autonomos, pagos, deja, terceros, pagosDelMes: pagosMes, djDelPeriodo: djDelPeriodo(datosDir, mes),
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

/**
 * Saldo de IIBB del período: el TOTAL A PAGAR de la CM03 menos los pagos comprobados del período. Nunca el impuesto
 * determinado menos los pagos (los saldos a favor, retenciones y percepciones ya están descontados en la CM03). Sin pagos
 * encontrados, el saldo queda «sin conciliar» (valor null, la cifra declarada aparte): no es una deuda confirmada. Los
 * pagos no dicen a qué jurisdicción van: con una sola jurisdicción a pagar el pago es de ella; con varias y un pago que
 * no cubre el total, también «sin conciliar», sin afirmar cuánto se debe en cada una.
 */
export function saldoIibb(aPagar, pagos = [], jurisdicciones = null) {
  if (aPagar?.valor == null) return faltante('sin el total a pagar de la CM03 no se puede saber el saldo: el impuesto determinado no es lo que se paga');
  if (aPagar.valor <= 0) return cifra(0, aPagar.nivel, aPagar.fuente, 'la CM03 no deja saldo a pagar');
  const pagado = r2(pagos.reduce((n, c) => n + (c.valor ?? 0), 0));
  const nivelPagos = pagos.every((c) => c.nivel === 'verificado') ? aPagar.nivel : 'manual';
  // Sin pagos encontrados no hay saldo VERIFICADO: lo declarado a pagar no es la deuda de hoy (los pagos de COMARB no
  // siempre se pudieron consultar). Se informa como «sin conciliar», con la cifra declarada aparte.
  if (pagado <= 0) return { ...faltante(`sin conciliar: la CM03 deja ${aPagar.valor} a pagar y no se encontraron pagos en lo bajado (no prueba que esté impago ni que se deba)`), diferencia: aPagar.valor };
  if (pagado >= aPagar.valor - 1) return cifra(0, nivelPagos, 'a pagar según CM03 − pagos', pagado > aPagar.valor + 1 ? `los pagos (${pagado}) superan lo a pagar: revisalos` : 'cubierto por los pagos del período');
  const conSaldo = (jurisdicciones ?? []).filter((j) => j.aPagar > 0);
  if (conSaldo.length === 1) return cifra(aPagar.valor - pagado, nivelPagos, 'a pagar según CM03 − pagos', `queda de ${conSaldo[0].jurisdiccion} (la única jurisdicción con saldo a pagar)`);
  return { ...faltante(`saldo sin conciliar: pagos por ${pagado} de ${aPagar.valor} a pagar${conSaldo.length ? ` en ${conSaldo.length} jurisdicciones` : ''}; el total no se afirma hasta verificar cada jurisdicción (ver «Pagos por jurisdicción»)`), diferencia: r2(aPagar.valor - pagado) };
}

/**
 * Pagos de impuestos con FECHA en el mes (caja): los de Cuentas Tributarias y los cargados o importados con fecha de pago
 * en el mes, conciliados para no sumar dos veces (pagos.js). Los duplicados e inciertos se listan, marcados, pero no se
 * suman. Las cargas viejas sin fecha de pago se avisan aparte: no tienen caja.
 */
function pagosDeCaja(outDir, mes, pagosMes) {
  const verificados = pagosMes.map((x) => ({ fecha: x.fecha, clave: x.clasificacion.clave, impuesto: x.clasificacion.nombre, detalle: x.impuesto, corresponde: x.imputadoA,
    periodo: x.periodo?.tipo === 'mes' ? x.periodo.mes : x.periodo?.tipo === 'anual' ? x.periodo.anio : null, importe: x.importe, propio: x.clasificacion.propio, nivel: 'verificado', fuente: 'Cuentas Tributarias' }));
  const cargados = pagosCargadosEnCaja(outDir, mes).map((x) => ({ ...x, detalle: x.concepto, corresponde: x.periodo ? `período ${x.periodo.slice(5)}/${x.periodo.slice(0, 4)}` : 'período no indicado' }));
  const c = conciliarPagos(verificados, cargados);
  const filas = [...c.computados.map((x) => ({ ...x, computado: true })), ...c.duplicados, ...c.inciertos].sort((a, b) => String(a.fecha ?? '9').localeCompare(String(b.fecha ?? '9')));
  const sumar = (f) => r2(c.computados.filter(f).reduce((n, p) => n + (p.importe ?? 0), 0));
  const sinFecha = pagosSinFecha(outDir);
  return { filas, propios: sumar((p) => p.propio !== false && p.propio !== 'empleador'), comoAgente: sumar((p) => p.propio === false), comoEmpleador: sumar((p) => p.propio === 'empleador'), total: sumar(() => true),
    noSumados: c.duplicados.length + c.inciertos.length,
    sinFecha: sinFecha.length ? { cantidad: sinFecha.length, nota: `${sinFecha.length} pago(s) cargado(s) a mano sin fecha de pago: cuentan contra su período pero no se ubican en la caja de ningún mes (corregilos y cargales la fecha)` } : null };
}

/** Las dos obligaciones que no son impuestos propios: F.931 (empleador) y F.744 / SICORE (agente). */
export const TERCEROS = {
  f931: { nombre: 'F.931 · Seguridad social (empleador)', formulario: '931', clave: 'empleador', declarado: 'f931-declarado', pagado: 'f931-pagado',
    tratamiento: 'aportes retenidos al personal y contribuciones del empleador', dondeDeclarado: 'el acuse del F.931 (Declaración en línea): el total a pagar del período' },
  sicore: { nombre: 'F.744 · SICORE (agente de retención y percepción)', formulario: '744', clave: 'agente', declarado: 'sicore-declarado', pagado: 'sicore-pagado',
    tratamiento: 'retenciones y percepciones practicadas a terceros: dinero de terceros, no Ganancias propia ni lo que te retienen a vos', dondeDeclarado: 'el acuse del F.744 (SICORE/SIRE): el total a ingresar del período' },
};

/**
 * F.931 y SICORE del PERÍODO: la DJ presentada (Cuentas Tributarias), el importe declarado (cargado: las listas no lo
 * traen), los pagos imputados al período (Cuentas Tributarias, más los cargados, sin duplicar), su estado y vencimiento.
 * Presentar la DJ no es pagarla.
 */
export function obligacionesDeTerceros(outDir, datosDir, mes, hoy) {
  const man = manualesDelMes(outDir, mes); const imp = importadoDelMes(outDir, mes);
  const djs = djDelPeriodo(datosDir, mes);
  const venc = obligaciones(datosDir, hoy);
  return Object.entries(TERCEROS).map(([id, t]) => {
    const dj = djs.find((d) => String(d.formulario) === t.formulario) ?? null;
    const d = man[t.declarado] ?? imp[t.declarado];
    const declarado = d ? cifra(d.importe, d.cargas ? 'manual' : 'importado', d.cargas ? 'carga manual' : 'archivo importado') : faltante(dj ? `DJ presentada: cargá su importe (${t.dondeDeclarado})` : 'sin DJ del período en lo bajado de Cuentas Tributarias');
    const verificados = pagosDelPeriodo(datosDir, mes, t.clave).map((x) => ({ ...x, clave: t.clave, periodo: mes, nivel: 'verificado', fuente: 'Cuentas Tributarias' }));
    const c = conciliarPagos(verificados, pagosCargadosDelPeriodo(outDir, mes, t.pagado));
    const pagos = c.computados.map((x) => cifra(x.importe, x.nivel, x.fuente));
    const v = venc.find((o) => classifyO(o.impuesto) === t.clave && String(o.periodo) === mes);
    return { id, nombre: t.nombre, tratamiento: t.tratamiento,
      presentacion: dj ? { fecha: dj.fecha, version: dj.version, nivel: 'verificado', fuente: dj.fuente } : null,
      declarado, pagos: pagos.length ? cifra(c.total, pagos.every((x) => x.nivel === 'verificado') ? 'verificado' : 'manual', [...new Set(c.computados.map((x) => x.fuente))].join(' + ')) : faltante('sin pagos imputados al período en lo bajado'),
      estado: declarado.valor != null ? estadoPago(declarado.valor, pagos) : dj ? 'presentada, importe sin cargar' : 'sin datos',
      vencimiento: v ? { fecha: v.vencimiento, nivel: 'verificado', fuente: 'Cuentas Tributarias' } : { fecha: null, nivel: 'faltante' },
      noSumados: [...c.duplicados, ...c.inciertos] };
  });
}
const classifyO = (impuesto) => clasificarImpuesto(impuesto).clave;

/**
 * Pagos que descuentan la obligación de IIBB del PERÍODO: volantes de SIFERE con estado pagado (verificados) y pagos
 * cargados para ese período, conciliados. Los volantes sin estado de pago se devuelven aparte (no se descuentan).
 */
const soloDigitos = (x) => String(x ?? '').replace(/\D/g, '') || null;
/**
 * ¿Un volante pagado de SIFERE DDJJ es el mismo pago que uno de SIFERE Consultas? Pura. 'mismo' si comparten el número
 * de VEP/comprobante; 'distinto' si los dos tienen número y no coincide, o si no hay ninguno del mismo importe;
 * 'incierto' si coincide el importe pero falta el número para confirmarlo (no se suma dos veces ni se descarta).
 */
export function mismoPagoIibb(volante, pagos) {
  const v = soloDigitos(volante.vep);
  if (v && pagos.some((p) => soloDigitos(p.comprobante) === v)) return 'mismo';
  const igualImporte = pagos.filter((p) => Math.abs(p.importe - volante.importe) <= 0.01);
  if (!igualImporte.length) return 'distinto';
  return v && igualImporte.every((p) => soloDigitos(p.comprobante) && soloDigitos(p.comprobante) !== v) ? 'distinto' : 'incierto';
}

export function pagosIibbDelPeriodo(outDir, datosDir, mes) {
  const volantes = volantesSifere(datosDir, mes);
  // Pagos verificados de SIFERE Consultas y volantes pagados de SIFERE DDJJ. Mismo pago visto en las dos pantallas: se
  // reconoce por el número de VEP; con el mismo importe y sin número que lo confirme, queda «incierto» (no se suma).
  const pc = pagosConsultasIibb(datosDir, mes).pagos.filter((p) => p.verificado && p.importe > 0);
  const consultas = pc.map((p) => ({ clave: 'iibb', importe: p.importe, fecha: p.fecha, periodo: mes, nivel: 'verificado', fuente: p.fuente, comprobante: p.comprobante }));
  const pagados = volantes.filter((v) => v.pagado).map((v) => ({ ...v, relacion: mismoPagoIibb(v, pc) }));
  const deVolantes = pagados.filter((v) => v.relacion === 'distinto')
    .map((v) => ({ clave: 'iibb', importe: v.importe, fecha: null, periodo: mes, nivel: 'verificado', fuente: v.fuente, comprobante: v.vep }));
  const verificados = [...consultas, ...deVolantes];
  const c = conciliarPagos(verificados, pagosCargadosDelPeriodo(outDir, mes, 'iibb-pagado'));
  return { ...c, volantesSinPago: volantes.filter((v) => !v.pagado).map((v) => ({ importe: v.importe, estado: v.estado, nota: 'volante generado, pago sin verificar: no se descuenta' })),
    volantesInciertos: pagados.filter((v) => v.relacion === 'incierto').map((v) => ({ importe: v.importe, estado: v.estado, vep: v.vep, fuente: v.fuente,
      nota: 'volante pagado del mismo importe que un pago de SIFERE Consultas, sin número de VEP que confirme si es el mismo: no se suma' })) };
}
