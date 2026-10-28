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
    await Promise.all([cargarMes(inicial), renderPendientes()]);
  } catch (e) {
    poner($('#impuestos'), h('div', { class: 'error' }, `No se pudo cargar FiscalOS: ${e.message}`));
  }
}

async function cargarMes(mes) {
  estado.mes = mes;
  for (const id of ['impuestos', 'obligaciones']) poner($(`#${id}`), h('div', { class: 'cargando' }, `Cargando ${nombreMes(mes)}…`));
  try {
    estado.panel = await api(`/api/panel?mes=${encodeURIComponent(mes)}`);
    renderImpuestos(); renderObligaciones(); renderSimulador();
  } catch (e) {
    poner($('#impuestos'), h('div', { class: 'error' }, `No se pudo armar el panel de ${nombreMes(mes)}: ${e.message}`));
  }
}

/** Sube el PDF de una CM03 (el «Reporte» de SIFERE). `mes`: el período que se espera (null: el que diga el PDF). */
async function subirCm03(file, mes, msg) {
  msg.textContent = `Leyendo ${file.name}…`;
  try {
    const b64 = await new Promise((ok, mal) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => mal(r.error); r.readAsDataURL(file); });
    const c = await api('/api/cm03/importar', { nombre: file.name, contenido: b64, mes });
    msg.textContent = c.estado === 'valida'
      ? `${c.yaImportado ? 'Ya estaba importada. ' : ''}CM03 ${c.periodo.slice(5)}/${c.periodo.slice(0, 4)} ${c.rectificativa ? `rectificativa ${c.rectificativa}` : 'original'}: impuesto determinado ${fmt(c.impuestoDeterminadoTotal)}, total a pagar ${fmt(c.totalAPagarDeclarado)} (${c.jurisdicciones.length} jurisdicciones). Presentarla no es pagarla.`
      : `El PDF quedó en revisión y no se usa: ${c.motivos.join('; ')}`;
    await renderPendientes(); if (estado.mes) await cargarMes(estado.mes);
    if ($('#cm03-lista')) await listarCm03();
  } catch (e) { msg.textContent = e.message; }
}

