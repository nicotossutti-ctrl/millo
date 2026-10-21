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
// ORDEN DE EJECUCIÓN deliberado: primero los comprobantes y, enseguida, las fuentes fiscales que
// más importan (Cuentas Tributarias con sus sub-rutas de DJ/Pagos/CtaCte/Compensaciones y DDJJ y
// Pagos), después los portales Angular y lo accesorio, y DEJAMOS MIS RETENCIONES PARA EL FINAL: su
// iteración por impuesto en /resultados es la más frágil y no debe impedir llegar al resto de los
// datos. Igual, ningún servicio puede abortar la corrida (cada uno está aislado en el orquestador).
export const SERVICIOS = [
  { id: 'comprobantes-recibidos', nombre: 'Mis Comprobantes', terminos: ['MIS COMPROBANTES'], fuente: 2, confirmado: true, extractor: 'mis-comprobantes', tipo: 'recibidos' },
  { id: 'comprobantes-emitidos', nombre: 'Mis Comprobantes', terminos: ['MIS COMPROBANTES'], fuente: '1b', confirmado: true, extractor: 'mis-comprobantes', tipo: 'emitidos' },
  { id: 'cuentas-tributarias', nombre: 'SISTEMA DE CUENTAS TRIBUTARIAS', terminos: ['SISTEMA DE CUENTAS TRIBUTARIAS', 'CUENTAS TRIBUTARIAS'], fuente: 12, confirmado: true, extractor: 'tabla',
    columnasEsperadas: ['Impuesto', 'Concepto', 'Periodo', 'Vencimiento'] },
  // Sub-rutas del Sistema de Cuentas Tributarias (frame legacy ctacte). CONFIRMADO por capturas:
  // el menú "Consultas" NO es un dropdown que se expande con un clic al <a> oculto (eso no cambiaba
  // la pantalla: caía siempre en la grilla Vue de Vencimientos), sino una BARRA LATERAL izquierda
  // que se abre con el botón hamburguesa (a.menu-a). Una vez abierta, DJ / Pagos / Cuenta Corriente
  // / Compensaciones son enlaces VISIBLES; cada uno abre su propio FORMULARIO (Fecha Desde/Hasta +
  // CONSULTAR, o SIGUIENTE para DJ). Por eso: paso 1 abre la barra, paso 2 entra a la sección; el
  // extractor genérico completa las fechas del período y consulta. Solo lectura.
  // DJ: su formulario EXIGE elegir Establecimiento = "0" (confirmado) antes de SIGUIENTE; con eso
  // (y dejando Impuesto/Formulario sin tocar) trae todas las DJ. requiereEstablecimiento lo maneja.
  { id: 'ct-ddjj', nombre: 'SISTEMA DE CUENTAS TRIBUTARIAS', terminos: ['SISTEMA DE CUENTAS TRIBUTARIAS', 'CUENTAS TRIBUTARIAS'], fuente: '12-DJ', confirmado: false, extractor: 'generico',
    requiereEstablecimiento: true,
    ruta: [{ selector: 'a.menu-a', opcional: true, continuar: true }, { texto: 'Declaraciones Juradas (DJ)' }] },
  { id: 'ct-pagos', nombre: 'SISTEMA DE CUENTAS TRIBUTARIAS', terminos: ['SISTEMA DE CUENTAS TRIBUTARIAS', 'CUENTAS TRIBUTARIAS'], fuente: '12-Pagos', confirmado: false, extractor: 'generico',
    ruta: [{ selector: 'a.menu-a', opcional: true, continuar: true }, { texto: 'Pagos' }] },
  { id: 'ct-cuenta-corriente', nombre: 'SISTEMA DE CUENTAS TRIBUTARIAS', terminos: ['SISTEMA DE CUENTAS TRIBUTARIAS', 'CUENTAS TRIBUTARIAS'], fuente: '12-CtaCte', confirmado: false, extractor: 'generico',
    ruta: [{ selector: 'a.menu-a', opcional: true, continuar: true }, { texto: 'Cuenta Corriente' }] },
  { id: 'ct-compensaciones', nombre: 'SISTEMA DE CUENTAS TRIBUTARIAS', terminos: ['SISTEMA DE CUENTAS TRIBUTARIAS', 'CUENTAS TRIBUTARIAS'], fuente: '12-Comp', confirmado: false, extractor: 'generico',
    ruta: [{ selector: 'a.menu-a', opcional: true, continuar: true }, { texto: 'Consulta Compensaciones y Afectaciones' }] },
  // DDJJ y Pagos (seti, EJ2): la home arranca con un tutorial/intro ("Saltar intro"/"Continuar")
  // y, debajo, las tabs "Presentaciones" (DDJJ presentadas) y "Pagos". Saltamos la intro (opcional)
  // y abrimos "Presentaciones"; la grilla de componente la lee el extractor (e-grid/role=grid).
  { id: 'ddjj-y-pagos', nombre: 'PRESENTACIÓN DE DDJJ Y PAGOS', terminos: ['PRESENTACIÓN DE DDJJ Y PAGOS', 'PRESENTACION DE DDJJ'], fuente: 10, confirmado: false, extractor: 'generico',
    ruta: [{ texto: 'Entendido', opcional: true }, { texto: 'Saltar intro', opcional: true }, { texto: 'Presentaciones', opcional: true }] },
  // Portal IVA (Angular, siapweb/iva/#/...). Flujo real confirmado por capturas:
  //   home (#/init) --CONSULTAR "Declaraciones juradas presentadas"--> #/anteriores
  //   #/anteriores  --CONSULTAR "Declaración Jurada de IVA"--> #/declaraciones.anteriores (la LISTA)
  // La lista trae Período Fiscal / Formulario / Secuencia / Presentación de TODAS las DDJJ de IVA
  // presentadas. Paso 1: el CONSULTAR de la home (aria-label ...declaraciones.anteriores, el nombre
  // exacto varía entre .alt y .portal.alt, por eso matcheamos el común). Paso 2: saltamos por hash a
  // la lista (evita depender del 2º CONSULTAR, que comparte texto con el de "Libro IVA").
  { id: 'portal-iva', nombre: 'PORTAL IVA', terminos: ['PORTAL IVA'], fuente: 3, confirmado: false, extractor: 'generico',
    ruta: [{ selector: 'button[aria-label*="declaraciones.anteriores"]' }, { hash: '#/declaraciones.anteriores' }],
    columnasEsperadas: ['Periodo', 'Formulario', 'Secuencia', 'Presentacion'] },
  // Ganancias (GPH): la portada (diagnóstico 23-51-59) solo ofrece CREAR DJ (tarjetas; el CONTINUAR
  // lleva al F711 = presentación, VETADO). No expone consulta de DJ presentadas. No ruteamos a
  // ciegas: queda relevado. Sus DJ presentadas y pagos salen por Cuentas Tributarias (ct-ddjj/pagos).
  { id: 'ganancias-ph', nombre: 'GANANCIAS PERSONAS HUMANAS', terminos: ['GANANCIAS PERSONAS HUMANAS'], fuente: 8, confirmado: false, extractor: 'generico',
    ruta: [] },
  // Bienes Personales (F.762): la home muestra "Mis declaraciones juradas presentadas" (texto
  // confirmado) pero el botón CONSULTAR renderiza tarde y no se capturó. Intentamos abrir esa
  // sección por su texto (tarjeta/enlace) o por CONSULTAR; ambos opcionales. La grilla es async.
  { id: 'bienes-personales', nombre: 'BIENES PERSONALES WEB', terminos: ['BIENES PERSONALES WEB', 'BIENES PERSONALES'], fuente: 9, confirmado: false, extractor: 'generico',
    ruta: [{ texto: 'Mis declaraciones juradas presentadas', opcional: true }, { texto: 'CONSULTAR', opcional: true }] },
  { id: 'ccma', nombre: 'CCMA - CUENTA CORRIENTE DE CONTRIBUYENTES MONOTRIBUTISTAS Y AUTONOMOS', terminos: ['CCMA', 'CUENTA CORRIENTE DE CONTRIBUYENTES'], fuente: 13, confirmado: false, extractor: 'generico' },
  { id: 'mis-facilidades', nombre: 'MIS FACILIDADES', terminos: ['MIS FACILIDADES'], fuente: 15, confirmado: true, extractor: 'tabla',
    columnasEsperadas: ['Presentacion', 'Numero', 'Cuotas', 'Estado'] },
  // SIFERE (Convenio Multilateral) vive en COMARB (otro dominio), no en el listado de ARCA.
  // CONFIRMADO por capturas: con la misma clave fiscal se entra por la URL de inicio, se elige el
  // CUIT y se llega al módulo con los LISTADOS de DDJJ. Extractor dedicado 'sifere': entra por URL
  // directa, selecciona el CUIT y baja los listados de solo lectura (mensuales 83, anuales 5):
  //   Listado DDJJ Mensuales  -> MostrarListaDDJJController.do (Anticipo/Estado/Fecha/Presentación)
  //   Listado DDJJ Anuales    -> MostrarListaDDJJAnualController.do (Año/Estado/Fecha/Presentación)
  // NO toca "Nueva DJ" ni pagos: solo los listados. Resultado de presentación incluido.
  { id: 'sifere-consultas', nombre: 'SIFERE', terminos: ['SIFERE', 'CONVENIO MULTILATERAL'], fuente: 5, confirmado: false, extractor: 'sifere',
    url: 'https://sifereweb.comarb.gob.ar/sifereweb/InicioSistemaClaveFiscalController.do',
    grillas: [
      { id: 'ddjj-mensuales', url: 'https://sifereweb.comarb.gob.ar/sifereweb/MostrarListaDDJJController.do', columnasEsperadas: ['Anticipo', 'Estado', 'Presentacion'] },
      { id: 'ddjj-anuales', url: 'https://sifereweb.comarb.gob.ar/sifereweb/MostrarListaDDJJAnualController.do', columnasEsperadas: ['Año', 'Estado', 'Presentacion'] },
    ] },
  // Ventanilla = Domicilio Fiscal Electrónico (nombre real del servicio en el portal).
  { id: 'ventanilla', nombre: 'DOMICILIO FISCAL ELECTRÓNICO', terminos: ['DOMICILIO FISCAL ELECTRÓNICO', 'VENTANILLA'], fuente: 16, confirmado: false, extractor: 'generico' },
  // Mis Retenciones VA ÚLTIMO a propósito (ver nota de ORDEN arriba): su consulta itera impuesto
  // por impuesto en mirequa-web /resultados (combo EJ2 #selectImpuestos, no <select> nativo; hay
  // que volver al formulario entre impuestos) y es la pantalla más propensa a colgarse o fallar.
  // Dejándola al final, un problema acá no impide bajar el resto de los datos fiscales.
  { id: 'mis-retenciones', nombre: 'MIS RETENCIONES', terminos: ['MIS RETENCIONES'], fuente: 11, confirmado: true, extractor: 'tabla',
    selectores: { fechaDesde: '#fechaRetencionDesde__input', fechaHasta: '#fechaRetencionHasta__input', consultar: '#btnConsultarRetenciones' },
    requiereImpuesto: true, selectorImpuesto: '#selectImpuestos',
    // Consultamos los impuestos/regímenes relevantes para persona humana RI (IVA, Ganancias,
    // Bienes Personales, PAÍS, SICORE/SIRE), no los ~40 regímenes del combo.
    impuestosRelevantes: /sire|sicore|\biva\b|ganancia|gcias|\bgan\b|bienes?\s+personal|pa[ií]s/i,
    columnasEsperadas: ['Impuesto', 'Fecha', 'Importe'] },
];

export function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}
