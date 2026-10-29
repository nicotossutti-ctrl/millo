/**
 * SIFERE WEB – Consultas (Comisión Arbitral): los PAGOS realizados de Ingresos Brutos de Convenio Multilateral.
 *
 * Lo confirmado por la documentación oficial (ca.gob.ar, preguntas frecuentes «SIFERE WEB Consultas», RG CA 6/2012):
 * el módulo tiene tres opciones, «PADRON WEB», «SIFERE» y «DEDUCCIONES»; en «SIFERE» se consultan las DJ presentadas
 * y los pagos realizados, con exportación a Excel. Las pantallas internas NO se vieron todavía en una corrida (la del
 * 28/10 no cargó el sitio), así que no hay selectores: se sigue el menú por sus RÓTULOS y la grilla se reconoce por sus
 * columnas (fecha, importe, período). Si un paso no es inequívoco, no se hace clic y se informa el motivo.
 *
 * Solo lectura: nunca se toca nada que diga pagar, VEP, generar, volante, presentar, crear, rectificar ni eliminar.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { esProhibido } from './extractor.js';

const NO_TOCAR = /pagar|vep|generar|volante|presentar|crear|nueva|rectific|eliminar|borrar|modificar/i;
const seguro = (t) => !esProhibido(t) && !NO_TOCAR.test(t);
const limpio = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** ¿Este rótulo lleva a la consulta de pagos? «Pagos», «Consulta de pagos», «Pagos realizados»… nunca «Pagar». Pura. */
export function esRotuloPagos(texto) {
  const t = limpio(texto).toLowerCase();
  return seguro(t) && /^(consulta(s)? de )?pagos( realizados| efectuados| mensuales)?$/.test(t);
}

/** Controles visibles u ocultos (menús desplegables) cuyo texto cumple `test`, en todos los frames. */
async function controles(pagina, test) {
  const out = [];
  for (const frame of pagina.frames()) {
    const loc = frame.locator('a, button, [role=menuitem], [role=tab], input[type=button], input[type=submit]');
    const n = Math.min(await loc.count().catch(() => 0), 300);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      const txt = limpio((await el.innerText().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || (await el.getAttribute('title').catch(() => '')));
      if (txt && test(txt)) out.push({ el, txt, visible: await el.isVisible().catch(() => false) });
    }
  }
  return out;
}

async function clic(pagina, el) {
  const nav = pagina.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await el.click({ timeout: 5000 }).catch(() => el.evaluate((x) => x.click()));
  await nav; await pagina.waitForTimeout(2000).catch(() => {});
}

/**
 * Dentro del módulo: abre «SIFERE» (si el menú lo pide) y luego la consulta de «Pagos»; si la pantalla tiene un botón de
 * consulta («Consultar», «Buscar», «Aplicar», «Ver»), lo toca. Lanza un error con el motivo si no encuentra un único
 * control inequívoco: el orquestador lo registra y no se pisa lo guardado. Devuelve la descripción del recorrido.
 */
export async function irAPagosConsultas(pagina, { log = () => {} } = {}) {
  const recorrido = [];
  let pagos = await controles(pagina, esRotuloPagos);
  if (!pagos.length) {
    // Menú «SIFERE» del módulo (no el título de la página): solo si es un control con ese texto exacto.
    const menu = await controles(pagina, (t) => /^sifere$/i.test(t));
    if (menu.length === 1) { recorrido.push('menú «SIFERE»'); await clic(pagina, menu[0].el); pagos = await controles(pagina, esRotuloPagos); }
  }
  const unicos = [...new Map(pagos.map((p) => [p.txt.toLowerCase(), p])).values()];
  if (!unicos.length) throw new Error(`SIFERE Consultas: no se encontró la consulta de «Pagos»${recorrido.length ? ` (después del ${recorrido.join(', ')})` : ''}`);
  if (unicos.length > 1) throw new Error(`SIFERE Consultas: hay ${unicos.length} controles de pagos distintos (${unicos.map((p) => `«${p.txt}»`).join(', ')}): no se elige uno a ciegas`);
  const elegido = pagos.find((p) => p.visible) ?? pagos[0];
  recorrido.push(`«${elegido.txt}»`);
  log(`  sifere-consultas: abro ${recorrido.join(' > ')} (solo lectura).`);
  await clic(pagina, elegido.el);
  const consultar = await controles(pagina, (t) => /^(consultar|buscar|aplicar|ver)$/i.test(t) && seguro(t));
  const visibles = consultar.filter((c) => c.visible);
  if (visibles.length === 1) { recorrido.push(`«${visibles[0].txt}»`); await clic(pagina, visibles[0].el); }
  return `SIFERE Consultas: ${recorrido.join(' > ')}`;
}

/**
 * Exportación de la consulta (Excel), si la pantalla la ofrece: es el respaldo original de los pagos leídos. Se guarda
 * tal cual en out/importados/sifere-pagos/ (el mismo archivo no se guarda dos veces). Devuelve { archivo } o { motivo }.
 */
export async function guardarExportacionPagos(pagina, outDir, { mes, esperaMs = 20000 } = {}) {
  const exp = (await controles(pagina, (t) => /excel|exportar|descargar|xls/i.test(t) && seguro(t))).filter((c) => c.visible);
  if (exp.length !== 1) return { motivo: exp.length ? `hay ${exp.length} controles de exportación: no se elige uno` : 'la consulta no muestra exportación' };
  const [descarga] = await Promise.all([pagina.waitForEvent('download', { timeout: esperaMs }).catch(() => null), clic(pagina, exp[0].el)]);
  if (!descarga) return { motivo: 'la exportación no descargó un archivo' };
  const tmp = await descarga.path().catch(() => null);
  if (!tmp) return { motivo: 'no se pudo leer el archivo exportado' };
  const buf = fs.readFileSync(tmp);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const ext = (path.extname(descarga.suggestedFilename?.() ?? '') || '.xls').toLowerCase().replace(/[^.a-z0-9]/g, '');
  const dir = path.join(outDir, 'importados', 'sifere-pagos');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const archivo = path.join(dir, `${mes ?? 'pagos'}-${hash.slice(0, 12)}${ext}`);
  if (!fs.existsSync(archivo)) fs.writeFileSync(archivo, buf, { mode: 0o600 });
  return { archivo: path.relative(outDir, archivo), hash };
}
