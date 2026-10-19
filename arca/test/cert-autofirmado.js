/** Emisor X.509 mínimo con el codificador DER de src/cms.js. Solo para tests. */
import crypto from 'node:crypto';
import { tlv, oid } from '../src/cms.js';

const SEQ = (...x) => tlv(0x30, ...x);
const SET = (...x) => tlv(0x31, ...x);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const print = (s) => tlv(0x13, Buffer.from(s, 'ascii'));
const utc = (d) => { const p = (n) => String(n).padStart(2, '0'); return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`)); };
const pem = (tipo, der) => `-----BEGIN ${tipo}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${tipo}-----\n`;

export function certificadoAutofirmado() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const nombre = SEQ(SET(SEQ(oid('2.5.4.6'), print('AR'))), SET(SEQ(oid('2.5.4.10'), utf8('test'))), SET(SEQ(oid('2.5.4.3'), utf8('test'))));
  const algFirma = SEQ(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00])); // sha256WithRSAEncryption
  const ahora = new Date();
  const tbs = SEQ(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),                  // version v3
    tlv(0x02, Buffer.from([0x01, 0x23, 0x45])),               // serial
    algFirma,
    nombre,                                                   // issuer
    SEQ(utc(ahora), utc(new Date(ahora.getTime() + 86400000))),
    nombre,                                                   // subject
    spki,
  );
  const firma = crypto.sign('sha256', tbs, { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
  const cert = SEQ(tbs, algFirma, tlv(0x03, Buffer.concat([Buffer.from([0]), firma])));
  return { cert: pem('CERTIFICATE', cert), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
