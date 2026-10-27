// Interfaz de FiscalOS. Sin dependencias. Todo el contenido se inserta como texto (nunca HTML),
// porque incluye datos de archivos importados.

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (n == null ? '—' : `$ ${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const fecha = (iso) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso || '—');
const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nombreMes = (m) => `${NOMBRE_MES[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;

/** h('div', { class: 'x', onclick }, hijo1, 'texto', ...) — crea elementos sin innerHTML. */
function h(tag, attrs = {}, ...hijos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of hijos.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** Reemplaza el contenido de `el` (replaceChildren escribiría "null" por cada hijo vacío). */
function poner(el, ...hijos) {
  el.replaceChildren(...hijos.flat(Infinity).filter((c) => c != null && c !== false));
}

async function api(ruta, cuerpo) {
  const r = await fetch(ruta, cuerpo ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) } : {});
  const j = await r.json().catch(() => ({ error: `respuesta inválida (${r.status})` }));
  if (!r.ok) throw new Error(j.error ?? `error ${r.status}`);
  return j;
}

const NIVEL_TXT = { manual: 'cargado a mano' };
const badge = (nivel) => h('span', { class: `nivel ${nivel}` }, NIVEL_TXT[nivel] ?? nivel);
/** Celda de una cifra: importe + nivel; fuente y nota como texto chico. */
function celdaCifra(c, { conNota = true } = {}) {
  if (!c) return h('td', { class: 'num' }, '—');
  return h('td', { class: 'num', title: [c.fuente, c.nota].filter(Boolean).join(' · ') },
    c.valor == null ? '—' : fmt(c.valor), badge(c.nivel),
    conNota && c.nota && c.valor == null ? h('div', { class: 'nota' }, c.nota) : null);
}
const celdaFecha = (f) => h('td', { title: [f?.fuente, f?.nota].filter(Boolean).join(' · ') }, f?.fecha ? fecha(f.fecha) : '—', badge(f?.nivel ?? 'faltante'));

const estado = { mes: null, meses: [], panel: null, hoy: null, conceptos: {}, clases: {} };

// ---------------- pestañas y mes ----------------
for (const b of document.querySelectorAll('[data-pestana]')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('[data-pestana]')) x.classList.toggle('activa', x === b);
    for (const s of document.querySelectorAll('.pestana')) s.classList.toggle('activa', s.id === b.dataset.pestana);
  });
}
$('#mes').addEventListener('change', (e) => cargarMes(e.target.value));
$('#mes-ant').addEventListener('click', () => moverMes(1));
$('#mes-sig').addEventListener('click', () => moverMes(-1));
function moverMes(d) {
  const i = estado.meses.indexOf(estado.mes) + d;
  if (i >= 0 && i < estado.meses.length) { $('#mes').value = estado.meses[i]; cargarMes(estado.meses[i]); }
}

async function iniciar() {
  try {
    const [m, conceptos, clases] = await Promise.all([api('/api/meses'), api('/api/conceptos'), api('/api/clases-proveedor')]);
    estado.meses = m.meses; estado.hoy = m.hoy; estado.conceptos = conceptos; estado.clases = clases;
    const sel = $('#mes');
    poner(sel, ...m.meses.map((x) => h('option', { value: x }, `${nombreMes(x)}${x === m.porDefecto ? ' (mes anterior)' : ''}`)));
    const inicial = m.meses.includes(m.porDefecto) ? m.porDefecto : m.meses[0];
    sel.value = inicial;
    renderImportar();
    await cargarMes(inicial);
  } catch (e) {
    poner($('#impuestos'), h('div', { class: 'error' }, `No se pudo cargar FiscalOS: ${e.message}`));
  }
}

async function cargarMes(mes) {
  estado.mes = mes;
  for (const id of ['impuestos', 'rentabilidad', 'obligaciones']) poner($(`#${id}`), h('div', { class: 'cargando' }, `Cargando ${nombreMes(mes)}…`));
  try {
    estado.panel = await api(`/api/panel?mes=${encodeURIComponent(mes)}`);
    renderImpuestos(); renderRentabilidad(); renderObligaciones(); renderSimulador();
  } catch (e) {
    poner($('#impuestos'), h('div', { class: 'error' }, `No se pudo armar el panel de ${nombreMes(mes)}: ${e.message}`));
  }
}

// ---------------- Impuestos del mes ----------------
function claseEstado(t) {
  if (/\(vencido\)|saldo pendiente|pagado de más/.test(t)) return 'alerta';
  if (/conciliado|pagado$|sin saldo a pagar/.test(t)) return 'ok';
  if (/pendiente|declarado|estimad/.test(t)) return 'pend';
  return '';
}
function tarjeta(titulo, principal, estadoTxt, lineas) {
  return h('div', { class: 'tarjeta' },
    h('h3', {}, titulo),
    h('div', { class: 'monto' }, principal?.valor == null ? '—' : fmt(principal.valor), principal ? badge(principal.nivel) : null),
    estadoTxt ? h('span', { class: `estado ${claseEstado(estadoTxt)}` }, estadoTxt) : null,
    ...lineas.filter(Boolean).map((l) => h('div', { class: 'linea' }, l)));
}

