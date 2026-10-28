/**
 * Texto de PDFs de ARCA con fuentes Type3 «dibujadas» (p. ej. el F.2711 de Ganancias): cada letra es un dibujo y su
 * código es solo el orden en que apareció (la «D» es 0, la «E» es 1…), sin tabla de caracteres. Se ve bien en pantalla,
 * pero la extracción de texto común devuelve basura.
 *
 * Cómo se lee: se toma el dibujo de cada glifo y se lo reconoce contra un diccionario de formas de letras
 * (glifos-arca.json: solo formas, ningún dato de nadie):
 *  - primero por dibujo EXACTO (el mismo generador dibuja la misma letra siempre igual);
 *  - si no está, por PARECIDO de forma (mapa de bits de 24×24), solo con mucha coincidencia y sin otra letra cerca.
 * Lo que no se reconoce con seguridad queda como «?»: el lector que lo use lo deja en revisión, nunca adivina.
 *
 * Las posiciones salen de las operaciones de texto del PDF (no de getTextContent, que convierte en espacios los
 * códigos 9, 10, 13… y con eso se perderían letras).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { agruparLineas } from './cm03.js';

const LADO = 24;
// Caja del glifo (espacio de la fuente, em = 1): un poco más ancha que la letra, de la descendente a la ascendente.
const X0 = -0.1, X1 = 1.1, Y0 = -0.25, Y1 = 0.95;

const DICCIONARIO = new URL('./glifos-arca.json', import.meta.url);
let cacheDic = null;
/** Diccionario de formas: { clave → ch } y la lista para comparar formas. */
export function diccionario() {
  if (cacheDic) return cacheDic;
  const d = JSON.parse(fs.readFileSync(DICCIONARIO, 'utf8'));
  cacheDic = { exactos: new Map(d.glifos.map((g) => [g.clave, g.ch])), formas: d.glifos.map((g) => ({ ch: g.ch, bits: deHex(g.bits) })) };
  return cacheDic;
}

const multiplicar = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const aplicar = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * Contornos de un glifo Type3 (lista de operaciones de pdfjs) como polígonos en el espacio de la fuente. `OPS` son las
 * constantes de pdfjs. Las curvas se aproximan con 8 tramos.
 */
export function contornos(listaOps, OPS) {
  const polis = []; let actual = null; let m = [1, 0, 0, 1, 0, 0]; const pila = [];
  const punto = (x, y) => aplicar(m, x, y);
  const curva = (p0, p1, p2, p3) => {
    for (let t = 1; t <= 8; t++) {
      const s = t / 8, u = 1 - s;
      actual.push([u * u * u * p0[0] + 3 * u * u * s * p1[0] + 3 * u * s * s * p2[0] + s * s * s * p3[0], u * u * u * p0[1] + 3 * u * u * s * p1[1] + 3 * u * s * s * p2[1] + s * s * s * p3[1]]);
    }
  };
  listaOps.fnArray.forEach((fn, i) => {
    const a = listaOps.argsArray[i];
    if (fn === OPS.save) pila.push(m);
    else if (fn === OPS.restore) m = pila.pop() ?? m;
    else if (fn === OPS.transform) m = multiplicar(a, m);
    else if (fn === OPS.constructPath) {
      const [ops, c] = a; let j = 0;
      for (const op of ops) {
        if (op === OPS.moveTo) { actual = [punto(c[j], c[j + 1])]; polis.push(actual); j += 2; }
        else if (op === OPS.lineTo) { actual?.push(punto(c[j], c[j + 1])); j += 2; }
        else if (op === OPS.curveTo) { const p0 = actual.at(-1); curva(p0, punto(c[j], c[j + 1]), punto(c[j + 2], c[j + 3]), punto(c[j + 4], c[j + 5])); j += 6; }
        else if (op === OPS.curveTo2) { const p0 = actual.at(-1); curva(p0, p0, punto(c[j], c[j + 1]), punto(c[j + 2], c[j + 3])); j += 4; }
        else if (op === OPS.curveTo3) { const p0 = actual.at(-1); const p3 = punto(c[j + 2], c[j + 3]); curva(p0, punto(c[j], c[j + 1]), p3, p3); j += 4; }
        else if (op === OPS.rectangle) {
          const [x, y, w, h] = c.slice(j, j + 4); j += 4;
          actual = [punto(x, y), punto(x + w, y), punto(x + w, y + h), punto(x, y + h)]; polis.push(actual);
        } else if (op === OPS.closePath) { /* el polígono se cierra solo al rellenar */ }
      }
    }
  });
  return polis.filter((p) => p.length > 2);
}

