import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rangos, candidatos, validarArchivo } from '../src/portal/misComprobantes.js';

test('rangos parte el período en tramos de hasta 365 días', () => {
  assert.deepEqual(rangos('2026-01-01', '2026-03-31'), [['2026-01-01', '2026-03-31']]);
  const r = rangos('2025-01-01', '2026-10-19');
  assert.equal(r[0][0], '2025-01-01');
  assert.equal(r.at(-1)[1], '2026-10-19');
  assert.ok(r.every(([a, b]) => (new Date(b) - new Date(a)) / 86400000 <= 364));
});

test('candidatos elige fecha, buscar y exportar a partir del relevamiento', () => {
  const rel = { frames: [{ principal: true, inputs: [
    { tag: 'input', id: 'fechaEmision', visible: true, type: 'text' },
    { tag: 'input', id: 'nroDoc', visible: true, type: 'text' },
    { tag: 'input', id: 'fechaOculta', visible: false, type: 'hidden' },
  ], botones: [{ tag: 'button', id: 'buscarComprobantes', text: 'Buscar', visible: true }, { tag: 'button', text: 'Volver', visible: true }],
  enlaces: [{ tag: 'a', text: 'CSV', cls: 'buttons-csv', visible: true }], conRol: [{ role: 'grid' }] }] };
  const c = candidatos(rel);
  assert.deepEqual(c.fecha.map((x) => x.id), ['fechaEmision']);
  assert.deepEqual(c.buscar.map((x) => x.id), ['buscarComprobantes']);
  assert.deepEqual(c.exportar.map((x) => x.text), ['CSV']);
  assert.equal(c.tabla, 1);
});

test('validarArchivo acepta un CSV con fechas dentro del rango y rechaza uno fuera', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-mc-'));
  const f = path.join(dir, 'a.csv');
  fs.writeFileSync(f, '﻿Fecha de Emisión;Tipo de Comprobante;Punto de Venta;Número Desde;Imp. Total\r\n05/03/2026;1;1;10;1210,00\r\n20/03/2026;3;1;2;-100,00\r\n');
  const ok = validarArchivo(f, '2026-03-01', '2026-03-31');
  assert.equal(ok.ok, true);
  assert.equal(ok.filas, 2);
  assert.equal(ok.separador, ';');
  assert.equal(ok.columnaFecha, 'Fecha de Emisión');
  const mal = validarArchivo(f, '2026-04-01', '2026-04-30');
  assert.equal(mal.ok, false);
  assert.equal(mal.fueraDelRango, 2);
  fs.writeFileSync(f, 'Fecha\r\n');
  assert.equal(validarArchivo(f, '2026-03-01', '2026-03-31').ok, false);
});

test('resumenResultados describe tablas, paginación, exportación y mensajes', async () => {
  const { resumenResultados } = await import('../src/portal/misComprobantes.js');
  const rel = { frames: [{ principal: true, inputs: [], botones: [{ tag: 'button', text: 'Excel', cls: 'buttons-excel', visible: true }], enlaces: [],
    tablas: [{ id: 'tablaDataTables', visible: true, filas: 25, encabezados: ['Fecha', 'Tipo', 'Total'] }, { id: 'oculta', visible: false, filas: 0, encabezados: [] }],
    paginacion: [{ text: 'Mostrando 1 a 25 de 61 registros' }], mensajes: [], conRol: [] }] };
  const r = resumenResultados(rel);
  assert.equal(r.tablasVisibles.length, 1);
  assert.equal(r.tablasVisibles[0].filas, 25);
  assert.deepEqual(r.paginacion, ['Mostrando 1 a 25 de 61 registros']);
  assert.deepEqual(r.exportacion.map((e) => e.texto), ['Excel']);
});

test('validarContenidoCsv detecta duplicados por comprobante y fechas fuera de rango', async () => {
  const { validarContenidoCsv } = await import('../src/portal/misComprobantes.js');
  const cab = 'Fecha de Emisión;Tipo de Comprobante;Punto de Venta;Número Desde;Imp. Total';
  const ok = validarContenidoCsv(`${cab}\n05/09/2026;1;1;10;100,00\n06/09/2026;1;1;11;200,00`, '2026-09-01', '2026-09-30');
  assert.equal(ok.ok, true);
  assert.equal(ok.filas, 2);
  assert.equal(ok.duplicados, 0);
  const dup = validarContenidoCsv(`${cab}\n05/09/2026;1;1;10;100,00\n05/09/2026;1;1;10;100,00`, '2026-09-01', '2026-09-30');
  assert.equal(dup.ok, false);
  assert.equal(dup.duplicados, 1);
  const fuera = validarContenidoCsv(`${cab}\n05/10/2026;1;1;10;100,00`, '2026-09-01', '2026-09-30');
  assert.equal(fuera.ok, false);
  assert.equal(fuera.fueraDelRango, 1);
});

