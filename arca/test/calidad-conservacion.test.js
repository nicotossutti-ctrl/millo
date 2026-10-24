import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fechaIso, verificarFechas, resumenEstados, evaluarCalidad, columnasFaltantes, estadoInforme } from '../src/portal/calidad.js';
import { rangoResultado, debeReemplazar, conservarIntento, verificarArchivos, leerVigente, leerIntentos, claveDe } from '../src/portal/conservacion.js';
import { mesesCompletos, compactarMeses, generarMatrizCobertura } from '../src/portal/coberturaHistorica.js';
import { enlaceDeConsultaValido, drillHaciaGrilla } from '../src/portal/navegar.js';
import { ejecutarTodo, fuentesDe } from '../src/portal/orquestador.js';
import { completarFiltros, extraerTablaEnPagina } from '../src/portal/extractor.js';
import { SERVICIOS } from '../src/portal/servicios.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arca-cons-'));
const P = { desde: '2026-09-01', hasta: '2026-09-30' };
const csv = (headers, filas) => '﻿' + [headers.join(';'), ...filas.map((f) => f.join(';'))].join('\r\n') + '\r\n';

// Encabezados reales de la grilla de Vencimientos de la home de Cuentas Tributarias (diagnóstico 19-49-58).
const VENCIMIENTOS = ['Impuesto', 'Concepto', 'Subconcepto', 'Período', 'Ant/Cuota', 'Fecha Vencimiento', 'Detalle'];

// Extracción base que pasa TODOS los controles, para variar de a un control por prueba.
const SERV = { id: 'svc', columnasEsperadas: ['Impuesto', 'Fecha', 'Importe'], columnaFecha: 'Fecha' };
const buena = (extra = {}) => ({
  id: 'svc', filas: 2, columnas: ['Impuesto', 'Fecha Retención', 'Importe'], finPaginacion: 'sin-siguiente',
  informados: 2, totalFuente: 'paginador', conFiltroPeriodo: true, rangoOk: true,
  fechas: { verificado: true, columna: 'Fecha Retención', enRango: 2, fueraDeRango: 0, sinFecha: 0 }, ...extra,
});

// ---------------- fechas y estados ----------------

test('fechaIso reconoce los formatos de ARCA y rechaza lo que no es fecha', () => {
  assert.equal(fechaIso('05/09/2026'), '2026-09-05');
  assert.equal(fechaIso('5-9-2026 10:31'), '2026-09-05');
  assert.equal(fechaIso('2026-09-05T00:00'), '2026-09-05');
  assert.equal(fechaIso('09/2026'), null);
  assert.equal(fechaIso(''), null);
});

test('verificarFechas cuenta filas en rango, fuera de rango y sin fecha interpretable', () => {
  const h = ['Impuesto', 'Fecha Retención', 'Importe'];
  const filas = [['IVA', '02/09/2026', '1'], ['IVA', '30/09/2026', '2'], ['IVA', '01/10/2026', '3'], ['IVA', 'pendiente', '4']];
  const v = verificarFechas(h, filas, P.desde, P.hasta, 'Fecha');
  assert.deepEqual([v.verificado, v.enRango, v.fueraDeRango, v.sinFecha], [true, 2, 1, 1]);
  assert.equal(verificarFechas(h, filas, P.desde, P.hasta, null).verificado, false, 'sin columna declarada no se adivina');
  assert.equal(verificarFechas(h, filas, P.desde, P.hasta, 'Vencimiento').verificado, false);
});

test('resumenEstados cuenta valores de Estado/Resultado (p. ej. VEP generado vs pago acreditado)', () => {
  const r = resumenEstados(['Anticipo', 'Monto Total', 'Estado', 'Resultado'], [['01', '1', 'Generado', ''], ['02', '1', 'Pagado', 'Acreditado'], ['03', '1', 'Pagado', 'Acreditado']]);
  assert.deepEqual(r.Estado, { Generado: 1, Pagado: 2 });
  assert.deepEqual(r.Resultado, { '(vacío)': 1, Acreditado: 2 });
});

// ---------------- validación: los niveles ----------------

test('evaluarCalidad: la extracción base es APTA (validada y cotejada con el paginador)', () => {
  const c = evaluarCalidad(SERV, buena(), P);
  assert.equal(c.nivel, 'apto');
  assert.equal(c.validado, true);
  assert.deepEqual(c.motivos, []);
  // Sin total de paginador (total inferido de la única tabla): validada pero NO apta para cálculos.
  const sinTot = evaluarCalidad(SERV, buena({ totalFuente: 'tabla-unica' }), P);
  assert.equal(sinTot.nivel, 'validado');
  assert.equal(sinTot.total, 'no-independiente');
  assert.equal(evaluarCalidad(SERV, buena({ informados: null, totalFuente: null }), P).nivel, 'validado');
  // El total del paginador que NO coincide invalida.
  assert.equal(evaluarCalidad(SERV, buena({ informados: 3 }), P).validado, false);
  // El total "de la única tabla visible" no es independiente: no valida ni invalida (tras paginar ve
  // solo la última página; p. ej. Mis Facilidades 14 filas en 2 páginas -> 4).
  const ultimaPagina = evaluarCalidad(SERV, buena({ filas: 14, informados: 4, totalFuente: 'tabla-unica' }), P);
  assert.equal(ultimaPagina.total, 'no-independiente');
  assert.equal(ultimaPagina.nivel, 'validado');
});

