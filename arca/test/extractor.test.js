import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNAS_LIBRES, esProhibido, elegirTabla, recolectarTablas, decidirEstado, completarFiltros, elegirOpcionImpuesto, impuestosDeItems, seleccionarEstablecimiento } from '../src/portal/extractor.js';
import { toCsv } from '../src/csv.js';

test('impuestosDeItems: solo impuestos reales, sin grupos, sin duplicados, filtrados por relevantes', () => {
  // El combo EJ2 repite ítems y mezcla encabezados de grupo con impuestos reales.
  const items = [
    { i: 0, t: 'Impositivas' },                 // encabezado de grupo -> fuera
    { i: 1, t: '216 - SIRE - IVA' },
    { i: 2, t: '216 - SIRE - IVA' },            // duplicado -> una sola vez
    { i: 3, t: '217 - SICORE-GANANCIAS' },
    { i: 4, t: '767 - Percepción Something' },
    { i: 5, t: '767 - Percepción Something' },  // duplicado
    { i: 6, t: 'Recursos de la Seguridad Social' }, // grupo -> fuera
    { i: 7, t: 'Elegí un impuesto' },           // placeholder sin código -> fuera
  ];
  // Sin filtro: impuestos reales únicos, en orden, sin grupos ni placeholders.
  assert.deepEqual(impuestosDeItems(items), ['216 - SIRE - IVA', '217 - SICORE-GANANCIAS', '767 - Percepción Something']);
  // Con regex de relevantes (IVA/Ganancias): deja solo esos, aún sin duplicar.
  assert.deepEqual(impuestosDeItems(items, /\biva\b|ganancia/i), ['216 - SIRE - IVA', '217 - SICORE-GANANCIAS']);
  // Acepta también strings sueltos (no solo {t}).
  assert.deepEqual(impuestosDeItems(['300 - IVA', '300 - IVA']), ['300 - IVA']);
});

test('recolectarTablas une varias tablas con los mismos encabezados (caso Portal IVA: 1 fila por tabla)', () => {
  // Portal IVA pinta cada DDJJ presentada en su propia <table> de 1 fila, con el mismo encabezado.
  const enc = ['Período Fiscal', 'Formulario', 'Secuencia', 'Presentación'];
  const tablas = [
    { headers: enc, rows: [['09/2026', '2051', 'DJ Original', '16/10/2026']] },
    { headers: enc, rows: [['08/2026', '2051', 'DJ Original', '16/09/2026']] },
    { headers: enc, rows: [['07/2026', '2051', 'DJ Original', '19/08/2026']] },
    { headers: ['Otra', 'Cosa'], rows: [['x', 'y']] }, // tabla de navegación: no coincide, se descarta
  ];
  const r = recolectarTablas(tablas, ['Periodo', 'Formulario', 'Secuencia', 'Presentacion']);
  assert.equal(r.rows.length, 3, 'une las 3 tablas que coinciden');
  assert.deepEqual(r.headers, enc);
  assert.deepEqual(r.rows[2], ['07/2026', '2051', 'DJ Original', '19/08/2026']);
  // Sin encabezados esperados: se comporta como elegirTabla (la mejor única).
  const unica = recolectarTablas(tablas);
  assert.ok(unica && unica.rows.length >= 1);
  // Si ninguna coincide con lo esperado, devuelve null (era navegación/título).
  assert.equal(recolectarTablas(tablas, ['Impuesto', 'Vencimiento']), null);
});

test('seleccionarEstablecimiento elige el valor 0 (DJ de Cuentas Tributarias lo exige)', async () => {
  let elegido = null;
  const optionLoc = { allTextContents: async () => ['Nada seleccionado', '0'] };
  const selectLoc = {
    isVisible: async () => true,
    getAttribute: async (a) => (a === 'name' ? 'idEstablecimiento' : null),
    locator: () => optionLoc,
    selectOption: async (v) => { elegido = v; },
  };
  const frame = {
    getByLabel: () => ({ count: async () => 0, first: () => null }),
    locator: (sel) => (sel === 'select' ? { count: async () => 1, nth: () => selectLoc } : optionLoc),
  };
  assert.equal(await seleccionarEstablecimiento(frame), true);
  assert.equal(elegido, '0', 'se elige exactamente el Establecimiento 0');
});

test('seleccionarEstablecimiento devuelve false si no hay control de Establecimiento', async () => {
  const frame = {
    getByLabel: () => ({ count: async () => 0, first: () => null }),
    locator: () => ({ count: async () => 0, nth: () => null }),
  };
  assert.equal(await seleccionarEstablecimiento(frame), false);
});

