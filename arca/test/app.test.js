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
  const a = analizarArchivo(out, { nombre: 'pagos-iibb-sep.xlsx', contenido: xlsxVentas(VENTAS).toString('base64') });
  assert.equal(a.filaEncabezado, 2);
  assert.equal(a.encabezados[1], 'Fecha de venta');
  assert.equal(a.sugeridas.colFecha, 1);
  assert.equal(a.sugeridas.colImporte, 3);
  const mapeo = { hash: a.hash, concepto: 'iibb-pagado', colFecha: 1, colImporte: 3, colDescripcion: 2 };
  const s = simularImportacion(out, mapeo);
  assert.equal(s.nuevas, 3);
  assert.deepEqual(s.porMes, { '2026-09': { importe: 17000.5, filas: 2 }, '2026-10': { importe: 999.99, filas: 1 } });
  assert.equal(listarImportaciones(out).length, 0, 'simular no guarda nada');
  const r = confirmarImportacion(out, mapeo);
  assert.equal(r.filas, 3);
  assert.equal(importadoDelMes(out, '2026-09')['iibb-pagado'].importe, 17000.5);
  // El mismo archivo otra vez: rechazado.
  const a2 = analizarArchivo(out, { nombre: 'copia.xlsx', contenido: xlsxVentas(VENTAS).toString('base64') });
  assert.ok(a2.yaImportado);
  assert.throws(() => confirmarImportacion(out, { ...mapeo, hash: a2.hash }), /ya se importó/);
  // Otro archivo que repite una venta y agrega una nueva: solo entra la nueva.
  const a3 = analizarArchivo(out, { nombre: 'pagos-iibb-sep-2.xlsx', contenido: xlsxVentas([VENTAS[0], [1004, 46282, 'Producto E', 500]]).toString('base64') });
  const s3 = simularImportacion(out, { ...mapeo, hash: a3.hash });
  assert.equal(s3.duplicadas, 1);
  assert.equal(s3.nuevas, 1);
  confirmarImportacion(out, { ...mapeo, hash: a3.hash });
  assert.equal(importadoDelMes(out, '2026-09')['iibb-pagado'].importe, 17500.5);
  // CSV con mes fijo y coma decimal; fila ilegible descartada.
  const csv = 'Concepto;Importe\nAlquiler;150.000,00\nLuz;23.456,78\nTotal;xx\n';
  const a4 = analizarArchivo(out, { nombre: 'autonomos.csv', contenido: Buffer.from(csv).toString('base64') });
  const s4 = simularImportacion(out, { hash: a4.hash, concepto: 'autonomos', colFecha: '', mesFijo: '2026-09', colImporte: 1 });
  assert.equal(s4.nuevas, 2); assert.equal(s4.descartadas, 1);
  assert.equal(s4.porMes['2026-09'].importe, 173456.78);
  // Deshacer.
  eliminarImportacion(out, r.id);
  assert.equal(importadoDelMes(out, '2026-09')['iibb-pagado'].importe, 500);
  assert.throws(() => simularImportacion(out, { hash: 'x'.repeat(64), concepto: 'iibb-pagado', colImporte: 0, colFecha: 0 }), /inválido|pendiente/);
  // Lo comercial (costos, ventas, gastos de Mercado Libre) lo calcula PFOS: no se importa en FiscalOS.
  const a5 = analizarArchivo(out, { nombre: 'costo.csv', contenido: Buffer.from('Mes;Importe\n2026-09;100\n').toString('base64') });
  assert.throws(() => simularImportacion(out, { hash: a5.hash, concepto: 'costo-mercaderia', colFecha: 0, colImporte: 1 }), /lo calcula PFOS/);
});

// ---------------- panel con un escenario como el real de septiembre 2026 ----------------
const CAB = ['Fecha de Emisión', 'Tipo de Comprobante', 'Punto de Venta', 'Número Desde', 'Imp. Neto Gravado Total', 'IVA 21%', 'Total IVA', 'Imp. Total', 'Nro. Doc. Emisor', 'Denominación Emisor'];
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
    ['comprobantes-emitidos', 'emitidos', [['2026-09-01', '1', '1', '1', '100000,00', '21000,00', '21000,00', '121000,00', '', ''], ['2026-09-10', '3', '1', '2', '10000,00', '2100,00', '2100,00', '12100,00', '', '']]],
    // Compras: mercadería (stock), cargos de Mercado Libre (con una nota de crédito) y un gasto (contador).
    ['comprobantes-recibidos', 'recibidos', [['2026-09-05', '1', '1', '1', '50000,00', '10500,00', '10500,00', '60500,00', '30111111118', 'DISTRIBUIDORA MAYORISTA SA'],
      ['2026-09-30', '1', '9', '7', '8000,00', '1680,00', '1680,00', '9680,00', '30703088534', 'MERCADOLIBRE S.R.L.'],
      ['2026-09-30', '3', '9', '8', '500,00', '105,00', '105,00', '605,00', '30703088534', 'MERCADOLIBRE S.R.L.'],
      ['2026-09-12', '1', '2', '3', '3000,00', '630,00', '630,00', '3630,00', '20222222223', 'ESTUDIO CONTABLE PEREZ']]]]) {
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
    [['17/10/2026', '1571', '1', '11 - GANANCIAS PERSONAS HUMANAS', '202500', '7.000,00']], { desde: '2026-10-01', hasta: '2026-10-26' });
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
  // Fixture: la pantalla solo trae el total; el JSON trae rubros con nombres técnicos -> no disponible.
  assert.equal(inf.declarado.composicionDebito.disponible, false);
  assert.match(inf.declarado.composicionDebito.motivo, /no trae el detalle/);
  // Rubros de pantalla que suman el total: disponible, sin crédito, sin duplicados, sin JSON.
  const ok = composicionDebito([
    { concepto: 'Total del débito fiscal del período', importe: 12 }, { concepto: 'Débito fiscal por ventas gravadas 21%', importe: 10 },
    { concepto: 'Débito fiscal por ventas gravadas 21%', importe: 10 }, { concepto: 'Débito fiscal por restitución de créditos', importe: 2 },
    { concepto: 'Crédito fiscal por compras (débito y crédito)', importe: 5 }, { concepto: 'json dj debito fiscal operaciones', importe: 10 },
  ]);
  assert.equal(ok.disponible, true);
  assert.deepEqual(ok.componentes.map((c) => c.concepto), ['Débito fiscal por ventas gravadas 21%', 'Débito fiscal por restitución de créditos']);
  // Con un rubro de menos no suma el total: no se muestra una composición parcial.
  const parcial = composicionDebito([{ concepto: 'Total del débito fiscal del período', importe: 12 }, { concepto: 'Débito fiscal por ventas', importe: 10 }]);
  assert.equal(parcial.disponible, false);
  assert.match(parcial.motivo, /no reconstruyen el total/);
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
  assert.equal(p.iva.estimado.valor, (21000 - 2100) - (10500 + 1680 - 105 + 630) - 1000, 'débito con NC restando − IVA proveedores − percepciones');
  assert.equal(p.iva.detalle_.diferenciaDebito.valor, 20000 - 18900);
  assert.equal(p.iibb.declarado.nivel, 'faltante');
  assert.equal(p.ganancias.estimado.nivel, 'faltante', 'sin params no se estima');
  // FiscalOS es impositivo: no arma rentabilidad. Lo que el mes deja para pagar: el IVA con su deuda registrada.
  assert.equal(p.rentabilidad, undefined);
  const ivaDeja = p.deja.find((o) => o.impuesto === 'IVA');
  assert.equal(ivaDeja.cifra.valor, 8500); assert.equal(ivaDeja.vence, '2026-12-21');
  assert.match(ivaDeja.nota, /saldo exigible confirmado/);
  assert.ok(p.obligaciones.some((o) => o.tipo === 'deuda' && o.vencimiento === '2026-12-21' && o.estado === 'por vencer'));
  assert.equal(p.integraciones.pfos.conectado, false);
});

