import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ejecutarTodo, correrUno, clasificarRelevamiento, generarCobertura } from '../src/portal/orquestador.js';
import { SERVICIOS } from '../src/portal/servicios.js';

function dirTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'arca-orq-')); }
const sesionFalsa = { cfg: { cuit: '20111111112' } };

test('un servicio que falla no detiene a los demas', async () => {
  const outDir = dirTmp();
  const servicios = [
    { id: 'a', nombre: 'A', fuente: 1, confirmado: true },
    { id: 'b-rompe', nombre: 'B', fuente: 2, confirmado: false },
    { id: 'c', nombre: 'C', fuente: 3, confirmado: false },
  ];
  const runner = async (s) => {
    if (s.id === 'b-rompe') throw new Error('timeout abriendo pantalla');
    return { estado: 'relevado', filas: 0 };
  };
  const { resultados, cobertura, baseDir } = await ejecutarTodo(sesionFalsa, { servicios, outDir, runner, periodo: { desde: '2026-09-01', hasta: '2026-09-30' } });
  assert.equal(resultados.length, 3);
  assert.equal(resultados.find((r) => r.id === 'a').estado, 'relevado');
  assert.equal(resultados.find((r) => r.id === 'b-rompe').estado, 'sin-acceso');
  assert.equal(resultados.find((r) => r.id === 'c').estado, 'relevado');
  assert.ok(fs.existsSync(path.join(baseDir, 'cobertura.md')));
  assert.ok(fs.existsSync(path.join(baseDir, 'cobertura.json')));
  assert.ok(fs.existsSync(path.join(outDir, 'ultima.txt')));
  assert.match(cobertura.texto, /1 relevado|2 relevado/);
});

test('orden de servicios: datos fiscales primero, Mis Retenciones al final', () => {
  const ids = SERVICIOS.map((s) => s.id);
  const pos = (id) => ids.indexOf(id);
  // Retenciones (la pantalla más frágil) va última para no bloquear al resto.
  assert.equal(pos('mis-retenciones'), ids.length - 1, 'mis-retenciones debe ser el último');
  // Cuentas Tributarias y DDJJ/Pagos (lo que más necesitamos) corren antes que Retenciones.
  for (const id of ['cuentas-tributarias', 'ct-ddjj', 'ct-pagos', 'ddjj-y-pagos', 'portal-iva']) {
    assert.ok(pos(id) >= 0 && pos(id) < pos('mis-retenciones'), `${id} debe ir antes que mis-retenciones`);
  }
  // Cuentas Tributarias y sus sub-rutas antes que los portales Angular.
  assert.ok(pos('cuentas-tributarias') < pos('portal-iva'), 'cuentas-tributarias antes que portal-iva');
});

test('los informes se escriben DESPUÉS DE CADA servicio (si el último se cuelga, no se pierde lo anterior)', async () => {
  const outDir = dirTmp();
  const servicios = [
    { id: 'a', nombre: 'A', fuente: 1, confirmado: true },
    { id: 'z-ultimo', nombre: 'Z', fuente: 2, confirmado: false },
  ];
  let coberturaAlCorrerZ = null;
  const runner = async (s) => {
    if (s.id === 'z-ultimo') {
      // Cuando corre el último servicio, el informe del primero YA debe estar en disco.
      const ult = fs.readFileSync(path.join(outDir, 'ultima.txt'), 'utf8').trim();
      coberturaAlCorrerZ = fs.readFileSync(path.join(ult, 'cobertura.md'), 'utf8');
    }
    return { estado: 'relevado', filas: 0 };
  };
  await ejecutarTodo(sesionFalsa, { servicios, outDir, runner, periodo: { desde: '2026-09-01', hasta: '2026-09-30' } });
  assert.ok(coberturaAlCorrerZ, 'debía existir cobertura.md mientras corría el último servicio');
  assert.match(coberturaAlCorrerZ, /\| A \|/, 'la cobertura intermedia ya incluye el servicio A');
});

test('correrUno marca desafio de seguridad sin propagar el error', async () => {
  const outDir = dirTmp();
  class DesafioDeSeguridad extends Error { constructor(m) { super(m); this.name = 'DesafioDeSeguridad'; } }
  const r = await correrUno(sesionFalsa, { id: 'x', nombre: 'X', fuente: 9 }, {
    baseDir: outDir,
    runner: async () => { throw new DesafioDeSeguridad('CAPTCHA'); },
  });
  assert.equal(r.estado, 'desafio');
  assert.ok(fs.existsSync(path.join(outDir, 'x', 'error.txt')));
});

