import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importeAr, agruparLineas, leerCm03, lineasDePdf, importarCm03, listarCm03, cm03DelPeriodo, eliminarCm03 } from '../src/app/cm03.js';
import { panelMes, saldoIibb, cifra } from '../src/app/panel.js';
import { pendientesDeCarga } from '../src/app/pendientes.js';
import { guardarManual } from '../src/app/manuales.js';
import { toCsv } from '../src/csv.js';
import { htmlCm03, pdfDeHtml } from './helpers/cm03.js';

// Todo es SINTÉTICO: jurisdicciones e importes inventados (el ejemplo de la revisión: 100 + 80 determinado, 140 + 50 de
// créditos → una a favor 40, la otra a pagar 30).
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arca-cm03-'));
const DOS = [
  { jurisdiccion: '901 - Uno', determinado: 100, restan: 140, suman: 0, aFavorContribuyente: 40, aFavorFisco: 0, aPagar: 0 },
  { jurisdiccion: '902 - Dos Provincia', determinado: 80, restan: 50, suman: 0, aFavorContribuyente: 0, aFavorFisco: 30, aPagar: 30 },
];
const TRES = [...DOS, { jurisdiccion: '903 - Tres', determinado: 1234567.89, restan: 1000, suman: 0, aFavorContribuyente: 0, aFavorFisco: 1233567.89, aPagar: 1233567.89 }];

/** Líneas como las arma lineasDePdf, a partir de renglones [[texto, x], …] (de arriba hacia abajo). */
const lineas = (renglones) => [{ pagina: 1, lineas: agruparLineas(renglones.flatMap((r, i) => r.map(([str, x]) => ({ str, x, y: 800 - i * 12, w: str.length * 5, alto: 9 })))) }];
const TITULOS = [[['Jurisdicciones incluidas', 10]], [['Anticipo Impuesto', 100], ['Valores', 200], ['Valores', 280], ['A Favor', 360], ['A Favor', 440], ['A', 520]],
  [['Jurisdicción', 10], ['Determinado', 100], ['Restan', 200], ['Suman', 280], ['Contribuyente', 350], ['Fisco', 440], ['Pagar', 515]]];
const COLX = [110, 205, 285, 370, 445, 520];
const fila = (nombre, vs) => [[nombre, 10], ...vs.map((v, k) => [v, COLX[k]])];
const caratula = (extra = []) => [[['Período: 202609', 10]], [['Original', 10]], [['Estado: PRESENTADA', 10]], [['Fecha de Presentación: 15/10/2026 10:20:30', 10]], ...extra];

test('importes argentinos: con miles, decimales y signo; lo que no es importe es null (nunca 0)', () => {
  assert.equal(importeAr('7.654.321,09'), 7654321.09);
  assert.equal(importeAr('0,00'), 0);
  assert.equal(importeAr('$123.456,70'), 123456.7);
  assert.equal(importeAr('-1.234,50'), -1234.5);
  assert.equal(importeAr('(10,00)'), -10);
  for (const x of ['', 'CABA', '1234', '1.234', '12,3', '1,234.56', null]) assert.equal(importeAr(x), null, String(x));
});

test('CM03: lee las seis columnas por jurisdicción; determinado ≠ total a pagar; los saldos a favor no se compensan entre jurisdicciones', () => {
  const r = leerCm03(lineas([...caratula(), ...TITULOS, fila('901 - Uno', ['100,00', '140,00', '0,00', '40,00', '0,00', '0,00']),
    fila('902 - Dos Provincia', ['80,00', '50,00', '0,00', '0,00', '30,00', '30,00']), fila('TOTALES', ['180,00', '190,00', '0,00', '40,00', '30,00', '30,00']),
    [['Total a pagar: $ 30,00', 10]]]), { mes: '2026-09' });
  assert.equal(r.estado, 'valida', r.motivos.join('; '));
  assert.equal(r.periodo, '2026-09'); assert.equal(r.rectificativa, 0); assert.equal(r.estadoDj, 'PRESENTADA'); assert.equal(r.fechaPresentacion, '2026-10-15 10:20:30');
  assert.deepEqual(r.jurisdicciones.map((j) => [j.codigo, j.jurisdiccion, j.aFavorContribuyente, j.aPagar]), [['901', 'Uno', 40, 0], ['902', 'Dos Provincia', 0, 30]]);
  assert.equal(r.impuestoDeterminadoTotal, 180);
  assert.equal(r.totalAPagarDeclarado, 30, 'no 180 (determinado) ni −10 (neteo entre jurisdicciones)');
  assert.equal(r.aFavorContribuyenteTotal, 40);
});

