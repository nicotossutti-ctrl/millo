/**
 * Modo diagnóstico: entra a cada servicio del portal y guarda captura, HTML y las URLs de red
 * en out/diagnostico/<servicio>/. Con eso se escriben los selectores exactos de cada extractor
 * sin adivinar. No descarga datos fiscales: solo la estructura de las pantallas.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SERVICIOS = [
  'Mis Comprobantes',
  'Portal IVA',
  'Mis Retenciones',
  'Sistema de Cuentas Tributarias',
  'Presentación de DDJJ y Pagos',
  'CCMA - Cuenta Corriente de Monotributistas y Autónomos',
  'Convenio Multilateral – SIFERE WEB - DDJJ',
  'Convenio Multilateral - SIFERE WEB - Consultas',
  'Mis Aplicaciones Web',
  'Ventanilla Electrónica',
];

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

export async function diagnosticar(sesion, { servicios = SERVICIOS, outDir = 'out/diagnostico', log = () => {} } = {}) {
  const resumen = [];
  for (const nombre of servicios) {
    const dir = path.join(outDir, slug(nombre));
    fs.mkdirSync(dir, { recursive: true });
    const red = [];
    const onReq = (req) => red.push({ method: req.method(), url: req.url(), type: req.resourceType() });
    sesion.context.on('request', onReq);
    const item = { servicio: nombre, ok: false, url: null, error: null };
    try {
      const pagina = await sesion.abrirServicio(nombre);
      await pagina.waitForTimeout(3000);
      item.url = pagina.url();
      await pagina.screenshot({ path: path.join(dir, 'pantalla.png'), fullPage: true });
      fs.writeFileSync(path.join(dir, 'pagina.html'), await pagina.content());
      // formularios, inputs, botones y links: lo que hace falta para escribir selectores
      const estructura = await pagina.evaluate(() => {
        const q = (sel) => [...document.querySelectorAll(sel)].slice(0, 300).map((e) => ({
          tag: e.tagName.toLowerCase(), id: e.id || null, name: e.getAttribute('name'), type: e.getAttribute('type'),
          text: (e.innerText || e.value || '').trim().slice(0, 80) || null, href: e.getAttribute('href'), cls: e.className?.toString().slice(0, 80) || null,
        }));
        return { title: document.title, forms: q('form'), inputs: q('input, select, textarea'), botones: q('button, input[type=submit], a.btn, [role=button]'), links: q('a[href]'), iframes: q('iframe') };
      });
      fs.writeFileSync(path.join(dir, 'estructura.json'), JSON.stringify(estructura, null, 2));
      item.ok = true;
      if (pagina !== sesion.page) await pagina.close();
    } catch (e) {
      item.error = e.message;
      await sesion.page.screenshot({ path: path.join(dir, 'error.png'), fullPage: true }).catch(() => {});
    } finally {
      sesion.context.off('request', onReq);
      fs.writeFileSync(path.join(dir, 'red.json'), JSON.stringify(red.filter((r) => !/\.(png|jpg|gif|css|woff2?|svg|ico)(\?|$)/.test(r.url)), null, 2));
    }
    log(`${item.ok ? 'OK ' : 'ERR'} ${nombre}${item.error ? `: ${item.error}` : ''}`);
    resumen.push(item);
  }
  fs.writeFileSync(path.join(outDir, 'resumen.json'), JSON.stringify(resumen, null, 2));
  return resumen;
}