function renderImpuestos() {
  const p = estado.panel; const { iva, iibb, ganancias, autonomos } = p;
  const principalIva = iva.declarado.valor != null ? iva.declarado : iva.estimado;
  const tarjetas = h('div', { class: 'tarjetas' },
    tarjeta(`IVA · ${nombreMes(p.mes)}`, principalIva, iva.estado, [
      iva.declarado.valor != null ? 'Saldo a pagar declarado (F.2051)' : 'Estimado (sin DJ conservada)',
      iva.vencimientoPago.fecha ? `Vence el pago: ${fecha(iva.vencimientoPago.fecha)}` : null,
      iva.presentacion.fecha ? `DJ presentada: ${iva.presentacion.fecha}` : null,
    ]),
    tarjeta('Ingresos Brutos', iibb.declarado.valor != null ? iibb.declarado : iibb.estimado, iibb.estado, [
      iibb.declarado.valor != null ? 'Declarado (CM03)' : iibb.estimado.valor != null ? 'Estimado' : 'Sin CM03: cargalo en Rentabilidad',
    ]),
    tarjeta('Ganancias', ganancias.estimado, ganancias.estado, [
      ganancias.estimado.valor != null ? 'Provisión estimada del mes' : 'Sin provisión (faltan datos)',
      ganancias.pagosEnElMes ? `Pagado en el mes: ${fmt(ganancias.pagosEnElMes.valor)} (de otro período, ver abajo)` : null,
    ]),
    tarjeta('Autónomos', autonomos.declarado, null, [autonomos.pagos.valor != null ? `Pagado en el mes: ${fmt(autonomos.pagos.valor)}` : 'Sin pagos registrados en el mes']),
  );

  // Detalle por impuesto: cada celda solo importe/fecha y nivel. Las fuentes y explicaciones van en
  // una fila desplegable (botón accesible con teclado) y en el title de la celda.
  const COLS = [['declarado', 'Declarado'], ['estimado', 'Estimado'], ['pagos', 'Pagos imputados'], ['saldoPendiente', 'Saldo pendiente']];
  const FECHAS = [['vencimientoPresentacion', 'Venc. presentación'], ['vencimientoPago', 'Venc. pago']];
  const celdaCorta = (c, rotulo) => h('td', { class: 'num', 'data-rotulo': rotulo, title: [c?.fuente, c?.nota].filter(Boolean).join(' · ') || null },
    h('span', {}, c?.valor == null ? h('span', { class: 'sin-dato' }, '—') : fmt(c.valor), badge(c?.nivel ?? 'faltante')));
  const fechaCorta = (f, rotulo) => h('td', { 'data-rotulo': rotulo, title: [f?.fuente, f?.nota].filter(Boolean).join(' · ') || null },
    h('span', {}, f?.fecha ? fecha(f.fecha) : h('span', { class: 'sin-dato' }, '—'), badge(f?.nivel ?? 'faltante')));
  const filas = [];
  [iva, iibb, ganancias].forEach((t, n) => {
    const id = `fuentes-${n}`;
    const det = h('tr', { class: 'fuentes', id, hidden: true }, h('td', { colspan: 9 }, h('dl', {},
      ...[...COLS, ...FECHAS].flatMap(([k, rot]) => {
        const c = t[k]; const txt = [c?.fuente, c?.nota].filter(Boolean).join(' — ');
        return txt ? [h('dt', {}, rot), h('dd', {}, txt)] : [];
      }),
      t.pagosEnElMes ? [h('dt', {}, 'Pagado en el mes'), h('dd', {}, `${fmt(t.pagosEnElMes.valor)} — ${t.pagosEnElMes.nota ?? ''} (no se atribuye a ${nombreMes(p.mes)})`)] : null,
      t.detalle ? [h('dt', {}, 'Estado'), h('dd', {}, t.detalle)] : null)));
    const boton = h('button', { class: 'ver-fuentes', 'aria-expanded': 'false', 'aria-controls': id, onclick: (e) => {
      const abierto = det.hidden; det.hidden = !abierto; e.currentTarget.setAttribute('aria-expanded', String(abierto)); e.currentTarget.textContent = abierto ? 'Ocultar' : 'Fuentes';
    } }, 'Fuentes');
    filas.push(h('tr', {},
      h('td', { 'data-rotulo': 'Impuesto' }, h('strong', {}, t.impuesto)),
      h('td', { 'data-rotulo': 'Estado' }, t.estado ? h('span', { class: `estado ${claseEstado(t.estado)}` }, t.estado) : '—'),
      ...COLS.map(([k, rot]) => celdaCorta(t[k], rot)),
      ...FECHAS.map(([k, rot]) => fechaCorta(t[k], rot)),
      h('td', { 'data-rotulo': 'Detalle' }, boton)), det);
  });
  const tabla = h('div', { class: 'caja' }, h('h2', {}, `Detalle por impuesto · ${nombreMes(p.mes)}`),
    h('table', { class: 'tabla-impuestos apilable' },
      h('thead', {}, h('tr', {}, ...['Impuesto', 'Estado', ...COLS.map((c) => c[1]), ...FECHAS.map((c) => c[1]), ''].map((x, i) => h('th', { class: i >= 2 && i <= 5 ? 'num' : '' }, x)))),
      h('tbody', {}, ...filas)),
    h('p', { class: 'nota' }, '"Fuentes" muestra de dónde sale cada cifra. El vencimiento de pago del IVA es el que registra Cuentas Tributarias para tu régimen.'));

  // IVA: declarado vs. comprobantes.
  const d = iva.detalle_;
  const filaD = (nombre, c) => h('tr', {}, h('td', { 'data-rotulo': '' }, nombre), celdaCorta(c, 'Importe'));
  const cd = d.composicionDebito;
  const detalle = h('div', { class: 'caja' }, h('h2', {}, `IVA: declarado vs. comprobantes`),
    h('table', {}, h('tbody', {},
      filaD('Débito fiscal declarado (DJ)', d.debitoDeclarado),
      filaD('IVA de comprobantes emitidos', d.debitoComprobantes),
      d.diferenciaDebito ? filaD('Diferencia de débito (DJ − comprobantes)', d.diferenciaDebito) : null,
      filaD('Crédito fiscal declarado (DJ)', d.creditoDeclarado),
      filaD('IVA facturado por proveedores', d.ivaProveedores),
      filaD('Retenciones y percepciones declaradas (DJ)', d.percepcionesDeclaradas),
      filaD('Percepciones de IVA sufridas (Mis Retenciones)', d.percepcionesSufridas))),
    h('h3', {}, 'Composición del débito según la DJ'),
    cd?.disponible
      ? h('table', {}, h('tbody', {}, ...cd.componentes.map((c) => h('tr', {}, h('td', {}, c.concepto), h('td', { class: 'num' }, fmt(c.importe))))))
      : h('p', { class: 'no-disponible' }, `Detalle no disponible${cd?.motivo ? `: ${cd.motivo}` : ''}.`),
    d.diferenciaDebito ? h('details', {}, h('summary', { class: 'nota' }, 'Sobre la diferencia de débito'), h('p', { class: 'nota' }, d.diferenciaDebito.nota)) : null,
    iva.avisos.length || iva.faltantes.length ? h('details', {}, h('summary', { class: 'nota' }, `Avisos y faltantes (${iva.avisos.length + iva.faltantes.length})`),
      ...iva.avisos.map((a) => h('div', { class: 'aviso' }, a)), h('ul', { class: 'lista' }, ...iva.faltantes.map((f) => h('li', {}, f)))) : null);

  // Pagos de impuestos realizados en el mes (caja), con a qué período corresponden.
  const pagos = p.pagosDelMes ?? [];
  const pagosCaja = h('div', { class: 'caja' }, h('h2', {}, `Pagos de impuestos realizados en ${nombreMes(p.mes)}`),
    h('p', { class: 'nota' }, 'Flujo de caja: lo que se pagó con fecha en el mes. Cada pago dice a qué período se imputó; un pago de otro período no es carga de este mes.'),
    pagos.length ? h('table', { class: 'apilable' },
      h('thead', {}, h('tr', {}, ...['Fecha', 'Impuesto', 'Formulario', 'Corresponde a', 'Importe'].map((x, i) => h('th', { class: i === 4 ? 'num' : '' }, x)))),
      h('tbody', {}, ...pagos.map((x) => h('tr', { title: [x.observaciones, x.fuente].filter(Boolean).join(' · ') },
        h('td', { 'data-rotulo': 'Fecha' }, fecha(x.fecha)),
        h('td', { 'data-rotulo': 'Impuesto' }, h('span', {}, x.impuesto, ' ', h('span', { class: `etiqueta ${x.clasificacion.propio ? 'propio' : ''}` }, x.clasificacion.propio === false ? 'como agente' : x.clasificacion.propio ? 'propio' : 'sin clasificar'))),
        h('td', { 'data-rotulo': 'Formulario' }, x.formulario ?? '—'),
        h('td', { 'data-rotulo': 'Corresponde a' }, h('span', {}, x.imputadoA, x.delMismoPeriodo ? ' (este mes)' : '')),
        h('td', { class: 'num', 'data-rotulo': 'Importe' }, fmt(x.importe)))))) : h('p', { class: 'no-disponible' }, 'No hay pagos con fecha en este mes en las consultas conservadas de Cuentas Tributarias.'));

  const config = !p.configuracion.contribuyente
    ? h('div', { class: 'aviso' }, 'Para estimar Ingresos Brutos, Ganancias y autónomos falta params/contribuyente.json (copiá params/contribuyente.example.json y completalo con los datos de tu contador).')
    : null;
  poner($('#impuestos'), tarjetas, config, tabla, h('div', { class: 'columnas' }, detalle, pagosCaja));
}

