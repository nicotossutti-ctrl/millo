import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claveJurisdiccion, conciliarIibb } from '../src/app/iibbConciliacion.js';
import { panelMes, pagosConsultasIibb } from '../src/app/panel.js';
import { importarCm03 } from '../src/app/cm03.js';
import { toCsv } from '../src/csv.js';
import { htmlCm03, pdfDeHtml } from './helpers/cm03.js';

// Todo INVENTADO: importes, fechas y comprobantes.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arca-iibb-'));
const JUR = [
  { jurisdiccion: 'CABA', aPagar: 0 }, { jurisdiccion: 'Buenos Aires', aPagar: 100 },
  { jurisdiccion: 'Córdoba', aPagar: 200 }, { jurisdiccion: 'Santa Fe', aPagar: 300 },
];

test('jurisdicciones: por código o por nombre, con las variantes habituales', () => {
  assert.equal(claveJurisdiccion('902 - Buenos Aires'), '902');
  assert.equal(claveJurisdiccion('Pcia. de Buenos Aires'), '902');
  assert.equal(claveJurisdiccion('Ciudad Autónoma de Buenos Aires'), '901');
  assert.equal(claveJurisdiccion('CABA'), '901');
  assert.equal(claveJurisdiccion('CORDOBA'), '904');
  assert.equal(claveJurisdiccion('Santiago del Estero'), '922');
  assert.equal(claveJurisdiccion('Santa Fe'), '921');
  assert.equal(claveJurisdiccion('Tucumán', '924'), '924');
  assert.equal(claveJurisdiccion('Otra cosa'), null);
});

test('conciliación por jurisdicción: sin consulta «A consultar»; con pagos verificados, saldo por jurisdicción; nunca deuda inventada', () => {
  let c = conciliarIibb({ jurisdicciones: JUR, pagos: [], consultado: false });
  assert.deepEqual(c.filas.filter((f) => f.aPagar > 0).map((f) => [f.jurisdiccion, f.estado, f.saldo, f.saldoTexto]),
    [['Buenos Aires', 'A consultar', null, 'Sin verificar'], ['Córdoba', 'A consultar', null, 'Sin verificar'], ['Santa Fe', 'A consultar', null, 'Sin verificar']]);
  assert.equal(c.total.saldo, null);
  c = conciliarIibb({ jurisdicciones: JUR, consultado: true, pagos: [
    { importe: 100, fecha: '2026-10-14', jurisdiccion: '902 - Buenos Aires', comprobante: 'VEP 1', verificado: true, fuente: 'SIFERE Consultas' },
    { importe: 150, fecha: '2026-10-14', jurisdiccion: 'Córdoba', verificado: true, fuente: 'SIFERE Consultas' },
    { importe: 300, fecha: '2026-10-15', jurisdiccion: null, verificado: true, fuente: 'volante pagado' },
    { importe: 600, fecha: null, jurisdiccion: null, verificado: false, estado: 'Generado', fuente: 'volante' },
  ] });
  const fila = (n) => c.filas.find((f) => f.jurisdiccion === n);
  assert.deepEqual([fila('Buenos Aires').estado, fila('Buenos Aires').saldo, fila('Buenos Aires').pagos[0].comprobante], ['Pagado', 0, 'VEP 1']);
  assert.deepEqual([fila('Córdoba').estado, fila('Córdoba').saldo], ['Pago parcial', 50]);
  assert.deepEqual([fila('Santa Fe').estado, fila('Santa Fe').saldo, fila('Santa Fe').saldoTexto], ['Sin pagos verificados', null, 'Sin verificar']);
  assert.equal(c.sinImputar.length, 1, 'el pago sin jurisdicción no se reparte');
  assert.match(c.sinImputar[0].nota, /pendiente de imputación/);
  assert.equal(c.sinConfirmar.length, 1, 'un volante generado no es un pago');
  assert.equal(c.total.pagadoVerificado, 550); assert.equal(c.total.saldo, null);
  // Cubierto el total (aunque uno no diga jurisdicción): el total queda en 0, cada jurisdicción sin pago propio sigue sin verificar.
  c = conciliarIibb({ jurisdicciones: JUR, consultado: true, pagos: [{ importe: 600, jurisdiccion: null, verificado: true, fuente: 'x' }] });
  assert.equal(c.total.saldo, 0);
  assert.equal(c.filas.find((f) => f.jurisdiccion === 'Santa Fe').saldo, null);
});

