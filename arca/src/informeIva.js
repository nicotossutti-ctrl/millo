/**
 * Informe de IVA de un período, armado SOLO con los datos conservados (out/datos): no abre ARCA.
 *
 * Distingue sin mezclar:
 *   - lo que surge de los comprobantes (débito de emitidos; IVA facturado por proveedores en
 *     recibidos, que NO equivale a crédito fiscal computable);
 *   - lo DECLARADO (detalle de la DJ leído de Portal IVA, fuente portal-iva-ddjj);
 *   - lo PAGADO (pagos de Cuentas Tributarias imputados a IVA de ese período);
 *   - retenciones y percepciones de IVA sufridas en el período (Mis Retenciones);
 *   - presentación, vencimiento y deuda registrada (Portal IVA / Cuentas Tributarias).
 * Cada cifra lleva su fuente y su nivel (apto / validado). El saldo pendiente solo se calcula si hay
 * declarado y pagado; "conciliado" solo cuando ambos existen, están validados y coinciden. No se
 * inventa ni se completa ningún monto: lo que falta figura como faltante, con cómo obtenerlo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { leerVigente } from './portal/conservacion.js';
import { leerManifiesto, decodificar } from './portal/misComprobantes.js';
import { leerZipDesdeArchivo } from './portal/zip.js';
import { periodoDe, importeDe, identificarConceptosIva } from './portal/ivaDdjj.js';
import { fechaIso } from './portal/calidad.js';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const r2 = (x) => Math.round(x * 100) / 100;
export const fmt = (n) => (n == null ? '—' : n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/** Parser CSV (separador `;`, comillas dobles). Devuelve filas de celdas. Pura. */
export function parsearCsv(texto, sep = ';') {
  const filas = []; let fila = []; let celda = ''; let comillas = false;
  const t = String(texto ?? '').replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (comillas) {
      if (c === '"' && t[i + 1] === '"') { celda += '"'; i++; } else if (c === '"') comillas = false; else celda += c;
    } else if (c === '"') comillas = true;
    else if (c === sep) { fila.push(celda); celda = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      fila.push(celda); celda = '';
      if (fila.some((x) => x.trim() !== '')) filas.push(fila);
      fila = [];
    } else celda += c;
  }
  fila.push(celda);
  if (fila.some((x) => x.trim() !== '')) filas.push(fila);
  return filas;
}

/** Tabla { headers, rows } a partir del texto; el encabezado es la primera fila que cumple `esEncabezado`. Pura. */
export function tablaDe(texto, esEncabezado = () => true) {
  const filas = parsearCsv(texto);
  const i = filas.findIndex(esEncabezado);
  if (i < 0) return { headers: [], rows: [] };
  return { headers: filas[i].map((h) => h.trim()), rows: filas.slice(i + 1) };
}

const col = (headers, re) => headers.findIndex((h) => re.test(norm(h)));

// Tipos de comprobante (códigos ARCA): notas de crédito restan.
const NOTAS_CREDITO = new Set([3, 8, 13, 53, 113, 203, 208, 213]);

/**
 * Resumen de IVA de comprobantes (CSV de Mis Comprobantes) para un mes. Pura.
 * Notas de crédito restan (si el CSV las trae en positivo). Montos en pesos (el CSV lo declara).
 */