// Caso 1 de la revisión: paginación.
test('caso 1: solo un fin NATURAL de paginación valida; página repetida, grilla desaparecida o tope quedan como obtenido', () => {
  for (const fin of ['pagina-repetida', 'grilla-desaparecio', 'tope', 'sin-grilla', null]) {
    const c = evaluarCalidad(SERV, buena({ finPaginacion: fin, paginas: 3 }), P);
    assert.equal(c.validado, false, `fin ${fin}`);
    assert.equal(c.nivel, 'obtenido', `fin ${fin}`);
    assert.equal(c.paginacion, 'incompleta', `fin ${fin}`);
  }
  assert.match(evaluarCalidad(SERV, buena({ finPaginacion: 'pagina-repetida' }), P).motivos.join(' '), /falla de navegación/);
});

// Caso 2 de la revisión: fechas.
test('caso 2: con período obligatorio, una sola fila sin fecha interpretable o fuera de rango impide validar', () => {
  const sinFecha = evaluarCalidad(SERV, buena({ fechas: { verificado: true, columna: 'Fecha Retención', enRango: 1, fueraDeRango: 0, sinFecha: 1 } }), P);
  assert.equal(sinFecha.validado, false);
  assert.equal(sinFecha.temporal, 'fallida');
  assert.match(sinFecha.motivos.join(' '), /sin fecha interpretable/);
  const fuera = evaluarCalidad(SERV, buena({ fechas: { verificado: true, columna: 'Fecha Retención', enRango: 1, fueraDeRango: 1, sinFecha: 0 } }), P);
  assert.equal(fuera.validado, false);
  // Falta la columna de fecha requerida (no declarada o no encontrada): no se declara validación temporal.
  for (const fechas of [undefined, { verificado: false, motivo: 'no se encontró la columna de fecha "Fecha"' }]) {
    const c = evaluarCalidad({ ...SERV, columnaFecha: undefined }, buena({ fechas }), P);
    assert.equal(c.validado, false);
    assert.equal(c.temporal, 'no-verificada');
  }
  // Rango aplicado sin confirmar: tampoco.
  assert.equal(evaluarCalidad(SERV, buena({ rangoOk: null }), P).validado, false);
  // Fuente acumulada (sin filtro de período): la validación temporal no aplica.
  const acum = evaluarCalidad(SERV, buena({ conFiltroPeriodo: false, fechas: undefined }), P);
  assert.equal(acum.temporal, 'no-aplica');
  assert.equal(acum.validado, true);
});

// Caso 4 de la revisión: columnas.
test('caso 4: se contrastan los encabezados REALES con las columnas obligatorias, no solo la configuración', () => {
  assert.deepEqual(columnasFaltantes(['Impuesto', 'Período Fiscal'], ['Impuesto', 'Periodo', 'Importe']), ['Importe']);
  // La fuente declara columnas, pero la grilla leída no las tiene.
  const otra = evaluarCalidad(SERV, buena({ columnas: ['Notificado', 'Asunto', 'Organismo'] }), P);
  assert.equal(otra.columnas, 'no-coinciden');
  assert.equal(otra.validado, false);
  assert.match(otra.motivos.join(' '), /faltan columnas obligatorias: Impuesto, Fecha, Importe/);
  // Sin encabezados (tabla de maquetación): no se puede probar la identidad.
  assert.equal(evaluarCalidad(SERV, buena({ columnas: [] }), P).columnas, 'sin-encabezados');
  // Fuente sin columnas obligatorias declaradas: nunca se valida.
  assert.equal(evaluarCalidad({ id: 'svc' }, buena(), P).columnas, 'sin-confirmar');
  // Identidad: la extracción es de otra fuente.
  assert.equal(evaluarCalidad(SERV, buena({ id: 'ct-pagos' }), P).columnas, 'otra-fuente');
  // Grilla rechazada por configuración, aunque el que llama no lo haya detectado.
  const cc = SERVICIOS.find((s) => s.id === 'ct-cuenta-corriente');
  assert.equal(evaluarCalidad(cc, { id: cc.id, filas: 5, columnas: VENCIMIENTOS, finPaginacion: 'sin-siguiente' }, P).columnas, 'rechazadas');
});

test('un cero solo se valida con la grilla propia presente y vacía', () => {
  const cero = { id: 'svc', filas: 0, ceroConfirmado: true, encabezadosGrilla: ['Impuesto', 'Fecha', 'Importe'], conFiltroPeriodo: true, rangoOk: true };
  assert.equal(evaluarCalidad(SERV, cero, P).nivel, 'apto');
  // Cero confirmado solo por un cartel, sin grilla: no se puede probar la identidad.
  assert.equal(evaluarCalidad(SERV, { ...cero, encabezadosGrilla: undefined }, P).validado, false);
  assert.equal(evaluarCalidad(SERV, { ...cero, ceroConfirmado: false }, P).nivel, 'sin-datos');
});