// ---------------- Pendientes de carga (cartel) ----------------
/** Lo que ARCA no entrega sola: se pide con un cartel hasta que esté cargado (importe acá o archivo en «Importar»). */
async function renderPendientes() {
  const cont = $('#pendientes');
  let lista;
  try { lista = await api('/api/pendientes'); } catch (e) { poner(cont, h('div', { class: 'error' }, `No se pudieron revisar los pendientes: ${e.message}`)); return; }
  if (!lista.length) { poner(cont); return; }
  const item = (x) => {
    const msg = h('span', { class: 'nota', role: 'status' });
    const formCarga = (accion, conImportar) => {
      const imp = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Importe (ej. 1.234.567,89)', 'aria-label': `Importe: ${x.titulo}` });
      const fp = accion.conFecha ? h('input', { type: 'date', 'aria-label': `Fecha de pago: ${x.titulo}`, title: 'Fecha en que se pagó' }) : null;
      const guardar = async () => {
        try {
          await api('/api/manuales/guardar', { mes: accion.mes, concepto: accion.concepto, importe: imp.value, fuente: 'cartel de pendientes', nota: x.titulo, fechaPago: fp?.value || null });
          await renderPendientes(); if (estado.mes) await cargarMes(estado.mes);
        } catch (e) { msg.textContent = e.message; }
      };
      imp.addEventListener('keydown', (e) => { if (e.key === 'Enter') guardar(); });
      return h('div', { class: 'carga' }, imp, fp ? h('label', { class: 'nota' }, 'pagado el ', fp) : null, h('button', { class: accion === x.accion ? 'primario' : '', onclick: guardar }, 'Guardar'),
        conImportar ? h('button', { onclick: () => document.querySelector('[data-pestana=importar]').click() }, 'Importar archivo') : null);
    };
    let form = null;
    if (x.accion.tipo === 'cargar') form = h('div', {}, formCarga(x.accion, true), msg);
    if (x.accion.tipo === 'cm03') {
      const entrada = h('input', { type: 'file', accept: '.pdf,application/pdf', hidden: true, 'aria-label': `PDF de la CM03: ${x.titulo}` });
      entrada.addEventListener('change', () => entrada.files[0] && subirCm03(entrada.files[0], x.accion.mes, msg));
      form = h('div', {}, h('div', { class: 'carga' }, h('button', { class: 'primario', onclick: () => entrada.click() }, 'Subir el PDF de la CM03'), entrada),
        x.accion.alternativa ? h('details', {}, h('summary', { class: 'nota' }, 'o cargar el importe a mano'), formCarga(x.accion.alternativa, false)) : null, msg);
    }
    return h('li', {}, h('strong', {}, x.titulo), x.estadoPago ? h('span', { class: 'estado pend' }, x.estadoPago) : null,
      h('div', { class: 'nota' }, `Por qué: ${x.porque}.`), h('div', { class: 'nota' }, x.como), form);
  };
  const grupos = [...lista.reduce((m, x) => m.set(x.mes, [...(m.get(x.mes) ?? []), x]), new Map())];
  poner(cont, h('div', { class: 'caja aviso-pendientes' }, h('details', { open: true },
    h('summary', {}, h('strong', {}, `Te falta cargar ${lista.length === 1 ? '1 dato' : `${lista.length} datos`} de ARCA y SIFERE`),
      h('span', { class: 'nota' }, ' · lo que ARCA no entrega sola; el cartel desaparece cuando está cargado')),
    ...grupos.map(([mes, xs], n) => h('details', { open: n === 0 },
      h('summary', {}, h('strong', {}, mes.endsWith('-12') && xs.every((x) => x.accion.concepto === 'ganancias-determinado') ? `Ganancias ${mes.slice(0, 4)} (anual)` : nombreMes(mes)), h('span', { class: 'nota' }, ` · ${xs.length} pendiente(s)`)),
      h('ul', { class: 'lista' }, ...xs.map(item)))))));
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
    tarjeta('Ingresos Brutos', iibb.aPagar.valor != null ? iibb.aPagar : iibb.declarado.valor != null ? iibb.declarado : iibb.estimado, iibb.estado, [
      iibb.aPagar.valor != null ? 'A pagar según la CM03' : iibb.declarado.valor != null ? 'Impuesto determinado (falta el total a pagar de la CM03)' : iibb.estimado.valor != null ? 'Estimado' : 'Sin CM03: subila desde el cartel de pendientes',
      iibb.aPagar.valor != null && iibb.declarado.valor != null ? `Impuesto determinado: ${fmt(iibb.declarado.valor)} (la carga del mes, no lo que se paga)` : null,
      iibb.volantesSinPago?.length ? `${iibb.volantesSinPago.length} volante(s) de SIFERE generado(s) sin estado de pago: no se descuentan` : null,
      iibb.presentacion?.fecha ? `CM03 presentada: ${fecha(iibb.presentacion.fecha)} (${iibb.presentacion.nota.replace(/^CM03 /, '').replace(/ presentada.*/, '')}, SIFERE)` : null,
    ]),
    tarjeta('Ganancias', ganancias.estimado, ganancias.estado, [
      ganancias.estimado.valor != null ? 'Provisión estimada del mes' : 'Sin provisión (faltan datos)',
      ganancias.pagosEnElMes ? `Pagado en el mes: ${fmt(ganancias.pagosEnElMes.valor)} (de otro período, ver abajo)` : null,
      ganancias.djAnterior?.valor != null ? `${ganancias.djAnterior.fuente}: impuesto determinado ${fmt(ganancias.djAnterior.valor)}` : null,
      ganancias.djAnteriorPresentada ? `DJ anual del año anterior presentada: ${fecha(ganancias.djAnteriorPresentada.fecha)} (F.${ganancias.djAnteriorPresentada.formulario})` : null,
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

  const config = !p.configuracion.contribuyente
    ? h('div', { class: 'aviso' }, 'Para estimar Ingresos Brutos, Ganancias y autónomos falta params/contribuyente.json (copiá params/contribuyente.example.json y completalo con los datos de tu contador).')
    : null;
  const djs = p.djDelPeriodo ?? [];
  const bloqueDj = h('div', { class: 'caja' }, h('h2', {}, `Declaraciones juradas presentadas del período ${p.mes.slice(5)}/${p.mes.slice(0, 4)}`),
    h('p', { class: 'nota' }, 'Según las DJ de Cuentas Tributarias ya bajadas (todas las nacionales: IVA, retenciones como agente, cargas sociales…). Una DJ que no figura puede no estar en lo bajado.'),
    djs.length ? h('table', { class: 'apilable' }, h('thead', {}, h('tr', {}, ...['Presentada', 'Formulario', 'Impuesto', 'Versión'].map((x) => h('th', {}, x)))),
      h('tbody', {}, ...djs.map((d) => h('tr', {}, h('td', { 'data-rotulo': 'Presentada' }, d.fecha ?? '—'), h('td', { 'data-rotulo': 'Formulario' }, `F.${d.formulario}`),
        h('td', { 'data-rotulo': 'Impuesto' }, d.impuesto), h('td', { 'data-rotulo': 'Versión' }, d.version ?? '—'))))) : h('p', { class: 'no-disponible' }, 'No hay DJ de este período en lo bajado de Cuentas Tributarias.'));
  const bloqueTerceros = h('div', { class: 'caja' }, h('h2', {}, 'Como empleador y como agente de retención'),
    h('p', { class: 'nota' }, 'No son impuestos propios sobre tu actividad: F.931 son las cargas sociales del personal; SICORE, lo que retuviste o percibiste a terceros. Presentar la DJ no es pagarla.'),
    h('table', { class: 'apilable' }, h('thead', {}, h('tr', {}, ...['Obligación', 'DJ presentada', 'Declarado', 'Pagos del período', 'Estado', 'Vence'].map((x, i) => h('th', { class: i === 2 || i === 3 ? 'num' : '' }, x)))),
      h('tbody', {}, ...(p.terceros ?? []).map((o) => h('tr', { title: o.tratamiento },
        h('td', { 'data-rotulo': 'Obligación' }, o.nombre),
        h('td', { 'data-rotulo': 'DJ presentada' }, o.presentacion ? h('span', {}, o.presentacion.fecha ?? '—', badge('verificado')) : h('span', { class: 'sin-dato' }, '—')),
        celdaCifra(o.declarado), celdaCifra(o.pagos),
        h('td', { 'data-rotulo': 'Estado' }, h('span', { class: `estado ${claseEstado(o.estado)}` }, o.estado)),
        h('td', { 'data-rotulo': 'Vence' }, o.vencimiento?.fecha ? fecha(o.vencimiento.fecha) : '—'))))));
  poner($('#impuestos'), tarjetas, config, tabla, h('div', { class: 'columnas' }, detalle, bloquePagos(p)), bloqueIibb(p), h('div', { class: 'columnas' }, bloqueDeja(p), bloqueDj), bloqueTerceros, bloquePfos(p));
}

// ---------------- Cargas a mano (pagos que no están en ARCA) ----------------
/** Editor en línea de las cargas manuales de un concepto del mes: corregir, borrar, agregar. */
function editorCargas(concepto, cargas, alGuardar, { pago = false, periodoPorDefecto = null } = {}) {
  const fila = (c) => {
    const imp = h('input', { type: 'text', inputmode: 'decimal', value: c ? String(c.importe).replace('.', ',') : '', 'aria-label': 'Importe', placeholder: 'Importe (ej. 1.234.567,89)' });
    // Un pago: el PERÍODO al que corresponde y la FECHA en que se pagó, por separado.
    const per = pago ? h('input', { type: 'month', value: c?.mes ?? periodoPorDefecto ?? '', 'aria-label': 'Período al que corresponde' }) : null;
    const fp = pago ? h('input', { type: 'date', value: c?.fechaPago ?? '', 'aria-label': 'Fecha de pago' }) : null;
    const fue = h('input', { type: 'text', value: c?.fuente ?? '', 'aria-label': 'Fuente', placeholder: 'De dónde sale (ej. VEP, volante de SIFERE)' });
    const nota = h('input', { type: 'text', value: c?.nota ?? '', 'aria-label': 'Nota', placeholder: 'Nota (opcional)' });
    const msg = h('span', { class: 'nota' });
    const guardar = async () => {
      try { await api('/api/manuales/guardar', { id: c?.id ?? null, mes: per?.value || c?.mes || estado.mes, concepto, importe: imp.value, fuente: fue.value, nota: nota.value, fechaPago: fp?.value || null }); await alGuardar(); }
      catch (e) { msg.textContent = e.message; msg.className = 'error'; }
    };
    const borrar = c ? h('button', { onclick: async () => { if (!confirm('¿Borrar esta carga?')) return; try { await api('/api/manuales/eliminar', { id: c.id }); await alGuardar(); } catch (e) { msg.textContent = e.message; } } }, 'Borrar') : null;
    return h('div', { class: 'carga' }, imp, per ? h('label', { class: 'nota' }, 'período ', per) : null, fp ? h('label', { class: 'nota' }, 'pagado el ', fp) : null,
      fue, nota, h('button', { class: 'primario', onclick: guardar }, c ? 'Guardar corrección' : 'Agregar'), borrar, msg,
      c?.historial?.length ? h('div', { class: 'nota' }, `Valores anteriores: ${c.historial.map((x) => fmt(x.importe)).join(' · ')}`) : null);
  };
  return h('div', { class: 'editor' }, ...cargas.map(fila), fila(null));
}

/** Pagos de impuestos con fecha en el mes (ARCA + cargados a mano) y el formulario para cargar uno que no está en ARCA. */
function bloquePagos(p) {
  const pg = p.pagos;
  const recargar = async () => { await cargarMes(estado.mes); await renderPendientes(); };
  const conc = h('select', { 'aria-label': 'Impuesto pagado' }, ...['iibb-pagado', 'ganancias-anticipo', 'autonomos', 'f931-pagado', 'sicore-pagado'].map((k) => h('option', { value: k }, estado.conceptos[k]?.nombre ?? k)));
  const cont = h('div');
  const abrir = h('button', { class: 'ver-fuentes', onclick: () => {
    const [y, m] = p.mes.split('-').map(Number); const anterior = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    poner(cont, h('div', { class: 'editor' }, h('label', { class: 'nota' }, 'Impuesto ', conc),
      h('p', { class: 'nota' }, 'El período es al que corresponde el pago; la fecha, cuándo salió el dinero. Si ARCA ya lo registra, no lo cargues: se detecta como duplicado y no se suma.'),
      editorCargas(conc.value, [], recargar, { pago: true, periodoPorDefecto: anterior })));
    conc.onchange = () => abrir.click();
  } }, 'Cargar un pago que no está en ARCA');
  return h('div', { class: 'caja' }, h('h2', {}, `Pagos de impuestos realizados en ${nombreMes(p.mes)}`),
    h('p', { class: 'nota' }, 'Flujo de caja: lo que se pagó con fecha en el mes. Cada pago dice a qué período se imputó; un pago de otro período no es carga de este mes.'),
    pg.filas.length ? h('table', { class: 'apilable' }, h('thead', {}, h('tr', {}, ...['Fecha', 'Impuesto', 'Corresponde a', 'Importe'].map((x, i) => h('th', { class: i === 3 ? 'num' : '' }, x)))),
      h('tbody', {}, ...pg.filas.map((f) => h('tr', { title: f.detalle ?? null },
        h('td', { 'data-rotulo': 'Fecha' }, f.fecha ? fecha(f.fecha) : '—'),
        h('td', { 'data-rotulo': 'Impuesto' }, h('span', {}, f.impuesto, ' ', h('span', { class: `etiqueta ${f.propio === true ? 'propio' : ''}` }, f.propio === false ? 'como agente' : f.propio === 'empleador' ? 'como empleador' : 'propio'),
          f.estadoConciliacion === 'duplicado' ? h('span', { class: 'etiqueta', title: f.nota }, 'duplicado: no se suma') : f.estadoConciliacion === 'incierto' ? h('span', { class: 'etiqueta', title: f.nota }, 'sin fecha: no se suma')
            : f.estadoConciliacion === 'sin conciliar' ? h('span', { class: 'etiqueta', title: f.nota }, 'sin conciliar: no se suma') : null)),
        h('td', { 'data-rotulo': 'Corresponde a' }, f.corresponde),
        h('td', { class: 'num', 'data-rotulo': 'Importe' }, h('span', {}, fmt(f.importe), badge(f.nivel))))))) : h('p', { class: 'no-disponible' }, 'No hay pagos con fecha en este mes en las consultas conservadas de Cuentas Tributarias ni cargados a mano.'),
    h('p', {}, h('strong', {}, 'Impuestos propios pagados: '), fmt(pg.propios), pg.comoAgente ? h('span', { class: 'nota' }, ` · retenciones depositadas como agente: ${fmt(pg.comoAgente)} (dinero de terceros)`) : null,
      pg.comoEmpleador ? h('span', { class: 'nota' }, ` · seguridad social como empleador: ${fmt(pg.comoEmpleador)}`) : null),
    pg.noSumados ? h('div', { class: 'aviso' }, `${pg.noSumados} pago(s) cargado(s) a mano no se suman: coinciden con uno verificado o no tienen fecha (pasá el mouse para ver por qué).`) : null,
    pg.sinFecha ? h('div', { class: 'aviso' }, pg.sinFecha.nota) : null,
    h('div', {}, abrir, cont));
}

/** Lo que el mes deja para pagar más adelante. */
/** Ingresos Brutos según la CM03: por jurisdicción, sin compensar saldos a favor de una con lo que se debe en otra. */
function bloqueIibb(p) {
  const i = p.iibb; const js = i.porJurisdiccion;
  const fila = (nombre, c) => h('tr', {}, h('td', {}, nombre), h('td', { class: 'num', title: [c?.fuente, c?.nota].filter(Boolean).join(' · ') || null },
    c?.valor == null ? h('span', { class: 'sin-dato' }, '—') : fmt(c.valor), badge(c?.nivel ?? 'faltante'), c?.valor == null && c?.nota ? h('div', { class: 'nota' }, c.nota) : null));
  return h('div', { class: 'caja' }, h('h2', {}, `Ingresos Brutos (Convenio Multilateral) · ${nombreMes(p.mes)}`),
    h('table', {}, h('tbody', {},
      fila('Impuesto determinado (la carga del mes)', i.declarado),
      fila('Total a pagar según la CM03', i.aPagar),
      fila('Saldos a favor del contribuyente', i.aFavorContribuyente),
      fila('Pagos comprobados del período', i.pagos),
      fila('Saldo', i.saldoPendiente))),
    js ? h('table', { class: 'apilable' },
      h('thead', {}, h('tr', {}, ...['Jurisdicción', 'Determinado', 'A favor contribuyente', 'A favor fisco', 'A pagar'].map((x, k) => h('th', { class: k ? 'num' : '' }, x)))),
      h('tbody', {}, ...js.map((j) => h('tr', {}, h('td', { 'data-rotulo': 'Jurisdicción' }, `${j.codigo ? `${j.codigo} · ` : ''}${j.jurisdiccion}`),
        ...[['determinado', 'Determinado'], ['aFavorContribuyente', 'A favor contribuyente'], ['aFavorFisco', 'A favor fisco'], ['aPagar', 'A pagar']].map(([k, rot]) => h('td', { class: 'num', 'data-rotulo': rot }, fmt(j[k]))))))) : null,
    h('p', { class: 'nota' }, 'Presentar la CM03 no es pagarla. Un saldo a favor de una jurisdicción no cancela lo que se debe en otra; los pagos no dicen a qué jurisdicción van.'),
    i.cm03?.vigente?.detalles?.length ? h('details', {}, h('summary', { class: 'nota' }, 'Determinación del anticipo (detalle del PDF, no se suma)'),
      ...i.cm03.vigente.detalles.map((d) => h('div', {}, h('strong', {}, d.jurisdiccion), h('table', {}, h('tbody', {}, ...d.conceptos.map((c) => h('tr', {}, h('td', {}, c.concepto), h('td', { class: 'num' }, fmt(c.importe))))))))) : null,
    i.avisos?.length ? h('div', {}, ...i.avisos.map((a) => h('div', { class: 'aviso' }, a))) : null);
}

function bloqueDeja(p) {
  return h('div', { class: 'caja' }, h('h2', {}, `Lo que ${nombreMes(p.mes)} deja para pagar más adelante`),
    h('table', { class: 'apilable' }, h('tbody', {}, ...p.deja.map((o) => h('tr', {},
      h('td', { 'data-rotulo': 'Impuesto' }, o.impuesto),
      h('td', { class: 'num', 'data-rotulo': 'Importe', title: [o.cifra.fuente, o.cifra.nota].filter(Boolean).join(' · ') || null }, h('span', {}, o.cifra.valor == null ? '—' : fmt(o.cifra.valor), badge(o.cifra.nivel))),
      h('td', { 'data-rotulo': 'Vence' }, o.vence ? fecha(o.vence) : '—'),
      h('td', { 'data-rotulo': '' }, h('span', { class: 'nota' }, o.nota ?? '')))))));
}

/** Conciliación fiscal con PFOS: la cuenta (por CAE), las ventas como control contra la facturación y las retenciones de MP. */
function bloquePfos(p) {
  const x = p.integraciones.pfos;
  if (!x.conectado) return h('div', { class: 'caja' }, h('h2', {}, 'Conciliación con PFOS (Mercado Libre)'), h('p', { class: 'no-disponible' }, x.nota));
  const corte = x.mesCerrado === false && x.corte ? ` (al corte del ${fecha(x.corte)})` : '';
  const chip = x.verificada ? ['ok', 'cuenta verificada por CAE'] : x.usable ? ['pend', `cuenta verificada en ${nombreMes(x.titularidad.mesVerificado)}`] : ['alerta', 'cuenta NO verificada: no se usan sus datos'];
  const conc = x.conciliacionFiscal ?? { estado: 'pendiente', motivo: x.cuenta?.motivo };
  const c = x.control; const r = x.retencionesMp;
  const filas = x.usable ? [
    ['Ventas de Mercado Libre con IVA', c?.ventasMl == null ? '—' : `${fmt(c.ventasMl)} · ${c.ordenes} órdenes${corte}`],
    ['Facturado en el mes (importe total de los comprobantes emitidos)', c?.facturado == null ? 'faltan los comprobantes emitidos del mes' : fmt(c.facturado)],
    ['Diferencia (facturado − ventas de ML)', c?.diferencia == null ? '—' : fmt(c.diferencia)],
    ['Retenciones de Mercado Pago en los cobros', r?.importe == null ? '—' : `${fmt(r.importe)}${r.cobertura != null ? ` · ${r.cobertura}% de las ventas con su cobro` : ''}`],
  ] : [];
  return h('div', { class: 'caja' }, h('h2', {}, 'Conciliación con PFOS (Mercado Libre)'),
    h('p', {}, h('span', { class: `estado ${chip[0]}` }, chip[1]), h('span', { class: 'nota' }, ` · datos del ${fecha(String(x.generado).slice(0, 10))}${corte}`)),
    h('p', { class: 'nota' }, x.titularidad?.motivo ?? x.cuenta?.motivo ?? ''),
    h('p', {}, h('strong', {}, 'Conciliación fiscal del mes: '), h('span', { class: `estado ${conc.estado === 'conciliada' ? 'ok' : conc.estado === 'pendiente' ? 'pend' : 'alerta'}` }, conc.estado),
      conc.estado !== 'conciliada' ? h('span', { class: 'nota' }, ` · ${conc.motivo ?? ''}`) : null),
    filas.length ? h('table', { class: 'apilable' }, h('tbody', {}, ...filas.map(([k, v]) => h('tr', {}, h('td', { 'data-rotulo': '' }, k), h('td', { 'data-rotulo': '' }, v))))) : null,
    c?.nota ? h('p', { class: 'nota' }, c.nota) : null,
    r?.porNombre && Object.keys(r.porNombre).length ? h('p', { class: 'nota' }, `Retenciones por tipo: ${Object.entries(r.porNombre).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ')}. Son anticipos de impuestos: se concilian con IIBB y Mis Retenciones.`) : null,
    h('p', { class: 'nota' }, 'Costos, comisiones, publicidad, logística y rentabilidad se calculan en PFOS, no en FiscalOS.'));
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
  const entrada = h('input', { type: 'file', accept: '.csv,.txt,.tsv,.xlsx,.pdf', id: 'archivo', hidden: true });
  const zona = h('div', { class: 'soltar' }, 'Arrastrá acá un CSV, Excel (.xlsx) o el PDF de una CM03, o ', h('button', { onclick: () => entrada.click() }, 'elegí un archivo'),
    h('div', { class: 'nota' }, 'Por ejemplo: el «Reporte» en PDF de la CM03 (SIFERE), los anticipos o pagos de impuestos, la cuota de autónomos o el resultado comercial que calcula PFOS.'));
  zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('encima'); });
  zona.addEventListener('dragleave', () => zona.classList.remove('encima'));
  zona.addEventListener('drop', (e) => { e.preventDefault(); zona.classList.remove('encima'); if (e.dataTransfer.files[0]) subir(e.dataTransfer.files[0]); });
  entrada.addEventListener('change', () => entrada.files[0] && subir(entrada.files[0]));
  poner($('#importar'), 
    h('div', { class: 'caja' }, h('h2', {}, 'Importar archivo'), zona, entrada, h('div', { id: 'imp-trabajo' })),
    h('div', { class: 'caja' }, h('h2', {}, 'CM03 importadas (PDF)'), h('div', { id: 'cm03-lista' }, 'Cargando…')),
    h('div', { class: 'caja' }, h('h2', {}, 'Importaciones hechas'), h('div', { id: 'imp-lista' }, 'Cargando…')));
  listarImportaciones(); listarCm03();
}