// ---------------- Rentabilidad ----------------
const fmtPct = (n) => (n == null ? '' : ` · ${n.toLocaleString('es-AR', { maximumFractionDigits: 1 })}%`);
const ORIGEN_TXT = { manual: 'carga manual', importado: 'archivo importado', pfos: 'PFOS', arca: 'facturas en ARCA' };
const CLASE_ESTADO = { completo: 'ok', 'con estimaciones': 'pend', parcial: 'alerta' };

/** Editor en línea de las cargas manuales de un concepto del mes: corregir, borrar, agregar. */
function editorCargas(concepto, cargas, alGuardar) {
  const fila = (c) => {
    const imp = h('input', { type: 'text', inputmode: 'decimal', value: c ? String(c.importe).replace('.', ',') : '', 'aria-label': 'Importe', placeholder: 'Importe (ej. 1.234.567,89)' });
    const fue = h('input', { type: 'text', value: c?.fuente ?? '', 'aria-label': 'Fuente', placeholder: 'De dónde sale (ej. eCom, planilla de administración)' });
    const nota = h('input', { type: 'text', value: c?.nota ?? '', 'aria-label': 'Nota', placeholder: 'Nota (opcional)' });
    const est = h('input', { type: 'checkbox', checked: !!c?.estimado, 'aria-label': 'Es una estimación' });
    const msg = h('span', { class: 'nota' });
    const guardar = async () => {
      try { await api('/api/manuales/guardar', { id: c?.id ?? null, mes: estado.mes, concepto, importe: imp.value, fuente: fue.value, nota: nota.value, estimado: est.checked }); await alGuardar(); }
      catch (e) { msg.textContent = e.message; msg.className = 'error'; }
    };
    const borrar = c ? h('button', { onclick: async () => { if (!confirm('¿Borrar esta carga?')) return; try { await api('/api/manuales/eliminar', { id: c.id }); await alGuardar(); } catch (e) { msg.textContent = e.message; } } }, 'Borrar') : null;
    return h('div', { class: 'carga' }, imp, fue, nota, h('label', { class: 'nota estimacion' }, est, ' es una estimación'), h('button', { class: 'primario', onclick: guardar }, c ? 'Guardar corrección' : 'Agregar'), borrar, msg,
      c?.historial?.length ? h('div', { class: 'nota' }, `Valores anteriores: ${c.historial.map((x) => fmt(x.importe)).join(' · ')}`) : null);
  };
  return h('div', { class: 'editor' },
    h('div', { class: 'nota' }, cargas.length ? 'Cargas de este mes (se suman entre sí; reemplazan a las otras fuentes de este concepto):' : 'Cargá el importe del mes. Reemplaza a las otras fuentes de este concepto (no se suma a ellas).'),
    ...cargas.map(fila), fila(null));
}

