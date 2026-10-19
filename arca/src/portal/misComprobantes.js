/**
 * Mis Comprobantes (fes.afip.gob.ar/mcmp). Navegación verificada en el diagnóstico real:
 *   abrirServicio('Mis Comprobantes') -> setearContribuyente.do
 *   enlace  comprobantesEmitidos.do   -> pantalla Emitidos
 *   enlace  comprobantesRecibidos.do  -> pantalla Recibidos
 *
 * Selectores confirmados en la pantalla real (diagnóstico del 19/10/2026):
 *   #fechaEmision        rango de fechas "dd/mm/aaaa - dd/mm/aaaa"
 *   #buscarComprobantes  botón de consulta
 *   #cuitConsultada      CUIT del receptor (no se toca)
 *   #tabResultados       pestaña de resultados
 *   #comprobanteDesde / #comprobanteHasta son números de comprobante, no fechas (no se tocan)
 * La exportación NO está en la pantalla inicial: se busca recién después de consultar, en
 * Resultados, y no se asume que exista hasta verla. Solo consulta: nunca presenta,
 * modifica ni paga.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { relevarPagina, resumenRelevamiento } from './relevar.js';
import { sanitizarHtml } from './diagnostico.js';
import { leerZipDesdeArchivo } from './zip.js';

const ENLACE = { emitidos: 'comprobantesEmitidos.do', recibidos: 'comprobantesRecibidos.do' };
export const SEL = { fecha: '#fechaEmision', buscar: '#buscarComprobantes', tabResultados: '#tabResultados' };
const fechaArca = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

export function rangos(desde, hasta, maxDias = 365) {
  const out = [];
  let d = new Date(`${desde}T00:00:00Z`);
  const h = new Date(`${hasta}T00:00:00Z`);
  while (d <= h) {
    const fin = new Date(Math.min(h.getTime(), d.getTime() + (maxDias - 1) * 86400000));
    out.push([d.toISOString().slice(0, 10), fin.toISOString().slice(0, 10)]);
    d = new Date(fin.getTime() + 86400000);
  }
  return out;
}

function escribirProtegido(file, contenido) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contenido, { mode: 0o600 });
}

/** Abre Mis Comprobantes y entra a Emitidos o Recibidos por el enlace real. */
export async function irAPantalla(sesion, tipo, log = () => {}) {
  if (!ENLACE[tipo]) throw new Error('tipo debe ser emitidos o recibidos');
  const pagina = await sesion.abrirServicio('Mis Comprobantes');
  // Si pide elegir a quién representar, elegimos el propio CUIT.
  const propio = pagina.locator(`a:has-text("${sesion.cfg.cuit}"), button:has-text("${sesion.cfg.cuit}"), option:has-text("${sesion.cfg.cuit}")`).first();
  if (await propio.count() && await propio.isVisible().catch(() => false)) {
    log('Mis Comprobantes: seleccionando el propio CUIT como contribuyente.');
    await propio.click();
    await pagina.waitForLoadState('networkidle').catch(() => {});
  }
  const enlace = pagina.locator(`a[href*="${ENLACE[tipo]}"]`).first();
  await enlace.waitFor({ state: 'visible', timeout: 20000 });
  log(`Mis Comprobantes: entrando a ${tipo} por ${ENLACE[tipo]}.`);
  await enlace.click();
  await pagina.waitForLoadState('domcontentloaded');
  await pagina.waitForLoadState('networkidle').catch(() => {});
  await pagina.waitForTimeout(1500);
  return pagina;
}

/** Candidatos a filtro de fecha, botón de consulta y exportación, a partir del relevamiento. */
export function candidatos(rel) {
  const f = rel.frames.find((x) => x.principal) ?? rel.frames[0];
  const txt = (x) => `${x.id ?? ''} ${x.name ?? ''} ${x.placeholder ?? ''} ${x.ariaLabel ?? ''} ${x.title ?? ''} ${x.text ?? ''}`.toLowerCase();
  const vis = (arr) => (arr ?? []).filter((x) => x.visible);
  return {
    fecha: vis(f.inputs).filter((x) => /fecha|emisi|desde|hasta|period/.test(txt(x)) && x.type !== 'hidden'),
    buscar: vis(f.botones).filter((x) => /buscar|consultar/.test(txt(x))),
    exportar: [...vis(f.botones), ...vis(f.enlaces)].filter((x) => /\bcsv\b|excel|exportar|xls/.test(txt(x))),
    tabla: (f.conRol ?? []).filter((x) => /grid|table/.test(x.role ?? '')).length,
  };
}

