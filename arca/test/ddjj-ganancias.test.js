import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconocer, mapaDeBits, lineasType3, diccionario } from '../src/app/glifos.js';
import { leerDdjjGanancias, importarDdjjGanancias, ddjjGananciasDelAnio, eliminarDdjjGanancias } from '../src/app/ddjjGanancias.js';
import { importarPdfFiscal } from '../src/app/pdfFiscal.js';
import { panelMes, djAnualLeida } from '../src/app/panel.js';
import { pendientesDeCarga } from '../src/app/pendientes.js';
import { toCsv } from '../src/csv.js';
import { pdfType3, renglonesF2711 } from './helpers/type3.js';

// Todo es SINTÉTICO: PDFs con una fuente Type3 dibujada con las formas del diccionario y datos inventados.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arca-gan-'));
const texto = async (buf) => (await lineasType3(buf)).flatMap((p) => p.lineas.map((l) => l.palabras.map((w) => w.texto).join(' ')));

test('glifos: el diccionario tiene las diez cifras, la coma, el punto y el signo $ (lo que hace falta para los importes)', () => {
  const chars = new Set([...diccionario().exactos.values()]);
  for (const c of '0123456789,.$-/') assert.ok(chars.has(c), c);
});

test('glifos: un dibujo que no se parece a ninguna letra queda «?» (nunca se adivina); un glifo sin dibujo es un espacio', () => {
  const mancha = [[[-0.1, -0.25], [1.1, -0.25], [1.1, 0.95], [-0.1, 0.95]]]; // todo lleno
  assert.equal(reconocer(mancha).ch, '?');
  assert.equal(reconocer([]).ch, ' ');
  // Un rectángulo chico a media altura: «-».
  assert.equal(mapaDeBits([[[0.1, 0.25], [0.4, 0.25], [0.4, 0.32], [0.1, 0.32]]]).reduce((n, b) => n + b, 0) > 0, true);
});

test('fuente Type3 «dibujada» (códigos por orden de aparición, sin tabla de caracteres): se lee igual, también los códigos 9, 10 y 13', async () => {
  // Con «DECLARACIÓN JURADA», la «J» y la «U» caen en los códigos 10 y 11; una extracción común los vuelve espacios.
  const lineas = await texto(pdfType3([{ texto: 'DECLARACIÓN JURADA SIMPLIFICADA', x: 20, y: 700 }, { texto: 'Pagos $ 1.234.567,89', x: 20, y: 680 }]));
  assert.deepEqual(lineas, ['DECLARACIÓN JURADA SIMPLIFICADA', 'Pagos $ 1.234.567,89']);
});

test('F.2711: impuesto determinado, pagos a cuenta y saldo; la cuenta tiene que cerrar al centavo', async () => {
  const r = leerDdjjGanancias(await lineasType3(pdfType3(renglonesF2711())), { anio: '2024' });
  assert.equal(r.estado, 'valida', r.motivos.join('; '));
  assert.deepEqual([r.formulario, r.anio, r.secuencia, r.fechaPresentacion], ['2711', '2024', 0, '2025-06-12']);
  assert.deepEqual([r.impuestoDeterminado, r.pagosACuenta, r.saldoAFavorArca, r.saldoAFavorContribuyente], [1500, 400, 1100, 0]);
  // Saldo a favor del contribuyente.
  const c = leerDdjjGanancias(await lineasType3(pdfType3(renglonesF2711({ determinado: 300, pagos: 500, arca: null, contribuyente: 200 }))));
  assert.equal(c.estado, 'valida', c.motivos.join('; '));
  assert.equal(c.saldoAFavorContribuyente, 200);
});

test('F.2711 en revisión: la cuenta no cierra, otro año, una cifra no reconocida, falta la secuencia', async () => {
  const motivo = async (o, opciones) => { const r = leerDdjjGanancias(await lineasType3(pdfType3(renglonesF2711(o))), opciones); assert.equal(r.estado, 'revision'); return r.motivos.join(' | '); };
  assert.match(await motivo({ arca: 1000 }), /no da el saldo/);
  assert.match(await motivo({}, { anio: '2023' }), /período 2024, no de 2023/);
  assert.match(await motivo({ secuencia: 'Pendiente' }), /secuencia/);
  // Un «7» dibujado distinto (no está en el diccionario): queda «?» y el importe no se puede leer.
  const raro = '0.1 0.1 0.05 0.6 re\n0.5 0.1 0.05 0.6 re\n0.1 0.65 0.45 0.05 re\n0.25 0.3 0.1 0.1 re';
  const r = leerDdjjGanancias(await lineasType3(pdfType3(renglonesF2711({ determinado: 1700, pagos: 600, arca: 1100 }), { dibujoPropio: { 7: raro } })));
  assert.equal(r.estado, 'revision');
  assert.match(r.motivos.join(' '), /Impuesto determinado total|no da el saldo/);
});

