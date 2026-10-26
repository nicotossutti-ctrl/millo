import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { leerXlsx, columnaDe, fechaExcel } from '../src/app/xlsx.js';
import { mesDe, importeImportado, usaComaDecimal, detectarEncabezado, analizarArchivo, simularImportacion, confirmarImportacion, eliminarImportacion, listarImportaciones, importadoDelMes } from '../src/app/importar.js';
import { panelMes, mesesDisponibles, mesAnterior } from '../src/app/panel.js';
import { crearServidor } from '../src/app/servidor.js';
import { identificarConceptosIva } from '../src/portal/ivaDdjj.js';
import { generarInformeIva, composicionDebito } from '../src/informeIva.js';
import { toCsv } from '../src/csv.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arca-app-'));

// ---------------- xlsx mínimo (ZIP "almacenado", sin compresión) ----------------
function zipAlmacenado(archivos) {
  const locales = []; const centrales = []; let off = 0;
  for (const [nombre, contenido] of Object.entries(archivos)) {
    const n = Buffer.from(nombre); const d = Buffer.from(contenido);
    const loc = Buffer.alloc(30); loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(0, 8); loc.writeUInt32LE(d.length, 18); loc.writeUInt32LE(d.length, 22); loc.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(0, 10); cen.writeUInt32LE(d.length, 20); cen.writeUInt32LE(d.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(off, 42);
    locales.push(loc, n, d); centrales.push(cen, n); off += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(centrales);
  const fin = Buffer.alloc(22); fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(Object.keys(archivos).length, 8); fin.writeUInt16LE(Object.keys(archivos).length, 10); fin.writeUInt32LE(cd.length, 12); fin.writeUInt32LE(off, 16);
  return Buffer.concat([...locales, cd, fin]);
}
/** Planilla como el reporte de ventas de Mercado Libre: título arriba, encabezado en la fila 3, fecha con formato. */
function xlsxVentas(filas) {
  const strings = ['Reporte de ventas', '# de venta', 'Fecha de venta', 'Título', 'Total (ARS)', ...filas.map((f) => f[2])];
  const si = strings.map((s) => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('');
  const celda = (ref, v, tipo, s) => `<c r="${ref}"${tipo ? ` t="${tipo}"` : ''}${s != null ? ` s="${s}"` : ''}><v>${v}</v></c>`;
  const rows = [`<row r="1">${celda('A1', 0, 's')}</row>`, `<row r="3">${celda('A3', 1, 's')}${celda('B3', 2, 's')}${celda('C3', 3, 's')}${celda('D3', 4, 's')}</row>`,
    ...filas.map((f, i) => `<row r="${i + 4}">${celda(`A${i + 4}`, f[0])}${celda(`B${i + 4}`, f[1], null, 1)}${celda(`C${i + 4}`, 5 + i, 's')}${celda(`D${i + 4}`, f[3])}</row>`)];
  return zipAlmacenado({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Ventas" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst>${si}</sst>`,
    'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`,
  });
}
// 46282 = 2026-09-17; 46297 = 2026-10-02
const VENTAS = [[1001, 46282, 'Producto A', 15000.5], [1002, 46282, 'Producto B & C', 2000], [1003, 46297, 'Producto D', 999.99]];

test('xlsx: hojas, textos compartidos, fechas por formato y números', () => {
  assert.equal(columnaDe('AB12'), 27);
  assert.equal(fechaExcel(46282), '2026-09-17');
  const [hoja] = leerXlsx(xlsxVentas(VENTAS));
  assert.equal(hoja.nombre, 'Ventas');
  assert.deepEqual(hoja.filas[2], ['# de venta', 'Fecha de venta', 'Título', 'Total (ARS)']);
  assert.deepEqual(hoja.filas[3], ['1001', '2026-09-17', 'Producto A', '15000.5']);
  assert.equal(hoja.filas[4][2], 'Producto B & C');
  assert.equal(detectarEncabezado(hoja.filas), 2, 'salta el título del reporte');
});

test('formatos de fecha y de importe de los reportes', () => {
  assert.equal(mesDe('15 de septiembre de 2026 10:20 hs.'), '2026-09');
  assert.equal(mesDe('17/09/2026'), '2026-09');
  assert.equal(mesDe('2026-09-17T10:00:00'), '2026-09');
  assert.equal(mesDe('09/2026'), '2026-09');
  assert.equal(mesDe('202609'), '2026-09');
  assert.equal(mesDe('Septiembre 2026'), '2026-09');
  assert.equal(mesDe('total'), null);
  assert.equal(importeImportado('$ -1.234,56'), -1234.56);
  assert.equal(importeImportado('(1.234,56)'), -1234.56);
  assert.equal(importeImportado('1234.56', false), 1234.56);
  assert.equal(importeImportado('1,234.56', false), 1234.56);
  assert.equal(importeImportado('1.234.567', true), 1234567);
  assert.equal(importeImportado('abc'), null);
  assert.equal(usaComaDecimal(['1.234,56', '10']), true);
  assert.equal(usaComaDecimal(['1234.56', '10']), false);
});

test('importación: vista previa, simulación, confirmación, duplicados y deshacer', () => {
  const out = tmp();
  const a = analizarArchivo(out, { nombre: 'ventas-ml-sep.xlsx', contenido: xlsxVentas(VENTAS).toString('base64') });
  assert.equal(a.filaEncabezado, 2);
  assert.equal(a.encabezados[1], 'Fecha de venta');
  assert.equal(a.sugeridas.colFecha, 1);
  assert.equal(a.sugeridas.colImporte, 3);
  const mapeo = { hash: a.hash, concepto: 'ventas-ml', colFecha: 1, colImporte: 3, colDescripcion: 2 };
  const s = simularImportacion(out, mapeo);
  assert.equal(s.nuevas, 3);
  assert.deepEqual(s.porMes, { '2026-09': { importe: 17000.5, filas: 2 }, '2026-10': { importe: 999.99, filas: 1 } });
  assert.equal(listarImportaciones(out).length, 0, 'simular no guarda nada');
  const r = confirmarImportacion(out, mapeo);
  assert.equal(r.filas, 3);
  assert.equal(importadoDelMes(out, '2026-09')['ventas-ml'].importe, 17000.5);
  // El mismo archivo otra vez: rechazado.
  const a2 = analizarArchivo(out, { nombre: 'copia.xlsx', contenido: xlsxVentas(VENTAS).toString('base64') });
  assert.ok(a2.yaImportado);
  assert.throws(() => confirmarImportacion(out, { ...mapeo, hash: a2.hash }), /ya se importó/);
  // Otro archivo que repite una venta y agrega una nueva: solo entra la nueva.
  const a3 = analizarArchivo(out, { nombre: 'ventas-ml-sep-2.xlsx', contenido: xlsxVentas([VENTAS[0], [1004, 46282, 'Producto E', 500]]).toString('base64') });
  const s3 = simularImportacion(out, { ...mapeo, hash: a3.hash });
  assert.equal(s3.duplicadas, 1);
  assert.equal(s3.nuevas, 1);
  confirmarImportacion(out, { ...mapeo, hash: a3.hash });
  assert.equal(importadoDelMes(out, '2026-09')['ventas-ml'].importe, 17500.5);
  // CSV con mes fijo y coma decimal; fila ilegible descartada.
  const csv = 'Concepto;Importe\nAlquiler;150.000,00\nLuz;23.456,78\nTotal;xx\n';
  const a4 = analizarArchivo(out, { nombre: 'gastos.csv', contenido: Buffer.from(csv).toString('base64') });
  const s4 = simularImportacion(out, { hash: a4.hash, concepto: 'gastos-operativos', colFecha: '', mesFijo: '2026-09', colImporte: 1 });
  assert.equal(s4.nuevas, 2); assert.equal(s4.descartadas, 1);
  assert.equal(s4.porMes['2026-09'].importe, 173456.78);
  // Deshacer.
  eliminarImportacion(out, r.id);
  assert.equal(importadoDelMes(out, '2026-09')['ventas-ml'].importe, 500);
  assert.throws(() => simularImportacion(out, { hash: 'x'.repeat(64), concepto: 'ventas-ml', colImporte: 0, colFecha: 0 }), /inválido|pendiente/);
});

// ---------------- panel con un escenario como el real de septiembre 2026 ----------------
const CAB = ['Fecha de Emisión', 'Tipo de Comprobante', 'Punto de Venta', 'Número Desde', 'Imp. Neto Gravado Total', 'IVA 21%', 'Total IVA', 'Imp. Total'];
const csvMc = (filas) => '﻿' + [CAB, ...filas].map((f) => f.map((x) => `"${x}"`).join(';')).join('\r\n') + '\r\n';
function escenario({ conDeuda = true } = {}) {
  const out = tmp(); const d = path.join(out, 'datos');
  const vig = (id, clave, nombre, headers, rows, entrada = {}) => {
    fs.mkdirSync(path.join(d, id, 'vigente', clave), { recursive: true });
    fs.writeFileSync(path.join(d, id, 'vigente', clave, nombre), toCsv(rows, headers.map((h, i) => ({ header: h, value: (r) => r[i] }))));
    const f = path.join(d, id, 'vigente.json');
    const man = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    man[clave] = { cuando: '2026-10-26T20-00-00', rango: 2, nivel: 'validado', filas: rows.length, archivos: [nombre], ...entrada };
    fs.writeFileSync(f, JSON.stringify(man));
  };
  for (const [id, tipo, filas] of [
    ['comprobantes-emitidos', 'emitidos', [['2026-09-01', '1', '1', '1', '100000,00', '21000,00', '21000,00', '121000,00'], ['2026-09-10', '3', '1', '2', '10000,00', '2100,00', '2100,00', '12100,00']]],
    ['comprobantes-recibidos', 'recibidos', [['2026-09-05', '1', '1', '1', '50000,00', '10500,00', '10500,00', '60500,00']]]]) {
    fs.mkdirSync(path.join(d, id), { recursive: true });
    fs.writeFileSync(path.join(d, id, `mc-${tipo}.csv`), csvMc(filas));
    fs.writeFileSync(path.join(d, id, 'manifiesto.json'), JSON.stringify({ [`${tipo}:2026-09-01:2026-09-30`]: { ok: true, fecha: '2026-10-20', archivo: `mc-${tipo}.csv`, filas: filas.length } }));
  }
  // Conceptos de la DJ como los de la corrida real: pantalla + JSON con subtotales parecidos.
  vig('portal-iva-ddjj', '2026-09-01_2026-09-30', 'ddjj-iva-2026-09.csv', ['Concepto', 'Importe'], [
    ['Total del débito fiscal del período', 20000], ['Total del crédito fiscal del período', 10500], ['Total de retenciones, percepciones y pagos a cuenta neto de restituciones', 1000],
    ['Saldo técnico a favor de ARCA', 9500], ['Saldo de impuesto a favor de ARCA', 8500],
    ['json dj debito credito fiscal total debito fiscal', 20000], ['json dj debito credito fiscal total credito fiscal', 10500],
    ['json dj determinacion impuesto total retenciones percepciones', 1100], ['json dj retenciones percepciones percepciones impositivas total neto percepciones', 1000],
    ['json dj debito fiscal operaciones con comprobante debito', 18900], ['json dj debito fiscal restitucion credito fiscal', 1100], ['json dj debito fiscal otros', 0],
  ], { desde: '2026-09-01', hasta: '2026-09-30' });
  vig('portal-iva', 'acumulado', 'portal-iva.csv', ['Período Fiscal', 'Formulario', 'Secuencia', 'Presentación'], [['09/2026', '2051', 'DJ Original', '16/10/2026']]);
  vig('ct-pagos', '2026-10-01_2026-10-26', 'ct-pagos.csv', ['Fecha Operación', 'Formulario', 'Versión', 'Impuesto', 'Período Fiscal', 'Importe'],
    [['17/09/2026', '1571', '1', '11 - GANANCIAS PERSONAS HUMANAS', '202608', '7.000,00']], { desde: '2026-10-01', hasta: '2026-10-26' });
  vig('mis-retenciones', '2026-09-01_2026-09-30', 'mis-retenciones-767-sicore-2026-09-01-2026-09-30.csv', ['Impuesto', 'Fecha', 'Importe'], [['767', '10/09/2026', '1.000,00']], { desde: '2026-09-01', hasta: '2026-09-30' });
  vig('cuentas-tributarias', 'acumulado', 'v.csv', ['Impuesto', 'Concepto', 'Período', 'Vencimiento'], [['217 - SICORE', '19 - DDJJ', '202610', '10/11/2026']]);
  if (conDeuda) vig('ct-deudas', 'acumulado', 'd.csv', ['Establecimiento', 'Impuesto', 'Concepto', 'Subconcepto', 'Período', 'Ant/Cuota', 'Vencimiento', 'Saldo'],
    [['0', '30 - IVA', '19 - DECLARACIÓN JURADA', '51', '202609', '0', '21/12/2026', '8.500,00']]);
  return out;
}

test('DJ: manda el rótulo de pantalla; el JSON corrobora (crédito y percepciones ya no quedan ambiguos)', () => {
  const conceptos = [
    { concepto: 'Total del crédito fiscal del período', importe: 30157579.95 },
    { concepto: 'json dj debito credito fiscal total debito fiscal', importe: 37445589.63 },
    { concepto: 'json dj determinacion impuesto total credito fiscal', importe: 30157579.95 },
    { concepto: 'Total de retenciones, percepciones y pagos a cuenta neto de restituciones', importe: 3602044.66 },
    { concepto: 'json dj determinacion impuesto total retenciones percepciones', importe: 3615310.54 },
  ];
  const id = identificarConceptosIva(conceptos);
  assert.equal(id.creditoFiscal.importe, 30157579.95);
  assert.equal(id.creditoFiscal.json, 'coincide');
  assert.equal(id.retencionesPercepciones.importe, 3602044.66);
  assert.equal(id.retencionesPercepciones.json, 'difiere', 'se informa que el JSON trae otro subtotal');
  // Sin pantalla, el JSON solo: si da valores distintos, sigue ambiguo.
  assert.ok(identificarConceptosIva(conceptos.filter((c) => c.concepto.startsWith('json'))).creditoFiscal.ambiguo);
});

test('informe IVA: IVA diferido — deuda registrada con vencimiento propio = pendiente no vencido; composición del débito', () => {
  const out = escenario();
  const inf = generarInformeIva(path.join(out, 'datos'), '2026-09', { hoy: '2026-10-26' }).objeto;
  assert.equal(inf.vencimientoPago, '2026-12-21');
  assert.equal(inf.conciliacion.estado, 'pendiente de pago (no vencido)');
  assert.match(inf.conciliacion.detalle, /igual a lo declarado.*21\/12\/2026/);
  assert.equal(generarInformeIva(path.join(out, 'datos'), '2026-09', { hoy: '2026-12-22' }).objeto.conciliacion.estado, 'pendiente de pago (vencido)');
  assert.equal(generarInformeIva(path.join(escenario({ conDeuda: false }), 'datos'), '2026-09', { hoy: '2026-10-26' }).objeto.conciliacion.estado, 'pago no verificado', 'sin deuda registrada no se asume impago');
  const comp = composicionDebito(inf.declarado.conceptos);
  assert.ok(comp.some((c) => /restitucion/.test(c.concepto)), 'la pantalla solo trae el total: se muestran los rubros del JSON');
  assert.ok(!comp.some((c) => /total credito fiscal|saldo/.test(c.concepto)));
  const conRubros = composicionDebito([{ concepto: 'Débito fiscal por ventas', importe: 10 }, { concepto: 'Restitución de crédito fiscal (débito)', importe: 2 }, { concepto: 'json dj debito fiscal otros', importe: 3 }]);
  assert.equal(conRubros.length, 2, 'con rubros en pantalla, mandan esos');
});

test('panel del mes: IVA verificado con vencimiento diferido; estimaciones y faltantes rotulados', () => {
  const out = escenario();
  assert.equal(mesAnterior('2026-10-26'), '2026-09');
  assert.equal(mesAnterior('2027-01-05'), '2026-12');
  assert.deepEqual(mesesDisponibles(out, '2026-10-26'), ['2026-09']);
  const p = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: path.join(out, 'no-existe.json') });
  assert.equal(p.iva.declarado.valor, 8500);
  assert.equal(p.iva.declarado.nivel, 'verificado');
  assert.equal(p.iva.estado, 'pendiente de pago (no vencido)');
  assert.equal(p.iva.vencimientoPago.fecha, '2026-12-21');
  assert.equal(p.iva.saldoPendiente.valor, 8500);
  assert.equal(p.iva.pagos.nivel, 'faltante');
  assert.equal(p.iva.estimado.nivel, 'estimado');
  assert.equal(p.iva.estimado.valor, (21000 - 2100) - 10500 - 1000, 'débito con NC restando − IVA proveedores − percepciones');
  assert.equal(p.iva.detalle_.diferenciaDebito.valor, 20000 - 18900);
  assert.equal(p.iibb.declarado.nivel, 'faltante');
  assert.equal(p.ganancias.estimado.nivel, 'faltante', 'sin params no se estima');
  assert.equal(p.rentabilidad.resultado.nivel, 'faltante');
  assert.match(p.rentabilidad.resultado.nota, /costo de la mercadería/);
  assert.match(p.rentabilidad.nota, /IVA no se resta/);
  assert.ok(p.obligaciones.some((o) => o.tipo === 'deuda' && o.vencimiento === '2026-12-21' && o.estado === 'por vencer'));
  assert.equal(p.integraciones.pfos.conectado, false);
});

test('panel: con costo de mercadería e IIBB importados, calcula el resultado sin restar el IVA', () => {
  const out = escenario();
  const params = path.join(out, 'contribuyente.json');
  fs.writeFileSync(params, JSON.stringify({ deduccionEspecial: 'ap1', cargasFamilia: { conyuge: 0, hijos: 0 }, ingresosBrutos: [{ jurisdiccion: 'X', coeficiente: 1, alicuota: 0.03 }], autonomosMensual: 0 }));
  for (const [nombre, concepto, csv] of [['costo.csv', 'costo-mercaderia', 'Detalle;Importe\nCMV;40.000,00\n'], ['iibb.csv', 'iibb-declarado', 'Detalle;Importe\nCM03;2.500,00\n']]) {
    const a = analizarArchivo(out, { nombre, contenido: Buffer.from(csv).toString('base64') });
    confirmarImportacion(out, { hash: a.hash, concepto, colFecha: '', mesFijo: '2026-09', colImporte: 1 });
  }
  const p = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: params });
  assert.equal(p.iibb.declarado.valor, 2500);
  assert.equal(p.iibb.declarado.nivel, 'importado');
  assert.equal(p.iibb.estimado.valor, 90000 * 0.03, 'estimado: facturación neta × alícuota');
  // Ganancias se provisiona sobre el año: faltan enero-agosto.
  assert.equal(p.ganancias.estimado.nivel, 'faltante');
  assert.match(p.ganancias.estimado.nota, /2026-01/);
  // Resultado = 90.000 − 40.000 − 2.500 (Ganancias faltante) — el IVA (8.500) NO se resta.
  assert.equal(p.rentabilidad.resultado.valor, 47500);
  assert.match(p.rentabilidad.resultado.nota, /incompleto: falta provisión de Ganancias/);
});

