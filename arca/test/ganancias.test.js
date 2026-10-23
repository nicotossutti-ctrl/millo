import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impuesto, deduccionesPersonales, liquidacionAnual, provisionMensual, escala as escalaDe } from '../src/ganancias.js';

// Valores tomados de la DDJJ F.2711 período 2025 presentada el 10/07/2026.
const DDJJ_2025 = {
  resultadoNeto3ra: 63871446.29,
  dividendos: 21679.73,
  deduccionesPersonales: 20283774.84,
  deduccionesGenerales: 1899716.32,
  gananciaNetaSujeta: 41687955.13,
  impuestoEscala: 9283471.07,
  impuestoDividendos: 1517.58,
  impuestoDeterminado: 9284988.65,
  pagosACuenta: 3571906.78,
  saldo: 5713081.87,
};

test('deducciones personales 2025 = GNI + deducción especial ap. 1, como en la DDJJ', () => {
  assert.equal(deduccionesPersonales(2025, { deduccionEspecial: 'ap1' }), DDJJ_2025.deduccionesPersonales);
});

test('impuesto 2025 sobre la ganancia neta sujeta reproduce la DDJJ al centavo', () => {
  assert.equal(impuesto(2025, DDJJ_2025.gananciaNetaSujeta), DDJJ_2025.impuestoEscala);
});

test('liquidación anual 2025 completa reproduce la DDJJ', () => {
  const liq = liquidacionAnual(2025, {
    resultadoNeto: DDJJ_2025.resultadoNeto3ra,
    deduccionesGenerales: DDJJ_2025.deduccionesGenerales,
    dividendos: DDJJ_2025.dividendos,
    pagosACuenta: DDJJ_2025.pagosACuenta,
  });
  assert.equal(liq.gananciaNetaSujeta, DDJJ_2025.gananciaNetaSujeta);
  assert.equal(liq.impuestoEscala, DDJJ_2025.impuestoEscala);
  assert.equal(liq.impuestoDividendos, DDJJ_2025.impuestoDividendos);
  assert.equal(liq.impuestoDeterminado, DDJJ_2025.impuestoDeterminado);
  assert.equal(liq.saldo, DDJJ_2025.saldo);
  assert.equal(liq.alicuotaMarginal, 0.31);
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
  const meses = Array(12).fill(63871446.29 / 12);
  const prov = provisionMensual(2025, meses, {}, { deduccionesGenerales: DDJJ_2025.deduccionesGenerales });
  const suma = prov.reduce((s, m) => s + m.provisionMes, 0);
  assert.ok(Math.abs(suma - DDJJ_2025.impuestoEscala) < 0.1, `suma ${suma}`);
  assert.equal(prov.at(-1).provisionAcumulada, DDJJ_2025.impuestoEscala);
});
