/**
 * Mis Comprobantes (fes.afip.gob.ar/mcmp). Navegación verificada en el diagnóstico real:
 *   abrirServicio('Mis Comprobantes') -> setearContribuyente.do
 *   enlace  comprobantesEmitidos.do   -> pantalla Emitidos
 *   enlace  comprobantesRecibidos.do  -> pantalla Recibidos
 *
 * Dentro de cada pantalla NO usamos selectores fijos: relevamos la página y elegimos
 *   - el campo de fecha: input visible cuyo id/name/placeholder/aria-label mencione "fecha",
 *   - el botón de consulta: botón visible con texto Buscar/Consultar,
 *   - la exportación: botón o enlace visible con texto CSV/Excel/Exportar.
 * Si alguna de las tres cosas no es única o no existe, el extractor se detiene y muestra lo
 * que vio, para ajustar con datos reales. Solo consulta: nunca presenta, modifica ni paga.
 */
import fs from 'node:fs';
import path from 'node:path';
import { relevarPagina, resumenRelevamiento } from './relevar.js';
import { sanitizarHtml } from './diagnostico.js';

const ENLACE = { emitidos: 'comprobantesEmitidos.do', recibidos: 'comprobantesRecibidos.do' };
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

// ---------- descarga ----------

async function elegir(pagina, lista, que) {
  if (lista.length === 0) throw new Error(`No encontré ${que} en la pantalla. Corré portal:mc-diagnostico y pasame el resumen.`);
  const x = lista[0];
  const sel = selectorDe(x);
  const loc = sel ? pagina.locator(sel).first() : pagina.getByText(x.text ?? '', { exact: false }).first();
  if (!(await loc.count())) throw new Error(`Encontré ${que} en el relevamiento pero no pude ubicarlo para operar: ${JSON.stringify(x)}`);
  return loc;
}

/** Lee el CSV descargado y verifica que tenga filas con fechas dentro del rango. */
export function validarArchivo(file, desde, hasta) {
  const texto = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim());
  if (lineas.length < 2) return { ok: false, filas: 0, motivo: 'archivo sin filas de datos' };
  const sep = (lineas[0].match(/;/g) ?? []).length >= (lineas[0].match(/,/g) ?? []).length ? ';' : ',';
  const cab = lineas[0].split(sep).map((c) => c.trim());
  const iFecha = cab.findIndex((c) => /fecha/i.test(c));
  const d = desde.replace(/-/g, ''); const h = hasta.replace(/-/g, '');
  let dentro = 0; let fuera = 0;
  const aYmd = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s.trim()); return m ? `${m[3]}${m[2]}${m[1]}` : null; };
  for (const l of lineas.slice(1)) {
    const f = iFecha >= 0 ? aYmd(l.split(sep)[iFecha] ?? '') : null;
    if (!f) continue;
    if (f >= d && f <= h) dentro++; else fuera++;
  }
  return { ok: iFecha >= 0 && dentro > 0 && fuera === 0, filas: lineas.length - 1, columnas: cab.length, separador: sep, columnaFecha: iFecha >= 0 ? cab[iFecha] : null, dentroDelRango: dentro, fueraDelRango: fuera, encabezados: cab };
}

export async function descargarMisComprobantes(sesion, { tipo, desde, hasta, outDir = 'out/portal', log = () => {} }) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const resultado = { tipo, desde, hasta, archivos: [], validaciones: [], verificado: false };
  const pagina = await irAPantalla(sesion, tipo, log);

  for (const [d, h] of rangos(desde, hasta)) {
    log(`Mis Comprobantes ${tipo} ${d} a ${h}`);
    const rel = await relevarPagina(pagina);
    const cand = candidatos(rel);
    if (cand.fecha.length > 1) log(`  aviso: ${cand.fecha.length} campos de fecha visibles; uso el primero (${selectorDe(cand.fecha[0])}).`);

    const campo = await elegir(pagina, cand.fecha, 'el campo de fecha');
    await campo.click();
    await campo.fill('');
    await campo.type(`${fechaArca(d)} - ${fechaArca(h)}`);
    await pagina.keyboard.press('Enter');
    await pagina.waitForTimeout(500);
    // Si el selector de rango abrió un panel con "Aplicar", lo confirmamos; si no, Escape lo cierra.
    const aplicar = pagina.locator('button:has-text("Aplicar"), .applyBtn').first();
    if (await aplicar.count() && await aplicar.isVisible().catch(() => false)) await aplicar.click(); else await pagina.keyboard.press('Escape');

    const buscar = await elegir(pagina, cand.buscar, 'el botón Buscar/Consultar');
    await buscar.click();
    await pagina.waitForLoadState('networkidle').catch(() => {});
    await pagina.waitForTimeout(2000);

    const sinDatos = await pagina.locator('text=/No se encontraron|sin resultados|no hay comprobantes|No existen/i').count();
    if (sinDatos) { log('  sin comprobantes en el rango'); resultado.validaciones.push({ desde: d, hasta: h, ok: true, filas: 0, motivo: 'sin comprobantes' }); continue; }

    const rel2 = await relevarPagina(pagina);
    const cand2 = candidatos(rel2);
    const csvPrimero = [...cand2.exportar].sort((a, b) => (/csv/i.test(`${b.text}${b.cls}`) ? 1 : 0) - (/csv/i.test(`${a.text}${a.cls}`) ? 1 : 0));
    const exportar = await elegir(pagina, csvPrimero, 'el botón de exportación (CSV/Excel)');
    const [descarga] = await Promise.all([pagina.waitForEvent('download', { timeout: 120000 }), exportar.click()]);
    const ext = path.extname(descarga.suggestedFilename()) || '.csv';
    const destino = path.join(outDir, `mis-comprobantes-${tipo}-${d}-${h}${ext}`);
    await descarga.saveAs(destino);
    fs.chmodSync(destino, 0o600);
    resultado.archivos.push(destino);
    const val = ext.toLowerCase() === '.csv' ? validarArchivo(destino, d, h) : { ok: false, motivo: `formato ${ext}: validar a mano` };
    resultado.validaciones.push({ desde: d, hasta: h, archivo: destino, ...val });
    log(`  -> ${destino} · ${val.filas ?? '?'} filas · ${val.ok ? 'VALIDADO' : `NO validado: ${val.motivo ?? `${val.fueraDelRango} fuera de rango`}`}`);
  }
  resultado.verificado = resultado.validaciones.length > 0 && resultado.validaciones.every((v) => v.ok);
  if (pagina !== sesion.page) await pagina.close().catch(() => {});
  return resultado;
}