test('correrUno sanea el CUIT y datos sensibles en el error antes de guardarlo', async () => {
  const outDir = dirTmp();
  const r = await correrUno(sesionFalsa, { id: 'y', nombre: 'Y', fuente: 7 }, {
    baseDir: outDir,
    runner: async () => { throw new Error('fallo con CUIT 20353544773 y total $ 63.871.446,29'); },
  });
  assert.doesNotMatch(r.error, /20353544773|871\.446/);
  assert.match(r.error, /20-XXXXXXXX-3/);
  const guardado = fs.readFileSync(path.join(outDir, 'y', 'error.txt'), 'utf8');
  assert.doesNotMatch(guardado, /20353544773|871\.446/);
});

test('clasificarRelevamiento detecta datos, exportacion y si esta listo para extractor', () => {
  const rel = { frames: [{ principal: true,
    inputs: [{ tag: 'input', id: 'fechaEmision', visible: true, type: 'text', placeholder: 'dd/mm' }],
    botones: [{ tag: 'button', id: 'buscar', text: 'Buscar', visible: true }],
    enlaces: [{ tag: 'a', text: 'CSV', cls: 'buttons-csv', visible: true }],
    tablas: [{ id: 't', visible: true, filas: 12, encabezados: ['Fecha', 'Importe'] }],
    paginacion: [{ text: '1 a 12 de 12' }], conRol: [] }] };
  const c = clasificarRelevamiento(rel);
  assert.equal(c.estado, 'con-datos');
  assert.equal(c.filas, 12);
  assert.equal(c.listoParaExtractor, true);
  assert.deepEqual(c.exportacion.map((e) => e.texto), ['CSV']);
  assert.equal(c.filtroFecha[0].selector, '#fechaEmision');
});

test('clasificarRelevamiento con pantalla vacia queda en relevado y no listo', () => {
  const c = clasificarRelevamiento({ frames: [{ principal: true, inputs: [], botones: [], enlaces: [], conRol: [] }] });
  assert.equal(c.estado, 'relevado');
  assert.equal(c.listoParaExtractor, false);
});

test('generarCobertura ordena por estado y cuenta', () => {
  const res = [
    { id: 'a', nombre: 'A', fuente: 1, estado: 'error', error: 'x' },
    { id: 'b', nombre: 'B', fuente: 2, estado: 'validado', archivos: ['f.csv'], validaciones: [{ filas: 20 }] },
    { id: 'c', nombre: 'C', fuente: 3, estado: 'relevado', filas: 0, exportacion: [], botonConsulta: [], filtroFecha: [] },
  ];
  const { objeto, texto } = generarCobertura(res, { cuit: '20111111112', cuando: '2026-10-19' });
  // validado primero, error ultimo
  assert.equal(objeto.servicios[0].estado, 'validado');
  assert.equal(objeto.servicios.at(-1).estado, 'error');
  assert.equal(objeto.conteo.validado, 1);
  assert.match(texto, /20 filas/);
  assert.match(texto, /CUIT 20-XXXXXXXX-2/);
  assert.doesNotMatch(texto, /20111111112/);
  // las cuatro secciones de la issue #1
  assert.match(texto, /## Descargado y validado/);
  assert.match(texto, /## Descargado sin validar/);
  assert.match(texto, /## Solo relevado/);
  assert.match(texto, /## Sin acceso o bloqueo/);
  assert.deepEqual(objeto.categorias['Descargado y validado'], ['b']);
});

test('un período con cantidad no verificada queda como descargado sin validar, no validado', () => {
  const res = [{ id: 'rec', nombre: 'Mis Comprobantes', fuente: 2, estado: 'descargado',
    archivos: ['r.csv'], validaciones: [{ filas: 18, duplicados: 0, cantidadVerificada: false }] }];
  const { texto, objeto } = generarCobertura(res, {});
  assert.deepEqual(objeto.categorias['Descargado sin validar'], ['rec']);
  assert.deepEqual(objeto.categorias['Descargado y validado'], []);
  assert.match(texto, /cantidad no verificada/);
});

test('correrUno con extractor tabla está cableado: no es ReferenceError (regresión de correrTabla)', async () => {
  const outDir = dirTmp();
  const sesion = { cfg: { cuit: '20111111112', outDir }, abrirServicio: async () => { throw new Error('boom-abrir'); } };
  const r = await correrUno(sesion, { id: 'mis-retenciones', nombre: 'Mis Retenciones', fuente: 11, extractor: 'tabla' }, {
    baseDir: outDir, periodo: { desde: '2026-09-01', hasta: '2026-09-30' },
  });
  // El error debe venir de abrirServicio (boom-abrir), NO de 'correrTabla is not defined'.
  assert.match(r.error, /boom-abrir/);
  assert.doesNotMatch(r.error, /is not defined|no está definid/i);
});