export function resumenComprobantes(texto, mes) {
  const t = tablaDe(texto, (f) => f.some((c) => /fecha de emisi/i.test(norm(c))) && f.some((c) => /tipo de comprobante/i.test(norm(c))));
  const h = t.headers;
  const iFecha = col(h, /^fecha de emision/); const iTipo = col(h, /^tipo de comprobante/);
  const iTotalIva = col(h, /^total iva$/); const iNeto = col(h, /^imp\. neto gravado total$/); const iTotal = col(h, /^imp\. total$/);
  const ivaPorAlicuota = h.map((x, i) => [x, i]).filter(([x]) => /^iva \d/.test(norm(x)));
  if (iFecha < 0 || iTipo < 0) return { error: 'el archivo no tiene las columnas Fecha de Emisión / Tipo de Comprobante' };
  let n = 0, nc = 0, iva = 0, neto = 0, total = 0; const porAlicuota = {}; const porTipo = {};
  for (const f of t.rows) {
    const fecha = fechaIso(f[iFecha]);
    if (!fecha || fecha.slice(0, 7) !== mes) continue;
    const tipo = Number(String(f[iTipo]).match(/\d+/)?.[0]);
    const signo = NOTAS_CREDITO.has(tipo) ? -1 : 1;
    const v = (i) => { const x = importeDe(f[i]) ?? 0; return signo < 0 && x > 0 ? -x : x; };
    n++; if (signo < 0) nc++;
    porTipo[tipo] = (porTipo[tipo] ?? 0) + 1;
    if (iTotalIva >= 0) iva += v(iTotalIva); else for (const [, i] of ivaPorAlicuota) iva += v(i);
    if (iNeto >= 0) neto += v(iNeto);
    if (iTotal >= 0) total += v(iTotal);
    for (const [x, i] of ivaPorAlicuota) porAlicuota[x] = (porAlicuota[x] ?? 0) + v(i);
  }
  for (const k of Object.keys(porAlicuota)) porAlicuota[k] = r2(porAlicuota[k]);
  return { comprobantes: n, notasCredito: nc, iva: r2(iva), netoGravado: r2(neto), total: r2(total), porAlicuota, porTipo };
}

const fechaDma = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');

/**
 * Conceptos del débito fiscal que declara la DJ, distintos de cero, para explicar diferencias con el
 * IVA de los comprobantes emitidos (ventas sin comprobante electrónico, restituciones, etc.). Pura.
 * Se prefieren los rótulos de pantalla; si no hay, los del JSON. Sin duplicar importes iguales.
 */
export function composicionDebito(conceptos) {
  // Fuera: saldos y el total de crédito (las rutas JSON "debito credito fiscal ..." agrupan ambos).
  const deb = (conceptos ?? []).filter((c) => /debito/.test(norm(c.concepto)) && !/saldo|total (del )?credito fiscal/.test(norm(c.concepto)) && c.importe);
  const pantalla = deb.filter((c) => !/^json\b/.test(c.concepto));
  // Si la pantalla trae solo el total, no explica nada: se suman los rubros del JSON.
  const base = pantalla.length > 1 ? pantalla : deb;
  const vistos = new Set(); const out = [];
  for (const c of base) { const k = `${norm(c.concepto)}|${c.importe}`; if (!vistos.has(k)) { vistos.add(k); out.push(c); } }
  return out.slice(0, 30);
}

function textoComprobantes(dirFuente, archivo) {
  const f = path.join(dirFuente, archivo);
  if (/\.zip$/i.test(f)) return leerZipDesdeArchivo(f).filter((e) => /\.csv$/i.test(e.name)).map((e) => decodificar(e.data)).join('\n');
  return decodificar(fs.readFileSync(f));
}

/** Tramos de Mis Comprobantes verificados (manifiesto) que contienen el mes completo. */
function comprobantesDelMes(datosDir, id, tipo, mes) {
  const dirFuente = path.join(datosDir, id);
  const man = leerManifiesto(dirFuente);
  const [y, m] = mes.split('-'); const ini = `${mes}-01`; const fin = new Date(Date.UTC(+y, +m, 0)).toISOString().slice(0, 10);
  for (const [k, v] of Object.entries(man)) {
    const [t, d, h] = k.split(':');
    if (t === tipo && v?.ok && d <= ini && h >= fin && v.archivo) return { dirFuente, ...v, desde: d, hasta: h };
  }
  return null;
}

/** Vigentes de una fuente con su texto CSV: [{ clave, entrada, archivos: [{ nombre, texto }] }]. */
function vigentesCon(datosDir, id) {
  const vig = leerVigente(datosDir, id);
  return Object.entries(vig).map(([clave, entrada]) => ({
    clave, entrada,
    archivos: (entrada.archivos ?? []).map((nombre) => {
      try { return { nombre, texto: fs.readFileSync(path.join(datosDir, id, 'vigente', clave, nombre), 'utf8') }; } catch { return { nombre, texto: '' }; }
    }),
  }));
}

