import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizarServicio, coincideServicio } from '../src/portal/sesion.js';

test('normalizarServicio quita acentos, guiones y colapsa espacios', () => {
  assert.equal(normalizarServicio('Convenio Multilateral – SIFERE WEB -...'), 'convenio multilateral sifere web ...');
  assert.equal(normalizarServicio('Monotributistas y Autónomos'), 'monotributistas y autonomos');
});

test('coincideServicio tolera guión largo y acentos (SIFERE y CCMA de la corrida real)', () => {
  // El tile real usa guión largo "–" y viene truncado.
  assert.equal(coincideServicio('Convenio Multilateral – SIFERE WEB -...', ['SIFERE', 'Convenio Multilateral']), true);
  assert.equal(coincideServicio('Cuenta Corriente de Monotributistas y Autónomos', ['CCMA', 'Cuenta Corriente de Monotributistas']), true);
  assert.equal(coincideServicio('Mis Comprobantes', ['Mis Comprobantes']), true);
});

test('coincideServicio no da falsos positivos', () => {
  assert.equal(coincideServicio('Portal IVA', ['SIFERE']), false);
  assert.equal(coincideServicio('Ventanilla Electrónica', ['CCMA', 'Cuenta Corriente']), false);
  assert.equal(coincideServicio('', ['SIFERE']), false);
});