test('estadoInforme: validado / descargado (columnas propias, otro control falló) / con-datos (no es de la sección)', () => {
  assert.equal(estadoInforme(evaluarCalidad(SERV, buena(), P), 2), 'validado');
  assert.equal(estadoInforme(evaluarCalidad(SERV, buena({ finPaginacion: 'pagina-repetida' }), P), 2), 'descargado');
  assert.equal(estadoInforme(evaluarCalidad(SERV, buena({ columnas: ['Otra'] }), P), 2), 'con-datos');
  assert.equal(estadoInforme(evaluarCalidad(SERV, { filas: 0 }, P), 0), null);
});

test('completarFiltros genérico relee los campos: rango confirmado solo si tomaron las fechas', async () => {
  const mk = (tomaValor) => {
    const vals = [];
    const inputs = [0, 1].map((i) => ({ isVisible: async () => true, fill: async (v) => { vals[i] = tomaValor ? v : ''; }, inputValue: async () => vals[i] ?? '' }));
    let clicks = 0;
    const boton = { isVisible: async () => true, innerText: async () => 'Consultar', click: async () => { clicks++; } };
    const frame = { locator: (sel) => (/placeholder/.test(sel)
      ? { count: async () => 2, nth: (i) => inputs[i] }
      : { filter: () => ({ count: async () => 1, nth: () => boton }) }) };
    return { pagina: { frames: () => [frame], waitForLoadState: async () => {}, waitForTimeout: async () => {} }, clicks: () => clicks };
  };
  const ok = mk(true);
  const r = await completarFiltros(ok.pagina, P.desde, P.hasta, {}, () => {});
  assert.equal(r.rangoOk, true);
  assert.equal(r.rangoAplicado, '01/09/2026 - 30/09/2026');
  assert.equal(ok.clicks(), 1);
  const mal = await completarFiltros(mk(false).pagina, P.desde, P.hasta, {}, () => {});
  assert.equal(mal.rangoOk, false, 'si los campos no tomaron las fechas, el período no queda confirmado');
});

// ---------------- conservación ----------------

test('caso 3: rangoResultado da 0 a todo lo no validado; debeReemplazar nunca promueve evidencia, ni como primer resultado', () => {
  const apto = { filas: 83, calidad: { nivel: 'apto' } };
  const validado = { filas: 83, calidad: { nivel: 'validado' } };
  const obtenido = { filas: 5, calidad: { nivel: 'obtenido', columnas: 'rechazadas' } };
  const sinCalidad = { estado: 'validado', filas: 10 }; // sin validación final evaluada: no vale
  assert.deepEqual([apto, validado, obtenido, sinCalidad].map(rangoResultado), [3, 2, 0, 0]);
  assert.equal(debeReemplazar(obtenido, null), false, 'una grilla ajena no es el primer vigente');
  assert.equal(debeReemplazar(sinCalidad, null), false);
  assert.equal(debeReemplazar(validado, null), true);
  assert.equal(debeReemplazar(validado, { rango: 3 }), false, 'validado sin total no reemplaza a uno apto');
  assert.equal(debeReemplazar(apto, { rango: 3 }), true, 'otro apto más reciente sí');
  assert.equal(claveDe({ conFiltroPeriodo: true }, P), '2026-09-01_2026-09-30');
  assert.equal(claveDe({ conFiltroPeriodo: false }, P), 'acumulado');
});

test('verificarArchivos: existencia, lectura y suma exacta de filas', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.csv'), csv(['X', 'Y'], [['1', '2'], ['3', '4']]));
  fs.writeFileSync(path.join(d, 'b.csv'), csv(['X', 'Y'], [['5', '6']]));
  fs.writeFileSync(path.join(d, 'vacio.csv'), '');
  assert.deepEqual(verificarArchivos(d, ['a.csv', 'b.csv'], 3), { ok: true, filas: 3 });
  assert.match(verificarArchivos(d, ['a.csv'], 3).motivo, /tienen 2 filas y la extracción informa 3/);
  assert.match(verificarArchivos(d, ['falta.csv'], 0).motivo, /no se puede leer/);
  assert.match(verificarArchivos(d, ['vacio.csv'], 0).motivo, /vacío/);
  assert.equal(verificarArchivos(d, [], 0).ok, true, 'un cero validado no tiene archivos');
});

