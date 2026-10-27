/**
 * Puntos de conexión de FiscalOS con otros sistemas. En V1 no hay ninguno activo: FiscalOS y PFOS
 * son aplicaciones independientes. Este módulo fija el CONTRATO para conectarlas más adelante sin
 * tocar el panel:
 *
 * PFOS (Mercado Libre): `pfos:actualizar` lee la base de PFOS en SOLO LECTURA (docs/pfos-acceso.sql) y deja una foto por
 *   mes en out/pfos/AAAA-MM.json (src/pfos/). obtenerPfos(outDir, mes) devuelve los conceptos de esa foto
 *   ({ 'costo-mercaderia' | 'comisiones-ml' | 'logistica' | 'publicidad': { importe sin IVA, nivel, completo, faltan, nota } }),
 *   solo si la cuenta se verificó contra los comprobantes emitidos de ARCA del contribuyente (en el mes, o en otro mes con la
 *   misma cuenta: entonces es «provisoria» y la conciliación fiscal del mes queda pendiente).
 *   Cuentas: entra SOLO la cuenta de Mercado Libre del CUIT del contribuyente; la otra (otro CUIT) no existe para el rol.
 *   Regla para no duplicar: los INGRESOS salen de la facturación (Mis Comprobantes); de PFOS se toman COSTOS y GASTOS,
 *   con una sola fuente por concepto según la prioridad de rentabilidad.js; PFOS incompleto queda como referencia.
 *
 * Simulador de compras reales: hoy es un cálculo en la interfaz (crédito fiscal potencial y efecto
 * en caja de una compra real con factura). La versión completa usará este mismo panel como base.
 */
import { leerFoto, leerFotos } from '../pfos/fotos.js';
import { titularidad } from '../pfos/cuenta.js';
import { compararAlCorte } from '../pfos/comparar.js';

const mesAnterior = (mes) => { const [y, m] = mes.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

/** La foto del mes y su titularidad (verificada por CAE en el mes, o provisoria por otro mes verificado de la misma cuenta). */
export function fotoUsable(outDir, mes) {
  const foto = outDir ? leerFoto(outDir, mes) : null;
  if (!foto) return { foto: null, titularidad: null };
  return { foto, titularidad: titularidad(foto, leerFotos(outDir)) };
}

/**
 * Conceptos del mes según la foto de PFOS (out/pfos/AAAA-MM.json): { concepto: { importe, nivel, completo, faltan, nota,
 * generado, alCorte, mesCerrado, provisoria } }. Vacío si no hay foto o si la titularidad no se pudo establecer (ni en el
 * mes ni en otro mes verificado por CAE con la misma cuenta). Con `ventas: true` agrega las ventas del mes según PFOS
 * (con IVA), para la rentabilidad operativa provisoria del mes en curso.
 */
export function obtenerPfos(outDir, mes) {
  const { foto, titularidad: t } = fotoUsable(outDir, mes);
  if (!foto || !t.usable) return {};
  const extra = { generado: foto.generado, alCorte: foto.corte ?? null, mesCerrado: foto.mesCerrado ?? true, provisoria: t.provisoria };
  const out = Object.fromEntries(Object.entries(foto.lineas ?? {}).map(([k, l]) => [k, { ...l, ...extra }]));
  Object.defineProperty(out, 'ventas', { value: { ...foto.ventas, ...extra }, enumerable: false });
  return out;
}

/** Estado de la conexión con PFOS para el mes (lo muestra la pestaña Rentabilidad). */
export function integraciones(outDir, mes) {
  const { foto, titularidad: t } = fotoUsable(outDir, mes);
  if (!foto) return { pfos: { conectado: false, nota: 'Sin datos de PFOS para este mes: corré «fiscalos.ps1 pfos -Periodo AAAA-MM» (necesita el acceso de solo lectura de docs/pfos-acceso.sql).' } };
  const previa = leerFoto(outDir, mesAnterior(mes));
  return { pfos: { conectado: true, verificada: !!foto.cuenta?.verificada, usable: t.usable, provisoria: t.provisoria, titularidad: t,
    conciliacionFiscal: t.conciliacionFiscal, generado: foto.generado, corte: foto.corte ?? null, mesCerrado: foto.mesCerrado ?? true,
    cuenta: foto.cuenta, cobertura: foto.cobertura, ventas: foto.ventas, costo: foto.costo, cargos: foto.cargos, ads: foto.ads, reportes: foto.reportes,
    retencionesMp: foto.retencionesMp, lineas: foto.lineas,
    comparacion: previa ? compararAlCorte(foto, previa) : { motivo: `no hay foto de PFOS de ${mesAnterior(mes)} para comparar` } } };
}
