/**
 * Detalle de la DDJJ de IVA de un período, leído de Portal IVA en SOLO LECTURA.
 *
 * Portal IVA ("Declaración Jurada de IVA", #/declaraciones.anteriores) muestra cada DJ presentada en
 * su propia tabla (Período Fiscal / Formulario / Secuencia / Presentación) con botones por fila
 * (diagnóstico 2026-10-25): "Ver declaración jurada", "Descargar acuse de recibo", "Descargar
 * formulario", "Generar VEP" y "RECTIFICAR". Acá SOLO se usan "Ver declaración jurada" (para leer
 * los importes de la pantalla) y "Descargar acuse de recibo" (comprobante local). Generar VEP y
 * Rectificar están vetados por esProhibido y nunca se tocan.
 *
 * El acuse en PDF no sirve para leer importes (ARCA usa una fuente sin mapa de caracteres: el texto
 * sale ilegible), por eso los importes se leen de la vista "Ver declaración jurada".
 */
import fs from 'node:fs';
import path from 'node:path';
import { esProhibido, norm } from './extractor.js';
import { drillHaciaGrilla } from './navegar.js';
import { relevarTodasLasPaginas } from './relevar.js';
import { mesesCompletos } from './coberturaHistorica.js';
import { fechaIso } from './calidad.js';
import { toCsv } from '../csv.js';

const BOTON_VER = 'Ver declaración jurada';
const BOTON_ACUSE = 'Descargar acuse de recibo';

/** 'aaaa-mm' a partir de "09/2026", "2026-09", "2026/09" o "202609"; null si no es un período. */
export function periodoDe(texto) {
  const s = String(texto ?? '').trim();
  let m = s.match(/^(\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})[/-](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{4})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}`;
  // Cuentas Tributarias informa el período con 8 dígitos: AAAAMM00 (CSV de DJ, corrida 2026-10-26).
  m = s.match(/^(\d{4})(\d{2})\d{2}$/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2]}`;
  return null;
}

/**
 * Valores numéricos de una respuesta JSON como conceptos: la ruta de claves en palabras
 * ("liquidacion.saldoAFavorAfip" -> "liquidacion saldo a favor afip") y el importe. Pura.
 * Sirve para leer la DJ de los datos que la aplicación de ARCA carga al abrirla.
 */
export function conceptosDeJson(json, prefijo = '') {
  const out = [];
  // camelCase en palabras, incluida la mayúscula suelta: "saldoAFavorAfip" -> "saldo a favor afip".
  const palabras = (k) => String(k).replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/[_.]+/g, ' ').toLowerCase();
  const visitar = (v, ruta) => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ concepto: ruta.trim(), importe: v, origen: 'json' });
    else if (Array.isArray(v)) v.forEach((x, i) => visitar(x, `${ruta} ${i}`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visitar(x, `${ruta} ${palabras(k)}`);
  };
  visitar(json, prefijo);
  return out;
}

