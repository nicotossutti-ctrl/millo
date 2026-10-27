/**
 * Arma la foto de un mes con los datos de PFOS (pura: recibe lo leído y los comprobantes de ARCA). La foto es lo que usa
 * FiscalOS: cada concepto con su importe NETO (sin IVA), su nivel, si está completo y por qué no; la cobertura de cada
 * fuente; la verificación de la cuenta; y el detalle para revisar (unidades sin costo, cargos, logística).
 */
import { ordenesDelMes, costoVendidoMes, devolucionesMes, cargosMes, adsMes, vigentesConciliacion, logisticaReportesMes,
  coberturaReportes, diasCubiertos, corteDelMes, finDelMes, IVA } from './calculo.js';
import { clavesArca, comprobantesPfos, verificarCuenta } from './cuenta.js';

const r2 = (x) => Math.round(x * 100) / 100;
const pct = (x) => (x == null ? '—' : `${String(x).replace('.', ',')} %`);

/** Umbrales para que un concepto de PFOS pueda ser la fuente del mes (si no, queda como referencia). */
export const MINIMOS = { costo: 95, cobros: 98 };

// Reportes mensuales de «Conciliación» (mientras PFOS no los traiga solo): concepto, nombre y de dónde se bajan.
const REPORTES = [
  ['flexBonif', 'bonificaciones Flex', 'Facturación de ML → notas de crédito de Envíos Flex'],
  ['flexAnul', 'anulaciones Flex', 'Facturación de ML → notas de débito de Envíos Flex'],
  ['luma', 'viajes de Luma', 'planilla de Luma Logística, por quincena o el detalle de viajes'],
  ['full', 'cargos de Full', 'Facturación de ML → Reporte de cargos de Full'],
];

const fechaCorta = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '—');

