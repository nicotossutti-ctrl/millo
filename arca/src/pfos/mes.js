/**
 * Foto FISCAL de un mes con los datos de PFOS (pura: recibe lo leído y los comprobantes de ARCA): la verificación de la
 * cuenta por CAE, las ventas del mes como control contra la facturación, las retenciones de Mercado Pago y la cobertura de
 * la recolección. No calcula costos ni rentabilidad: eso es de PFOS.
 */
import { ordenesDelMes, retencionesMes, vigentesConciliacion, diasCubiertos, corteDelMes, finDelMes } from './calculo.js';
import { clavesArca, comprobantesPfos, verificarCuenta } from './cuenta.js';

const r2 = (x) => Math.round(x * 100) / 100;

export function armarMes({ mes, datos, textosArca, generado = new Date().toISOString() }) {
  // Corte: el mes terminado, entero; el mes en curso, hasta ayer (lo posterior no es «atrasado»).
  const corte = corteDelMes(mes, generado);
  const mesCerrado = corte === finDelMes(mes);
  const { vigentes, canceladas, posteriores } = ordenesDelMes(datos.ordenes, mes, corte);

  // Cuenta: sus facturas a clientes tienen que estar en tus comprobantes emitidos de ARCA, con el mismo CAE.
  const concil = vigentesConciliacion(datos.conciliacion);
  const cuenta = verificarCuenta(comprobantesPfos(datos.facturas, concil.porFuente.comprobante ?? []), clavesArca(textosArca));

  const diasOrdenes = diasCubiertos(datos.alcances, 'orders', mes, corte);
  const diasCobros = diasCubiertos(datos.alcances, 'mp_payments', mes, corte);
  const ret = retencionesMes(vigentes, datos.cobros);
  const completas = corte != null && diasOrdenes.faltan.length === 0;

  return {
    mes, generado, corte, mesCerrado, cuenta,
    cobertura: { corte, ordenes: diasOrdenes, cobros: diasCobros, cobrosDeVentas: ret.cobertura,
      conciliacion: { conflictos: concil.conflictos, pendientes: concil.pendientes, provisionales: concil.provisionales } },
    ventas: { ordenes: vigentes.length, canceladas: canceladas.length, posterioresAlCorte: posteriores, completas,
      totalConIva: r2(vigentes.reduce((n, o) => n + (Number(o.data?.total_amount) || 0), 0)),
      nota: 'control contra la facturación de ARCA: las ventas de Mercado Libre con IVA, por fecha de venta; no reemplazan a los comprobantes emitidos' },
    retencionesMp: { importe: ret.total, porNombre: ret.porNombre, pagos: ret.pagos, cobertura: ret.cobertura,
      nota: 'retenciones que Mercado Pago hizo en los cobros de las ventas del mes: anticipos de impuestos (conciliar con IIBB y Mis Retenciones)' },
  };
}