test('conservarIntento: guarda cada intento aparte y la corrida mala no pisa la buena', () => {
  const datosDir = tmp();
  const id = 'sifere-consultas-ddjj-mensuales';
  const H = ['Anticipo', 'Estado', 'Presentación'];
  // Corrida 1: apta (83 filas).
  const d1 = path.join(datosDir, id, 'intentos', 'c1');
  fs.mkdirSync(d1, { recursive: true });
  fs.writeFileSync(path.join(d1, 'lista.csv'), csv(H, Array.from({ length: 83 }, (_, i) => [String(i), 'Presentada', '01/01/2026'])));
  const r1 = conservarIntento({ datosDir, id, cuando: 'c1', clave: 'acumulado', dirIntento: d1, ...P,
    resultado: { filas: 83, archivos: ['lista.csv'], calidad: { nivel: 'apto' } } });
  assert.equal(r1.promovido, true);
  assert.equal(leerVigente(datosDir, id).acumulado.nivel, 'apto');
  // Corrida 2: evidencia (paginación incompleta, 3 filas): NO reemplaza.
  const d2 = path.join(datosDir, id, 'intentos', 'c2');
  fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d2, 'lista.csv'), csv(H, [['1', 'x', 'y'], ['2', 'x', 'y'], ['3', 'x', 'y']]));
  const r2 = conservarIntento({ datosDir, id, cuando: 'c2', clave: 'acumulado', dirIntento: d2, ...P,
    resultado: { filas: 3, archivos: ['lista.csv'], calidad: { nivel: 'obtenido' } } });
  assert.equal(r2.promovido, false);
  assert.match(r2.motivo, /se conserva el vigente del c1.*solo como evidencia/);
  assert.equal(leerVigente(datosDir, id).acumulado.filas, 83);
  assert.equal(fs.readFileSync(path.join(datosDir, id, 'vigente', 'acumulado', 'lista.csv'), 'utf8').split('\r\n').filter(Boolean).length, 84);
  // Corrida 3: falla antes de extraer.
  const r3 = conservarIntento({ datosDir, id, cuando: 'c3', clave: null, resultado: { estado: 'error', filas: 0, error: 'COMARB: sesión expirada' } });
  assert.match(r3.motivo, /se conserva lo obtenido el c1/);
  // Corrida 4: validada pero el archivo no tiene las filas que dice: NO se promueve.
  const d4 = path.join(datosDir, id, 'intentos', 'c4');
  fs.mkdirSync(d4, { recursive: true });
  fs.writeFileSync(path.join(d4, 'lista.csv'), csv(H, [['1', 'x', 'y']]));
  const r4 = conservarIntento({ datosDir, id, cuando: 'c4', clave: 'acumulado', dirIntento: d4, ...P,
    resultado: { filas: 90, archivos: ['lista.csv'], calidad: { nivel: 'apto' } } });
  assert.equal(r4.promovido, false);
  assert.match(r4.motivo, /NO se promueve: los archivos tienen 1 filas y la extracción informa 90/);
  assert.equal(leerVigente(datosDir, id).acumulado.cuando, 'c1');
  // Los cuatro intentos quedan trazados con su nivel y error.
  const ints = leerIntentos(datosDir, id);
  assert.deepEqual(ints.map((i) => [i.cuando, i.promovido]), [['c1', true], ['c2', false], ['c3', false], ['c4', false]]);
  assert.equal(ints[2].error, 'COMARB: sesión expirada');
  for (const c of ['c1', 'c2', 'c3', 'c4']) assert.ok(fs.existsSync(path.join(datosDir, id, 'intentos', c, 'intento.json')), c);
});

test('conservarIntento sanea el resumen guardado (CUIT e importes)', () => {
  const datosDir = tmp();
  conservarIntento({ datosDir, id: 'x', cuando: 'c1', clave: null, resultado: { estado: 'error', filas: 0, error: 'CUIT 20353544773 total $ 63.871.446,29' } });
  const txt = fs.readFileSync(path.join(datosDir, 'x', 'intentos', 'c1', 'intento.json'), 'utf8') + fs.readFileSync(path.join(datosDir, 'x', 'intentos.jsonl'), 'utf8');
  assert.doesNotMatch(txt, /20353544773|871\.446/);
});

// Caso pedido en la revisión: Cuenta Corriente que lee por accidente los 5 vencimientos de la home.
test('Cuenta Corriente que lee los 5 vencimientos de la home: queda como evidencia, nunca como dato vigente', async () => {
  const servicio = SERVICIOS.find((s) => s.id === 'ct-cuenta-corriente');
  const filasHome = Array.from({ length: 5 }, (_, i) => ['30 - IVA', '19 - DDJJ', '19 - DDJJ', `2026-0${i + 4}`, '0', `1${i}/10/2026`, '']);
  // Página falsa: el iframe Vue de la home muestra SOLO la grilla de Vencimientos (la ruta no llegó a la sección).
  const nada = { count: async () => 0, isVisible: async () => false };
  nada.filter = () => nada; nada.first = () => nada; nada.nth = () => nada;
  const frame = {
    name: () => '', url: () => 'https://ctacte.cloud.afip.gob.ar/contribuyente/scripts/vue/homeContribuyente/index.html',
    evaluate: async (fn) => (fn.name === 'extraerTablasEnDocumento' ? [{ headers: VENCIMIENTOS, rows: filasHome }] : { tablas: [], inputs: [], paginacion: [], mensajes: [] }),
    locator: () => nada,
  };
  const pagina = { frames: () => [frame], mainFrame: () => frame, url: () => frame.url(), title: async () => 'SCT',
    waitForTimeout: async () => {}, waitForLoadState: async () => {} };
  const datosDir = tmp();
  const dirIntento = path.join(datosDir, servicio.id, 'intentos', 'c1');
  const ext = await extraerTablaEnPagina(pagina, servicio, { ...P, dirSalida: dirIntento });
  assert.equal(ext.filas, 5, 'el extractor sí leyó 5 filas (la grilla de la home)');
  // El control final detecta la grilla ajena por sí mismo, sin depender del aviso del drill.
  ext.calidad = evaluarCalidad(servicio, ext, P);
  assert.equal(ext.calidad.columnas, 'rechazadas');
  assert.equal(ext.calidad.nivel, 'obtenido');
  assert.equal(estadoInforme(ext.calidad, ext.filas), 'con-datos', 'no se informa como dato de Cuenta Corriente');
  const r = conservarIntento({ datosDir, id: servicio.id, cuando: 'c1', clave: claveDe(ext, P), dirIntento, ...P, resultado: ext });
  assert.equal(r.promovido, false);
  assert.deepEqual(leerVigente(datosDir, servicio.id), {}, 'no hay datos vigentes de Cuenta Corriente');
  assert.ok(!fs.existsSync(path.join(datosDir, servicio.id, 'vigente')), 'nada copiado a vigente');
  // La evidencia queda guardada en el intento, para diagnóstico.
  assert.ok(fs.readdirSync(dirIntento).some((f) => f.endsWith('.csv')));
  assert.equal(leerIntentos(datosDir, servicio.id)[0].nivel, 'obtenido');
  // Y la cobertura histórica lo muestra como evidencia, no como cubierto.
  const m = generarMatrizCobertura(datosDir, [{ id: servicio.id, nombre: 'CC' }], { hoy: '2026-10-24' }).objeto.fuentes[0];
  assert.equal(m.acumulado, null);
  assert.match(m.nota, /solo evidencia.*No hay datos utilizables/);
});