function renderRentabilidad() {
  const p = estado.panel; const r = p.rentabilidad;
  const recargar = () => cargarMes(estado.mes);
  const filas = [];
  const linea = (l, { editable = null } = {}) => {
    const conc = editable ?? (estado.conceptos[l.clave] ? l.clave : null);
    const cargas = conc ? p.manuales.filter((c) => c.concepto === conc) : [];
    const id = `ed-${conc ?? l.clave}`;
    const editor = conc ? h('tr', { class: 'fuentes', id, hidden: true }, h('td', { colspan: 4 }, editorCargas(conc, cargas, recargar))) : null;
    const boton = conc ? h('button', { class: 'ver-fuentes', 'aria-expanded': 'false', 'aria-controls': id, onclick: (e) => {
      const abrir = editor.hidden; editor.hidden = !abrir; e.currentTarget.setAttribute('aria-expanded', String(abrir));
    } }, cargas.length ? `Corregir (${cargas.length})` : 'Cargar') : null;
    const alt = (l.alternativas ?? []).filter((a) => a.valor != null);
    filas.push(h('tr', {},
      h('td', { 'data-rotulo': 'Concepto' }, `${l.signo < 0 ? '− ' : ''}${l.nombre}`),
      h('td', { class: 'num', 'data-rotulo': 'Importe', title: [l.cifra.fuente, l.cifra.nota].filter(Boolean).join(' · ') || null },
        h('span', {}, l.cifra.valor == null ? h('span', { class: 'sin-dato' }, '—') : fmt(l.cifra.valor), badge(l.cifra.nivel))),
      h('td', { 'data-rotulo': 'Fuente' }, h('span', { class: 'nota' }, l.cifra.valor == null ? (l.cifra.nota ?? '') : (l.cifra.fuente ?? ''),
        alt.length ? h('span', { class: 'alternativa', title: alt.map((a) => a.nota).filter(Boolean).join(' · ') || null }, ` · también: ${alt.map((a) => `${ORIGEN_TXT[a.origen] ?? a.origen}${a.referencia ? ' (incompleto)' : ''} ${fmt(a.valor)}`).join(', ')} (no se suma)`) : null)),
      h('td', { 'data-rotulo': '' }, boton)), editor);
  };
  const sub = (s, extra = '') => filas.push(h('tr', { class: 'total' },
    h('td', { 'data-rotulo': '' }, `= ${s.nombre}${extra}`),
    h('td', { class: 'num', 'data-rotulo': 'Importe' }, s.valor == null ? '—' : fmt(s.valor)),
    h('td', { 'data-rotulo': 'Estado', colspan: 2 }, h('span', { class: `estado ${CLASE_ESTADO[s.estado] ?? ''}` }, s.estado), s.faltan.length ? h('span', { class: 'nota' }, ` falta: ${s.faltan.join(', ')}`) : null)));

  const L = Object.fromEntries(r.lineas.map((l) => [l.clave, l]));
  linea({ ...r.ventas, signo: 1 });
  if (L['otros-ingresos'].cifra.valor != null) linea(L['otros-ingresos']);
  linea(L['costo-mercaderia']);
  sub(r.margen, fmtPct(r.margenPct));
  for (const k of ['comisiones-ml', 'publicidad', 'logistica', 'gastos-operativos']) linea(L[k]);
  sub(r.operativo);
  linea(r.iibb, { editable: 'iibb-declarado' });
  linea(r.autonomos);
  sub(r.antesGanancias);
  linea(r.ganancias);
  const parcial = r.neto.estado === 'parcial';
  sub({ ...r.neto, nombre: parcial ? 'Resultado parcial (no es la rentabilidad neta)' : 'Resultado neto estimado' });

  const encabezado = h('div', { class: 'resumen-rent' },
    h('div', {}, h('div', { class: 'nota' }, r.provisional ? 'Ventas de ML netas (provisorio)' : 'Facturación neta'), h('div', { class: 'monto' }, fmt(r.ventas.cifra.valor))),
    h('div', {}, h('div', { class: 'nota' }, `Margen bruto${fmtPct(r.margenPct)}`), h('div', { class: 'monto' }, r.margen.estado === 'parcial' ? '—' : fmt(r.margen.valor))),
    h('div', {}, h('div', { class: 'nota' }, 'Resultado operativo'), h('div', { class: 'monto' }, r.operativo.estado === 'parcial' ? '—' : fmt(r.operativo.valor))),
    h('div', {}, h('div', { class: 'nota' }, parcial ? 'Resultado neto' : 'Resultado neto estimado'), h('div', { class: 'monto' }, parcial ? '—' : fmt(r.neto.valor)),
      h('span', { class: `estado ${CLASE_ESTADO[r.neto.estado]}` }, parcial ? 'faltan datos' : r.neto.estado)));

  const bloqueResultado = h('div', { class: 'caja' }, h('h2', {}, `1. Resultado económico de ${nombreMes(p.mes)}${r.provisional ? ' (provisorio)' : ''}`),
    r.provisional ? h('div', { class: 'aviso' }, r.provisional.nota) : null, encabezado,
    h('table', { class: 'apilable tabla-resultado' }, h('thead', {}, h('tr', {}, h('th', {}, 'Concepto'), h('th', { class: 'num' }, 'Importe'), h('th', {}, 'Fuente'), h('th', {}, ''))), h('tbody', {}, ...filas)),
    h('div', { class: 'aviso' }, r.nota),
    r.referencia.comprasMercaderia ? h('p', { class: 'nota' }, `Compras de mercadería del mes (ARCA): ${fmt(r.referencia.comprasMercaderia.valor)} — van a stock; no son el costo de lo vendido y no se restan.`) : null,
    r.referencia.ventasMercadoLibre ? h('p', { class: 'nota' }, `Ventas de Mercado Libre: ${fmt(r.referencia.ventasMercadoLibre.valor)} — ya están dentro de la facturación; no se suman.`) : null,
    r.avisos.length ? h('details', { open: true }, h('summary', { class: 'nota' }, `Revisar (${r.avisos.length})`), ...r.avisos.map((a) => h('div', { class: 'aviso' }, a))) : null);

  const imp = r.impuestos;
  const bloqueImpuestos = h('div', { class: 'caja' }, h('h2', {}, `2. Impuestos que generó ${nombreMes(p.mes)}`),
    h('table', { class: 'apilable' }, h('thead', {}, h('tr', {}, ...['Impuesto', 'Importe', 'Tratamiento', 'Vence'].map((x, i) => h('th', { class: i === 1 ? 'num' : '' }, x)))),
      h('tbody', {}, ...imp.filas.map((f) => h('tr', {},
        h('td', { 'data-rotulo': 'Impuesto' }, f.impuesto),
        h('td', { class: 'num', 'data-rotulo': 'Importe', title: [f.cifra.fuente, f.cifra.nota].filter(Boolean).join(' · ') || null }, h('span', {}, f.cifra.valor == null ? '—' : fmt(f.cifra.valor), badge(f.cifra.nivel))),
        h('td', { 'data-rotulo': 'Tratamiento' }, h('span', { class: 'nota' }, f.tratamiento)),
        h('td', { 'data-rotulo': 'Vence' }, f.vence ? fecha(f.vence) : '—'))))),
    h('p', {}, h('strong', {}, 'Carga fiscal atribuible (sin IVA): '), imp.cargaAtribuible.valor == null ? '—' : fmt(imp.cargaAtribuible.valor), badge(imp.cargaAtribuible.nivel),
      imp.cargaPct != null ? h('span', { class: 'nota' }, ` ${imp.cargaPct.toLocaleString('es-AR')}% de la facturación${imp.cargaAtribuible.nota ? ` (${imp.cargaAtribuible.nota})` : ''}`) : null));

  const pg = r.pagos;
  const formPago = (() => {
    const conc = h('select', { 'aria-label': 'Impuesto pagado' }, ...['iibb-pagado', 'ganancias-anticipo', 'autonomos'].map((k) => h('option', { value: k }, estado.conceptos[k]?.nombre ?? k)));
    const cont = h('div');
    const abrir = h('button', { class: 'ver-fuentes', onclick: () => { poner(cont, h('div', { class: 'editor' }, h('label', { class: 'nota' }, 'Impuesto ', conc), editorCargas(conc.value, [], recargar))); conc.onchange = () => abrir.click(); } }, 'Cargar un pago que no está en ARCA');
    return h('div', {}, abrir, cont);
  })();
  const bloquePagos = h('div', { class: 'caja' }, h('h2', {}, `3. Pagos de impuestos que salieron de caja en ${nombreMes(p.mes)}`),
    h('p', { class: 'nota' }, 'Cualquier período: cada pago dice a qué corresponde. No es la carga del mes.'),
    pg.filas.length ? h('table', { class: 'apilable' }, h('thead', {}, h('tr', {}, ...['Fecha', 'Impuesto', 'Corresponde a', 'Importe'].map((x, i) => h('th', { class: i === 3 ? 'num' : '' }, x)))),
      h('tbody', {}, ...pg.filas.map((f) => h('tr', {},
        h('td', { 'data-rotulo': 'Fecha' }, f.fecha ? fecha(f.fecha) : '—'),
        h('td', { 'data-rotulo': 'Impuesto' }, h('span', {}, f.impuesto, ' ', h('span', { class: `etiqueta ${f.propio ? 'propio' : ''}` }, f.propio === false ? 'como agente' : 'propio'), f.posibleDuplicado ? h('span', { class: 'etiqueta' }, '¿duplicado con ARCA?') : null)),
        h('td', { 'data-rotulo': 'Corresponde a' }, f.corresponde),
        h('td', { class: 'num', 'data-rotulo': 'Importe' }, h('span', {}, fmt(f.importe), badge(f.nivel))))))) : h('p', { class: 'no-disponible' }, 'Sin pagos de impuestos con fecha en este mes.'),
    h('p', {}, h('strong', {}, 'Impuestos propios pagados: '), fmt(pg.propios), pg.comoAgente ? h('span', { class: 'nota' }, ` · retenciones depositadas como agente: ${fmt(pg.comoAgente)} (dinero de terceros)`) : null),
    formPago);

  const bloqueObligaciones = h('div', { class: 'caja' }, h('h2', {}, `4. Lo que ${nombreMes(p.mes)} deja para pagar más adelante`),
    h('table', { class: 'apilable' }, h('tbody', {}, ...r.obligaciones.map((o) => h('tr', {},
      h('td', { 'data-rotulo': 'Impuesto' }, o.impuesto),
      h('td', { class: 'num', 'data-rotulo': 'Importe' }, h('span', {}, o.cifra.valor == null ? '—' : fmt(o.cifra.valor), badge(o.cifra.nivel))),
      h('td', { 'data-rotulo': 'Vence' }, o.vence ? fecha(o.vence) : '—'),
      h('td', { 'data-rotulo': '' }, h('span', { class: 'nota' }, o.nota ?? '')))))));

  const sinClasificar = r.proveedores.filter((x) => !x.clase);
  const bloqueProveedores = h('div', { class: 'caja' }, h('details', { open: sinClasificar.length > 0 },
    h('summary', {}, h('strong', {}, `Proveedores de ${nombreMes(p.mes)} (facturas recibidas en ARCA)`), sinClasificar.length ? h('span', { class: 'nota' }, ` · ${sinClasificar.length} sin clasificar`) : h('span', { class: 'nota' }, ' · todos clasificados')),
    h('p', { class: 'nota' }, 'Clasificá cada proveedor una sola vez: se recuerda para todos los meses. Así los gastos con factura salen de ARCA sin preparar planillas. La mercadería va a stock y no se resta.'),
    r.proveedores.length ? h('table', { class: 'apilable' }, h('thead', {}, h('tr', {}, ...['Proveedor', 'Comprobantes', 'Neto', 'Clasificación'].map((x, i) => h('th', { class: i === 2 ? 'num' : '' }, x)))),
      h('tbody', {}, ...r.proveedores.map((x) => {
        const sel = h('select', { 'aria-label': `Clasificación de ${x.nombre}` }, h('option', { value: '' }, x.sugerida ? `— sin clasificar (sugerido: ${estado.clases[x.sugerida]?.nombre}) —` : '— sin clasificar —'),
          ...Object.entries(estado.clases).map(([k, c]) => h('option', { value: k }, c.nombre)));
        sel.value = x.clase ?? '';
        sel.addEventListener('change', async () => { try { await api('/api/proveedores/clasificar', { clave: x.clave, nombre: x.nombre, clase: sel.value }); await recargar(); } catch (e) { alert(e.message); } });
        return h('tr', {}, h('td', { 'data-rotulo': 'Proveedor' }, x.nombre), h('td', { class: 'num', 'data-rotulo': 'Comprobantes' }, String(x.comprobantes)),
          h('td', { class: 'num', 'data-rotulo': 'Neto' }, fmt(x.neto)), h('td', { 'data-rotulo': 'Clasificación' }, sel));
      }))) : h('p', { class: 'no-disponible' }, 'No hay comprobantes recibidos conservados para este mes.')));

  const bloqueFaltantes = r.faltantes.length ? h('div', { class: 'caja' }, h('h2', {}, 'Qué falta y de dónde sale'),
    h('ul', { class: 'lista' }, ...r.faltantes.map((f) => h('li', {}, h('strong', {}, f.dato), `: ${f.como}`)))) : null;

  const comparacion = h('div', { class: 'caja', id: 'comparacion' }, h('h2', {}, 'Comparación de meses'), h('div', { class: 'cargando' }, 'Cargando…'));
  poner($('#rentabilidad'), comparacion, bloqueResultado, h('div', { class: 'columnas' }, bloqueImpuestos, bloquePagos), h('div', { class: 'columnas' }, bloqueObligaciones, bloqueFaltantes),
    bloquePfos(p), bloqueProveedores);
  renderComparacion(comparacion);
}

