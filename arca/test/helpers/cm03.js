/**
 * Reporte CM03 SINTÉTICO (sin datos reales) con la forma del de SIFERE: carátula, tabla «Jurisdicciones incluidas» con
 * los títulos en dos renglones, fila TOTALES, «Total a pagar» y una página de «Determinación del anticipo». Se convierte
 * a PDF con el navegador de las pruebas.
 */
const ar = (n) => (n < 0 ? '-' : '') + Math.abs(n).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

export function htmlCm03({ periodo = '202609', rectificativa = 0, estado = 'PRESENTADA', fecha = '15/10/2026 10:20:30', filas, totales = null, totalAPagar = null,
  detalle = null, quitarColumna = null } = {}) {
  const cols = ['Anticipo Impuesto<br>Determinado', 'Valores<br>Restan', 'Valores<br>Suman', 'A Favor<br>Contribuyente', 'A Favor<br>Fisco', 'A<br>Pagar'];
  const campos = ['determinado', 'restan', 'suman', 'aFavorContribuyente', 'aFavorFisco', 'aPagar'];
  const tot = totales ?? Object.fromEntries(campos.map((c) => [c, filas.reduce((n, f) => n + f[c], 0)]));
  const celda = (v) => `<td class="n">${v == null ? '' : ar(v)}</td>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: Helvetica, Arial, sans-serif; font-size: 9pt; } table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #999; padding: 3px 4px; } th { text-align: center; } td.n { text-align: right; } .salto { page-break-before: always; }
  </style></head><body>
    <h3>Comisión Arbitral del Convenio Multilateral - SIFERE WEB</h3>
    <p>Declaración Jurada Mensual - CM03</p>
    <p>Período: ${periodo}</p>
    <p>${rectificativa ? `Rectificativa: ${rectificativa}` : 'Original'}</p>
    <p>Estado: ${estado}</p>
    <p>Fecha de Presentación: ${fecha}</p>
    <h4>Jurisdicciones incluidas</h4>
    <table><thead><tr><th>Jurisdicción</th>${cols.filter((_, i) => i !== quitarColumna).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>
    ${filas.map((f) => `<tr><td>${f.jurisdiccion}</td>${campos.filter((_, i) => i !== quitarColumna).map((c) => celda(f[c])).join('')}</tr>`).join('')}
    <tr><td>TOTALES</td>${campos.filter((_, i) => i !== quitarColumna).map((c) => celda(tot[c])).join('')}</tr>
    </tbody></table>
    <p>Total a pagar: $ ${ar(totalAPagar ?? tot.aPagar)}</p>
    ${detalle ? `<div class="salto"><h4>Determinación del anticipo - ${detalle.jurisdiccion}</h4><table>${detalle.conceptos.map(([t, v]) => `<tr><td>${t}</td><td class="n">${ar(v)}</td></tr>`).join('')}</table></div>` : ''}
  </body></html>`;
}

/** PDF de ese HTML con Chromium (null si no hay navegador). */
export async function pdfDeHtml(html) {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { return null; }
  let b;
  try { b = await chromium.launch(process.env.FISCALOS_CHROMIUM ? { executablePath: process.env.FISCALOS_CHROMIUM } : {}); } catch { return null; }
  try { const pg = await b.newPage(); await pg.setContent(html); return await pg.pdf({ format: 'A4', printBackground: false }); } finally { await b.close(); }
}
