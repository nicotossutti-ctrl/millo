/**
 * Comparación entre períodos EQUIVALENTES con las fotos de PFOS: del 1 al día N de cada mes, N = el día del corte del mes
 * en curso (si el otro mes es más corto, su último día). Así octubre al 26 se compara con septiembre del 1 al 26, nunca con
 * septiembre entero. Pura: recibe dos fotos (con su detalle por día) y devuelve los totales de cada una.
 */
const r2 = (x) => Math.round(x * 100) / 100;
const CAMPOS = ['ordenes', 'ventas', 'unidades', 'unidadesConCosto', 'costo', 'comision', 'envio', 'ads', 'full', 'bonificacionFlex', 'anulacionFlex', 'cadete'];

function sumarHasta(foto, dia) {
  const tope = `${foto.mes}-${String(dia).padStart(2, '0')}`;
  const t = Object.fromEntries(CAMPOS.map((k) => [k, 0]));
  let diasAds = 0;
  for (const [d, x] of Object.entries(foto.porDia ?? {})) {
    if (d > tope) continue;
    for (const k of CAMPOS) if (x[k] != null) t[k] = r2(t[k] + x[k]);
    if (x.ads != null) diasAds++;
  }
  return { ...t, ads: diasAds ? t.ads : null, diasAds, cobertura: t.unidades ? r2((t.unidadesConCosto / t.unidades) * 100) : null };
}

/** { dia, actual: { mes, desde, hasta, ...totales }, anterior: { … } } o { motivo } si no se puede comparar. */
export function compararAlCorte(actual, anterior) {
  if (!actual?.porDia || !anterior?.porDia) return { motivo: 'las fotos de PFOS no traen el detalle por día: volvé a correr «fiscalos.ps1 pfos»' };
  if (!actual.corte) return { motivo: 'el mes todavía no empezó' };
  const dia = Number(actual.corte.slice(8, 10));
  const ultimoAnterior = anterior.corte ? Number(anterior.corte.slice(8, 10)) : 0;
  const diaAnterior = Math.min(dia, ultimoAnterior);
  if (diaAnterior < dia && !anterior.mesCerrado) return { motivo: `${anterior.mes} tiene datos solo hasta el día ${ultimoAnterior}` };
  const fin = (m, d) => `${m}-${String(d).padStart(2, '0')}`;
  return {
    dia,
    actual: { mes: actual.mes, desde: `${actual.mes}-01`, hasta: fin(actual.mes, dia), ...sumarHasta(actual, dia) },
    anterior: { mes: anterior.mes, desde: `${anterior.mes}-01`, hasta: fin(anterior.mes, diaAnterior), ...sumarHasta(anterior, diaAnterior) },
  };
}
