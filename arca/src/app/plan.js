/**
 * Qué va a buscar «Actualizar datos fiscales»: primero mira lo que YA está guardado en out/ para IVA, IIBB y Ganancias
 * del último mes cerrado, y entra solo a las fuentes que faltan, cada una con su ventana de fechas:
 *  - la DJ y los comprobantes son del MES (septiembre); si ya están guardados completos, no se vuelven a bajar;
 *  - los PAGOS se buscan por fecha de operación desde el mes (o desde la presentación de la DJ anual de Ganancias, si es
 *    anterior) HASTA AYER: el IVA de septiembre se paga en octubre o después, y una consulta solo de septiembre no lo ve;
 *  - deudas, vencimientos y compensaciones se releen siempre (son el saldo de hoy);
 *  - SIFERE se relee siempre (los volantes pagados son los pagos de IIBB) y baja el Reporte de la CM03 si falta.
 * Lo que todavía no tiene fuente automática se informa como pendiente, sin inventar nada. Pura sobre out/.
 */
import path from 'node:path';
import { mesAnterior } from './panel.js';
import { tieneComprobantes } from './pendientes.js';
import { cm03DelPeriodo } from './cm03.js';
import { ddjjGananciasDelAnio } from './ddjjGanancias.js';
import { leerVigente } from '../portal/conservacion.js';

const finDeMes = (mes) => { const [y, m] = mes.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const diaAnterior = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const restarMeses = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };

/**
 * { mes, pasos: [{ id, desde, hasta, porque }], reutilizado: [{ que, porque }], pendientes: [string] }. `hoy` es
 * 'AAAA-MM-DD' (fecha local). Los pasos se corren en el orden de SERVICIOS.
 */
export function planActualizacion(outDir, hoy) {
  const datosDir = path.join(outDir, 'datos');
  const mes = mesAnterior(hoy); const inicio = `${mes}-01`; const fin = finDeMes(mes); const ayer = diaAnterior(hoy);
  const pasos = []; const reutilizado = []; const pendientes = [];
  const paso = (id, desde, hasta, porque) => pasos.push({ id, desde, hasta, porque });

  // IVA: comprobantes y DJ del mes (una vez); pagos hasta ayer; saldo (deudas, vencimientos, compensaciones) siempre.
  for (const [id, tipo, nombre] of [['comprobantes-emitidos', 'emitidos', 'Comprobantes emitidos'], ['comprobantes-recibidos', 'recibidos', 'Comprobantes recibidos']]) {
    if (tieneComprobantes(datosDir, id, tipo, mes)) reutilizado.push({ que: `${nombre} de ${mes}`, porque: 'ya están guardados completos' });
    else paso(id, inicio, fin, `${nombre.toLowerCase()} de ${mes}: no están guardados completos`);
  }
  const djIva = Object.keys(leerVigente(datosDir, 'portal-iva-ddjj')).some((k) => k.startsWith(`${inicio}_`));
  if (djIva) reutilizado.push({ que: `DJ de IVA (F.2051) de ${mes}`, porque: 'ya está guardada' });
  else { paso('portal-iva', inicio, fin, `lista de DJ de IVA presentadas: falta la de ${mes}`); paso('portal-iva-ddjj', inicio, fin, `detalle de la DJ de IVA de ${mes}: no está guardado`); }

  // Pagos: desde el mes (o la presentación de la DJ anual de Ganancias, si es anterior y de hace menos de un año) hasta ayer.
  const anio = Number(mes.slice(0, 4)) - 1;
  const djGan = ddjjGananciasDelAnio(outDir, anio).vigente;
  const desdeGan = djGan?.fechaPresentacion && djGan.fechaPresentacion >= restarMeses(hoy, 12) ? djGan.fechaPresentacion.slice(0, 10) : null;
  const desdePagos = desdeGan && desdeGan < inicio ? desdeGan : inicio;
  paso('ct-pagos', desdePagos, ayer, `pagos hechos entre ${desdePagos} y ayer: los de ${mes} se pagan después del mes${desdePagos < inicio ? `, y los del saldo de la DJ de Ganancias ${anio} desde su presentación` : ''}`);
  paso('ct-deudas', inicio, ayer, 'deudas registradas hoy (saldo)');
  paso('cuentas-tributarias', inicio, ayer, 'vencimientos (si el saldo está vencido o no)');
  paso('ct-compensaciones', inicio, ayer, 'compensaciones que cancelan saldos');

  // IIBB: SIFERE siempre (los volantes pagados son los pagos); el Reporte de la CM03 solo si falta.
  const cm = cm03DelPeriodo(outDir, mes).vigente;
  if (cm) reutilizado.push({ que: `CM03 de ${mes}`, porque: `ya está leída (${cm.rectificativa ? `rectificativa ${cm.rectificativa}` : 'original'})` });
  paso('sifere-consultas', inicio, ayer, cm ? 'IIBB: volantes de pago (pagos del período) y rectificativas nuevas' : `IIBB: volantes de pago y el Reporte de la CM03 de ${mes}`);
  pendientes.push('IIBB: los pagos y deducciones de «SIFERE WEB – Consultas» todavía no se extraen solos (solo los volantes pagados de SIFERE DDJJ)');

  // Ganancias: la DJ anual no se baja sola todavía; sus pagos salen de ct-pagos (arriba).
  if (djGan) reutilizado.push({ que: `DJ de Ganancias ${anio} (F.${djGan.formulario})`, porque: 'ya está leída' });
  else pendientes.push(`Ganancias: la DJ anual ${anio} no se baja sola todavía; subí su PDF (F.2711 o F.711) en la app`);

  return { mes, hoy, pasos, reutilizado, pendientes };
}
