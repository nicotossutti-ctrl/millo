import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fechaIso, verificarFechas, resumenEstados, evaluarCalidad } from '../src/portal/calidad.js';
import { rangoResultado, debeReemplazar, conservarIntento, leerVigente, leerIntentos, claveDe } from '../src/portal/conservacion.js';
import { mesesCompletos, compactarMeses, generarMatrizCobertura } from '../src/portal/coberturaHistorica.js';
import { enlaceDeConsultaValido, drillHaciaGrilla } from '../src/portal/navegar.js';
import { ejecutarTodo, fuentesDe } from '../src/portal/orquestador.js';
import { completarFiltros } from '../src/portal/extractor.js';
import { SERVICIOS } from '../src/portal/servicios.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arca-cons-'));
const P = { desde: '2026-09-01', hasta: '2026-09-30' };

// ---------------- 2. Validación ----------------

test('fechaIso reconoce los formatos de ARCA y rechaza lo que no es fecha', () => {
  assert.equal(fechaIso('05/09/2026'), '2026-09-05');
  assert.equal(fechaIso('5-9-2026 10:31'), '2026-09-05');
  assert.equal(fechaIso('2026-09-05T00:00'), '2026-09-05');
  assert.equal(fechaIso('09/2026'), null);
  assert.equal(fechaIso(''), null);
});

test('verificarFechas cuenta filas fuera del rango solo con columna de fecha declarada', () => {
  const h = ['Impuesto', 'Fecha Retención', 'Importe'];
  const filas = [['IVA', '02/09/2026', '1'], ['IVA', '30/09/2026', '2'], ['IVA', '01/10/2026', '3'], ['IVA', '', '4']];
  const v = verificarFechas(h, filas, P.desde, P.hasta, 'Fecha');
  assert.equal(v.verificado, true);
  assert.deepEqual([v.enRango, v.fueraDeRango, v.sinFecha], [2, 1, 1]);
  // Sin columna declarada no se adivina cuál fecha corresponde al filtro.
  assert.equal(verificarFechas(h, filas, P.desde, P.hasta, null).verificado, false);
  assert.equal(verificarFechas(h, filas, P.desde, P.hasta, 'Vencimiento').verificado, false);
});

test('resumenEstados cuenta valores de Estado/Resultado (p. ej. VEP generado vs pago acreditado)', () => {
  const r = resumenEstados(['Anticipo', 'Monto Total', 'Estado', 'Resultado'], [['01', '1', 'Generado', ''], ['02', '1', 'Pagado', 'Acreditado'], ['03', '1', 'Pagado', 'Acreditado']]);
  assert.deepEqual(r.Estado, { Generado: 1, Pagado: 2 });
  assert.deepEqual(r.Resultado, { '(vacío)': 1, Acreditado: 2 });
});

test('evaluarCalidad: llegar a una pantalla con filas NO es éxito sin columnas propias', () => {
  const ext = { filas: 5, conFiltroPeriodo: false, finPaginacion: 'sin-siguiente', informados: null };
  const sinCols = evaluarCalidad({}, ext, P);
  assert.equal(sinCols.exito, false);
  assert.equal(sinCols.columnas, 'sin-confirmar');
  const conCols = evaluarCalidad({ columnasEsperadas: ['Impuesto'] }, ext, P);
  assert.equal(conCols.exito, true);
  assert.equal(conCols.periodo, 'acumulado');
  // Grilla de otra pantalla (Vencimientos de la home): rechazada aunque tenga filas.
  assert.equal(evaluarCalidad({ columnasEsperadas: ['Impuesto'] }, ext, { ...P, rechazada: true }).columnas, 'rechazadas');
});

