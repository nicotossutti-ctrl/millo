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

// Encabezados de la grilla de Vencimientos de la home de Cuentas Tributarias (la del servicio
// cuentas-tributarias). Si un ct-* lee ESA grilla, la ruta no llegó a su sección y no cuenta.
const RECHAZAR_VENCIMIENTOS = ['impuesto', 'concepto', 'periodo', 'vencimiento'];
// Cuentas Tributarias: CT_SISTEMA es la página del sistema (con el menú); si no carga, no se llegó
// (p. ej. quedó en el login de ARCA): fallo de navegación, nunca un cero. CT_HOME es el iframe de la
// home (pestañas Vencimientos/Deudas). OJO (corrida 2026-10-24T20-38-29): el sistema RECUERDA la
// última pantalla; tras DJ, reabrirlo no muestra la home. Por eso solo Vencimientos y Deudas exigen
// la home (frameInicio) y, si no está, vuelven por el enlace "Inicio" del menú.
const CT_SISTEMA = 'ctacte.cloud.afip.gob.ar/contribuyente/externo';
const CT_HOME = 'ctacte.cloud.afip.gob.ar/contribuyente/scripts/vue/homeContribuyente';
// Corrida 2026-10-26T20-04-19 (ct-pagos): quedó en .../externo con la página VACÍA (título vacío,
// 5 elementos, sin enlaces, botones, formularios ni iframes) y pasaba el control de requiereFrame.
// La interfaz cargada tiene, en alguna página del sistema, al menos uno de estos elementos ya vistos
// en corridas reales: el botón hamburguesa del menú (a.menu-a), los <a> del menú Tapestry
// (href ...panelMenu..., diagnóstico 19-49-58) o los iframes Vue de cada pantalla (scripts/vue/...).
// Si ninguno aparece: se espera, se reintenta el acceso una vez y, si sigue, "servicio no cargado".
const CT_INTERFAZ = { frame: 'ctacte.cloud.afip.gob.ar/contribuyente/', selectores: ['a.menu-a', 'a[href*="panelMenu"]', 'iframe'] };