function selectorDe(x) {
  if (x.id) return `#${x.id.replace(/([^\w-])/g, '\\$1')}`;
  if (x.name) return `${x.tag}[name="${x.name}"]`;
  return null;
}

/** Diagnóstico de la pantalla Emitidos o Recibidos: relevamiento + candidatos. Sin tocar filtros. */
export async function diagnosticoMisComprobantes(sesion, { tipo, outDir = 'out/diagnostico', sinCapturas = true, log = () => {} }) {
  const dir = path.join(outDir, `mis-comprobantes-${tipo}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pagina = await irAPantalla(sesion, tipo, log);
  const rel = await relevarPagina(pagina);
  const cand = candidatos(rel);
  escribirProtegido(path.join(dir, 'estructura.json'), JSON.stringify(rel, null, 2));
  escribirProtegido(path.join(dir, 'pagina.html'), sanitizarHtml(await pagina.content()));
  if (!sinCapturas) { await pagina.screenshot({ path: path.join(dir, 'pantalla.png'), fullPage: true }); fs.chmodSync(path.join(dir, 'pantalla.png'), 0o600); }
  const lineas = [
    ...resumenRelevamiento(rel),
    '',
    '== Candidatos que usaría el extractor',
    `fecha:    ${cand.fecha.length} -> ${cand.fecha.map((x) => selectorDe(x) ?? x.placeholder ?? x.tag).join(' | ') || 'NINGUNO'}`,
    `buscar:   ${cand.buscar.length} -> ${cand.buscar.map((x) => `${JSON.stringify(x.text)} ${selectorDe(x) ?? ''}`).join(' | ') || 'NINGUNO'}`,
    `exportar: ${cand.exportar.length} -> ${cand.exportar.map((x) => `${JSON.stringify(x.text)} ${selectorDe(x) ?? x.href ?? ''}`).join(' | ') || 'NINGUNO (puede aparecer recién después de buscar)'}`,
    `tablas con rol grid/table: ${cand.tabla}`,
  ];
  escribirProtegido(path.join(dir, 'resumen.txt'), lineas.join('\n'));
  for (const l of lineas) log(l);
  if (pagina !== sesion.page) await pagina.close().catch(() => {});
  return { rel, candidatos: cand, dir };
}

// ---------- consulta ----------

/** Carga el rango en #fechaEmision y consulta con #buscarComprobantes. */
export async function consultar(pagina, d, h, log = () => {}) {
  const valor = `${fechaArca(d)} - ${fechaArca(h)}`;
  const campo = pagina.locator(SEL.fecha);
  await campo.waitFor({ state: 'visible', timeout: 20000 });
  await campo.click();
  await campo.fill(valor);
  // El selector de rango puede abrir un panel: Enter lo aplica; si queda abierto, Escape lo cierra.
  await pagina.keyboard.press('Enter');
  await pagina.waitForTimeout(400);
  const aplicar = pagina.locator('.applyBtn, button:has-text("Aplicar")').first();
  if (await aplicar.count() && await aplicar.isVisible().catch(() => false)) await aplicar.click();
  else await pagina.keyboard.press('Escape');
  const leido = await campo.inputValue();
  if (leido.replace(/\s/g, '') !== valor.replace(/\s/g, '')) {
    // Último recurso: asignar el valor y avisar al formulario, sin tocar nada más.
    await campo.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, valor);
  }
  log(`  rango cargado en ${SEL.fecha}: "${await campo.inputValue()}"`);
  await pagina.locator(SEL.buscar).click();
  await pagina.waitForLoadState('networkidle').catch(() => {});
  await pagina.waitForTimeout(2500);
  const tab = pagina.locator(SEL.tabResultados);
  if (await tab.count() && await tab.isVisible().catch(() => false)) {
    await tab.click().catch(() => {});
    await pagina.waitForTimeout(800);
  }
}

/** Total de comprobantes informado por ARCA, leído de la paginación ("... de N registros"). */
export function totalInformado(res) {
  const aNum = (x) => Number(String(x).replace(/\./g, ''));
  for (const txt of res.paginacion ?? []) {
    // Preferimos el número inmediatamente anterior a la palabra "registros/resultados/...".
    const pref = /([\d.]+)\s*(?:registros|resultados|comprobantes|entries)/i.exec(txt);
    if (pref) return aNum(pref[1]);
    const alt = /(?:\bde\b|\bof\b)\s+([\d.]+)\b/i.exec(txt);
    if (alt) return aNum(alt[1]);
  }
  // Sin paginación: si hay una sola tabla visible, sus filas son el total.
  if (res.tablasVisibles.length === 1) return res.tablasVisibles[0].filas;
  return null;
}

/** Qué hay en Resultados después de consultar: tablas, paginación, exportación, mensajes. */
export function resumenResultados(rel) {
  const f = rel.frames.find((x) => x.principal) ?? rel.frames[0];
  const cand = candidatos(rel);
  const tablas = (f.tablas ?? []).filter((t) => t.visible);
  return {
    tablasVisibles: tablas.map((t) => ({ id: t.id, filas: t.filas, columnas: t.encabezados })),
    paginacion: (f.paginacion ?? []).map((p) => p.text).filter(Boolean),
    exportacion: cand.exportar.map((x) => ({ texto: x.text, id: x.id, cls: x.cls, href: x.href })),
    mensajes: f.mensajes ?? [],
  };
}

/** Prueba real de consulta de un período corto: consulta, releva Resultados, no descarga nada. */
export async function pruebaConsulta(sesion, { tipo, desde, hasta, outDir = 'out/diagnostico', sinCapturas = true, log = () => {} }) {
  const dir = path.join(outDir, `mis-comprobantes-${tipo}-resultados`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pagina = await irAPantalla(sesion, tipo, log);
  log(`Consulta ${tipo} ${desde} a ${hasta}`);
  await consultar(pagina, desde, hasta, log);
  const rel = await relevarPagina(pagina);
  const res = resumenResultados(rel);
  escribirProtegido(path.join(dir, 'estructura.json'), JSON.stringify(rel, null, 2));
  escribirProtegido(path.join(dir, 'pagina.html'), sanitizarHtml(await pagina.content()));
  if (!sinCapturas) { await pagina.screenshot({ path: path.join(dir, 'pantalla.png'), fullPage: true }); fs.chmodSync(path.join(dir, 'pantalla.png'), 0o600); }
  const lineas = [
    ...resumenRelevamiento(rel),
    '',
    '== Resultados de la consulta',
    `tablas visibles: ${res.tablasVisibles.length}` + res.tablasVisibles.map((t) => `\n  ${t.id ?? '(sin id)'}: ${t.filas} filas · ${t.columnas.join(' | ')}`).join(''),
    `paginación: ${res.paginacion.length ? res.paginacion.join(' || ') : 'no se detectó'}`,
    `exportación: ${res.exportacion.length ? res.exportacion.map((e) => `${JSON.stringify(e.texto)} ${e.id ? `#${e.id}` : ''} ${e.cls ?? ''} ${e.href ?? ''}`.trim()).join(' | ') : 'NO HAY botón de exportación visible'}`,
    `mensajes: ${res.mensajes.length ? res.mensajes.join(' || ') : 'ninguno'}`,
  ];
  escribirProtegido(path.join(dir, 'resumen.txt'), lineas.join('\n'));
  for (const l of lineas) log(l);
  if (pagina !== sesion.page) await pagina.close().catch(() => {});
  return { rel, resultados: res, dir };
}

// ---------- descarga ----------

async function elegir(pagina, lista, que) {
  if (lista.length === 0) throw new Error(`No encontré ${que} en la pantalla. Corré portal:mc-consulta y pasame el resumen.`);
  const x = lista[0];
  const sel = selectorDe(x);
  const loc = sel ? pagina.locator(sel).first() : pagina.getByText(x.text ?? '', { exact: false }).first();
  if (!(await loc.count())) throw new Error(`Encontré ${que} en el relevamiento pero no pude ubicarlo para operar: ${JSON.stringify(x)}`);
  return loc;
}

/** Valida el TEXTO de un CSV: filas dentro del rango, columnas, separador y duplicados. */
export function validarContenidoCsv(texto, desde, hasta) {
  const limpio = texto.replace(/^﻿/, '');
  const lineas = limpio.split(/\r?\n/).filter((l) => l.trim());
  if (lineas.length < 2) return { ok: false, filas: 0, motivo: 'archivo sin filas de datos' };
  const sep = (lineas[0].match(/;/g) ?? []).length >= (lineas[0].match(/,/g) ?? []).length ? ';' : ',';
  const cab = lineas[0].split(sep).map((c) => c.trim());
  // Normaliza para que la detección no dependa del encoding del CSV (acentos).
  const norm = (c) => c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const iFecha = cab.findIndex((c) => /fecha/.test(norm(c)));
  const idCols = cab.map((c, i) => (/numero|nro|punto de venta|tipo|emisor|cod\.? aut/.test(norm(c)) ? i : -1)).filter((i) => i >= 0);
  const d = desde.replace(/-/g, ''); const h = hasta.replace(/-/g, '');
  const aYmd = (x) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec((x ?? '').trim()); return m ? `${m[3]}${m[2]}${m[1]}` : null; };
  let dentro = 0; let fuera = 0;
  const claves = new Map();
  let duplicados = 0;
  for (const l of lineas.slice(1)) {
    const celdas = l.split(sep);
    const f = iFecha >= 0 ? aYmd(celdas[iFecha]) : null;
    if (f) { if (f >= d && f <= h) dentro++; else fuera++; }
    const clave = idCols.length ? idCols.map((i) => (celdas[i] ?? '').trim()).join('|') : l.trim();
    if (claves.has(clave)) duplicados++; else claves.set(clave, true);
  }
  const filas = lineas.length - 1;
  return {
    ok: iFecha >= 0 && dentro > 0 && fuera === 0 && duplicados === 0,
    filas, columnas: cab.length, separador: sep,
    columnaFecha: iFecha >= 0 ? cab[iFecha] : null,
    dentroDelRango: dentro, fueraDelRango: fuera,
    duplicados, claveDuplicados: idCols.length ? idCols.map((i) => cab[i]) : ['línea completa'],
    encabezados: cab,
    motivo: iFecha < 0 ? 'no se encontró columna de fecha' : fuera > 0 ? `${fuera} fuera de rango` : duplicados ? `${duplicados} duplicados` : dentro === 0 ? 'ninguna fila con fecha válida' : null,
  };
}

/** Valida un archivo descargado: si es ZIP, extrae y valida cada CSV; si es CSV, directo. */
export function validarArchivo(file, desde, hasta) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.csv') {
    return { ...validarContenidoCsv(fs.readFileSync(file, 'utf8'), desde, hasta), csv: [path.basename(file)] };
  }
  if (ext === '.zip') {
    let entradas;
    try { entradas = leerZipDesdeArchivo(file); } catch (e) { return { ok: false, motivo: `ZIP ilegible: ${e.message}` }; }
    const csvs = entradas.filter((e) => /\.csv$/i.test(e.name));
    if (!csvs.length) return { ok: false, motivo: `el ZIP no contiene CSV (${entradas.map((e) => e.name).join(', ')})` };
    const dir = path.join(path.dirname(file), path.basename(file, '.zip') + '-csv');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const partes = csvs.map((e) => {
      fs.writeFileSync(path.join(dir, path.basename(e.name)), e.data, { mode: 0o600 });
      return { csv: path.basename(e.name), ...validarContenidoCsv(e.data.toString('utf8'), desde, hasta) };
    });
    return {
      ok: partes.every((p) => p.ok),
      filas: partes.reduce((n, p) => n + (p.filas ?? 0), 0),
      duplicados: partes.reduce((n, p) => n + (p.duplicados ?? 0), 0),
      dentroDelRango: partes.reduce((n, p) => n + (p.dentroDelRango ?? 0), 0),
      fueraDelRango: partes.reduce((n, p) => n + (p.fueraDelRango ?? 0), 0),
      csv: partes.map((p) => p.csv), partes,
      motivo: partes.every((p) => p.ok) ? null : partes.filter((p) => !p.ok).map((p) => `${p.csv}: ${p.motivo}`).join('; '),
    };
  }
  return { ok: false, motivo: `formato ${ext || 'desconocido'}: validar a mano` };
}

