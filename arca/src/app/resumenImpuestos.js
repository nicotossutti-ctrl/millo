/**
 * Lo que importa de un mes, en una línea por impuesto: IVA, Ingresos Brutos y Ganancias, cada uno con DECLARADO,
 * PAGADO, SALDO y DOCUMENTACIÓN, y lo que FALTA. Sale de lo guardado (panelMes): no consulta ARCA. Un saldo sin
 * verificar lo dice; nunca se inventa. Lo usan el final de la corrida y la app.
 */
import path from 'node:path';
import { panelMes, mesAnterior } from './panel.js';

const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const pesos = (n) => `$ ${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fechaDma = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : null);
const NIVEL = { verificado: 'verificado', importado: 'de un documento tuyo', manual: 'cargado a mano', estimado: 'estimado' };
/** «$ 1.234,56 (verificado)» o la nota de por qué falta. */
const dato = (c) => (c?.valor != null ? `${pesos(c.valor)} (${NIVEL[c.nivel] ?? c.nivel})` : `sin dato${c?.nota ? `: ${c.nota}` : ''}`);

/**
 * { mes, impuestos: [{ impuesto, declarado, aPagar, pagado, saldo, documentos, falta }], texto } del mes `mes` (por
 * defecto, el último mes cerrado). Son cifras del panel ({ valor, nivel, fuente, nota }). `aPagar` es lo que la DJ dejó a
 * pagar (lo declarado); `saldo` es el saldo VERIFICADO de hoy: sin verificación, sin dato y con su motivo.
 */
export function resumenImpuestos(outDir, { hoy = new Date().toISOString().slice(0, 10), mes = mesAnterior(hoy), paramsFile = path.resolve('params/contribuyente.json') } = {}) {
  const p = panelMes(outDir, mes, { hoy, paramsFile });
  const { iva, iibb, ganancias } = p;
  const impuestos = [];

  const docIva = [iva.presentacion?.fecha ? `DJ F.2051 presentada el ${iva.presentacion.fecha}` : null, iva.detalle_?.debitoComprobantes?.valor != null ? `Mis Comprobantes (${iva.detalle_.debitoComprobantes.nota})` : null].filter(Boolean);
  impuestos.push({ impuesto: 'IVA', declarado: iva.declarado, aPagar: iva.declarado, pagado: iva.pagos, saldo: iva.saldoPendiente, estado: iva.estado, vence: iva.vencimientoPago?.fecha ?? null, documentos: docIva,
    falta: [iva.declarado.valor == null ? 'la DJ F.2051 del mes (Portal IVA)' : null, iva.detalle_?.debitoComprobantes?.valor == null ? 'los comprobantes emitidos (Mis Comprobantes)' : null,
      iva.saldoPendiente?.valor == null ? 'el saldo en Cuentas Tributarias (pagos y deudas del período)' : null].filter(Boolean) });

  const cm = iibb.cm03?.vigente;
  impuestos.push({ impuesto: 'Ingresos Brutos', declarado: iibb.declarado, aPagar: iibb.aPagar, pagado: iibb.pagos, saldo: iibb.saldoPendiente, estado: iibb.estado, vence: null,
    documentos: [cm ? `CM03 ${cm.rectificativa ? `rectificativa ${cm.rectificativa}` : 'original'} (PDF${cm.fechaPresentacion ? `, presentada el ${fechaDma(cm.fechaPresentacion.slice(0, 10))}` : ''})` : null,
      iibb.presentacion?.fecha && !cm ? `CM03 presentada el ${iibb.presentacion.fecha} (lista de SIFERE)` : null].filter(Boolean),
    falta: [iibb.declarado.valor == null ? 'la CM03 del mes (Reporte de SIFERE)' : null, iibb.aPagar?.valor == null ? 'el total a pagar de la CM03' : null,
      iibb.aPagar?.valor > 0 && !iibb.pagos?.valor ? 'los pagos del período (volantes de SIFERE pagados o VEP)' : null].filter(Boolean) });

  const dj = ganancias.djAnual;
  const anioDj = Number(mes.slice(0, 4)) - 1;
  impuestos.push({ impuesto: `Ganancias (DJ ${anioDj})`, declarado: dj?.determinado ?? ganancias.djAnterior, aPagar: dj?.saldoDeclarado ?? null, pagado: dj?.pagosPosteriores ?? null, saldo: dj?.restante ?? null,
    proyeccion: ganancias.estimado, estado: ganancias.estado, vence: null, documentos: dj ? [`F.${dj.formulario} ${dj.anio} (PDF${dj.fecha ? `, presentada el ${fechaDma(dj.fecha)}` : ''})`] : [],
    falta: [!dj ? `la DJ anual ${anioDj} (F.2711 / F.711)` : null, dj && dj.restante?.valor == null ? `los pagos del saldo de la DJ ${anioDj} en Cuentas Tributarias` : null,
      ganancias.estimado?.valor == null ? `para estimar ${mes.slice(0, 4)}: ${ganancias.estimado?.nota ?? 'faltan datos'}` : null].filter(Boolean) });

  const texto = [`== IVA, Ingresos Brutos y Ganancias · ${NOMBRE_MES[Number(mes.slice(5)) - 1]} ${mes.slice(0, 4)}`];
  for (const x of impuestos) {
    texto.push(`${x.impuesto}`,
      `  declarado: ${dato(x.declarado)}${x.aPagar && x.aPagar !== x.declarado ? ` · a pagar según la DJ: ${dato(x.aPagar)}` : ''}`,
      `  pagado: ${dato(x.pagado)}`,
      `  saldo verificado: ${dato(x.saldo)}${x.vence ? ` · vence ${fechaDma(x.vence)}` : ''}${x.estado ? ` · ${x.estado}` : ''}`,
      `  documentos: ${x.documentos.length ? x.documentos.join(' · ') : 'ninguno guardado'}`,
      ...(x.proyeccion ? [`  proyección ${mes.slice(0, 4)}: ${dato(x.proyeccion)}`] : []),
      `  falta: ${x.falta.length ? x.falta.join(' · ') : 'nada'}`);
  }
  return { mes, impuestos, texto };
}
