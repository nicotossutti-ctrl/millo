/**
 * CCMA (Cuenta corriente de autónomos y monotributistas, servicios2.afip.gob.ar/.../ccam/P02_ctacte.asp). Pantalla
 * vieja maquetada con tablas sin <th>: la fila de encabezados es una fila de celdas comunes, a veces debajo de un título.
 * Diagnóstico del 25/10: siete tablas (clases CabeceraTablaBorde y TablaAzul), campos perdesde2 / perhasta2 / feccalculo
 * y los botones CalDeud («Calcular deuda») y Pag_Princ («Pagar»).
 *
 * Solo LEE lo que la pantalla muestra al abrir: no completa campos (su formato no está confirmado) ni hace clic en
 * ningún botón; nunca en Pag_Princ. Lo leído va como «descargado» sin validar, con columnas sin confirmar, hasta ver las
 * columnas reales: el relevamiento guarda una muestra enmascarada de las primeras filas de cada tabla.
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
