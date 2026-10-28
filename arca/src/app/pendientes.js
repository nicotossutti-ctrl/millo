/**
 * Pendientes de carga: lo que ARCA no entrega sola y hay que bajar a mano (una vez por mes o por año). La app lo pide con
 * un cartel hasta que esté cargado. Solo datos impositivos; nada comercial (eso es de PFOS).
 *
 * Por cada uno de los últimos MESES_REVISADOS meses CALENDARIO cerrados (desde el mes anterior a hoy hacia atrás), tengan
 * datos guardados o no: un mes sin nada es justamente el que más falta.
 *  - Comprobantes emitidos y recibidos (Mis Comprobantes): se bajan solos con la actualización de ARCA.
 *  - Ingresos Brutos: la CM03 del mes, mejor su PDF («Reporte» de SIFERE), que trae el impuesto determinado y el total a
 *    pagar de cada jurisdicción. Con el PDF importado sale el pedido de la CM03, pero no el del pago. Si SIFERE muestra
 *    una rectificativa posterior a la importada, se pide su reporte. Cargado a mano solo el determinado, se pide el total
 *    a pagar: el determinado no es lo que se paga.
 *  - Ingresos Brutos: el pago, si la CM03 deja algo a pagar y no se encontró un pago que lo cubra. «No encontrado» es
 *    falta de evidencia, no prueba de que esté impago; un pago parcial no silencia el pedido.
 *  - Autónomos: la cuota del mes, si ARCA no tiene pagos imputados al período y no está configurada.
 *  - F.931 (empleador) y F.744 / SICORE (agente), si su DJ figura presentada: el total declarado y, después, el pago.
 * Una vez por año (desde julio): el impuesto determinado de la DJ anual de Ganancias del año anterior.
 */
import path from 'node:path';
import { leerManifiesto } from '../portal/misComprobantes.js';
import { manualesDelMes } from './manuales.js';
import { importadoDelMes, CONCEPTOS } from './importar.js';
import { mesAnterior, pagosDelPeriodo, contribuyente, estadoPago, cifra, pagosIibbDelPeriodo, obligacionesDeTerceros, TERCEROS } from './panel.js';
import { cm03Sifere, djAnualGanancias } from './presentaciones.js';
import { cm03DelPeriodo } from './cm03.js';

