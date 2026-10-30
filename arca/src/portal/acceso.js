/**
 * Seguimiento del ACCESO a un sistema que se abre desde el portal de ARCA: qué pestañas abrió ESA acción, por qué
 * direcciones pasó (SSO de clave fiscal, redirecciones) y dónde terminó. Sirve para no culpar al sitio por lo que pasó
 * en otra pestaña, y para distinguir un acceso equivocado, un login pendiente, una sesión expirada y un error de red
 * (DNS, tiempo agotado, certificado, conexión). Lo que se registra no lleva query, fragmento, cookies ni cuerpos: solo
 * origen y ruta (más el parámetro público `system` del SSO de ARCA, que dice a qué sistema se pidió entrar).
 */

// Accesos oficiales de la Comisión Arbitral (https://www.ca.gob.ar/sifere): cada módulo de SIFERE WEB tiene su sistema
// en el login de clave fiscal de ARCA.
export const SISTEMA_SSO = { consultas: 'comarb_sifereweb_consultas', ddjj: 'comarb_sifereweb_ddjj' };
export const urlSso = (sistema) => `https://auth.afip.gob.ar/contribuyente_/login.xhtml?action=SYSTEM&system=${sistema}`;

/** Origen y ruta de una dirección; del SSO de ARCA, además, el sistema pedido. Sin query ni fragmento. Pura. */
export function urlDeAcceso(u) {
  const s = String(u ?? '');
  if (/^chrome-error:/i.test(s)) return 'chrome-error';
  if (/^about:blank/i.test(s)) return 'about:blank';
  let x; try { x = new URL(s); } catch { return '[url]'; }
  const sistema = /(^|\.)auth\.afip\.gob\.ar$/i.test(x.hostname) ? x.searchParams.get('system') : null;
  return `${x.origin}${x.pathname}${sistema && /^[a-z0-9_]+$/i.test(sistema) ? `?system=${sistema}` : ''}`;
}

/** Tipo de un error de red de Chromium («net::ERR_…»). Pura. */
export function tipoErrorRed(codigo) {
  const c = String(codigo ?? '').toUpperCase();
  if (!c) return 'desconocido';
  if (/NAME_NOT_RESOLVED|NAME_RESOLUTION|DNS/.test(c)) return 'dns';
  if (/TIMED_OUT|TIMEOUT/.test(c)) return 'tiempo agotado';
  if (/CERT|SSL|TLS/.test(c)) return 'certificado';
  if (/CONNECTION_(REFUSED|RESET|CLOSED|FAILED|ABORTED)|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|NETWORK_CHANGED|EMPTY_RESPONSE|PROXY|TUNNEL/.test(c)) return 'conexión';
  return 'otro';
}

/**
 * Empieza a seguir las pestañas que se abran en `context` desde ahora (y las que ya estaban y se agreguen con `seguir`,
 * p. ej. un servicio que se abre en la misma pestaña). De cada una registra, de su marco principal: navegaciones,
 * respuestas de navegación (estado HTTP, también las redirecciones) y navegaciones fallidas (código de Chromium). Se
 * escucha el CONTEXTO y no la pestaña: una pestaña nueva se anuncia recién después de su primera navegación, y las
 * redirecciones del SSO se perderían. Devuelve { paginas, eventos, eventosDe(p), seguir(p), detener() }.
 */
export function seguirAcceso(context) {
  const antes = new Set(context?.pages?.() ?? []);
  const seguidas = new Set(); const paginas = []; const eventos = [];
  const propia = (p) => {
    if (!p || (antes.has(p) && !seguidas.has(p))) return null;
    if (!paginas.includes(p)) paginas.push(p);
    return p;
  };
  // La navegación inicial de una pestaña nueva llega ANTES de que exista la pestaña (request.frame() falla): queda
  // «sin pestaña» y se le asigna a la próxima pestaña que se anuncie (los accesos se hacen de a uno).
  const SIN = Symbol('sin pestaña');
  const dePagina = (q) => {
    let f; try { f = q.frame(); } catch { return q.isNavigationRequest() ? SIN : null; }
    const p = f.page();
    return q.isNavigationRequest() && f === p.mainFrame() ? propia(p) : null;
  };
  const alAbrir = (p) => { if (propia(p)) for (const e of eventos) if (e.pagina === SIN) e.pagina = p; };
  const alResponder = (r) => { const q = r.request(); const p = dePagina(q); if (p) eventos.push({ pagina: p, tipo: 'respuesta', url: urlDeAcceso(r.url()), metodo: q.method(), estado: r.status() }); };
  const alFallar = (q) => { const p = dePagina(q); if (p) eventos.push({ pagina: p, tipo: 'fallo', url: urlDeAcceso(q.url()), metodo: q.method(), error: String(q.failure()?.errorText ?? '').slice(0, 80) }); };
  context?.on?.('page', alAbrir); context?.on?.('response', alResponder); context?.on?.('requestfailed', alFallar);
  return {
    paginas, eventos,
    eventosDe: (p) => eventos.filter((e) => e.pagina === p).map(({ pagina, ...e }) => e),
    seguir: (p) => { if (p) { seguidas.add(p); propia(p); } },
    detener: () => { context?.off?.('page', alAbrir); context?.off?.('response', alResponder); context?.off?.('requestfailed', alFallar); },
  };
}

