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

export class SoapError extends Error {
  constructor(message, { retryable = false, status = null, fault = null } = {}) {
    super(message);
    this.name = 'SoapError';
    this.retryable = retryable;
    this.status = status;
    this.fault = fault;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST SOAP 1.1 con reintentos controlados. Reintenta solo errores de red, HTTP 5xx/429
 * y respuestas no parseables; nunca un Fault de negocio. Devuelve el Body parseado.
 */
export async function soapCall(url, soapAction, envelope, { retries = 3, backoffMs = 1000, fetchImpl = globalThis.fetch, onRetry = () => {} } = {}) {
  let lastErr;
  for (let intento = 0; intento <= retries; intento++) {
    try {
      return await unaLlamada(url, soapAction, envelope, fetchImpl);
    } catch (e) {
      lastErr = e;
      if (!(e instanceof SoapError) || !e.retryable || intento === retries) throw e;
      onRetry(intento + 1, e);
      await sleep(backoffMs * 2 ** intento);
    }
  }
  throw lastErr;
}

async function unaLlamada(url, soapAction, envelope, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${soapAction}"` },
      body: envelope,
    });
  } catch (e) {
    throw new SoapError(`Error de red contra ${url}: ${e.message}`, { retryable: true });
  }
  const text = await res.text();
  let doc;
  try {
    doc = parseXml(text);
  } catch {
    throw new SoapError(`Respuesta no XML de ${url} (HTTP ${res.status}): ${text.slice(0, 300)}`, { retryable: res.status >= 500, status: res.status });
  }
  const body = doc?.Envelope?.Body;
  if (body?.Fault) {
    const f = body.Fault;
    const msg = `SOAP Fault: ${f.faultcode ?? ''} ${f.faultstring ?? JSON.stringify(f)}`;
    // Faults de infraestructura (servidor caído) se reintentan; los de negocio no.
    const retryable = /Server|Internal|timeout|unavailable/i.test(String(f.faultcode) + String(f.faultstring)) && !/cms\.|coe\.|wsn\./.test(String(f.faultcode));
    throw new SoapError(msg, { retryable, status: res.status, fault: f });
  }
  if (!res.ok) throw new SoapError(`HTTP ${res.status} de ${url}: ${text.slice(0, 300)}`, { retryable: res.status >= 500 || res.status === 429, status: res.status });
  if (!body) throw new SoapError(`SOAP sin Body (HTTP ${res.status}): ${text.slice(0, 300)}`, { retryable: false, status: res.status });
  return body;
}

/** fast-xml-parser devuelve objeto para 1 elemento y array para varios; normalizamos. */
export function asArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}
