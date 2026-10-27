/**
 * Clave del rol de solo lectura de PFOS (fiscalos_lectura).
 *  - Se genera con el generador criptográfico de Node (crypto.randomBytes): 32 bytes, 64 caracteres hexadecimales.
 *    Solo usa 0-9 y a-f: no hace falta codificarla para una URL de PostgreSQL ni escaparla en SQL.
 *  - Se guarda SOLO en arca/.env (FISCALOS_PFOS_CLAVE); nunca se muestra en pantalla.
 *  - Para crear el rol se imprime el VERIFICADOR SCRAM-SHA-256 (la clave cifrada, como la guarda PostgreSQL): así la
 *    clave real no aparece en el SQL ni queda en el historial del SQL Editor de Neon.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const generarClave = () => crypto.randomBytes(32).toString('hex');

const hmac = (k, m) => crypto.createHmac('sha256', k).update(m).digest();
const sha256 = (x) => crypto.createHash('sha256').update(x).digest();

/** Claves SCRAM-SHA-256 (RFC 5802 / 7677) de una clave ASCII. */
export function scramClaves(clave, sal, iteraciones = 4096) {
  const salada = crypto.pbkdf2Sync(Buffer.from(clave, 'utf8'), sal, iteraciones, 32, 'sha256');
  const claveCliente = hmac(salada, 'Client Key');
  return { claveCliente, claveGuardada: sha256(claveCliente), claveServidor: hmac(salada, 'Server Key') };
}

/** Verificador en el formato de PostgreSQL: SCRAM-SHA-256$<iteraciones>:<sal>$<StoredKey>:<ServerKey> (base64). */
export function verificadorScram(clave, { sal = crypto.randomBytes(16), iteraciones = 4096 } = {}) {
  if (!/^[\x21-\x7e]+$/.test(clave)) throw new Error('la clave tiene que ser ASCII imprimible');
  const { claveGuardada, claveServidor } = scramClaves(clave, sal, iteraciones);
  return `SCRAM-SHA-256$${iteraciones}:${sal.toString('base64')}$${claveGuardada.toString('base64')}:${claveServidor.toString('base64')}`;
}

/** Escribe (o reemplaza) FISCALOS_PFOS_CLAVE en el .env, con permisos solo para el usuario. Devuelve si ya había una. */
export function guardarClaveEnEnv(archivo, clave) {
  const previo = fs.existsSync(archivo) ? fs.readFileSync(archivo, 'utf8') : '';
  const habia = /^FISCALOS_PFOS_CLAVE=/m.test(previo);
  const linea = `FISCALOS_PFOS_CLAVE=${clave}`;
  const nuevo = habia ? previo.replace(/^FISCALOS_PFOS_CLAVE=.*$/m, linea) : `${previo}${previo && !previo.endsWith('\n') ? '\n' : ''}${linea}\n`;
  fs.writeFileSync(archivo, nuevo, { mode: 0o600 });
  return habia;
}