test('cargas manuales: CM03 con corrección e historial, fuente obligatoria; lo comercial ya no se carga y lo viejo se conserva', async () => {
  const { guardarManual, eliminarManual, listarManuales } = await import('../src/app/manuales.js');
  const out = escenario();
  const iibb = guardarManual(out, { mes: '2026-09', concepto: 'iibb-declarado', importe: '2.400,00', fuente: 'CM03 presentado' });
  guardarManual(out, { id: iibb.id, mes: '2026-09', concepto: 'iibb-declarado', importe: '2.500,00', fuente: 'CM03 presentado (rectificado)' });
  assert.equal(listarManuales(out).find((c) => c.id === iibb.id).historial[0].importe, 2400, 'la corrección guarda el valor anterior');
  assert.throws(() => guardarManual(out, { mes: '2026-09', concepto: 'iibb-pagado', importe: '5', fuente: '' }), /fuente/);
  assert.throws(() => guardarManual(out, { mes: '2026-09', concepto: 'iibb-pagado', importe: '5', fuente: 'VEP' }), /fecha en que se pagó/, 'un pago nuevo necesita su fecha');
  let p = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: path.join(out, 'x.json') });
  assert.equal(p.iibb.declarado.valor, 2500); assert.equal(p.iibb.declarado.nivel, 'manual');
  assert.equal(p.iibb.estado, 'pago no encontrado (sin cobertura)', 'sin pago registrado: falta evidencia, no «impago»');
  assert.equal(p.deja.find((o) => o.impuesto === 'Ingresos Brutos').cifra.valor, 2500);
  guardarManual(out, { mes: '2026-09', concepto: 'iibb-pagado', importe: '1.000', fuente: 'VEP', fechaPago: '2026-10-20' });
  p = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: path.join(out, 'x.json') });
  assert.equal(p.iibb.estado, 'pago parcial: falta conciliar');
  // Lo comercial lo calcula PFOS: no se crean cargas nuevas. Una carga vieja se conserva y se puede borrar.
  assert.throws(() => guardarManual(out, { mes: '2026-09', concepto: 'costo-mercaderia', importe: '40.000', fuente: 'eCom' }), /lo calcula PFOS/);
  const f = path.join(out, 'importados', 'manuales.json');
  const lista = JSON.parse(fs.readFileSync(f, 'utf8'));
  lista.push({ id: 'viejo', mes: '2026-09', concepto: 'costo-mercaderia', importe: 66500000, fuente: 'PFOS (aproximado)', estimado: true, cuando: 'x', actualizado: 'x' });
  fs.writeFileSync(f, JSON.stringify(lista));
  assert.ok(panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: path.join(out, 'x.json') }).manuales.some((c) => c.id === 'viejo'));
  eliminarManual(out, 'viejo');
  assert.ok(!listarManuales(out).some((c) => c.id === 'viejo'));
});

test('Ganancias: proyección con el resultado comercial de PFOS de cada mes; sin él, «no estimable» (nunca con costos ni compras)', async () => {
  const { guardarManual } = await import('../src/app/manuales.js');
  const out = tmp(); const d = path.join(out, 'datos');
  fs.mkdirSync(path.join(d, 'comprobantes-emitidos'), { recursive: true });
  fs.writeFileSync(path.join(d, 'comprobantes-emitidos', 'mc.csv'), csvMc([['2026-01-10', '1', '1', '1', '1000000,00', '210000,00', '210000,00', '1210000,00', '', ''], ['2026-02-10', '1', '1', '2', '1000000,00', '210000,00', '210000,00', '1210000,00', '', '']]));
  fs.writeFileSync(path.join(d, 'comprobantes-emitidos', 'manifiesto.json'), JSON.stringify({ 'emitidos:2026-01-01:2026-02-28': { ok: true, fecha: '2026-03-02', archivo: 'mc.csv' } }));
  const params = path.join(out, 'contribuyente.json');
  fs.writeFileSync(params, JSON.stringify({ deduccionEspecial: 'ap1', cargasFamilia: { conyuge: 0, hijos: 0 }, ingresosBrutos: [{ jurisdiccion: 'X', coeficiente: 1, alicuota: 0.03 }], autonomosMensual: 50000 }));
  const gan = () => panelMes(out, '2026-02', { hoy: '2026-03-05', paramsFile: params }).ganancias.estimado;
  // Un costo de mercadería viejo (comercial) no sirve: hace falta el resultado de PFOS de cada mes.
  fs.mkdirSync(path.join(out, 'importados'), { recursive: true });
  fs.writeFileSync(path.join(out, 'importados', 'manuales.json'), JSON.stringify([{ id: 'v', mes: '2026-01', concepto: 'costo-mercaderia', importe: 400000, fuente: 'x', cuando: 'x', actualizado: 'x' }]));
  assert.equal(gan().nivel, 'faltante');
  assert.match(gan().nota, /no estimable.*falta el resultado comercial de PFOS de 2026-01, 2026-02/);
  guardarManual(out, { mes: '2026-01', concepto: 'resultado-comercial', importe: '600.000', fuente: 'PFOS: resumen de enero' });
  assert.match(gan().nota, /de 2026-02$/);
  guardarManual(out, { mes: '2026-02', concepto: 'resultado-comercial', importe: '600.000', fuente: 'PFOS: resumen de febrero' });
  const g = gan();
  assert.equal(g.nivel, 'estimado');
  assert.match(g.nota, /resultado comercial de PFOS − IIBB − autónomos/);
  assert.match(g.nota, /No es la DJ anual/);
  // Sin los comprobantes emitidos de un mes, tampoco: la base de IIBB sale de la facturación.
  assert.match(panelMes(out, '2026-03', { hoy: '2026-04-05', paramsFile: params }).ganancias.estimado.nota, /faltan los comprobantes emitidos de 2026-03/);
});

