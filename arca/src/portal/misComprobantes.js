/**
 * Mis Comprobantes: descarga de emitidos y recibidos por rango de fechas (hasta 365 días por
 * consulta) usando la exportación del propio servicio.
 *
 * ESTADO: escrito sobre la estructura conocida del servicio (formulario de filtros con rango de
 * fechas y botón de exportación). Los selectores se confirman con `portal:diagnostico`; hasta
 * entonces este extractor se considera NO VERIFICADO y lo dice en su resultado.
 */
import fs from 'node:fs';
import path from 'node:path';

const fechaArca = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

function rangos(desde, hasta, maxDias = 365) {
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

async function primeroVisible(page, selectores, timeout = 15000) {
  const fin = Date.now() + timeout;
  while (Date.now() < fin) {
    for (const sel of selectores) {
      const loc = page.locator(sel).first();
      if (await loc.count() && await loc.isVisible().catch(() => false)) return loc;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`No encontré ninguno de: ${selectores.join(' | ')}. Corré portal:diagnostico y ajustá los selectores.`);
}

export async function descargarMisComprobantes(sesion, { tipo, desde, hasta, outDir = 'out/portal', log = () => {} }) {
  if (!['emitidos', 'recibidos'].includes(tipo)) throw new Error('tipo debe ser emitidos o recibidos');
  fs.mkdirSync(outDir, { recursive: true });
  const pagina = await sesion.abrirServicio('Mis Comprobantes');
  const resultado = { tipo, desde, hasta, archivos: [], verificado: false, advertencias: ['Extractor no verificado contra la pantalla real: validar el primer archivo a mano.'] };

  // Si el servicio pide elegir la persona representada, elegimos el propio CUIT.
  const propio = pagina.locator(`text=${sesion.cfg.cuit}`).first();
  if (await propio.count()) await propio.click().catch(() => {});

  for (const [d, h] of rangos(desde, hasta)) {
    log(`Mis Comprobantes ${tipo} ${d} a ${h}`);
    const boton = await primeroVisible(pagina, [
      tipo === 'emitidos' ? 'a:has-text("Emitidos"), button:has-text("Emitidos"), [id*="emitidos" i]' : 'a:has-text("Recibidos"), button:has-text("Recibidos"), [id*="recibidos" i]',
    ]);
    await boton.click();
    const campoFecha = await primeroVisible(pagina, ['#fechaEmision', 'input[name*="fechaEmision" i]', 'input[id*="fecha" i]', 'input[placeholder*="/" i]']);
    await campoFecha.fill(`${fechaArca(d)} - ${fechaArca(h)}`);
    await pagina.keyboard.press('Escape').catch(() => {});
    const buscar = await primeroVisible(pagina, ['#buscarComprobantes', 'button:has-text("Buscar")', 'input[type="submit"][value*="Buscar" i]']);
    await buscar.click();
    await pagina.waitForLoadState('networkidle').catch(() => {});
    const sinDatos = await pagina.locator('text=/No se encontraron|sin resultados|no hay comprobantes/i').count();
    if (sinDatos) { log('  sin comprobantes en el rango'); continue; }
    const exportar = await primeroVisible(pagina, ['a:has-text("CSV")', 'button:has-text("CSV")', 'a:has-text("Exportar")', 'button:has-text("Exportar")', 'a:has-text("Excel")', 'button:has-text("Excel")']);
    const [descarga] = await Promise.all([pagina.waitForEvent('download', { timeout: 120000 }), exportar.click()]);
    const nombre = `mis-comprobantes-${tipo}-${d}-${h}${path.extname(descarga.suggestedFilename()) || '.csv'}`;
    const destino = path.join(outDir, nombre);
    await descarga.saveAs(destino);
    resultado.archivos.push(destino);
    log(`  -> ${destino}`);
  }
  if (pagina !== sesion.page) await pagina.close().catch(() => {});
  return resultado;
}
