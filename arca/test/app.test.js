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
  // Rentabilidad sin costo de mercadería: resultado PARCIAL, nunca neto definitivo.
  assert.equal(p.rentabilidad.margen.estado, 'parcial');
  assert.ok(p.rentabilidad.margen.faltan.includes('Costo de la mercadería vendida'));
  assert.equal(p.rentabilidad.neto.estado, 'parcial');
  assert.ok(p.rentabilidad.faltantes.some((f) => /Costo de la mercadería vendida/.test(f.dato) && /No se reemplaza por las compras/.test(f.como)));
  assert.match(p.rentabilidad.nota, /IVA no se resta/);
  assert.ok(p.obligaciones.some((o) => o.tipo === 'deuda' && o.vencimiento === '2026-12-21' && o.estado === 'por vencer'));
  assert.equal(p.integraciones.pfos.conectado, false);
});

test('rentabilidad: cargas manuales, proveedores de ARCA, una fuente por concepto y el IVA fuera del resultado', async () => {
  const { guardarManual, eliminarManual, listarManuales, clasificarProveedor } = await import('../src/app/manuales.js');
  const out = escenario();
  const params = path.join(out, 'contribuyente.json');
  fs.writeFileSync(params, JSON.stringify({ deduccionEspecial: 'ap1', cargasFamilia: { conyuge: 0, hijos: 0 }, ingresosBrutos: [{ jurisdiccion: 'X', coeficiente: 1, alicuota: 0.03 }], autonomosMensual: 0 }));
  let p = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: params });
  const prov = Object.fromEntries(p.rentabilidad.proveedores.map((x) => [x.nombre, x]));
  assert.equal(prov['MERCADOLIBRE S.R.L.'].neto, 7500, 'la nota de crédito resta');
  assert.equal(prov['MERCADOLIBRE S.R.L.'].sugerida, 'mercado-libre');
  assert.equal(prov['MERCADOLIBRE S.R.L.'].clase, null, 'la sugerencia no se aplica sola');
  assert.equal(p.rentabilidad.referencia.sinClasificar.valor, 50000 + 7500 + 3000);
  // Clasificación (una vez): ML -> cargos, contador -> gasto, mayorista -> mercadería.
  clasificarProveedor(out, { clave: '30703088534', nombre: 'MERCADOLIBRE S.R.L.', clase: 'mercado-libre' });
  clasificarProveedor(out, { clave: '20222222223', nombre: 'ESTUDIO CONTABLE PEREZ', clase: 'gasto' });
  clasificarProveedor(out, { clave: '30111111118', nombre: 'DISTRIBUIDORA MAYORISTA SA', clase: 'mercaderia' });
  // CMV y lo que falta, a mano; IIBB del CM03 a mano.
  guardarManual(out, { mes: '2026-09', concepto: 'costo-mercaderia', importe: '40.000,00', fuente: 'eCom: costo de lo vendido' });
  guardarManual(out, { mes: '2026-09', concepto: 'publicidad', importe: 0, fuente: 'no hubo campañas' });
  guardarManual(out, { mes: '2026-09', concepto: 'logistica', importe: '1500', fuente: 'planilla de envíos' });
  const iibb = guardarManual(out, { mes: '2026-09', concepto: 'iibb-declarado', importe: '2.400,00', fuente: 'CM03 presentado' });
  guardarManual(out, { id: iibb.id, mes: '2026-09', concepto: 'iibb-declarado', importe: '2.500,00', fuente: 'CM03 presentado (rectificado)' });
  assert.equal(listarManuales(out).find((c) => c.id === iibb.id).historial[0].importe, 2400, 'la corrección guarda el valor anterior');
  assert.throws(() => guardarManual(out, { mes: '2026-09', concepto: 'publicidad', importe: '5', fuente: '' }), /fuente/);
  p = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: params });
  const r = p.rentabilidad; const L = Object.fromEntries(r.lineas.map((l) => [l.clave, l]));
  assert.equal(r.ventas.cifra.valor, 90000);
  assert.equal(L['costo-mercaderia'].cifra.valor, 40000); assert.equal(L['costo-mercaderia'].origen, 'manual');
  assert.equal(L['comisiones-ml'].cifra.valor, 7500); assert.equal(L['comisiones-ml'].origen, 'arca');
  assert.equal(L['gastos-operativos'].cifra.valor, 3000); assert.equal(L['gastos-operativos'].origen, 'arca');
  assert.equal(r.referencia.comprasMercaderia.valor, 50000, 'las compras de mercadería son referencia, no costo');
  assert.equal(r.margen.valor, 50000); assert.equal(r.margen.estado, 'completo'); assert.equal(r.margenPct, 55.56);
  assert.equal(r.operativo.valor, 90000 - 40000 - 7500 - 0 - 1500 - 3000);
  assert.equal(r.operativo.estado, 'completo');
  assert.equal(p.iibb.declarado.valor, 2500); assert.equal(p.iibb.declarado.nivel, 'manual');
  assert.equal(r.antesGanancias.valor, 38000 - 2500);
  // Ganancias necesita el CMV de enero a septiembre: no se inventa con las compras.
  assert.equal(p.ganancias.estimado.nivel, 'faltante');
  assert.equal(r.neto.estado, 'parcial');
  assert.ok(r.neto.faltan.includes('Provisión de Ganancias'));
  // El IVA (8.500) no entra al resultado; está en impuestos generados con su vencimiento.
  const ivaFila = r.impuestos.filas.find((f) => f.impuesto === 'IVA');
  assert.equal(ivaFila.cifra.valor, 8500); assert.equal(ivaFila.vence, '2026-12-21'); assert.match(ivaFila.tratamiento, /no es costo/);
  assert.equal(r.obligaciones.find((o) => o.impuesto === 'IVA').cifra.valor, 8500);
  // Una sola fuente por concepto: un archivo de gastos NO se suma a lo de ARCA; la manual manda sobre ambos.
  const a = analizarArchivo(out, { nombre: 'gastos.csv', contenido: Buffer.from('Detalle;Importe\nAlquiler;5.000,00\n').toString('base64') });
  confirmarImportacion(out, { hash: a.hash, concepto: 'gastos-operativos', colFecha: '', mesFijo: '2026-09', colImporte: 1 });
  p = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: params });
  const g = p.rentabilidad.lineas.find((l) => l.clave === 'gastos-operativos');
  assert.equal(g.cifra.valor, 5000); assert.equal(g.origen, 'importado');
  assert.deepEqual(g.alternativas.map((x) => [x.origen, x.valor]), [['arca', 3000]]);
  assert.ok(p.rentabilidad.avisos.some((x) => /Gastos operativos.*No se suman/.test(x)));
  // Deshacer la carga manual vuelve a la fuente siguiente.
  eliminarManual(out, listarManuales(out).find((c) => c.concepto === 'costo-mercaderia').id);
  assert.equal(panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: params }).rentabilidad.margen.estado, 'parcial');
});