test('pagos de caja del mes: propios separados de los depositados como agente; cargas manuales marcadas', async () => {
  const { guardarManual } = await import('../src/app/manuales.js');
  const out = escenario();
  guardarManual(out, { mes: '2026-09', concepto: 'iibb-pagado', importe: '2.500', fuente: 'VEP CM03 septiembre', fechaPago: '2026-10-15' });
  const p = panelMes(out, '2026-10', { hoy: '2026-10-26', paramsFile: path.join(out, 'x.json') });
  const pg = p.pagos;
  assert.ok(pg.filas.some((f) => f.impuesto === 'Ganancias' && f.corresponde === 'período fiscal 2025 (anual)' && f.importe === 7000));
  assert.ok(pg.filas.some((f) => f.impuesto === 'Ingresos Brutos' && f.nivel === 'manual' && f.importe === 2500));
  assert.equal(pg.propios, 9500);
  assert.equal(pg.comoAgente, 0);
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

test('pagos realizados en el mes: impuesto por código, período fiscal y sin atribuir Ganancias al mes', async () => {
  const { periodoFiscal, clasificarImpuesto, pagosDelMes } = await import('../src/app/panel.js');
  assert.deepEqual(periodoFiscal('202609'), { tipo: 'mes', mes: '2026-09' });
  assert.deepEqual(periodoFiscal('20260900'), { tipo: 'mes', mes: '2026-09' });
  assert.deepEqual(periodoFiscal('202500'), { tipo: 'anual', anio: '2025' });
  assert.deepEqual(periodoFiscal('2025'), { tipo: 'anual', anio: '2025' });
  assert.equal(clasificarImpuesto('11 - GANANCIAS PERSONAS HUMANAS').clave, 'ganancias');
  assert.equal(clasificarImpuesto('217 - SICORE-IMPTO.A LAS GANANCIAS').clave, 'agente', 'SICORE no es Ganancias propia');
  assert.equal(clasificarImpuesto('30 - IVA').clave, 'iva');
  const out = escenario(); const d = path.join(out, 'datos');
  // Pagos de septiembre: saldo de DJ de Ganancias 2025, SICORE como agente e IVA de agosto.
  const dir = path.join(d, 'ct-pagos', 'vigente', '2026-09-01_2026-09-30');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'p.csv'), toCsv([
    ['15/09/2026', '1571', '1', '11 - GANANCIAS PERSONAS HUMANAS', '202500', '3.878.285,26', ''],
    ['10/09/2026', '1571', '1', '217 - SICORE-IMPTO.A LAS GANANCIAS', '202608', '326.384,15', ''],
    ['21/09/2026', '2051', '1', '30 - IVA', '202608', '980,00', ''],
  ], ['Fecha Operación', 'Formulario', 'Versión', 'Impuesto', 'Período Fiscal', 'Importe', 'Observaciones'].map((h, i) => ({ header: h, value: (r) => r[i] }))));
  const man = JSON.parse(fs.readFileSync(path.join(d, 'ct-pagos', 'vigente.json'), 'utf8'));
  man['2026-09-01_2026-09-30'] = { cuando: '2026-10-25T14-51-11', nivel: 'validado', archivos: ['p.csv'], desde: '2026-09-01', hasta: '2026-09-30' };
  fs.writeFileSync(path.join(d, 'ct-pagos', 'vigente.json'), JSON.stringify(man));
  const pagos = pagosDelMes(d, '2026-09');
  assert.equal(pagos.length, 3);
  const gan = pagos.find((x) => x.clasificacion.clave === 'ganancias');
  assert.equal(gan.imputadoA, 'período fiscal 2025 (anual)');
  assert.equal(gan.delMismoPeriodo, false);
  const p = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: path.join(out, 'x.json') });
  assert.equal(p.ganancias.pagos.valor, null, 'no se atribuye a septiembre');
  assert.equal(p.ganancias.pagosEnElMes.valor, 3878285.26);
  assert.match(p.ganancias.pagosEnElMes.nota, /período fiscal 2025/);
  assert.equal(p.pagosDelMes.find((x) => x.clasificacion.clave === 'agente').clasificacion.propio, false);
  // Los importes declarados y fechas verificadas no cambian.
  assert.equal(p.iva.declarado.valor, 8500);
  assert.equal(p.iva.vencimientoPago.fecha, '2026-12-21');
});

test('autónomos: la cuota cargada a mano es del período y se marca así', async () => {
  const { guardarManual } = await import('../src/app/manuales.js');
  const out = escenario();
  guardarManual(out, { mes: '2026-09', concepto: 'autonomos-cuota', importe: '45.000', fuente: 'boleta autónomos' });
  const a = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: path.join(out, 'x.json') }).autonomos;
  assert.equal(a.declarado.valor, 45000);
  assert.equal(a.declarado.nivel, 'manual');
});

test('estado de un pago declarado: no encontrado no es impago; un pago parcial no lo da por pagado', async () => {
  const { estadoPago, cifra } = await import('../src/app/panel.js');
  assert.equal(estadoPago(1000, []), 'pago no encontrado (sin cobertura)');
  assert.equal(estadoPago(1000, [cifra(400, 'verificado')]), 'pago parcial: falta conciliar');
  assert.equal(estadoPago(1000, [cifra(1000, 'verificado')]), 'pagado verificado');
  assert.equal(estadoPago(1000, [cifra(600, 'verificado'), cifra(400, 'manual')]), 'pago cargado a mano');
  assert.equal(estadoPago(0, []), 'sin saldo a pagar');
  assert.equal(estadoPago(null, []), 'sin declarar');
});

test('autónomos: la cuota del mes sale de los pagos de ARCA imputados al período; la carga manual manda', async () => {
  const { guardarManual } = await import('../src/app/manuales.js');
  const out = escenario(); const d = path.join(out, 'datos');
  const dir = path.join(d, 'ct-pagos', 'vigente', '2026-09-01_2026-09-30');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.csv'), toCsv([['18/09/2026', '1571', '1', '308 - APORTES SEG.SOCIAL AUTONOMOS', '202609', '62.000,00']],
    ['Fecha Operación', 'Formulario', 'Versión', 'Impuesto', 'Período Fiscal', 'Importe'].map((h, i) => ({ header: h, value: (r) => r[i] }))));
  const man = JSON.parse(fs.readFileSync(path.join(d, 'ct-pagos', 'vigente.json'), 'utf8'));
  man['2026-09-01_2026-09-30'] = { cuando: 'c', nivel: 'validado', archivos: ['a.csv'], desde: '2026-09-01', hasta: '2026-09-30' };
  fs.writeFileSync(path.join(d, 'ct-pagos', 'vigente.json'), JSON.stringify(man));
  let p = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: path.join(out, 'x.json') });
  assert.equal(p.autonomos.declarado.valor, 62000);
  assert.equal(p.autonomos.declarado.nivel, 'verificado');
  guardarManual(out, { mes: '2026-09', concepto: 'autonomos-cuota', importe: '60.000', fuente: 'boleta' });
  p = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: path.join(out, 'x.json') });
  assert.equal(p.autonomos.declarado.valor, 60000);
});

