import { test, before } from 'node:test';
import { execFileSync as run } from 'node:child_process';

let hayOpenssl = true;
try { run('openssl', ['version'], { stdio: 'ignore' }); } catch { hayOpenssl = false; }
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildTra, signTra, loginCms, getTicket } from '../src/wsaa.js';
import { certificadoDePrueba } from './helpers.js';
import { verificarCms } from '../src/cms.js';
import crypto from 'node:crypto';

// Certificado autofirmado descartable, generado en el momento. No es una credencial real.
let cfg;
before(() => {
  // Certificado autofirmado descartable generado con crypto de Node: no requiere openssl.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-wsaa-'));
  const certPath = path.join(dir, 'test.crt');
  const keyPath = path.join(dir, 'test.key');
  const { cert, key } = certificadoDePrueba();
  fs.writeFileSync(certPath, cert);
  fs.writeFileSync(keyPath, key);
  cfg = { env: 'test', cuit: '20111111112', certPath, keyPath, signer: 'node', taDir: path.join(dir, 'ta'), endpoints: { wsaa: 'https://wsaa.test/LoginCms' } };
});

test('el TRA tiene la estructura que exige WSAA, con hora de Buenos Aires', () => {
  const tra = buildTra('wsfe', new Date('2026-10-18T18:00:00Z'));
  assert.match(tra, /<service>wsfe<\/service>/);
  assert.match(tra, /<generationTime>2026-10-18T14:50:00-03:00<\/generationTime>/);
  assert.match(tra, /<expirationTime>2026-10-18T15:10:00-03:00<\/expirationTime>/);
  assert.match(tra, /<uniqueId>\d+<\/uniqueId>/);
});

test('la firma CMS con crypto de Node es verificable por openssl y contiene el TRA', { skip: !hayOpenssl && 'sin openssl en este equipo' }, () => {
  const tra = buildTra('wsfe');
  const b64 = signTra(tra, cfg);
  const der = Buffer.from(b64, 'base64');
  const out = execFileSync('openssl', ['cms', '-verify', '-noverify', '-inform', 'DER'], { input: der });
  assert.equal(out.toString('utf8'), tra);
  // y la firma es válida contra el certificado incluido
  execFileSync('openssl', ['cms', '-verify', '-noverify', '-inform', 'DER', '-certfile', cfg.certPath, '-out', '/dev/null'], { input: der });
});

test('la firma CMS se verifica con crypto de Node, sin openssl', () => {
  const tra = buildTra('wsfe');
  const der = Buffer.from(signTra(tra, cfg), 'base64');
  const v = verificarCms(der);
  assert.equal(v.contenido.toString('utf8'), tra);
  assert.equal(v.digestCoincide, true, 'messageDigest ≠ sha256 del contenido');
  assert.equal(v.firmaValida, true, 'la firma RSA no verifica contra el certificado incluido');
  assert.equal(v.certificado.subject, new crypto.X509Certificate(fs.readFileSync(cfg.certPath)).subject);
});

test('la firma con openssl produce un CMS equivalente', { skip: !hayOpenssl && 'sin openssl en este equipo' }, () => {
  const tra = buildTra('wsfe');
  const b64 = signTra(tra, { ...cfg, signer: 'openssl' });
  const out = execFileSync('openssl', ['cms', '-verify', '-noverify', '-inform', 'DER'], { input: Buffer.from(b64, 'base64') });
  assert.equal(out.toString('utf8'), tra);
});

const respuestaWsaa = (exp) => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><loginCmsResponse><loginCmsReturn>${
  '&lt;loginTicketResponse version="1.0"&gt;&lt;header&gt;&lt;source&gt;CN=wsaahomo&lt;/source&gt;&lt;destination&gt;C=ar&lt;/destination&gt;&lt;uniqueId&gt;1&lt;/uniqueId&gt;&lt;generationTime&gt;2026-10-18T14:50:00-03:00&lt;/generationTime&gt;&lt;expirationTime&gt;' + exp + '&lt;/expirationTime&gt;&lt;/header&gt;&lt;credentials&gt;&lt;token&gt;TOKEN123&lt;/token&gt;&lt;sign&gt;SIGN456&lt;/sign&gt;&lt;/credentials&gt;&lt;/loginTicketResponse&gt;'
}</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`;

test('loginCms manda el CMS en in0 y parsea token y sign', async () => {
  const llamadas = [];
  globalThis.fetch = async (url, init) => { llamadas.push({ url, body: init.body }); return { ok: true, status: 200, text: async () => respuestaWsaa('2099-01-01T00:00:00-03:00') }; };
  const ta = await loginCms(cfg, 'wsfe');
  assert.equal(ta.token, 'TOKEN123');
  assert.equal(ta.sign, 'SIGN456');
  assert.equal(llamadas[0].url, cfg.endpoints.wsaa);
  assert.match(llamadas[0].body, /<wsaa:in0>[A-Za-z0-9+/=]+<\/wsaa:in0>/);
});

test('getTicket cachea el ticket mientras no venza y lo renueva cuando vence', async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; return { ok: true, status: 200, text: async () => respuestaWsaa(n === 1 ? '2000-01-01T00:00:00-03:00' : '2099-01-01T00:00:00-03:00') }; };
  const vencido = await getTicket(cfg, 'wsfe');   // se guarda vencido
  assert.equal(vencido.expirationTime, '2000-01-01T00:00:00-03:00');
  const nuevo = await getTicket(cfg, 'wsfe');     // vencido: pide otro
  assert.equal(nuevo.expirationTime, '2099-01-01T00:00:00-03:00');
  await getTicket(cfg, 'wsfe');                   // vigente: no llama
  assert.equal(n, 2);
  const file = path.join(cfg.taDir, 'test-wsfe.json');
  assert.ok(fs.existsSync(file));
  // En POSIX el ticket se guarda 0600. En Windows chmod no existe: la protección es la ACL
  // de la carpeta del usuario, y el modo reportado es siempre 0666.
  if (process.platform !== 'win32') assert.equal((fs.statSync(file).mode & 0o777), 0o600);
});