// ---------- registro de períodos ya verificados (trazabilidad) ----------

function rutaManifiesto(outDir) { return path.join(outDir, 'manifiesto.json'); }
export function leerManifiesto(outDir) {
  const f = rutaManifiesto(outDir);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}
export function claveManifiesto(tipo, d, h) { return `${tipo}:${d}:${h}`; }
export function registrarManifiesto(outDir, clave, registro) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const m = leerManifiesto(outDir);
  m[clave] = registro;
  fs.writeFileSync(rutaManifiesto(outDir), JSON.stringify(m, null, 2), { mode: 0o600 });
}

/**
 * Reparte los tramos del período en pendientes (hay que descargar) y reutilizados (ya
 * verificados en el manifiesto persistente de outDir). Pura: no toca la red.
 */
export function periodosPendientes(outDir, tipo, desde, hasta, rehacer = false) {
  const manifiesto = leerManifiesto(outDir);
  const pendientes = []; const reutilizados = [];
  for (const [d, h] of rangos(desde, hasta)) {
    const prev = manifiesto[claveManifiesto(tipo, d, h)];
    if (prev?.ok && !rehacer) reutilizados.push({ desde: d, hasta: h, ...prev });
    else pendientes.push([d, h]);
  }
  return { pendientes, reutilizados };
}