// ---------------- cobertura histórica ----------------

test('mesesCompletos y compactarMeses', () => {
  assert.deepEqual(mesesCompletos('2026-01-01', '2026-03-31'), ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(mesesCompletos('2026-01-15', '2026-03-20'), ['2026-02'], 'solo meses enteros');
  assert.deepEqual(mesesCompletos('2024-02-01', '2024-02-29'), ['2024-02']);
  assert.equal(compactarMeses(['2026-03', '2026-01', '2026-02', '2026-05']), '2026-01 a 2026-03, 2026-05');
});

test('matriz de cobertura: aptos, validados, evidencia, faltantes, acumulados y fuentes sin datos', () => {
  const datosDir = tmp();
  const dir = (id) => { fs.mkdirSync(path.join(datosDir, id), { recursive: true }); return path.join(datosDir, id); };
  // Retenciones: julio apto, agosto validado sin total; septiembre leído pero no validado (evidencia).
  fs.writeFileSync(path.join(dir('mis-retenciones'), 'vigente.json'), JSON.stringify({
    '2026-07-01_2026-07-31': { cuando: 'c1', rango: 3, nivel: 'apto', filas: 4, desde: '2026-07-01', hasta: '2026-07-31' },
    '2026-08-01_2026-08-31': { cuando: 'c1', rango: 2, nivel: 'validado', filas: 2, desde: '2026-08-01', hasta: '2026-08-31' },
  }));
  fs.writeFileSync(path.join(dir('mis-retenciones'), 'intentos.jsonl'), JSON.stringify({ cuando: 'c2', clave: '2026-09-01_2026-09-30', filas: 11, rango: 0, nivel: 'obtenido', promovido: false }) + '\n');
  // Mis Facilidades: acumulado validado sin total de paginador.
  fs.writeFileSync(path.join(dir('mis-facilidades'), 'vigente.json'), JSON.stringify({ acumulado: { cuando: 'c2', rango: 2, nivel: 'validado', filas: 14, acumulado: true } }));
  // Mis Comprobantes: manifiesto propio (tramos verificados contra el total de ARCA).
  fs.writeFileSync(path.join(dir('comprobantes-recibidos'), 'manifiesto.json'), JSON.stringify({ 'recibidos:2026-09-01:2026-09-30': { ok: true, fecha: '2026-10-20', filas: 62 } }));
  // ct-pagos: nunca dio datos.
  fs.writeFileSync(path.join(dir('ct-pagos'), 'intentos.jsonl'), JSON.stringify({ cuando: 'c2', estado: 'sin-extraccion', error: 'no se encontró el paso Pagos', promovido: false }) + '\n');

  const fuentes = [{ id: 'mis-retenciones', nombre: 'Ret' }, { id: 'mis-facilidades', nombre: 'MF' }, { id: 'comprobantes-recibidos', nombre: 'Rec' }, { id: 'ct-pagos', nombre: 'Pagos' }];
  const { objeto, texto } = generarMatrizCobertura(datosDir, fuentes, { hoy: '2026-10-24', historicoDesde: '2026-06' });
  const f = Object.fromEntries(objeto.fuentes.map((x) => [x.id, x]));
  assert.equal(f['mis-retenciones'].mesesAptos, '2026-07');
  assert.equal(f['mis-retenciones'].mesesValidados, '2026-07 a 2026-08');
  assert.equal(f['mis-retenciones'].mesesEvidencia, '2026-09');
  assert.equal(f['mis-retenciones'].faltantes, '2026-06, 2026-09', 'la evidencia de septiembre NO tapa el hueco');
  assert.equal(f['mis-facilidades'].tipo, 'acumulado');
  assert.match(f['mis-facilidades'].nota, /sin total de ARCA.*no demuestra el histórico completo/);
  assert.equal(f['comprobantes-recibidos'].mesesAptos, '2026-09');
  assert.equal(f['ct-pagos'].tipo, 'sin-datos');
  assert.match(f['ct-pagos'].nota, /no se encontró el paso Pagos/);
  assert.match(texto, /no verificable por período/);
  assert.match(texto, /\| Pagos \(ct-pagos\) \| sin-datos \|/);
});

test('fuentesDe separa los listados de SIFERE como fuentes propias', () => {
  const ids = fuentesDe(SERVICIOS).map((f) => f.id);
  assert.ok(ids.includes('sifere-consultas-ddjj-mensuales'));
  assert.ok(ids.includes('sifere-consultas-volantes-pago'));
  assert.ok(!ids.includes('sifere-consultas'));
});

test('ejecutarTodo conserva entre corridas y escribe la cobertura histórica', async () => {
  const outDir = tmp(); const datosDir = path.join(outDir, 'datos');
  const servicios = [{ id: 'mis-facilidades', nombre: 'MF', fuente: 15 }];
  const sesion = { cfg: { cuit: '20111111112' } };
  // Corrida buena: validada, sin archivos que verificar (0 filas no; usamos un CSV real de 2 filas).
  const dirI = () => fs.readdirSync(path.join(outDir)).filter((x) => /^\d{4}-/.test(x)).sort().at(-1);
  const buenaRun = async () => {
    const d = path.join(datosDir, 'mis-facilidades', 'intentos', dirI());
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'mf.csv'), csv(['Presentación', 'Número'], [['a', '1'], ['b', '2']]));
    return { estado: 'validado', filas: 2,
      intentos: [{ id: 'mis-facilidades', clave: 'acumulado', dirIntento: d, resultado: { filas: 2, archivos: ['mf.csv'], calidad: { nivel: 'validado' } } }] };
  };
  await ejecutarTodo(sesion, { servicios, outDir, datosDir, runner: buenaRun, periodo: P });
  await new Promise((r) => setTimeout(r, 1100)); // otra corrida = otro timestamp
  const mala = async () => { throw new Error('timeout abriendo pantalla'); };
  const { baseDir, resultados } = await ejecutarTodo(sesion, { servicios, outDir, datosDir, runner: mala, periodo: P });
  assert.equal(resultados[0].estado, 'sin-acceso');
  assert.equal(leerVigente(datosDir, 'mis-facilidades').acumulado.filas, 2, 'el fallo no borra lo conservado');
  assert.equal(leerIntentos(datosDir, 'mis-facilidades').length, 2);
  const hist = fs.readFileSync(path.join(baseDir, 'cobertura-historica.md'), 'utf8');
  assert.match(hist, /MF \(mis-facilidades\) \| acumulado/);
  assert.ok(fs.existsSync(path.join(datosDir, 'cobertura-historica.json')));
});