const ESTADO_TXT = { completo: 'completo', 'con estimaciones': 'con estimaciones', parcial: 'parcial', faltante: 'falta' };
const chipEstado = (e) => h('span', { class: `estado ${CLASE_ESTADO[e] ?? ''}` }, ESTADO_TXT[e] ?? e);

/** Comparación del mes elegido con el anterior disponible, con el estado de cada cifra. */
async function renderComparacion(cont) {
  const i = estado.meses.indexOf(estado.mes);
  // El mes elegido contra el anterior (o, si no hay anterior, contra el siguiente).
  const meses = (estado.meses[i + 1] ? [estado.meses[i + 1], estado.mes] : [estado.mes, estado.meses[i - 1]]).filter(Boolean).sort();
  if (meses.length < 2) { poner(cont, h('h2', {}, 'Comparación de meses'), h('p', { class: 'no-disponible' }, 'Hace falta más de un mes con datos para comparar.')); return; }
  try {
    const c = await api(`/api/comparacion?meses=${encodeURIComponent(meses.join(','))}`);
    const filas = [
      ['Facturación neta', 'facturacion'], ['Costo de la mercadería vendida', 'costo'], ['Margen bruto', 'margen'], ['Gastos (ML, publicidad, logística, operativos)', 'gastos'],
      ['Impuestos atribuibles (IIBB, autónomos, Ganancias)', 'impuestos'], ['Resultado neto', 'resultado'], ['IVA del mes (no es costo)', 'iva'], ['Impuestos pagados en el mes (caja)', 'pagosImpuestos'],
    ];
    const celda = (x, k) => {
      const v = x[k];
      const extra = k === 'margen' && v.pct != null ? ` (${v.pct.toLocaleString('es-AR')}%)` : '';
      const parcial = k === 'resultado' && v.valor == null && v.parcial != null ? h('div', { class: 'nota' }, `parcial: ${fmt(v.parcial)}`) : null;
      const nota = [k === 'costo' && x.costoFuente ? `fuente: ${ORIGEN_TXT[x.costoFuente] ?? x.costoFuente}` : null, v.faltan?.length ? `falta: ${v.faltan.join(', ')}` : null].filter(Boolean).join(' · ');
      return h('td', { class: 'num', 'data-rotulo': nombreMes(x.mes), title: nota || null }, h('span', {}, v.valor == null ? '—' : `${fmt(v.valor)}${extra}`, ' ', chipEstado(v.estado)), parcial);
    };
    const variacion = (k) => {
      if (c.columnas.slice(-2).some((x) => x.provisional)) return h('td', { class: 'num', 'data-rotulo': 'Variación', title: 'un mes provisorio (al corte) no se compara con uno entero' }, '—');
      const [a, b] = c.columnas.slice(-2).map((x) => x[k]);
      if (a?.valor == null || b?.valor == null || !a.valor) return h('td', { class: 'num', 'data-rotulo': 'Variación' }, '—');
      const pctv = ((b.valor - a.valor) / Math.abs(a.valor)) * 100;
      const dudosa = [a, b].some((x) => x.estado !== 'completo');
      return h('td', { class: 'num', 'data-rotulo': 'Variación', title: dudosa ? 'alguno de los dos meses es parcial o tiene estimaciones' : null },
        `${pctv >= 0 ? '+' : ''}${pctv.toLocaleString('es-AR', { maximumFractionDigits: 1 })}%${dudosa ? ' *' : ''}`);
    };
    poner(cont, h('h2', {}, 'Comparación de meses'),
      h('table', { class: 'apilable' }, h('thead', {}, h('tr', {}, h('th', {}, ''), ...c.columnas.map((x) => h('th', { class: 'num' }, nombreMes(x.mes))), h('th', { class: 'num' }, 'Variación'))),
        h('tbody', {}, ...filas.map(([nombre, k]) => h('tr', {}, h('td', { 'data-rotulo': '' }, h('strong', {}, nombre)), ...c.columnas.map((x) => celda(x, k)), variacion(k))))),
      h('p', { class: 'nota' }, '* La variación compara meses donde alguna cifra es parcial o estimada: tomala como orientación, no como dato. Pasá el mouse para ver la fuente y lo que falta.'),
      h('p', { class: 'nota' }, `PFOS: ${c.columnas.map((x) => `${nombreMes(x.mes)} ${x.pfos}`).join(' · ')}`),
      c.columnas.some((x) => x.provisional) ? h('p', { class: 'nota' }, `${c.columnas.filter((x) => x.provisional).map((x) => `${nombreMes(x.mes)}: ${x.provisional}`).join(' · ')}. Un mes incompleto no se compara con uno entero: para los mismos días de cada mes, mirá «Comparación al corte» en el bloque de PFOS.`) : null);
  } catch (e) { poner(cont, h('h2', {}, 'Comparación de meses'), h('div', { class: 'error' }, e.message)); }
}

