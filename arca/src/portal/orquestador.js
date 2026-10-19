/**
 * Orquestador: recorre todos los servicios autorizados en una sola corrida, en modo lectura.
 * Un servicio que falla no detiene a los demás. Cada corrida se guarda en
 * out/corridas/<timestamp>/ y se resume en un informe de cobertura (JSON + texto).
 */
import fs from 'node:fs';
import path from 'node:path';
import { relevarPagina, resumenRelevamiento } from './relevar.js';
import { sanitizarHtml } from './diagnostico.js';
import { candidatos, consultar, resumenResultados, validarArchivo, irAPantalla, descargarMisComprobantes } from './misComprobantes.js';
import { slug } from './servicios.js';

const ESTADOS = ['validado', 'descargado', 'con-datos', 'relevado', 'sin-acceso', 'desafio', 'error'];

function escribir(file, contenido) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contenido, { mode: 0o600 });
}

function selectorDe(x) {
  if (!x) return null;
  if (x.id) return `#${x.id.replace(/([^\w-])/g, '\\$1')}`;
  if (x.name) return `${x.tag}[name="${x.name}"]`;
  return null;
}

/**
 * Clasifica lo que se encontró en un servicio genérico a partir del relevamiento, sin descargar.
 * Devuelve estado y los elementos candidatos para escribir después el extractor confirmado.
 */
export function clasificarRelevamiento(rel) {
  const f = rel?.frames?.find((x) => x.principal) ?? rel?.frames?.[0] ?? {};
  const cand = candidatos(rel ?? { frames: [{}] });
  const tablas = (f.tablas ?? []).filter((t) => t.visible);
  const filas = tablas.reduce((n, t) => n + (t.filas ?? 0), 0);
  const hayExport = cand.exportar.length > 0;
  const hayFiltroFecha = cand.fecha.length > 0;
  const hayConsulta = cand.buscar.length > 0;
  let estado = 'relevado';
  if (filas > 0 || hayExport) estado = 'con-datos';
  return {
    estado,
    filas,
    tablas: tablas.map((t) => ({ id: t.id, filas: t.filas, columnas: t.encabezados })),
    exportacion: cand.exportar.map((x) => ({ texto: x.text, selector: selectorDe(x), href: x.href })),
    filtroFecha: cand.fecha.map((x) => ({ selector: selectorDe(x), placeholder: x.placeholder })),
    botonConsulta: cand.buscar.map((x) => ({ texto: x.text, selector: selectorDe(x) })),
    paginacion: (f.paginacion ?? []).map((p) => p.text).filter(Boolean),
    listoParaExtractor: hayFiltroFecha && hayConsulta,
  };
}

/** Releva un servicio genérico: lo abre, releva la pantalla y clasifica. No descarga. */
async function correrGenerico(sesion, servicio, dir, log) {
  const pagina = await sesion.abrirServicio(servicio.nombre);
  await pagina.waitForTimeout(2500);
  const rel = await relevarPagina(pagina);
  escribir(path.join(dir, 'estructura.json'), JSON.stringify(rel, null, 2));
  escribir(path.join(dir, 'pagina.html'), sanitizarHtml(await pagina.content()));
  const clas = clasificarRelevamiento(rel);
  const lineas = [...resumenRelevamiento(rel), '', '== Clasificación', JSON.stringify(clas, null, 2)];
  escribir(path.join(dir, 'resumen.txt'), lineas.join('\n'));
  if (pagina !== sesion.page) await pagina.close().catch(() => {});
  return { ...clas, url: rel.url };
}

/** Mis Comprobantes: descarga real con el extractor dedicado (validado). */
async function correrMisComprobantes(sesion, servicio, dir, periodo, log) {
  const r = await descargarMisComprobantes(sesion, { tipo: servicio.tipo, desde: periodo.desde, hasta: periodo.hasta, outDir: dir, log });
  escribir(path.join(dir, 'resultado.json'), JSON.stringify(r, null, 2));
  const estado = r.verificado ? 'validado' : (r.archivos.length ? 'descargado' : 'con-datos');
  return { estado, archivos: r.archivos.map((a) => path.basename(a)), validaciones: r.validaciones };
}

/**
 * Corre un servicio aislado: cualquier error se captura y se devuelve como estado 'error' o
 * 'desafio', sin propagarse. `correrServicio` se puede inyectar para los tests.
 */
