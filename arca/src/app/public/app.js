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

const badge = (nivel) => h('span', { class: `nivel ${nivel}` }, nivel);
/** Celda de una cifra: importe + nivel; fuente y nota como texto chico. */
function celdaCifra(c, { conNota = true } = {}) {
  if (!c) return h('td', { class: 'num' }, '—');
  return h('td', { class: 'num', title: [c.fuente, c.nota].filter(Boolean).join(' · ') },
    c.valor == null ? '—' : fmt(c.valor), badge(c.nivel),
    conNota && c.nota && c.valor == null ? h('div', { class: 'nota' }, c.nota) : null);
}
const celdaFecha = (f) => h('td', { title: [f?.fuente, f?.nota].filter(Boolean).join(' · ') }, f?.fecha ? fecha(f.fecha) : '—', badge(f?.nivel ?? 'faltante'));

const estado = { mes: null, meses: [], panel: null, hoy: null, conceptos: {} };

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
    const [m, conceptos] = await Promise.all([api('/api/meses'), api('/api/conceptos')]);
    estado.meses = m.meses; estado.hoy = m.hoy; estado.conceptos = conceptos;
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
      iibb.declarado.valor != null ? 'Declarado (importado)' : iibb.estimado.valor != null ? 'Estimado' : 'Sin DJ: importala en "Importar archivo"',
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
function renderRentabilidad() {
  const r = estado.panel.rentabilidad;
  const fila = (nombre, c, signo = '') => h('tr', {}, h('td', {}, `${signo}${nombre}`), celdaCifra(c));
  const filas = [
    fila('Facturación neta de IVA', r.ingresos),
    ...r.gastos.map((g) => fila(g.nombre, g, '− ')),
    fila('Ingresos Brutos atribuible', r.iibb, '− '),
    fila('Provisión de Ganancias', r.ganancias, '− '),
    r.autonomos ? fila('Autónomos', r.autonomos, '− ') : null,
  ];
  const total = h('tr', { class: 'total' }, h('td', {}, 'Resultado económico del mes'), celdaCifra(r.resultado));
  const ref = [r.referencia.comprasFacturadas && fila('Compras facturadas por proveedores (neto)', r.referencia.comprasFacturadas),
    r.referencia.ventasMercadoLibre && fila('Ventas de Mercado Libre (importadas)', r.referencia.ventasMercadoLibre)].filter(Boolean);
  const caja = estado.panel.caja;
  poner($('#rentabilidad'), 
    h('div', { class: 'caja' }, h('h2', {}, `Resultado económico · ${nombreMes(estado.panel.mes)}`),
      h('table', {}, h('tbody', {}, ...filas, total)),
      r.resultado.nota ? h('p', { class: 'nota' }, r.resultado.nota) : null,
      h('div', { class: 'aviso' }, r.nota),
      r.faltantes.length ? h('p', { class: 'nota' }, `Para completar: ${r.faltantes.join(' · ')}. Los costos y gastos se cargan en "Importar archivo".`) : null),
    ref.length ? h('div', { class: 'caja' }, h('h2', {}, 'Referencias (no se suman)'), h('table', {}, h('tbody', {}, ...ref))) : null,
    h('div', { class: 'caja' }, h('h2', {}, 'Caja fiscal: lo que este mes genera para pagar'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Impuesto'), h('th', { class: 'num' }, 'Importe'), h('th', {}, 'Vence'))),
        h('tbody', {}, ...caja.map((c) => h('tr', {}, h('td', {}, c.impuesto), celdaCifra({ valor: c.importe, nivel: c.importe == null ? 'faltante' : c.nivel }), h('td', {}, c.vence ? fecha(c.vence) : '—'))))),
      h('p', { class: 'nota' }, 'El IVA aparece acá (caja) y no en el resultado. Ingresos Brutos y Ganancias aparecen en los dos: son costo del mes y también un pago futuro.')),
    h('div', { class: 'caja' }, h('h2', {}, 'Conexión con PFOS'), h('p', { class: 'nota' }, estado.panel.integraciones.pfos.nota)));
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
