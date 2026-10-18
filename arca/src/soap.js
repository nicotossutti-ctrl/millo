import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false, // todo como string; convertimos nosotros donde haga falta
  trimValues: true,
});

export function parseXml(xml) {
  return parser.parse(xml);
}

export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Hace un POST SOAP 1.1 y devuelve el Body parseado. */
export async function soapCall(url, soapAction, envelope) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `"${soapAction}"`,
    },
    body: envelope,
  });
  const text = await res.text();
  let doc;
  try {
    doc = parseXml(text);
  } catch {
    throw new Error(`Respuesta no XML de ${url} (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const body = doc?.Envelope?.Body;
  if (!body) throw new Error(`SOAP sin Body (HTTP ${res.status}): ${text.slice(0, 300)}`);
  if (body.Fault) {
    const f = body.Fault;
    throw new Error(`SOAP Fault: ${f.faultcode ?? ''} ${f.faultstring ?? JSON.stringify(f)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} de ${url}: ${text.slice(0, 300)}`);
  return body;
}

/** fast-xml-parser devuelve objeto para 1 elemento y array para varios; normalizamos. */
export function asArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}