export const SERVICIOS = [
  // SIFERE va PRIMERO (corrida 2026-10-24T19-39-01): llegaba ~25 minutos después del login, cuando
  // COMARB ya no tomaba la sesión de ARCA y pedía login de nuevo. Recién logueados, el SSO pasa
  // solo; y si pide clave, la persona todavía está frente a la pantalla. Abre en pestaña propia.
  // SIFERE (Convenio Multilateral) vive en COMARB (otro dominio), no en el listado de ARCA.
  // CONFIRMADO por capturas: con la misma clave fiscal se entra por la URL de inicio, se elige el
  // CUIT y se llega al módulo con los LISTADOS de DDJJ. Extractor dedicado 'sifere': entra por URL
  // directa, selecciona el CUIT y baja los listados de solo lectura (mensuales 83, anuales 5):
  //   Listado DDJJ Mensuales  -> MostrarListaDDJJController.do (Anticipo/Estado/Fecha/Presentación)
  //   Listado DDJJ Anuales    -> MostrarListaDDJJAnualController.do (Año/Estado/Fecha/Presentación)
  // NO toca "Nueva DJ" ni pagos: solo los listados. Resultado de presentación incluido.
  // Entrada por el LOGIN de clave fiscal de AFIP con el parámetro del sistema SIFERE (confirmado por
  // el usuario): esta URL establece la sesión de COMARB (la URL directa caía en 'Sesión Expirada').
  // Como el robot ya tiene la sesión de AFIP abierta (login de ARCA), pasa por SSO sin reescribir la
  // clave; si expiró, se completa en el navegador visible. Luego redirige a Seleccionar CUIT.
  // Corrida 2026-10-25T14-51-11: entrar por la URL de login de COMARB terminó en "Sesión Expirada";
  // el portal de ARCA ya muestra el acceso "Convenio Multilateral – SIFERE WEB - DDJJ". Se entra por
  // ese acceso, como cualquier servicio: la sesión de ARCA pasa sola (sin segunda clave) y abre en
  // pestaña propia. Si igual pidiera login, abrirServicio espera a que la persona lo complete.
  // 2026-10-28 (revisión de la PR #2): la Comisión Arbitral separa «SIFERE WEB – DDJJ» (confeccionar y presentar) de
  // «SIFERE WEB – Consultas» (DJ presentadas, pagos y retenciones), y el portal muestra los dos accesos. Esta entrada
  // es SOLO de relevamiento: entra por Consultas, espera el ingreso a COMARB como la otra y releva la pantalla (con la
  // muestra de filas y acciones) SIN hacer clic en nada. Con esa evidencia se escribe el lector de la CM03 presentada.
  { id: 'sifere-consultas-web', nombre: 'SIFERE (Consultas)', terminos: ['SIFERE WEB - CONSULTAS', 'CONVENIO MULTILATERAL – SIFERE WEB - CONSULTAS', 'CONVENIO MULTILATERAL - SIFERE WEB - CONSULTAS'],
    fuente: '5-consultas', confirmado: false, extractor: 'sifere', grillas: [], soloRelevamiento: true },
  // Además de los listados, baja el «Reporte» (PDF) de cada CM03 presentada del período y lo lee (sifereReporte.js):
  // solo el control inequívoco de reporte/impresión de la fila; nunca «Pago» ni «Crear DJ a partir de copia».
  { id: 'sifere-consultas', nombre: 'SIFERE', terminos: ['SIFERE WEB - DDJJ', 'CONVENIO MULTILATERAL – SIFERE WEB - DDJJ'], fuente: 5, confirmado: false, extractor: 'sifere',
    reportesCm03: 'https://sifereweb.comarb.gob.ar/sifereweb/MostrarListaDDJJController.do',
    grillas: [
      { id: 'ddjj-mensuales', url: 'https://sifereweb.comarb.gob.ar/sifereweb/MostrarListaDDJJController.do', columnasEsperadas: ['Anticipo', 'Estado', 'Presentacion'] },
      { id: 'ddjj-anuales', url: 'https://sifereweb.comarb.gob.ar/sifereweb/MostrarListaDDJJAnualController.do', columnasEsperadas: ['Año', 'Estado', 'Presentacion'] },
      // Volantes de Pago de DDJJ: los PAGOS reales de IIBB (Monto Total, Medio de Pago, N° VEP,
      // Estado, Resultado). URL confirmada por captura. Solo lectura (no se paga nada).
      { id: 'volantes-pago', url: 'https://sifereweb.comarb.gob.ar/sifereweb/MostrarListaVolantesPagoController.do', columnasEsperadas: ['Anticipo', 'Monto Total', 'Medio de Pago'] },
    ] },
  { id: 'comprobantes-recibidos', nombre: 'Mis Comprobantes', terminos: ['MIS COMPROBANTES'], fuente: 2, confirmado: true, extractor: 'mis-comprobantes', tipo: 'recibidos' },
  { id: 'comprobantes-emitidos', nombre: 'Mis Comprobantes', terminos: ['MIS COMPROBANTES'], fuente: '1b', confirmado: true, extractor: 'mis-comprobantes', tipo: 'emitidos' },
  // Vencimientos (home de Cuentas Tributarias). Corrida 2026-10-24: quedó en el login de ARCA y dio 0
  // filas; además la pestaña activa puede ser otra (Deudas). Ahora: se verifica que cargó la home,
  // se elige EXPRESAMENTE la pestaña Vencimientos y se lee solo el iframe Vue.
  { id: 'cuentas-tributarias', nombre: 'SISTEMA DE CUENTAS TRIBUTARIAS', terminos: ['SISTEMA DE CUENTAS TRIBUTARIAS', 'CUENTAS TRIBUTARIAS'], fuente: 12, confirmado: true, extractor: 'generico',
    requiereFrame: CT_SISTEMA, interfazCargada: CT_INTERFAZ, frameInicio: CT_HOME, frameDatos: 'scripts/vue/homeContribuyente',
    ruta: [{ selector: 'a[role=tab]:has-text("Vencimientos")' }],
    columnasEsperadas: ['Impuesto', 'Concepto', 'Periodo', 'Vencimiento'] },
  // Pestaña "Deudas N" de la misma home (iframe Vue homeContribuyente, diagnóstico 19-49-58): grilla
  // Establecimiento/Impuesto/Concepto/Subconcepto/Período/Ant-Cuota/Vencimiento, oculta hasta abrir
  // la pestaña. "Establecimiento" la distingue de Vencimientos (que no la tiene). Solo lectura.
  { id: 'ct-deudas', nombre: 'SISTEMA DE CUENTAS TRIBUTARIAS', terminos: ['SISTEMA DE CUENTAS TRIBUTARIAS', 'CUENTAS TRIBUTARIAS'], fuente: '12-Deudas', confirmado: false, extractor: 'generico',
    requiereFrame: CT_SISTEMA, interfazCargada: CT_INTERFAZ, frameInicio: CT_HOME, frameDatos: 'scripts/vue/homeContribuyente',
    columnasEsperadas: ['Establecimiento', 'Impuesto', 'Concepto', 'Periodo', 'Vencimiento'],
    ruta: [{ selector: 'a[role=tab]:has-text("Deudas")' }] },
  // Sub-rutas del Sistema de Cuentas Tributarias (frame legacy ctacte). CONFIRMADO por capturas:
  // el menú "Consultas" NO es un dropdown que se expande con un clic al <a> oculto (eso no cambiaba
  // la pantalla: caía siempre en la grilla Vue de Vencimientos), sino una BARRA LATERAL izquierda
  // que se abre con el botón hamburguesa (a.menu-a). Una vez abierta, DJ / Pagos / Cuenta Corriente
  // / Compensaciones son enlaces VISIBLES; cada uno abre su propio FORMULARIO (Fecha Desde/Hasta +
  // CONSULTAR, o SIGUIENTE para DJ). Por eso: paso 1 abre la barra, paso 2 entra a la sección; el
  // extractor genérico completa las fechas del período y consulta. Solo lectura.
  // Respaldo (respaldoEnlace): el NavBar dibuja los ítems visibles aparte y en varias corridas el ítem
  // no apareció. Los <a> REALES del menú (ocultos) tienen el texto exacto y el href de la sección
  // (diagnóstico 19-49-58: .../externo?service=partial/1/Home/Home/panelMenu.$PartialLink&sp=...&sp=SPagos).
  // Si el ítem visible no aparece, se navega a ese href: es la misma URL de consulta que abre el
  // menú, del mismo host, y se veta si el texto o el título parecen trámite (enlaceDeConsultaValido).
  // Sin columnas propias confirmadas todavía, lo que se lea queda 'con-datos' (no validado) y con
  // sus encabezados reales en el informe, para confirmarlas.
  // DJ: su formulario EXIGE elegir Establecimiento = "0" (confirmado) antes de SIGUIENTE; con eso
  // (y dejando Impuesto/Formulario sin tocar) trae todas las DJ. requiereEstablecimiento lo maneja.
  { id: 'ct-ddjj', nombre: 'SISTEMA DE CUENTAS TRIBUTARIAS', terminos: ['SISTEMA DE CUENTAS TRIBUTARIAS', 'CUENTAS TRIBUTARIAS'], fuente: '12-DJ', confirmado: false, extractor: 'generico',
    requiereFrame: CT_SISTEMA, interfazCargada: CT_INTERFAZ, frameDatos: 'scripts/vue/',
    // Columnas reales (diagnóstico 2026-10-24): Est. / Formulario / Versión / Impuesto / Periodo / Descripción / Observaciones / Detalle DJ.
    columnasEsperadas: ['Formulario', 'Version', 'Impuesto', 'Periodo', 'Descripcion'],
    rechazarSiColumnas: RECHAZAR_VENCIMIENTOS,
    requiereEstablecimiento: true,
    ruta: [{ selector: 'a.menu-a', opcional: true, continuar: true, siNoVisible: 'Declaraciones Juradas (DJ)' }, { texto: 'Consultas', opcional: true, continuar: true, siNoVisible: 'Declaraciones Juradas (DJ)' }, { texto: 'Declaraciones Juradas (DJ)', respaldoEnlace: true }] },
  { id: 'ct-pagos', nombre: 'SISTEMA DE CUENTAS TRIBUTARIAS', terminos: ['SISTEMA DE CUENTAS TRIBUTARIAS', 'CUENTAS TRIBUTARIAS'], fuente: '12-Pagos', confirmado: false, extractor: 'generico',
    requiereFrame: CT_SISTEMA, interfazCargada: CT_INTERFAZ, frameDatos: 'scripts/vue/',
    rechazarSiColumnas: RECHAZAR_VENCIMIENTOS,
    ruta: [{ selector: 'a.menu-a', opcional: true, continuar: true, siNoVisible: 'Pagos' }, { texto: 'Consultas', opcional: true, continuar: true, siNoVisible: 'Pagos' }, { texto: 'Pagos', respaldoEnlace: true }],
    // Formulario Fecha Desde/Hasta + CONSULTAR. Columnas REALES (corrida 2026-10-24T19-39-01):
    // Fecha Operación / Formulario / Versión / Impuesto / Período Fiscal / Importe / Observaciones.
    filtroPeriodo: true,
    columnasEsperadas: ['Fecha Operacion', 'Formulario', 'Impuesto', 'Periodo Fiscal', 'Importe'],
    columnaFecha: 'Fecha Operacion' },
  { id: 'ct-cuenta-corriente', nombre: 'SISTEMA DE CUENTAS TRIBUTARIAS', terminos: ['SISTEMA DE CUENTAS TRIBUTARIAS', 'CUENTAS TRIBUTARIAS'], fuente: '12-CtaCte', confirmado: false, extractor: 'generico',
    // "Detalle de Deuda Consolidada" es un FORMULARIO (diagnóstico 2026-10-24): combo "Trámite"
    // (INCUMPLIMIENTOS COMPLETOS / DEUDA EXIGIBLE Y FALTA DE PRESENTACION / CONSULTA DEUDA PROVEEDORES
    // DEL ESTADO) + CONSULTAR. Esta fuente consulta la deuda exigible; ct-incumplimientos, la otra.
    requiereFrame: CT_SISTEMA, interfazCargada: CT_INTERFAZ, frameDatos: 'scripts/vue/deudaConsolidada',
    seleccionarOpcion: 'DEUDA EXIGIBLE Y FALTA DE PRESENTACION',
    // Cartel real cuando no hay deuda (corrida 2026-10-25): cero confirmado por ARCA en esta pantalla.
    mensajesCero: ['No registra deudas'],
    rechazarSiColumnas: RECHAZAR_VENCIMIENTOS,
    // "Cuenta Corriente" es un ENCABEZADO de sección de la barra (no abre nada): se expande y se
    // entra a la hoja "Detalle de Deuda Consolidada". Antes los 5 registros eran la grilla de la home.
    ruta: [{ selector: 'a.menu-a', opcional: true, continuar: true, siNoVisible: 'Detalle de Deuda Consolidada' }, { texto: 'Cuenta Corriente', opcional: true, continuar: true, siNoVisible: 'Detalle de Deuda Consolidada' }, { texto: 'Detalle de Deuda Consolidada', respaldoEnlace: true }] },
  { id: 'ct-incumplimientos', nombre: 'SISTEMA DE CUENTAS TRIBUTARIAS', terminos: ['SISTEMA DE CUENTAS TRIBUTARIAS', 'CUENTAS TRIBUTARIAS'], fuente: '12-Incump', confirmado: false, extractor: 'generico',
    requiereFrame: CT_SISTEMA, interfazCargada: CT_INTERFAZ, frameDatos: 'scripts/vue/deudaConsolidada',
    seleccionarOpcion: 'INCUMPLIMIENTOS COMPLETOS',
    mensajesCero: ['No registra deudas'],
    rechazarSiColumnas: RECHAZAR_VENCIMIENTOS,
    ruta: [{ selector: 'a.menu-a', opcional: true, continuar: true, siNoVisible: 'Detalle de Deuda Consolidada' }, { texto: 'Cuenta Corriente', opcional: true, continuar: true, siNoVisible: 'Detalle de Deuda Consolidada' }, { texto: 'Detalle de Deuda Consolidada', respaldoEnlace: true }] },
  { id: 'ct-compensaciones', nombre: 'SISTEMA DE CUENTAS TRIBUTARIAS', terminos: ['SISTEMA DE CUENTAS TRIBUTARIAS', 'CUENTAS TRIBUTARIAS'], fuente: '12-Comp', confirmado: false, extractor: 'generico',
    requiereFrame: CT_SISTEMA, interfazCargada: CT_INTERFAZ, frameDatos: 'scripts/vue/consultaCompensacionesAfectaciones',
    mensajesCero: ['No se encontraron resultados'],
    rechazarSiColumnas: RECHAZAR_VENCIMIENTOS,
    ruta: [{ selector: 'a.menu-a', opcional: true, continuar: true, siNoVisible: 'Consulta Compensaciones y Afectaciones' }, { texto: 'Consultas', opcional: true, continuar: true, siNoVisible: 'Consulta Compensaciones y Afectaciones' }, { texto: 'Consulta Compensaciones y Afectaciones', respaldoEnlace: true }],
    filtroPeriodo: true },
  // DDJJ y Pagos (seti, EJ2): la home arranca con un tutorial/intro ("Saltar intro"/"Continuar")
  // y, debajo, las tabs "Presentaciones" (DDJJ presentadas) y "Pagos". Saltamos la intro (opcional)
  // y abrimos "Presentaciones"; la grilla de componente la lee el extractor (e-grid/role=grid).
  // Presentación de DDJJ y Pagos (setiweb, Angular). El diagnóstico del 25/10 muestra el menú lateral con rutas de
  // LECTURA: «Consulta de DDJJ presentadas» (#/presentacion/consulta) y «Consulta de VEP» (#/pago/consulta-veps); se
  // entra por hash, como en Portal IVA. Nunca «Presentación de declaración jurada» (#/presentacion/presentacion) ni
  // «Gestión de VEP» (#/pago/nuevo-vep). Las grillas todavía no se vieron: el relevamiento con muestra las va a mostrar.
  { id: 'ddjj-y-pagos', nombre: 'PRESENTACIÓN DE DDJJ Y PAGOS', terminos: ['PRESENTACIÓN DE DDJJ Y PAGOS', 'PRESENTACION DE DDJJ'], fuente: 10, confirmado: false, extractor: 'generico',
    ruta: [{ texto: 'Entendido', opcional: true }, { texto: 'Saltar intro', opcional: true }, { hash: '#/presentacion/consulta' },
      { texto: 'Consultar', opcional: true }, { texto: 'Buscar', opcional: true }] },
  { id: 'ddjj-y-pagos-veps', nombre: 'PRESENTACIÓN DE DDJJ Y PAGOS', terminos: ['PRESENTACIÓN DE DDJJ Y PAGOS', 'PRESENTACION DE DDJJ'], fuente: '10-veps', confirmado: false, extractor: 'generico',
    ruta: [{ texto: 'Entendido', opcional: true }, { texto: 'Saltar intro', opcional: true }, { hash: '#/pago/consulta-veps' },
      { texto: 'Consultar', opcional: true }, { texto: 'Buscar', opcional: true }] },
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
  // Detalle (importes) de la DJ de IVA de cada mes del período: misma lista de Portal IVA, pero
  // abre "Ver declaración jurada" de la DJ vigente del mes y lee sus conceptos; además descarga el
  // acuse como comprobante local. Generar VEP y Rectificar están vetados. Ver ivaDdjj.js.
  { id: 'portal-iva-ddjj', nombre: 'PORTAL IVA', terminos: ['PORTAL IVA'], fuente: '3-DJ', confirmado: false, extractor: 'iva-ddjj',
    ruta: [{ selector: 'button[aria-label*="declaraciones.anteriores"]' }, { hash: '#/declaraciones.anteriores' }] },
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
  // CCMA: lector propio (ccma.js) para sus tablas sin <th>; solo lee, sin completar campos ni tocar «Pagar» (Pag_Princ).
  { id: 'ccma', nombre: 'CCMA - CUENTA CORRIENTE DE CONTRIBUYENTES MONOTRIBUTISTAS Y AUTONOMOS', terminos: ['CCMA', 'CUENTA CORRIENTE DE CONTRIBUYENTES'], fuente: 13, confirmado: false, extractor: 'ccma',
    columnasEsperadas: ['Periodo'] },
  { id: 'mis-facilidades', nombre: 'MIS FACILIDADES', terminos: ['MIS FACILIDADES'], fuente: 15, confirmado: true, extractor: 'tabla',
    columnasEsperadas: ['Presentacion', 'Numero', 'Cuotas', 'Estado'] },
  // Ventanilla = Domicilio Fiscal Electrónico (nombre real del servicio en el portal).
  // Columnas reales (diagnóstico 19-49-58): Notificado / Asunto / Organismo / Representado / Clasificación / Recibido.
  { id: 'ventanilla', nombre: 'DOMICILIO FISCAL ELECTRÓNICO', terminos: ['DOMICILIO FISCAL ELECTRÓNICO', 'VENTANILLA'], fuente: 16, confirmado: false, extractor: 'generico',
    columnasEsperadas: ['Asunto', 'Organismo', 'Recibido'] },
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
    columnasEsperadas: ['Impuesto', 'Fecha', 'Importe'],
    // La consulta filtra por fecha de retención: cada fila debe caer en el período pedido.
    columnaFecha: 'Fecha' },
];

export function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}
