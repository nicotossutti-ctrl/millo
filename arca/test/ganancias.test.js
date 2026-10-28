import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impuesto, deduccionesPersonales, liquidacionAnual, provisionMensual, escala as escalaDe } from '../src/ganancias.js';

// Casos INVENTADOS. Los resultados esperados se calcularon a mano con la escala y las deducciones oficiales 2025 de
// params/ganancias.json (tramo de 23.623.669,56 a 35.435.504,34: fijo 4.156.015,94 + 27 % sobre el excedente). La
// comparación con una DJ real es una prueba privada (ganancias-privada.test.js), que no lleva datos al repositorio.

test('deducciones personales 2025 = ganancia no imponible + deducción especial ap. 1 (valores oficiales)', () => {
  assert.equal(deduccionesPersonales(2025, { deduccionEspecial: 'ap1' }), 4507505.52 + 15776269.32);
});

test('impuesto 2025 sobre una ganancia neta sujeta inventada: fijo del tramo + alícuota sobre el excedente', () => {
  // 4.156.015,94 + (30.000.000 − 23.623.669,56) × 0,27 = 5.877.625,16
  assert.equal(impuesto(2025, 30000000), 5877625.16);
});

test('liquidación anual 2025 de un caso inventado, con la misma estructura que el F.2711', () => {
  const liq = liquidacionAnual(2025, { resultadoNeto: 55000000, deduccionesGenerales: 2000000, dividendos: 10000, pagosACuenta: 3000000 });
  assert.equal(liq.gananciaNetaSujeta, 32716225.16); // 55.000.000 − 2.000.000 − 20.283.774,84
  assert.equal(liq.impuestoEscala, 6611005.95); // 4.156.015,94 + 9.092.555,60 × 0,27
  assert.equal(liq.impuestoDividendos, 700); // 7 %
  assert.equal(liq.impuestoDeterminado, 6611705.95);
  assert.equal(liq.saldo, 3611705.95);
  assert.equal(liq.alicuotaMarginal, 0.27);
});

test('bordes de la escala: el fijo de cada tramo coincide con el tope del anterior', () => {
  for (const anio of [2025, 2026]) {
    const { escala } = escalaDe(anio);
    for (let i = 1; i < escala.length; i++) {
      assert.ok(Math.abs(impuesto(anio, escala[i - 1].hasta) - escala[i].fijo) < 0.02, `${anio} tramo ${i}`);
    }
  }
});

test('provisión mensual: la suma de las provisiones iguala el impuesto del año proyectado', () => {
  const prov = provisionMensual(2025, Array(12).fill(4500000), {}, { deduccionesGenerales: 2000000 });
  const suma = prov.reduce((s, m) => s + m.provisionMes, 0);
  // 54.000.000 − 2.000.000 − 20.283.774,84 = 31.716.225,16 → 4.156.015,94 + 8.092.555,60 × 0,27 = 6.341.005,95
  assert.ok(Math.abs(suma - 6341005.95) < 0.1, `suma ${suma}`);
  assert.equal(prov.at(-1).provisionAcumulada, 6341005.95);
});
