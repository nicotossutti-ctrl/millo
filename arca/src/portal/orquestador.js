/**
 * Orquestador: recorre todos los servicios autorizados en una sola corrida, en modo lectura.
 * Un servicio que falla no detiene a los demás. Cada corrida se guarda en
 * out/corridas/<timestamp>/ y se resume en un informe de cobertura (JSON + texto).
 */
import fs from 'node:fs';
import path from 'node:path';
import { relevarPagina, relevarTodasLasPaginas, resumenRelevamiento } from './relevar.js';
import { sanitizarHtml, sanitizarTexto } from './diagnostico.js';
import { candidatos, consultar, resumenResultados, validarArchivo, irAPantalla, descargarMisComprobantes } from './misComprobantes.js';
import { extraerTabla, extraerTablaEnPagina, norm } from './extractor.js';
import { drillHaciaGrilla } from './navegar.js';
import { slug } from './servicios.js';
import { evaluarCalidad, esGrillaAjena, estadoInforme } from './calidad.js';
import { conservarIntento, registrarIntento, claveDe } from './conservacion.js';
import { generarMatrizCobertura } from './coberturaHistorica.js';

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
 * ¿La grilla leída es una que este servicio NO busca? Pura. true si TODOS los términos de
 * `rechazar` aparecen en los encabezados (p. ej. la grilla de Vencimientos de la home de Cuentas
 * Tributarias, que aparece cuando la ruta no llegó a DJ/Pagos/Cuenta Corriente).
 */
export function esGrillaRechazada(columnas, rechazar) {
  return esGrillaAjena(columnas, rechazar);
}

/**
 * Corre EN EL NAVEGADOR (frame.evaluate): devuelve los elementos más profundos que contienen el
 * texto (sin mayúsculas), con etiqueta, clase, tamaño, visibilidad y si parecen clickeables. Solo
 * lee el DOM. Autocontenida: no puede usar nada de este módulo.
 */
export function buscarElementosConTexto(texto) {
  const t = String(texto).toLowerCase().trim();
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!txt || txt.length > 120 || !txt.toLowerCase().includes(t)) continue;
    // Solo el más profundo: si un hijo también contiene el texto, se saltea el padre.
    if ([...el.children].some((c) => (c.textContent || '').toLowerCase().includes(t))) continue;
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const p = el.parentElement;
    out.push({
      tag: el.tagName.toLowerCase(), id: el.id || null, cls: String(el.className || '').slice(0, 80) || null,
      text: txt, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y),
      display: cs.display, visibility: cs.visibility, cursor: cs.cursor,
      onclick: el.hasAttribute('onclick') || typeof el.onclick === 'function',
      href: el.getAttribute('href') ? el.getAttribute('href').slice(0, 120) : null,
      parent: p ? `${p.tagName.toLowerCase()}${p.id ? `#${p.id}` : ''}${p.className ? `.${String(p.className).split(/\s+/)[0]}` : ''}` : null,
      html: el.outerHTML.slice(0, 200),
    });
    if (out.length >= 30) break;
  }
  return out;
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

/**
 * Servicio genérico / hub: lo abre, lo atraviesa en SOLO LECTURA hasta una grilla o sus filtros
 * (drill), y si llega a la grilla intenta extraerla acá mismo. Siempre guarda el relevamiento
 * saneado del nivel alcanzado para escribir el extractor real si todavía no se pudo.
 */