async function listarCm03() {
  const cont = $('#cm03-lista');
  try {
    const xs = await api('/api/cm03');
    if (!xs.length) { poner(cont, h('p', { class: 'nota' }, 'Todavía no importaste ninguna CM03 en PDF.')); return; }
    poner(cont, h('table', { class: 'apilable' }, h('thead', {}, h('tr', {}, ...['Período', 'Versión', 'Estado', 'Determinado', 'A pagar', 'Archivo', ''].map((x, k) => h('th', { class: k === 3 || k === 4 ? 'num' : '' }, x)))),
      h('tbody', {}, ...xs.slice().reverse().map((c) => h('tr', {},
        h('td', { 'data-rotulo': 'Período' }, c.periodo ? nombreMes(c.periodo) : '—'),
        h('td', { 'data-rotulo': 'Versión' }, c.rectificativa == null ? '—' : c.rectificativa ? `rectificativa ${c.rectificativa}` : 'original'),
        h('td', { 'data-rotulo': 'Estado', title: c.motivos?.join('; ') || null }, h('span', { class: `estado ${c.estado === 'valida' ? 'ok' : 'alerta'}` }, c.estado === 'valida' ? 'leída' : 'en revisión'),
          c.estado !== 'valida' ? h('div', { class: 'nota' }, c.motivos.join('; ')) : null),
        h('td', { class: 'num', 'data-rotulo': 'Determinado' }, fmt(c.impuestoDeterminadoTotal)), h('td', { class: 'num', 'data-rotulo': 'A pagar' }, fmt(c.totalAPagarDeclarado)),
        h('td', { 'data-rotulo': 'Archivo' }, c.archivo),
        h('td', {}, h('button', { onclick: async () => { if (!confirm(`¿Quitar la CM03 "${c.archivo}"? El PDF queda guardado.`)) return; try { await api('/api/cm03/eliminar', { id: c.id }); await listarCm03(); await cargarMes(estado.mes); await renderPendientes(); } catch (e) { alert(e.message); } } }, 'Quitar')))))));
  } catch (e) { poner(cont, h('div', { class: 'error' }, e.message)); }
}

async function subir(file) {
  const trabajo = $('#imp-trabajo');
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    const msg = h('div', { class: 'nota', role: 'status' });
    poner(trabajo, msg);
    return subirCm03(file, null, msg);
  }
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
  const concepto = sel('imp-concepto', [h('option', { value: '' }, '— elegí —'), ...Object.entries(estado.conceptos).filter(([, c]) => !c.legado).map(([k, c]) => h('option', { value: k }, c.nombre))], imp.concepto ?? '');
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
    h('p', { class: 'nota' }, 'Versión inicial: no modifica ningún dato. La planificación completa (Ganancias y stock) se suma más adelante.')));
}

iniciar();