test('Ganancias: con CMV de todos los meses del año se estima; nunca con las compras', async () => {
  const { guardarManual } = await import('../src/app/manuales.js');
  const out = escenario();
  const params = path.join(out, 'contribuyente.json');
  fs.writeFileSync(params, JSON.stringify({ deduccionEspecial: 'ap1', cargasFamilia: { conyuge: 0, hijos: 0 }, ingresosBrutos: [{ jurisdiccion: 'X', coeficiente: 1, alicuota: 0.03 }], autonomosMensual: 0 }));
  // Solo septiembre tiene comprobantes en el escenario: el año queda incompleto y se dice qué falta.
  guardarManual(out, { mes: '2026-09', concepto: 'costo-mercaderia', importe: 40000, fuente: 'eCom' });
  const p = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: params });
  assert.equal(p.ganancias.estimado.nivel, 'faltante');
  assert.match(p.ganancias.estimado.nota, /faltan los comprobantes de 2026-01/);
  assert.doesNotMatch(p.ganancias.estimado.nota, /compras/);
});

test('pagos de caja del mes: propios separados de los depositados como agente; cargas manuales marcadas', async () => {
  const { guardarManual } = await import('../src/app/manuales.js');
  const out = escenario();
  guardarManual(out, { mes: '2026-10', concepto: 'iibb-pagado', importe: '2.500', fuente: 'VEP CM03 septiembre' });
  const p = panelMes(out, '2026-10', { hoy: '2026-10-26', paramsFile: path.join(out, 'x.json') });
  const pg = p.rentabilidad.pagos;
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

test('rentabilidad: cuota de autónomos cargada a mano; aviso de doble conteo de ML solo con importes reales', async () => {
  const { guardarManual, clasificarProveedor } = await import('../src/app/manuales.js');
  const out = escenario();
  clasificarProveedor(out, { clave: '30703088534', nombre: 'MERCADOLIBRE S.R.L.', clase: 'mercado-libre' });
  guardarManual(out, { mes: '2026-09', concepto: 'publicidad', importe: 0, fuente: 'no hubo' });
  guardarManual(out, { mes: '2026-09', concepto: 'autonomos-cuota', importe: '45.000', fuente: 'boleta autónomos' });
  let r = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: path.join(out, 'x.json') }).rentabilidad;
  assert.equal(r.autonomos.cifra.valor, 45000);
  assert.equal(r.autonomos.cifra.nivel, 'manual');
  assert.ok(!r.avisos.some((a) => /contados dos veces/.test(a)), 'publicidad en 0 no duplica nada');
  guardarManual(out, { mes: '2026-09', concepto: 'publicidad', importe: 1200, fuente: 'Mercado Ads' });
  r = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: path.join(out, 'x.json') }).rentabilidad;
  assert.ok(r.avisos.some((a) => /contados dos veces/.test(a)));
});

test('carga manual marcada como estimación: se muestra como estimado y el resultado queda "con estimaciones"', async () => {
  const { guardarManual, clasificarProveedor } = await import('../src/app/manuales.js');
  const out = escenario();
  for (const [clave, nombre, clase] of [['30703088534', 'MERCADOLIBRE S.R.L.', 'mercado-libre'], ['20222222223', 'ESTUDIO CONTABLE PEREZ', 'gasto'], ['30111111118', 'DISTRIBUIDORA MAYORISTA SA', 'mercaderia']]) clasificarProveedor(out, { clave, nombre, clase });
  guardarManual(out, { mes: '2026-09', concepto: 'costo-mercaderia', importe: '40.000', fuente: 'PFOS (aprox.)', estimado: true });
  for (const k of ['publicidad', 'logistica']) guardarManual(out, { mes: '2026-09', concepto: k, importe: 0, fuente: 'no hubo' });
  const r = panelMes(out, '2026-09', { hoy: '2026-10-26', paramsFile: path.join(out, 'x.json') }).rentabilidad;
  const cmv = r.lineas.find((l) => l.clave === 'costo-mercaderia');
  assert.equal(cmv.cifra.nivel, 'estimado');
  assert.equal(r.margen.estado, 'con estimaciones', 'nunca "completo" con un costo estimado');
  assert.equal(r.operativo.estado, 'con estimaciones');
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