test('CM03 en revisión (nunca se completa con 0): totales que no cierran, celdas vacías, otro período, borrador, columnas desconocidas', () => {
  const base = (cambios = {}) => [...(cambios.caratula ?? caratula()), ...(cambios.titulos ?? TITULOS),
    fila('901 - Uno', cambios.uno ?? ['100,00', '140,00', '0,00', '40,00', '0,00', '0,00']), fila('902 - Dos', ['80,00', '50,00', '0,00', '0,00', '30,00', '30,00']),
    fila('TOTALES', cambios.totales ?? ['180,00', '190,00', '0,00', '40,00', '30,00', '30,00']), [[`Total a pagar: $ ${cambios.totalAPagar ?? '30,00'}`, 10]]];
  const motivo = (cambios, mes = '2026-09') => { const r = leerCm03(lineas(base(cambios)), { mes }); assert.equal(r.estado, 'revision'); return r.motivos.join(' | '); };
  assert.match(motivo({ totales: ['181,00', '190,00', '0,00', '40,00', '30,00', '30,00'] }), /Determinado.*suman 180.*TOTALES dice 181/);
  assert.match(motivo({ totalAPagar: '31,00' }), /Total a pagar.*no coincide/);
  assert.match(motivo({ uno: ['100,00', '140,00', '0,00', '40,00', '0,00'] }), /no se pudo leer \(5 importe/);
  assert.match(motivo({}, '2026-08'), /período 2026-09, no de 2026-08/);
  assert.match(motivo({ caratula: [[['Período: 202609', 10]], [['Original', 10]], [['Estado: BORRADOR', 10]]] }), /no dice PRESENTADA/);
  assert.match(motivo({ caratula: [[['Estado: PRESENTADA', 10]], [['Original', 10]]] }), /no se encontró el período/);
  assert.match(motivo({ caratula: [[['Período: 202609', 10]], [['Estado: PRESENTADA', 10]]] }), /original o una rectificativa/);
  assert.match(motivo({ titulos: [TITULOS[0], [['Jurisdicción', 10], ['Importe', 100], ['Otro', 200]]] }), /no se reconocen las columnas/);
  // Columnas en otro orden: A Pagar antes que A Favor Fisco.
  const cambiado = [TITULOS[0], TITULOS[1], [['Jurisdicción', 10], ['Determinado', 100], ['Restan', 200], ['Suman', 280], ['Contribuyente', 350], ['Pagar', 440], ['Fisco', 515]]];
  assert.match(motivo({ titulos: cambiado }), /orden esperado/);
});

test('CM03: la fecha con el rótulo del reporte real («Datos Presentación Arca: DDJJ presentada el …»)', () => {
  const r = leerCm03(lineas([[['Período: 202609', 10]], [['Original', 10]], [['Estado: PRESENTADA', 10]],
    [['Datos Presentación Arca: DDJJ presentada el 14/10/2026 - 09:08:07 ante ARCA', 10]], ...TITULOS,
    fila('901 - Uno', ['10,00', '0,00', '0,00', '0,00', '10,00', '10,00']), fila('TOTALES', ['10,00', '0,00', '0,00', '0,00', '10,00', '10,00']), [['Total a pagar: $ 10,00', 10]]]));
  assert.equal(r.estado, 'valida', r.motivos.join('; '));
  assert.equal(r.fechaPresentacion, '2026-10-14 09:08:07');
  assert.deepEqual(r.avisos, []);
});

test('CM03 rectificativa: el número sale de la carátula', () => {
  const r = leerCm03(lineas([[['Período: 202609', 10]], [['Rectificativa: 2', 10]], [['Estado: PRESENTADA', 10]], ...TITULOS,
    fila('901 - Uno', ['10,00', '0,00', '0,00', '0,00', '10,00', '10,00']), fila('TOTALES', ['10,00', '0,00', '0,00', '0,00', '10,00', '10,00'])]));
  assert.equal(r.estado, 'valida', r.motivos.join('; '));
  assert.equal(r.rectificativa, 2);
  assert.match(r.avisos.join(' '), /Total a pagar/, 'sin la línea «Total a pagar» se avisa y se usa la fila TOTALES');
});

/** PDF sintético (con el navegador de las pruebas). */
async function pdf(t, opciones) {
  const b = await pdfDeHtml(htmlCm03(opciones));
  if (!b) t.skip('sin navegador para generar el PDF de prueba');
  return b;
}

test('PDF real de texto (sintético): se lee sin OCR, con la página de «Determinación del anticipo» como evidencia que no se suma', async (t) => {
  const b = await pdf(t, { filas: TRES, detalle: { jurisdiccion: 'Uno', conceptos: [['Saldo a favor período anterior', 10.5], ['Percepciones', 2000.25]] } });
  if (!b) return;
  const r = leerCm03(await lineasDePdf(b), { mes: '2026-09' });
  assert.equal(r.estado, 'valida', r.motivos.join('; '));
  assert.equal(r.jurisdicciones.length, 3);
  assert.equal(r.impuestoDeterminadoTotal, 1234747.89);
  assert.equal(r.totalAPagarDeclarado, 1233597.89);
  assert.deepEqual(r.detalles, [{ jurisdiccion: 'Uno', pagina: 2, conceptos: [{ concepto: 'Saldo a favor período anterior', importe: 10.5 }, { concepto: 'Percepciones', importe: 2000.25 }] }]);
  // Una columna menos en el PDF: en revisión.
  const sin = await pdf(t, { filas: TRES, quitarColumna: 2 });
  assert.equal(leerCm03(await lineasDePdf(sin), { mes: '2026-09' }).estado, 'revision');
});

test('guardado: el mismo PDF no se importa dos veces; una rectificativa posterior no se reemplaza por una anterior; misma versión con otros importes se rechaza', async (t) => {
  const out = tmp();
  const original = await pdf(t, { filas: DOS }); if (!original) return;
  const a = await importarCm03(out, { nombre: 'cm03-original.pdf', contenido: original.toString('base64'), mes: '2026-09' });
  assert.equal(a.estado, 'valida', a.motivos.join('; '));
  assert.equal((await importarCm03(out, { nombre: 'otra-vez.pdf', contenido: original, mes: '2026-09' })).yaImportado, true);
  assert.equal(listarCm03(out).length, 1);
  assert.ok(fs.existsSync(path.join(out, 'importados', 'cm03', 'archivos', `${a.hash}.pdf`)), 'el PDF queda guardado, local');
  const filasR1 = DOS.map((f) => (f.aPagar ? { ...f, determinado: 90, aFavorFisco: 40, aPagar: 40 } : f));
  const r1 = await importarCm03(out, { nombre: 'cm03-r1.pdf', contenido: await pdf(t, { filas: filasR1, rectificativa: 1 }) });
  assert.equal(r1.rectificativa, 1);
  assert.equal(cm03DelPeriodo(out, '2026-09').vigente.rectificativa, 1);
  // La original otra vez (otra impresión, mismos importes, otra fecha): se guarda, pero la vigente sigue siendo la rectificativa.
  await importarCm03(out, { nombre: 'cm03-original-reimpresa.pdf', contenido: await pdf(t, { filas: DOS, fecha: '16/10/2026 09:00:00' }) });
  assert.equal(cm03DelPeriodo(out, '2026-09').vigente.rectificativa, 1);
  assert.equal(cm03DelPeriodo(out, '2026-09').vigente.totalAPagarDeclarado, 40);
  // Otra copia de la rectificativa 1 con otros importes: hay que ver cuál es la correcta.
  await assert.rejects(importarCm03(out, { nombre: 'cm03-r1-b.pdf', contenido: await pdf(t, { filas: DOS, rectificativa: 1 }) }), /otros importes/);
  // En revisión: se guarda como evidencia pero no se usa.
  const mala = await importarCm03(out, { nombre: 'borrador.pdf', contenido: await pdf(t, { filas: DOS, estado: 'BORRADOR', periodo: '202608' }), mes: '2026-08' });
  assert.equal(mala.estado, 'revision');
  assert.equal(cm03DelPeriodo(out, '2026-08').vigente, null);
  assert.equal(cm03DelPeriodo(out, '2026-08').enRevision.length, 1);
  await assert.rejects(importarCm03(out, { nombre: 'x.pdf', contenido: Buffer.from('no es un pdf') }), /no es un PDF/);
  eliminarCm03(out, r1.id);
  assert.equal(cm03DelPeriodo(out, '2026-09').vigente.rectificativa, 0);
});

test('saldo de IIBB: total a pagar de la CM03 − pagos comprobados; con varias jurisdicciones y un pago parcial, «sin conciliar»', () => {
  const ap = (v) => cifra(v, 'importado', 'CM03');
  const pago = (v, nivel = 'verificado') => cifra(v, nivel, 'x');
  assert.equal(saldoIibb(cifra(null), []).valor, null);
  assert.equal(saldoIibb(ap(0), []).valor, 0);
  assert.match(saldoIibb(ap(30), []).nota, /no prueba que esté impago/);
  assert.equal(saldoIibb(ap(30), []).valor, null, 'sin pagos: sin conciliar, no 30');
  assert.equal(saldoIibb(ap(30), []).diferencia, 30);
  assert.equal(saldoIibb(ap(30), [pago(30)]).valor, 0);
  const una = saldoIibb(ap(30), [pago(20)], DOS);
  assert.equal(una.valor, 10, 'una sola jurisdicción con saldo a pagar: el pago es de ella');
  assert.match(una.nota, /Dos Provincia/);
  const varias = saldoIibb(ap(70), [pago(20)], [...DOS, { jurisdiccion: 'Tres', aPagar: 40 }]);
  assert.equal(varias.valor, null, 'no se afirma cuánto se debe en cada una');
  assert.equal(varias.diferencia, 50);
  assert.match(varias.nota, /sin conciliar/);
});

test('panel y cartel con la CM03 importada: el determinado sale del cartel, el pago no; la rectificativa posterior de SIFERE se pide', async (t) => {
  const out = tmp(); const op = { hoy: '2026-10-28', paramsFile: path.join(out, 'x.json') };
  const antes = pendientesDeCarga(out, op.hoy, op).find((x) => x.clave === 'iibb-declarado:2026-09');
  assert.equal(antes.accion.tipo, 'cm03');
  assert.match(antes.como, /Reporte/);
  const b = await pdf(t, { filas: DOS }); if (!b) return;
  await importarCm03(out, { nombre: 'cm03.pdf', contenido: b, mes: '2026-09' });
  const p = panelMes(out, '2026-09', op);
  assert.equal(p.iibb.declarado.valor, 180); assert.equal(p.iibb.declarado.nivel, 'importado');
  assert.equal(p.iibb.aPagar.valor, 30);
  assert.equal(p.iibb.aFavorContribuyente.valor, 40);
  assert.deepEqual(p.iibb.porJurisdiccion.map((j) => [j.jurisdiccion, j.aPagar]), [['Uno', 0], ['Dos Provincia', 30]]);
  assert.equal(p.iibb.estado, 'pago no encontrado (sin cobertura)', 'presentada no es pagada');
  assert.equal(p.iibb.saldoPendiente.valor, null, 'sin pagos encontrados no hay saldo verificado: lo declarado no es la deuda de hoy');
  assert.match(p.iibb.saldoPendiente.nota, /sin conciliar/);
  const { resumenImpuestos } = await import('../src/app/resumenImpuestos.js');
  const fila = resumenImpuestos(out, { ...op, mes: '2026-09' }).impuestos.find((x) => x.impuesto === 'Ingresos Brutos');
  assert.equal(fila.aPagar.valor, 30, 'el total a pagar de la CM03 se muestra aparte');
  assert.equal(fila.saldo.valor, null);
  let claves = pendientesDeCarga(out, op.hoy, op).filter((x) => x.mes === '2026-09').map((x) => x.clave.split(':')[0]);
  assert.ok(!claves.includes('iibb-declarado') && !claves.includes('iibb-a-pagar-segun-cm03'), 'la CM03 ya no se pide');
  assert.ok(claves.includes('iibb-pagado'), 'el pago se sigue pidiendo');
  guardarManual(out, { mes: '2026-09', concepto: 'iibb-pagado', importe: 20, fuente: 'VEP', fechaPago: '2026-10-20' });
  assert.equal(panelMes(out, '2026-09', op).iibb.saldoPendiente.valor, 10);
  // SIFERE muestra presentada la rectificativa 1: se pide su reporte y se avisa.
  const d = path.join(out, 'datos', 'sifere-consultas-ddjj-mensuales'); fs.mkdirSync(path.join(d, 'vigente', 'a'), { recursive: true });
  fs.writeFileSync(path.join(d, 'vigente', 'a', 'l.csv'), toCsv([['202609 - 1', 'Presentada', '20/10/2026 11:00:00']], ['Anticipo', 'Estado', 'Fecha Presentación'].map((h, i) => ({ header: h, value: (r) => r[i] }))));
  fs.writeFileSync(path.join(d, 'vigente.json'), JSON.stringify({ a: { cuando: 'c', nivel: 'validado', archivos: ['l.csv'] } }));
  claves = pendientesDeCarga(out, op.hoy, op).filter((x) => x.mes === '2026-09').map((x) => x.clave.split(':')[0]);
  assert.ok(claves.includes('iibb-rectificativa'));
  assert.match(panelMes(out, '2026-09', op).iibb.avisos.join(' '), /rectificativa 1/);
});

test('servidor: se sube el PDF de la CM03 y se lista; un archivo que no es PDF da error', async (t) => {
  const { crearServidor } = await import('../src/app/servidor.js');
  const b = await pdf(t, { filas: DOS }); if (!b) return;
  const out = tmp(); const puerto = 43000 + Math.floor(Math.random() * 1000);
  const s = crearServidor({ outDir: out, hoy: '2026-10-28', puerto, paramsFile: path.join(out, 'x.json') });
  await new Promise((ok) => s.listen(puerto, '127.0.0.1', ok));
  try {
    const base = `http://127.0.0.1:${puerto}`;
    const post = (ruta, cuerpo) => fetch(`${base}${ruta}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(cuerpo) });
    const r = await post('/api/cm03/importar', { nombre: 'cm03.pdf', contenido: b.toString('base64'), mes: '2026-09' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).totalAPagarDeclarado, 30);
    const lista = await (await fetch(`${base}/api/cm03`)).json();
    assert.equal(lista.length, 1); assert.equal(lista[0].estado, 'valida');
    assert.equal((await post('/api/cm03/importar', { nombre: 'x.pdf', contenido: Buffer.from('hola').toString('base64') })).status, 400);
    const panel = await (await fetch(`${base}/api/panel?mes=2026-09`)).json();
    assert.equal(panel.iibb.aPagar.valor, 30);
  } finally { await new Promise((ok) => s.close(ok)); }
});