const esIva = (impuesto) => /(^|\D)30(\D|$)|\biva\b/i.test(String(impuesto ?? '')) && !/ganancia|bienes|pais/i.test(String(impuesto ?? ''));
const fuenteTxt = (id, e) => `${id} (${e?.nivel ?? 'validado'}, ${e?.cuando ?? '?'})`;

/**
 * Arma el informe de IVA de `mes` ('aaaa-mm') con lo conservado en `datosDir`. Devuelve
 * { objeto, texto } (JSON + Markdown). No toca la red.
 */
export function generarInformeIva(datosDir, mes, { hoy = new Date().toISOString().slice(0, 10) } = {}) {
  const faltantes = []; const lineas = []; const avisos = [];
  const [y, m] = mes.split('-'); const etiqueta = `${m}/${y}`;

  // 1. Comprobantes.
  const comp = {};
  for (const [id, tipo] of [['comprobantes-emitidos', 'emitidos'], ['comprobantes-recibidos', 'recibidos']]) {
    const tramo = comprobantesDelMes(datosDir, id, tipo, mes);
    if (!tramo) { faltantes.push(`${tipo}: no hay un tramo verificado de Mis Comprobantes que cubra ${etiqueta} (correr con -Desde/-Hasta de ese mes)`); continue; }
    try {
      comp[tipo] = { ...resumenComprobantes(textoComprobantes(tramo.dirFuente, tramo.archivo), mes), fuente: `${id} (apto: cotejado con el total de ARCA, ${tramo.fecha})` };
    } catch (e) { faltantes.push(`${tipo}: no se pudo leer ${tramo.archivo} (${e.message})`); }
  }

  // 2. Declarado (detalle de la DJ).
  let declarado = null;
  const ddjj = vigentesCon(datosDir, 'portal-iva-ddjj').find((v) => v.clave.startsWith(`${mes}-01_`));
  if (ddjj) {
    const t = tablaDe(ddjj.archivos[0]?.texto ?? '', (f) => /concepto/i.test(norm(f[0] ?? '')));
    const conceptos = t.rows.map((f) => ({ concepto: f[0], importe: importeDe(f[1]) })).filter((c) => c.importe != null);
    declarado = { conceptos, identificados: identificarConceptosIva(conceptos), composicionDebito: composicionDebito(conceptos), fuente: fuenteTxt('portal-iva-ddjj', ddjj.entrada) };
  } else faltantes.push(`declarado: no hay detalle de la DJ de IVA ${etiqueta} conservado (fuente portal-iva-ddjj: correr con -Servicios portal-iva-ddjj y el mes)`);

  // 3. Presentación (Portal IVA y DJ de Cuentas Tributarias).
  const presentaciones = [];
  for (const v of vigentesCon(datosDir, 'portal-iva')) {
    for (const a of v.archivos) {
      const t = tablaDe(a.texto); const ip = col(t.headers, /periodo/); const fo = col(t.headers, /formulario/); const se = col(t.headers, /secuencia/); const pr = col(t.headers, /presentaci/);
      for (const f of t.rows) if (periodoDe(f[ip]) === mes) presentaciones.push({ fuente: fuenteTxt('portal-iva', v.entrada), formulario: f[fo], secuencia: f[se], presentacion: f[pr] });
    }
  }
  for (const v of vigentesCon(datosDir, 'ct-ddjj')) {
    for (const a of v.archivos) {
      const t = tablaDe(a.texto); const ip = col(t.headers, /^periodo/); const ii = col(t.headers, /impuesto/); const fo = col(t.headers, /formulario/); const ve = col(t.headers, /version/); const fe = col(t.headers, /fecha/);
      for (const f of t.rows) if (periodoDe(f[ip]) === mes && esIva(f[ii])) presentaciones.push({ fuente: fuenteTxt('ct-ddjj', v.entrada), formulario: f[fo], secuencia: f[ve] ? `versión ${f[ve]}` : null, presentacion: fe >= 0 ? f[fe] : null });
    }
  }
  if (!presentaciones.length) faltantes.push(`presentación: ni Portal IVA ni las DJ de Cuentas Tributarias conservadas registran la DJ de IVA ${etiqueta}`);

  // 4. Pagos imputados a IVA del período.
  const pagos = []; const ventanasPagos = [];
  for (const v of vigentesCon(datosDir, 'ct-pagos')) {
    ventanasPagos.push(v.clave.replace('_', ' a '));
    for (const a of v.archivos) {
      const t = tablaDe(a.texto); const ip = col(t.headers, /periodo/); const ii = col(t.headers, /impuesto/); const im = col(t.headers, /importe/); const fe = col(t.headers, /fecha/); const fo = col(t.headers, /formulario/);
      for (const f of t.rows) if (esIva(f[ii]) && periodoDe(f[ip]) === mes) pagos.push({ fecha: f[fe], formulario: f[fo], importe: importeDe(f[im]), fuente: fuenteTxt('ct-pagos', v.entrada) });
    }
  }
  const pagado = pagos.length ? r2(pagos.reduce((n, p) => n + (p.importe ?? 0), 0)) : null;
  const finMes = new Date(Date.UTC(+y, +m, 0)).toISOString().slice(0, 10);
  const consultoDespues = vigentesCon(datosDir, 'ct-pagos').some((v) => (v.entrada.hasta ?? '') > finMes);
  if (!pagos.length) {
    faltantes.push(consultoDespues
      ? `pagos: en las ventanas consultadas (${ventanasPagos.join(', ')}) no hay pagos imputados a IVA ${etiqueta}`
      : `pagos: el IVA ${etiqueta} se paga DESPUÉS del mes; no se consultaron pagos posteriores a ${finMes} (correr -Servicios ct-pagos con fechas del mes siguiente)`);
  }

  // 5. Retenciones / percepciones de IVA sufridas en el mes (Mis Retenciones).
  const retenciones = []; const otrasRet = [];
  for (const v of vigentesCon(datosDir, 'mis-retenciones')) {
    if (!(v.entrada.desde ?? '').startsWith(mes)) continue;
    for (const a of v.archivos) {
      const codigo = Number(a.nombre.match(/mis-retenciones-(\d+)/)?.[1]);
      const t = tablaDe(a.texto); const im = col(t.headers, /importe/);
      const suma = r2(t.rows.reduce((n, f) => n + (importeDe(f[im]) ?? 0), 0));
      const reg = { codigo, archivo: a.nombre, filas: t.rows.length, importe: suma, fuente: fuenteTxt('mis-retenciones', v.entrada) };
      if ([216, 767].includes(codigo)) retenciones.push(reg); else otrasRet.push(reg);
    }
  }
  const retIva = retenciones.length ? r2(retenciones.reduce((n, r) => n + r.importe, 0)) : 0;

  // 6. Vencimiento y deuda registrada.
  const vencimientos = []; const deudas = [];
  for (const [id, destino] of [['cuentas-tributarias', vencimientos], ['ct-deudas', deudas]]) {
    for (const v of vigentesCon(datosDir, id)) {
      for (const a of v.archivos) {
        const t = tablaDe(a.texto); const ip = col(t.headers, /periodo/); const ii = col(t.headers, /^impuesto/); const iv = col(t.headers, /vencimiento/); const is = col(t.headers, /^saldo/); const ic = col(t.headers, /^concepto/);
        for (const f of t.rows) if (esIva(f[ii]) && periodoDe(f[ip]) === mes) destino.push({ concepto: f[ic], vencimiento: f[iv], saldo: is >= 0 ? importeDe(f[is]) : null, fuente: fuenteTxt(id, v.entrada) });
      }
    }
  }

  // Vencimiento de PAGO: el que registra Cuentas Tributarias para la deuda del período (o su grilla
  // de vencimientos). Es el del régimen del contribuyente; no se aplica el calendario general.
  const vencimientoPago = [...deudas, ...vencimientos].map((v) => fechaIso(v.vencimiento)).find(Boolean) ?? null;

  // 7. Conciliación (solo con cifras existentes).
  const id = declarado?.identificados ?? {};
  const saldoAPagar = id.saldoAPagar?.importe ?? null;
  let conciliacion;
  if (saldoAPagar == null) {
    conciliacion = { estado: 'no determinable', detalle: declarado ? 'la DJ conservada no tiene un "saldo a pagar" identificado sin ambigüedad' : 'falta el detalle de la DJ (importe declarado)' };
  } else if (pagado == null && saldoAPagar === 0) {
    conciliacion = { estado: 'sin saldo a pagar declarado', detalle: 'la DJ declara saldo a pagar 0' };
  } else if (pagado == null) {
    // Sin pagos imputados. Si Cuentas Tributarias registra la deuda del período, eso acredita que está
    // pendiente; su fecha es el vencimiento de PAGO del contribuyente (p. ej. IVA diferido a 90 días
    // de MiPyMEs: septiembre vence en diciembre). No se usa el calendario general.
    const deuda = r2(deudas.reduce((n, d) => n + (d.saldo ?? 0), 0));
    if (deudas.length && deuda > 0) {
      const vence = vencimientoPago;
      const estado = !vence ? 'pendiente de pago' : vence < hoy ? 'pendiente de pago (vencido)' : 'pendiente de pago (no vencido)';
      conciliacion = { estado, detalle: `declarado; sin pago registrado en las ventanas consultadas; Cuentas Tributarias registra la deuda por ${fmt(deuda)}${Math.abs(deuda - saldoAPagar) < 1 ? ' (igual a lo declarado)' : ` (distinta de lo declarado: ${fmt(saldoAPagar)})`}${vence ? `; vence el ${fechaDma(vence)} según Cuentas Tributarias` : ''}`, saldoPendiente: deuda };
    } else {
      conciliacion = { estado: 'pago no verificado', detalle: 'no hay pagos imputados en las ventanas consultadas ni deuda registrada que lo confirme' };
    }
  } else {
    const dif = r2(saldoAPagar - pagado);
    conciliacion = Math.abs(dif) < 1 ? { estado: 'conciliado', detalle: 'saldo declarado = pagos imputados (Cuentas Tributarias)' }
      : dif > 0 ? { estado: 'saldo pendiente', detalle: `faltan ${fmt(dif)}` } : { estado: 'pagado de más', detalle: `pagos exceden lo declarado en ${fmt(-dif)}` };
    conciliacion.diferencia = dif;
  }
  const deudaIva = deudas.reduce((n, d) => n + (d.saldo ?? 0), 0);
  if (deudas.length && deudaIva > 0) avisos.push(`Cuentas Tributarias registra deuda de IVA ${etiqueta} por ${fmt(r2(deudaIva))}`);
  const debitoDecl = id.debitoFiscal?.importe ?? null;
  if (debitoDecl != null && comp.emitidos) {
    const d = r2(debitoDecl - comp.emitidos.iva);
    if (Math.abs(d) >= 1) avisos.push(`informativo: débito declarado (${fmt(debitoDecl)}) ≠ IVA de comprobantes emitidos (${fmt(comp.emitidos.iva)}); diferencia ${fmt(d)}`);
  }

  const objeto = { periodo: mes, comprobantes: comp, declarado, presentaciones, pagos, pagado, ventanasPagos, retenciones, retencionesIva: retIva, otrasRetenciones: otrasRet,
    vencimientos, deudas, vencimientoPago, conciliacion, avisos, faltantes };

  // Markdown.
  const md = [`# IVA ${etiqueta} · FiscalOS`, '', 'Armado con los datos conservados (out/datos). Cada cifra indica su fuente y nivel. Nada se completa a mano ni se estima.', ''];
  md.push('## Resultado', '', `**${conciliacion.estado.toUpperCase()}** — ${conciliacion.detalle}`, '');
  md.push('| Concepto | Importe | Fuente |', '|---|---:|---|');
  const fila = (c, v, f) => md.push(`| ${c} | ${fmt(v)} | ${f ?? '—'} |`);
  fila('Saldo a pagar declarado (DJ)', saldoAPagar, declarado?.fuente);
  fila('Pagos imputados a IVA del período', pagado, pagos[0]?.fuente);
  if (conciliacion.diferencia != null) fila('Diferencia (declarado − pagado)', conciliacion.diferencia, 'cálculo');
  md.push('', '## Comprobantes del mes (Mis Comprobantes)', '');
  for (const tipo of ['emitidos', 'recibidos']) {
    const c = comp[tipo];
    if (!c) { md.push(`- **${tipo}**: falta (ver faltantes)`); continue; }
    if (c.error) { md.push(`- **${tipo}**: ${c.error}`); continue; }
    md.push(`- **${tipo === 'emitidos' ? 'Débito (IVA de comprobantes emitidos)' : 'IVA facturado por proveedores (no es crédito fiscal computable)'}**: ${fmt(c.iva)} · neto gravado ${fmt(c.netoGravado)} · ${c.comprobantes} comprobantes (${c.notasCredito} notas de crédito restando) · ${c.fuente}`);
    const alic = Object.entries(c.porAlicuota).filter(([, v]) => v);
    if (alic.length) md.push(`  - por alícuota: ${alic.map(([k, v]) => `${k} ${fmt(v)}`).join(' · ')}`);
  }
  md.push('', '## Declarado (detalle de la DJ, Portal IVA)', '');
  if (declarado) {
    for (const [k, v] of Object.entries(declarado.identificados)) md.push(`- ${k}: ${v.ambiguo ? `AMBIGUO (${v.ambiguo.map((a) => `${a.concepto} ${fmt(a.importe)}`).join(' / ')})` : `${fmt(v.importe)} — "${v.concepto}"`}`);
    if (declarado.composicionDebito.length) {
      md.push('- composición del débito según la DJ (conceptos distintos de cero):');
      for (const c of declarado.composicionDebito) md.push(`  - ${c.concepto}: ${fmt(c.importe)}`);
    }
    md.push(`- conceptos leídos: ${declarado.conceptos.length} · ${declarado.fuente}`);
  } else md.push('- falta (ver faltantes)');
  md.push('', '## Presentación', '');
  if (presentaciones.length) for (const p of presentaciones) md.push(`- F.${p.formulario ?? '?'} ${p.secuencia ?? ''} · presentada ${p.presentacion ?? '?'} · ${p.fuente}`);
  else md.push('- sin registro (ver faltantes)');
  md.push('', '## Pagos imputados a IVA del período (Cuentas Tributarias)', '', `Ventanas consultadas: ${ventanasPagos.join(', ') || 'ninguna'}`, '');
  for (const p of pagos) md.push(`- ${p.fecha ?? '?'} · F.${p.formulario ?? '?'} · ${fmt(p.importe)}`);
  md.push('', '## Retenciones y percepciones de IVA sufridas en el mes (Mis Retenciones)', '');
  if (retenciones.length) for (const r of retenciones) md.push(`- impuesto ${r.codigo}: ${fmt(r.importe)} (${r.filas} comprobantes) · ${r.fuente}`);
  else md.push('- ninguna en los regímenes de IVA (216 SIRE-IVA, 767 SICORE) para el mes');
  md.push('  - Aplicables a la DJ según su régimen: se informan, no se descuentan automáticamente.');
  if (otrasRet.length) md.push(`- otras (no IVA): ${otrasRet.map((r) => `${r.codigo} ${fmt(r.importe)}`).join(' · ')}`);
  md.push('', '## Vencimiento y deuda registrada (Cuentas Tributarias)', '');
  if (vencimientoPago) md.push(`- vencimiento de pago (según Cuentas Tributarias, régimen del contribuyente): ${fechaDma(vencimientoPago)}`);
  for (const v of vencimientos) md.push(`- vencimiento: ${v.vencimiento ?? '?'} (${v.concepto ?? ''})`);
  for (const d of deudas) md.push(`- deuda: saldo ${fmt(d.saldo)} · vence ${d.vencimiento ?? '?'} (${d.concepto ?? ''})`);
  if (!vencimientos.length && !deudas.length) md.push('- sin registros de IVA para el período');
  if (avisos.length) md.push('', '## Avisos', '', ...avisos.map((a) => `- ${a}`));
  if (faltantes.length) md.push('', '## Faltantes (cómo completarlos)', '', ...faltantes.map((f) => `- ${f}`));
  return { objeto, texto: md.join('\n') };
}

export function escribirInformeIva(outDir, mes, datosDir = path.join(outDir, 'datos')) {
  const inf = generarInformeIva(datosDir, mes);
  const dir = path.join(outDir, 'informes');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const md = path.join(dir, `iva-${mes}.md`);
  fs.writeFileSync(md, inf.texto, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, `iva-${mes}.json`), JSON.stringify(inf.objeto, null, 2), { mode: 0o600 });
  return { ...inf, archivo: md };
}
