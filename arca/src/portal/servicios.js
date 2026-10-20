/**
 * Catálogo de servicios fiscales de ARCA y SIFERE que FiscalOS recorre, en modo lectura.
 *
 * Cada servicio declara:
 *   - nombre: texto con el que se busca/abre en el portal (abrirServicio).
 *   - fuente: número de fila en COBERTURA.md.
 *   - confirmado: true si los selectores de su pantalla ya se verificaron contra ARCA real.
 *   - extractor: 'mis-comprobantes' usa el extractor dedicado; 'tabla' consulta una grilla con
 *     selectores por servicio o genéricos; 'generico' es un hub: se atraviesa en SOLO LECTURA
 *     (drill) hasta la grilla y, si se llega, se extrae; si no, se releva y se documenta.
 *   - tipo: parámetro extra para el extractor dedicado (emitidos|recibidos).
 *   - terminos: alternativas de nombre para encontrarlo en el buscador del portal.
 *   - drill: false desactiva la navegación automática de hub (por defecto está activa en genéricos).
 *
 * Ningún servicio presenta, modifica, emite ni paga: solo navega, consulta y exporta.
 * COBERTURA.md tiene el detalle de qué datos trae cada fuente y el estado real de cada una.
 */
export const SERVICIOS = [
  { id: 'comprobantes-recibidos', nombre: 'Mis Comprobantes', fuente: 2, confirmado: true, extractor: 'mis-comprobantes', tipo: 'recibidos' },
  { id: 'comprobantes-emitidos', nombre: 'Mis Comprobantes', fuente: '1b', confirmado: true, extractor: 'mis-comprobantes', tipo: 'emitidos' },
  { id: 'portal-iva', nombre: 'Portal IVA', terminos: ['Portal IVA', 'IVA'], fuente: 3, confirmado: false, extractor: 'generico' },
  { id: 'mis-retenciones', nombre: 'Mis Retenciones', fuente: 11, confirmado: true, extractor: 'tabla',
    selectores: { fechaDesde: '#fechaRetencionDesde__input', fechaHasta: '#fechaRetencionHasta__input', consultar: '#btnConsultarRetenciones' },
    columnasEsperadas: ['Impuesto', 'Fecha', 'Importe'] },
  { id: 'cuentas-tributarias', nombre: 'Sistema de Cuentas Tributarias', fuente: 12, confirmado: true, extractor: 'tabla',
    columnasEsperadas: ['Impuesto', 'Concepto', 'Periodo', 'Vencimiento'] },
  { id: 'ddjj-y-pagos', nombre: 'Presentación de DDJJ y Pagos', terminos: ['Presentación de DDJJ y Pagos', 'Mis DDJJ', 'Presentacion de DDJJ'], fuente: 10, confirmado: false, extractor: 'generico' },
  { id: 'ganancias-ph', nombre: 'Ganancias Personas Humanas', terminos: ['Ganancias Personas Humanas', 'Ganancias y Bienes Personales Web', 'Ganancias'], fuente: 8, confirmado: false, extractor: 'generico' },
  { id: 'bienes-personales', nombre: 'Bienes Personales Web', terminos: ['Bienes Personales', 'Ganancias y Bienes Personales Web'], fuente: 9, confirmado: false, extractor: 'generico' },
  { id: 'ccma', nombre: 'CCMA - Cuenta Corriente de Monotributistas y Autónomos', terminos: ['CCMA', 'Cuenta Corriente de Monotributistas'], fuente: 13, confirmado: false, extractor: 'generico' },
  { id: 'mis-facilidades', nombre: 'Mis Facilidades', fuente: 15, confirmado: true, extractor: 'tabla',
    columnasEsperadas: ['Presentacion', 'Numero', 'Cuotas', 'Estado'] },
  { id: 'sifere-consultas', nombre: 'Convenio Multilateral - SIFERE WEB - Consultas', terminos: ['SIFERE', 'Convenio Multilateral'], fuente: 5, confirmado: false, extractor: 'generico' },
  { id: 'ventanilla', nombre: 'Ventanilla Electrónica', terminos: ['Ventanilla Electrónica', 'Domicilio Fiscal Electrónico', 'e-Ventanilla'], fuente: 16, confirmado: false, extractor: 'generico' },
];

export function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}
