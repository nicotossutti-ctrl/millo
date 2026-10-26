import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { periodoDe, importeDe, parsearConceptos, identificarConceptosIva, elegirDjVigente, textoEsDelPeriodo } from '../src/portal/ivaDdjj.js';
import { esProhibido } from '../src/portal/extractor.js';
import { parsearCsv, resumenComprobantes, generarInformeIva } from '../src/informeIva.js';
import { SERVICIOS } from '../src/portal/servicios.js';
import { toCsv } from '../src/csv.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arca-iva-'));

test('seguridad: Rectificar y Generar VEP están vetados; Ver declaración jurada y Descargar acuse, no', () => {
  for (const t of ['Rectificar', 'RECTIFICAR', 'Generar VEP']) assert.equal(esProhibido(t), true, t);
  for (const t of ['Ver declaración jurada', 'Descargar acuse de recibo']) assert.equal(esProhibido(t), false, t);
});

test('periodoDe e importeDe reconocen los formatos de ARCA', () => {
  assert.equal(periodoDe('09/2026'), '2026-09');
  assert.equal(periodoDe('202609'), '2026-09');
  assert.equal(periodoDe('2026-09'), '2026-09');
  assert.equal(periodoDe('9/2026'), '2026-09');
  assert.equal(periodoDe('2026'), null);
  assert.equal(importeDe('1.234.567,89'), 1234567.89);
  assert.equal(importeDe('$ -1.234,50'), -1234.5);
  assert.equal(importeDe('(100,00)'), -100);
  assert.equal(importeDe('2490,50'), 2490.5);
  assert.equal(importeDe('abc'), null);
});

test('parsearConceptos e identificarConceptosIva: saldos de la DJ por su texto; ambiguos no se usan', () => {
  const texto = [
    'Declaración Jurada de IVA - Período 09/2026',
    'Total Débito Fiscal $ 250.000,00',
    'Total Crédito Fiscal 180.000,50',
    'Saldo técnico a favor de ARCA: 69.999,50',
    'Total retenciones y percepciones 10.000,00',
    'Saldo de impuesto a favor de ARCA $ 59.999,50',
    'Texto sin importe',
  ].join('\n');
  const c = parsearConceptos(texto);
  assert.equal(c.length, 5);
  const id = identificarConceptosIva(c);
  assert.equal(id.debitoFiscal.importe, 250000);
  assert.equal(id.creditoFiscal.importe, 180000.5);
  assert.equal(id.saldoAPagar.importe, 59999.5);
  assert.equal(id.retencionesPercepciones.importe, 10000);
  assert.ok(textoEsDelPeriodo(texto, '2026-09'));
  assert.ok(!textoEsDelPeriodo(texto, '2026-08'));
  const amb = identificarConceptosIva([{ concepto: 'Saldo a pagar', importe: 1 }, { concepto: 'Saldo a pagar (rectif.)', importe: 2 }]);
  assert.ok(amb.saldoAPagar.ambiguo, 'dos saldos a pagar distintos: ambiguo');
});

test('elegirDjVigente: de varias DJ del mismo período, la última presentada', () => {
  const djs = [
    { idx: 0, periodo: '09/2026', formulario: '2051', secuencia: 'DJ Original', presentacion: '16/10/2026', tieneVer: true },
    { idx: 1, periodo: '09/2026', formulario: '2051', secuencia: 'Rectificativa 1', presentacion: '20/10/2026', tieneVer: true },
    { idx: 2, periodo: '08/2026', formulario: '2051', secuencia: 'DJ Original', presentacion: '16/09/2026', tieneVer: true },
  ];
  assert.equal(elegirDjVigente(djs, '2026-09').elegida.idx, 1);
  assert.equal(elegirDjVigente(djs, '2026-09').candidatas, 2);
  assert.equal(elegirDjVigente(djs, '2026-07').elegida, null);
});

test('portal-iva-ddjj: extractor propio sobre la misma lista de Portal IVA', () => {
  const s = SERVICIOS.find((x) => x.id === 'portal-iva-ddjj');
  assert.equal(s.extractor, 'iva-ddjj');
  assert.equal(s.ruta.at(-1).hash, '#/declaraciones.anteriores');
});