test('evaluarCalidad: tope de paginación, total distinto, rango sin confirmar y fechas fuera invalidan', () => {
  const s = { columnasEsperadas: ['Impuesto'] };
  const base = { filas: 10, finPaginacion: 'sin-siguiente', conFiltroPeriodo: true, rangoOk: true, informados: 10 };
  assert.equal(evaluarCalidad(s, base, P).exito, true);
  assert.equal(evaluarCalidad(s, { ...base, finPaginacion: 'tope', paginas: 100 }, P).paginacion, 'incompleta');
  assert.equal(evaluarCalidad(s, { ...base, finPaginacion: 'tope' }, P).exito, false);
  assert.equal(evaluarCalidad(s, { ...base, informados: 12 }, P).exito, false);
  assert.equal(evaluarCalidad(s, { ...base, rangoOk: null }, P).exito, false);
  const fuera = evaluarCalidad(s, { ...base, fechas: { verificado: true, enRango: 9, fueraDeRango: 1, sinFecha: 0 } }, P);
  assert.equal(fuera.exito, false);
  assert.match(fuera.motivos.join(' '), /fuera del rango/);
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

// ---------------- 3. Conservación ----------------

test('rangoResultado / debeReemplazar: un fallo o parcial nunca reemplaza a uno validado', () => {
  const validado = { estado: 'validado', filas: 83, calidad: { exito: true } };
  const parcial = { estado: 'parcial', filas: 40 };
  const error = { estado: 'error', filas: 0, error: 'sesión expirada' };
  assert.equal(rangoResultado(validado), 3);
  assert.equal(rangoResultado(parcial), 1);
  assert.equal(rangoResultado(error), 0);
  const vig = { rango: 3 };
  assert.equal(debeReemplazar(parcial, vig), false);
  assert.equal(debeReemplazar(error, vig), false);
  assert.equal(debeReemplazar(validado, vig), true, 'otro validado más reciente sí reemplaza');
  assert.equal(debeReemplazar(parcial, null), true, 'sin vigente, algo con filas se conserva');
  assert.equal(debeReemplazar(error, null), false);
  // Validado pero con chequeos de calidad en rojo: no vale como validado.
  assert.equal(rangoResultado({ estado: 'validado', filas: 5, calidad: { exito: false } }), 1);
  assert.equal(claveDe({ conFiltroPeriodo: true }, P), '2026-09-01_2026-09-30');
  assert.equal(claveDe({ conFiltroPeriodo: false }, P), 'acumulado');
});

test('conservarIntento: guarda cada intento aparte y la corrida mala no pisa la buena', () => {
  const datosDir = tmp();
  const id = 'sifere-consultas-ddjj-mensuales';
  // Corrida 1: buena (83 filas, columnas confirmadas).
  const d1 = path.join(datosDir, id, 'intentos', 'c1');
  fs.mkdirSync(d1, { recursive: true });
  fs.writeFileSync(path.join(d1, 'lista.csv'), 'a;b\n1;2\n');
  const r1 = conservarIntento({ datosDir, id, cuando: 'c1', clave: 'acumulado', dirIntento: d1, ...P,
    resultado: { estado: 'extraido', filas: 83, archivos: ['lista.csv'], calidad: { exito: true } } });
  assert.equal(r1.promovido, true);
  assert.ok(fs.existsSync(path.join(datosDir, id, 'vigente', 'acumulado', 'lista.csv')));
  // Corrida 2: parcial con menos filas (sesión que se cortó): NO reemplaza.
  const d2 = path.join(datosDir, id, 'intentos', 'c2');
  fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d2, 'lista.csv'), 'a;b\n');
  const r2 = conservarIntento({ datosDir, id, cuando: 'c2', clave: 'acumulado', dirIntento: d2, ...P,
    resultado: { estado: 'parcial', filas: 3, archivos: ['lista.csv'], error: 'impuesto X: timeout' } });
  assert.equal(r2.promovido, false);
  assert.match(r2.motivo, /se conserva el vigente del c1/);
  assert.equal(leerVigente(datosDir, id).acumulado.filas, 83);
  assert.equal(fs.readFileSync(path.join(datosDir, id, 'vigente', 'acumulado', 'lista.csv'), 'utf8'), 'a;b\n1;2\n');
  // Corrida 3: falla antes de extraer (sin clave): se registra el error, el vigente sigue.
  const r3 = conservarIntento({ datosDir, id, cuando: 'c3', clave: null, resultado: { estado: 'error', filas: 0, error: 'COMARB: sesión expirada' } });
  assert.equal(r3.promovido, false);
  assert.match(r3.motivo, /se conserva lo obtenido el c1/);
  // Los tres intentos quedan trazados, con su error, y cada uno con su intento.json.
  const ints = leerIntentos(datosDir, id);
  assert.deepEqual(ints.map((i) => [i.cuando, i.promovido]), [['c1', true], ['c2', false], ['c3', false]]);
  assert.equal(ints[2].error, 'COMARB: sesión expirada');
  for (const c of ['c1', 'c2', 'c3']) assert.ok(fs.existsSync(path.join(datosDir, id, 'intentos', c, 'intento.json')), c);
});

test('conservarIntento sanea el resumen guardado (CUIT e importes)', () => {
  const datosDir = tmp();
  conservarIntento({ datosDir, id: 'x', cuando: 'c1', clave: null, resultado: { estado: 'error', filas: 0, error: 'CUIT 20353544773 total $ 63.871.446,29' } });
  const txt = fs.readFileSync(path.join(datosDir, 'x', 'intentos', 'c1', 'intento.json'), 'utf8') + fs.readFileSync(path.join(datosDir, 'x', 'intentos.jsonl'), 'utf8');
  assert.doesNotMatch(txt, /20353544773|871\.446/);
});

// ---------------- 4. Cobertura histórica ----------------