// ---------------- navegación ----------------

test('enlaceDeConsultaValido: texto exacto, mismo host, sin trámite', () => {
  const base = { texto: 'Pagos', title: 'Permite consultar los comprobantes de pagos', href: 'https://ctacte.cloud.afip.gob.ar/contribuyente/externo?service=partial&sp=SPagos', hostFrame: 'ctacte.cloud.afip.gob.ar' };
  assert.equal(enlaceDeConsultaValido(base, 'Pagos'), true);
  assert.equal(enlaceDeConsultaValido(base, 'pagos '), true, 'sin distinguir mayúsculas ni espacios');
  assert.equal(enlaceDeConsultaValido({ ...base, texto: 'Presentación DJ / Pagos' }, 'Pagos'), false, 'no por subcadena');
  assert.equal(enlaceDeConsultaValido({ ...base, hostFrame: 'otro.afip.gob.ar' }, 'Pagos'), false, 'no salta a otro sistema');
  assert.equal(enlaceDeConsultaValido({ ...base, href: 'javascript:void(0)' }, 'Pagos'), false);
  assert.equal(enlaceDeConsultaValido({ ...base, texto: 'Generar VEP' }, 'Generar VEP'), false, 'trámite vetado');
  assert.equal(enlaceDeConsultaValido({ ...base, title: 'Pagar ahora' }, 'Pagos'), false, 'título de trámite vetado');
});

test('drill: si el ítem visible no aparece, usa el enlace exacto como respaldo y lo informa', async () => {
  let navegado = null; let nivel = 0;
  const frame = {
    url: () => 'https://ctacte.cloud.afip.gob.ar/contribuyente/externo',
    locator: () => { const l = { filter: () => l, count: async () => 0, first: () => null, nth: () => null }; return l; },
    getByText: () => ({ count: async () => 0 }),
    evaluate: async () => [
      { texto: 'Presentación DJ / Pagos', title: '', href: 'https://ctacte.cloud.afip.gob.ar/contribuyente/externo?sp=SPresentacion' },
      { texto: 'Pagos', title: 'Permite consultar los comprobantes de pagos', href: 'https://ctacte.cloud.afip.gob.ar/contribuyente/externo?sp=SPagos' },
    ],
  };
  const pagina = {
    frames: () => [frame], mainFrame: () => frame,
    goto: async (u) => { navegado = u; nivel = 1; },
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
  };
  const relevar = async () => (nivel === 0 ? { frames: [{ tablas: [], inputs: [] }] } : { frames: [{ tablas: [], inputs: [{ id: 'fechaDesde' }] }] });
  const r = await drillHaciaGrilla(pagina, { ruta: [{ texto: 'Pagos', respaldoEnlace: true }], relevar });
  assert.equal(navegado, 'https://ctacte.cloud.afip.gob.ar/contribuyente/externo?sp=SPagos');
  assert.equal(r.lista, true);
  assert.deepEqual(r.recorrido, [{ paso: 'Pagos', via: 'enlace' }]);
});

