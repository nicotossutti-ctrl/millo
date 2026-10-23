import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soapCall, SoapError, parseXml, asArray } from '../src/soap.js';

const envelope = (inner) => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
const resp = (status, body) => ({ ok: status < 400, status, text: async () => body });

test('reintenta un 503 y devuelve la respuesta buena', async () => {
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? resp(503, 'Service Unavailable') : resp(200, envelope('<X><ok>1</ok></X>')));
  const reintentos = [];
  const body = await soapCall('https://x', '', '<e/>', { fetchImpl, backoffMs: 1, onRetry: (i, e) => reintentos.push(e.status) });
  assert.equal(body.X.ok, '1');
  assert.deepEqual(reintentos, [503]);
});

test('no reintenta un Fault de negocio (certificado no confiable)', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return resp(500, envelope('<soapenv:Fault><faultcode>ns1:cms.cert.untrusted</faultcode><faultstring>Certificado no emitido por AC de confianza</faultstring></soapenv:Fault>')); };
  await assert.rejects(() => soapCall('https://x', '', '<e/>', { fetchImpl, backoffMs: 1 }), (e) => e instanceof SoapError && !e.retryable && /untrusted/.test(e.message));
  assert.equal(n, 1);
});

test('agota los reintentos ante errores de red y falla', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; throw new Error('ECONNRESET'); };
  await assert.rejects(() => soapCall('https://x', '', '<e/>', { fetchImpl, retries: 2, backoffMs: 1 }), /ECONNRESET/);
  assert.equal(n, 3);
});

test('parseXml quita prefijos de namespace y asArray normaliza', () => {
  const doc = parseXml('<a:root xmlns:a="urn:x"><a:item>1</a:item></a:root>');
  assert.equal(doc.root.item, '1');
  assert.deepEqual(asArray(doc.root.item), ['1']);
  assert.deepEqual(asArray(undefined), []);
});
