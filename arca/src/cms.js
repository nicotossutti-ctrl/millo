/**
 * Firma CMS / PKCS#7 SignedData (RFC 5652) con el módulo crypto de Node, sin dependencias.
 * Es lo que WSAA espera: SignedData con el TRA embebido (no detached), SHA-256 + RSA PKCS#1 v1.5,
 * el certificado incluido y atributos firmados contentType, signingTime y messageDigest.
 *
 * Verificable con: openssl cms -verify -noverify -inform DER -in firma.der
 */
import crypto from 'node:crypto';

// ---------- codificador DER mínimo ----------

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag, ...contenido) {
  const c = Buffer.concat(contenido.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x))));
  return Buffer.concat([Buffer.from([tag]), len(c.length), c]);
}

const SEQ = (...x) => tlv(0x30, ...x);
/** SET OF en DER: elementos ordenados por su codificación. */
const SET = (...x) => tlv(0x31, ...[...x].sort(Buffer.compare));
const OCTETS = (b) => tlv(0x04, b);
const NULO = Buffer.from([0x05, 0x00]);
const EXPLICITO0 = (...x) => tlv(0xa0, ...x);
const IMPLICITO0_SET = (...x) => tlv(0xa0, ...[...x].sort(Buffer.compare)); // [0] IMPLICIT SET OF

function entero(n) {
  let hex = BigInt(n).toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let b = Buffer.from(hex, 'hex');
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

export function oid(s) {
  const p = s.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) {
    const bytes = [n & 0x7f];
    for (let x = n >> 7; x > 0; x >>= 7) bytes.unshift(0x80 | (x & 0x7f));
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, 'ascii'));
}

const OIDS = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
};

// ---------- lector DER mínimo, para sacar issuer y serial del certificado ----------

function leerTlv(buf, off) {
  const tag = buf[off];
  let l = buf[off + 1];
  let p = off + 2;
  if (l & 0x80) {
    const n = l & 0x7f;
    l = 0;
    for (let i = 0; i < n; i++) l = (l << 8) | buf[p + i];
    p += n;
  }
  return { tag, start: off, headerEnd: p, end: p + l, raw: buf.subarray(off, p + l), contenido: buf.subarray(p, p + l) };
}

function hijos(t) {
  const out = [];
  let off = 0;
  while (off < t.contenido.length) {
    const h = leerTlv(t.contenido, off);
    out.push(h);
    off = h.end;
  }
  return out;
}

/** Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { [0] version OPTIONAL, serialNumber, signature, issuer, ... } } */
export function issuerYSerial(certDer) {
  const cert = leerTlv(certDer, 0);
  const tbs = hijos(cert)[0];
  const campos = hijos(tbs);
  let i = 0;
  if (campos[0].tag === 0xa0) i = 1; // version explícita
  const serial = campos[i].raw;
  const issuer = campos[i + 2].raw;
  return { serial, issuer };
}

// ---------- firma ----------

/**
 * @param {string|Buffer} contenido  el TRA en XML
 * @param {string} certPem           certificado X.509 en PEM
 * @param {string} keyPem            clave privada en PEM
 * @returns {Buffer} CMS SignedData en DER
 */
export function firmarCms(contenido, certPem, keyPem, { fecha = new Date() } = {}) {
  const datos = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido, 'utf8');
  const cert = new crypto.X509Certificate(certPem);
  const key = crypto.createPrivateKey(keyPem);
  if (key.asymmetricKeyType !== 'rsa') throw new Error(`La clave es ${key.asymmetricKeyType}; WSAA requiere RSA.`);
  const certDer = cert.raw;
  const { serial, issuer } = issuerYSerial(certDer);

  const algSha256 = SEQ(oid(OIDS.sha256), NULO);
  const algRsa = SEQ(oid(OIDS.rsaEncryption), NULO);
  const digest = crypto.createHash('sha256').update(datos).digest();

  const atributos = [
    SEQ(oid(OIDS.contentType), SET(oid(OIDS.data))),
    SEQ(oid(OIDS.signingTime), SET(utcTime(fecha))),
    SEQ(oid(OIDS.messageDigest), SET(OCTETS(digest))),
  ];
  // Lo que se firma es el SET de atributos (tag 0x31); en el mensaje va como [0] IMPLICIT (0xa0).
  const setAtributos = SET(...atributos);
  const firma = crypto.sign('sha256', setAtributos, { key, padding: crypto.constants.RSA_PKCS1_PADDING });
  const signedAttrs = Buffer.concat([Buffer.from([0xa0]), setAtributos.subarray(1)]);

  const signerInfo = SEQ(
    entero(1),
    SEQ(issuer, serial),
    algSha256,
    signedAttrs,
    algRsa,
    OCTETS(firma),
  );

  const signedData = SEQ(
    entero(1),
    SET(algSha256),
    SEQ(oid(OIDS.data), EXPLICITO0(OCTETS(datos))),
    IMPLICITO0_SET(certDer),
    SET(signerInfo),
  );

  return SEQ(oid(OIDS.signedData), EXPLICITO0(signedData));
}

// ---------- verificación (usada por los tests; no depende de openssl) ----------

/**
 * Lee un SignedData generado por firmarCms y verifica: que el messageDigest firmado sea el
 * SHA-256 del contenido y que la firma RSA valide contra el certificado incluido.
 */
export function verificarCms(der) {
  const contentInfo = hijos(leerTlv(der, 0));
  const signedData = leerTlv(contentInfo[1].contenido, 0);
  const [, , encap, certs, signerInfos] = hijos(signedData);
  const contenido = leerTlv(hijos(encap)[1].contenido, 0).contenido;
  const certDer = hijos(certs)[0].raw;
  const certificado = new crypto.X509Certificate(certDer);
  const si = hijos(hijos(signerInfos)[0]);
  const signedAttrs = si[3];
  const firma = si[5].contenido;
  const setAtributos = Buffer.concat([Buffer.from([0x31]), signedAttrs.raw.subarray(1)]);
  const firmaValida = crypto.verify('sha256', setAtributos, { key: certificado.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, firma);
  const attrs = hijos(signedAttrs).map((a) => hijos(a));
  const md = attrs.find((a) => a[0].raw.equals(oid(OIDS.messageDigest)));
  const digestFirmado = leerTlv(md[1].contenido, 0).contenido;
  const digestCoincide = digestFirmado.equals(crypto.createHash('sha256').update(contenido).digest());
  return { contenido, certificado, firmaValida, digestCoincide };
}