test('las cuatro consultas de Cuentas Tributarias tienen respaldo por enlace en su hoja', () => {
  for (const id of ['ct-ddjj', 'ct-pagos', 'ct-cuenta-corriente', 'ct-compensaciones']) {
    const s = SERVICIOS.find((x) => x.id === id);
    assert.equal(s.ruta.at(-1).respaldoEnlace, true, id);
    assert.ok(s.rechazarSiColumnas?.length, `${id} rechaza la grilla de la home`);
  }
});

// ---------------- reducciones y sustitución segura ----------------

// Prepara un vigente "acumulado" de `n` filas (vía conservarIntento, como en una corrida real).
function conVigente(datosDir, id, n, cuando = 'c1') {
  const d = path.join(datosDir, id, 'intentos', cuando);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'mf.csv'), csv(['Presentación', 'Número'], Array.from({ length: n }, (_, i) => [`p${i}`, String(i)])));
  const r = conservarIntento({ datosDir, id, cuando, clave: 'acumulado', dirIntento: d, ...P,
    resultado: { filas: n, archivos: ['mf.csv'], calidad: { nivel: 'validado', total: 'no-independiente' } } });
  assert.equal(r.promovido, true);
  return d;
}
const intentoDe = (datosDir, id, cuando, n, calidad) => {
  const d = path.join(datosDir, id, 'intentos', cuando);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'mf.csv'), csv(['Presentación', 'Número'], Array.from({ length: n }, (_, i) => [`q${i}`, String(i)])));
  return { d, resultado: { filas: n, archivos: ['mf.csv'], calidad } };
};
const filasVigente = (datosDir, id) => fs.readFileSync(path.join(datosDir, id, 'vigente', 'acumulado', 'mf.csv'), 'utf8').split('\r\n').filter(Boolean).length - 1;

test('reducción sin confirmar: 14 validados no se reemplazan por 4 validados; el intento queda pendiente de revisión', () => {
  const datosDir = tmp(); const id = 'mis-facilidades';
  conVigente(datosDir, id, 14);
  const { d, resultado } = intentoDe(datosDir, id, 'c2', 4, { nivel: 'validado', total: 'no-independiente' });
  const r = conservarIntento({ datosDir, id, cuando: 'c2', clave: 'acumulado', dirIntento: d, ...P, resultado });
  assert.equal(r.promovido, false);
  assert.match(r.motivo, /trae 4 filas y el vigente 14.*pendiente de revisión/);
  const vig = leerVigente(datosDir, id).acumulado;
  assert.equal(vig.filas, 14);
  assert.equal(vig.cuando, 'c1');
  assert.deepEqual([vig.pendienteRevision.cuando, vig.pendienteRevision.filas], ['c2', 4]);
  assert.equal(filasVigente(datosDir, id), 14, 'los archivos vigentes siguen siendo los 14');
  assert.ok(fs.existsSync(path.join(d, 'mf.csv')), 'el intento nuevo se conserva para revisar');
  // La cobertura histórica lo avisa.
  const m = generarMatrizCobertura(datosDir, [{ id, nombre: 'MF' }], { hoy: '2026-10-24' }).objeto.fuentes[0];
  assert.match(m.nota, /Pendiente de revisión: acumulado: el intento c2 trajo 4 filas y el vigente tiene 14/);
  // Un cero (grilla vacía) tampoco borra 14: no hay total de ARCA que confirme la reducción.
  const cero = conservarIntento({ datosDir, id, cuando: 'c3', clave: 'acumulado', ...P, resultado: { filas: 0, archivos: [], calidad: { nivel: 'apto', total: 'no-informado' } } });
  assert.equal(cero.promovido, false);
  assert.equal(leerVigente(datosDir, id).acumulado.filas, 14);
});

test('reducción confirmada por el total de ARCA: sí reemplaza (el organismo cambió registros) y el anterior queda en respaldo', () => {
  const datosDir = tmp(); const id = 'mis-facilidades';
  conVigente(datosDir, id, 14);
  const { d, resultado } = intentoDe(datosDir, id, 'c2', 4, { nivel: 'apto', total: 'coincide' });
  const r = conservarIntento({ datosDir, id, cuando: 'c2', clave: 'acumulado', dirIntento: d, ...P, resultado });
  assert.equal(r.promovido, true);
  assert.match(r.motivo, /reducción 14 → 4 filas confirmada por el total de ARCA/);
  assert.equal(leerVigente(datosDir, id).acumulado.filas, 4);
  assert.equal(filasVigente(datosDir, id), 4);
  const resp = path.join(datosDir, id, 'respaldos', 'acumulado', 'c1', 'mf.csv');
  assert.equal(fs.readFileSync(resp, 'utf8').split('\r\n').filter(Boolean).length - 1, 14, 'los 14 anteriores quedan en respaldos/');
  // Igual nivel con MÁS o iguales filas reemplaza normalmente.
  const mas = intentoDe(datosDir, id, 'c3', 5, { nivel: 'apto', total: 'coincide' });
  assert.equal(conservarIntento({ datosDir, id, cuando: 'c3', clave: 'acumulado', dirIntento: mas.d, ...P, resultado: mas.resultado }).promovido, true);
});