// Encabezados REALES del CSV de Mis Comprobantes (emitidos), con la línea de título previa.
const CAB = ['Fecha de Emisión', 'Tipo de Comprobante', 'Punto de Venta', 'Número Desde', 'Número Hasta', 'Cód. Autorización', 'Tipo Doc. Receptor', 'Nro. Doc. Receptor', 'Denominación Receptor', 'Tipo Cambio', 'Moneda', 'Imp. Neto Gravado IVA 0%', 'IVA 2,5%', 'Imp. Neto Gravado IVA 2,5%', 'IVA 5%', 'Imp. Neto Gravado IVA 5%', 'IVA 10,5%', 'Imp. Neto Gravado IVA 10,5%', 'IVA 21%', 'Imp. Neto Gravado IVA 21%', 'IVA 27%', 'Imp. Neto Gravado IVA 27%', 'Imp. Neto Gravado Total', 'Imp. Neto No Gravado', 'Imp. Op. Exentas', 'Otros Tributos', 'Total IVA', 'Imp. Total'];
const filaMc = (fecha, tipo, iva21, neto21) => [fecha, tipo, '6', '1', '1', '1', '80', '1', 'X', '1,00', '$', '', '', '', '', '', '', '', iva21, neto21, '', '', neto21, '0,00', '0,00', '0,00', iva21, String(importeDe(iva21) + importeDe(neto21)).replace('.', ',')];
const csvMc = (filas) => '﻿"Comprobantes (montos expresados en pesos)"\r\n' + [CAB, ...filas].map((f) => f.map((x) => `"${x}"`).join(';')).join('\r\n') + '\r\n';

test('resumenComprobantes: IVA del mes con notas de crédito restando, filtrando otras fechas', () => {
  const texto = csvMc([
    filaMc('2026-09-01', '1', '2490,50', '11859,50'),
    filaMc('2026-09-15', '1', '210,00', '1000,00'),
    filaMc('2026-09-20', '3', '21,00', '100,00'), // nota de crédito A: resta
    filaMc('2026-08-31', '1', '999,00', '1,00'),  // otro mes: fuera
  ]);
  const r = resumenComprobantes(texto, '2026-09');
  assert.equal(r.comprobantes, 3);
  assert.equal(r.notasCredito, 1);
  assert.equal(r.iva, 2679.5);
  assert.equal(r.netoGravado, 12759.5);
  assert.equal(r.porAlicuota['IVA 21%'], 2679.5);
  assert.equal(parsearCsv('a;"b;c";"d""e"\r\n1;2;3\n').length, 2);
});