/** Datos de PFOS del mes: titularidad de la cuenta, conciliación fiscal, cobertura al corte, lo que falta y la comparación. */
function bloquePfos(p) {
  const x = p.integraciones.pfos;
  if (!x.conectado) return h('div', { class: 'caja' }, h('h2', {}, 'PFOS (Mercado Libre)'), h('p', { class: 'no-disponible' }, x.nota));
  const cob = x.cobertura;
  const corte = x.mesCerrado === false && x.corte ? ` (al corte del ${fecha(x.corte)})` : '';
  const esperados = (c) => c.diasEsperados ?? c.diasMes;
  const rep = (r) => (r.estado === 'completa' ? 'completo' : r.estado === 'desconocida' ? `cobertura sin validar en PFOS (${r.sinValidar} archivo/s): no se da por completo`
    : r.estado === 'parcial'
    ? `parcial (${r.rangos.map((g) => `${fecha(g.desde)}–${fecha(g.hasta)}`).join(', ')}${r.faltaDesde ? `; falta desde el ${fecha(r.faltaDesde)}` : ''}${r.descartadas ? '; con filas descartadas' : ''})` : 'sin reporte del mes en «Conciliación»');
  const motivos = Object.entries(x.costo.motivos ?? {}).sort((a, b) => b[1] - a[1]);
  const reglas = Object.entries(x.costo.porRegla ?? {}).sort((a, b) => b[1] - a[1]);
  const filas = [
    ['Ventas (órdenes)', `${cob.ordenes.dias} de ${esperados(cob.ordenes)} días completos en PFOS${corte} · ${x.ventas.ordenes} órdenes, ${x.ventas.unidades} unidades`],
    ['Cobros de Mercado Pago', `${cob.cobrosDeVentas ?? '—'}% de las ventas con su cobro`],
    ['Costo de la mercadería', `${x.costo.unidadesConCosto} de ${x.costo.unidades} unidades con costo (${x.costo.cobertura ?? '—'}%)${x.costo.unidadesListaPosterior ? ` · ${x.costo.unidadesListaPosterior} con la lista posterior a la venta` : ''}${x.costo.unidadesParaRevision ? ` · ${x.costo.unidadesParaRevision} para revisión` : ''}${x.costo.faltante?.unidades ? ` · lo sin costo, ${x.costo.faltante.estimado == null ? 'sin poder estimar' : `estimado en ${fmt(x.costo.faltante.estimado)} (sus ventas × la relación costo/venta de lo costeado)`}` : ''}`],
    ['Publicidad (Mercado Ads)', cob.ads.dias ? `${cob.ads.dias} de ${esperados(cob.ads)} días${corte}` : 'sin datos (no es cero): la vista de Ads no devolvió días del mes'],
    ['Flex: bonificaciones', rep(cob.reportes.flexBonif)], ['Flex: anulaciones', rep(cob.reportes.flexAnul)], ['Flex: viajes de Luma', rep(cob.reportes.luma)], ['Full', rep(cob.reportes.full)],
  ];
  const chip = x.verificada ? ['ok', 'cuenta verificada por CAE'] : x.provisoria ? ['pend', `cuenta verificada en ${nombreMes(x.titularidad.mesVerificado)}: datos provisorios`] : ['alerta', 'cuenta NO verificada: no se usan sus datos'];
  const conc = x.conciliacionFiscal ?? { estado: x.verificada ? 'conciliada' : 'pendiente', motivo: x.cuenta?.motivo };
  const cmp = x.comparacion;
  const pesosCmp = (v) => (v == null ? 'sin datos' : fmt(v));
  const tablaCmp = cmp && !cmp.motivo ? [h('h3', {}, `Comparación al corte: del 1 al ${cmp.dia} de cada mes`),
    h('table', { class: 'apilable' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { class: 'num' }, `${fecha(cmp.anterior.desde)}–${fecha(cmp.anterior.hasta)}`), h('th', { class: 'num' }, `${fecha(cmp.actual.desde)}–${fecha(cmp.actual.hasta)}`))),
      h('tbody', {}, ...[['Órdenes', 'ordenes', String], ['Ventas con IVA', 'ventas', fmt], ['Unidades', 'unidades', String], ['Costo de lo vendido (unidades con costo)', 'costo', fmt],
        ['Comisiones y cargos de ML (con IVA)', 'comision', fmt], ['Envíos a cargo del vendedor (con IVA)', 'envio', fmt], ['Publicidad', 'ads', pesosCmp]].map(([n, k, f]) => h('tr', {},
        h('td', { 'data-rotulo': '' }, n), h('td', { class: 'num', 'data-rotulo': nombreMes(cmp.anterior.mes) }, f(cmp.anterior[k])), h('td', { class: 'num', 'data-rotulo': nombreMes(cmp.actual.mes) }, f(cmp.actual[k])))))),
    h('p', { class: 'nota' }, `Mismos días de cada mes. Costo con ${cmp.anterior.cobertura ?? '—'}% y ${cmp.actual.cobertura ?? '—'}% de las unidades con costo. Full, Flex y Luma no entran: llegan por reportes mensuales.`)]
    : cmp?.motivo ? h('p', { class: 'nota' }, `Comparación al corte: ${cmp.motivo}.`) : null;
  return h('div', { class: 'caja' }, h('details', { open: !x.verificada },
    h('summary', {}, h('strong', {}, 'PFOS (Mercado Libre, solo la cuenta de tu CUIT)'), h('span', { class: 'nota' }, ` · datos del ${fecha(String(x.generado).slice(0, 10))}${corte} · `),
      h('span', { class: `estado ${chip[0]}` }, chip[1])),
    h('p', { class: 'nota' }, x.titularidad?.motivo ?? x.cuenta?.motivo ?? ''),
    h('p', {}, h('strong', {}, 'Conciliación fiscal del mes: '), h('span', { class: `estado ${conc.estado === 'conciliada' ? 'ok' : conc.estado === 'pendiente' ? 'pend' : 'alerta'}` }, conc.estado),
      conc.estado !== 'conciliada' ? h('span', { class: 'nota' }, ` · ${conc.motivo ?? ''}`) : null),
    h('table', { class: 'apilable' }, h('tbody', {}, ...filas.map(([k, v]) => h('tr', {}, h('td', { 'data-rotulo': '' }, k), h('td', { 'data-rotulo': '' }, v))))),
    tablaCmp,
    reglas.length ? h('p', { class: 'nota' }, `Reglas de PFOS aplicadas (unidades): ${reglas.map(([k, n]) => `${k} ${n}`).join(' · ')}`) : null,
    motivos.length ? [h('h3', {}, 'Unidades sin costo, por motivo'), h('p', { class: 'nota' }, motivos.map(([k, n]) => `${k}: ${n} u.`).join(' · '))] : null,
    x.costo.sinCosto?.length ? [h('h3', {}, 'SKU sin costo (los «para revisión» se resuelven confirmándolos en PFOS → Costos de la mercadería)'),
      h('ul', { class: 'lista' }, ...x.costo.sinCosto.slice(0, 20).map((s) => h('li', {}, `${s.sku}: ${s.unidades} u. — ${s.revision ? 'para revisión: ' : ''}${s.motivo}`)))] : null,
    h('p', { class: 'nota' }, `Retenciones de Mercado Pago en los cobros del mes: ${fmt(x.retencionesMp.importe)} (anticipos de impuestos, no costo).`)));
}

