/**
 * Puntos de conexión de FiscalOS con otros sistemas. En V1 no hay ninguno activo: FiscalOS y PFOS
 * son aplicaciones independientes. Este módulo fija el CONTRATO para conectarlas más adelante sin
 * tocar el panel:
 *
 * PFOS (ventas reales de Mercado Libre, comisiones, publicidad, logística, costo de productos)
 *   obtenerPfos(mes) -> null | {
 *     mes: 'AAAA-MM',
 *     ventasNetas, costoMercaderia, comisiones, publicidad, logistica, otrosGastos,  // pesos, sin IVA
 *     fuente: 'PFOS', actualizado: ISO
 *   }
 *   Regla para no duplicar: los INGRESOS salen de la facturación (Mis Comprobantes); de PFOS se
 *   toman COSTOS y GASTOS. Si para un mes hay datos de PFOS e importados del mismo concepto, se usa
 *   uno solo (PFOS) y se avisa.
 *
 * Simulador de compras reales: hoy es un cálculo en la interfaz (crédito fiscal potencial y efecto
 * en caja de una compra real con factura). La versión completa usará este mismo panel como base.
 */
export function obtenerPfos() {
  return null; // V1: sin conexión.
}

export function integraciones(mes) {
  return {
    pfos: { conectado: false, datos: obtenerPfos(mes), nota: 'PFOS no está conectado: los costos y gastos se cargan con "Importar archivo".' },
  };
}
