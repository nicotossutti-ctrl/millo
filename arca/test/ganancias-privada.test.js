/**
 * Prueba PRIVADA de exactitud: compara el cálculo de Ganancias con la DJ anual REAL del contribuyente, sin llevar sus
 * datos al repositorio. Usa las DJ que se importaron en FiscalOS (su PDF leído, en out/importados/ganancias/, que Git
 * ignora). Sin ninguna DJ importada (otra computadora, GitHub), se saltea: nunca falla por falta de datos.
 * FISCALOS_OUT permite apuntar a otra carpeta out/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listarDdjjGanancias } from '../src/app/ddjjGanancias.js';
import { impuesto, deduccionesPersonales, escala } from '../src/ganancias.js';

const outDir = process.env.FISCALOS_OUT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
const djs = listarDdjjGanancias(outDir).filter((d) => d.estado === 'valida' && d.formulario === '2711');
const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const concepto = (d, re) => d.conceptos.find((c) => re.test(sinAcentos(c.concepto)))?.importe ?? null;

test('DJ real (privada): el cálculo de FiscalOS reproduce cada DJ importada al centavo', { skip: !djs.length && 'sin DJ de Ganancias importada en out/ (prueba privada)' }, () => {
  for (const d of djs) {
    const anio = Number(d.anio);
    try { escala(anio); } catch { continue; } // año sin escala cargada
    const personales = concepto(d, /^deducciones personales computables/);
    const gns = concepto(d, /^ganancia neta sujeta a impuesto excepto/);
    const impEscala = concepto(d, /^impuesto determinado excepto/);
    const impDiv = concepto(d, /^impuesto determinado por dividendos/) ?? 0;
    if (personales != null) assert.ok([deduccionesPersonales(anio, { deduccionEspecial: 'ap1' }), deduccionesPersonales(anio, { deduccionEspecial: 'nuevos' })].includes(personales), `deducciones personales ${anio}`);
    if (gns != null && impEscala != null) assert.equal(impuesto(anio, gns), impEscala, `impuesto de la escala ${anio}`);
    if (impEscala != null) assert.ok(Math.abs(impEscala + impDiv - d.impuestoDeterminado) <= 0.01, `impuesto determinado ${anio}`);
    assert.ok(Math.abs(d.impuestoDeterminado - d.pagosACuenta - ((d.saldoAFavorArca ?? 0) - (d.saldoAFavorContribuyente ?? 0))) <= 0.02, `saldo ${anio}`);
  }
});
