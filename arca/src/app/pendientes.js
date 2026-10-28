/**
 * Pendientes de carga: lo que ARCA no entrega sola y hay que bajar a mano (una vez por mes o por año). La app lo pide con
 * un cartel hasta que esté cargado. Solo datos impositivos; nada comercial (eso es de PFOS).
 *
 * Por cada uno de los últimos MESES_REVISADOS meses CALENDARIO cerrados (desde el mes anterior a hoy hacia atrás), tengan
 * datos guardados o no: un mes sin nada es justamente el que más falta.
 *  - Comprobantes emitidos y recibidos (Mis Comprobantes): se bajan solos con la actualización de ARCA.
 *  - Ingresos Brutos: el impuesto determinado de la DJ CM03 del mes (SIFERE no se lee).
 *  - Ingresos Brutos: el pago, si hay impuesto declarado y no se encontró un pago que lo cubra. «No encontrado» es falta de
 *    evidencia, no prueba de que esté impago; un pago parcial no silencia el pedido.
 *  - Autónomos: la cuota del mes, si ARCA no tiene pagos imputados al período y no está configurada.
 * Una vez por año (desde julio): el impuesto determinado de la DJ anual de Ganancias del año anterior.
 */
import path from 'node:path';
import { leerManifiesto } from '../portal/misComprobantes.js';
import { manualesDelMes } from './manuales.js';
import { importadoDelMes, CONCEPTOS } from './importar.js';
import { mesAnterior, pagosDelPeriodo, volantesSifere, contribuyente, estadoPago, cifra } from './panel.js';
import { cm03Sifere, djAnualGanancias } from './presentaciones.js';

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
 * { tipo: 'cargar', concepto, mes } (importe en el cartel o archivo en «Importar») | { tipo: 'arca' } (se baja sola).
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
    const iibb = cargado(outDir, mes, 'iibb-declarado');
    if (!iibb) {
      const cm = cm03Sifere(datosDir, mes)?.presentada;
      const cual = cm ? `la CM03 ${cm.rectificativa ? `rectificativa ${cm.rectificativa}` : 'original'} presentada el ${cm.fechaPresentacion}` : `la DJ CM03 del período ${mes.slice(5)}/${mes.slice(0, 4)}`;
      out.push({ clave: `iibb-declarado:${mes}`, mes, titulo: `Ingresos Brutos de ${n}: impuesto determinado (CM03)${cm ? ` · presentada el ${String(cm.fechaPresentacion).slice(0, 10)}` : ''}`,
        porque: 'es el impuesto de IIBB del mes; sin él solo hay una estimación',
        como: `En SIFERE Web (Convenio Multilateral), ${cual}: el total de impuesto determinado de todas las jurisdicciones. Cargá ese número acá, o el archivo en «Importar archivo».`,
        accion: { tipo: 'cargar', concepto: 'iibb-declarado', mes } });
    } else if (iibb.importe > 0) {
      const volantes = volantesSifere(datosDir, mes);
      const manual = cargado(outDir, mes, 'iibb-pagado');
      const pagos = [...(volantes.length ? [cifra(volantes.reduce((x, v) => x + (v.importe ?? 0), 0), 'verificado')] : []), ...(manual ? [cifra(manual.importe, 'manual')] : [])];
      const estado = estadoPago(iibb.importe, pagos);
      if (estado === 'pago no encontrado (sin cobertura)' || estado === 'pago parcial: falta conciliar') {
        const pagado = pagos.reduce((x, c) => x + c.valor, 0);
        out.push({ clave: `iibb-pagado:${mes}`, mes, titulo: `Ingresos Brutos de ${n}: pago`, estadoPago: estado,
          porque: estado === 'pago parcial: falta conciliar'
            ? `hay pagos por ${pesos(pagado)} de ${pesos(iibb.importe)} declarados: falta conciliar ${pesos(iibb.importe - pagado)}`
            : 'no encontramos el pago en SIFERE ni en tus cargas. Eso no prueba que esté impago: si lo pagaste, cargá el importe; si todavía no, queda pendiente',
          como: 'El importe pagado del VEP o del volante de SIFERE de ese período.', accion: { tipo: 'cargar', concepto: 'iibb-pagado', mes } });
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