// ---------------- Pendientes de carga (cartel) ----------------
test('pendientes: los últimos seis meses calendario cerrados, tengan datos o no; se van cuando está cargado', async () => {
  const { pendientesDeCarga, mesesHacia } = await import('../src/app/pendientes.js');
  const { guardarManual } = await import('../src/app/manuales.js');
  assert.deepEqual(mesesHacia('2026-09', 6), ['2026-09', '2026-08', '2026-07', '2026-06', '2026-05', '2026-04']);
  assert.deepEqual(mesesHacia('2026-02', 3), ['2026-02', '2026-01', '2025-12']);
  // Instalación vacía: los seis meses aparecen (sin datos es justamente lo que más falta).
  const vacia = tmp();
  const pv = pendientesDeCarga(vacia, '2026-10-28', { paramsFile: path.join(vacia, 'no.json') });
  assert.deepEqual([...new Set(pv.map((x) => x.mes))], ['2026-09', '2026-08', '2026-07', '2026-06', '2026-05', '2026-04', '2025-12']);
  assert.deepEqual(pv.filter((x) => x.mes === '2026-06').map((x) => x.clave),
    ['comprobantes-emitidos:2026-06', 'comprobantes-recibidos:2026-06', 'iibb-declarado:2026-06', 'autonomos-cuota:2026-06']);
  // Datos de septiembre y de junio: julio y agosto (intercalados, sin nada) siguen pidiéndose.
  const out = tmp(); const d = path.join(out, 'datos');
  for (const [id, tipo] of [['comprobantes-emitidos', 'emitidos'], ['comprobantes-recibidos', 'recibidos']]) {
    fs.mkdirSync(path.join(d, id), { recursive: true });
    fs.writeFileSync(path.join(d, id, 'mc.csv'), '"Fecha de Emisión";"Tipo de Comprobante"\r\n"2026-09-01";"1"');
    fs.writeFileSync(path.join(d, id, 'manifiesto.json'), JSON.stringify({ [`${tipo}:2026-09-01:2026-09-30`]: { ok: true, fecha: '2026-10-21', archivo: 'mc.csv' },
      [`${tipo}:2026-06-01:2026-06-30`]: { ok: true, fecha: '2026-07-21', archivo: 'mc.csv' } }));
  }
  const op = { paramsFile: path.join(out, 'no.json') };
  const de = (mes, hoy = '2026-10-28') => pendientesDeCarga(out, hoy, op).filter((x) => x.mes === mes).map((x) => x.clave.split(':')[0]);
  assert.deepEqual(de('2026-09'), ['iibb-declarado', 'autonomos-cuota']);
  assert.deepEqual(de('2026-08'), ['comprobantes-emitidos', 'comprobantes-recibidos', 'iibb-declarado', 'autonomos-cuota'], 'mes intercalado sin datos');
  assert.deepEqual(de('2026-07'), ['comprobantes-emitidos', 'comprobantes-recibidos', 'iibb-declarado', 'autonomos-cuota']);
  assert.deepEqual(de('2026-06'), ['iibb-declarado', 'autonomos-cuota']);
  assert.deepEqual(de('2026-04'), ['comprobantes-emitidos', 'comprobantes-recibidos', 'iibb-declarado', 'autonomos-cuota']);
  assert.deepEqual(de('2026-03'), [], 'solo seis meses');
  assert.deepEqual(de('2026-10'), [], 'el mes en curso no se pide');
  assert.deepEqual(de('2025-12'), ['ganancias-determinado']);
  assert.ok(!de('2025-12', '2026-06-15').includes('ganancias-determinado'), 'la DJ anual se pide desde julio');
  // CM03 cargado: se pide el pago sin decir que está impago; un pago parcial no lo saca del cartel.
  guardarManual(out, { mes: '2026-09', concepto: 'iibb-declarado', importe: '1.234.567,89', fuente: 'cartel de pendientes' });
  let pago = pendientesDeCarga(out, '2026-10-28', op).find((x) => x.clave === 'iibb-pagado:2026-09');
  assert.equal(pago.estadoPago, 'pago no encontrado (sin cobertura)');
  assert.match(pago.porque, /no prueba que esté impago/);
  guardarManual(out, { mes: '2026-09', concepto: 'iibb-pagado', importe: 1000000, fuente: 'VEP', fechaPago: '2026-10-15' });
  pago = pendientesDeCarga(out, '2026-10-28', op).find((x) => x.clave === 'iibb-pagado:2026-09');
  assert.equal(pago.estadoPago, 'pago parcial: falta conciliar');
  guardarManual(out, { mes: '2026-09', concepto: 'iibb-pagado', importe: 234567.89, fuente: 'VEP 2', fechaPago: '2026-10-22' });
  guardarManual(out, { mes: '2026-09', concepto: 'autonomos-cuota', importe: 95000, fuente: 'CCMA' });
  assert.deepEqual(de('2026-09'), []);
  // La DJ anual se guarda en diciembre del período y no abre ese mes en el selector.
  guardarManual(out, { mes: '2025-12', concepto: 'ganancias-determinado', importe: 5000000, fuente: 'F.711' });
  assert.deepEqual(de('2025-12'), []);
  assert.ok(!mesesDisponibles(out, '2026-10-28').includes('2025-12'));
  assert.equal(panelMes(out, '2026-09', { hoy: '2026-10-28', ...op }).ganancias.djAnterior.valor, 5000000);
  assert.match(pendientesDeCarga(out, '2026-10-28', op).find((x) => x.accion.tipo === 'arca').como, /fiscalos\.ps1 correr/);
});