/** Código de error que muestra la página de error de Chromium (p. ej. «ERR_CONNECTION_TIMED_OUT»), o null. */
export async function codigoDePaginaDeError(p) {
  if (!/^chrome-error:/i.test(p?.url?.() ?? '')) return null;
  const t = await p.evaluate(() => document.querySelector('.error-code')?.textContent ?? document.body?.innerText ?? '').catch(() => '');
  return String(t).match(/\b(?:NET::)?ERR_[A-Z_]+\b/i)?.[0]?.toUpperCase() ?? null;
}

const hostDe = (u) => { try { return new URL(u).hostname; } catch { return null; } };
const sistemaDe = (u) => String(u ?? '').match(/[?&]system=([a-z0-9_]+)/i)?.[1] ?? null;

/**
 * Dónde quedó el acceso de UNA pestaña, con lo que se vio de ella. Pura. Estados:
 *   'en-modulo'           en el host del módulo, sin error, fuera del login y de «Sesión expirada»;
 *   'acceso-equivocado'   el SSO pidió OTRO sistema (p. ej. el de DDJJ en lugar del de Consultas);
 *   'error-red'           la navegación falló en el navegador (con su tipo: dns, tiempo agotado, certificado, conexión);
 *   'login-pendiente'     quedó en el login de clave fiscal de ARCA (la persona lo completa en la ventana visible);
 *   'sesion-expirada'     el módulo respondió «Sesión expirada»;
 *   'mantenimiento'       el sitio muestra su página de «Tareas de Mantenimiento» (por el título);
 *   'fuera-del-modulo'    terminó en otra parte (p. ej. sigue en el portal de ARCA);
 *   'sin-pestana'         la acción no abrió ninguna pestaña.
 * `cadena`: las direcciones por las que pasó, en orden y sin repetir seguidas.
 */
export function clasificarAcceso({ url, eventos = [], codigoPagina = null, hostModulo, sistema = null, titulo = '' }) {
  if (url == null) return { estado: 'sin-pestana', detalle: 'el acceso no abrió ninguna pestaña', cadena: [] };
  const cadena = [];
  for (const e of eventos) if (e.tipo !== 'fallo' && e.url && e.url !== 'about:blank' && cadena.at(-1) !== e.url) cadena.push(e.url);
  const fallos = eventos.filter((e) => e.tipo === 'fallo' && !/ERR_ABORTED/i.test(e.error ?? ''));
  const pedidos = [...new Set(eventos.map((e) => sistemaDe(e.url)).filter(Boolean))];
  const final = urlDeAcceso(url);
  // Solo se juzga contra los sistemas CONOCIDOS de otros módulos: un nombre de sistema que no conocemos no se descarta.
  const ajenos = pedidos.filter((x) => x !== sistema && Object.values(SISTEMA_SSO).includes(x));
  if (sistema && ajenos.length && !pedidos.includes(sistema)) {
    return { estado: 'acceso-equivocado', detalle: `el acceso pidió el sistema ${ajenos.join(', ')} y no ${sistema}`, cadena, final };
  }
  if (/^chrome-error:/i.test(url)) {
    const f = fallos.at(-1);
    const codigo = (f?.error || codigoPagina || '').replace(/^net::/i, '') || null;
    const donde = f?.url ? f.url.replace(/^https?:\/\//, '') : 'dirección no registrada';
    return { estado: 'error-red', tipo: tipoErrorRed(codigo), codigo, host: f?.url ? hostDe(f.url) : null, metodo: f?.metodo ?? null,
      detalle: `el navegador no pudo cargar ${donde} (${codigo ?? 'sin código'}: ${tipoErrorRed(codigo)})`, cadena, final };
  }
  if (/auth\.afip\.gob\.ar\/contribuyente_?\/login/i.test(url)) return { estado: 'login-pendiente', detalle: 'quedó en el login de clave fiscal de ARCA', cadena, final };
  if (/SesionExpirada/i.test(url)) return { estado: 'sesion-expirada', detalle: 'el módulo respondió «Sesión expirada»', cadena, final };
  // COMARB muestra «SIFERE - Mantenimiento» / «Tareas de Mantenimiento» en el host del módulo: lo dice el sitio.
  if (/mantenimiento/i.test(titulo ?? '')) return { estado: 'mantenimiento', detalle: `el sitio informa tareas de mantenimiento (${final.replace(/^https?:\/\//, '')})`, cadena, final };
  if (hostModulo?.test(url)) return { estado: 'en-modulo', detalle: `en ${final.replace(/^https?:\/\//, '')}`, cadena, final };
  return { estado: 'fuera-del-modulo', detalle: `terminó en ${final.replace(/^https?:\/\//, '')}, fuera del módulo`, cadena, final };
}

/**
 * La pestaña de la acción: la que devolvió la apertura si es una de las que abrió; si no (p. ej. la pestaña nueva tardó
 * más que la espera y se devolvió la del portal), la última que abrió; si no abrió ninguna, la que devolvió (el servicio
 * se abrió en la misma pestaña). Las demás pestañas abiertas NO cuentan: un error en otra pestaña no es del servicio.
 */
export function paginaDeLaAccion(devuelta, propias) {
  const vivas = propias.filter((p) => !p.isClosed?.());
  if (devuelta && vivas.includes(devuelta)) return devuelta;
  return vivas.at(-1) ?? devuelta ?? null;
}