// ---------------- servidor local ----------------
test('servidor: solo atiende a 127.0.0.1/localhost y a la propia página', async () => {
  const out = escenario();
  // Se busca un puerto libre y se crea el servidor con ese puerto (el Host permitido depende de él).
  const s1 = http.createServer(); await new Promise((ok) => s1.listen(0, '127.0.0.1', ok)); const puerto = s1.address().port; await new Promise((ok) => s1.close(ok));
  const srv = () => crearServidor({ outDir: out, hoy: '2026-10-26', puerto, paramsFile: path.join(out, 'x.json') });
  const escuchar = async (s) => { await new Promise((ok) => s.listen(puerto, '127.0.0.1', ok)); return s; };
  const s = await escuchar(srv());
  try {
    const base = `http://127.0.0.1:${puerto}`;
    const panel = await (await fetch(`${base}/api/panel?mes=2026-09`)).json();
    assert.equal(panel.iva.declarado.valor, 8500);
    assert.equal((await fetch(`${base}/api/panel?mes=2026-13`)).status, 400);
    const conHost = await new Promise((ok, mal) => http.get({ host: '127.0.0.1', port: puerto, path: '/api/meses', headers: { host: 'evil.example' } }, (r) => { r.resume(); ok(r.statusCode); }).on('error', mal));
    assert.equal(conHost, 403, 'DNS rebinding: Host ajeno');
    const ajeno = await fetch(`${base}/api/importaciones/eliminar`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert.equal(ajeno.status, 403, 'otra página no puede escribir');
    const sinJson = await fetch(`${base}/api/importaciones/eliminar`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(sinJson.status, 415);
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-security-policy'), /default-src 'self'/);
  } finally { s.close(); }
});