export function armarMes({ mes, datos, comunes, textosArca, generado = new Date().toISOString() }) {
  const ctx = { listas: comunes.listas, itemsPorLista: comunes.itemsPorLista, mapeos: comunes.mapeos };
  // Corte: el mes terminado, entero; el mes en curso, hasta ayer. Lo posterior no es «atrasado» ni se mezcla.
  const corte = corteDelMes(mes, generado);
  const mesCerrado = corte === finDelMes(mes);
  const alCorte = mesCerrado ? '' : ` al ${fechaCorta(corte)}`;
  const { vigentes, canceladas, posteriores } = ordenesDelMes(datos.ordenes, mes, corte);
  const ordenesPorId = new Map([...datos.ordenes, ...datos.ordenesDevueltas].map((o) => [String(o.key), o]));

  // Cuenta: sus facturas a clientes tienen que estar en tus comprobantes emitidos de ARCA.
  const concil = vigentesConciliacion(datos.conciliacion);
  const cuenta = verificarCuenta(comprobantesPfos(datos.facturas, concil.porFuente.comprobante ?? []), clavesArca(textosArca));

  // Cobertura de la recolección de PFOS en el mes.
  const diasOrdenes = diasCubiertos(datos.alcances, 'orders', mes, corte);
  const diasCobros = diasCubiertos(datos.alcances, 'mp_payments', mes, corte);
  const imp = comunes.importaciones;
  const cobRep = {
    flexBonif: coberturaReportes(imp, ['flex_nc'], mes, corte), flexAnul: coberturaReportes(imp, ['flex_nd'], mes, corte),
    luma: coberturaReportes(imp, ['luma_viajes', 'luma_viajes_detalle'], mes, corte), full: coberturaReportes(imp, ['ml_cargos_full'], mes, corte),
  };
  const ordenesCompletas = corte != null && diasOrdenes.faltan.length === 0;

  const vendido = costoVendidoMes(vigentes, ctx);
  const devueltas = devolucionesMes(datos.devoluciones, ordenesPorId, mes, ctx);
  const cargos = cargosMes(vigentes, datos.cobros);
  const ads = adsMes(datos.ads, mes, corte);
  const rep = logisticaReportesMes(concil, mes, corte);
  const unidades = vendido.unidades;

  const lineas = {};
  // Costo de la mercadería vendida, sin IVA (PALERMO responsable inscripto).
  {
    const faltan = [];
    if (!ordenesCompletas) faltan.push(`ventas de ${diasOrdenes.faltan.length} día(s) sin recolección completa en PFOS${alCorte}`);
    if ((vendido.cobertura ?? 0) < MINIMOS.costo) faltan.push(`solo ${pct(vendido.cobertura)} de las unidades tiene costo (mínimo ${MINIMOS.costo} %)`);
    if (devueltas.sinCostear) faltan.push(`${devueltas.sinCostear} unidad(es) devuelta(s) sin costear`);
    const estimado = vendido.unidadesListaPosterior > 0 || vendido.unidadesAutomaticas > 0 || (vendido.cobertura ?? 0) < 100;
    lineas['costo-mercaderia'] = {
      importe: r2(vendido.total - devueltas.total), nivel: estimado ? 'estimado' : 'importado', completo: faltan.length === 0, faltan,
      nota: [`${vendido.unidadesConCosto} de ${unidades} unidades con costo (${pct(vendido.cobertura)})`,
        vendido.unidadesListaPosterior ? `${vendido.unidadesListaPosterior} con la lista posterior a la venta` : null,
        vendido.unidadesAutomaticas ? `${vendido.unidadesAutomaticas} con las reglas de PFOS (sin confirmar uno por uno)` : null,
        vendido.unidadesParaRevision ? `${vendido.unidadesParaRevision} para revisión (presentación, cantidad, talle o precio ambiguos)` : null,
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
    for (const [k, nombre, reporte] of REPORTES) {
      const c = cobRep[k];
      if (c.estado === 'completa') continue;
      if (c.estado === 'sin datos') faltan.push(`${nombre}: sin reporte del mes en «Conciliación» (${reporte})`);
      else if (c.descartadas) faltan.push(`${nombre}: un reporte cargado tiene filas descartadas al leer (revisarlo en «Conciliación»)`);
      else faltan.push(`${nombre}: reporte que no cubre todo el mes${alCorte} (falta desde el ${fechaCorta(c.faltaDesde)}; ${reporte})`);
    }
    for (const [fuente, nombre] of [['flex_bonificacion', 'bonificaciones Flex'], ['flex_anulacion', 'anulaciones Flex'], ['flex_viaje', 'viajes de Luma'], ['full_cargo', 'cargos de Full']]) {
      const n = (concil.pendientes[fuente] ?? 0) + (concil.conflictos[fuente] ?? 0);
      if (n) faltan.push(`${nombre}: ${n} registro(s) pendientes o en conflicto en «Conciliación» (no se suman)`);
    }
    const ml = cargos.envio + rep.full.total - rep.bonificacionFlex.total + rep.anulacionFlex.total;
    lineas.logistica = { importe: r2(ml / IVA + rep.cadete.total), nivel: 'estimado', completo: faltan.length === 0, faltan,
      nota: `envíos a cargo del vendedor ${cargos.envio} + Full ${rep.full.total} − bonificación Flex ${rep.bonificacionFlex.total} + anulaciones ${rep.anulacionFlex.total} (con IVA, ÷ 1,21) + cadete Luma ${rep.cadete.total} (sin IVA verificado)${rep.cadete.repetidos ? `; ${rep.cadete.repetidos} viaje(s) de la planilla de detalle ya estaban en la quincenal: no se suman` : ''}` };
  }
  // Publicidad: inversión de Mercado Ads por día (el IVA de Ads está pendiente en PFOS: 1,19 no cierra con 21 %). Sin
  // ningún día leído es FALTANTE (importe null), nunca $ 0.
  {
    const faltan = ads.dias === 0 ? [`sin datos de Mercado Ads${alCorte}: la vista fiscalos.ads_diario no devolvió días del mes (si PFOS los tiene, correr docs/pfos-correccion-1.sql)`]
      : ads.faltan.length ? [`inversión leída en ${ads.dias} de ${ads.diasEsperados} días${alCorte}`] : [];
    lineas.publicidad = { importe: ads.total, nivel: ads.total == null ? 'faltante' : 'importado', completo: faltan.length === 0, faltan,
      nota: ads.total == null ? 'sin datos (no es cero)' : 'inversión según Mercado Ads; el IVA de su factura está pendiente de verificar' };
  }
  for (const l of Object.values(lineas)) { l.alCorte = corte; l.mesCerrado = mesCerrado; }

  // Por día (hasta el corte): para comparar períodos equivalentes (1 al N de cada mes).
  const porDia = {};
  const dia = (d) => (porDia[d] ??= { ordenes: 0, ventas: 0, unidades: 0, unidadesConCosto: 0, costo: 0, comision: 0, envio: 0, ads: null, full: 0, bonificacionFlex: 0, anulacionFlex: 0, cadete: 0 });
  for (const o of vigentes) { const d = dia(o.dia); d.ordenes++; d.ventas = r2(d.ventas + (Number(o.data?.total_amount) || 0)); }
  for (const [d, x] of Object.entries(vendido.porDia)) Object.assign(dia(d), { unidades: x.unidades, unidadesConCosto: x.conCosto, costo: x.costo });
  for (const [d, x] of Object.entries(cargos.porDia)) Object.assign(dia(d), x);
  for (const [d, v] of Object.entries(ads.porDia)) dia(d).ads = v;
  for (const [k, campo] of [['full', 'full'], ['bonificacionFlex', 'bonificacionFlex'], ['anulacionFlex', 'anulacionFlex'], ['cadete', 'cadete']]) {
    for (const [d, v] of Object.entries(rep[k].porDia)) dia(d)[campo] = v;
  }

  const { porDia: _c, ...costoSinDias } = vendido;
  const { porDia: _g, ...cargosSinDias } = cargos;
  const { porDia: _a, ...adsSinDias } = ads;
  return {
    mes, generado, corte, mesCerrado, cuenta,
    cobertura: { corte, ordenes: diasOrdenes, cobros: diasCobros, cobrosDeVentas: cargos.cobertura, reportes: cobRep,
      ads: { dias: ads.dias, diasEsperados: ads.diasEsperados, diasMes: ads.diasMes, faltan: ads.faltan },
      conciliacion: { conflictos: concil.conflictos, pendientes: concil.pendientes, provisionales: concil.provisionales } },
    ventas: { ordenes: vigentes.length, canceladas: canceladas.length, posterioresAlCorte: posteriores, unidades,
      totalConIva: r2(vigentes.reduce((n, o) => n + (Number(o.data?.total_amount) || 0), 0)) },
    costo: { ...costoSinDias, sinCosto: vendido.sinCosto.slice(0, 40), devoluciones: devueltas },
    cargos: cargosSinDias, ads: adsSinDias, reportes: Object.fromEntries(Object.entries(rep).map(([k, { porDia: _, ...v }]) => [k, v])),
    porDia,
    retencionesMp: { importe: cargos.retencion, nota: 'retenciones de MP en los cobros del mes: son anticipos de impuestos, no costo' },
    lineas,
  };
}
