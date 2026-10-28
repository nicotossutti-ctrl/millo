/**
 * PDF SINTÉTICO con una fuente Type3 «dibujada», como las de ARCA: cada letra es un dibujo (acá, los cuadritos de su
 * forma en el diccionario de glifos) y su código es el orden en que aparece, sin tabla de caracteres. Sirve para probar
 * glifos.js y los lectores de DJ sin documentos reales.
 */
import fs from 'node:fs';

const LADO = 24; const X0 = -0.1, X1 = 1.1, Y0 = -0.25, Y1 = 0.95;
const dic = JSON.parse(fs.readFileSync(new URL('../../src/app/glifos-arca.json', import.meta.url), 'utf8'));
const bitsDe = (hex) => { const b = Buffer.from(hex, 'hex'); const out = []; b.forEach((v) => { for (let k = 0; k < 8; k++) out.push((v >> (7 - k)) & 1); }); return out; };

/** Dibujo de una letra: un rectángulo por cuadrito lleno de su forma. `ch` sin forma conocida: `dibujoPropio` o vacío. */
function proc(ch, dibujoPropio) {
  if (ch === ' ') return '0.6 0 d0\n';
  if (dibujoPropio?.[ch]) return `0.6 0 -0.1 -0.25 1.1 0.95 d1\n${dibujoPropio[ch]}\nf\n`;
  const g = dic.glifos.find((x) => x.ch === ch);
  if (!g) throw new Error(`no hay forma para «${ch}»`);
  const bits = bitsDe(g.bits); const cw = (X1 - X0) / LADO, chh = (Y1 - Y0) / LADO; let s = '';
  bits.forEach((b, i) => { if (b) s += `${(X0 + (i % LADO) * cw).toFixed(4)} ${(Y1 - (Math.floor(i / LADO) + 1) * chh).toFixed(4)} ${cw.toFixed(4)} ${chh.toFixed(4)} re\n`; });
  return `0.6 0 -0.1 -0.25 1.1 0.95 d1\n${s}f\n`;
}

/** PDF de una página con renglones [{ texto, x, y, tam }] en una fuente Type3. Los códigos van por orden de aparición. */
export function pdfType3(renglones, { dibujoPropio = null } = {}) {
  const codigos = new Map();
  for (const r of renglones) for (const ch of r.texto) if (!codigos.has(ch)) codigos.set(ch, codigos.size);
  if (codigos.size > 255) throw new Error('demasiadas letras');
  const nombres = [...codigos.keys()].map((_, i) => `g${i}`);
  const hex = (t) => [...t].map((ch) => codigos.get(ch).toString(16).padStart(2, '0')).join('');
  const contenido = `BT\n${renglones.map((r) => `/F1 ${r.tam ?? 9} Tf\n1 0 0 1 ${r.x} ${r.y} Tm\n<${hex(r.texto)}> Tj`).join('\n')}\nET\n`;
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>';
  objs[4] = `<< /Length ${Buffer.byteLength(contenido)} >>\nstream\n${contenido}endstream`;
  const base = 6;
  objs[5] = `<< /Type /Font /Subtype /Type3 /FontBBox [-0.1 -0.25 1.1 0.95] /FontMatrix [1 0 0 1 0 0] /FirstChar 0 /LastChar ${codigos.size - 1}
 /Widths [${nombres.map(() => '0.6').join(' ')}] /Encoding << /Type /Encoding /Differences [0 ${nombres.map((n) => `/${n}`).join(' ')}] >>
 /CharProcs << ${nombres.map((n, i) => `/${n} ${base + i} 0 R`).join(' ')} >> /Resources << >> >>`;
  [...codigos.keys()].forEach((ch, i) => { const p = proc(ch, dibujoPropio); objs[base + i] = `<< /Length ${Buffer.byteLength(p)} >>\nstream\n${p}endstream`; });
  let pdf = '%PDF-1.4\n'; const offs = [];
  for (let i = 1; i < objs.length; i++) { offs[i] = Buffer.byteLength(pdf); pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offs.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const ar = (n) => (n < 0 ? '-' : '') + Math.abs(n).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Renglones de una DJ de Ganancias F.2711 SINTÉTICA (datos inventados), con la disposición del formulario real. */
export function renglonesF2711({ anio = '2024', secuencia = 'Original', fecha = '12/06/2025', determinado = 1500, pagos = 400, arca = 1100, contribuyente = null } = {}) {
  const r = [
    { texto: 'DECLARACIÓN JURADA SIMPLIFICADA', x: 25, y: 750 },
    { texto: 'GANANCIAS PERSONAS HUMANAS', x: 30, y: 734 },
    { texto: 'F.2711 V.100', x: 60, y: 706 },
    { texto: 'Período', x: 190, y: 805 }, { texto: 'Fecha de Presentación', x: 500, y: 805 },
    { texto: anio, x: 190, y: 795 }, { texto: fecha, x: 500, y: 795 },
    { texto: 'Secuencia', x: 190, y: 735 }, { texto: secuencia, x: 190, y: 725 },
    { texto: 'Determinación del saldo', x: 280, y: 153 },
    { texto: 'Impuesto determinado total', x: 14, y: 116 }, { texto: `$ ${ar(determinado)}`, x: 560, y: 116 },
    { texto: 'Pagos a cuenta computables en el impuesto a las ganancias', x: 14, y: 94 }, { texto: `$ ${ar(pagos)}`, x: 560, y: 94 },
    { texto: 'Saldos a favor', x: 290, y: 69 },
  ];
  if (arca != null) r.push({ texto: 'ARCA', x: 14, y: 32 }, { texto: `$ ${ar(arca)}`, x: 560, y: 32 });
  if (contribuyente != null) r.push({ texto: 'Contribuyente', x: 14, y: 20 }, { texto: `$ ${ar(contribuyente)}`, x: 560, y: 20 });
  return r;
}