async function correrGenerico(sesion, servicio, dir, periodo, log, ctx = {}) {
  const pagina = await sesion.abrirServicio(servicio);
  // Damos tiempo a que la SPA cargue sus controles (p. ej. las tarjetas de Ganancias renderizan tarde).
  await pagina.waitForTimeout(3500);
  const expected = (servicio.columnasEsperadas ?? []).map(norm);
  // El drill solo navega por RUTA explícita del servicio; sin ruta no clickea (no adivina).
  // Puede terminar en una pestaña nueva: trabajamos sobre drill.pagina.
  const drill = await drillHaciaGrilla(pagina, { expected, ruta: servicio.ruta ?? [], log });
  const paginaDatos = drill.pagina ?? pagina;

  // Si el drill llegó a una grilla (o a sus filtros), intentamos extraer en esa página.
  let extraccion = null;
  const dirIntento = ctx.dirIntento?.(servicio.id) ?? null;
  if (drill.lista && periodo) {
    const outBase = sesion?.cfg?.outDir ?? 'out';
    extraccion = await extraerTablaEnPagina(paginaDatos, servicio, { desde: periodo.desde, hasta: periodo.hasta, outDir: path.join(outBase, 'datos'), dirSalida: dirIntento, log })
      .catch((e) => ({ error: sanitizarTexto(e.message), filas: 0 }));
  }
  // Grilla que NO es la buscada (p. ej. Vencimientos de la home de Cuentas Tributarias cuando la
  // ruta no llegó a la sección): no se cuenta como dato de esta fuente.
  const grillaAjena = extraccion && !extraccion.error && extraccion.filas > 0 && esGrillaRechazada(extraccion.columnas, servicio.rechazarSiColumnas);
  // Llegar a una pantalla no es éxito: la extracción se juzga contra lo que la sección declara.
  if (extraccion) {
    extraccion.calidad = evaluarCalidad(servicio, extraccion, { desde: periodo?.desde, hasta: periodo?.hasta, rechazada: !!grillaAjena });
    escribir(path.join(dir, 'resultado.json'), JSON.stringify(extraccion, null, 2));
  }

  // Paso de ruta no encontrado: relevamos TODO elemento que contenga los textos de la ruta (etiqueta,
  // clase, tamaño, si es clickeable) y sacamos captura, para ver cómo dibuja la pantalla ese menú.
  let diagnosticoPaso = null;
  if (/no se encontró el paso/.test(drill.motivo ?? '') || grillaAjena) {
    const textos = [...new Set((servicio.ruta ?? []).flatMap((p) => [p.texto, p.siNoVisible]).filter(Boolean))];
    diagnosticoPaso = { motivo: drill.motivo ?? 'grilla ajena', textos, frames: [] };
    for (const frame of paginaDatos.frames()) {
      const candidatos = {};
      for (const t of textos) candidatos[t] = (await frame.evaluate(buscarElementosConTexto, t).catch(() => []))
        .map((c) => ({ ...c, text: sanitizarTexto(c.text), html: sanitizarTexto(c.html), href: c.href && sanitizarTexto(c.href) }));
      diagnosticoPaso.frames.push({ url: sanitizarTexto(frame.url()), candidatos });
    }
    await paginaDatos.screenshot({ path: path.join(dir, 'paso-no-encontrado.png'), fullPage: true }).catch(() => {});
  }

  // Capturamos TODAS las pestañas abiertas (la grilla puede estar en una pestaña nueva).
  const todas = await relevarTodasLasPaginas(sesion, paginaDatos);
  if (diagnosticoPaso) todas.push({ diagnosticoPaso });
  const rel = todas.find((t) => t.principal) ?? todas[0] ?? { frames: [] };
  escribir(path.join(dir, 'estructura.json'), JSON.stringify(todas, null, 2));
  escribir(path.join(dir, 'pagina.html'), sanitizarHtml(await paginaDatos.content().catch(() => '')));
  const clas = clasificarRelevamiento(rel);
  const lineas = [...resumenRelevamiento(rel), '',
    `== Drill (solo lectura, ruta explícita): pasos ${drill.pasos}, lista=${drill.lista}${drill.motivo ? `, ${drill.motivo}` : ''}`,
    '', '== Clasificación', JSON.stringify(clas, null, 2)];
  escribir(path.join(dir, 'resumen.txt'), lineas.join('\n'));
  // Cerrar las pestañas abiertas por este servicio (la del servicio y la que haya abierto el drill).
  if (paginaDatos !== sesion.page && paginaDatos !== pagina) await paginaDatos.close().catch(() => {});
  if (pagina !== sesion.page) await pagina.close().catch(() => {});

  const drillInfo = { pasos: drill.pasos, lista: drill.lista, motivo: drill.motivo, recorrido: drill.recorrido };
  // Todo intento se registra (también los que no llegaron a extraer): la conservación decide si
  // reemplaza al vigente; uno malo nunca pisa uno bueno.
  const intentos = [{ id: servicio.id, dirIntento, clave: extraccion ? claveDe(extraccion, periodo) : null,
    resultado: extraccion ?? { estado: 'sin-extraccion', filas: 0, error: sanitizarTexto(drill.motivo ?? 'no se llegó a una grilla') } }];
  if (grillaAjena) {
    return { ...clas, url: rel.url, drill: drillInfo, estado: 'con-datos', calidad: extraccion.calidad, intentos,
      motivo: 'la ruta no llegó a la sección: se leyó la grilla de la home (Vencimientos), no se cuenta como dato de esta fuente; diagnóstico del menú capturado' };
  }
  if (extraccion && !extraccion.error && extraccion.filas > 0) {
    const c = extraccion.calidad;
    const validacion = { desde: periodo.desde, hasta: periodo.hasta, filas: extraccion.filas, informados: extraccion.informados,
      ok: c.validado, nivel: c.nivel, cantidadVerificada: c.total === 'coincide', estadoExtractor: extraccion.estado,
      conFiltroPeriodo: extraccion.conFiltroPeriodo, rangoAplicado: extraccion.rangoAplicado, paginas: extraccion.paginas,
      finPaginacion: extraccion.finPaginacion, calidad: c, resumenEstados: extraccion.resumenEstados };
    // validado: dato de la fuente. descargado: filas de la sección con algún control fallido.
    // con-datos: filas que no se probó que sean de esta sección. Solo lo validado llega a vigente.
    const estado = estadoInforme(c, extraccion.filas);
    if (estado !== 'con-datos') {
      return { estado, archivos: extraccion.archivos, filas: extraccion.filas, drill: drillInfo, calidad: c, intentos, validaciones: [validacion],
        motivo: c.motivos.length ? sanitizarTexto(c.motivos.join('; ')) : extraccion.motivo };
    }
    return { ...clas, url: rel.url, estado, archivos: extraccion.archivos, filas: extraccion.filas, drill: drillInfo, calidad: c, intentos,
      validaciones: [validacion],
      // Los encabezados reales van al informe: con ellos se confirman las columnas propias de la sección.
      motivo: sanitizarTexto(`${extraccion.filas} filas leídas, sin validar: ${c.motivos.join('; ')}${extraccion.columnas?.length ? ` · encabezados leídos: ${extraccion.columnas.join(' / ')}` : ''}`) };
  }
  // No se extrajo: queda el relevamiento. Explicitamos por qué (acceso ≠ descarga).
  const motivo = extraccion?.error
    ? `grilla alcanzada pero la extracción falló: ${extraccion.error}`
    : drill.lista ? 'grilla/filtros alcanzados pero sin filas: falta confirmar columnas/consulta'
    : (servicio.ruta?.length
      ? `la ruta de navegación no llegó a la grilla (${drill.motivo ?? 'sin detalle'}); estructura capturada`
      : 'sin ruta de navegación confirmada: estructura capturada para definir la ruta real');
  return { ...clas, url: rel.url, drill: drillInfo, motivo, intentos };
}