export const MESES_REVISADOS = 6;
const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nombreMes = (m) => `${NOMBRE_MES[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const pesos = (n) => `$ ${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Los últimos `n` meses calendario hasta `ultimo` inclusive, del más nuevo al más viejo. */
export function mesesHacia(ultimo, n) {
  const out = []; let [y, m] = ultimo.split('-').map(Number);
  for (let i = 0; i < n; i++) { out.push(`${y}-${String(m).padStart(2, '0')}`); m -= 1; if (!m) { m = 12; y -= 1; } }
  return out;
}
const finDeMes = (mes) => { const [y, m] = mes.split('-'); return new Date(Date.UTC(+y, +m, 0)).toISOString().slice(0, 10); };

/** ¿Hay un tramo apto de Mis Comprobantes que cubra el mes entero? */
function tieneComprobantes(datosDir, id, tipo, mes) {
  return Object.entries(leerManifiesto(path.join(datosDir, id))).some(([k, v]) => {
    const [t, d, h] = k.split(':');
    return t === tipo && v?.ok && d <= `${mes}-01` && h >= finDeMes(mes);
  });
}

/** Carga manual o importada de un concepto en un mes (lo que haya). */
const cargado = (outDir, mes, concepto) => manualesDelMes(outDir, mes)[concepto] ?? importadoDelMes(outDir, mes)[concepto] ?? null;

/**
 * Lista de pendientes, del más nuevo al más viejo: [{ clave, mes, titulo, porque, como, accion }]. accion:
 * { tipo: 'cargar', concepto, mes } (importe en el cartel o archivo en «Importar») | { tipo: 'arca' } (se baja sola) |
 * { tipo: 'cm03', mes, alternativa? } (subir el PDF de la CM03; la alternativa es cargar el importe a mano).
 */
export function pendientesDeCarga(outDir, hoy, { paramsFile } = {}) {
  const datosDir = path.join(outDir, 'datos');
  const contrib = contribuyente(paramsFile);
  const ultimo = mesAnterior(hoy);
  const meses = mesesHacia(ultimo, MESES_REVISADOS);
  const out = [];
  for (const mes of meses) {
    const n = nombreMes(mes);
    for (const [id, tipo, nombre] of [['comprobantes-emitidos', 'emitidos', 'emitidos'], ['comprobantes-recibidos', 'recibidos', 'recibidos']]) {
      if (tieneComprobantes(datosDir, id, tipo, mes)) continue;
      out.push({ clave: `${id}:${mes}`, mes, titulo: `Comprobantes ${nombre} de ${n}`, porque: 'sin ellos no hay IVA ni Ingresos Brutos estimados del mes',
        como: 'No hay que bajar nada: se traen solos con la actualización de ARCA (fiscalos.ps1 correr).', accion: { tipo: 'arca' } });
    }
    // Ingresos Brutos: la CM03 (lo mejor, su PDF: trae el determinado y el total a pagar por jurisdicción) y el pago del
    // TOTAL A PAGAR, nunca del impuesto determinado.
    const cm = cm03DelPeriodo(outDir, mes); const cmv = cm.vigente;
    const lista = cm03Sifere(datosDir, mes)?.presentada;
    const cual = lista ? `la CM03 ${lista.rectificativa ? `rectificativa ${lista.rectificativa}` : 'original'} presentada el ${lista.fechaPresentacion}` : `la DJ CM03 del período ${mes.slice(5)}/${mes.slice(0, 4)}`;
    const dondePdf = 'En SIFERE WEB – Consultas: DDJJ Mensuales > Listado > la fila presentada del período > ícono «Reporte» (impresora). Subí ese PDF acá: FiscalOS lee el impuesto determinado y el total a pagar de cada jurisdicción.';
    const revision = cm.enRevision.length ? ` Hay ${cm.enRevision.length} PDF(s) en revisión que no se usan (${cm.enRevision.map((r) => r.motivos[0]).join('; ')}).` : '';
    const det = cmv ? { importe: cmv.impuestoDeterminadoTotal } : cargado(outDir, mes, 'iibb-declarado');
    const aPagar = cmv ? { importe: cmv.totalAPagarDeclarado } : cargado(outDir, mes, 'iibb-a-pagar-segun-cm03');
    if (!det) {
      out.push({ clave: `iibb-declarado:${mes}`, mes, titulo: `Ingresos Brutos de ${n}: CM03${lista ? ` · presentada el ${String(lista.fechaPresentacion).slice(0, 10)}` : ''}`,
        porque: `es el impuesto de IIBB del mes y lo que queda para pagar; sin ella solo hay una estimación.${revision}`,
        como: `${dondePdf} Si no podés bajarlo, cargá el impuesto determinado total de ${cual}.`,
        accion: { tipo: 'cm03', mes, alternativa: { tipo: 'cargar', concepto: 'iibb-declarado', mes } } });
    } else if (cmv && lista && lista.rectificativa > cmv.rectificativa) {
      out.push({ clave: `iibb-rectificativa:${mes}`, mes, titulo: `Ingresos Brutos de ${n}: falta el reporte de la rectificativa ${lista.rectificativa}`,
        porque: `SIFERE muestra presentada la rectificativa ${lista.rectificativa} y la importada es la ${cmv.rectificativa ? `rectificativa ${cmv.rectificativa}` : 'original'}: los importes pueden haber cambiado`,
        como: dondePdf, accion: { tipo: 'cm03', mes } });
    } else if (!aPagar) {
      out.push({ clave: `iibb-a-pagar-segun-cm03:${mes}`, mes, titulo: `Ingresos Brutos de ${n}: total a pagar de la CM03`,
        porque: `el impuesto determinado no es lo que se paga: la CM03 descuenta saldos a favor, retenciones y percepciones de cada jurisdicción.${revision}`,
        como: `${dondePdf} Si no, cargá el «Total a pagar» de ${cual}.`,
        accion: { tipo: 'cm03', mes, alternativa: { tipo: 'cargar', concepto: 'iibb-a-pagar-segun-cm03', mes } } });
    }
    if (aPagar && aPagar.importe > 0) {
      // Lo que cancela el total a pagar del período: volantes PAGADOS y pagos cargados para el período, sin duplicados.
      const ip = pagosIibbDelPeriodo(outDir, datosDir, mes);
      const pagos = ip.computados.map((x) => cifra(x.importe, x.nivel));
      const estado = estadoPago(aPagar.importe, pagos);
      if (estado === 'pago no encontrado (sin cobertura)' || estado === 'pago parcial: falta conciliar') {
        const pagado = pagos.reduce((x, c) => x + c.valor, 0);
        out.push({ clave: `iibb-pagado:${mes}`, mes, titulo: `Ingresos Brutos de ${n}: pago`, estadoPago: estado,
          porque: estado === 'pago parcial: falta conciliar'
            ? `hay pagos por ${pesos(pagado)} de ${pesos(aPagar.importe)} a pagar según la CM03: falta conciliar ${pesos(aPagar.importe - pagado)}`
            : `la CM03 deja ${pesos(aPagar.importe)} a pagar y no encontramos el pago en SIFERE ni en tus cargas. Eso no prueba que esté impago: si lo pagaste, cargá el importe; si todavía no, queda pendiente`,
          como: `El importe pagado del VEP o del volante de SIFERE de ese período, con la fecha en que se pagó.${ip.volantesSinPago.length ? ` Hay ${ip.volantesSinPago.length} volante(s) generado(s) en SIFERE sin estado de pago: un volante no es un pago.` : ''}${ip.inciertos.length ? ` Hay ${ip.inciertos.length} pago(s) cargado(s) que no se suman hasta aclararlos (sin fecha de pago o sin poder conciliarlos con lo de ARCA).` : ''}`,
          accion: { tipo: 'cargar', concepto: 'iibb-pagado', mes, conFecha: true } });
      }
    }
    // Como empleador (F.931) y agente (F.744 / SICORE): solo si la DJ del período figura presentada (hay obligación).
    for (const o of obligacionesDeTerceros(outDir, datosDir, mes, hoy)) {
      const t = TERCEROS[o.id];
      if (!o.presentacion) continue;
      if (o.declarado.valor == null) {
        out.push({ clave: `${t.declarado}:${mes}`, mes, titulo: `${o.nombre} de ${n}: total declarado · presentada el ${String(o.presentacion.fecha).slice(0, 10)}`,
          porque: `la DJ figura presentada en Cuentas Tributarias, pero la lista no trae el importe (${t.tratamiento})`,
          como: `En ${t.dondeDeclarado}. Cargá ese número acá.`, accion: { tipo: 'cargar', concepto: t.declarado, mes } });
      } else if (o.declarado.valor > 0 && ['pago no encontrado (sin cobertura)', 'pago parcial: falta conciliar'].includes(o.estado)) {
        out.push({ clave: `${t.pagado}:${mes}`, mes, titulo: `${o.nombre} de ${n}: pago`, estadoPago: o.estado,
          porque: o.estado === 'pago parcial: falta conciliar' ? 'los pagos encontrados no cubren lo declarado: falta conciliar'
            : 'no encontramos el pago imputado al período en Cuentas Tributarias. Eso no prueba que esté impago: si lo pagaste, cargá el importe y la fecha',
          como: 'El importe pagado del VEP de ese período, con la fecha en que se pagó.', accion: { tipo: 'cargar', concepto: t.pagado, mes, conFecha: true } });
      }
    }
    if (!cargado(outDir, mes, 'autonomos-cuota') && !pagosDelPeriodo(datosDir, mes, 'autonomos').length && !contrib?.autonomosMensual) {
      out.push({ clave: `autonomos-cuota:${mes}`, mes, titulo: `Autónomos de ${n}: cuota del mes`,
        porque: 'ARCA no tiene pagos de autónomos imputados a ese período',
        como: 'En ARCA, «CCMA - Cuenta corriente de monotributistas y autónomos» (o tu VEP): el importe de la cuota del período.',
        accion: { tipo: 'cargar', concepto: 'autonomos-cuota', mes } });
    }
  }
  // Ganancias: la DJ anual del año anterior, una vez por año (desde julio; las prórrogas de ARCA la corren a veces).
  const anio = Number(hoy.slice(0, 4)) - 1;
  if (hoy.slice(5, 7) >= '07' && !cargado(outDir, `${anio}-12`, 'ganancias-determinado')) {
    const dj = djAnualGanancias(datosDir, anio);
    out.push({ clave: `ganancias-determinado:${anio}`, mes: `${anio}-12`, titulo: `Ganancias ${anio}: impuesto determinado de la DJ anual${dj ? ` · F.${dj.formulario} presentada el ${dj.fecha}` : ''}`,
      porque: 'de esa DJ salen los anticipos que se pagan este año; los pagos ya se leen solos de Cuentas Tributarias',
      como: `En ARCA, «Ganancias Personas Humanas» (o el F.711 que presentó tu contador): el impuesto determinado del período fiscal ${anio}.`,
      accion: { tipo: 'cargar', concepto: 'ganancias-determinado', mes: `${anio}-12` } });
  }
  return out.map((x) => ({ ...x, concepto: x.accion.concepto ? CONCEPTOS[x.accion.concepto].nombre : null }));
}