// ---------------- DJ presentadas (Cuentas Tributarias y SIFERE) ----------------
test('DJ presentadas: Cuentas Tributarias (todas las nacionales del período, F.711 anual) y CM03 de SIFERE con su rectificativa', async () => {
  const { djDelPeriodo, djAnualGanancias, cm03Sifere } = await import('../src/app/presentaciones.js');
  const { pendientesDeCarga } = await import('../src/app/pendientes.js');
  const out = escenario(); const d = path.join(out, 'datos');
  const vig = (id, nombre, headers, rows) => {
    fs.mkdirSync(path.join(d, id, 'vigente', 'acumulado'), { recursive: true });
    fs.writeFileSync(path.join(d, id, 'vigente', 'acumulado', nombre), toCsv(rows, headers.map((h, i) => ({ header: h, value: (r) => r[i] }))));
    fs.writeFileSync(path.join(d, id, 'vigente.json'), JSON.stringify({ acumulado: { cuando: '2026-10-25T14-00-00', nivel: 'validado', archivos: [nombre] } }));
  };
  // Estructura de las grillas reales (diagnóstico del 25/10), con datos inventados.
  vig('ct-ddjj', 'dj.csv', ['Fecha Operación', 'Est.', 'Formulario', 'Versión', 'Impuesto', 'Periodo', 'Descripción', 'Observaciones'], [
    ['16/10/2026 14:55', '0', '2051', '101', '30 - IVA', '20260900', 'Comprobante general', 'VALIDO'],
    ['09/10/2026 10:35', '0', '744', '900', '220 - PRESENTAC. DJ RET. Y/O PERCEP', '20260900', 'Contribuyente No Inscripto en el Impuesto', 'VALIDO'],
    ['05/10/2026 10:26', '0', '931', '4700', '301 - EMPLEADOR-APORTES SEG. SOCIAL', '20260900', 'Comprobante general', 'VALIDO'],
    ['16/09/2026 12:32', '0', '2051', '101', '30 - IVA', '20260800', 'Comprobante general', 'VALIDO'],
    ['23/06/2026 11:06', '0', '711', '2800', '11 - GANANCIAS PERSONAS FISICAS', '20250000', 'Comprobante general', 'VALIDO'],
    ['01/06/2026 10:00', '0', '711', '2800', '11 - GANANCIAS PERSONAS FISICAS', '20250000', 'Comprobante general', 'RECHAZADO'],
  ]);
  vig('sifere-consultas-ddjj-mensuales', 'cm03.csv', ['Acciones', 'Anticipo', 'Estado', 'Fecha Creación', 'Fecha y Hora Presentación', 'Resultado Presentación'], [
    ['', '202609 - 0', '4 - PRESENTADA', '14/10/2026', '14/10/2026 12:50:50', 'OK Transacción: 1'],
    ['', '202605 - 1', '4 - PRESENTADA', '24/06/2026', '24/06/2026 14:43:10', 'OK Transacción: 2'],
    ['', '202605 - 0', '4 - PRESENTADA', '17/06/2026', '17/06/2026 15:19:20', 'OK Transacción: 3'],
    ['', '202605 - 2', '1 - BORRADOR', '17/06/2026', '', ''],
  ]);
  assert.deepEqual(djDelPeriodo(d, '2026-09').map((x) => x.formulario), ['2051', '744', '931']);
  const gan = djAnualGanancias(d, 2025);
  assert.deepEqual([gan.formulario, gan.fecha, gan.fechaIso], ['711', '23/06/2026 11:06', '2026-06-23'], 'la rechazada no cuenta');
  assert.equal(djAnualGanancias(d, 2024), null);
  assert.equal(cm03Sifere(d, '2026-09').presentada.rectificativa, 0);
  const may = cm03Sifere(d, '2026-05');
  assert.equal(may.presentada.rectificativa, 1, 'la rectificativa presentada más alta; el borrador no');
  assert.equal(may.borradores.length, 1);
  assert.equal(cm03Sifere(d, '2026-07').presentada, null);
  // En el panel y en el cartel.
  const p = panelMes(out, '2026-09', { hoy: '2026-10-28', paramsFile: path.join(out, 'x.json') });
  assert.equal(p.iibb.presentacion.fecha, '2026-10-14'); assert.equal(p.iibb.presentacion.nivel, 'verificado');
  assert.match(p.iibb.presentacion.nota, /original/);
  assert.equal(p.ganancias.djAnteriorPresentada.formulario, '711');
  assert.equal(p.djDelPeriodo.length, 3);
  const pend = pendientesDeCarga(out, '2026-10-28', { paramsFile: path.join(out, 'x.json') });
  assert.match(pend.find((x) => x.clave === 'iibb-declarado:2026-09').titulo, /presentada el 14\/10\/2026/);
  assert.match(pend.find((x) => x.clave === 'iibb-declarado:2026-05').como, /rectificativa 1 presentada el 24\/06\/2026/);
  assert.match(pend.find((x) => x.clave === 'ganancias-determinado:2025').titulo, /F\.711 presentada el 23\/06\/2026/);
});

// ---------------- Conciliación de pagos (revisión de 337b136) ----------------
function conPagosCt(out, ventanas) {
  const d = path.join(out, 'datos'); const man = {};
  for (const [clave, filas] of Object.entries(ventanas)) {
    const dir = path.join(d, 'ct-pagos', 'vigente', clave); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'p.csv'), toCsv(filas, ['Fecha Operación', 'Formulario', 'Versión', 'Impuesto', 'Período Fiscal', 'Importe'].map((h, i) => ({ header: h, value: (r) => r[i] }))));
    const [desde, hasta] = clave.split('_');
    man[clave] = { cuando: 'c', nivel: 'validado', archivos: ['p.csv'], desde, hasta };
  }
  fs.writeFileSync(path.join(d, 'ct-pagos', 'vigente.json'), JSON.stringify(man));
}

test('pagos: el CM03 de septiembre pagado el 20/10 baja la obligación de septiembre y sale de la caja de octubre, nunca de la de septiembre', async () => {
  const { guardarManual } = await import('../src/app/manuales.js');
  const out = escenario(); const op = { hoy: '2026-10-28', paramsFile: path.join(out, 'x.json') };
  guardarManual(out, { mes: '2026-09', concepto: 'iibb-declarado', importe: 2500, fuente: 'CM03' });
  guardarManual(out, { mes: '2026-09', concepto: 'iibb-pagado', importe: 2500, fuente: 'VEP', fechaPago: '2026-10-20' });
  // Anticipo de Ganancias del período fiscal 2026 pagado en octubre: caja de octubre.
  guardarManual(out, { mes: '2026-08', concepto: 'ganancias-anticipo', importe: 4000, fuente: 'VEP anticipo 1', fechaPago: '2026-10-05' });
  const sep = panelMes(out, '2026-09', op); const oct = panelMes(out, '2026-10', op);
  assert.equal(sep.iibb.estado, 'pago cargado a mano', 'cuenta contra la obligación de septiembre');
  assert.ok(!sep.pagos.filas.some((f) => f.clave === 'iibb'), 'no sale de la caja de septiembre');
  const iibbOct = oct.pagos.filas.find((f) => f.clave === 'iibb');
  assert.deepEqual([iibbOct.fecha, iibbOct.importe, iibbOct.corresponde], ['2026-10-20', 2500, 'período 09/2026']);
  assert.ok(oct.pagos.filas.some((f) => f.clave === 'ganancias' && f.importe === 4000 && f.fecha === '2026-10-05'));
  assert.equal(oct.ganancias.pagosEnElMes.valor, 7000 + 4000, 'el de Cuentas Tributarias (17/10) y el anticipo cargado');
  // Una carga vieja sin fecha de pago: cuenta contra su período, no entra en ninguna caja, y se avisa.
  const f = path.join(out, 'importados', 'manuales.json'); const lista = JSON.parse(fs.readFileSync(f, 'utf8'));
  lista.push({ id: 'vieja', mes: '2026-07', concepto: 'iibb-pagado', importe: 100, fuente: 'VEP', cuando: 'x', actualizado: 'x' });
  fs.writeFileSync(f, JSON.stringify(lista));
  assert.match(panelMes(out, '2026-07', op).pagos.sinFecha.nota, /sin fecha de pago/);
  assert.ok(!panelMes(out, '2026-07', op).pagos.filas.some((x) => x.id === 'vieja'));
});