// Arma un out/datos de prueba como lo deja una corrida real.
function datosDePrueba({ ddjj = true, pagos = 'octubre', deuda = 0 } = {}) {
  const d = tmp();
  const vig = (id, clave, nombre, headers, rows, entrada = {}) => {
    fs.mkdirSync(path.join(d, id, 'vigente', clave), { recursive: true });
    fs.writeFileSync(path.join(d, id, 'vigente', clave, nombre), toCsv(rows, headers.map((h, i) => ({ header: h, value: (r) => r[i] }))));
    const f = path.join(d, id, 'vigente.json');
    const man = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    man[clave] = { cuando: '2026-10-26T10-00-00', rango: 2, nivel: 'validado', filas: rows.length, archivos: [nombre], ...entrada };
    fs.writeFileSync(f, JSON.stringify(man));
  };
  // Mis Comprobantes (manifiesto propio).
  for (const [id, tipo, filas] of [['comprobantes-emitidos', 'emitidos', [filaMc('2026-09-01', '1', '2100,00', '10000,00')]], ['comprobantes-recibidos', 'recibidos', [filaMc('2026-09-05', '1', '1050,00', '5000,00')]]]) {
    fs.mkdirSync(path.join(d, id), { recursive: true });
    fs.writeFileSync(path.join(d, id, `mc-${tipo}.csv`), csvMc(filas));
    fs.writeFileSync(path.join(d, id, 'manifiesto.json'), JSON.stringify({ [`${tipo}:2026-09-01:2026-09-30`]: { ok: true, fecha: '2026-10-20', archivo: `mc-${tipo}.csv`, filas: 1 } }));
  }
  if (ddjj) vig('portal-iva-ddjj', '2026-09-01_2026-09-30', 'ddjj-iva-2026-09.csv', ['Concepto', 'Importe'],
    [['Total Débito Fiscal', 2100], ['Total Crédito Fiscal', 1050], ['Saldo de impuesto a favor de ARCA', 1050]], { desde: '2026-09-01', hasta: '2026-09-30' });
  vig('portal-iva', 'acumulado', 'portal-iva.csv', ['Período Fiscal', 'Formulario', 'Secuencia', 'Presentación'], [['09/2026', '2051', 'DJ Original', '16/10/2026'], ['08/2026', '2051', 'DJ Original', '16/09/2026']]);
  if (pagos) {
    const clave = pagos === 'octubre' ? '2026-10-01_2026-10-25' : '2026-09-01_2026-09-30';
    vig('ct-pagos', clave, 'ct-pagos.csv', ['Fecha Operación', 'Formulario', 'Versión', 'Impuesto', 'Período Fiscal', 'Importe', 'Observaciones'],
      // En la ventana de octubre se paga el IVA de septiembre; en la de septiembre, el de agosto.
      pagos === 'octubre'
        ? [['17/10/2026', '2051', '1', '30 - IVA', '202609', '1.050,00', ''], ['18/10/2026', '1571', '1', '217 - GANANCIAS', '202609', '9.999,00', '']]
        : [['17/09/2026', '2051', '1', '30 - IVA', '202608', '980,00', '']],
      { desde: clave.slice(0, 10), hasta: clave.slice(11) });
  }
  vig('mis-retenciones', '2026-09-01_2026-09-30', 'mis-retenciones-216-sire-iva-2026-09-01-2026-09-30.csv', ['Impuesto', 'Fecha Retención o Percepción', 'Importe'], [['216', '10/09/2026', '50,00']], { desde: '2026-09-01', hasta: '2026-09-30' });
  vig('cuentas-tributarias', 'acumulado', 'v.csv', ['Impuesto', 'Concepto', 'Subconcepto', 'Período', 'Ant/Cuota', 'Fecha Vencimiento'], [['30 - IVA', '19 - DDJJ', '19', '202609', '0', '20/10/2026']]);
  if (deuda) vig('ct-deudas', 'acumulado', 'd.csv', ['Establecimiento', 'Impuesto', 'Concepto', 'Subconcepto', 'Período', 'Ant/Cuota', 'Vencimiento', 'Saldo'], [['0', '30 - IVA', '19', '51', '202609', '0', '20/10/2026', String(deuda)]]);
  return d;
}

test('informe IVA: conciliado cuando el saldo declarado coincide con los pagos imputados', () => {
  const { objeto, texto } = generarInformeIva(datosDePrueba(), '2026-09');
  assert.equal(objeto.comprobantes.emitidos.iva, 2100);
  assert.equal(objeto.comprobantes.recibidos.iva, 1050);
  assert.equal(objeto.declarado.identificados.saldoAPagar.importe, 1050);
  assert.equal(objeto.pagado, 1050, 'solo el pago de IVA (no el de Ganancias)');
  assert.equal(objeto.conciliacion.estado, 'conciliado');
  assert.equal(objeto.retencionesIva, 50);
  assert.equal(objeto.presentaciones[0].presentacion, '16/10/2026');
  assert.equal(objeto.vencimientos[0].vencimiento, '20/10/2026');
  assert.match(texto, /IVA facturado por proveedores \(no es crédito fiscal computable\)/);
  assert.match(texto, /\*\*CONCILIADO\*\*/);
});

test('informe IVA: sin detalle de DJ -> no determinable; sin pagos posteriores -> lo dice; nada se inventa', () => {
  const sinDj = generarInformeIva(datosDePrueba({ ddjj: false }), '2026-09').objeto;
  assert.equal(sinDj.conciliacion.estado, 'no determinable');
  assert.ok(sinDj.faltantes.some((f) => /portal-iva-ddjj/.test(f)));
  const sinOct = generarInformeIva(datosDePrueba({ pagos: 'septiembre' }), '2026-09').objeto;
  assert.equal(sinOct.pagado, null);
  assert.equal(sinOct.conciliacion.estado, 'pago no verificado');
  assert.ok(sinOct.faltantes.some((f) => /no se consultaron pagos posteriores/.test(f)));
  const conDeuda = generarInformeIva(datosDePrueba({ deuda: 1050 }), '2026-09').objeto;
  assert.ok(conDeuda.avisos.some((a) => /registra deuda de IVA/.test(a)));
  const vacio = generarInformeIva(tmp(), '2026-09').objeto;
  assert.equal(vacio.conciliacion.estado, 'no determinable');
  assert.ok(vacio.faltantes.length >= 4);
});
