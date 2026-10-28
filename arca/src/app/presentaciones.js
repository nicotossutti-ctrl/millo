/**
 * Declaraciones juradas PRESENTADAS, de lo ya bajado y validado (sin abrir ARCA ni SIFERE):
 *  - Cuentas Tributarias, «Declaraciones Juradas (DJ)» (ct-ddjj): todas las DJ nacionales con fecha, formulario, versión,
 *    impuesto y período (IVA F.2051, Ganancias F.711, SICORE F.744, cargas sociales F.931…).
 *  - SIFERE, lista de DJ mensuales CM03 (sifere-consultas-ddjj-mensuales): anticipo «AAAAMM - n» (n = rectificativa),
 *    estado y fecha de presentación. La lista NO trae el impuesto determinado: ese importe se carga desde el cartel.
 * Una presentación encontrada es un dato verificado; que no aparezca solo dice que no está en lo bajado.
 */
import { vigentes, periodoFiscal, clasificarImpuesto } from './panel.js';
import { fechaIso } from '../portal/calidad.js';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const col = (headers, re) => headers.findIndex((h) => re.test(norm(h)));
const fuenteDe = (id, v) => `${id} (${v.entrada.nivel ?? 'validado'}, ${v.entrada.cuando})`;

/** Todas las DJ de Cuentas Tributarias conservadas, sin repetir: [{ fecha, formulario, version, impuesto, clave, periodo, descripcion, fuente }]. */
export function djCuentasTributarias(datosDir) {
  const out = []; const vistos = new Set();
  for (const v of vigentes(datosDir, 'ct-ddjj')) {
    for (const t of v.tablas) {
      const fe = col(t.headers, /^fecha/); const fo = col(t.headers, /formulario/); const ve = col(t.headers, /version/); const ii = col(t.headers, /impuesto/);
      const ip = col(t.headers, /^periodo/); const de = col(t.headers, /descripcion/); const ob = col(t.headers, /observ/);
      if (fo < 0 || ii < 0 || ip < 0) continue;
      for (const f of t.rows) {
        const k = [f[fe], f[fo], f[ve], f[ii], f[ip]].join('|');
        if (vistos.has(k)) continue; vistos.add(k);
        if (ob >= 0 && f[ob] && !/valid/i.test(f[ob])) continue; // solo las válidas
        out.push({ fecha: fe >= 0 ? f[fe] : null, fechaIso: fe >= 0 ? fechaIso(String(f[fe]).slice(0, 10)) : null, formulario: f[fo], version: ve >= 0 ? f[ve] : null,
          impuesto: f[ii], clave: clasificarImpuesto(f[ii]).clave, periodo: periodoFiscal(f[ip]), descripcion: de >= 0 ? f[de] : null, fuente: fuenteDe('ct-ddjj', v) });
      }
    }
  }
  return out.sort((a, b) => String(b.fechaIso ?? '').localeCompare(String(a.fechaIso ?? '')));
}

/** DJ mensuales presentadas para el período `mes` (todas las del período, la más nueva primero). */
export function djDelPeriodo(datosDir, mes) {
  return djCuentasTributarias(datosDir).filter((d) => d.periodo?.tipo === 'mes' && d.periodo.mes === mes);
}

/** DJ anual de Ganancias del año (F.711 u otra), la última versión presentada; null si no está en lo bajado. */
export function djAnualGanancias(datosDir, anio) {
  return djCuentasTributarias(datosDir).find((d) => d.clave === 'ganancias' && d.periodo?.tipo === 'anual' && String(d.periodo.anio) === String(anio)) ?? null;
}

/**
 * CM03 del mes según SIFERE: { presentada: la de rectificativa más alta presentada | null, borradores, todas, fuente } o
 * null si no hay ninguna lista de SIFERE conservada.
 */
export function cm03Sifere(datosDir, mes) {
  const listas = vigentes(datosDir, 'sifere-consultas-ddjj-mensuales');
  if (!listas.length) return null;
  const todas = []; let fuente = null;
  for (const v of listas) {
    fuente ??= fuenteDe('sifere-consultas-ddjj-mensuales', v);
    for (const t of v.tablas) {
      const ia = col(t.headers, /^anticipo/); const ie = col(t.headers, /^estado/); const ip = col(t.headers, /presentacion/); const ir = col(t.headers, /resultado/);
      if (ia < 0 || ie < 0) continue;
      for (const f of t.rows) {
        const m = String(f[ia] ?? '').match(/^(\d{4})(\d{2})\s*-\s*(\d+)/);
        if (!m || `${m[1]}-${m[2]}` !== mes) continue;
        todas.push({ rectificativa: Number(m[3]), estado: String(f[ie] ?? '').trim(), presentada: /presentada/i.test(f[ie] ?? ''),
          fechaPresentacion: ip >= 0 ? String(f[ip] ?? '').trim() || null : null, resultado: ir >= 0 ? String(f[ir] ?? '').trim() || null : null });
      }
    }
  }
  const presentadas = todas.filter((x) => x.presentada).sort((a, b) => b.rectificativa - a.rectificativa);
  return { presentada: presentadas[0] ?? null, borradores: todas.filter((x) => !x.presentada), todas, fuente };
}
