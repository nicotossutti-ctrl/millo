/**
 * WSFEv1: Factura Electrónica. Solo usamos los métodos de consulta.
 * Manual oficial: https://www.afip.gob.ar/ws/documentacion/manuales/manual-desarrollador-ARCA-COMPG-v4-0.pdf
 */
import { soapCall, asArray } from './soap.js';
import { getTicket } from './wsaa.js';

const NS = 'http://ar.gov.afip.dif.FEV1/';

function envelope(method, innerXml) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}">
  <soap:Body>
    <ar:${method}>${innerXml}</ar:${method}>
  </soap:Body>
</soap:Envelope>`;
}

function authXml(cfg, ta) {
  return `<ar:Auth><ar:Token>${ta.token}</ar:Token><ar:Sign>${ta.sign}</ar:Sign><ar:Cuit>${cfg.cuit}</ar:Cuit></ar:Auth>`;
}

/** Los métodos de WSFE devuelven Errors/Err[] en vez de SOAP Faults. */
function throwIfErrors(result, method) {
  const errs = asArray(result?.Errors?.Err);
  if (errs.length) {
    const e = new Error(`${method}: ${errs.map((x) => `[${x.Code}] ${x.Msg}`).join('; ')}`);
    e.codes = errs.map((x) => Number(x.Code));
    throw e;
  }
}

export class Wsfe {
  constructor(cfg) {
    this.cfg = cfg;
  }

  async call(method, innerXml, { auth = true } = {}) {
    const ta = auth ? await getTicket(this.cfg, 'wsfe') : null;
    const xml = envelope(method, (auth ? authXml(this.cfg, ta) : '') + innerXml);
    const body = await soapCall(this.cfg.endpoints.wsfe, NS + method, xml);
    const result = body?.[`${method}Response`]?.[`${method}Result`];
    if (result === undefined) throw new Error(`${method}: respuesta inesperada ${JSON.stringify(body).slice(0, 300)}`);
    throwIfErrors(result, method);
    return result;
  }

  /** Estado de los servidores. No requiere autenticación. */
  dummy() {
    return this.call('FEDummy', '', { auth: false });
  }

  async ptosVenta() {
    const r = await this.call('FEParamGetPtosVenta', '');
    return asArray(r.ResultGet?.PtoVenta).map((p) => ({
      nro: Number(p.Nro),
      emisionTipo: p.EmisionTipo,
      bloqueado: p.Bloqueado === 'S',
      fchBaja: p.FchBaja === 'NULL' ? null : p.FchBaja,
    }));
  }

  async tiposCbte() {
    const r = await this.call('FEParamGetTiposCbte', '');
    return asArray(r.ResultGet?.CbteTipo).map((t) => ({
      id: Number(t.Id),
      desc: t.Desc,
      fchDesde: t.FchDesde,
      fchHasta: t.FchHasta === 'NULL' ? null : t.FchHasta,
    }));
  }

  async ultimoAutorizado(ptoVta, cbteTipo) {
    const r = await this.call(
      'FECompUltimoAutorizado',
      `<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`,
    );
    return Number(r.CbteNro);
  }

  /** Devuelve el comprobante o null si no existe (error 602). */
  async consultar(ptoVta, cbteTipo, cbteNro) {
    let r;
    try {
      r = await this.call(
        'FECompConsultar',
        `<ar:FeCompConsReq><ar:CbteTipo>${cbteTipo}</ar:CbteTipo><ar:CbteNro>${cbteNro}</ar:CbteNro><ar:PtoVta>${ptoVta}</ar:PtoVta></ar:FeCompConsReq>`,
      );
    } catch (e) {
      if (e.codes?.includes(602)) return null;
      throw e;
    }
    const c = r.ResultGet;
    if (!c) return null;
    return normalizeComprobante(c);
  }
}

const num = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));

export function normalizeComprobante(c) {
  return {
    ptoVta: Number(c.PtoVta),
    cbteTipo: Number(c.CbteTipo),
    cbteDesde: Number(c.CbteDesde),
    cbteHasta: Number(c.CbteHasta),
    cbteFch: c.CbteFch, // yyyymmdd
    concepto: Number(c.Concepto),
    docTipo: Number(c.DocTipo),
    docNro: String(c.DocNro ?? ''),
    monId: c.MonId,
    monCotiz: num(c.MonCotiz),
    impNeto: num(c.ImpNeto),
    impIva: num(c.ImpIVA),
    impTrib: num(c.ImpTrib),
    impOpEx: num(c.ImpOpEx),
    impTotConc: num(c.ImpTotConc),
    impTotal: num(c.ImpTotal),
    resultado: c.Resultado,
    codAutorizacion: String(c.CodAutorizacion ?? ''),
    emisionTipo: c.EmisionTipo,
    fchVto: c.FchVto,
    fchProceso: c.FchProceso,
    fchServDesde: c.FchServDesde ?? '',
    fchServHasta: c.FchServHasta ?? '',
    fchVtoPago: c.FchVtoPago ?? '',
    cbtesAsoc: asArray(c.CbtesAsoc?.CbteAsoc).map((a) => ({
      tipo: Number(a.Tipo), ptoVta: Number(a.PtoVta), nro: Number(a.Nro),
    })),
    iva: asArray(c.Iva?.AlicIva).map((a) => ({
      id: Number(a.Id), baseImp: num(a.BaseImp), importe: num(a.Importe),
    })),
    tributos: asArray(c.Tributos?.Tributo).map((t) => ({
      id: Number(t.Id), desc: t.Desc, baseImp: num(t.BaseImp), alic: num(t.Alic), importe: num(t.Importe),
    })),
  };
}
