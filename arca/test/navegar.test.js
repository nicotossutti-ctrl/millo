import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esPasoSeguro, grillaLista, drillHaciaGrilla } from '../src/portal/navegar.js';

test('esPasoSeguro bloquea controles de trámite/pago y permite navegación de lectura', () => {
  for (const t of ['Presentar DDJJ', 'Generar VEP', 'Pagar', 'Confirmar', 'Anular']) {
    assert.equal(esPasoSeguro(t), false, t);
  }
  for (const t of ['Ingresar al servicio', 'Consultar', 'Ver declaraciones', 'Continuar']) {
    assert.equal(esPasoSeguro(t), true, t);
  }
});

test('grillaLista detecta grilla con datos, grilla esperada y filtros de fecha', () => {
  const conDatos = { frames: [{ tablas: [{ visible: true, filas: 5, encabezados: ['X'] }], inputs: [] }] };
  assert.equal(grillaLista(conDatos).hayGrillaConDatos, true);
  assert.equal(grillaLista(conDatos).lista, true);

  const esperada = { frames: [{ tablas: [{ visible: true, filas: 0, encabezados: ['Impuesto', 'Concepto', 'Periodo'] }], inputs: [] }] };
  const g = grillaLista(esperada, ['impuesto', 'concepto', 'periodo']);
  assert.equal(g.hayGrillaEsperada, true);
  assert.equal(g.hayGrillaConDatos, false);

  const filtros = { frames: [{ tablas: [], inputs: [{ placeholder: 'dd/mm/aaaa' }] }] };
  assert.equal(grillaLista(filtros).hayFiltroFecha, true);

  const nada = { frames: [{ tablas: [], inputs: [{ placeholder: 'texto' }] }] };
  assert.equal(grillaLista(nada).lista, false);
});

test('drillHaciaGrilla NO clickea nada si el servicio no tiene ruta (no adivina por palabras)', async () => {
  // Hub con botones genéricos del portal: sin ruta, el drill no debe tocar nada.
  const relevar = async () => ({ frames: [{ botones: [{ text: 'Envianos tu consulta', visible: true }, { text: 'CONSULTAR', visible: true }], tablas: [], inputs: [] }] });
  let clicks = 0;
  const pagina = { frames: () => { clicks++; return []; }, waitForLoadState: async () => {}, waitForTimeout: async () => {} };
  const r = await drillHaciaGrilla(pagina, { expected: [], ruta: [], relevar });
  assert.equal(r.lista, false);
  assert.equal(r.pasos, 0);
  assert.match(r.motivo, /sin ruta/);
  assert.equal(clicks, 0); // nunca iteró frames para clickear
});

test('drillHaciaGrilla no navega si ya hay grilla/filtros presentes', async () => {
  const relevar = async () => ({ frames: [{ tablas: [{ visible: true, filas: 3, encabezados: ['A'] }], inputs: [] }] });
  const pagina = { frames: () => [], waitForLoadState: async () => {}, waitForTimeout: async () => {} };
  const r = await drillHaciaGrilla(pagina, { expected: [], ruta: [{ texto: 'Ingresar' }], relevar });
  assert.equal(r.lista, true);
  assert.equal(r.pasos, 0);
});

// Locator falso estilo Playwright: soporta .filter() (devuelve sí mismo), .count() y .first().
function locatorFalso({ present, control }) {
  const self = { filter: () => self, count: async () => (present ? 1 : 0), first: () => control };
  return self;
}

test('drillHaciaGrilla sigue la ruta explícita hasta la grilla', async () => {
  // Nivel 0: hub sin grilla. Tras el paso "Ingresar", nivel 1: aparece la grilla.
  let nivel = 0;
  const relevar = async () => (nivel === 0
    ? { frames: [{ tablas: [], inputs: [] }] }
    : { frames: [{ tablas: [{ visible: true, filas: 4, encabezados: ['Periodo', 'Importe'] }], inputs: [] }] });
  const control = { isVisible: async () => true, innerText: async () => 'Ingresar', click: async () => { nivel = 1; } };
  const pagina = {
    frames: () => [{ locator: () => locatorFalso({ present: true, control }) }],
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
  };
  const r = await drillHaciaGrilla(pagina, { expected: ['periodo', 'importe'], ruta: [{ texto: 'Ingresar' }], relevar });
  assert.equal(r.lista, true);
  assert.equal(r.pasos, 1);
});

test('drillHaciaGrilla espera el render tardío de la grilla tras navegar (no da por fallida enseguida)', async () => {
  let llamadas = 0;
  const relevar = async () => {
    llamadas++;
    // 1: hub sin grilla. 2: tras el click, todavía cargando. 3: ya con grilla.
    return llamadas >= 3
      ? { frames: [{ tablas: [{ visible: true, filas: 2, encabezados: ['A'] }], inputs: [] }] }
      : { frames: [{ tablas: [], inputs: [] }] };
  };
  const control = { isVisible: async () => true, innerText: async () => 'Ver', click: async () => {} };
  const pagina = {
    frames: () => [{ locator: () => locatorFalso({ present: true, control }) }],
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
  };
  const r = await drillHaciaGrilla(pagina, { expected: [], ruta: [{ texto: 'Ver' }], relevar });
  assert.equal(r.lista, true);
  assert.equal(r.pasos, 1);
});

test('drillHaciaGrilla informa si un paso de la ruta no se encuentra', async () => {
  const relevar = async () => ({ frames: [{ tablas: [], inputs: [] }] });
  const pagina = { frames: () => [{ locator: () => locatorFalso({ present: false }) }], waitForLoadState: async () => {}, waitForTimeout: async () => {} };
  const r = await drillHaciaGrilla(pagina, { expected: [], ruta: [{ texto: 'No existe' }], relevar });
  assert.equal(r.lista, false);
  assert.match(r.motivo, /no se encontró el paso/);
});