/** Lo que deja la consulta de pagos de SIFERE Consultas en out/datos (como cualquier listado conservado). */
function conPagosConsultas(out, filas, headers = ['Anticipo', 'Jurisdicción', 'Fecha de Pago', 'Importe', 'Estado', 'Número VEP']) {
  const d = path.join(out, 'datos', 'sifere-consultas-web-pagos'); const clave = '2026-09-01_2026-10-28';
  fs.mkdirSync(path.join(d, 'vigente', clave), { recursive: true });
  fs.writeFileSync(path.join(d, 'vigente', clave, 'p.csv'), toCsv(filas, headers.map((h, i) => ({ header: h, value: (r) => r[i] }))));
  fs.writeFileSync(path.join(d, 'vigente.json'), JSON.stringify({ [clave]: { cuando: '2026-10-29T10-00-00', nivel: 'validado', archivos: ['p.csv'], desde: '2026-09-01', hasta: '2026-10-28' } }));
}

test('panel: pagos de SIFERE Consultas conciliados contra la CM03 por jurisdicción; el volante del mismo pago no se suma dos veces', async (t) => {
  const pdf = await pdfDeHtml(htmlCm03({ filas: [
    { jurisdiccion: '901 - CABA', determinado: 100, restan: 140, suman: 0, aFavorContribuyente: 40, aFavorFisco: 0, aPagar: 0 },
    { jurisdiccion: '902 - Buenos Aires', determinado: 120, restan: 20, suman: 0, aFavorContribuyente: 0, aFavorFisco: 100, aPagar: 100 },
    { jurisdiccion: '904 - Córdoba', determinado: 220, restan: 20, suman: 0, aFavorContribuyente: 0, aFavorFisco: 200, aPagar: 200 },
  ] }));
  if (!pdf) { t.skip('sin navegador para generar la CM03 de prueba'); return; }
  const out = tmp(); const op = { hoy: '2026-10-29', paramsFile: path.join(out, 'x.json') };
  await importarCm03(out, { nombre: 'cm03.pdf', contenido: pdf, mes: '2026-09' });
  let p = panelMes(out, '2026-09', op);
  assert.deepEqual(p.iibb.conciliacion.filas.filter((f) => f.aPagar > 0).map((f) => f.estado), ['A consultar', 'A consultar']);
  conPagosConsultas(out, [
    ['202609', '902 - Buenos Aires', '14/10/2026', '100,00', 'Pagado', '555000111'],
    ['202609', '904 - Córdoba', '15/10/2026', '200,00', 'Pendiente', '555000112'],
    ['202608', '904 - Córdoba', '14/09/2026', '50,00', 'Pagado', '555000113'],
  ]);
  // Un volante de SIFERE DDJJ pagado por el mismo importe que el pago de Buenos Aires: es el mismo pago.
  const dv = path.join(out, 'datos', 'sifere-consultas-volantes-pago', 'vigente', 'acumulado'); fs.mkdirSync(dv, { recursive: true });
  fs.writeFileSync(path.join(dv, 'v.csv'), toCsv([['', '202609 - 0', '13/10/2026', '100,00', 'VEP', 'Pagado']], ['Acciones', 'Anticipo', 'Fecha Generación', 'Monto Total', 'Medio de Pago', 'Estado'].map((h, i) => ({ header: h, value: (r) => r[i] }))));
  fs.writeFileSync(path.join(out, 'datos', 'sifere-consultas-volantes-pago', 'vigente.json'), JSON.stringify({ acumulado: { cuando: 'c', nivel: 'validado', archivos: ['v.csv'] } }));
  assert.equal(pagosConsultasIibb(path.join(out, 'datos'), '2026-09').pagos.length, 2, 'solo el período 09/2026');
  p = panelMes(out, '2026-09', op);
  const c = p.iibb.conciliacion;
  const ba = c.filas.find((f) => f.codigo === '902'); const cba = c.filas.find((f) => f.codigo === '904');
  assert.deepEqual([ba.estado, ba.pagado, ba.saldo, ba.pagos[0].fecha], ['Pagado', 100, 0, '2026-10-14']);
  assert.deepEqual([cba.estado, cba.saldo], ['Sin pagos verificados', null], 'un pago «Pendiente» no cuenta');
  assert.equal(c.sinConfirmar.length, 1);
  assert.equal(c.sinImputar.length, 0, 'el volante pagado es el mismo pago de la consulta');
  assert.equal(p.iibb.pagos.valor, 100, 'el total pagado no se duplica');
  assert.equal(p.iibb.saldoPendiente.valor, null, 'con una jurisdicción sin verificar, el saldo total no se afirma');
});