export async function correrUno(sesion, servicio, { baseDir, periodo, log = () => {}, runner } = {}) {
  const dir = path.join(baseDir, slug(servicio.id));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const inicio = Date.now();
  const run = runner ?? (async () => {
    if (servicio.extractor === 'mis-comprobantes') return correrMisComprobantes(sesion, servicio, dir, periodo, log);
    return correrGenerico(sesion, servicio, dir, log);
  });
  try {
    log(`[${servicio.id}] abriendo ${servicio.nombre}`);
    const r = await run();
    log(`[${servicio.id}] ${r.estado}`);
    return { id: servicio.id, nombre: servicio.nombre, fuente: servicio.fuente, confirmado: servicio.confirmado, ms: Date.now() - inicio, ...r };
  } catch (e) {
    const estado = e?.name === 'DesafioDeSeguridad' ? 'desafio' : (/no encontré|no pude abrir|timeout/i.test(e.message) ? 'sin-acceso' : 'error');
    log(`[${servicio.id}] ${estado}: ${e.message}`);
    escribir(path.join(dir, 'error.txt'), `${e.name}: ${e.message}\n${e.stack ?? ''}`);
    return { id: servicio.id, nombre: servicio.nombre, fuente: servicio.fuente, confirmado: servicio.confirmado, ms: Date.now() - inicio, estado, error: e.message };
  }
}

/** Genera el informe de cobertura (objeto + texto) a partir de los resultados de la corrida. */
export function generarCobertura(resultados, { cuit, cuando } = {}) {
  const orden = { validado: 0, descargado: 1, 'con-datos': 2, relevado: 3, 'sin-acceso': 4, desafio: 5, error: 6 };
  const filas = [...resultados].sort((a, b) => (orden[a.estado] ?? 9) - (orden[b.estado] ?? 9));
  const conteo = {};
  for (const r of resultados) conteo[r.estado] = (conteo[r.estado] ?? 0) + 1;
  const txt = [];
  txt.push(`# Cobertura FiscalOS${cuit ? ` · CUIT ${cuit}` : ''}${cuando ? ` · ${cuando}` : ''}`);
  txt.push('');
  txt.push('Resumen: ' + ESTADOS.filter((e) => conteo[e]).map((e) => `${conteo[e]} ${e}`).join(', '));
  txt.push('');
  txt.push('| Servicio | Fuente | Estado | Detalle |');
  txt.push('|---|---|---|---|');
  for (const r of filas) {
    let detalle = '';
    if (r.archivos?.length) detalle = `${r.archivos.length} archivo(s); ${(r.validaciones ?? []).map((v) => v.filas ?? 0).reduce((a, b) => a + b, 0)} filas`;
    else if (r.estado === 'con-datos' || r.estado === 'relevado') detalle = `${r.filas ?? 0} filas; export: ${r.exportacion?.length ? r.exportacion.map((e) => e.texto).join('/') : 'no visible'}; ${r.listoParaExtractor ? 'listo para extractor' : 'faltan filtros/consulta'}`;
    else if (r.error) detalle = r.error.slice(0, 120);
    txt.push(`| ${r.nombre} | ${r.fuente} | **${r.estado}** | ${detalle} |`);
  }
  return { objeto: { cuando, cuit, conteo, servicios: filas }, texto: txt.join('\n') };
}

/** Recorre todos los servicios, aislando fallos, y persiste la corrida. */
export async function ejecutarTodo(sesion, { servicios, periodo, outDir = 'out/corridas', log = () => {}, runner } = {}) {
  const cuando = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseDir = path.join(outDir, cuando);
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const resultados = [];
  for (const s of servicios) {
    resultados.push(await correrUno(sesion, s, { baseDir, periodo, log, runner: runner ? () => runner(s) : undefined }));
  }
  const cobertura = generarCobertura(resultados, { cuit: sesion?.cfg?.cuit, cuando });
  escribir(path.join(baseDir, 'cobertura.json'), JSON.stringify(cobertura.objeto, null, 2));
  escribir(path.join(baseDir, 'cobertura.md'), cobertura.texto);
  // Puntero a la última corrida, para no tener que buscar la carpeta.
  escribir(path.join(outDir, 'ultima.txt'), baseDir);
  return { baseDir, resultados, cobertura };
}
