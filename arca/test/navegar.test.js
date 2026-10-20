import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esAvanceLectura, elegirAvances, grillaLista, drillHaciaGrilla } from '../src/portal/navegar.js';

test('esAvanceLectura acepta verbos de lectura y rechaza trámite/navegación-afuera', () => {
  for (const t of ['Consultar', 'Ingresar', 'Ver detalle', 'Continuar', 'Siguiente', 'Buscar', 'Mostrar', 'Listar']) {
    assert.equal(esAvanceLectura(t), true, t);
  }
  // Trámite / pago / emisión: prohibidos.
  for (const t of ['Presentar DDJJ', 'Generar VEP', 'Pagar', 'Confirmar', 'Enviar', 'Anular']) {
    assert.equal(esAvanceLectura(t), false, t);
  }
  // Navegación hacia afuera, o sin verbo de avance.
  for (const t of ['Volver', 'Salir', 'Cerrar sesión', 'Cancelar', 'Inicio', 'Ayuda', '']) {
    assert.equal(esAvanceLectura(t), false, t);
  }
});

test('elegirAvances ordena por prioridad, saltea vistos y descarta prohibidos', () => {
  const rel = { frames: [{
    botones: [
      { tag: 'button', text: 'Presentar', visible: true },      // prohibido
      { tag: 'button', text: 'Buscar', visible: true },           // avance, baja prioridad
      { tag: 'button', text: 'Consultar', id: 'c', visible: true }, // avance, alta prioridad
      { tag: 'button', text: 'Volver', visible: true },           // afuera
    ],
    enlaces: [{ tag: 'a', text: 'Ingresar', visible: true }],
    conRol: [],
  }] };
  const av = elegirAvances(rel, { yaVistas: ['Ingresar'] });
  assert.deepEqual(av.map((x) => x.texto), ['Consultar', 'Buscar']);
  assert.equal(av[0].id, 'c');
});

test('elegirAvances no repite el mismo texto en distintos frames', () => {
  const rel = { frames: [
    { botones: [{ tag: 'button', text: 'Consultar', visible: true }] },
    { botones: [{ tag: 'button', text: 'Consultar', visible: true }] },
  ] };
  assert.equal(elegirAvances(rel).length, 1);
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

test('drillHaciaGrilla se detiene al encontrar la grilla, sin exceder maxNiveles', async () => {
  // Relevar falso: primer nivel es hub (solo botón Consultar), segundo ya trae la grilla.
  let nivel = 0;
  const relevar = async () => (nivel === 0
    ? { frames: [{ botones: [{ tag: 'button', text: 'Consultar', id: 'go', visible: true }], tablas: [], inputs: [] }] }
    : { frames: [{ botones: [], tablas: [{ visible: true, filas: 3, encabezados: ['A'] }], inputs: [] }] });
  const pagina = {
    frames: () => [{ locator: () => ({ count: async () => 1, first: () => ({ isVisible: async () => true, innerText: async () => 'Consultar', click: async () => { nivel = 1; } }) }) }],
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
  };
  const r = await drillHaciaGrilla(pagina, { expected: [], relevar, maxNiveles: 3 });
  assert.equal(r.lista, true);
  assert.equal(r.niveles, 1);
  assert.deepEqual(r.visitados, ['Consultar']);
});

test('drillHaciaGrilla se detiene si no hay por dónde avanzar en lectura', async () => {
  const relevar = async () => ({ frames: [{ botones: [{ tag: 'button', text: 'Presentar', visible: true }], tablas: [], inputs: [] }] });
  const pagina = { frames: () => [], waitForLoadState: async () => {}, waitForTimeout: async () => {} };
  const r = await drillHaciaGrilla(pagina, { expected: [], relevar, maxNiveles: 3 });
  assert.equal(r.lista, false);
  assert.equal(r.niveles, 0);
});
