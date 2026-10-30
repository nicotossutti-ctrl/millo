import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wsfe, METODOS_LECTURA, WsfeError } from '../src/wsfe.js';
import { cfgDePrueba, ticketFalso, soapWsfe, xmlComprobante, xmlError602, fetchFalso } from './helpers.js';

test('bloquea cualquier método que no sea de lectura', async () => {
  const wsfe = new Wsfe(cfgDePrueba(), { fetchImpl: fetchFalso(() => ''), ticketProvider: ticketFalso });
  for (const m of ['FECAESolicitar', 'FECAEARegInformativo', 'FECAEASolicitar', 'FECAEAInformarMovimiento']) {
    await assert.rejects(() => wsfe.call(m, ''), /solo lectura/);
  }
  assert.ok(!METODOS_LECTURA.some((m) => /Solicitar|Reg|Informar/.test(m)));
});

test('consultar parsea un comprobante con IVA y asociados', async () => {
  const fetchImpl = fetchFalso((method) => {
    assert.equal(method, 'FECompConsultar');
    return soapWsfe(method, xmlComprobante({ nro: 7, tipo: 3, fch: '20260315', total: 1210, neto: 1000, ivaTotal: 210, iva: [{ id: 5, baseImp: 1000, importe: 210 }], cbtesAsoc: [{ tipo: 1, ptoVta: 1, nro: 5 }] }));
  });
  const wsfe = new Wsfe(cfgDePrueba(), { fetchImpl, ticketProvider: ticketFalso });
  const c = await wsfe.consultar(1, 3, 7);
  assert.equal(c.cbteFch, '20260315');
  assert.equal(c.impTotal, 1210);
  assert.deepEqual(c.iva, [{ id: 5, baseImp: 1000, importe: 210 }]);
  assert.deepEqual(c.cbtesAsoc, [{ tipo: 1, ptoVta: 1, nro: 5 }]);
  assert.match(fetchImpl.llamadas[0].body, /<ar:Token>T<\/ar:Token>.*<ar:Cuit>20111111112<\/ar:Cuit>/s);
  assert.match(fetchImpl.llamadas[0].body, /<ar:CbteTipo>3<\/ar:CbteTipo><ar:CbteNro>7<\/ar:CbteNro><ar:PtoVta>1<\/ar:PtoVta>/);
});

test('consultar devuelve null ante error 602 y propaga otros errores de WSFE', async () => {
  const fetchImpl = fetchFalso((method, body) => (/<ar:CbteNro>9</.test(body)
    ? soapWsfe(method, xmlError602)
    : soapWsfe(method, '<Errors><Err><Code>600</Code><Msg>ValidacionDeToken</Msg></Err></Errors>')));
  const wsfe = new Wsfe(cfgDePrueba(), { fetchImpl, ticketProvider: ticketFalso });
  assert.equal(await wsfe.consultar(1, 1, 9), null);
  await assert.rejects(() => wsfe.consultar(1, 1, 10), (e) => e instanceof WsfeError && e.codes.includes(600));
});

test('ultimoAutorizado, ptosVenta (incluye bloqueados) y tiposCbte', async () => {
  const fetchImpl = fetchFalso((method) => ({
    FECompUltimoAutorizado: soapWsfe(method, '<PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><CbteNro>123</CbteNro>'),
    FEParamGetPtosVenta: soapWsfe(method, '<ResultGet><PtoVenta><Nro>1</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja>NULL</FchBaja></PtoVenta><PtoVenta><Nro>2</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>S</Bloqueado><FchBaja>20240101</FchBaja></PtoVenta></ResultGet>'),
    FEParamGetTiposCbte: soapWsfe(method, '<ResultGet><CbteTipo><Id>1</Id><Desc>Factura A</Desc><FchDesde>20100917</FchDesde><FchHasta>NULL</FchHasta></CbteTipo></ResultGet>'),
  })[method]);
  const wsfe = new Wsfe(cfgDePrueba(), { fetchImpl, ticketProvider: ticketFalso });
  assert.equal(await wsfe.ultimoAutorizado(1, 1), 123);
  const ptos = await wsfe.ptosVenta();
  assert.equal(ptos.length, 2);
  assert.deepEqual(ptos[1], { nro: 2, emisionTipo: 'CAE', bloqueado: true, fchBaja: '20240101' });
  assert.deepEqual(await wsfe.tiposCbte(), [{ id: 1, desc: 'Factura A', fchDesde: '20100917', fchHasta: null }]);
});

test('FEDummy no manda Auth', async () => {
  const fetchImpl = fetchFalso((method) => soapWsfe(method, '<AppServer>OK</AppServer><DbServer>OK</DbServer><AuthServer>OK</AuthServer>'));
  const wsfe = new Wsfe(cfgDePrueba(), { fetchImpl, ticketProvider: async () => { throw new Error('no debería pedir ticket'); } });
  assert.deepEqual(await wsfe.dummy(), { AppServer: 'OK', DbServer: 'OK', AuthServer: 'OK' });
  assert.doesNotMatch(fetchImpl.llamadas[0].body, /<ar:Auth>/);
});
