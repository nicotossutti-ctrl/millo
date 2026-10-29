/**
 * CCMA (Cuenta corriente de autónomos y monotributistas, servicios2.afip.gob.ar/.../ccam/P02_ctacte.asp). Pantalla
 * vieja maquetada con tablas sin <th>: la fila de encabezados es una fila de celdas comunes, a veces debajo de un título.
 * Diagnóstico del 25/10: siete tablas (clases CabeceraTablaBorde y TablaAzul), campos perdesde2 / perhasta2 / feccalculo
 * y los botones CalDeud («Calcular deuda») y Pag_Princ («Pagar»).
 *
 * Corrida 2026-10-28T21-19-50: al abrir no hay grilla, solo el formulario «Recálculo de deuda a fecha» con los períodos
 * rotulados (MM/AAAA). Se completan los períodos y se toca SOLO «Calcular deuda» (calcularDeudaCcma); nunca Pag_Princ.
 * Lo leído va como «descargado» sin validar, con columnas sin confirmar, hasta ver las columnas reales: el relevamiento
 * guarda una muestra enmascarada de las primeras filas de cada tabla.
 */
const PALABRAS = [/per[ií]odo/, /venc/, /importe|monto/, /capital/, /inter[eé]s/, /saldo|deuda/, /pag(o|ad)/, /concepto|impuesto|obligaci/, /cuota/, /categor/];
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const PERIODO = /\b\d{2}\/\d{4}\b|\b\d{6}\b|\b\d{4}-\d{2}\b|\b\d{4}\/\d{2}\b/;

/** ¿Esta fila es de encabezados? Al menos dos palabras de columna distintas, una de ellas «período», en celdas cortas. */
export function esEncabezadoCcma(celdas) {
  const cortas = (celdas ?? []).map(norm).filter((c) => c && c.length <= 40);
  const hits = PALABRAS.filter((re) => cortas.some((c) => re.test(c)));
  return hits.length >= 2 && cortas.some((c) => /per[ií]odo/.test(c));
}

/**
 * La grilla de CCMA entre las tablas leídas ({ headers, rows } de extraerTablasEnDocumento). Pura. Devuelve { headers,
 * rows, totales } de la tabla con más filas de datos (filas con un período, debajo de la fila de encabezados y antes de
 * un «Total»), o null si ninguna tiene una fila de encabezados reconocible: nunca se inventan columnas.
 */
export function leerCcma(tablas) {
  let mejor = null;
  for (const t of tablas ?? []) {
    const todas = [t.headers ?? [], ...(t.rows ?? [])];
    const h = todas.findIndex(esEncabezadoCcma);
    if (h < 0) continue;
    const headers = todas[h].map((c) => String(c ?? '').trim());
    const rows = []; const totales = [];
    for (const f of todas.slice(h + 1)) {
      if (/^total/i.test(norm(f[0])) || (f.length < headers.length && f.some((c) => /^total/i.test(norm(c))))) { totales.push(f); continue; }
      if (esEncabezadoCcma(f)) break; // empieza otra grilla
      if (Math.abs(f.length - headers.length) > 1 || !f.some((c) => PERIODO.test(String(c ?? '')))) continue;
      rows.push(f);
    }
    if (!mejor || rows.length > mejor.rows.length) mejor = { headers, rows, totales };
  }
  return mejor;
}

const mmaaaa = (y, m) => `${String(m).padStart(2, '0')}/${y}`;
/**
 * Períodos del «Recálculo de deuda a fecha» (MM/AAAA, como lo rotula la pantalla): los doce meses que terminan en el mes
 * final de la corrida, para ver también la deuda o los pagos de meses anteriores. Pura.
 */
export function periodosCcma(periodo) {
  const [y, m] = periodo.hasta.slice(0, 7).split('-').map(Number);
  let y0 = y, m0 = m - 11; while (m0 < 1) { m0 += 12; y0 -= 1; }
  return { desde: mmaaaa(y0, m0), hasta: mmaaaa(y, m) };
}

/**
 * Consulta de la cuenta corriente (diagnóstico de la corrida 2026-10-28T21-19-50: al abrir, la pantalla solo muestra el
 * formulario «Recálculo de deuda a fecha», sin grilla). Completa «Período desde/hasta (MM/AAAA)» y, si está vacía, la
 * «Fecha de cálculo» (hoy), y toca SOLO «Calcular deuda» (CalDeud), que es una consulta. Nunca «Pagar» (Pag_Princ).
 * Devuelve { consultado, desde, hasta, fechaCalculo, motivo }.
 */
export async function calcularDeudaCcma(pagina, periodo, { log = () => {}, hoy = new Date() } = {}) {
  const { esProhibido } = await import('./extractor.js');
  const { desde, hasta } = periodosCcma(periodo);
  for (const f of pagina.frames()) {
    const d = f.locator('input[name="perdesde2"]'); const h = f.locator('input[name="perhasta2"]'); const fc = f.locator('input[name="feccalculo"]');
    const btn = f.locator('input[name="CalDeud"]');
    if (!(await d.count().catch(() => 0)) || !(await h.count().catch(() => 0)) || !(await btn.count().catch(() => 0))) continue;
    const texto = `${await btn.first().getAttribute('value').catch(() => '') ?? ''} ${await btn.first().getAttribute('title').catch(() => '') ?? ''}`.trim();
    // Hace falta una indicación POSITIVA de cálculo o consulta: un botón sin texto, o que solo dice «deuda», no se toca.
    if (esProhibido(texto) || !/calcul|consult/i.test(texto)) return { consultado: false, desde, hasta, motivo: `el botón CalDeud dice «${texto}»: no se confirma que sea la consulta, no se toca` };
    for (const [loc, v] of [[d, desde], [h, hasta]]) {
      await loc.first().fill(v);
      if ((await loc.first().inputValue().catch(() => '')) !== v) return { consultado: false, desde, hasta, motivo: `el campo de período no tomó ${v}` };
    }
    let fechaCalculo = await fc.first().inputValue().catch(() => '');
    if (!fechaCalculo && await fc.count().catch(() => 0)) {
      fechaCalculo = `${String(hoy.getDate()).padStart(2, '0')}/${String(hoy.getMonth() + 1).padStart(2, '0')}/${hoy.getFullYear()}`;
      await fc.first().fill(fechaCalculo).catch(() => {});
    }
    log(`  ccma: «Calcular deuda» de ${desde} a ${hasta}${fechaCalculo ? ` al ${fechaCalculo}` : ''} (consulta; «Pagar» no se toca).`);
    await btn.first().click();
    await pagina.waitForLoadState('networkidle').catch(() => {});
    await pagina.waitForTimeout(3000).catch(() => {});
    return { consultado: true, desde, hasta, fechaCalculo: fechaCalculo || null, boton: texto || 'CalDeud' };
  }
  return { consultado: false, desde, hasta, motivo: 'no está el formulario «Recálculo de deuda a fecha» (perdesde2 / perhasta2 / CalDeud)' };
}