test('sustitución segura: si la copia falla a mitad, el vigente anterior queda intacto y no queda basura', () => {
  const datosDir = tmp(); const id = 'mis-facilidades';
  conVigente(datosDir, id, 14);
  const { d, resultado } = intentoDe(datosDir, id, 'c2', 20, { nivel: 'validado', total: 'no-independiente' });
  const ops = { copyFileSync: () => { throw new Error('EIO: disco desconectado'); } };
  const r = conservarIntento({ datosDir, id, cuando: 'c2', clave: 'acumulado', dirIntento: d, ...P, resultado, ops });
  assert.equal(r.promovido, false);
  assert.match(r.motivo, /no se pudo preparar la copia nueva \(EIO: disco desconectado\); el vigente anterior queda intacto/);
  assert.equal(leerVigente(datosDir, id).acumulado.filas, 14);
  assert.equal(filasVigente(datosDir, id), 14);
  assert.deepEqual(fs.readdirSync(path.join(datosDir, id, 'vigente')), ['acumulado'], 'sin carpeta temporal colgada');
});

test('sustitución segura: si falla colocar la copia nueva, se restaura el vigente anterior desde el respaldo', () => {
  const datosDir = tmp(); const id = 'mis-facilidades';
  conVigente(datosDir, id, 14);
  const { d, resultado } = intentoDe(datosDir, id, 'c2', 20, { nivel: 'validado', total: 'no-independiente' });
  // El primer rename (vigente -> respaldo) anda; el segundo (temporal -> vigente) falla.
  let n = 0;
  const ops = { renameSync: (a, b) => { if (++n === 2) throw new Error('EPERM: archivo en uso'); fs.renameSync(a, b); } };
  const r = conservarIntento({ datosDir, id, cuando: 'c2', clave: 'acumulado', dirIntento: d, ...P, resultado, ops });
  assert.equal(r.promovido, false);
  assert.match(r.motivo, /EPERM.*se restauró el vigente anterior/);
  assert.equal(filasVigente(datosDir, id), 14);
  assert.equal(leerVigente(datosDir, id).acumulado.cuando, 'c1');
});

test('interrupción a mitad (Windows corta): la corrida siguiente repara antes de seguir', () => {
  const datosDir = tmp(); const id = 'mis-facilidades';
  conVigente(datosDir, id, 14);
  const base = path.join(datosDir, id);
  // Estado tras un corte entre los dos renames: vigente movido a respaldo, copia nueva a medio hacer.
  fs.mkdirSync(path.join(base, 'respaldos', 'acumulado'), { recursive: true });
  fs.renameSync(path.join(base, 'vigente', 'acumulado'), path.join(base, 'respaldos', 'acumulado', 'c1'));
  fs.mkdirSync(path.join(base, 'vigente', '.nuevo-acumulado'), { recursive: true });
  fs.writeFileSync(path.join(base, 'vigente', '.nuevo-acumulado', 'mf.csv'), 'a;b\n1;2\n'); // incompleta
  // La corrida siguiente (con un intento que no se promueve) primero repara.
  conservarIntento({ datosDir, id, cuando: 'c2', clave: 'acumulado', ...P, resultado: { filas: 3, calidad: { nivel: 'obtenido' } } });
  assert.equal(filasVigente(datosDir, id), 14, 'se restauró el vigente desde el respaldo');
  assert.ok(!fs.existsSync(path.join(base, 'vigente', '.nuevo-acumulado')), 'se borró la copia a medio hacer');
  // Y si el corte fue DESPUÉS de colocar la copia pero ANTES de actualizar el manifiesto, la carpeta manda.
  const datos2 = tmp();
  conVigente(datos2, id, 14);
  const b2 = path.join(datos2, id);
  const meta = JSON.parse(fs.readFileSync(path.join(b2, 'vigente', 'acumulado', '_meta.json'), 'utf8'));
  fs.writeFileSync(path.join(b2, 'vigente', 'acumulado', '_meta.json'), JSON.stringify({ ...meta, cuando: 'c9', filas: 14 }));
  conservarIntento({ datosDir: datos2, id, cuando: 'c10', clave: null, resultado: { estado: 'error', filas: 0, error: 'x' } });
  conservarIntento({ datosDir: datos2, id, cuando: 'c11', clave: 'acumulado', ...P, resultado: { filas: 1, calidad: { nivel: 'obtenido' } } });
  assert.equal(leerVigente(datos2, id).acumulado.cuando, 'c9', 'el manifiesto se alineó con la carpeta colocada');
});

test('respaldos: se conservan los últimos MAX_RESPALDOS', () => {
  const datosDir = tmp(); const id = 'mis-facilidades';
  conVigente(datosDir, id, 1, 'c0');
  for (let i = 1; i <= 5; i++) {
    const { d, resultado } = intentoDe(datosDir, id, `c${i}`, 1 + i, { nivel: 'validado', total: 'no-independiente' });
    assert.equal(conservarIntento({ datosDir, id, cuando: `c${i}`, clave: 'acumulado', dirIntento: d, ...P, resultado }).promovido, true);
  }
  assert.deepEqual(fs.readdirSync(path.join(datosDir, id, 'respaldos', 'acumulado')).sort(), ['c2', 'c3', 'c4']);
});
