/**
 * Sesión autenticada en el portal de ARCA con Playwright.
 *
 * Reglas:
 * - Nunca elude CAPTCHA, segundo factor ni ninguna verificación. Si aparece una, se detiene,
 *   avisa, y en modo visible (--visible) deja que la persona la resuelva a mano.
 * - La clave fiscal no se guarda en disco. Se toma de ARCA_CLAVE (variable de entorno, por
 *   ejemplo desde el llavero del sistema) o se tipea a mano en modo visible.
 * - Las cookies de sesión se guardan en .sesion/<cuit>.json con permisos 0600 y se reutilizan
 *   mientras sirvan. ARCA las vence solo; cuando pasa, se vuelve a loguear.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

export const URL_LOGIN = 'https://auth.afip.gob.ar/contribuyente_/login.xhtml';
export const URL_PORTAL = 'https://portalcf.cloud.afip.gob.ar/portal/app/';

/** Normaliza para comparar nombres de servicios: sin acentos, guiones como espacio, minúsculas. */
export function normalizarServicio(x) {
  return String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2012-\u2015_-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
/** true si el texto del candidato contiene alguno de los términos (normalizados). */
export function coincideServicio(textoCandidato, terminos) {
  const c = normalizarServicio(textoCandidato);
  return terminos.some((t) => { const n = normalizarServicio(t); return n.length > 0 && c.includes(n); });
}

const SELECTORES_DESAFIO = ['iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', '.g-recaptcha', '#captcha', 'img[alt*="captcha" i]', 'input[name*="captcha" i]', 'input[name*="token" i]', 'input[name*="otp" i]', 'input[name*="codigo" i]'];

export class DesafioDeSeguridad extends Error {
  constructor(que) { super(`ARCA pidió una verificación adicional (${que}). No se automatiza: ejecutá con --visible y resolvela a mano.`); this.name = 'DesafioDeSeguridad'; }
}

function archivoSesion(cfg) {
  return path.join(path.resolve(cfg.sesionDir ?? '.sesion'), `${cfg.cuit}.json`);
}

async function hayDesafio(page) {
  for (const sel of SELECTORES_DESAFIO) {
    const el = page.locator(sel).first();
    if (await el.count() && await el.isVisible().catch(() => false)) return sel;
  }
  return null;
}

export class Sesion {
  constructor(cfg, { visible = false, log = () => {}, downloadsDir = null } = {}) {
    this.cfg = cfg;
    this.visible = visible;
    this.log = log;
    this.downloadsDir = downloadsDir ?? path.join(cfg.outDir ?? 'out', 'descargas');
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async abrir() {
    fs.mkdirSync(this.downloadsDir, { recursive: true });
    // ARCA_CHROMIUM permite usar un Chromium ya instalado en vez del que baja Playwright.
    // Ventana grande (1920) a propósito: varias pantallas de ARCA son RESPONSIVE y a ancho chico
    // colapsan el menú (p. ej. la barra lateral de Cuentas Tributarias esconde DJ/Pagos/Cuenta
    // Corriente/Compensaciones tras un hamburguesa). A 1920 renderizan expandidas, como en pantalla.
    this.browser = await chromium.launch({ headless: !this.visible, slowMo: this.visible ? 50 : 0, args: ['--window-size=1920,1080'], executablePath: process.env.ARCA_CHROMIUM || undefined });
    const sesion = archivoSesion(this.cfg);
    const opts = { acceptDownloads: true, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', viewport: { width: 1920, height: 1080 } };
    if (fs.existsSync(sesion)) {
      opts.storageState = sesion;
      this.log(`Reutilizando sesión guardada (${sesion}).`);
    }
    this.context = await this.browser.newContext(opts);
    this.context.setDefaultTimeout(30000);
    this.page = await this.context.newPage();
    return this;
  }

  async cerrar() {
    await this.context?.close();
    await this.browser?.close();
  }

  /** Guarda cookies y storage para no volver a loguear hasta que ARCA venza la sesión. */
  async guardar() {
    const f = archivoSesion(this.cfg);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    await this.context.storageState({ path: f });
    fs.chmodSync(f, 0o600);
  }

  async estaLogueado() {
    await this.page.goto(URL_PORTAL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle').catch(() => {});
    // Si el portal redirige al login, no hay sesión.
    if (this.page.url().includes('auth.afip.gob.ar')) return false;
    return (await this.page.locator('text=/Servicios|Más utilizados|Estado de cuenta/i').count()) > 0;
  }

  /**
   * Login en dos pasos (CUIT → clave). Si no hay ARCA_CLAVE y la sesión es visible, espera a que
   * la persona tipee la clave. Ante CAPTCHA o segundo factor: en modo visible espera a que la
   * persona lo resuelva y, si la sesión queda iniciada, termina ahí; en modo oculto falla.
   * En ningún caso se sigue operando el formulario después de una verificación.
   */
  async login() {
    const { page, cfg } = this;
    await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });
    if (await this.resolverDesafioSiHay('antes del CUIT')) return;

    await page.fill('#F1\\:username', cfg.cuit);
    await page.click('#F1\\:btnSiguiente');
    await page.waitForSelector('#F1\\:password', { state: 'attached', timeout: 20000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    if (await this.resolverDesafioSiHay('después del CUIT')) return;
    if (!(await page.locator('#F1\\:password').count())) {
      const msg = ((await page.locator('#F1\\:msg').textContent().catch(() => '')) || '').trim();
      throw new Error(`ARCA no pasó al paso de la clave${msg ? `: ${msg}` : ''}. Corré con --visible para ver qué muestra.`);
    }

    const clave = process.env.ARCA_CLAVE;
    if (clave) {
      await page.fill('#F1\\:password', clave);
      // El botón del segundo paso cambió de id más de una vez; si no está, Enter envía el formulario.
      const btn = page.locator('#F1\\:btnIngresar, input[type="submit"][value*="Ingresar" i], button:has-text("Ingresar")').first();
      if (await btn.count()) await btn.click(); else await page.press('#F1\\:password', 'Enter');
    } else if (this.visible) {
      this.log('Tipeá la clave fiscal en la ventana del navegador y presioná Ingresar. Espero hasta 3 minutos.');
    } else {
      throw new Error('Sin ARCA_CLAVE y sin --visible no se puede loguear. Definí ARCA_CLAVE o corré con --visible para tipearla a mano.');
    }

    const timeout = this.visible ? 180000 : 45000;
    const salida = await Promise.race([
      page.waitForURL((u) => !u.href.includes('auth.afip.gob.ar'), { timeout }).then(() => 'ok'),
      page.waitForSelector('#F1\\:msg:not(:empty)', { timeout }).then(() => 'msg'),
    ]).catch(() => 'timeout');

    if (salida === 'ok') return this.confirmarLogin();
    if (await this.resolverDesafioSiHay('después de la clave')) return;
    if (salida === 'msg') {
      const err = ((await page.locator('#F1\\:msg').textContent()) ?? '').trim();
      throw new Error(`ARCA rechazó el ingreso: ${err}`);
    }
    throw new Error('El login no terminó a tiempo. Corré con --visible para ver qué muestra ARCA.');
  }

  /** Verifica que el portal cargue con sesión y recién entonces guarda las cookies. */
  async confirmarLogin() {
    if (!(await this.estaLogueado())) throw new Error('Salimos del login pero el portal no muestra sesión iniciada.');
    await this.guardar();
    this.log('Sesión iniciada y guardada.');
  }

  /**
   * Si hay un CAPTCHA u otra verificación: en modo visible espera a que la persona la resuelva
   * (hasta 3 minutos) y devuelve true si la sesión quedó iniciada; en modo oculto lanza
   * DesafioDeSeguridad. Devuelve false si no había verificación.
   */
  async resolverDesafioSiHay(momento) {
    const que = await hayDesafio(this.page);
    if (!que) return false;
    if (!this.visible) throw new DesafioDeSeguridad(`${que} ${momento}`);
    this.log(`ARCA pidió una verificación (${que}, ${momento}). Resolvela a mano en la ventana, incluida la clave si la pide; espero hasta 3 minutos.`);
    try {
      await this.page.waitForURL((u) => !u.href.includes('auth.afip.gob.ar'), { timeout: 180000 });
    } catch {
      throw new DesafioDeSeguridad(`${que} ${momento}, no resuelta en 3 minutos`);
    }
    await this.confirmarLogin();
    return true;
  }

  async asegurarLogin() {
    if (await this.estaLogueado()) { this.log('Sesión vigente.'); return; }
    this.log('Sin sesión vigente: iniciando login.');
    await this.login();
  }

  /**
   * Abre un servicio del portal por nombre. No depende de un buscador con selector fijo:
   * 1. Si en la página principal (en cualquier frame) hay un enlace o botón visible con ese
   *    nombre, por ejemplo en "Más utilizados", lo usa.
   * 2. Si no, busca un campo de texto visible y grande (el buscador del portal, tenga el
   *    atributo que tenga), tipea el nombre y espera un resultado con ese texto.
   * 3. Si nada de eso existe, falla con un mensaje que remite a portal:inspeccionar.
   * Los servicios suelen abrir en una pestaña nueva; devolvemos esa página.
   */
  async abrirServicio(target) {
    const { page } = this;
    const nombre = typeof target === 'string' ? target : target.nombre;
    const terminos = typeof target === 'string'
      ? [target]
      : (target.terminos?.length ? target.terminos : [target.nombre]);

    // Servicio con URL DIRECTA (p. ej. SIFERE en COMARB, otro dominio que no está en el listado del
    // portal ARCA). La sesión de clave fiscal federa; navegamos directo y seguimos en esa página.
    if (typeof target === 'object' && target.url) {
      this.log(`Servicio "${nombre}": navegando directo a ${target.url}`);
      await page.goto(target.url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(2000);
      const desafio = await hayDesafio(page);
      if (desafio) throw new DesafioDeSeguridad(desafio);
      return page;
    }

    await page.goto(URL_PORTAL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);

    const clicYEsperar = async (locator) => {
      const [nueva] = await Promise.all([
        this.context.waitForEvent('page', { timeout: 15000 }).catch(() => null),
        locator.click(),
      ]);
      const destino = nueva ?? page;
      await destino.waitForLoadState('domcontentloaded');
      await destino.waitForLoadState('networkidle').catch(() => {});
      const desafio = await hayDesafio(destino);
      if (desafio) throw new DesafioDeSeguridad(desafio);
      return destino;
    };

    // Busca un clickeable visible cuyo texto coincida con algún término. Filtra en el navegador
    // con hasText (barato) y solo revisa las pocas coincidencias, en vez de recorrer todo el DOM.
    const buscarEn = async (frame, selector) => {
      for (const termino of terminos) {
        const cand = frame.locator(selector).filter({ hasText: termino });
        const n = Math.min(await cand.count(), 15);
        for (let i = 0; i < n; i++) {
          const it = cand.nth(i);
          if (!(await it.isVisible().catch(() => false))) continue;
          const texto = (await it.innerText().catch(() => '')) || '';
          if (coincideServicio(texto, terminos)) return it;
        }
      }
      return null;
    };
    // Primero elementos claramente clickeables; los <li> (tiles grandes) solo como último recurso.
    const buscarClickeable = async (frame) =>
      (await buscarEn(frame, 'a, button, [role=button], [role=option], [role=menuitem], [role=link]'))
      ?? (await buscarEn(frame, 'li'));

    // 1. enlace o tile directo en cualquier frame (p. ej. "Más utilizados").
    for (const frame of page.frames()) {
      const it = await buscarClickeable(frame);
      if (it) { this.log(`Servicio "${nombre}": encontrado directo en la página.`); return clicYEsperar(it); }
    }

    // 2. buscador: campo de texto visible y ancho; tipeamos cada término y buscamos una sugerencia.
    for (const frame of page.frames()) {
      const campos = frame.locator('input:not([type]), input[type="text"], input[type="search"], input[role="combobox"], textarea');
      const m = await campos.count();
      for (let i = 0; i < m; i++) {
        const c = campos.nth(i);
        if (!(await c.isVisible().catch(() => false))) continue;
        const box = await c.boundingBox();
        if (!box || box.width < 250) continue;
        for (const termino of terminos) {
          await c.fill('');
          await c.fill(termino);
          await page.waitForTimeout(1500); // el typeahead tarda en poblar
          const it = await buscarClickeable(frame);
          if (it) { this.log(`Servicio "${nombre}": vía buscador con "${termino}".`); return clicYEsperar(it); }
        }
      }
    }

    throw new Error(`No encontré "${nombre}" ni como enlace directo ni en el buscador (términos: ${terminos.join(', ')}). Corré portal:inspeccionar y revisá out/diagnostico/portal/resumen.txt.`);
  }
}
