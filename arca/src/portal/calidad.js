/**
 * Validación de lo extraído (pura, sin red ni disco). Llegar a una pantalla o leer "una tabla" no
 * es éxito: cada sección tiene que mostrar SUS columnas (se contrastan los encabezados reales), el
 * período tiene que estar confirmado (o declararse acumulado), la paginación tiene que terminar de
 * forma natural y, si la consulta filtra por fecha, todas las filas tienen que tener fecha
 * interpretable dentro del rango. Ver evaluarCalidad para los tres niveles.
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

/** Columnas obligatorias que NO aparecen en los encabezados reales (comparación sin acentos ni mayúsculas, por inclusión). */
export function columnasFaltantes(encabezados, requeridas) {
  const hn = (encabezados ?? []).map(norm).filter(Boolean);
  return (requeridas ?? []).filter((r) => !hn.some((h) => h.includes(norm(r))));
}

/** ¿Los encabezados son los de una grilla que la sección NO busca? true si TODOS los términos de `rechazar` aparecen. */
export function esGrillaAjena(encabezados, rechazar) {
  if (!rechazar?.length || !encabezados?.length) return false;
  return columnasFaltantes(encabezados, rechazar).length === 0;
}

/**
 * Evalúa una extracción contra lo que la sección declara y la clasifica en uno de tres niveles,
 * que es lo que distingue sin ambigüedad qué se puede usar:
 *
 *   'obtenido'  hay filas leídas, pero algún control falló o no se pudo hacer: es EVIDENCIA, se
 *               guarda como intento y nunca pasa a los datos vigentes.
 *   'validado'  la grilla es la de esta fuente (encabezados reales con todas las columnas
 *               obligatorias, no es una grilla rechazada), la paginación terminó de forma natural
 *               (sin control "siguiente"), ningún total la contradice y, si la consulta filtra por
 *               período, el rango quedó confirmado en pantalla y TODAS las filas tienen fecha
 *               interpretable dentro del rango (con la columna de fecha declarada por la sección).
 *               Un cero solo se valida si la grilla propia está presente y vacía.
 *   'apto'      validado y, además, la cantidad está cotejada contra el total que ARCA informa en
 *               el paginador (o es un cero validado). Es lo único apto para usar en cálculos.
 *
 * `rechazada`: el que llama ya detectó que la grilla es ajena. También se detecta acá con
 * `servicio.rechazarSiColumnas`, para que el control final no dependa de pasos anteriores.
 */