test('pagos: el mismo pago en ARCA y a mano (o en dos ventanas de Cuentas Tributarias) se suma una sola vez; dos pagos distintos, los dos', async () => {
  const { guardarManual } = await import('../src/app/manuales.js');
  const out = escenario(); const op = { hoy: '2026-10-28', paramsFile: path.join(out, 'x.json') };
  // Dos ventanas de consulta que se superponen con la misma fila de autónomos, y un pago de Ganancias.
  const fila = ['18/10/2026', '1571', '1', '308 - APORTES SEG.SOCIAL AUTONOMOS', '202609', '62.000,00'];
  conPagosCt(out, { '2026-10-01_2026-10-20': [fila], '2026-10-15_2026-10-26': [fila, ['17/10/2026', '1571', '1', '11 - GANANCIAS PERSONAS HUMANAS', '202500', '7.000,00']] });
  let p = panelMes(out, '2026-10', op);
  assert.equal(p.pagos.filas.filter((x) => x.clave === 'autonomos').length, 1, 'ventanas superpuestas: una vez');
  // El mismo pago cargado a mano (mismo importe, fecha cercana): duplicado, no se suma.
  guardarManual(out, { mes: '2026-09', concepto: 'autonomos', importe: '62.000', fuente: 'boleta', fechaPago: '2026-10-19' });
  p = panelMes(out, '2026-10', op);
  const dup = p.pagos.filas.find((x) => x.estadoConciliacion === 'duplicado');
  assert.ok(dup); assert.match(dup.nota, /no se suma/);
  assert.equal(p.pagos.propios, 62000 + 7000);
  assert.equal(p.autonomos.pagos.valor, 62000);
  // Un pago distinto (otro importe, con fecha): se suma.
  guardarManual(out, { mes: '2026-10', concepto: 'autonomos', importe: '5.000', fuente: 'boleta otra', fechaPago: '2026-10-25' });
  p = panelMes(out, '2026-10', op);
  assert.equal(p.pagos.propios, 62000 + 7000 + 5000);
});

test('pagos de IIBB: un volante de SIFERE solo cuenta si está pagado; el mismo pago a mano y en SIFERE no se suma dos veces', async () => {
  const { guardarManual } = await import('../src/app/manuales.js');
  const { volantesSifere } = await import('../src/app/panel.js');
  const out = escenario(); const d = path.join(out, 'datos'); const op = { hoy: '2026-10-28', paramsFile: path.join(out, 'x.json') };
  const dir = path.join(d, 'sifere-consultas-volantes-pago', 'vigente', 'acumulado'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'v.csv'), toCsv([['', '202609 - 0', '14/10/2026', '2.500,00', 'VEP', 'Generado'], ['', '202608 - 0', '14/09/2026', '3.000,00', 'VEP', 'Pagado']],
    ['Acciones', 'Anticipo', 'Fecha Generación', 'Monto Total', 'Medio de Pago', 'Estado'].map((h, i) => ({ header: h, value: (r) => r[i] }))));
  fs.writeFileSync(path.join(d, 'sifere-consultas-volantes-pago', 'vigente.json'), JSON.stringify({ acumulado: { cuando: 'c', nivel: 'validado', archivos: ['v.csv'] } }));
  assert.deepEqual(volantesSifere(d, '2026-09').map((v) => v.pagado), [false]);
  guardarManual(out, { mes: '2026-09', concepto: 'iibb-declarado', importe: 2500, fuente: 'CM03' });
  guardarManual(out, { mes: '2026-08', concepto: 'iibb-declarado', importe: 3000, fuente: 'CM03' });
  let sep = panelMes(out, '2026-09', op);
  assert.equal(sep.iibb.estado, 'pago no encontrado (sin cobertura)', 'volante generado: no es un pago');
  assert.match(sep.iibb.volantesSinPago[0].nota, /pago sin verificar/);
  const ago = panelMes(out, '2026-08', op);
  assert.equal(ago.iibb.estado, 'pagado verificado');
  // El pago de agosto también cargado a mano: duplicado del volante pagado, no se suma.
  guardarManual(out, { mes: '2026-08', concepto: 'iibb-pagado', importe: 3000, fuente: 'VEP', fechaPago: '2026-09-15' });
  const ago2 = panelMes(out, '2026-08', op);
  assert.equal(ago2.iibb.estado, 'pagado verificado');
  assert.equal(ago2.iibb.pagos.valor, 3000);
  assert.equal(ago2.iibb.pagosNoSumados.length, 1);
});

test('conciliación con PFOS: lo facturado es el importe total de los comprobantes (con no gravado y notas de crédito)', async () => {
  const { integraciones } = await import('../src/app/integraciones.js');
  const out = tmp(); const d = path.join(out, 'datos');
  fs.mkdirSync(path.join(d, 'comprobantes-emitidos'), { recursive: true });
  // Factura con parte no gravada y una nota de crédito.
  const cab = ['Fecha de Emisión', 'Tipo de Comprobante', 'Punto de Venta', 'Número Desde', 'Imp. Neto Gravado Total', 'Imp. Neto No Gravado', 'IVA 21%', 'Total IVA', 'Imp. Total', 'Nro. Doc. Emisor', 'Denominación Emisor'];
  const filas = [['2026-09-01', '6', '1', '1', '1000,00', '500,00', '210,00', '210,00', '1710,00', '', ''], ['2026-09-02', '8', '1', '2', '100,00', '0,00', '21,00', '21,00', '121,00', '', '']];
  fs.writeFileSync(path.join(d, 'comprobantes-emitidos', 'mc.csv'), [cab, ...filas].map((f) => f.map((x) => `"${x}"`).join(';')).join('\r\n'));
  fs.writeFileSync(path.join(d, 'comprobantes-emitidos', 'manifiesto.json'), JSON.stringify({ 'emitidos:2026-09-01:2026-09-30': { ok: true, fecha: '2026-10-02', archivo: 'mc.csv' } }));
  fs.mkdirSync(path.join(out, 'pfos'), { recursive: true });
  fs.writeFileSync(path.join(out, 'pfos', '2026-09.json'), JSON.stringify({ mes: '2026-09', cuentaPfos: '1', corte: '2026-09-30', mesCerrado: true,
    cuenta: { verificada: true, estado: 'verificada', motivo: 'ok' }, ventas: { ordenes: 1, totalConIva: 1500 }, retencionesMp: { importe: 0 } }));
  const c = integraciones(out, '2026-09').pfos.control;
  assert.equal(c.facturado, 1710 - 121, 'importe total, con la nota de crédito restando');
  assert.equal(c.diferencia, 1710 - 121 - 1500);
});

