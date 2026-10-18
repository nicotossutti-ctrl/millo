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
    this.browser = await chromium.launch({ headless: !this.visible, slowMo: this.visible ? 50 : 0, executablePath: process.env.ARCA_CHROMIUM || undefined });
    const sesion = archivoSesion(this.cfg);
    const opts = { acceptDownloads: true, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', viewport: { width: 1366, height: 900 } };
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
   * la persona tipee la clave. Si hay CAPTCHA o segundo factor, se detiene.
   */
  async login() {
    const { page, cfg } = this;
    await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });
    if (await hayDesafio(page)) throw await this.detenerPorDesafio(await hayDesafio(page));

    await page.fill('#F1\\:username', cfg.cuit);
    await page.click('#F1\\:btnSiguiente');
    await page.waitForSelector('#F1\\:password', { state: 'attached', timeout: 20000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    const msg = await page.locator('#F1\\:msg').textContent().catch(() => '');
    if (msg && msg.trim() && !(await page.locator('#F1\\:password').count())) throw new Error(`ARCA rechazó el CUIT: ${msg.trim()}`);

    const desafio = await hayDesafio(page);
    if (desafio) throw await this.detenerPorDesafio(desafio);

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

    // Esperamos salir del dominio de login o un mensaje de error.
    const salida = await Promise.race([
      page.waitForURL((u) => !u.href.includes('auth.afip.gob.ar'), { timeout: this.visible ? 180000 : 45000 }).then(() => 'ok'),
      page.waitForSelector('#F1\\:msg:not(:empty)', { timeout: this.visible ? 180000 : 45000 }).then(() => 'msg'),
    ]).catch(() => 'timeout');

    if (salida === 'msg') {
      const err = (await page.locator('#F1\\:msg').textContent()) ?? '';
      if (await hayDesafio(page)) throw await this.detenerPorDesafio(await hayDesafio(page));
      throw new Error(`ARCA rechazó el ingreso: ${err.trim()}`);
    }
    if (salida === 'timeout') {
      const desafio = await hayDesafio(page);
      if (desafio) throw await this.detenerPorDesafio(desafio);
      throw new Error('El login no terminó a tiempo. Corré con --visible para ver qué muestra ARCA.');
    }
    await this.guardar();
    this.log('Sesión iniciada y guardada.');
  }

  async detenerPorDesafio(que) {
    if (this.visible) {
      this.log(`ARCA pidió una verificación (${que}). Resolvela a mano en la ventana; espero hasta 3 minutos.`);
      try {
        await this.page.waitForURL((u) => !u.href.includes('auth.afip.gob.ar'), { timeout: 180000 });
        await this.guardar();
        return null;
      } catch { /* cae al error */ }
    }
    return new DesafioDeSeguridad(que);
  }

  async asegurarLogin() {
    if (await this.estaLogueado()) { this.log('Sesión vigente.'); return; }
    this.log('Sin sesión vigente: iniciando login.');
    const err = await this.login();
    if (err) throw err;
  }

  /**
   * Abre un servicio del portal por nombre, usando el buscador. Los servicios abren en una
   * pestaña nueva; devolvemos esa página.
   */
  async abrirServicio(nombre) {
    const { page } = this;
    await page.goto(URL_PORTAL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    const buscador = page.locator('input[type="search"], input[placeholder*="Buscar" i], input[aria-label*="Buscar" i]').first();
    await buscador.waitFor({ timeout: 20000 });
    await buscador.fill(nombre);
    await page.waitForTimeout(1500);
    const resultado = page.locator(`a:has-text("${nombre}"), button:has-text("${nombre}"), [role="option"]:has-text("${nombre}"), li:has-text("${nombre}")`).first();
    await resultado.waitFor({ timeout: 20000 });
    const [nueva] = await Promise.all([
      this.context.waitForEvent('page', { timeout: 30000 }).catch(() => null),
      resultado.click(),
    ]);
    const destino = nueva ?? page;
    await destino.waitForLoadState('domcontentloaded');
    await destino.waitForLoadState('networkidle').catch(() => {});
    if (await hayDesafio(destino)) throw new DesafioDeSeguridad(await hayDesafio(destino));
    return destino;
  }
}
