import { certificadoAutofirmado } from './cert-autofirmado.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function cfgDePrueba() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-test-'));
  return { env: 'test', cuit: '20111111112', outDir, endpoints: { wsfe: 'https://wsfe.test/service.asmx', wsaa: 'https://wsaa.test/LoginCms' } };
}

export const ticketFalso = async () => ({ token: 'T', sign: 'S', expirationTime: '2099-01-01T00:00:00-03:00' });

/** Respuesta SOAP de WSFE para un método, con el contenido del Result. */
export function soapWsfe(method, inner) {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method}Response xmlns="http://ar.gov.afip.dif.FEV1/"><${method}Result>${inner}</${method}Result></${method}Response></soap:Body></soap:Envelope>`;
}

export function xmlComprobante(c) {
  const iva = (c.iva ?? []).map((a) => `<AlicIva><Id>${a.id}</Id><BaseImp>${a.baseImp}</BaseImp><Importe>${a.importe}</Importe></AlicIva>`).join('');
  const asoc = (c.cbtesAsoc ?? []).map((a) => `<CbteAsoc><Tipo>${a.tipo}</Tipo><PtoVta>${a.ptoVta}</PtoVta><Nro>${a.nro}</Nro></CbteAsoc>`).join('');
  return `<ResultGet><Concepto>${c.concepto ?? 2}</Concepto><DocTipo>${c.docTipo ?? 80}</DocTipo><DocNro>${c.docNro ?? '30000000007'}</DocNro><CbteDesde>${c.nro}</CbteDesde><CbteHasta>${c.nro}</CbteHasta><CbteFch>${c.fch}</CbteFch><ImpTotal>${c.total}</ImpTotal><ImpTotConc>0</ImpTotConc><ImpNeto>${c.neto ?? c.total}</ImpNeto><ImpOpEx>0</ImpOpEx><ImpTrib>0</ImpTrib><ImpIVA>${c.ivaTotal ?? 0}</ImpIVA><MonId>${c.monId ?? 'PES'}</MonId><MonCotiz>${c.monCotiz ?? 1}</MonCotiz><Resultado>A</Resultado><CodAutorizacion>7${c.nro}</CodAutorizacion><EmisionTipo>CAE</EmisionTipo><FchVto>20260131</FchVto><FchProceso>20260101000000</FchProceso><PtoVta>${c.ptoVta ?? 1}</PtoVta><CbteTipo>${c.tipo ?? 1}</CbteTipo>${iva ? `<Iva>${iva}</Iva>` : ''}${asoc ? `<CbtesAsoc>${asoc}</CbtesAsoc>` : ''}</ResultGet>`;
}

export const xmlError602 = '<Errors><Err><Code>602</Code><Msg>No existen datos en nuestros registros para los parametros ingresados.</Msg></Err></Errors>';

/** fetch falso: recibe el body SOAP, devuelve XML según el método. */
export function fetchFalso(responder) {
  const llamadas = [];
  const fn = async (url, init) => {
    llamadas.push({ url, body: init.body });
    const method = /<ar:(\w+)>/.exec(init.body)?.[1];
    const r = await responder(method, init.body, llamadas.length);
    if (typeof r === 'string') return { ok: true, status: 200, text: async () => r };
    return { ok: r.status < 400, status: r.status, text: async () => r.body ?? '' };
  };
  fn.llamadas = llamadas;
  return fn;
}

/**
 * WSFE simulado en memoria para probar el recorrido: series = { 'pto-tipo': [{nro, fch, total, ...}] }.
 * `fallar` es un set de "pto-tipo-nro" que lanzan error.
 */
export function wsfeSimulado(series, { fallar = new Set(), ptosVenta = null, tiposCbte = null } = {}) {
  const idx = {};
  for (const [k, arr] of Object.entries(series)) idx[k] = new Map(arr.map((c) => [c.nro, c]));
  const consultas = [];
  return {
    consultas,
    async ptosVenta() { return ptosVenta ?? [...new Set(Object.keys(series).map((k) => Number(k.split('-')[0])))].map((nro) => ({ nro, emisionTipo: 'CAE', bloqueado: false, fchBaja: null })); },
    async tiposCbte() { return tiposCbte ?? [...new Set(Object.keys(series).map((k) => Number(k.split('-')[1])))].map((id) => ({ id, desc: `tipo ${id}`, fchDesde: '20100101', fchHasta: null })); },
    async ultimoAutorizado(pto, tipo) { const m = idx[`${pto}-${tipo}`]; return m ? Math.max(0, ...m.keys()) : 0; },
    async consultar(pto, tipo, nro) {
      consultas.push(`${pto}-${tipo}-${nro}`);
      if (fallar.has(`${pto}-${tipo}-${nro}`)) throw new Error('WSFE caído');
      const c = idx[`${pto}-${tipo}`]?.get(nro);
      if (!c) return null;
      return {
        ptoVta: pto, cbteTipo: tipo, cbteDesde: nro, cbteHasta: nro, cbteFch: c.fch, concepto: 2, docTipo: 80, docNro: '30000000007',
        monId: c.monId ?? 'PES', monCotiz: c.monCotiz ?? 1, impNeto: c.neto ?? c.total, impIva: c.ivaTotal ?? 0, impTrib: 0, impOpEx: 0, impTotConc: 0,
        impTotal: c.total, resultado: 'A', codAutorizacion: `7${nro}`, emisionTipo: 'CAE', fchVto: '20260131', fchProceso: '', fchServDesde: '', fchServHasta: '', fchVtoPago: '',
        cbtesAsoc: c.cbtesAsoc ?? [], iva: c.iva ?? [], tributos: [],
      };
    },
  };
}

/**
 * Certificado X.509 autofirmado + clave RSA generados con crypto de Node. Solo para tests:
 * no es una credencial y no sirve para ARCA. Sin openssl.
 */
export function certificadoDePrueba() {
  return certificadoAutofirmado();
}
