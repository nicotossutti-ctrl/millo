/**
 * Relevamiento estructural de una página autenticada: inputs, botones, enlaces, iframes,
 * menús y roles, en el documento principal, en cada frame y dentro de shadow DOM.
 * Solo lectura. Nunca guarda el valor de un input. Los textos se sanean con sanitizarTexto.
 */
import { sanitizarTexto, sanitizarUrl } from './diagnostico.js';

/** Se ejecuta dentro del navegador. Recorre el DOM incluyendo shadow roots. */
function relevarEnDocumento() {
  const vis = (e) => {
    try {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    } catch { return false; }
  };
  const todos = [];
  const recorrer = (raiz, enShadow) => {
    const walker = document.createTreeWalker(raiz, NodeFilter.SHOW_ELEMENT);
    let n = walker.currentNode;
    while (n) {
      if (n.nodeType === 1) {
        todos.push({ e: n, enShadow });
        if (n.shadowRoot) recorrer(n.shadowRoot, true);
      }
      n = walker.nextNode();
    }
  };
  recorrer(document, false);

  const desc = ({ e, enShadow }) => ({
    tag: e.tagName.toLowerCase(),
    id: e.id || null,
    name: e.getAttribute('name'),
    type: e.getAttribute('type'),
    role: e.getAttribute('role'),
    placeholder: e.getAttribute('placeholder'),
    ariaLabel: e.getAttribute('aria-label'),
    title: e.getAttribute('title'),
    href: e.getAttribute('href'),
    src: e.getAttribute('src'),
    cls: e.className?.toString?.().slice(0, 100) || null,
    text: /^(input|select|textarea)$/i.test(e.tagName) ? null : (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100) || null,
    visible: vis(e),
    enShadow,
    ...(e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' ? { rect: (() => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })() } : {}),
    // Para <select> guardamos las opciones (p. ej. el desplegable de impuesto en Mis Retenciones).
    ...(e.tagName === 'SELECT' ? { opciones: [...e.options].map((o) => (o.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)).filter(Boolean).slice(0, 40) } : {}),
  });

  const es = (x, sel) => { try { return x.e.matches(sel); } catch { return false; } };
  const lim = (arr, n) => arr.slice(0, n);
  return {
    title: document.title,
    url: location.href,
    totalElementos: todos.length,
    conShadowDom: todos.some((x) => x.enShadow),
    inputs: lim(todos.filter((x) => es(x, 'input, textarea, select')).map(desc), 200),
    botones: lim(todos.filter((x) => es(x, 'button, input[type=submit], input[type=button], [role=button], a.btn, .btn')).map(desc), 300),
    enlaces: lim(todos.filter((x) => es(x, 'a[href], [role=link]')).map(desc), 800),
    iframes: todos.filter((x) => es(x, 'iframe, frame')).map(desc),
    formularios: todos.filter((x) => es(x, 'form')).map((x) => ({ id: x.e.id || null, name: x.e.getAttribute('name'), action: x.e.getAttribute('action'), method: x.e.getAttribute('method') })),
    menus: lim(todos.filter((x) => es(x, 'nav, [role=navigation], [role=menu], [role=menubar], [role=tablist], ul.nav, .menu, .navbar, .sidebar, aside')).map((x) => ({
      ...desc(x),
      items: lim([...x.e.querySelectorAll('a, button, [role=menuitem], [role=tab], li')].map((i) => (i.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80)).filter(Boolean), 100),
    })), 50),
    conRol: lim(todos.filter((x) => x.e.getAttribute('role') && !es(x, 'button, a, nav, [role=navigation], [role=menu], [role=menubar]')).map(desc), 200),
    textosVisibles: lim(todos.filter((x) => es(x, 'h1, h2, h3, h4, label, legend, summary, [role=heading]') && vis(x.e)).map((x) => (x.e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 100)).filter(Boolean), 200),
    // Captura <table> clásicas Y grillas de componente (ARIA role=grid, Syncfusion .e-grid, etc.),
    // que son las que usan los portales nuevos de ARCA (IVA, Bienes Personales, DDJJ y Pagos).
    tablas: lim(todos.filter((x) => es(x, 'table, [role=grid], [role=table], .e-grid, .ag-root-wrapper, .k-grid')).map((x) => {
      const e = x.e;
      const esComp = !/^table$/i.test(e.tagName);
      const txt = (c) => (c.innerText || c.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const encabezados = (esComp
        ? [...e.querySelectorAll('[role=columnheader], .e-headercelldiv, .e-headertext')]
        : [...e.querySelectorAll('thead th, thead td, tr:first-child th')]).map(txt).filter(Boolean).slice(0, 40);
      const filas = esComp
        ? [...e.querySelectorAll('[role=row]')].filter((r) => r.querySelector('[role=gridcell], [role=cell], .e-rowcell')).length
        : e.querySelectorAll('tbody tr').length;
      return { id: e.id || null, cls: e.className?.toString?.().slice(0, 100) || null, visible: vis(e), tipo: esComp ? 'componente' : 'table', encabezados, filas };
    }), 30),
    paginacion: lim(todos.filter((x) => es(x, '.dataTables_info, .dataTables_paginate, .dataTables_length, .pagination, [class*="pagin" i], [id*="pagin" i], [class*="_info"], [id*="_info"], select[name*="length"]') && vis(x.e)).map(desc), 30),
    mensajes: lim(todos.filter((x) => es(x, '.alert, .mensaje, .error, .warning, [role=alert], .dataTables_empty, .text-danger, .text-warning') && vis(x.e)).map((x) => (x.e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160)).filter(Boolean), 20),
  };
}

function sanear(obj) {
  if (obj == null) return obj;
  if (typeof obj === 'string') return sanitizarTexto(obj);
  if (Array.isArray(obj)) return obj.map(sanear);
  if (typeof obj === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(obj)) o[k] = (k === 'href' || k === 'src' || k === 'url' || k === 'action') && typeof v === 'string' && /^https?:/i.test(v) ? sanitizarUrl(v) : sanear(v);
    return o;
  }
  return obj;
}

/** Releva la página y todos sus frames. Devuelve un objeto saneado, listo para guardar. */
export async function relevarPagina(pagina) {
  const frames = [];
  for (const frame of pagina.frames()) {
    let r;
    try {
      r = await frame.evaluate(relevarEnDocumento);
    } catch (e) {
      r = { error: e.message };
    }
    frames.push({ nombre: frame.name() || null, url: sanitizarUrl(frame.url()), principal: frame === pagina.mainFrame(), ...r });
  }
  return sanear({ url: sanitizarUrl(pagina.url()), title: await pagina.title().catch(() => null), frames });
}

/** Resumen corto para pegar en el chat: lo necesario para escribir selectores. */
export function resumenRelevamiento(rel) {
  const l = [];
  l.push(`Página: ${rel.title ?? ''} ${rel.url}`);
  for (const f of rel.frames) {
    l.push(`\n== Frame ${f.principal ? 'principal' : f.nombre ?? '(sin nombre)'} ${f.url}${f.conShadowDom ? ' [usa shadow DOM]' : ''}`);
    if (f.error) { l.push(`  error: ${f.error}`); continue; }
    l.push(`  elementos ${f.totalElementos} · inputs ${f.inputs.length} · botones ${f.botones.length} · enlaces ${f.enlaces.length} · iframes ${f.iframes.length} · menús ${f.menus.length}`);
    const attrs = (x) => ['tag', 'type', 'id', 'name', 'placeholder', 'ariaLabel', 'role', 'cls'].filter((k) => x[k]).map((k) => `${k}=${JSON.stringify(x[k])}`).join(' ');
    for (const i of f.inputs.filter((x) => x.visible)) l.push(`  input  ${attrs(i)} ${i.rect ? `${i.rect.w}x${i.rect.h}` : ''}${i.opciones?.length ? ` opciones=[${i.opciones.join(' | ')}]` : ''}${i.enShadow ? ' [shadow]' : ''}`);
    for (const b of f.botones.filter((x) => x.visible).slice(0, 40)) l.push(`  botón  ${JSON.stringify(b.text ?? b.ariaLabel ?? b.title ?? '')} ${attrs(b)}${b.enShadow ? ' [shadow]' : ''}`);
    for (const a of f.enlaces.filter((x) => x.visible && x.text).slice(0, 120)) l.push(`  enlace ${JSON.stringify(a.text)} -> ${a.href ?? ''}${a.enShadow ? ' [shadow]' : ''}`);
    for (const i of f.iframes) l.push(`  iframe ${attrs(i)} src=${i.src ?? ''}`);
    for (const m of f.menus.slice(0, 10)) l.push(`  menú   ${attrs(m)}: ${m.items.slice(0, 25).join(' | ')}`);
    if (f.textosVisibles.length) l.push(`  títulos: ${f.textosVisibles.slice(0, 30).join(' | ')}`);
    for (const t of f.tablas ?? []) l.push(`  tabla  ${attrs(t)} ${t.visible ? 'visible' : 'oculta'} · ${t.filas} filas · columnas: ${t.encabezados.join(' | ')}`);
    for (const pg of f.paginacion ?? []) l.push(`  paginación ${attrs(pg)}: ${JSON.stringify(pg.text ?? '')}`);
    for (const m of f.mensajes ?? []) l.push(`  mensaje: ${JSON.stringify(m)}`);
  }
  return l;
}
