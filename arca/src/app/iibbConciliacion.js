/**
 * Conciliación de Ingresos Brutos POR JURISDICCIÓN: lo que la CM03 dejó a pagar en cada una contra los pagos VERIFICADOS
 * que dicen a qué jurisdicción van. Reglas:
 *  - Un VEP emitido o un volante generado no es un pago; solo cuenta un pago con estado positivo o de una consulta de
 *    pagos realizados.
 *  - Un pago verificado que no dice su jurisdicción (p. ej. un volante pagado por el total) queda «pendiente de
 *    imputación»: no se reparte entre jurisdicciones.
 *  - Sin pagos verificados de una jurisdicción, su saldo es «Sin verificar», nunca deuda confirmada.
 * Pura.
 */
const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const r2 = (x) => Math.round(x * 100) / 100;

// Jurisdicciones de Convenio Multilateral con su código (901 a 924) y los nombres con que pueden aparecer.
const JURISDICCIONES = [
  ['901', 'Ciudad Autónoma de Buenos Aires', ['caba', 'c a b a', 'ciudad autonoma de buenos aires', 'ciudad de buenos aires', 'capital federal']],
  ['902', 'Buenos Aires', ['buenos aires', 'provincia de buenos aires', 'pcia de buenos aires', 'pcia buenos aires', 'bs as', 'pba']],
  ['903', 'Catamarca', ['catamarca']], ['904', 'Córdoba', ['cordoba']], ['905', 'Corrientes', ['corrientes']], ['906', 'Chaco', ['chaco']],
  ['907', 'Chubut', ['chubut']], ['908', 'Entre Ríos', ['entre rios']], ['909', 'Formosa', ['formosa']], ['910', 'Jujuy', ['jujuy']],
  ['911', 'La Pampa', ['la pampa']], ['912', 'La Rioja', ['la rioja']], ['913', 'Mendoza', ['mendoza']], ['914', 'Misiones', ['misiones']],
  ['915', 'Neuquén', ['neuquen']], ['916', 'Río Negro', ['rio negro']], ['917', 'Salta', ['salta']], ['918', 'San Juan', ['san juan']],
  ['919', 'San Luis', ['san luis']], ['920', 'Santa Cruz', ['santa cruz']], ['921', 'Santa Fe', ['santa fe']],
  ['922', 'Santiago del Estero', ['santiago del estero']], ['923', 'Tierra del Fuego', ['tierra del fuego']], ['924', 'Tucumán', ['tucuman']],
];

/** Código de jurisdicción ('901'…'924') de un texto («902 - Buenos Aires», «Pcia. de Córdoba», «CABA»…), o null. Pura. */
export function claveJurisdiccion(texto, codigo = null) {
  const c = String(codigo ?? '').match(/^9(0[1-9]|1\d|2[0-4])$/) ? String(codigo) : String(texto ?? '').match(/\b(9(?:0[1-9]|1\d|2[0-4]))\b/)?.[1];
  if (c) return c;
  const t = sinAcentos(texto).replace(/^(provincia|pcia|prov) (de )?/, '');
  if (!t) return null;
  // Exacto primero; después, el nombre contenido (el más largo gana: «santiago del estero» antes que «santa…»).
  for (const [cod, , alias] of JURISDICCIONES) if (alias.includes(t)) return cod;
  const contenidos = JURISDICCIONES.flatMap(([cod, , alias]) => alias.map((a) => [cod, a])).filter(([, a]) => new RegExp(`\\b${a}\\b`).test(t)).sort((a, b) => b[1].length - a[1].length);
  // «Buenos Aires» dentro de «Ciudad Autónoma de Buenos Aires»: el alias más largo ya es el de CABA.
  return contenidos[0]?.[0] ?? null;
}
export const nombreJurisdiccion = (cod) => JURISDICCIONES.find(([c]) => c === cod)?.[1] ?? null;

/**
 * pagos: [{ importe, fecha, jurisdiccion, comprobante, verificado, fuente, nivel, estado }] del período. `consultado`:
 * si la consulta de pagos por jurisdicción (SIFERE Consultas) se pudo leer para el período. Devuelve { filas, sinImputar,
 * sinConfirmar, total }.
 */
export function conciliarIibb({ jurisdicciones = [], pagos = [], consultado = false }) {
  const verificados = pagos.filter((p) => p.verificado && p.importe > 0);
  const usados = new Set();
  const filas = jurisdicciones.map((j) => {
    const cod = claveJurisdiccion(j.jurisdiccion, j.codigo);
    const suyos = cod ? verificados.filter((p) => p.jurisdiccion && claveJurisdiccion(p.jurisdiccion) === cod) : [];
    suyos.forEach((p) => usados.add(p));
    const pagado = suyos.length ? r2(suyos.reduce((n, p) => n + p.importe, 0)) : null;
    const base = { jurisdiccion: j.jurisdiccion, codigo: cod, aPagar: j.aPagar, pagado, pagos: suyos.map(({ fecha, importe, comprobante, fuente }) => ({ fecha, importe, comprobante, fuente })) };
    if (!(j.aPagar > 0)) return { ...base, estado: 'Nada a pagar según la CM03', saldo: pagado ? r2(-pagado) : 0 };
    if (pagado == null) return { ...base, estado: consultado ? 'Sin pagos verificados' : 'A consultar', saldo: null, saldoTexto: 'Sin verificar' };
    if (pagado >= j.aPagar - 1) return { ...base, estado: pagado > j.aPagar + 1 ? 'Pagado (de más)' : 'Pagado', saldo: r2(j.aPagar - pagado) };
    return { ...base, estado: 'Pago parcial', saldo: r2(j.aPagar - pagado) };
  });
  const sinImputar = verificados.filter((p) => !usados.has(p)).map(({ fecha, importe, comprobante, fuente, jurisdiccion }) => ({ fecha, importe, comprobante, fuente, jurisdiccion: jurisdiccion ?? null,
    nota: jurisdiccion ? `la jurisdicción «${jurisdiccion}» no está entre las de la CM03` : 'el pago no dice a qué jurisdicción corresponde: pendiente de imputación' }));
  const sinConfirmar = pagos.filter((p) => !p.verificado).map(({ fecha, importe, comprobante, fuente, estado }) => ({ fecha, importe, comprobante, fuente, estado: estado ?? null }));
  const aPagar = r2(jurisdicciones.reduce((n, j) => n + (j.aPagar > 0 ? j.aPagar : 0), 0));
  const pagadoTotal = r2(verificados.reduce((n, p) => n + p.importe, 0));
  return { filas, sinImputar, sinConfirmar, consultado,
    total: { aPagar, pagadoVerificado: pagadoTotal || null, saldo: pagadoTotal >= aPagar - 1 ? r2(aPagar - pagadoTotal) : null,
      saldoTexto: pagadoTotal >= aPagar - 1 ? null : 'Sin verificar' } };
}
