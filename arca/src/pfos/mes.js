/**
 * Arma la foto de un mes con los datos de PFOS (pura: recibe lo leído y los comprobantes de ARCA). La foto es lo que usa
 * FiscalOS: cada concepto con su importe NETO (sin IVA), su nivel, si está completo y por qué no; la cobertura de cada
 * fuente; la verificación de la cuenta; y el detalle para revisar (unidades sin costo, cargos, logística).
 */
import { ordenesDelMes, costoVendidoMes, devolucionesMes, cargosMes, adsMes, vigentesConciliacion, logisticaReportesMes,
  coberturaReportes, diasCubiertos, IVA } from './calculo.js';
import { clavesArca, comprobantesPfos, verificarCuenta } from './cuenta.js';

const r2 = (x) => Math.round(x * 100) / 100;
const pct = (x) => (x == null ? '—' : `${String(x).replace('.', ',')} %`);

/** Umbrales para que un concepto de PFOS pueda ser la fuente del mes (si no, queda como referencia). */
export const MINIMOS = { costo: 95, cobros: 98 };

export function armarMes({ mes, datos, comunes, textosArca, generado = new Date().toISOString() }) {
  const ctx = { listas: comunes.listas, itemsPorLista: comunes.itemsPorLista, mapeos: comunes.mapeos };
  const { vigentes, canceladas } = ordenesDelMes(datos.ordenes, mes);
  const ordenesPorId = new Map([...datos.ordenes, ...datos.ordenesDevueltas].map((o) => [String(o.key), o]));

  // Cuenta: sus facturas a clientes tienen que estar en tus comprobantes emitidos de ARCA.
  const concil = vigentesConciliacion(datos.conciliacion);
  const cuenta = verificarCuenta(comprobantesPfos(datos.facturas, concil.porFuente.comprobante ?? []), clavesArca(textosArca));

  // Cobertura de la recolección de PFOS en el mes.
  const diasOrdenes = diasCubiertos(datos.alcances, 'orders', mes);
  const diasCobros = diasCubiertos(datos.alcances, 'mp_payments', mes);
  const imp = comunes.importaciones;
  const cobRep = {
    flexBonif: coberturaReportes(imp, ['flex_nc'], mes), flexAnul: coberturaReportes(imp, ['flex_nd'], mes),
    luma: coberturaReportes(imp, ['luma_viajes', 'luma_viajes_detalle'], mes), full: coberturaReportes(imp, ['ml_cargos_full'], mes),
  };
  const ordenesCompletas = diasOrdenes.dias === diasOrdenes.diasMes;

  const vendido = costoVendidoMes(vigentes, ctx);
  const devueltas = devolucionesMes(datos.devoluciones, ordenesPorId, mes, ctx);
  const cargos = cargosMes(vigentes, datos.cobros);
  const ads = adsMes(datos.ads, mes);
  const rep = logisticaReportesMes(concil, mes);
  const unidades = vendido.unidades;

  const lineas = {};
  // Costo de la mercadería vendida, sin IVA (PALERMO responsable inscripto).
  {
    const faltan = [];
    if (!ordenesCompletas) faltan.push(`ventas de ${diasOrdenes.faltan.length} día(s) sin recolección completa en PFOS`);
    if ((vendido.cobertura ?? 0) < MINIMOS.costo) faltan.push(`solo ${pct(vendido.cobertura)} de las unidades tiene costo (mínimo ${MINIMOS.costo} %)`);
    if (devueltas.sinCostear) faltan.push(`${devueltas.sinCostear} unidad(es) devuelta(s) sin costear`);
    const estimado = vendido.unidadesListaPosterior > 0 || vendido.unidadesAutomaticas > 0 || (vendido.cobertura ?? 0) < 100;
    lineas['costo-mercaderia'] = {
      importe: r2(vendido.total - devueltas.total), nivel: estimado ? 'estimado' : 'importado', completo: faltan.length === 0, faltan,
      nota: [`${vendido.unidadesConCosto} de ${unidades} unidades con costo (${pct(vendido.cobertura)})`,
        vendido.unidadesListaPosterior ? `${vendido.unidadesListaPosterior} con la lista posterior a la venta` : null,
        vendido.unidadesAutomaticas ? `${vendido.unidadesAutomaticas} con mapeo automático (sin confirmar en PFOS)` : null,
        devueltas.total ? `− ${devueltas.total} de mercadería que volvió (${devueltas.unidades} u.)` : null].filter(Boolean).join(' · '),
    };
  }
  // Cargos de ML y MP: comisión, costo fijo, cuotas y cupones a cargo del vendedor. Neto estimado (÷ 1,21).
  {
    const faltan = [];
    if (!ordenesCompletas) faltan.push('ventas del mes incompletas en PFOS');
    if ((cargos.cobertura ?? 0) < MINIMOS.cobros) faltan.push(`cobros de MP de ${pct(cargos.cobertura)} de las ventas (mínimo ${MINIMOS.cobros} %)`);
    const conIva = cargos.comision + cargos.cuotas + cargos.cupon;
    lineas['comisiones-ml'] = { importe: r2(conIva / IVA), conIva: r2(conIva), nivel: 'estimado', completo: faltan.length === 0, faltan,
      nota: `con IVA ${conIva} (comisión ${cargos.comision}, cuotas ${cargos.cuotas}, cupones ${cargos.cupon}); neto ÷ 1,21 hasta verificarlo con las facturas de ML` };
  }
  // Logística: envío a cargo del vendedor (MP) + Full − bonificación Flex + anulaciones + cadete (Luma).
  {
    const faltan = [];
    if (!ordenesCompletas) faltan.push('ventas del mes incompletas en PFOS');
    if ((cargos.cobertura ?? 0) < MINIMOS.cobros) faltan.push('cobros de MP incompletos (envíos a cargo del vendedor)');
    for (const [k, nombre] of [['flexBonif', 'bonificaciones Flex'], ['flexAnul', 'anulaciones Flex'], ['luma', 'viajes de Luma'], ['full', 'cargos de Full']]) {
      if (cobRep[k].estado !== 'completa') faltan.push(`${nombre}: ${cobRep[k].estado === 'sin datos' ? 'sin reporte del mes en «Conciliación»' : 'reporte que no cubre todo el mes'}`);
    }
    const ml = cargos.envio + rep.full.total - rep.bonificacionFlex.total + rep.anulacionFlex.total;
    lineas.logistica = { importe: r2(ml / IVA + rep.cadete.total), nivel: 'estimado', completo: faltan.length === 0, faltan,
      nota: `envíos a cargo del vendedor ${cargos.envio} + Full ${rep.full.total} − bonificación Flex ${rep.bonificacionFlex.total} + anulaciones ${rep.anulacionFlex.total} (con IVA, ÷ 1,21) + cadete Luma ${rep.cadete.total} (sin IVA verificado)` };
  }
  // Publicidad: inversión de Mercado Ads por día (el IVA de Ads está pendiente en PFOS: 1,19 no cierra con 21 %).
  {
    const faltan = ads.dias === ads.diasMes ? [] : [`inversión leída en ${ads.dias} de ${ads.diasMes} días`];
    lineas.publicidad = { importe: ads.total, nivel: 'importado', completo: faltan.length === 0, faltan, nota: 'inversión según Mercado Ads; el IVA de su factura está pendiente de verificar' };
  }

  return {
    mes, generado, cuenta,
    cobertura: { ordenes: diasOrdenes, cobros: diasCobros, cobrosDeVentas: cargos.cobertura, reportes: cobRep, ads: { dias: ads.dias, diasMes: ads.diasMes },
      conciliacion: { conflictos: concil.conflictos, pendientes: concil.pendientes, provisionales: concil.provisionales } },
    ventas: { ordenes: vigentes.length, canceladas: canceladas.length, unidades,
      totalConIva: r2(vigentes.reduce((n, o) => n + (Number(o.data?.total_amount) || 0), 0)) },
    costo: { ...vendido, sinCosto: vendido.sinCosto.slice(0, 30), devoluciones: devueltas },
    cargos, ads, reportes: rep,
    retencionesMp: { importe: cargos.retencion, nota: 'retenciones de MP en los cobros del mes: son anticipos de impuestos, no costo' },
    lineas,
  };
}