/** "1.234.567,89" / "$ -1.234,50" / "1234,5" -> número; null si no es un importe. */
export function importeDe(texto) {
  const s = String(texto ?? '').replace(/\s|\$/g, '');
  if (!/^-?\(?[\d.]*\d(,\d{1,2})?\)?$/.test(s)) return null;
  const neg = s.startsWith('-') || s.startsWith('(');
  const n = Number(s.replace(/[-()]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/**
 * Conceptos con importe de un texto de pantalla: cada línea "Concepto ..... $ 1.234,56". Pura.
 * Devuelve [{ concepto, importe }] en el orden en que aparecen.
 */
export function parsearConceptos(texto) {
  const out = [];
  for (const linea of String(texto ?? '').split(/\r?\n/)) {
    const l = linea.replace(/\s+/g, ' ').trim();
    const m = l.match(/^(.*?[A-Za-zÁÉÍÓÚáéíóúÑñ].*?)[\s:]*(-?\$?\s?-?\(?[\d.]*\d,\d{2}\)?)$/);
    if (!m) continue;
    const importe = importeDe(m[2]);
    const concepto = m[1].replace(/[\s:.$]+$/, '').trim();
    if (importe == null || !concepto) continue;
    out.push({ concepto, importe });
  }
  return out;
}

// Conceptos clave de la DJ de IVA (F.2002). Se reconocen por el texto; si un concepto aparece más de
// una vez con importes distintos, queda AMBIGUO y no se usa para calcular.
// El tercer elemento excluye: el saldo TÉCNICO a favor de ARCA no es el saldo a pagar.
const CLAVES = [
  // "de" opcional: los nombres de campo de los JSON de ARCA vienen como "saldoAFavorAfip".
  ['saldoAPagar', /saldo.*(a favor (de )?(la |el )?(arca|afip|agencia|fisco)|a pagar|impuesto a ingresar)/, /tecnico|libre disponibilidad/],
  ['saldoLibreDisponibilidad', /saldo.*libre disponibilidad/],
  ['saldoTecnicoAFavorResponsable', /saldo tecnico.*a favor (del |de la )?(responsable|contribuyente)/],
  ['saldoTecnicoAFavorArca', /saldo tecnico.*a favor (de )?(la )?(arca|afip|agencia|fisco)/],
  ['debitoFiscal', /total.*debito fiscal|debito fiscal total/],
  ['creditoFiscal', /total.*credito fiscal|credito fiscal total/],
  ['retencionesPercepciones', /total.*(retenciones|percepciones)/],
];

/** Identifica los conceptos clave. Devuelve { clave: { importe, concepto } | { ambiguo: [...] } }. Pura. */
export function identificarConceptosIva(conceptos) {
  const out = {};
  for (const [clave, re, excluye] of CLAVES) {
    const hits = (conceptos ?? []).filter((c) => re.test(norm(c.concepto)) && !(excluye && excluye.test(norm(c.concepto))));
    const distintos = [...new Set(hits.map((h) => h.importe))];
    if (!hits.length) continue;
    out[clave] = distintos.length === 1 ? { importe: hits[0].importe, concepto: hits[0].concepto } : { ambiguo: hits };
  }
  return out;
}

/** Corre en el navegador: lista las DJ de la página (una tabla por DJ) con su fila y si tiene "Ver". */
function listarDjsEnDocumento() {
  const tx = (c) => (c.innerText || c.textContent || '').trim().replace(/\s+/g, ' ');
  const out = [];
  [...document.querySelectorAll('table')].forEach((t, idx) => {
    const head = t.tHead?.rows?.[0] ?? t.rows[0];
    const enc = [...(head?.cells ?? [])].map(tx);
    if (!enc.some((e) => /per[ií]odo/i.test(e))) return;
    const fila = [...t.tBodies].flatMap((b) => [...b.rows]).find((r) => r !== head);
    if (!fila) return;
    // Contenedor de la DJ: el ancestro más cercano que tiene UN botón "Ver declaración jurada".
    let cont = t; let ver = null;
    for (let i = 0; i < 6 && cont && !ver; i++) {
      const vs = cont.querySelectorAll('button[title="Ver declaración jurada"]');
      if (vs.length === 1) ver = vs[0]; else if (vs.length > 1) break;
      cont = cont.parentElement;
    }
    const celdas = [...fila.cells].map(tx);
    const dato = (re) => { const i = enc.findIndex((e) => re.test(e)); return i >= 0 ? celdas[i] : null; };
    out.push({ idx, periodo: dato(/per[ií]odo/i), formulario: dato(/formulario/i), secuencia: dato(/secuencia/i), presentacion: dato(/presentaci/i), tieneVer: !!ver });
  });
  return out;
}

/** Corre en el navegador: marca los botones de la DJ `idx` para clickearlos por selector. */
function marcarBotonesDj(idx) {
  const t = [...document.querySelectorAll('table')][idx];
  let cont = t;
  for (let i = 0; i < 6 && cont; i++) {
    const vs = cont.querySelectorAll('button[title="Ver declaración jurada"]');
    if (vs.length === 1) break;
    cont = cont.parentElement;
  }
  if (!cont) return false;
  for (const b of document.querySelectorAll('[data-fiscalos]')) b.removeAttribute('data-fiscalos');
  const ver = cont.querySelector('button[title="Ver declaración jurada"]');
  const acuse = cont.querySelector('button[title="Descargar acuse de recibo"]');
  if (ver) ver.setAttribute('data-fiscalos', 'ver');
  if (acuse) acuse.setAttribute('data-fiscalos', 'acuse');
  return !!ver;
}

/** De varias DJ del mismo período, la vigente: la última presentada (fecha) y, a igual fecha, la de mayor secuencia. Pura. */
export function elegirDjVigente(djs, mes) {
  const delMes = (djs ?? []).filter((d) => periodoDe(d.periodo) === mes && d.tieneVer);
  const nSec = (s) => { const m = String(s ?? '').match(/(\d+)/); return /original/i.test(s ?? '') ? 0 : m ? Number(m[1]) : 0; };
  delMes.sort((a, b) => String(fechaIso(a.presentacion) ?? '').localeCompare(String(fechaIso(b.presentacion) ?? '')) || nSec(a.secuencia) - nSec(b.secuencia));
  return { elegida: delMes.at(-1) ?? null, candidatas: delMes.length };
}

/** ¿El texto de la vista corresponde al período? (identidad: la vista abierta es la DJ pedida). Pura. */
export function textoEsDelPeriodo(texto, mes) {
  const [y, m] = mes.split('-');
  const t = String(texto ?? '');
  return t.includes(`${m}/${y}`) || t.includes(`${y}${m}`) || t.includes(`${y}-${m}`) || t.includes(`${y}/${m}`);
}

/** Único botón que se usa para avanzar en la vista de la DJ: texto exacto CONTINUAR o SIGUIENTE. */
async function botonContinuar(p) {
  for (const f of p.frames()) {
    const b = f.locator('button, [role=button], input[type=button], input[type=submit]').filter({ hasText: /^\s*(continuar|siguiente)\s*$/i });
    const n = Math.min(await b.count().catch(() => 0), 5);
    for (let i = 0; i < n; i++) {
      const it = b.nth(i);
      if (!(await it.isVisible().catch(() => false)) || !(await it.isEnabled().catch(() => false))) continue;
      const txt = ((await it.innerText().catch(() => '')) || '').trim();
      if (!/^(continuar|siguiente)$/i.test(txt) || esProhibido(txt)) continue;
      return it;
    }
  }
  return null;
}

async function textoDePagina(p) {
  const partes = [];
  for (const f of p.frames()) partes.push(await f.evaluate(() => document.body?.innerText ?? '').catch(() => ''));
  return partes.join('\n');
}

/**
 * Extractor 'iva-ddjj'. Para cada mes ENTERO del período pide la DJ vigente de Portal IVA, abre
 * "Ver declaración jurada", lee los conceptos con importe y descarga el acuse. Todo local:
 * out/datos/<id>/intentos/<corrida>/ (CSV de conceptos + texto de la vista) y
 * out/datos/<id>/documentos/<mes>/ (acuse PDF). Devuelve intentos por mes para la conservación.
 */
export async function correrIvaDdjj(sesion, servicio, dir, periodo, log, ctx = {}) {
  const pagina = await sesion.abrirServicio(servicio);
  await pagina.waitForTimeout(3500);
  const drill = await drillHaciaGrilla(pagina, { expected: ['periodo', 'formulario', 'secuencia', 'presentacion'], ruta: servicio.ruta ?? [], log });
  const p = drill.pagina ?? pagina;
  const outBase = sesion?.cfg?.outDir ?? 'out';
  const meses = mesesCompletos(periodo.desde, periodo.hasta);
  const intentos = []; const sub = [];
  for (const mes of meses) {
    const idMes = `${servicio.id}`;
    const dirIntento = ctx.dirIntento?.(idMes) ?? path.join(outBase, 'datos', idMes, 'intentos', 'manual');
    const [y, m] = mes.split('-');
    const desde = `${mes}-01`; const hasta = new Date(Date.UTC(Number(y), Number(m), 0)).toISOString().slice(0, 10);
    const clave = `${desde}_${hasta}`;
    try {
      let frameDj = null; let lista = [];
      for (const f of p.frames()) {
        const djs = await f.evaluate(listarDjsEnDocumento).catch(() => []);
        if (djs.length) { frameDj = f; lista = djs; break; }
      }
      const { elegida, candidatas } = elegirDjVigente(lista, mes);
      if (!elegida) throw new Error(`Portal IVA no lista una DJ de IVA presentada para ${m}/${y} (${lista.length} DJ en la lista)`);
      log(`  DJ IVA ${m}/${y}: formulario ${elegida.formulario}, ${elegida.secuencia}, presentada ${elegida.presentacion}${candidatas > 1 ? ` (vigente entre ${candidatas})` : ''}`);
      await frameDj.evaluate(marcarBotonesDj, elegida.idx);
      const ver = frameDj.locator('[data-fiscalos="ver"]');
      const titulo = (await ver.getAttribute('title').catch(() => '')) || '';
      if (titulo !== BOTON_VER || esProhibido(titulo)) throw new Error(`el botón marcado no es "${BOTON_VER}" (es "${titulo}"): no se toca`);

      // Comprobante: el acuse en PDF (solo descarga). Si no hay o falla, se sigue con la vista.
      const acuse = frameDj.locator('[data-fiscalos="acuse"]');
      let archivoAcuse = null;
      if (await acuse.count().catch(() => 0)) {
        const t2 = (await acuse.getAttribute('title').catch(() => '')) || '';
        if (t2 === BOTON_ACUSE && !esProhibido(t2)) {
          const [descarga] = await Promise.all([p.waitForEvent('download', { timeout: 20000 }).catch(() => null), acuse.click().catch(() => {})]);
          if (descarga) {
            const docDir = path.join(outBase, 'datos', servicio.id, 'documentos', mes);
            fs.mkdirSync(docDir, { recursive: true, mode: 0o700 });
            archivoAcuse = path.join(docDir, `acuse-iva-${mes}${path.extname(descarga.suggestedFilename()) || '.pdf'}`);
            await descarga.saveAs(archivoAcuse);
            fs.chmodSync(archivoAcuse, 0o600);
            log(`  acuse guardado: ${path.basename(archivoAcuse)}`);
          }
        }
      }

      // Vista de la DJ (corrida 2026-10-26): abre la app F.2051 "IVA SIMPLE" en una pestaña nueva, en
      // modo consulta de la DJ presentada, en el paso "Datos iniciales"; los importes están en los
      // pasos siguientes. Se registran (solo lectura) las respuestas JSON que la app recibe de ARCA
      // y se avanza paso a paso SOLO con "CONTINUAR", leyendo cada pantalla.
      const ctxNav = typeof p.context === 'function' ? p.context() : null;
      const jsons = [];
      const alResponder = async (resp) => {
        try {
          if (jsons.length >= 40) return;
          const u = resp.url();
          if (!/siapweb|afip\.gob\.ar|arca\.gob\.ar/.test(u) || !/json/i.test(resp.headers()['content-type'] ?? '')) return;
          jsons.push({ url: u.split('?')[0], json: await resp.json() });
        } catch { /* respuesta no JSON o ya liberada */ }
      };
      ctxNav?.on?.('response', alResponder);
      const [nueva] = await Promise.all([
        ctxNav?.waitForEvent?.('page', { timeout: 10000 }).catch(() => null) ?? Promise.resolve(null),
        ver.click(),
      ]);
      const vista = nueva ?? p;
      await vista.waitForLoadState?.('networkidle').catch(() => {});
      await vista.waitForTimeout?.(4000);
      const pasos = [await textoDePagina(vista)];
      for (let i = 0; i < 15; i++) {
        const sig = await botonContinuar(vista);
        if (!sig) break;
        await sig.click().catch(() => {});
        await vista.waitForLoadState?.('networkidle').catch(() => {});
        await vista.waitForTimeout?.(2500);
        const t = await textoDePagina(vista);
        if (t === pasos.at(-1)) break; // no avanzó
        pasos.push(t);
      }
      ctxNav?.off?.('response', alResponder);
      log(`  vista de la DJ: ${pasos.length} paso(s) leídos, ${jsons.length} respuesta(s) JSON de ARCA`);
      const texto = pasos.join('\n\n----- paso -----\n\n');
      const estructura = await relevarTodasLasPaginas(sesion, vista).catch(() => []);
      fs.mkdirSync(dirIntento, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, `estructura-ddjj-${mes}.json`), JSON.stringify(estructura, null, 2), { mode: 0o600 });
      // El texto de la vista tiene importes: queda SOLO local, en la carpeta de datos (no en la corrida).
      fs.writeFileSync(path.join(dirIntento, `vista-ddjj-iva-${mes}.txt`), texto, { mode: 0o600 });
      if (jsons.length) fs.writeFileSync(path.join(dirIntento, `datos-ddjj-iva-${mes}.json`), JSON.stringify(jsons, null, 2), { mode: 0o600 });
      const conceptos = [...parsearConceptos(texto), ...jsons.flatMap((j) => conceptosDeJson(j.json, 'json'))];
      const csvNombre = `ddjj-iva-${mes}.csv`;
      fs.writeFileSync(path.join(dirIntento, csvNombre), toCsv(conceptos, [{ header: 'Concepto', value: (c) => c.concepto }, { header: 'Importe', value: (c) => c.importe }]), { mode: 0o600 });
      const ident = identificarConceptosIva(conceptos);
      const delPeriodo = textoEsDelPeriodo(texto, mes);
      const claves = Object.entries(ident).filter(([, v]) => v.importe != null).map(([k]) => k);
      // Validado: la vista es de ESE período y se identificó al menos un saldo. Si no, evidencia.
      const validado = delPeriodo && conceptos.length > 0 && claves.some((k) => /saldo/i.test(k));
      const motivos = [];
      if (!delPeriodo) motivos.push(`la vista abierta no menciona el período ${m}/${y}: no se puede asegurar que sea esa DJ`);
      if (!conceptos.length) motivos.push('la vista no tiene conceptos con importe legibles (¿abrió un PDF?)');
      else if (!claves.some((k) => /saldo/i.test(k))) motivos.push('no se identificó ningún saldo (a pagar / técnico / libre disponibilidad) por su texto');
      const calidad = { nivel: validado ? 'validado' : conceptos.length ? 'obtenido' : 'sin-datos', validado, apto: false, motivos };
      const resultado = { id: servicio.id, estado: validado ? 'extraido' : 'parcial', filas: conceptos.length, archivos: [csvNombre], conFiltroPeriodo: true,
        rangoOk: delPeriodo, calidad, dj: { formulario: elegida.formulario, secuencia: elegida.secuencia, presentacion: elegida.presentacion },
        conceptosIdentificados: claves, acuse: archivoAcuse ? path.basename(archivoAcuse) : null };
      intentos.push({ id: servicio.id, dirIntento, clave, resultado });
      sub.push({ sub: mes, filas: conceptos.length, nivel: calidad.nivel, motivo: motivos.join('; ') || undefined, conceptosIdentificados: claves });
      log(`  DJ IVA ${m}/${y}: ${conceptos.length} conceptos con importe · identificados: ${claves.join(', ') || 'ninguno'} · ${calidad.nivel}`);
      if (nueva) await nueva.close().catch(() => {});
      else { await p.goBack?.().catch(() => {}); await p.waitForTimeout?.(2500); }
    } catch (e) {
      const error = String(e?.message ?? e);
      intentos.push({ id: servicio.id, dirIntento, clave: null, resultado: { estado: 'error', filas: 0, error } });
      sub.push({ sub: mes, filas: 0, nivel: 'sin-datos', motivo: error });
      log(`  DJ IVA ${mes}: ${error}`);
    }
  }
  if (p !== sesion.page) await p.close().catch(() => {});
  if (pagina !== sesion.page && pagina !== p) await pagina.close().catch(() => {});
  const todos = sub.length && sub.every((s) => s.nivel === 'validado');
  return {
    estado: todos ? 'validado' : sub.some((s) => s.filas) ? 'descargado' : 'relevado',
    filas: sub.reduce((n, s) => n + s.filas, 0), archivos: [], intentos,
    motivo: sub.map((s) => `${s.sub}: ${s.nivel}${s.motivo ? ` (${s.motivo})` : ''}`).join(' · '),
    validaciones: sub.map((s) => ({ sub: s.sub, filas: s.filas, nivel: s.nivel, ok: s.nivel === 'validado', motivo: s.motivo, conceptosIdentificados: s.conceptosIdentificados })),
  };
}
