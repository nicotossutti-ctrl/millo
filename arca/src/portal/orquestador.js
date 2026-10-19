/**
 * Orquestador: recorre todos los servicios autorizados en una sola corrida, en modo lectura.
 * Un servicio que falla no detiene a los demás. Cada corrida se guarda en
 * out/corridas/<timestamp>/ y se resume en un informe de cobertura (JSON + texto).
 */
import fs from 'node:fs';
import path from 'node:path';
import { relevarPagina, resumenRelevamiento } from './relevar.js';
import { sanitizarHtml, sanitizarTexto } from './diagnostico.js';
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
  const frames = rel?.frames ?? [{}];
  const cand = candidatos(rel ?? { frames: [{}] });
  const tablas = frames.flatMap((f) => f.tablas ?? []).filter((t) => t.visible);
  const paginacionTxt = frames.flatMap((f) => f.paginacion ?? []).map((p) => p.text).filter(Boolean);
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
    paginacion: paginacionTxt,
    listoParaExtractor: hayFiltroFecha && hayConsulta,
  };
}

/** Releva un servicio genérico: lo abre, releva la pantalla y clasifica. No descarga. */
async function correrGenerico(sesion, servicio, dir, log) {
  const pagina = await sesion.abrirServicio(servicio);
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

/**
 * Mis Comprobantes: descarga real con el extractor dedicado (validado). Los archivos y el
 * manifiesto van a una carpeta PERSISTENTE (out/datos/<id>), compartida entre corridas, para
 * reutilizar descargas históricas. La carpeta de la corrida solo guarda el resumen.
 */
async function correrMisComprobantes(sesion, servicio, dir, periodo, log) {
  const outBase = sesion?.cfg?.outDir ?? 'out';
  const datosDir = path.join(outBase, 'datos', servicio.id);
  const r = await descargarMisComprobantes(sesion, { tipo: servicio.tipo, desde: periodo.desde, hasta: periodo.hasta, outDir: datosDir, rehacer: periodo.rehacer, log });
  escribir(path.join(dir, 'resultado.json'), JSON.stringify({ datosDir, ...r }, null, 2));
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
    // El mensaje y el stack pueden contener texto de la pantalla: se sanean antes de guardar o devolver.
    const msg = sanitizarTexto(e.message);
    log(`[${servicio.id}] ${estado}: ${msg}`);
    escribir(path.join(dir, 'error.txt'), sanitizarTexto(`${e.name}: ${e.message}\n${e.stack ?? ''}`));
    return { id: servicio.id, nombre: servicio.nombre, fuente: servicio.fuente, confirmado: servicio.confirmado, ms: Date.now() - inicio, estado, error: msg };
  }
}

/** Genera el informe de cobertura (objeto + texto) a partir de los resultados de la corrida. */
export function generarCobertura(resultados, { cuit, cuando } = {}) {
  const orden = { validado: 0, descargado: 1, 'con-datos': 2, relevado: 3, 'sin-acceso': 4, desafio: 5, error: 6 };
  const filas = [...resultados].sort((a, b) => (orden[a.estado] ?? 9) - (orden[b.estado] ?? 9));
  const conteo = {};
  for (const r of resultados) conteo[r.estado] = (conteo[r.estado] ?? 0) + 1;
  const detalleDe = (r) => {
    if (r.estado === 'validado' || r.estado === 'descargado') {
      const vals = r.validaciones ?? [];
      const totFilas = vals.map((v) => v.filas ?? 0).reduce((a, b) => a + b, 0);
      const dup = vals.map((v) => v.duplicados ?? 0).reduce((a, b) => a + b, 0);
      const reut = vals.filter((v) => v.reutilizado).length;
      const sinVerif = vals.filter((v) => v.cantidadVerificada === false).length;
      return `${vals.length} período(s)${reut ? `, ${reut} reutilizado(s)` : ''}; ${totFilas} filas; ${dup} duplicados${sinVerif ? `; ${sinVerif} con cantidad no verificada` : ''}`;
    }
    if (r.estado === 'con-datos' || r.estado === 'relevado') return `${r.filas ?? 0} filas en pantalla; export: ${r.exportacion?.length ? r.exportacion.map((e) => e.texto).join('/') : 'no visible'}; ${r.listoParaExtractor ? 'listo para extractor' : 'faltan filtros/consulta'}`;
    if (r.error) return r.error.slice(0, 120);
    return '';
  };
  const fila = (r) => `| ${r.nombre} | ${r.fuente} | **${r.estado}** | ${detalleDe(r)} |`;
  // Las cuatro categorías que pide la issue #1.
  const secciones = [
    ['Descargado y validado', (r) => r.estado === 'validado'],
    ['Descargado sin validar', (r) => r.estado === 'descargado'],
    ['Solo relevado (inspeccionado, sin descarga)', (r) => r.estado === 'con-datos' || r.estado === 'relevado'],
    ['Sin acceso o bloqueo', (r) => ['sin-acceso', 'desafio', 'error'].includes(r.estado)],
  ];

  const cuitMask = cuit ? String(cuit).replace(/^(\d{2})\d{6,8}(\d)$/, '$1-XXXXXXXX-$2') : null;
  const txt = [];
  txt.push(`# Cobertura FiscalOS${cuitMask ? ` · CUIT ${cuitMask}` : ''}${cuando ? ` · ${cuando}` : ''}`);
  txt.push('');
  txt.push('Resumen: ' + ESTADOS.filter((e) => conteo[e]).map((e) => `${conteo[e]} ${e}`).join(', '));
  for (const [titulo, filtro] of secciones) {
    const grupo = filas.filter(filtro);
    txt.push('', `## ${titulo}`);
    if (!grupo.length) { txt.push('_(ninguno)_'); continue; }
    txt.push('| Servicio | Fuente | Estado | Detalle |', '|---|---|---|---|');
    for (const r of grupo) txt.push(fila(r));
  }
  const porCategoria = Object.fromEntries(secciones.map(([t, f]) => [t, filas.filter(f).map((r) => r.id)]));
  return { objeto: { cuando, cuit, conteo, categorias: porCategoria, servicios: filas }, texto: txt.join('\n') };
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