test('Ganancias: la proyección usa el CM03 real y la cuota real de autónomos cuando existen; si no, lo marca como hipótesis', async () => {
  const { guardarManual } = await import('../src/app/manuales.js');
  const out = tmp(); const d = path.join(out, 'datos');
  fs.mkdirSync(path.join(d, 'comprobantes-emitidos'), { recursive: true });
  fs.writeFileSync(path.join(d, 'comprobantes-emitidos', 'mc.csv'), csvMc([['2026-01-10', '1', '1', '1', '1000000,00', '210000,00', '210000,00', '1210000,00', '', ''], ['2026-02-10', '1', '1', '2', '1000000,00', '210000,00', '210000,00', '1210000,00', '', '']]));
  fs.writeFileSync(path.join(d, 'comprobantes-emitidos', 'manifiesto.json'), JSON.stringify({ 'emitidos:2026-01-01:2026-02-28': { ok: true, fecha: '2026-03-02', archivo: 'mc.csv' } }));
  const params = path.join(out, 'contribuyente.json');
  fs.writeFileSync(params, JSON.stringify({ deduccionEspecial: 'ap1', cargasFamilia: { conyuge: 0, hijos: 0 }, ingresosBrutos: [{ jurisdiccion: 'X', coeficiente: 1, alicuota: 0.03 }], autonomosMensual: 50000 }));
  for (const m of ['2026-01', '2026-02']) guardarManual(out, { mes: m, concepto: 'resultado-comercial', importe: 8000000, fuente: 'PFOS' });
  const nota = () => panelMes(out, '2026-02', { hoy: '2026-03-05', paramsFile: params }).ganancias.estimado.nota;
  assert.match(nota(), /IIBB por alícuota \(hipótesis\) en 2026-01, 2026-02; autónomos de params \(hipótesis\) en 2026-01, 2026-02/);
  const antes = panelMes(out, '2026-02', { hoy: '2026-03-05', paramsFile: params }).ganancias.estimado.valor;
  for (const m of ['2026-01', '2026-02']) {
    guardarManual(out, { mes: m, concepto: 'iibb-declarado', importe: 10000, fuente: 'CM03' });
    guardarManual(out, { mes: m, concepto: 'autonomos-cuota', importe: 90000, fuente: 'CCMA' });
  }
  assert.match(nota(), /IIBB real \(CM03\) en todos los meses; autónomos reales en todos los meses/);
  const despues = panelMes(out, '2026-02', { hoy: '2026-03-05', paramsFile: params }).ganancias.estimado.valor;
  assert.notEqual(despues, antes, 'con 10.000 de IIBB real en vez de 30.000 por alícuota y 90.000 de autónomos en vez de 50.000');
  // Los pagos no se restan otra vez: un pago de IIBB cargado no cambia la proyección.
  guardarManual(out, { mes: '2026-02', concepto: 'iibb-pagado', importe: 10000, fuente: 'VEP', fechaPago: '2026-03-15' });
  assert.equal(panelMes(out, '2026-02', { hoy: '2026-03-05', paramsFile: params }).ganancias.estimado.valor, despues);
});

test('F.931 y SICORE: aparte de los impuestos propios; DJ presentada no es pagada; el cartel pide el importe y después el pago', async () => {
  const { guardarManual } = await import('../src/app/manuales.js');
  const { clasificarImpuesto } = await import('../src/app/panel.js');
  const { pendientesDeCarga } = await import('../src/app/pendientes.js');
  assert.equal(clasificarImpuesto('301 - EMPLEADOR-APORTES SEG. SOCIAL').clave, 'empleador');
  assert.equal(clasificarImpuesto('351 - CONTRIBUCIONES SEG. SOCIAL').clave, 'empleador');
  assert.equal(clasificarImpuesto('308 - APORTES SEG.SOCIAL AUTONOMOS').clave, 'autonomos', 'los aportes de autónomos son propios');
  assert.equal(clasificarImpuesto('217 - SICORE-IMPTO.A LAS GANANCIAS').clave, 'agente');
  const out = escenario(); const d = path.join(out, 'datos'); const op = { hoy: '2026-10-28', paramsFile: path.join(out, 'x.json') };
  const dir = path.join(d, 'ct-ddjj', 'vigente', 'acumulado'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dj.csv'), toCsv([['05/10/2026 10:26', '0', '931', '4700', '301 - EMPLEADOR-APORTES SEG. SOCIAL', '20260900', 'Comprobante general', 'VALIDO'],
    ['09/10/2026 10:35', '0', '744', '900', '220 - PRESENTAC. DJ RET. Y/O PERCEP', '20260900', 'Contribuyente No Inscripto en el Impuesto', 'VALIDO']],
  ['Fecha Operación', 'Est.', 'Formulario', 'Versión', 'Impuesto', 'Periodo', 'Descripción', 'Observaciones'].map((h, i) => ({ header: h, value: (r) => r[i] }))));
  fs.writeFileSync(path.join(d, 'ct-ddjj', 'vigente.json'), JSON.stringify({ acumulado: { cuando: 'c', nivel: 'validado', archivos: ['dj.csv'] } }));
  conPagosCt(out, { '2026-10-01_2026-10-26': [['09/10/2026', '1571', '1', '301 - EMPLEADOR-APORTES SEG. SOCIAL', '202609', '80.000,00'], ['17/10/2026', '1571', '1', '11 - GANANCIAS PERSONAS HUMANAS', '202500', '7.000,00']] });
  let p = panelMes(out, '2026-09', op);
  const f931 = p.terceros.find((o) => o.id === 'f931'); const sicore = p.terceros.find((o) => o.id === 'sicore');
  assert.equal(f931.presentacion.fecha, '05/10/2026 10:26');
  assert.equal(f931.estado, 'presentada, importe sin cargar', 'presentada no es pagada');
  assert.equal(f931.pagos.valor, 80000);
  assert.equal(sicore.estado, 'presentada, importe sin cargar');
  // En la caja de octubre: el F.931 va como empleador, no como impuesto propio.
  const oct = panelMes(out, '2026-10', op);
  assert.equal(oct.pagos.propios, 7000); assert.equal(oct.pagos.comoEmpleador, 80000);
  let claves = pendientesDeCarga(out, '2026-10-28', op).filter((x) => x.mes === '2026-09').map((x) => x.clave);
  assert.ok(claves.includes('f931-declarado:2026-09') && claves.includes('sicore-declarado:2026-09'));
  assert.ok(!pendientesDeCarga(out, '2026-10-28', op).some((x) => x.clave === 'f931-declarado:2026-08'), 'sin DJ presentada, no se pide');
  guardarManual(out, { mes: '2026-09', concepto: 'f931-declarado', importe: 80000, fuente: 'acuse F.931' });
  guardarManual(out, { mes: '2026-09', concepto: 'sicore-declarado', importe: 12000, fuente: 'acuse F.744' });
  p = panelMes(out, '2026-09', op);
  assert.equal(p.terceros.find((o) => o.id === 'f931').estado, 'pagado verificado');
  assert.equal(p.terceros.find((o) => o.id === 'sicore').estado, 'pago no encontrado (sin cobertura)');
  claves = pendientesDeCarga(out, '2026-10-28', op).filter((x) => x.mes === '2026-09').map((x) => x.clave);
  assert.ok(claves.includes('sicore-pagado:2026-09') && !claves.includes('f931-pagado:2026-09'));
});

test('volantes de SIFERE: solo un estado positivo sin ambigüedad cuenta como pagado', async () => {
  const { volantePagado } = await import('../src/app/panel.js');
  for (const e of ['Pagado', 'PAGADO', 'Abonada', 'Acreditado', 'Pagado total']) assert.equal(volantePagado(e), true, e);
  for (const e of ['NO PAGADO', 'No pagado', 'Impagado', 'IMPAGO', 'Pago parcial', 'Pagado parcialmente', 'Pendiente de pago', 'Generado',
    'Sin pagar', 'No abonado', 'Rechazado', 'Anulado', 'Pagado / Anulado', 'Vencido', 'Desconocido', '', null]) assert.equal(volantePagado(e), false, String(e));
});