// ---------------- Obligaciones ----------------
function renderObligaciones() {
  const obs = estado.panel.obligaciones;
  const soloPend = h('input', { type: 'checkbox', id: 'solo-pend', checked: true });
  const cuerpo = h('tbody');
  const pintar = () => {
    const xs = obs.filter((o) => !soloPend.checked || o.tipo === 'deuda' || o.estado === 'por vencer');
    poner(cuerpo, ...(xs.length ? xs.map((o) => h('tr', {},
      h('td', {}, o.vencimiento ? fecha(o.vencimiento) : '—'), h('td', {}, o.impuesto), h('td', {}, o.concepto), h('td', {}, o.periodo),
      h('td', {}, o.tipo === 'deuda' ? 'Deuda registrada' : 'Vencimiento'), h('td', { class: 'num' }, o.saldo == null ? '—' : fmt(o.saldo)),
      h('td', {}, h('span', { class: `estado ${o.estado === 'vencido' ? 'alerta' : 'pend'}` }, o.estado)))) : [h('tr', {}, h('td', { colspan: 7 }, 'Sin obligaciones registradas.'))]));
  };
  soloPend.addEventListener('change', pintar);
  pintar();
  const consultado = obs[0]?.consultado;
  poner($('#obligaciones'), h('div', { class: 'caja' },
    h('h2', {}, 'Obligaciones registradas en Cuentas Tributarias'),
    h('p', { class: 'nota' }, consultado ? `Según la última consulta conservada (${consultado}). Son de todos los impuestos, no solo del mes elegido.` : 'No hay consultas de Cuentas Tributarias conservadas.'),
    h('label', { class: 'nota' }, soloPend, ' Solo deudas y vencimientos futuros'),
    h('table', {}, h('thead', {}, h('tr', {}, ...['Vence', 'Impuesto', 'Concepto', 'Período', 'Tipo', 'Saldo', 'Estado'].map((x, i) => h('th', { class: i === 5 ? 'num' : '' }, x)))), cuerpo)));
}

// ---------------- Importar ----------------
const imp = { archivo: null, previa: null };
function renderImportar() {
  const entrada = h('input', { type: 'file', accept: '.csv,.txt,.tsv,.xlsx', id: 'archivo', hidden: true });
  const zona = h('div', { class: 'soltar' }, 'Arrastrá acá un CSV o Excel (.xlsx), o ', h('button', { onclick: () => entrada.click() }, 'elegí un archivo'),
    h('div', { class: 'nota' }, 'Por ejemplo: el reporte mensual de ventas o de cargos de Mercado Libre, tus gastos, el costo de la mercadería vendida, la DJ de Ingresos Brutos.'));
  zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('encima'); });
  zona.addEventListener('dragleave', () => zona.classList.remove('encima'));
  zona.addEventListener('drop', (e) => { e.preventDefault(); zona.classList.remove('encima'); if (e.dataTransfer.files[0]) subir(e.dataTransfer.files[0]); });
  entrada.addEventListener('change', () => entrada.files[0] && subir(entrada.files[0]));
  poner($('#importar'), 
    h('div', { class: 'caja' }, h('h2', {}, 'Importar archivo'), zona, entrada, h('div', { id: 'imp-trabajo' })),
    h('div', { class: 'caja' }, h('h2', {}, 'Importaciones hechas'), h('div', { id: 'imp-lista' }, 'Cargando…')));
  listarImportaciones();
}

async function subir(file) {
  const trabajo = $('#imp-trabajo');
  poner(trabajo, h('div', { class: 'cargando' }, `Leyendo ${file.name}…`));
  try {
    const b64 = await new Promise((ok, mal) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => mal(r.error); r.readAsDataURL(file); });
    imp.previa = await api('/api/importar/analizar', { nombre: file.name, contenido: b64 });
    renderPrevia();
  } catch (e) { poner(trabajo, h('div', { class: 'error' }, e.message)); }
}

function renderPrevia() {
  const p = imp.previa; const trabajo = $('#imp-trabajo');
  const opcionesCol = (vacio) => [vacio ? h('option', { value: '' }, vacio) : null, ...p.encabezados.map((x, i) => h('option', { value: String(i) }, x))];
  const sel = (id, opciones, valor) => { const s = h('select', { id }, ...opciones); s.value = valor ?? ''; return s; };
  const hoja = sel('imp-hoja', p.hojas.map((x, i) => h('option', { value: String(i) }, x)), String(p.hoja));
  const filaEnc = h('input', { type: 'number', id: 'imp-fila', min: '1', value: String(p.filaEncabezado + 1) });
  const concepto = sel('imp-concepto', [h('option', { value: '' }, '— elegí —'), ...Object.entries(estado.conceptos).map(([k, c]) => h('option', { value: k }, c.nombre))], imp.concepto ?? '');
  const colFecha = sel('imp-fecha', opcionesCol('— todo el archivo es de un mes —'), p.sugeridas.colFecha >= 0 ? String(p.sugeridas.colFecha) : '');
  const mesFijo = h('input', { type: 'month', id: 'imp-mesfijo', value: estado.mes ?? '' });
  const colImporte = sel('imp-importe', opcionesCol('— elegí —'), p.sugeridas.colImporte >= 0 ? String(p.sugeridas.colImporte) : '');
  const colDesc = sel('imp-desc', opcionesCol('— ninguna —'), p.sugeridas.colDescripcion >= 0 ? String(p.sugeridas.colDescripcion) : '');
  const conIva = h('input', { type: 'checkbox', id: 'imp-iva' });
  const resumen = h('div', { id: 'imp-resumen' });
  const confirmar = h('button', { class: 'primario', disabled: true, onclick: () => confirmarImp() }, 'Confirmar importación');
  const releer = async () => {
    try { imp.previa = await api('/api/importar/vista', { hash: p.hash, hoja: Number(hoja.value), filaEncabezado: Number(filaEnc.value) - 1 }); imp.concepto = concepto.value; renderPrevia(); }
    catch (e) { poner(resumen, h('div', { class: 'error' }, e.message)); }
  };
  hoja.addEventListener('change', releer); filaEnc.addEventListener('change', releer);
  for (const x of [concepto, colFecha, mesFijo, colImporte, colDesc]) x.addEventListener('change', () => simular());
  imp.mapeo = () => ({ hash: p.hash, concepto: concepto.value, hoja: Number(hoja.value), filaEncabezado: Number(filaEnc.value) - 1,
    colFecha: colFecha.value, mesFijo: colFecha.value === '' ? mesFijo.value : null, colImporte: colImporte.value, colDescripcion: colDesc.value, incluyeIva: conIva.checked });
  imp.ui = { resumen, confirmar, mesFijo, colFecha };

  poner(trabajo, 
    h('h3', {}, `Archivo: ${p.nombre} · ${p.totalFilas} filas de datos`),
    p.yaImportado ? h('div', { class: 'error' }, `Este archivo ya se importó el ${fecha(p.yaImportado.cuando)} como "${estado.conceptos[p.yaImportado.concepto]?.nombre ?? p.yaImportado.concepto}". No se puede importar dos veces.`) : null,
    h('div', { class: 'previa' }, h('table', {},
      h('thead', {}, h('tr', {}, ...p.encabezados.map((x) => h('th', {}, x)))),
      h('tbody', {}, ...p.filas.map((f) => h('tr', {}, ...p.encabezados.map((_, i) => h('td', {}, f[i] ?? ''))))))),
    h('div', { class: 'grilla-form' },
      h('label', {}, 'Hoja', hoja), h('label', {}, 'Fila de encabezado', filaEnc),
      h('label', {}, '¿Qué representa el archivo?', concepto),
      h('label', {}, 'Columna de fecha o período', colFecha), h('label', {}, 'Mes (si todo el archivo es de un mes)', mesFijo),
      h('label', {}, 'Columna de importe', colImporte), h('label', {}, 'Columna de descripción (opcional)', colDesc),
      h('label', { class: 'check' }, conIva, 'Los importes incluyen IVA')),
    resumen,
    h('div', { class: 'fila-acciones' }, confirmar, h('button', { onclick: () => { imp.previa = null; poner($('#imp-trabajo'), ); } }, 'Cancelar')));
  simular();
}