export function evaluarCalidad(servicio, extraccion, { desde, hasta, rechazada = false } = {}) {
  const motivos = [];
  const filas = extraccion?.filas ?? 0;
  const encabezados = extraccion?.columnas ?? extraccion?.encabezadosGrilla ?? [];
  const requeridas = servicio?.columnasEsperadas ?? [];
  const faltan = columnasFaltantes(encabezados, requeridas);

  // 1. Identidad de la fuente y columnas: se contrastan los ENCABEZADOS REALES.
  let columnas;
  if (extraccion?.id && servicio?.id && extraccion.id !== servicio.id) columnas = 'otra-fuente';
  else if (rechazada || esGrillaAjena(encabezados, servicio?.rechazarSiColumnas)) columnas = 'rechazadas';
  else if (!encabezados.length) columnas = 'sin-encabezados';
  else if (!requeridas.length) columnas = 'sin-confirmar';
  else if (faltan.length) columnas = 'no-coinciden';
  else columnas = 'confirmadas';
  // Para el informe: solo encabezados cortos (los de maquetación traen nombre, domicilio, etc.).
  const cortos = encabezados.filter((h) => h && h.length <= 40).slice(0, 12);
  const leidos = encabezados.length ? ` (encabezados leídos: ${cortos.length ? cortos.join(' / ') : 'solo textos largos de maquetación'})` : '';
  if (columnas === 'otra-fuente') motivos.push(`la extracción es de otra fuente (${extraccion.id}), no de ${servicio.id}`);
  if (columnas === 'rechazadas') motivos.push(`la grilla leída no es la de esta sección: tiene las columnas de otra pantalla${leidos}`);
  if (columnas === 'sin-encabezados' && (filas || extraccion?.ceroConfirmado)) motivos.push('la grilla no tiene encabezados: no se puede comprobar que sea la de esta sección');
  if (columnas === 'sin-confirmar') motivos.push(`la sección todavía no tiene columnas obligatorias confirmadas${leidos}`);
  if (columnas === 'no-coinciden') motivos.push(`faltan columnas obligatorias: ${faltan.join(', ')}${leidos}`);

  // 2. Paginación: solo un fin NATURAL demuestra que se leyó todo. Excepción acotada: si el
  // "siguiente" no avanzó (página repetida) pero el total que ARCA informa en el PAGINADOR coincide
  // con las filas leídas (sin duplicar), el listado está completo por cotejo independiente: hay
  // paginadores que no deshabilitan "siguiente" en la última página (Mis Facilidades, 14 de 14).
  const fin = extraccion?.finPaginacion ?? null;
  const completoPorTotal = fin === 'pagina-repetida' && extraccion?.totalFuente === 'paginador' && extraccion?.informados === filas;
  const paginacion = !filas ? 'no-aplica' : (fin === 'sin-siguiente' || completoPorTotal) ? 'completa' : 'incompleta';
  if (paginacion === 'incompleta') {
    motivos.push(fin === 'tope' ? `la paginación llegó al tope de seguridad (${extraccion.paginas} páginas): puede faltar el final`
      : fin === 'pagina-repetida' ? 'el "siguiente" no avanzó (página repetida): puede ser una falla de navegación, no el final del listado'
      : fin === 'grilla-desaparecio' ? 'al pasar de página la grilla desapareció: no se sabe si se leyó todo'
      : 'no hay dato de cómo terminó la paginación');
  }

  // 3. Total: solo el del paginador de ARCA es un cotejo independiente (y solo él puede contradecir la
  // cantidad). El de "la única tabla visible" se toma tras paginar (ve la última página): no cuenta.
  const informados = extraccion?.informados ?? null;
  const total = extraccion?.totalFuente === 'paginador' ? (informados === filas ? 'coincide' : 'no-coincide')
    : informados != null ? 'no-independiente' : 'no-informado';
  if (total === 'no-coincide') motivos.push(`filas ${filas} ≠ total informado por ARCA ${informados}`);

  // 4. Período y fechas. Con filtro de período, la validación temporal exige rango confirmado y
  // TODAS las filas con fecha interpretable dentro del rango, según la columna declarada.
  const periodo = !extraccion?.conFiltroPeriodo ? 'acumulado' : extraccion?.rangoOk === true ? 'confirmado' : 'sin-confirmar';
  if (periodo === 'sin-confirmar') motivos.push('se filtró por fecha pero no se confirmó el rango aplicado en la pantalla');
  const fechas = extraccion?.fechas ?? { verificado: false, motivo: 'la sección no declara su columna de fecha' };
  let temporal = 'no-aplica';
  if (periodo !== 'acumulado' && filas) {
    if (!fechas.verificado) { temporal = 'no-verificada'; motivos.push(`no se pudo verificar las fechas de las filas: ${fechas.motivo}`); }
    else if (fechas.fueraDeRango || fechas.sinFecha) {
      temporal = 'fallida';
      if (fechas.fueraDeRango) motivos.push(`${fechas.fueraDeRango} fila(s) con fecha fuera del rango ${desde} a ${hasta}`);
      if (fechas.sinFecha) motivos.push(`${fechas.sinFecha} fila(s) sin fecha interpretable en "${fechas.columna}"`);
    } else temporal = 'verificada';
  }

  const cero = !filas && extraccion?.ceroConfirmado === true;
  const validado = filas > 0
    ? columnas === 'confirmadas' && paginacion === 'completa' && total !== 'no-coincide'
      && (periodo === 'acumulado' || (periodo === 'confirmado' && temporal === 'verificada'))
    : cero && columnas === 'confirmadas' && periodo !== 'sin-confirmar';
  const apto = validado && (cero || total === 'coincide');
  if (validado && !apto) motivos.push('validado, pero sin total de ARCA en el paginador para cotejar la cantidad: no apto para cálculos');
  const nivel = apto ? 'apto' : validado ? 'validado' : filas > 0 ? 'obtenido' : 'sin-datos';
  return { nivel, validado, apto, exito: validado, columnas, faltan, paginacion, total, periodo, temporal, fechas, motivos };
}

/**
 * Estado del informe de una corrida a partir de la calidad: 'validado'; 'descargado' (filas de la
 * sección, con columnas confirmadas, pero algún otro control falló); 'con-datos' (hay filas pero no
 * se probó que sean de esta sección: no se cuentan como sus datos). null: sin filas, decide el que llama.
 */
export function estadoInforme(calidad, filas) {
  if (calidad?.validado) return 'validado';
  if (!filas) return null;
  return calidad?.columnas === 'confirmadas' ? 'descargado' : 'con-datos';
}
