/**
 * Catálogo de servicios fiscales de ARCA y SIFERE que FiscalOS recorre, en modo lectura.
 *
 * Cada servicio declara:
 *   - nombre: texto con el que se busca/abre en el portal (abrirServicio).
 *   - fuente: número de fila en COBERTURA.md.
 *   - confirmado: true si los selectores de su pantalla ya se verificaron contra ARCA real.
 *   - extractor: 'mis-comprobantes' usa el extractor dedicado; 'tabla' consulta una grilla con
 *     selectores por servicio o genéricos; 'generico' es un hub: se abre, se sigue su `ruta`
 *     explícita de SOLO LECTURA hasta la grilla y, si se llega, se extrae; si no hay ruta, se
 *     releva y se guarda la estructura para definir la ruta real (no se adivina por palabras).
 *   - tipo: parámetro extra para el extractor dedicado (emitidos|recibidos).
 *   - terminos: alternativas de nombre para encontrarlo en el buscador del portal.
 *   - ruta: pasos concretos para llegar a la grilla desde el hub, tomados de la estructura real
 *     de la pantalla: [{ texto: 'Texto exacto del botón' } | { id: '...' } | { selector: '...' }].
 *     Pendiente de completar con los diagnósticos de cada hub (Portal IVA, DDJJ/Pagos, SIFERE,
 *     Ganancias, Bienes Personales). Ningún paso puede ser un control de trámite/pago/emisión.
 *
 * Ningún servicio presenta, modifica, emite ni paga: solo navega, consulta y exporta.
 * COBERTURA.md tiene el detalle de qué datos trae cada fuente y el estado real de cada una.
 */
// Nombres y rutas tomados del listado real de servicios (portal/app/mis-servicios) y de los
// diagnósticos de cada hub del 20/10/2026. No se adivina: cada ruta es un paso concreto visto.
export const SERVICIOS = [
  { id: 'comprobantes-recibidos', nombre: 'Mis Comprobantes', terminos: ['MIS COMPROBANTES'], fuente: 2, confirmado: true, extractor: 'mis-comprobantes', tipo: 'recibidos' },
  { id: 'comprobantes-emitidos', nombre: 'Mis Comprobantes', terminos: ['MIS COMPROBANTES'], fuente: '1b', confirmado: true, extractor: 'mis-comprobantes', tipo: 'emitidos' },
  // Portal IVA: dos botones "CONSULTAR" iguales de texto; el de DDJJ presentadas se distingue por
  // su aria-label (…declaraciones.anteriores.portal…). Abre la grilla en una pestaña nueva.
  // Portal IVA: el CONSULTAR de "Declaraciones juradas presentadas" (aria-label varía entre
  // ...declaraciones.anteriores.alt y ...declaraciones.anteriores.portal.alt; matcheamos el común).
  // Abre la grilla en una pestaña nueva (el drill la sigue).
  { id: 'portal-iva', nombre: 'PORTAL IVA', terminos: ['PORTAL IVA'], fuente: 3, confirmado: false, extractor: 'generico',
    ruta: [{ selector: 'button[aria-label*="declaraciones.anteriores"]' }] },
  // Mis Retenciones exige elegir un impuesto antes de Consultar (error real: "Seleccioná un impuesto").
  { id: 'mis-retenciones', nombre: 'MIS RETENCIONES', terminos: ['MIS RETENCIONES'], fuente: 11, confirmado: true, extractor: 'tabla',
    selectores: { fechaDesde: '#fechaRetencionDesde__input', fechaHasta: '#fechaRetencionHasta__input', consultar: '#btnConsultarRetenciones' },
    requiereImpuesto: true, columnasEsperadas: ['Impuesto', 'Fecha', 'Importe'] },
  { id: 'cuentas-tributarias', nombre: 'SISTEMA DE CUENTAS TRIBUTARIAS', terminos: ['SISTEMA DE CUENTAS TRIBUTARIAS', 'CUENTAS TRIBUTARIAS'], fuente: 12, confirmado: true, extractor: 'tabla',
    columnasEsperadas: ['Impuesto', 'Concepto', 'Periodo', 'Vencimiento'] },
  // DDJJ y Pagos (Syncfusion EJ2): modal de novedades ("Entendido", puede o no estar) y tabs
  // "Presentaciones"/"Pagos". La tab no es un control estándar; la dejamos opcional y confiamos en
  // que la grilla de componente aparezca (la lee el extractor de grillas e-grid/role=grid).
  { id: 'ddjj-y-pagos', nombre: 'PRESENTACIÓN DE DDJJ Y PAGOS', terminos: ['PRESENTACIÓN DE DDJJ Y PAGOS', 'PRESENTACION DE DDJJ'], fuente: 10, confirmado: false, extractor: 'generico',
    ruta: [{ texto: 'Entendido', opcional: true }, { texto: 'Presentaciones', opcional: true }] },
  // Ganancias: la portada no expone controles clickeables en el relevamiento (tarjetas con botones
  // que renderizan tarde). Pendiente de capturar esos botones para la ruta real; no se adivina.
  { id: 'ganancias-ph', nombre: 'GANANCIAS PERSONAS HUMANAS', terminos: ['GANANCIAS PERSONAS HUMANAS'], fuente: 8, confirmado: false, extractor: 'generico' },
  // Bienes Personales (F.762, mismo template integrado que IVA): CONSULTAR lleva a "Mis
  // declaraciones juradas presentadas"; la grilla aparece async (la espera la cubre).
  { id: 'bienes-personales', nombre: 'BIENES PERSONALES WEB', terminos: ['BIENES PERSONALES WEB', 'BIENES PERSONALES'], fuente: 9, confirmado: false, extractor: 'generico',
    ruta: [{ texto: 'CONSULTAR' }] },
  { id: 'ccma', nombre: 'CCMA - CUENTA CORRIENTE DE CONTRIBUYENTES MONOTRIBUTISTAS Y AUTONOMOS', terminos: ['CCMA', 'CUENTA CORRIENTE DE CONTRIBUYENTES'], fuente: 13, confirmado: false, extractor: 'generico' },
  { id: 'mis-facilidades', nombre: 'MIS FACILIDADES', terminos: ['MIS FACILIDADES'], fuente: 15, confirmado: true, extractor: 'tabla',
    columnasEsperadas: ['Presentacion', 'Numero', 'Cuotas', 'Estado'] },
  // SIFERE / Convenio Multilateral NO figura entre los servicios adheridos a esta clave fiscal
  // (no aparece en mis-servicios). Hay que adherirlo en Administrador de Relaciones (paso manual).
  { id: 'sifere-consultas', nombre: 'Convenio Multilateral - SIFERE WEB - Consultas', terminos: ['SIFERE', 'CONVENIO MULTILATERAL'], fuente: 5, confirmado: false, extractor: 'generico',
    bloqueo: 'SIFERE/Convenio Multilateral no aparece en el listado de servicios de ARCA de esta clave fiscal. Esto NO prueba que no haya acceso: SIFERE es de COMARB y puede entrarse (a) adhiriéndolo en Administrador de Relaciones o (b) por el portal de COMARB con la misma clave fiscal. A confirmar con un diagnóstico del listado completo y del portal COMARB antes de descartarlo.' },
  // Ventanilla = Domicilio Fiscal Electrónico (nombre real del servicio en el portal).
  { id: 'ventanilla', nombre: 'DOMICILIO FISCAL ELECTRÓNICO', terminos: ['DOMICILIO FISCAL ELECTRÓNICO', 'VENTANILLA'], fuente: 16, confirmado: false, extractor: 'generico' },
];

export function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}