test('mesesCompletos y compactarMeses', () => {
  assert.deepEqual(mesesCompletos('2026-01-01', '2026-03-31'), ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(mesesCompletos('2026-01-15', '2026-03-20'), ['2026-02'], 'solo meses enteros');
  assert.deepEqual(mesesCompletos('2024-02-01', '2024-02-29'), ['2024-02']);
  assert.equal(compactarMeses(['2026-03', '2026-01', '2026-02', '2026-05']), '2026-01 a 2026-03, 2026-05');
});

test('matriz de cobertura: meses validados, faltantes, acumulados no verificables y fuentes sin datos', () => {
  const datosDir = tmp();
  const escribirVig = (id, v) => { fs.mkdirSync(path.join(datosDir, id), { recursive: true }); fs.writeFileSync(path.join(datosDir, id, 'vigente.json'), JSON.stringify(v)); };
  // Retenciones: julio validado, septiembre extraído sin verificar.
  escribirVig('mis-retenciones', {
    '2026-07-01_2026-07-31': { cuando: 'c1', rango: 3, estado: 'validado', filas: 4, desde: '2026-07-01', hasta: '2026-07-31' },
    '2026-09-01_2026-09-30': { cuando: 'c2', rango: 2, estado: 'extraido', filas: 11, desde: '2026-09-01', hasta: '2026-09-30' },
  });
  // Mis Facilidades: acumulado que coincide con el total de la pantalla.
  escribirVig('mis-facilidades', { acumulado: { cuando: 'c2', rango: 2, estado: 'extraido', filas: 14, informados: 14, acumulado: true } });
  // Mis Comprobantes: manifiesto propio con tramos validados.
  fs.mkdirSync(path.join(datosDir, 'comprobantes-recibidos'), { recursive: true });
  fs.writeFileSync(path.join(datosDir, 'comprobantes-recibidos', 'manifiesto.json'), JSON.stringify({ 'recibidos:2026-09-01:2026-09-30': { ok: true, fecha: '2026-10-20', filas: 62 } }));
  // ct-pagos: nunca dio datos; último intento con error.
  fs.mkdirSync(path.join(datosDir, 'ct-pagos'), { recursive: true });
  fs.writeFileSync(path.join(datosDir, 'ct-pagos', 'intentos.jsonl'), JSON.stringify({ cuando: 'c2', estado: 'sin-extraccion', error: 'no se encontró el paso Pagos', promovido: false }) + '\n');

  const fuentes = [{ id: 'mis-retenciones', nombre: 'Ret' }, { id: 'mis-facilidades', nombre: 'MF' }, { id: 'comprobantes-recibidos', nombre: 'Rec' }, { id: 'ct-pagos', nombre: 'Pagos' }];
  const { objeto, texto } = generarMatrizCobertura(datosDir, fuentes, { hoy: '2026-10-23', historicoDesde: '2026-06' });
  const f = Object.fromEntries(objeto.fuentes.map((x) => [x.id, x]));
  assert.equal(f['mis-retenciones'].tipo, 'por-periodo');
  assert.equal(f['mis-retenciones'].mesesValidados, '2026-07');
  assert.equal(f['mis-retenciones'].mesesSinVerificar, '2026-09');
  assert.equal(f['mis-retenciones'].faltantes, '2026-06, 2026-08 a 2026-09', 'septiembre extraído sin verificar NO tapa el hueco');
  assert.equal(f['mis-facilidades'].tipo, 'acumulado');
  assert.match(f['mis-facilidades'].nota, /no demuestra el histórico completo/);
  assert.equal(f['comprobantes-recibidos'].mesesValidados, '2026-09');
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
  // Corrida buena: 14 filas con columnas confirmadas.
  const buena = async () => ({ estado: 'descargado', filas: 14,
    intentos: [{ id: 'mis-facilidades', clave: 'acumulado', dirIntento: null, resultado: { estado: 'extraido', filas: 14, calidad: { exito: true }, archivos: [] } }] });
  await ejecutarTodo(sesion, { servicios, outDir, datosDir, runner: buena, periodo: P });
  await new Promise((r) => setTimeout(r, 1100)); // otra corrida = otro timestamp
  // Corrida mala: tira error.
  const mala = async () => { throw new Error('timeout abriendo pantalla'); };
  const { baseDir, resultados } = await ejecutarTodo(sesion, { servicios, outDir, datosDir, runner: mala, periodo: P });
  assert.equal(resultados[0].estado, 'sin-acceso');
  assert.equal(leerVigente(datosDir, 'mis-facilidades').acumulado.filas, 14, 'el fallo no borra lo conservado');
  assert.equal(leerIntentos(datosDir, 'mis-facilidades').length, 2);
  const hist = fs.readFileSync(path.join(baseDir, 'cobertura-historica.md'), 'utf8');
  assert.match(hist, /MF \(mis-facilidades\) \| acumulado/);
  assert.ok(fs.existsSync(path.join(datosDir, 'cobertura-historica.json')));
});

// ---------------- 1. Navegación ----------------

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
    // Ningún control visible (el NavBar dibuja aparte): locator sin coincidencias.
    locator: () => { const l = { filter: () => l, count: async () => 0, first: () => null, nth: () => null }; return l; },
    getByText: () => { const l = { count: async () => 0 }; return l; },
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
