/**
 * WSAA: autenticación de web services de ARCA.
 * 1. Armamos un Ticket de Requerimiento de Acceso (TRA) en XML.
 * 2. Lo firmamos en formato CMS/PKCS#7 con nuestro certificado (crypto de Node, sin dependencias).
 * 3. Lo mandamos a loginCms y recibimos token + sign válidos ~12 h.
 * El ticket se cachea en .ta/<env>-<servicio>.json y se reutiliza hasta que vence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { firmarCms } from './cms.js';
import { soapCall, parseXml, escapeXml } from './soap.js';

const TZ = 'America/Argentina/Buenos_Aires';

/** ISO 8601 con offset de Buenos Aires, que es lo que WSAA espera. */
function isoArgentina(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}-03:00`;
}

export function buildTra(service, now = new Date()) {
  const gen = new Date(now.getTime() - 10 * 60 * 1000);
  const exp = new Date(now.getTime() + 10 * 60 * 1000);
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${Math.floor(now.getTime() / 1000)}</uniqueId>
    <generationTime>${isoArgentina(gen)}</generationTime>
    <expirationTime>${isoArgentina(exp)}</expirationTime>
  </header>
  <service>${escapeXml(service)}</service>
</loginTicketRequest>`;
}

function signWithNode(tra, certPem, keyPem) {
  return firmarCms(tra, certPem, keyPem).toString('base64');
}

function signWithOpenssl(tra, certPath, keyPath) {
  const out = execFileSync(
    'openssl',
    ['cms', '-sign', '-binary', '-signer', certPath, '-inkey', keyPath, '-nodetach', '-outform', 'DER'],
    { input: tra },
  );
  return out.toString('base64');
}

export function signTra(tra, cfg) {
  if (cfg.signer === 'openssl') return signWithOpenssl(tra, cfg.certPath, cfg.keyPath);
  return signWithNode(tra, fs.readFileSync(cfg.certPath, 'utf8'), fs.readFileSync(cfg.keyPath, 'utf8'));
}

export async function loginCms(cfg, service) {
  const tra = buildTra(service);
  const cms = signTra(tra, cfg);
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${cms}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

  const body = await soapCall(cfg.endpoints.wsaa, '', envelope);
  const inner = body?.loginCmsResponse?.loginCmsReturn;
  if (!inner) throw new Error(`WSAA: respuesta inesperada ${JSON.stringify(body).slice(0, 300)}`);
  const ta = parseXml(inner)?.loginTicketResponse;
  if (!ta?.credentials?.token) throw new Error(`WSAA: ticket sin credenciales: ${inner.slice(0, 300)}`);
  return {
    service,
    token: ta.credentials.token,
    sign: ta.credentials.sign,
    generationTime: ta.header.generationTime,
    expirationTime: ta.header.expirationTime,
  };
}

/** Devuelve un ticket válido para el servicio, usando el cache si todavía sirve. */
export async function getTicket(cfg, service) {
  const file = path.join(cfg.taDir, `${cfg.env}-${service}.json`);
  if (fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    const margin = 5 * 60 * 1000;
    if (new Date(cached.expirationTime).getTime() - margin > Date.now()) return cached;
  }
  const ta = await loginCms(cfg, service);
  fs.mkdirSync(cfg.taDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ta, null, 2), { mode: 0o600 });
  return ta;
}