async function simular() {
  const { resumen, confirmar, mesFijo, colFecha } = imp.ui;
  mesFijo.disabled = colFecha.value !== '';
  const m = imp.mapeo();
  confirmar.disabled = true;
  if (!m.concepto || m.colImporte === '') { poner(resumen, h('p', { class: 'nota' }, 'Elegí qué representa el archivo y la columna del importe para ver qué se incorporaría.')); return; }
  try {
    const s = await api('/api/importar/simular', m);
    const meses = Object.entries(s.porMes).sort();
    poner(resumen, 
      h('div', { class: s.nuevas ? 'exito' : 'aviso' }, `${s.nuevas} fila(s) nuevas para "${s.conceptoNombre}" · ${s.duplicadas} ya importadas antes (se omiten) · ${s.repetidasEnArchivo} repetidas dentro del archivo · ${s.descartadas} descartadas`),
      s.ejemplosDescartadas.length ? h('ul', { class: 'lista' }, ...s.ejemplosDescartadas.map((d) => h('li', {}, `fila ${d.fila}: ${d.motivo}`))) : null,
      meses.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Mes'), h('th', { class: 'num' }, 'Filas'), h('th', { class: 'num' }, 'Total'))),
        h('tbody', {}, ...meses.map(([mes, v]) => h('tr', {}, h('td', {}, nombreMes(mes)), h('td', { class: 'num' }, String(v.filas)), h('td', { class: 'num' }, fmt(v.importe)))))) : null,
      h('p', { class: 'nota' }, `Separador decimal detectado: ${s.comaDecimal ? 'coma (1.234,56)' : 'punto (1234.56)'}. Revisá que los totales coincidan con el reporte antes de confirmar.`));
    confirmar.disabled = !s.nuevas || !!s.yaImportado;
  } catch (e) { poner(resumen, h('div', { class: 'error' }, e.message)); }
}

async function confirmarImp() {
  try {
    const r = await api('/api/importar/confirmar', imp.mapeo());
    poner($('#imp-trabajo'), h('div', { class: 'exito' }, `Importado "${r.archivo}": ${r.filas} fila(s) en ${Object.keys(r.porMes).length} mes(es).`));
    imp.previa = null;
    await listarImportaciones();
    await refrescarMeses();
  } catch (e) { imp.ui.resumen.append(h('div', { class: 'error' }, e.message)); }
}

async function listarImportaciones() {
  const cont = $('#imp-lista');
  try {
    const xs = await api('/api/importaciones');
    if (!xs.length) { poner(cont, h('p', { class: 'nota' }, 'Todavía no importaste archivos.')); return; }
    poner(cont, h('table', {}, h('thead', {}, h('tr', {}, ...['Fecha', 'Archivo', 'Concepto', 'Meses', 'Filas', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, ...xs.slice().reverse().map((i) => h('tr', {}, h('td', {}, fecha(i.cuando)), h('td', {}, i.archivo), h('td', {}, i.conceptoNombre),
        h('td', {}, Object.keys(i.porMes).sort().map(nombreMes).join(', ')), h('td', { class: 'num' }, String(i.filas)),
        h('td', {}, h('button', { onclick: async () => { if (!confirm(`¿Deshacer la importación de "${i.archivo}"?`)) return; try { await api('/api/importaciones/eliminar', { id: i.id }); await listarImportaciones(); await cargarMes(estado.mes); } catch (e) { alert(e.message); } } }, 'Deshacer')))))));
  } catch (e) { poner(cont, h('div', { class: 'error' }, e.message)); }
}

async function refrescarMeses() {
  const m = await api('/api/meses');
  estado.meses = m.meses;
  const sel = $('#mes');
  poner(sel, ...m.meses.map((x) => h('option', { value: x }, `${nombreMes(x)}${x === m.porDefecto ? ' (mes anterior)' : ''}`)));
  sel.value = estado.mes;
  await cargarMes(estado.mes);
}

// ---------------- Simulador (compras reales) ----------------
function renderSimulador() {
  const p = estado.panel;
  const neto = h('input', { type: 'number', min: '0', step: '1000', value: '1000000' });
  const alic = h('select', {}, h('option', { value: '0.21' }, '21%'), h('option', { value: '0.105' }, '10,5%'), h('option', { value: '0.27' }, '27%'));
  const tipo = h('select', {}, h('option', { value: 'mercaderia' }, 'Mercadería para revender'), h('option', { value: 'gasto' }, 'Gasto del período (servicio, insumo)'));
  const salida = h('div');
  const base = p.iva.declarado.valor != null ? null : p.iva.estimado.valor;
  const calc = () => {
    const n = Math.max(0, Number(neto.value) || 0); const a = Number(alic.value); const credito = n * a;
    const filas = [
      ['IVA crédito fiscal potencial', fmt(credito)],
      ['Desembolso total (neto + IVA)', fmt(n + credito)],
      ['Costo real después de computar el crédito', fmt(n)],
    ];
    if (base != null) filas.push(['Saldo de IVA estimado del mes: antes → después', `${fmt(base)} → ${fmt(Math.max(0, base - credito))}`]);
    poner(salida, 
      h('table', {}, h('tbody', {}, ...filas.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, v))))),
      base == null ? h('div', { class: 'aviso' }, `La DJ de IVA de ${nombreMes(p.mes)} ya está presentada: una compra nueva computa en el período en que se factura.`) : null,
      h('p', { class: 'nota' }, tipo.value === 'mercaderia'
        ? 'Ganancias: la mercadería para revender no baja Ganancias al comprarla; se deduce como costo cuando se vende. El crédito de IVA sí se computa en el mes de la factura.'
        : 'Ganancias: un gasto deducible del período reduce el resultado del mes por su importe neto (el ahorro depende de tu alícuota marginal).'));
  };
  for (const x of [neto, alic, tipo]) x.addEventListener('input', calc);
  calc();
  poner($('#simulador'), h('div', { class: 'caja' },
    h('h2', {}, 'Simulador de una compra real'),
    h('div', { class: 'aviso' }, 'Solo para compras reales con su factura. El crédito fiscal requiere una operación existente y documentada.'),
    h('div', { class: 'grilla-form' }, h('label', {}, 'Importe neto de la compra', neto), h('label', {}, 'Alícuota de IVA', alic), h('label', {}, 'Tipo de compra', tipo)),
    salida,
    h('p', { class: 'nota' }, 'Versión inicial: no modifica ningún dato. La planificación completa (Ganancias, stock y rentabilidad) se suma más adelante.')));
}

iniciar();