/** Clave del dibujo exacto de un glifo (coordenadas redondeadas). */
export const claveGlifo = (polis) => crypto.createHash('sha256').update(JSON.stringify(polis.map((p) => p.map(([x, y]) => [Math.round(x * 1e4), Math.round(y * 1e4)])))).digest('hex').slice(0, 20);

/** Mapa de bits LADO×LADO (par-impar) de los contornos, en la caja fija del glifo. */
export function mapaDeBits(polis) {
  const bits = new Uint8Array(LADO * LADO);
  const aristas = polis.flatMap((p) => p.map((a, i) => [a, p[(i + 1) % p.length]]));
  for (let fila = 0; fila < LADO; fila++) {
    const y = Y1 - ((fila + 0.5) / LADO) * (Y1 - Y0);
    const cortes = [];
    for (const [[xa, ya], [xb, yb]] of aristas) if ((ya <= y) !== (yb <= y)) cortes.push(xa + ((y - ya) / (yb - ya)) * (xb - xa));
    cortes.sort((a, b) => a - b);
    for (let col = 0; col < LADO; col++) {
      const x = X0 + ((col + 0.5) / LADO) * (X1 - X0);
      if (cortes.filter((c) => c < x).length % 2) bits[fila * LADO + col] = 1;
    }
  }
  return bits;
}
export const aHex = (bits) => Buffer.from(Array.from({ length: bits.length / 8 }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((n, b) => (n << 1) | b, 0))).toString('hex');
function deHex(h) { const b = Buffer.from(h, 'hex'); const out = new Uint8Array(b.length * 8); b.forEach((v, i) => { for (let k = 0; k < 8; k++) out[i * 8 + k] = (v >> (7 - k)) & 1; }); return out; }

function parecido(a, b) {
  let y = 0, o = 0;
  for (let i = 0; i < a.length; i++) { y += a[i] & b[i]; o += a[i] | b[i]; }
  return o ? y / o : 0;
}

/**
 * Reconoce un glifo: { ch, como: 'exacto' | 'forma' | 'vacio' | 'dudoso', parecido }. Pura sobre el diccionario.
 * Por forma, exige ≥ 0,82 de coincidencia y 0,08 de ventaja sobre la mejor letra distinta.
 */
export function reconocer(polis, dic = diccionario()) {
  if (!polis.length) return { ch: ' ', como: 'vacio', parecido: 1 };
  const ex = dic.exactos.get(claveGlifo(polis));
  if (ex != null) return { ch: ex, como: 'exacto', parecido: 1 };
  const bits = mapaDeBits(polis);
  const mejores = new Map();
  for (const f of dic.formas) { const p = parecido(bits, f.bits); if (p > (mejores.get(f.ch) ?? 0)) mejores.set(f.ch, p); }
  const orden = [...mejores].sort((a, b) => b[1] - a[1]);
  const [ch, p] = orden[0] ?? ['?', 0]; const segundo = orden[1]?.[1] ?? 0;
  return p >= 0.82 && p - segundo >= 0.08 ? { ch, como: 'forma', parecido: p } : { ch: '?', como: 'dudoso', parecido: p };
}

/**
 * Glifos de cada página con su posición: [{ pagina, glifos: [{ x, y, w, alto, ch, como }] }], recorriendo las
 * operaciones de texto (Tf, Tm, Td, TL, T*, Tc, Tw, Tz, Ts, Tj/TJ) con la matriz de transformación vigente.
 */
