/**
 * Lector mínimo de archivos ZIP con el módulo zlib de Node, sin dependencias.
 * Soporta entradas almacenadas (método 0) y deflate (método 8), que es lo que exporta ARCA.
 * Pensado para ZIP chicos leídos enteros en memoria (una exportación mensual de comprobantes).
 */
import zlib from 'node:zlib';
import fs from 'node:fs';

const EOCD = 0x06054b50; // fin del directorio central
const CEN = 0x02014b50;  // entrada del directorio central
const LOC = 0x04034b50;  // encabezado local

/** Devuelve [{ name, data: Buffer }] con el contenido de cada archivo del ZIP. */
export function leerZip(buf) {
  // Buscamos el End Of Central Directory desde el final (puede haber comentario).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP inválido: no se encontró el directorio central.');
  const nEntradas = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const salida = [];
  for (let i = 0; i < nEntradas; i++) {
    if (buf.readUInt32LE(off) !== CEN) throw new Error('ZIP inválido: entrada de directorio corrupta.');
    const metodo = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localOff) !== LOC) throw new Error(`ZIP inválido: encabezado local de ${name}.`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const comprimido = buf.subarray(dataOff, dataOff + compSize);

    let data;
    if (metodo === 0) data = Buffer.from(comprimido);
    else if (metodo === 8) data = zlib.inflateRawSync(comprimido);
    else throw new Error(`ZIP: método de compresión ${metodo} no soportado en ${name}.`);
    if (!name.endsWith('/')) salida.push({ name, data });
  }
  return salida;
}

export function leerZipDesdeArchivo(file) {
  return leerZip(fs.readFileSync(file));
}
