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
 *   Cuentas: entra SOLO la cuenta de Mercado Libre cuyo CUIT es el del contribuyente de FiscalOS
 *   (responsable inscripto: importes sin IVA). La otra cuenta pertenece a otro CUIT (monotributo) y no
 *   se mezcla. La correspondencia cuenta ↔ CUIT se configura localmente (no va al repositorio).
 *   CMV: PFOS tiene la lista de costos (sin IVA) recién desde el 01/10/2026; meses anteriores, carga
 *   manual. Lectura prevista: usuario de base de SOLO LECTURA (docs/rentabilidad-DISENO.md de PFOS).
 *   Regla para no duplicar: los INGRESOS salen de la facturación (Mis Comprobantes); de PFOS se
 *   toman COSTOS y GASTOS. Si para un mes hay varias fuentes del mismo concepto, se usa una sola
 *   según la prioridad de rentabilidad.js (manual > importado > PFOS > ARCA) y se avisa si difieren.
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