test('validarContenidoCsv valida solo el período aunque el CSV traiga todo el historial (caso Emitidos)', async () => {
  const { validarContenidoCsv } = await import('../src/portal/misComprobantes.js');
  const cab = 'Fecha de Emisión;Tipo de Comprobante;Punto de Venta;Número Desde;Imp. Total';
  // 2 de septiembre (en rango) + 3 de otros meses (historial): debe contar 2 y no marcar duplicados.
  const texto = `${cab}\n` + [
    '05/09/2026;1;1;10;100,00', '18/09/2026;1;1;11;200,00',
    '05/01/2025;1;1;10;100,00', '05/02/2025;1;1;11;200,00', '09/09/2025;1;2;3;50,00',
  ].join('\n');
  const v = validarContenidoCsv(texto, '2026-09-01', '2026-09-30');
  assert.equal(v.ok, true, 'el subconjunto de septiembre es válido');
  assert.equal(v.filas, 2, 'cuenta solo las filas del período');
  assert.equal(v.filasTotales, 5, 'informa el total del archivo');
  assert.equal(v.dentroDelRango, 2);
  assert.equal(v.fueraDelRango, 3);
  assert.equal(v.duplicados, 0, 'no hay falsos duplicados entre períodos');
});

test('validarArchivo procesa un ZIP con CSV adentro y extrae el CSV', async () => {
  const { validarArchivo } = await import('../src/portal/misComprobantes.js');
  const { armarZip } = await import('./zip.test.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-zip-'));
  const zip = path.join(dir, 'mis-comprobantes-recibidos-2026-09-01-2026-09-30.zip');
  fs.writeFileSync(zip, armarZip('comprobantes.csv', 'Fecha;Número Desde;Total\r\n10/09/2026;5;100,00\r\n11/09/2026;6;200,00\r\n'));
  const v = validarArchivo(zip, '2026-09-01', '2026-09-30');
  assert.equal(v.ok, true);
  assert.equal(v.filas, 2);
  assert.deepEqual(v.csv, ['comprobantes.csv']);
  assert.ok(fs.existsSync(path.join(dir, 'mis-comprobantes-recibidos-2026-09-01-2026-09-30-csv', 'comprobantes.csv')));
});

test('el manifiesto registra y relee períodos verificados', async () => {
  const { leerManifiesto, registrarManifiesto, claveManifiesto } = await import('../src/portal/misComprobantes.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-man-'));
  assert.deepEqual(leerManifiesto(dir), {});
  const clave = claveManifiesto('recibidos', '2026-09-01', '2026-09-30');
  registrarManifiesto(dir, clave, { fecha: '2026-10-19', filas: 20, hash: 'abc' });
  assert.equal(leerManifiesto(dir)[clave].filas, 20);
});

test('totalInformado lee el total de la paginación de ARCA en varios formatos', async () => {
  const { totalInformado } = await import('../src/portal/misComprobantes.js');
  assert.equal(totalInformado({ paginacion: ['Mostrando 1 a 20 de 20 registros'], tablasVisibles: [] }), 20);
  assert.equal(totalInformado({ paginacion: ['1 a 25 de 1.234 registros'], tablasVisibles: [] }), 1234);
  assert.equal(totalInformado({ paginacion: ['Showing 1 to 10 of 61 entries'], tablasVisibles: [] }), 61);
  assert.equal(totalInformado({ paginacion: [], tablasVisibles: [{ filas: 7 }] }), 7);
  assert.equal(totalInformado({ paginacion: [], tablasVisibles: [{ filas: 3 }, { filas: 4 }] }), null);
});

