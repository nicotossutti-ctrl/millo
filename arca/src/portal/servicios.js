/**
 * Catálogo de servicios fiscales de ARCA y SIFERE que FiscalOS recorre, en modo lectura.
 *
 * Cada servicio declara:
 *   - nombre: texto con el que se busca/abre en el portal (abrirServicio).
 *   - fuente: número de fila en COBERTURA.md.
 *   - confirmado: true si los selectores de su pantalla ya se verificaron contra ARCA real.
 *   - extractor: 'mis-comprobantes' usa el extractor dedicado; 'generico' releva la pantalla
 *     e intenta descubrir filtros de fecha, botón de consulta y exportación sin selectores fijos.
 *   - tipo: parámetro extra para el extractor dedicado (emitidos|recibidos).
 *
 * Ningún servicio presenta, modifica, emite ni paga: solo navega, consulta y exporta.
 */
export const SERVICIOS = [
  { id: 'comprobantes-recibidos', nombre: 'Mis Comprobantes', fuente: 2, confirmado: true, extractor: 'mis-comprobantes', tipo: 'recibidos' },
  { id: 'comprobantes-emitidos', nombre: 'Mis Comprobantes', fuente: '1b', confirmado: true, extractor: 'mis-comprobantes', tipo: 'emitidos' },
  { id: 'portal-iva', nombre: 'Portal IVA', fuente: 3, confirmado: false, extractor: 'generico' },
  { id: 'mis-retenciones', nombre: 'Mis Retenciones', fuente: 11, confirmado: false, extractor: 'generico' },
  { id: 'cuentas-tributarias', nombre: 'Sistema de Cuentas Tributarias', fuente: 12, confirmado: false, extractor: 'generico' },
  { id: 'ddjj-y-pagos', nombre: 'Presentación de DDJJ y Pagos', fuente: 10, confirmado: false, extractor: 'generico' },
  { id: 'ccma', nombre: 'CCMA - Cuenta Corriente de Monotributistas y Autónomos', fuente: 13, confirmado: false, extractor: 'generico' },
  { id: 'mis-facilidades', nombre: 'Mis Facilidades', fuente: 15, confirmado: false, extractor: 'generico' },
  { id: 'sifere-consultas', nombre: 'Convenio Multilateral - SIFERE WEB - Consultas', fuente: 5, confirmado: false, extractor: 'generico' },
  { id: 'ventanilla', nombre: 'Ventanilla Electrónica', fuente: 16, confirmado: false, extractor: 'generico' },
];

export function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}