export async function glifosDePdf(buf, { dic = diccionario() } = {}) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { OPS } = pdfjs;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  try {
    const paginas = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const pg = await doc.getPage(n);
      const ol = await pg.getOperatorList();
      const cache = new Map(); const glifos = [];
      let ctm = [1, 0, 0, 1, 0, 0]; const pila = [];
      let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0];
      let fuente = null, tam = 1, tc = 0, tw = 0, th = 1, tl = 0, ts = 0;
      const deFuente = (nombre) => {
        if (!cache.has(nombre)) {
          const f = pg.commonObjs.get(nombre);
          cache.set(nombre, { f, glifo: new Map() });
        }
        return cache.get(nombre);
      };
      const mover = (tx, ty) => { tlm = multiplicar([1, 0, 0, 1, tx, ty], tlm); tm = tlm; };
      const mostrar = (lista) => {
        const fu = fuente && deFuente(fuente); const fm = fu?.f?.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0];
        const tramo = [];
        for (const g of lista) {
          if (typeof g === 'number') { tm = multiplicar([1, 0, 0, 1, (-g / 1000) * tam * th, 0], tm); continue; }
          const avance = ((g.width ?? 0) * fm[0] * tam + tc + (g.isSpace ? tw : 0)) * th;
          let r = { ch: g.unicode ?? '?', como: 'texto' };
          if (fu?.f?.isType3Font) {
            // pdfjs dice qué dibujo usa cada glifo (operatorListId); si no, por la tabla de diferencias de la fuente.
            const nombreG = g.operatorListId ?? fu.f.differences?.[g.originalCharCode] ?? String(g.originalCharCode);
            if (!fu.glifo.has(nombreG)) {
              const lo = fu.f.charProcOperatorList?.[nombreG];
              // Sin dibujo (p. ej. /.notdef con ancho): no se ve nada en la página, es un espacio.
              fu.glifo.set(nombreG, lo ? reconocer(contornos(lo, OPS), dic) : { ch: ' ', como: 'vacio', parecido: 1 });
            }
            r = fu.glifo.get(nombreG);
          }
          const m = multiplicar(tm, ctm);
          const [x, y] = aplicar(m, 0, ts); const [x2] = aplicar(multiplicar([1, 0, 0, 1, avance, 0], m), 0, ts);
          tramo.push({ x, y, w: Math.abs(x2 - x), alto: Math.abs(tam * m[3]) || tam, ch: r.ch, como: r.como });
          tm = multiplicar([1, 0, 0, 1, avance, 0], tm);
        }
        // El ancho declarado de estos glifos es ficticio (el PDF corrige la posición con TJ): el ancho real es hasta
        // donde empieza el glifo siguiente del mismo tramo.
        tramo.forEach((g, k) => { const sig = tramo[k + 1]; const d = sig ? sig.x - g.x : 0; g.w = d > 0 && d < 1.5 * g.alto ? d : Math.min(g.w, 0.6 * g.alto); });
        glifos.push(...tramo);
      };
      ol.fnArray.forEach((fn, i) => {
        const a = ol.argsArray[i];
        if (fn === OPS.save) pila.push(ctm);
        else if (fn === OPS.restore) ctm = pila.pop() ?? ctm;
        else if (fn === OPS.transform) ctm = multiplicar(a, ctm);
        else if (fn === OPS.beginText) { tm = [1, 0, 0, 1, 0, 0]; tlm = tm; }
        else if (fn === OPS.setFont) { fuente = a[0]; tam = a[1]; }
        else if (fn === OPS.setTextMatrix) { tm = a.slice(0, 6); tlm = tm; }
        else if (fn === OPS.moveText) mover(a[0], a[1]);
        else if (fn === OPS.setLeadingMoveText) { tl = -a[1]; mover(a[0], a[1]); }
        else if (fn === OPS.setLeading) tl = a[0];
        else if (fn === OPS.nextLine) mover(0, -tl);
        else if (fn === OPS.setCharSpacing) tc = a[0];
        else if (fn === OPS.setWordSpacing) tw = a[0];
        else if (fn === OPS.setHScale) th = a[0] / 100;
        else if (fn === OPS.setTextRise) ts = a[0];
        else if (fn === OPS.showText || fn === OPS.showSpacedText) mostrar(a[0]);
        else if (fn === OPS.nextLineShowText) { mover(0, -tl); mostrar(a[0]); }
        else if (fn === OPS.nextLineSetSpacingShowText) { tw = a[0]; tc = a[1]; mover(0, -tl); mostrar(a[2]); }
      });
      paginas.push({ pagina: n, glifos });
    }
    return paginas;
  } finally { await doc.destroy().catch(() => {}); }
}

/** Líneas de texto (como lineasDePdf de cm03.js) a partir de los glifos reconocidos. */
export async function lineasType3(buf, opciones) {
  const paginas = await glifosDePdf(buf, opciones);
  return paginas.map(({ pagina, glifos }) => ({ pagina, lineas: agruparLineas(glifos.map((g) => ({ x: g.x, y: g.y, w: g.w, alto: g.alto, str: g.ch }))),
    dudosos: glifos.filter((g) => g.ch === '?').length, porForma: glifos.filter((g) => g.como === 'forma').length, total: glifos.filter((g) => g.ch !== ' ').length }));
}