test('volantes de SIFERE: «NO PAGADO» e «Impagado» no descuentan la obligación del período', async () => {
  const { volantesSifere } = await import('../src/app/panel.js');
  const out = escenario(); const d = path.join(out, 'datos');
  const dir = path.join(d, 'sifere-consultas-volantes-pago', 'vigente', 'acumulado'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'v.csv'), toCsv([['', '202609 - 0', '14/10/2026', '2.500,00', 'VEP', 'NO PAGADO'], ['', '202609 - 1', '15/10/2026', '2.500,00', 'VEP', 'Impagado'],
    ['', '202609 - 2', '16/10/2026', '2.500,00', 'VEP', 'Pago parcial']],
  ['Acciones', 'Anticipo', 'Fecha Generación', 'Monto Total', 'Medio de Pago', 'Estado'].map((h, i) => ({ header: h, value: (r) => r[i] }))));
  fs.writeFileSync(path.join(d, 'sifere-consultas-volantes-pago', 'vigente.json'), JSON.stringify({ acumulado: { cuando: 'c', nivel: 'validado', archivos: ['v.csv'] } }));
  assert.deepEqual(volantesSifere(d, '2026-09').map((v) => v.pagado), [false, false, false]);
  const { guardarManual } = await import('../src/app/manuales.js');
  guardarManual(out, { mes: '2026-09', concepto: 'iibb-declarado', importe: 2500, fuente: 'CM03' });
  const sep = panelMes(out, '2026-09', { hoy: '2026-10-28', paramsFile: path.join(out, 'x.json') });
  assert.equal(sep.iibb.estado, 'pago no encontrado (sin cobertura)');
  assert.equal(sep.iibb.volantesSinPago.length, 3);
});

test('conciliación de pagos: el mismo importe el mismo día para OTRO período no es un duplicado; sin período, no se afirma', async () => {
  const { conciliarPagos, mismoPeriodo } = await import('../src/app/pagos.js');
  assert.equal(mismoPeriodo('2026-09', '2026-09'), 'igual');
  assert.equal(mismoPeriodo('2026-09', '2026-10'), 'distinto');
  assert.equal(mismoPeriodo('2025', '2025'), 'igual');
  assert.equal(mismoPeriodo('2025', '2026'), 'distinto');
  assert.equal(mismoPeriodo('2025', '2025-12'), 'igual');
  assert.equal(mismoPeriodo('2025', '2026-03'), 'desconocido', 'un anticipo del período 2025 se paga en 2026');
  assert.equal(mismoPeriodo(null, '2026-09'), 'desconocido');
  // IIBB de septiembre verificado, $500 el 20/10, y uno de octubre cargado a mano, $500 el 20/10: son dos pagos.
  const sep = { clave: 'iibb', importe: 500, fecha: '2026-10-20', periodo: '2026-09', fuente: 'SIFERE' };
  let c = conciliarPagos([sep], [{ clave: 'iibb', importe: 500, fecha: '2026-10-20', periodo: '2026-10' }]);
  assert.equal(c.total, 1000); assert.equal(c.duplicados.length, 0); assert.equal(c.inciertos.length, 0);
  // El mismo período: duplicado.
  c = conciliarPagos([sep], [{ clave: 'iibb', importe: 500, fecha: '2026-10-21', periodo: '2026-09' }]);
  assert.equal(c.total, 500); assert.equal(c.duplicados.length, 1);
  // Sin período en el cargado (fila de un archivo importado): sin conciliar, no se suma ni se afirma duplicado.
  c = conciliarPagos([sep], [{ clave: 'iibb', importe: 500, fecha: '2026-10-20', periodo: null }]);
  assert.equal(c.total, 500); assert.equal(c.duplicados.length, 0); assert.equal(c.inciertos[0].estadoConciliacion, 'sin conciliar');
  // Sin período en el verificado: igual.
  c = conciliarPagos([{ ...sep, periodo: null }], [{ clave: 'iibb', importe: 500, fecha: '2026-10-20', periodo: '2026-09' }]);
  assert.equal(c.inciertos[0].estadoConciliacion, 'sin conciliar');
  // Sin fecha y de otro período: distinto (se suma).
  c = conciliarPagos([sep], [{ clave: 'iibb', importe: 500, fecha: null, periodo: '2026-08' }]);
  assert.equal(c.total, 1000);
});

test('pagos en la caja: Cuentas Tributarias de septiembre y una carga de octubre, mismo importe y día, suman los dos; Ganancias anual se compara por año', async () => {
  const { guardarManual } = await import('../src/app/manuales.js');
  const out = escenario(); const op = { hoy: '2026-10-28', paramsFile: path.join(out, 'x.json') };
  conPagosCt(out, { '2026-10-01_2026-10-26': [['20/10/2026', '1571', '1', '308 - APORTES AUTONOMOS', '202609', '500,00'],
    ['17/10/2026', '1571', '1', '11 - GANANCIAS PERSONAS HUMANAS', '202500', '7.000,00']] });
  guardarManual(out, { mes: '2026-10', concepto: 'autonomos', importe: 500, fuente: 'boleta', fechaPago: '2026-10-20' });
  let oct = panelMes(out, '2026-10', op);
  const aut = oct.pagos.filas.filter((f) => f.clave === 'autonomos');
  assert.equal(aut.length, 2); assert.ok(aut.every((f) => f.computado), 'los dos se suman');
  assert.equal(oct.pagos.noSumados, 0);
  // Anticipo de Ganancias cargado para un mes de 2025 (mismo año que el período 2025 de Cuentas Tributarias): duplicado.
  guardarManual(out, { mes: '2025-12', concepto: 'ganancias-anticipo', importe: 7000, fuente: 'VEP', fechaPago: '2026-10-17' });
  oct = panelMes(out, '2026-10', op);
  assert.equal(oct.pagos.filas.find((f) => f.clave === 'ganancias' && !f.computado)?.estadoConciliacion, 'duplicado');
  // Cargado para un mes de 2026: no se puede saber si es del período 2025 → sin conciliar, no se suma.
  const out2 = escenario();
  conPagosCt(out2, { '2026-10-01_2026-10-26': [['17/10/2026', '1571', '1', '11 - GANANCIAS PERSONAS HUMANAS', '202500', '7.000,00']] });
  guardarManual(out2, { mes: '2026-08', concepto: 'ganancias-anticipo', importe: 7000, fuente: 'VEP', fechaPago: '2026-10-17' });
  const oct2 = panelMes(out2, '2026-10', { ...op, paramsFile: path.join(out2, 'x.json') });
  assert.equal(oct2.pagos.filas.find((f) => f.clave === 'ganancias' && !f.computado)?.estadoConciliacion, 'sin conciliar');
  assert.equal(oct2.pagos.noSumados, 1);
});