test('COLUMNAS_LIBRES arma el CSV a partir de headers y filas de la tabla scrapeada', () => {
  const headers = ['Impuesto', 'Período', 'Fecha Vencimiento'];
  const filas = [['IVA', '2026-09', '21/10/2026'], ['Ganancias', '2026', '12/08/2026']];
  const csv = toCsv(filas, COLUMNAS_LIBRES(headers));
  assert.match(csv, /Impuesto;Período;Fecha Vencimiento/);
  assert.match(csv, /IVA;2026-09;21\/10\/2026/);
  // columna sin nombre toma col<n>
  const csv2 = toCsv([['a', 'b']], COLUMNAS_LIBRES(['', 'X']));
  assert.match(csv2, /col1;X/);
});

test('esProhibido bloquea trámites, pagos, emisión y modificación', () => {
  for (const t of ['Presentar', 'Pagar', 'Generar VEP', 'Confirmar', 'Eliminar', 'Anular', 'Adherir', 'Solicitar plan']) {
    assert.equal(esProhibido(t), true, t);
  }
  for (const t of ['Consultar', 'Buscar', 'Siguiente', 'EXPORTAR', 'CSV', 'Vencimientos', '']) {
    assert.equal(esProhibido(t), false, t);
  }
});

test('elegirTabla prefiere la grilla fiscal por encabezados esperados, no por tamaño', () => {
  const navegacion = { headers: ['Inicio'], rows: Array.from({ length: 30 }, () => ['x']) }; // grande pero no es la grilla
  const grilla = { headers: ['Impuesto', 'Concepto', 'Periodo', 'Vencimiento'], rows: [['IVA', 'Saldo', '2026-09', '21/10/2026']] };
  const esperados = ['impuesto', 'concepto', 'periodo', 'vencimiento'];
  const elegida = elegirTabla([navegacion, grilla], esperados);
  assert.deepEqual(elegida.headers, grilla.headers);
});

test('elegirTabla descarta todo si se esperan encabezados y ninguna tabla coincide', () => {
  const soloNavegacion = [{ headers: ['Inicio', 'Ayuda'], rows: [['a', 'b']] }];
  assert.equal(elegirTabla(soloNavegacion, ['impuesto', 'concepto']), null);
});

test('elegirTabla sin encabezados esperados cae al puntaje por tamaño', () => {
  const chica = { headers: ['A', 'B'], rows: [['1', '2']] };
  const grande = { headers: ['A', 'B', 'C'], rows: [['1', '2', '3'], ['4', '5', '6']] };
  assert.deepEqual(elegirTabla([chica, grande], []).headers, grande.headers);
});

test('decidirEstado diferencia validado / extraido / parcial / sin-datos', () => {
  // 0 filas con grilla confirmada y rango OK -> cero CONFIRMADO (sin-datos real).
  assert.deepEqual(decidirEstado({ filas: 0, informados: null, conFiltroPeriodo: true, rangoOk: true, gridPresente: true }), { estado: 'sin-datos', verificado: false, ceroConfirmado: true });
  assert.deepEqual(decidirEstado({ filas: 20, informados: 20, conFiltroPeriodo: true, rangoOk: true }), { estado: 'validado', verificado: true });
  assert.deepEqual(decidirEstado({ filas: 18, informados: 20, conFiltroPeriodo: true, rangoOk: true }), { estado: 'parcial', verificado: false });
  assert.deepEqual(decidirEstado({ filas: 7, informados: null, conFiltroPeriodo: false, rangoOk: null }), { estado: 'extraido', verificado: false });
  assert.deepEqual(decidirEstado({ filas: 5, informados: null, conFiltroPeriodo: true, rangoOk: false }), { estado: 'parcial', verificado: false });
  // Conteo coincide con el informado PERO el rango no fue confirmado -> no es validado.
  assert.deepEqual(decidirEstado({ filas: 20, informados: 20, conFiltroPeriodo: true, rangoOk: null }), { estado: 'parcial', verificado: false });
  // Error de interacción -> parcial, aunque el conteo coincida.
  assert.deepEqual(decidirEstado({ error: 'fill falló', filas: 20, informados: 20, conFiltroPeriodo: true, rangoOk: true }), { estado: 'parcial', verificado: false });
  // Datos acumulados (sin filtro de período) -> nunca validado por período.
  assert.deepEqual(decidirEstado({ filas: 14, informados: null, conFiltroPeriodo: false, rangoOk: null }), { estado: 'extraido', verificado: false });
});