export async function descargarMisComprobantes(sesion, { tipo, desde, hasta, outDir = 'out/portal', rehacer = false, log = () => {} }) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const resultado = { tipo, desde, hasta, archivos: [], validaciones: [], verificado: false };
  // Trazabilidad: períodos ya verificados no se vuelven a descargar salvo --rehacer.
  const { pendientes, reutilizados } = periodosPendientes(outDir, tipo, desde, hasta, rehacer);
  for (const r of reutilizados) {
    log(`Mis Comprobantes ${tipo} ${r.desde} a ${r.hasta}: ya verificado el ${r.fecha} (${r.filas} filas), se reutiliza.`);
    resultado.validaciones.push({ desde: r.desde, hasta: r.hasta, ok: true, filas: r.filas, informados: r.informados, archivo: r.archivo, reutilizado: true, hash: r.hash });
    if (r.archivo) resultado.archivos.push(path.join(outDir, r.archivo));
  }
  if (!pendientes.length) {
    resultado.verificado = resultado.validaciones.length > 0 && resultado.validaciones.every((v) => v.ok);
    log('Todo el período ya estaba verificado; no se descargó nada.');
    return resultado;
  }

  const pagina = await irAPantalla(sesion, tipo, log);

  for (const [d, h] of pendientes) {
    log(`Mis Comprobantes ${tipo} ${d} a ${h}`);
    await consultar(pagina, d, h, log);
    const rel = await relevarPagina(pagina);
    const res = resumenResultados(rel);
    const filas = res.tablasVisibles.reduce((n, t) => n + t.filas, 0);
    log(`  resultados: ${res.tablasVisibles.length} tablas, ${filas} filas visibles, paginación ${res.paginacion.length ? JSON.stringify(res.paginacion[0]) : 'no detectada'}`);
    if (res.mensajes.some((m) => /no se encontraron|sin resultados|no hay|no existen/i.test(m)) || (res.tablasVisibles.length && filas === 0)) {
      log('  sin comprobantes en el rango');
      resultado.validaciones.push({ desde: d, hasta: h, ok: true, filas: 0, motivo: 'sin comprobantes' });
      continue;
    }
    if (!res.exportacion.length) {
      throw new Error(`La consulta mostró ${filas} filas pero no hay botón de exportación visible. Corré portal:mc-consulta y pasame el resumen para ver cómo se exporta en esta pantalla.`);
    }
    const cand = candidatos(rel);
    const csvPrimero = [...cand.exportar].sort((a, b) => (/csv/i.test(`${b.text}${b.cls}`) ? 1 : 0) - (/csv/i.test(`${a.text}${a.cls}`) ? 1 : 0));
    const exportar = await elegir(pagina, csvPrimero, 'el botón de exportación');
    log(`  exportando con ${JSON.stringify(csvPrimero[0].text)}`);
    const [descarga] = await Promise.all([pagina.waitForEvent('download', { timeout: 120000 }), exportar.click()]);
    const ext = path.extname(descarga.suggestedFilename()) || '.csv';
    const destino = path.join(outDir, `mis-comprobantes-${tipo}-${d}-${h}${ext}`);
    await descarga.saveAs(destino);
    fs.chmodSync(destino, 0o600);
    resultado.archivos.push(destino);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(destino)).digest('hex');
    const val = validarArchivo(destino, d, h);
    // Control clave: lo descargado debe coincidir con lo que ARCA informó en la tabla paginada.
    const informados = totalInformado(res);
    const coincideInformado = informados == null ? null : val.filas === informados;
    const ok = val.ok && coincideInformado !== false;
    const motivo = val.ok && coincideInformado === false ? `descargados ${val.filas} ≠ informados ${informados}` : val.motivo;
    resultado.validaciones.push({ desde: d, hasta: h, archivo: path.basename(destino), hash, ...val, ok, informados, coincideInformado, motivo });
    log(`  -> ${path.basename(destino)} · ${val.filas ?? '?'} filas / informados ${informados ?? '?'} · dup ${val.duplicados ?? 0} · ${ok ? 'VALIDADO' : `NO validado: ${motivo}`}`);
    if (ok) registrarManifiesto(outDir, claveManifiesto(tipo, d, h), { fecha: new Date().toISOString().slice(0, 10), ok: true, archivo: path.basename(destino), filas: val.filas, informados, hash, csv: val.csv });
  }
  resultado.verificado = resultado.validaciones.length > 0 && resultado.validaciones.every((v) => v.ok);
  if (pagina !== sesion.page) await pagina.close().catch(() => {});
  return resultado;
}