/** Extractor de tabla (solo lectura): Mis Retenciones, Cuentas Tributarias, Mis Facilidades. */
async function correrTabla(sesion, servicio, dir, periodo, log, ctx = {}) {
  const outBase = sesion?.cfg?.outDir ?? 'out';
  const dirIntento = ctx.dirIntento?.(servicio.id) ?? null;
  const r = await extraerTabla(sesion, servicio, { desde: periodo.desde, hasta: periodo.hasta, outDir: path.join(outBase, 'datos'), dirSalida: dirIntento, log });
  r.calidad = evaluarCalidad(servicio, r, { desde: periodo.desde, hasta: periodo.hasta });
  // La estructura (DOM de todas las pestañas) va a su propio archivo para el diagnóstico integral.
  const { estructura, ...rSinEstructura } = r;
  escribir(path.join(dir, 'resultado.json'), JSON.stringify(rSinEstructura, null, 2));
  if (estructura) escribir(path.join(dir, 'estructura.json'), JSON.stringify(estructura, null, 2));
  // extractor: validado | extraido | parcial | sin-datos  ->  categorías del informe.
  // Solo cuenta como "descargado" si realmente trajo filas; 0 filas (cero confirmado o ausencia
  // incierta) va a "relevado", nunca a "descargado sin validar".
  // El estado del informe sale de la validación final (calidad.js): columnas reales, paginación,
  // total, período y fechas. Un cero solo es 'validado' si la grilla propia estaba presente y vacía.
  const estado = estadoInforme(r.calidad, r.filas) ?? 'relevado';
  const motivo = r.motivo ?? (r.calidad.motivos.length ? r.calidad.motivos.join('; ') : undefined);
  return {
    estado,
    archivos: r.archivos,
    filas: r.filas,
    motivo,
    ceroConfirmado: r.ceroConfirmado,
    calidad: r.calidad,
    intentos: [{ id: servicio.id, dirIntento, clave: claveDe(r, periodo), resultado: rSinEstructura }],
    validaciones: [{
      desde: periodo.desde, hasta: periodo.hasta, filas: r.filas, informados: r.informados,
      ok: r.calidad.validado, nivel: r.calidad.nivel, cantidadVerificada: r.calidad.total === 'coincide',
      estadoExtractor: r.estado, conFiltroPeriodo: r.conFiltroPeriodo, rangoAplicado: r.rangoAplicado,
      paginas: r.paginas, finPaginacion: r.finPaginacion, motivo, ceroConfirmado: r.ceroConfirmado,
      calidad: r.calidad, resumenEstados: r.resumenEstados,
    }],
  };
}