test('el manifiesto persistente reutiliza descargas entre dos corridas distintas', async () => {
  const { periodosPendientes, registrarManifiesto, claveManifiesto } = await import('../src/portal/misComprobantes.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  // Carpeta PERSISTENTE compartida (no por corrida).
  const persistente = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-datos-'));

  // Corrida 1: nada verificado aún -> el período está pendiente.
  const antes = periodosPendientes(persistente, 'recibidos', '2026-09-01', '2026-09-30');
  assert.equal(antes.pendientes.length, 1);
  assert.equal(antes.reutilizados.length, 0);

  // La corrida 1 descarga y valida: registra en el manifiesto persistente.
  registrarManifiesto(persistente, claveManifiesto('recibidos', '2026-09-01', '2026-09-30'),
    { fecha: '2026-10-19', ok: true, filas: 20, informados: 20, hash: 'abc', archivo: 'r.csv' });

  // Corrida 2 (otra carpeta de corrida, MISMA carpeta persistente): se reutiliza, no se descarga.
  const despues = periodosPendientes(persistente, 'recibidos', '2026-09-01', '2026-09-30');
  assert.equal(despues.pendientes.length, 0);
  assert.equal(despues.reutilizados.length, 1);
  assert.equal(despues.reutilizados[0].filas, 20);
  assert.equal(despues.reutilizados[0].informados, 20);

  // Una carpeta persistente distinta NO ve ese manifiesto: vuelve a estar pendiente.
  const otra = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-datos2-'));
  assert.equal(periodosPendientes(otra, 'recibidos', '2026-09-01', '2026-09-30').pendientes.length, 1);

  // Con --rehacer, aunque esté verificado, vuelve a pendientes.
  assert.equal(periodosPendientes(persistente, 'recibidos', '2026-09-01', '2026-09-30', true).pendientes.length, 1);
});

test('totalInformado soporta la paginación completa de DataTables en español', async () => {
  const { totalInformado } = await import('../src/portal/misComprobantes.js');
  assert.equal(totalInformado({ paginacion: ['Mostrando registros del 1 al 20 de un total de 20 registros'], tablasVisibles: [] }), 20);
  assert.equal(totalInformado({ paginacion: ['Mostrando registros del 1 al 25 de un total de 1.234 registros'], tablasVisibles: [] }), 1234);
});

test('detección de columnas tolera acentos mal codificados (Número -> Nmero)', async () => {
  const { validarContenidoCsv } = await import('../src/portal/misComprobantes.js');
  // "Nmero" simula el header con el acento perdido por encoding latin1/utf8.
  const cab = 'Fecha de Emisin;Tipo;Punto de Venta;Nmero Desde;Total';
  const v = validarContenidoCsv(`${cab}\n05/09/2026;1;1;10;100,00\n05/09/2026;1;1;10;100,00`, '2026-09-01', '2026-09-30');
  assert.equal(v.duplicados, 1, 'debe detectar el duplicado por columnas aun sin acentos');
});

test('aYmd acepta los formatos de fecha que usa ARCA', async () => {
  const { aYmd } = await import('../src/portal/misComprobantes.js');
  assert.equal(aYmd('01/09/2026'), '20260901');
  assert.equal(aYmd('2026-09-01'), '20260901');
  assert.equal(aYmd('01-09-2026'), '20260901');
  assert.equal(aYmd('"05/09/2026"'), '20260905');
  assert.equal(aYmd('01/09/2026 00:00:00'), '20260901');
  assert.equal(aYmd(''), null);
});

test('validarContenidoCsv valida un CSV con fecha ISO (el caso que falló en la corrida real)', async () => {
  const { validarContenidoCsv } = await import('../src/portal/misComprobantes.js');
  const cab = 'Fecha de Emisión;Tipo;Punto de Venta;Número Desde;Imp. Total';
  const filas = Array.from({ length: 62 }, (_, i) => `2026-09-${String((i % 7) + 1).padStart(2, '0')};1;1;${i + 1};100,00`).join('\n');
  const v = validarContenidoCsv(`${cab}\n${filas}`, '2026-09-01', '2026-09-30');
  assert.equal(v.ok, true);
  assert.equal(v.filas, 62);
  assert.equal(v.dentroDelRango, 62);
  assert.equal(v.muestraFecha, '2026-09-01');
});

test('decodificar maneja UTF-16LE, latin1 y utf8', async () => {
  const { decodificar } = await import('../src/portal/misComprobantes.js');
  const texto = 'Fecha;Número\n2026-09-01;10';
  // UTF-16LE con BOM
  const u16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(texto, 'utf16le')]);
  assert.equal(decodificar(u16), texto);
  // latin1 con acento (0xFA = ú) que en utf8 sería inválido
  const lat = Buffer.from('Número', 'latin1');
  assert.equal(decodificar(lat), 'Número');
  // utf8 normal
  assert.equal(decodificar(Buffer.from(texto, 'utf8')), texto);
});

test('validarArchivo sobre un CSV UTF-16LE con fecha ISO valida correctamente', async () => {
  const { validarArchivo } = await import('../src/portal/misComprobantes.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-enc-'));
  const f = path.join(dir, 'r.csv');
  const texto = 'Fecha de Emisión;Número Desde;Total\r\n2026-09-10;5;100,00\r\n2026-09-11;6;200,00\r\n';
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(texto, 'utf16le')]));
  const v = validarArchivo(f, '2026-09-01', '2026-09-30');
  assert.equal(v.ok, true);
  assert.equal(v.filas, 2);
});

test('candidatos encuentra exportación y tablas dentro de un iframe (caso Cuentas Tributarias)', async () => {
  const { candidatos } = await import('../src/portal/misComprobantes.js');
  const rel = { frames: [
    { principal: true, inputs: [], botones: [], enlaces: [], conRol: [] },
    { principal: false, inputs: [{ tag: 'input', id: 'd', visible: true, type: 'text', placeholder: 'desde' }],
      botones: [{ tag: 'button', text: 'EXPORTAR', visible: true }, { tag: 'button', text: 'Consultar', visible: true }],
      enlaces: [{ tag: 'a', text: 'CSV', visible: true }], conRol: [] },
  ] };
  const c = candidatos(rel);
  assert.deepEqual(c.exportar.map((e) => e.text).sort(), ['CSV', 'EXPORTAR']);
  assert.deepEqual(c.buscar.map((b) => b.text), ['Consultar']);
  assert.equal(c.fecha.length, 1);
});
