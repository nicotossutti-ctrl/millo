/**
 * Validación de lo extraído (pura, sin red ni disco). Llegar a una pantalla o leer "una tabla" no
 * es éxito: cada sección tiene que mostrar SUS columnas, el período tiene que estar confirmado (o
 * declararse acumulado), la paginación tiene que terminar de forma verificable y, si la sección
 * filtra por fecha y declara su columna de fecha, las filas tienen que caer dentro del rango.
 */
// Mismo criterio que extractor.norm; se repite acá para que extractor.js pueda importar este módulo sin ciclo.
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** dd/mm/aaaa, aaaa-mm-dd o dd-mm-aaaa (con hora opcional) -> 'aaaa-mm-dd'; null si no es fecha. */
export function fechaIso(texto) {
  const s = String(texto ?? '').trim();
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?!\d)/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/**
 * Cuenta cuántas filas caen dentro / fuera del rango según la columna de fecha declarada por la
 * sección (`columna`, comparada sin acentos ni mayúsculas contra los encabezados). Sin columna
 * declarada o sin encabezado que coincida, devuelve verificado=false: no se adivina cuál fecha
 * corresponde al filtro (una grilla puede tener Fecha de Presentación, de Pago, de Vencimiento…).
 */
export function verificarFechas(headers, filas, desde, hasta, columna) {
  if (!columna) return { verificado: false, motivo: 'la sección no declara su columna de fecha' };
  const i = (headers ?? []).map(norm).findIndex((h) => h.includes(norm(columna)));
  if (i < 0) return { verificado: false, motivo: `no se encontró la columna de fecha "${columna}" en los encabezados` };
  let enRango = 0, fueraDeRango = 0, sinFecha = 0;
  for (const f of filas ?? []) {
    const iso = fechaIso(f[i]);
    if (!iso) { sinFecha++; continue; }
    if (iso >= desde && iso <= hasta) enRango++; else fueraDeRango++;
  }
  return { verificado: true, columna: headers[i], enRango, fueraDeRango, sinFecha };
}

/** Conteo de valores de las columnas de estado (Estado, Resultado, Situación). Para distinguir, p. ej., un VEP generado de un pago acreditado sin interpretarlo nosotros. */
export function resumenEstados(headers, filas) {
  const out = {};
  (headers ?? []).forEach((h, i) => {
    if (!/^(estado|resultado|situacion)\b/.test(norm(h))) return;
    const c = {};
    for (const f of filas ?? []) { const v = String(f[i] ?? '').trim() || '(vacío)'; c[v] = (c[v] ?? 0) + 1; }
    out[h] = c;
  });
  return out;
}

/**
 * Evalúa una extracción contra lo que la sección declara. Devuelve los chequeos y `exito`, que es
 * lo único que habilita contar la fuente como descargada. `rechazada`: la grilla leída es una que
 * la sección NO busca (p. ej. Vencimientos de la home de Cuentas Tributarias).
 */
export function evaluarCalidad(servicio, extraccion, { desde, hasta, rechazada = false } = {}) {
  const motivos = [];
  const filas = extraccion?.filas ?? 0;
  const declaradas = (servicio?.columnasEsperadas ?? []).length > 0;
  const columnas = rechazada ? 'rechazadas' : !filas ? 'sin-filas' : declaradas ? 'confirmadas' : 'sin-confirmar';
  if (columnas === 'rechazadas') motivos.push('la grilla leída no es la de esta sección (columnas de otra pantalla)');
  if (columnas === 'sin-confirmar') motivos.push('se leyó una grilla, pero la sección todavía no tiene columnas propias confirmadas: no cuenta como dato validado');

  const periodo = !extraccion?.conFiltroPeriodo ? 'acumulado'
    : extraccion?.rangoOk === true ? 'confirmado' : 'sin-confirmar';
  if (periodo === 'sin-confirmar') motivos.push('se filtró por fecha pero no se confirmó el rango aplicado en la pantalla');

  const fin = extraccion?.finPaginacion ?? null;
  const paginacion = fin === 'tope' ? 'incompleta' : fin ? 'completa' : 'sin-dato';
  if (paginacion === 'incompleta') motivos.push(`la paginación llegó al tope de seguridad (${extraccion.paginas} páginas): puede faltar el final`);

  const informados = extraccion?.informados ?? null;
  const total = informados == null ? 'no-informado' : informados === filas ? 'coincide' : 'no-coincide';
  if (total === 'no-coincide') motivos.push(`filas ${filas} ≠ total informado por ARCA ${informados}`);

  // El extractor ya contó las fechas (tiene las filas); acá solo se juzga.
  const fechas = extraccion?.fechas ?? { verificado: false, motivo: extraccion?.conFiltroPeriodo ? 'fechas no verificadas' : 'sin filtro de período' };
  if (fechas.verificado && fechas.fueraDeRango) motivos.push(`${fechas.fueraDeRango} fila(s) con fecha fuera del rango ${desde} a ${hasta}`);

  const exito = filas > 0 && columnas === 'confirmadas' && paginacion !== 'incompleta' && total !== 'no-coincide'
    && periodo !== 'sin-confirmar' && !(fechas.verificado && fechas.fueraDeRango);
  return { exito, columnas, periodo, paginacion, total, fechas, motivos };
}