test('decidirEstado distingue 0 filas CONFIRMADO (grilla vacía) de ausencia INCIERTA (sin grilla)', () => {
  // Retenciones: consulta con selectores OK, grilla presente y vacía -> cero real, no error.
  assert.deepEqual(decidirEstado({ filas: 0, conFiltroPeriodo: true, rangoOk: true, gridPresente: true }), { estado: 'sin-datos', verificado: false, ceroConfirmado: true });
  // No se encontró la grilla (pestaña/consulta sin verificar): NO es un cero, es incierto -> parcial.
  assert.deepEqual(decidirEstado({ filas: 0, conFiltroPeriodo: true, rangoOk: true, gridPresente: false }), { estado: 'parcial', verificado: false, ceroConfirmado: false });
  // Grilla confirmada pero el rango aplicado no se confirmó: tampoco se afirma el cero -> parcial.
  assert.deepEqual(decidirEstado({ filas: 0, conFiltroPeriodo: true, rangoOk: null, gridPresente: true }), { estado: 'parcial', verificado: false, ceroConfirmado: false });
  // Servicio acumulado sin filtro: grilla vacía confirmada basta para el cero real.
  assert.deepEqual(decidirEstado({ filas: 0, conFiltroPeriodo: false, rangoOk: null, gridPresente: true }), { estado: 'sin-datos', verificado: false, ceroConfirmado: true });
});

test('elegirOpcionImpuesto saltea placeholders y toma el primer impuesto real', () => {
  assert.deepEqual(elegirOpcionImpuesto(['Seleccioná un impuesto', 'IVA', 'Ganancias']), { index: 1, texto: 'IVA' });
  assert.deepEqual(elegirOpcionImpuesto(['Todos', '----', 'Ganancias']), { index: 2, texto: 'Ganancias' });
  assert.equal(elegirOpcionImpuesto(['Seleccioná', '']), null);
  assert.equal(elegirOpcionImpuesto([]), null);
});

test('elegirTabla reconoce una grilla esperada vacía (encabezados, 0 filas) para confirmar el cero', () => {
  const vacia = { headers: ['Impuesto', 'Fecha', 'Importe'], rows: [] };
  const navegacion = { headers: ['Inicio', 'Ayuda'], rows: [['x', 'y']] };
  const elegida = elegirTabla([navegacion, vacia], ['impuesto', 'fecha', 'importe']);
  assert.deepEqual(elegida.headers, vacia.headers);
  assert.equal(elegida.rows.length, 0);
  assert.ok(elegida.coincideCols >= 3);
});

// Locator falso con estado por instancia, para probar completarFiltros sin navegador.
function locFalso(opts = {}) {
  let val = '';
  return {
    count: async () => (opts.ausente ? 0 : 1),
    waitFor: async () => {},
    fill: async (v) => { if (opts.fillThrow) throw new Error('fill intercepted'); val = v; },
    inputValue: async () => (opts.inputValue !== undefined ? opts.inputValue : val),
    click: opts.click ?? (async () => {}),
  };
}
const paginaFalsa = (porSelector) => ({
  frames: () => [{ locator: (sel) => ({ first: () => porSelector(sel) }) }],
  waitForLoadState: async () => {}, waitForTimeout: async () => {},
});
const servFiltros = { selectores: { fechaDesde: '#d', fechaHasta: '#h', consultar: '#b' } };

test('completarFiltros reporta error si el campo de fecha no toma el valor (fallo de fill)', async () => {
  const pagina = paginaFalsa((sel) => (sel === '#d' ? locFalso({ inputValue: '' }) : locFalso()));
  const r = await completarFiltros(pagina, '2026-09-01', '2026-09-30', servFiltros, () => {});
  assert.match(r.error, /fecha desde/);
  assert.equal(r.rangoOk, undefined);
});

test('completarFiltros reporta error si Consultar falla (fallo de click), sin seguir', async () => {
  const pagina = paginaFalsa((sel) => (sel === '#b' ? locFalso({ click: async () => { throw new Error('click intercepted'); } }) : locFalso()));
  const r = await completarFiltros(pagina, '2026-09-01', '2026-09-30', servFiltros, () => {});
  assert.match(r.error, /filtro\/consulta: click intercepted/);
});

test('completarFiltros marca rangoOk true cuando los campos tomaron las fechas y Consultar anduvo', async () => {
  // Estado por selector: lo que se llena en #d/#h debe persistir para la relectura post-Consultar.
  const vals = {};
  const fake = (sel) => ({
    count: async () => 1,
    waitFor: async () => {},
    fill: async (v) => { vals[sel] = v; },
    inputValue: async () => vals[sel] ?? '',
    click: async () => {},
  });
  const pagina = {
    frames: () => [{ locator: (sel) => ({ first: () => fake(sel) }) }],
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
  };
  const r = await completarFiltros(pagina, '2026-09-01', '2026-09-30', servFiltros, () => {});
  assert.equal(r.error, undefined);
  assert.equal(r.conFiltroPeriodo, true);
  assert.equal(r.rangoOk, true);
});