test('guardado: el mismo PDF no se importa dos veces; la rectificativa gana; misma secuencia con otros importes se rechaza; se reconoce sin decir qué es', async () => {
  const out = tmp();
  const original = pdfType3(renglonesF2711());
  const a = await importarPdfFiscal(out, { nombre: 'dj-2024.pdf', contenido: original.toString('base64') });
  assert.equal(a.documento, 'ddjj-ganancias'); assert.equal(a.estado, 'valida', a.motivos.join('; '));
  assert.equal((await importarDdjjGanancias(out, { nombre: 'otra.pdf', contenido: original })).yaImportado, true);
  const r1 = await importarDdjjGanancias(out, { nombre: 'rect.pdf', contenido: pdfType3(renglonesF2711({ secuencia: '1', determinado: 1600, arca: 1200 })) });
  assert.equal(r1.secuencia, 1);
  assert.equal(ddjjGananciasDelAnio(out, 2024).vigente.impuestoDeterminado, 1600);
  await assert.rejects(importarDdjjGanancias(out, { nombre: 'rect-b.pdf', contenido: pdfType3(renglonesF2711({ secuencia: '1', fecha: '13/06/2025' })) }), /otros importes/);
  const mala = await importarDdjjGanancias(out, { nombre: 'mala.pdf', contenido: pdfType3(renglonesF2711({ anio: '2023', arca: 1 })) });
  assert.equal(mala.estado, 'revision');
  assert.equal(ddjjGananciasDelAnio(out, 2023).vigente, null);
  eliminarDdjjGanancias(out, r1.id);
  assert.equal(ddjjGananciasDelAnio(out, 2024).vigente.secuencia, 0);
});

test('panel y cartel: con la DJ leída sale el pedido; el saldo declarado se concilia con los pagos de Cuentas Tributarias posteriores a la presentación', async () => {
  const out = tmp(); const op = { hoy: '2025-08-20', paramsFile: path.join(out, 'x.json') };
  assert.ok(pendientesDeCarga(out, op.hoy, op).some((x) => x.clave === 'ganancias-determinado:2024' && x.accion.tipo === 'ddjj-ganancias'));
  await importarDdjjGanancias(out, { nombre: 'dj.pdf', contenido: pdfType3(renglonesF2711()) });
  assert.ok(!pendientesDeCarga(out, op.hoy, op).some((x) => x.clave.startsWith('ganancias-determinado')));
  let p = panelMes(out, '2025-07', op);
  assert.equal(p.ganancias.djAnterior.valor, 1500);
  assert.equal(p.ganancias.djAnual.saldoDeclarado.valor, 1100);
  assert.equal(p.ganancias.djAnual.restante.valor, null, 'sin pagos posteriores: sin conciliar, no «impago»');
  assert.match(p.ganancias.djAnual.restante.nota, /no prueba que esté impago/);
  // Pago del saldo en Cuentas Tributarias (período 2024, después de presentar) y un anticipo anterior que no cuenta.
  const d = path.join(out, 'datos', 'ct-pagos', 'vigente', '2025-01-01_2025-08-19'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'p.csv'), toCsv([['20/06/2025', '711', '1', '11 - GANANCIAS PERSONAS HUMANAS', '202400', '1.100,00'], ['15/02/2025', '1571', '1', '11 - GANANCIAS PERSONAS HUMANAS', '202400', '50,00']],
    ['Fecha Operación', 'Formulario', 'Versión', 'Impuesto', 'Período Fiscal', 'Importe'].map((h, i) => ({ header: h, value: (r) => r[i] }))));
  fs.writeFileSync(path.join(out, 'datos', 'ct-pagos', 'vigente.json'), JSON.stringify({ '2025-01-01_2025-08-19': { cuando: 'c', nivel: 'validado', archivos: ['p.csv'], desde: '2025-01-01', hasta: '2025-08-19' } }));
  const dj = djAnualLeida(out, path.join(out, 'datos'), 2024);
  assert.equal(dj.pagosPosteriores.valor, 1100);
  assert.equal(dj.restante.valor, 0);
});
