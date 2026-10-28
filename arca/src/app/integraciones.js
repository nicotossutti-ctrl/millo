/**
 * Conexión de FiscalOS con PFOS (Mercado Libre). FiscalOS es impositivo: de PFOS toma solo lo fiscal, de las fotos que
 * deja `pfos:actualizar` (out/pfos/AAAA-MM.json):
 *  - la verificación de que la cuenta de Mercado Libre es del CUIT (CAE de sus facturas en tus comprobantes emitidos);
 *  - las ventas del mes con IVA, como CONTROL contra la facturación de ARCA (no la reemplazan);
 *  - las retenciones que Mercado Pago hizo en los cobros (anticipos de impuestos, para conciliar).
 * Costos, comisiones, publicidad, logística y rentabilidad son de PFOS. Para proyectar Ganancias, FiscalOS recibe el
 * resultado comercial de cada mes ya calculado por PFOS (concepto «resultado-comercial»).
 * Cuentas: entra SOLO la cuenta de Mercado Libre del CUIT del contribuyente; la otra (otro CUIT) no existe para el rol.
 */
import path from 'node:path';
import { leerFoto, leerFotos } from '../pfos/fotos.js';
import { titularidad } from '../pfos/cuenta.js';
import { comprobantesMes } from './comprobantes.js';

const r2 = (x) => Math.round(x * 100) / 100;

/** La foto del mes y su titularidad (verificada por CAE en el mes, o por otro mes verificado de la misma cuenta). */
export function fotoUsable(outDir, mes) {
  const foto = outDir ? leerFoto(outDir, mes) : null;
  if (!foto) return { foto: null, titularidad: null };
  return { foto, titularidad: titularidad(foto, leerFotos(outDir)) };
}

/** Conciliación fiscal con PFOS para el mes (bloque de la pestaña Impuestos). */
export function integraciones(outDir, mes) {
  const { foto, titularidad: t } = fotoUsable(outDir, mes);
  if (!foto) return { pfos: { conectado: false, nota: 'Sin datos de PFOS para este mes: corré «fiscalos.ps1 pfos -Periodo AAAA-MM» (necesita el acceso de solo lectura de docs/pfos-acceso.sql).' } };
  const base = { conectado: true, verificada: !!foto.cuenta?.verificada, usable: t.usable, titularidad: t, conciliacionFiscal: t.conciliacionFiscal,
    generado: foto.generado, corte: foto.corte ?? null, mesCerrado: foto.mesCerrado ?? true, cuenta: foto.cuenta };
  if (!t.usable) return { pfos: base }; // cuenta sin verificar: sus datos no se muestran
  const em = comprobantesMes(path.join(outDir, 'datos'), 'comprobantes-emitidos', 'emitidos', mes);
  const facturado = em ? r2(em.netoGravado + em.iva) : null;
  const ventas = foto.ventas?.totalConIva ?? null;
  return { pfos: { ...base, cobertura: foto.cobertura,
    control: { ventasMl: ventas, ordenes: foto.ventas?.ordenes ?? null, facturado, diferencia: ventas != null && facturado != null ? r2(facturado - ventas) : null,
      nota: 'facturado (neto gravado + IVA de los comprobantes emitidos) − ventas de Mercado Libre con IVA. La diferencia puede venir de ventas fuera de Mercado Libre, envíos facturados, notas de crédito o fechas de emisión: es para revisar, no un error' },
    retencionesMp: foto.retencionesMp ?? null } };
}
