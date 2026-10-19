import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { leerZip } from '../src/portal/zip.js';

/** Arma un ZIP válido con una entrada (deflate o stored) para las pruebas. */
function armarZip(nombre, contenido, { stored = false } = {}) {
  const name = Buffer.from(nombre);
  const data = Buffer.from(contenido);
  const comp = stored ? data : zlib.deflateRawSync(data);
  const loc = Buffer.alloc(30);
  loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(stored ? 0 : 8, 8);
  loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(data.length, 22);
  loc.writeUInt16LE(name.length, 26);
  const locFull = Buffer.concat([loc, name, comp]);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(stored ? 0 : 8, 10);
  cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(0, 42);
  const cenFull = Buffer.concat([cen, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cenFull.length, 12); eocd.writeUInt32LE(locFull.length, 16);
  return Buffer.concat([locFull, cenFull, eocd]);
}
export { armarZip };

test('leerZip extrae una entrada deflate', () => {
  const r = leerZip(armarZip('datos.csv', 'Fecha;Total\r\n05/09/2026;100,00\r\n'));
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'datos.csv');
  assert.match(r[0].data.toString(), /05\/09\/2026/);
});

test('leerZip extrae una entrada almacenada (sin comprimir)', () => {
  const r = leerZip(armarZip('x.csv', 'hola', { stored: true }));
  assert.equal(r[0].data.toString(), 'hola');
});

test('leerZip rechaza un buffer que no es ZIP', () => {
  assert.throws(() => leerZip(Buffer.from('no soy un zip')), /directorio central/);
});
