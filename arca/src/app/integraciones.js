/**
 * Puntos de conexión de FiscalOS con otros sistemas. En V1 no hay ninguno activo: FiscalOS y PFOS
 * son aplicaciones independientes. Este módulo fija el CONTRATO para conectarlas más adelante sin
 * tocar el panel:
 *
 * PFOS (Mercado Libre): `pfos:actualizar` lee la base de PFOS en SOLO LECTURA (docs/pfos-acceso.sql) y deja una foto por
 *   mes en out/pfos/AAAA-MM.json (src/pfos/). obtenerPfos(outDir, mes) devuelve los conceptos de esa foto
 *   ({ 'costo-mercaderia' | 'comisiones-ml' | 'logistica' | 'publicidad': { importe sin IVA, nivel, completo, faltan, nota } }),
 *   solo si la cuenta se verificó contra los comprobantes emitidos de ARCA del contribuyente.
 *   Cuentas: entra SOLO la cuenta de Mercado Libre del CUIT del contribuyente; la otra (otro CUIT) no existe para el rol.
 *   Regla para no duplicar: los INGRESOS salen de la facturación (Mis Comprobantes); de PFOS se toman COSTOS y GASTOS,
 *   con una sola fuente por concepto según la prioridad de rentabilidad.js; PFOS incompleto queda como referencia.
 *
 * Simulador de compras reales: hoy es un cálculo en la interfaz (crédito fiscal potencial y efecto
 * en caja de una compra real con factura). La versión completa usará este mismo panel como base.
 */
import { leerFoto } from '../pfos/fotos.js';

/**
 * Conceptos del mes según la foto de PFOS (out/pfos/AAAA-MM.json): { concepto: { importe, nivel, completo, faltan, nota,
 * generado } }. Vacío si no hay foto o si la cuenta NO se verificó contra los comprobantes emitidos de ARCA.
 */
export function obtenerPfos(outDir, mes) {
  const foto = outDir ? leerFoto(outDir, mes) : null;
  if (!foto || !foto.cuenta?.verificada) return {};
  return Object.fromEntries(Object.entries(foto.lineas ?? {}).map(([k, l]) => [k, { ...l, generado: foto.generado }]));
}

/** Estado de la conexión con PFOS para el mes (lo muestra la pestaña Rentabilidad). */
export function integraciones(outDir, mes) {
  const foto = outDir ? leerFoto(outDir, mes) : null;
  if (!foto) return { pfos: { conectado: false, nota: 'Sin datos de PFOS para este mes: corré «fiscalos.ps1 pfos -Periodo AAAA-MM» (necesita el acceso de solo lectura de docs/pfos-acceso.sql).' } };
  return { pfos: { conectado: true, verificada: !!foto.cuenta?.verificada, generado: foto.generado, cuenta: foto.cuenta, cobertura: foto.cobertura,
    ventas: foto.ventas, costo: foto.costo, cargos: foto.cargos, ads: foto.ads, reportes: foto.reportes, retencionesMp: foto.retencionesMp, lineas: foto.lineas } };
}