/**
 * SIFERE (Convenio Multilateral, dominio COMARB). Entra por URL directa, selecciona el CUIT y baja
 * los LISTADOS de SOLO LECTURA (DDJJ mensuales, DDJJ anuales): grillas DataTables reales con la
 * historia de presentaciones. No toca "Nueva DJ" ni nada de presentación/pago. La sesión de clave
 * fiscal federa a COMARB; si COMARB pidiera completar el login, el listado no traerá filas y queda
 * 'relevado' con la estructura capturada (acceso ≠ descarga).
 */
async function correrSifere(sesion, servicio, dir, periodo, log, ctx = {}) {
  const pagina = await sesion.abrirServicio(servicio); // login de clave fiscal -> SIFERE
  // SIFERE/COMARB tiene su PROPIO login de clave fiscal (la sesión de ARCA no alcanza). Si la
  // entrada cae en el login de AFIP o en "Sesión Expirada", esperamos a que el usuario lo complete
  // en la ventana visible (hasta ~3 min) y aterrice en el módulo de SIFERE. Igual que el login
  // inicial, no se tipea la clave: la pone la persona. Si no llega, queda 'relevado' honesto.
  const enModulo = (u) => /sifereweb\.comarb\.gob\.ar/.test(u) && !/SesionExpirada|login\.xhtml|auth\.afip/i.test(u);
  // Corrida 2026-10-22T19-49-58: waitForURL se resolvía con una URL de sifereweb de PASO, justo antes
  // del redirect a SesionExpirada. Ahora exigimos que la URL quede en el módulo de forma ESTABLE (dos
  // lecturas seguidas) y, si cae en SesionExpirada, reabrimos la entrada de login (hasta 2 veces).
  if (!enModulo(pagina.url())) log('  SIFERE pide login de clave fiscal (COMARB): completalo en la ventana visible. Espero hasta 3 minutos.');
  const limite = Date.now() + 180000;
  let estables = 0, reintentos = 0;
  while (Date.now() < limite) {
    const u = pagina.url();
    if (enModulo(u)) {
      if (++estables >= 2) break;
    } else {
      estables = 0;
      if (/SesionExpirada/i.test(u) && reintentos < 2 && servicio.url) {
        reintentos++;
        log(`  SIFERE: sesión expirada, reabro la entrada de login (intento ${reintentos}/2).`);
        await pagina.goto(servicio.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }
    await pagina.waitForTimeout(1500);
  }
  await pagina.waitForLoadState('networkidle').catch(() => {});
  if (!enModulo(pagina.url())) log('  SIFERE: no se llegó al módulo (login no completado o sesión expirada); sigo con lo que haya.');
  // Pantalla "Seleccionar CUIT": elegimos el CUIT (si hay combo) y confirmamos. Solo navegación.
  try {
    const sel = pagina.locator('select').first();
    if (await sel.count().catch(() => 0)) {
      const cuit = sesion?.cfg?.cuit ? String(sesion.cfg.cuit).replace(/\D/g, '') : null;
      if (cuit) await sel.selectOption({ label: new RegExp(cuit) }).catch(() => {});
    }
    let btn = pagina.locator('input[value*="eleccionar" i]');
    if (!(await btn.count().catch(() => 0))) btn = pagina.locator('button, a, [role=button]').filter({ hasText: /^\s*seleccionar\s*$/i });
    if (await btn.count().catch(() => 0)) {
      await btn.first().click().catch(() => {});
      await pagina.waitForLoadState('networkidle').catch(() => {});
      await pagina.waitForTimeout(2000);
    }
  } catch { /* si no aparece la pantalla de CUIT, seguimos a los listados */ }

  const outBase = sesion?.cfg?.outDir ?? 'out';
  const sub = []; const intentos = [];
  const enSesion = enModulo(pagina.url());
  for (const g of servicio.grillas ?? []) {
    const idSub = `${servicio.id}-${g.id}`;
    const dirIntento = ctx.dirIntento?.(idSub) ?? null;
    try {
      await pagina.goto(g.url, { waitUntil: 'domcontentloaded' });
      await pagina.waitForLoadState('networkidle').catch(() => {});
      await pagina.waitForTimeout(2500);
      // Si COMARB nos manda a "Sesión Expirada", el listado NO se lee (y no pisa lo conservado).
      if (/SesionExpirada/i.test(pagina.url())) throw new Error('COMARB: sesión expirada al abrir el listado (no se completó el login)');
      const servSub = { id: idSub, columnasEsperadas: g.columnasEsperadas };
      const r = await extraerTablaEnPagina(pagina, servSub, { desde: periodo.desde, hasta: periodo.hasta, outDir: path.join(outBase, 'datos'), dirSalida: dirIntento, log });
      r.calidad = evaluarCalidad(servSub, r, { desde: periodo.desde, hasta: periodo.hasta });
      sub.push({ sub: g.id, filas: r.filas, estado: r.estado, archivos: r.archivos, motivo: r.motivo, calidad: r.calidad, resumenEstados: r.resumenEstados, finPaginacion: r.finPaginacion });
      intentos.push({ id: idSub, dirIntento, clave: claveDe(r, periodo), resultado: r });
      log(`  sifere/${g.id}: ${r.estado} · ${r.filas} filas${r.resumenEstados ? ` · ${JSON.stringify(r.resumenEstados)}` : ''}`);
    } catch (e) {
      const error = sanitizarTexto(e?.message ?? String(e));
      sub.push({ sub: g.id, filas: 0, estado: 'error', error });
      intentos.push({ id: idSub, dirIntento, clave: null, resultado: { estado: 'error', filas: 0, error } });
    }
  }
  const todas = await relevarTodasLasPaginas(sesion, pagina).catch(() => []);
  escribir(path.join(dir, 'estructura.json'), JSON.stringify(todas, null, 2));
  escribir(path.join(dir, 'resultado.json'), JSON.stringify({ sub }, null, 2));
  if (pagina !== sesion.page) await pagina.close().catch(() => {});

  const filas = sub.reduce((n, s) => n + (s.filas ?? 0), 0);
  const archivos = sub.flatMap((s) => s.archivos ?? []);
  // Validado solo si TODOS los listados se validaron; con filas pero sin validar, descargado.
  const estado = sub.length && sub.every((x) => x.calidad?.validado) ? 'validado' : filas > 0 ? 'descargado' : 'relevado';
  return {
    estado,
    archivos, filas, intentos,
    motivo: filas > 0 ? undefined
      : `SIFERE: no se obtuvieron filas de los listados${enSesion ? '' : ' (COMARB no quedó con sesión: completá el login en la ventana visible)'}; se conserva lo obtenido antes`,
    validaciones: sub.map((s) => ({ sub: s.sub, filas: s.filas, estadoExtractor: s.estado, nivel: s.calidad?.nivel ?? null, ok: !!s.calidad?.validado,
      motivo: s.calidad?.motivos?.length ? s.calidad.motivos.join('; ') : (s.motivo ?? s.error), calidad: s.calidad,
      finPaginacion: s.finPaginacion, resumenEstados: s.resumenEstados })),
  };
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
export async function correrUno(sesion, servicio, { baseDir, periodo, log = () => {}, runner, datosDir = null } = {}) {
  const dir = path.join(baseDir, slug(servicio.id));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const inicio = Date.now();
  // Conservación: los archivos de cada intento van a out/datos/<fuente>/intentos/<corrida>/ y solo
  // se promueven a vigente si son al menos tan buenos como lo conservado. En los tests con runner
  // inyectado no se toca disco fuera de baseDir salvo que se pase datosDir.
  const cuando = path.basename(baseDir);
  const datos = datosDir ?? (runner ? null : path.join(sesion?.cfg?.outDir ?? 'out', 'datos'));
  const ctx = { dirIntento: datos ? (id) => path.join(datos, id, 'intentos', cuando) : () => null };
  const conservar = (r) => {
    if (!datos) return r;
    const { intentos, ...resto } = r;
    try {
      if (intentos?.length) {
        resto.conservacion = intentos.map((it) => ({ id: it.id, ...conservarIntento({ datosDir: datos, id: it.id, cuando, clave: it.clave,
          resultado: it.resultado, dirIntento: it.dirIntento, desde: periodo?.desde, hasta: periodo?.hasta }) }));
      } else {
        registrarIntento({ datosDir: datos, id: servicio.id, cuando, resultado: resto });
      }
    } catch (e) { log(`[${servicio.id}] no se pudo registrar el intento: ${sanitizarTexto(e?.message ?? String(e))}`); }
    return resto;
  };
  // Servicio con bloqueo conocido (p. ej. no adherido a la clave fiscal): se reporta, no se abre.
  if (servicio.bloqueo && !runner) {
    const msg = sanitizarTexto(servicio.bloqueo);
    escribir(path.join(dir, 'bloqueo.txt'), msg);
    log(`[${servicio.id}] sin-acceso (bloqueo): ${msg}`);
    return { id: servicio.id, nombre: servicio.nombre, fuente: servicio.fuente, confirmado: servicio.confirmado, ms: Date.now() - inicio, estado: 'sin-acceso', error: msg };
  }
  const run = runner ?? (async () => {
    if (servicio.extractor === 'mis-comprobantes') return correrMisComprobantes(sesion, servicio, dir, periodo, log);
    if (servicio.extractor === 'tabla') return correrTabla(sesion, servicio, dir, periodo, log, ctx);
    if (servicio.extractor === 'sifere') return correrSifere(sesion, servicio, dir, periodo, log, ctx);
    return correrGenerico(sesion, servicio, dir, periodo, log, ctx);
  });
  try {
    log(`[${servicio.id}] abriendo ${servicio.nombre}`);
    const r = conservar(await run());
    log(`[${servicio.id}] ${r.estado}${(r.conservacion ?? []).map((c) => ` · ${c.id}: ${c.motivo}`).join('')}`);
    return { id: servicio.id, nombre: servicio.nombre, fuente: servicio.fuente, confirmado: servicio.confirmado, ms: Date.now() - inicio, ...r };
  } catch (e) {
    const estado = e?.name === 'DesafioDeSeguridad' ? 'desafio' : (/no encontré|no pude abrir|timeout/i.test(e.message) ? 'sin-acceso' : 'error');
    // El mensaje y el stack pueden contener texto de la pantalla: se sanean antes de guardar o devolver.
    const msg = sanitizarTexto(e.message);
    log(`[${servicio.id}] ${estado}: ${msg}`);
    escribir(path.join(dir, 'error.txt'), sanitizarTexto(`${e.name}: ${e.message}\n${e.stack ?? ''}`));
    // El intento fallido también queda registrado (y no toca lo conservado).
    if (datos) {
      const subs = servicio.extractor === 'sifere' ? (servicio.grillas ?? []).map((g) => `${servicio.id}-${g.id}`) : [servicio.id];
      for (const id of subs) { try { conservarIntento({ datosDir: datos, id, cuando, clave: null, resultado: { estado, filas: 0, error: msg } }); } catch { /* best-effort */ } }
    }
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
    if (r.estado === 'con-datos' || r.estado === 'relevado') {
      // Resultado de un extractor de tabla con 0 filas: mostrar si es cero confirmado o incierto.
      if (r.motivo) return r.motivo;
      return `${r.filas ?? 0} filas en pantalla; export: ${r.exportacion?.length ? r.exportacion.map((e) => e.texto).join('/') : 'no visible'}; ${r.listoParaExtractor ? 'listo para extractor' : 'faltan filtros/consulta'}`;
    }
    if (r.error) return r.error.slice(0, 120);
    return '';
  };
  // Evidencia extra por fila: por qué no se validó, cómo se navegó y qué se conservó.
  const extras = (r) => {
    const x = [];
    const nivelTxt = { apto: 'APTO para cálculos', validado: 'validado, sin total de ARCA: no apto para cálculos', obtenido: 'obtenido sin validar (evidencia)' };
    if (r.calidad?.nivel && nivelTxt[r.calidad.nivel]) x.push(nivelTxt[r.calidad.nivel]);
    for (const v of r.validaciones ?? []) if (v.sub && v.nivel) x.push(`${v.sub}: ${nivelTxt[v.nivel] ?? v.nivel}`);
    if (r.estado === 'descargado' && r.calidad?.motivos?.length && !r.motivo) x.push(`sin validar: ${r.calidad.motivos.join('; ')}`);
    if (r.drill?.recorrido?.length) x.push(`ruta: ${r.drill.recorrido.map((p) => `${p.paso}=${p.via}`).join(', ')}`);
    for (const c of r.conservacion ?? []) if (!c.promovido && c.vigente) x.push(`${c.id}: ${c.motivo}`);
    return x.length ? ` · ${x.join(' · ')}` : '';
  };
  const fila = (r) => `| ${r.nombre} | ${r.fuente} | **${r.estado}** | ${String(detalleDe(r) + extras(r)).replace(/\|/g, '/')} |`;
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
  txt.push('', 'Esta tabla es solo ESTA corrida. Qué períodos están cubiertos (con lo conservado de corridas anteriores) está en `cobertura-historica.md`.');
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

/**
 * Escribe/actualiza los informes de la corrida (cobertura + diagnóstico integral) con lo que haya
 * hasta el momento. Se llama DESPUÉS DE CADA servicio (no solo al final), para que si la corrida se
 * corta en el último servicio (el más frágil, p. ej. Retenciones), igual queden los informes de
 * todo lo anterior. Es barato (son ~16 servicios) y hace la corrida tolerante a fallos duros.
 */
/** Fuentes de la matriz histórica: cada servicio, y los listados de SIFERE como fuentes propias. */
export function fuentesDe(servicios) {
  return servicios.flatMap((s) => (s.extractor === 'sifere' && s.grillas?.length
    ? s.grillas.map((g) => ({ id: `${s.id}-${g.id}`, nombre: `SIFERE · ${g.id}` }))
    : [{ id: s.id, nombre: s.nombre }]));
}

function escribirInformes(baseDir, outDir, resultados, servicios, sesion, cuando, { datosDir = null, historicoDesde = null } = {}) {
  const cobertura = generarCobertura(resultados, { cuit: sesion?.cfg?.cuit, cuando });
  // Cobertura HISTÓRICA (lo conservado entre corridas, no solo esta): en out/datos y en la corrida.
  if (datosDir) {
    const matriz = generarMatrizCobertura(datosDir, fuentesDe(servicios), { historicoDesde });
    escribir(path.join(datosDir, 'cobertura-historica.json'), JSON.stringify(matriz.objeto, null, 2));
    escribir(path.join(datosDir, 'cobertura-historica.md'), matriz.texto);
    escribir(path.join(baseDir, 'cobertura-historica.md'), matriz.texto);
  }
  escribir(path.join(baseDir, 'cobertura.json'), JSON.stringify(cobertura.objeto, null, 2));
  escribir(path.join(baseDir, 'cobertura.md'), cobertura.texto);
  // Diagnóstico INTEGRAL en un solo archivo: el DOM saneado de cada servicio (todas sus pestañas).
  // Es lo único que hace falta mandar para escribir todos los extractores sin más corridas a ciegas.
  const integral = {};
  for (const s of servicios) {
    const f = path.join(baseDir, slug(s.id), 'estructura.json');
    if (fs.existsSync(f)) { try { integral[s.id] = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* ignore */ } }
  }
  escribir(path.join(baseDir, 'diagnostico-integral.json'), JSON.stringify(integral, null, 2));
  escribir(path.join(outDir, 'ultima.txt'), baseDir); // puntero a la última corrida
  return cobertura;
}

/** Recorre todos los servicios, aislando fallos, y persiste la corrida. */
export async function ejecutarTodo(sesion, { servicios, periodo, outDir = 'out/corridas', log = () => {}, runner, datosDir = null,
  historicoDesde = process.env.FISCALOS_HISTORICO_DESDE || null } = {}) {
  const cuando = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseDir = path.join(outDir, cuando);
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  // Datos conservados entre corridas. Con runner inyectado (tests) solo si se pasa datosDir explícito.
  const datos = datosDir ?? (runner ? null : path.join(sesion?.cfg?.outDir ?? path.dirname(outDir), 'datos'));
  const resultados = [];
  let cobertura = generarCobertura(resultados, { cuit: sesion?.cfg?.cuit, cuando });
  for (const s of servicios) {
    // Doble red: correrUno ya aísla sus errores, pero por las dudas envolvemos igual para que NADA
    // (ni un error inesperado al abrir el servicio) corte la corrida antes de escribir los informes.
    try {
      resultados.push(await correrUno(sesion, s, { baseDir, periodo, log, datosDir: datos, runner: runner ? () => runner(s) : undefined }));
    } catch (e) {
      const error = sanitizarTexto(e?.message ?? String(e));
      log(`[${s.id}] error aislado en el orquestador: ${error}`);
      resultados.push({ id: s.id, nombre: s.nombre, fuente: s.fuente, confirmado: s.confirmado, estado: 'error', error });
    }
    // Persistimos los informes tras CADA servicio: si lo que viene después se cuelga, no se pierde
    // nada de lo ya recorrido. Un fallo al escribir no corta la corrida.
    try { cobertura = escribirInformes(baseDir, outDir, resultados, servicios, sesion, cuando, { datosDir: datos, historicoDesde }); }
    catch (e) { log(`[informes] no se pudieron actualizar: ${sanitizarTexto(e?.message ?? String(e))}`); }
  }
  return { baseDir, resultados, cobertura };
}
