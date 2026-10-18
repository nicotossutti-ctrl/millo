#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { Wsfe } from './wsfe.js';
import { getTicket } from './wsaa.js';
import { exportarEmitidos, escribirCsv, escribirReporte, resumenReporte } from './emitidos.js';
import { liquidacionAnual } from './ganancias.js';
import { cargarContribuyente, estimar, leerMeses, escribirEstimacion } from './estimacion.js';
import { Sesion } from './portal/sesion.js';
import { diagnosticar, limpiar, SERVICIOS } from './portal/diagnostico.js';
import { descargarMisComprobantes } from './portal/misComprobantes.js';

const USO = `Uso: npm run arca -- <comando> [opciones]

Comandos:
  dummy                         Estado de los servidores de WSFE (sin certificado)
  login                         Pide (o muestra) el ticket de acceso WSAA para wsfe
  ptos-venta                    Puntos de venta habilitados
  tipos-cbte                    Tipos de comprobante vigentes
  ultimo --pto N --tipo T       Último comprobante autorizado
  consultar --pto N --tipo T --nro X
  emitidos --desde AAAA-MM-DD --hasta AAAA-MM-DD [--tipos 1,2,3,6,7,8] [--pto 1,2] [--completo] [--out out/emitidos.csv]
                                Exporta CSV + reporte de integridad JSON. Sin --tipos recorre todos los tipos
                                vigentes; sin --pto, todos los puntos de venta (bloqueados incluidos).
                                --completo recorre cada serie desde el número 1 (primera carga o verificación).
  ganancias --anio 2026 --neto 50000000 [--generales 1900000]
                                Liquidación anual simplificada de Ganancias para un resultado neto dado
  estimar --anio 2026 --meses out/meses.csv [--proyeccion 60000000] [--out out/estimacion.csv]
                                Provisión mensual de IIBB, autónomos y Ganancias; "ganancia real" por mes.
                                meses.csv: Mes;Ventas netas;Gastos netos. Usa params/contribuyente.json

Portal (sesión autenticada con navegador, sin certificado):
  portal:login [--visible]      Inicia sesión en el portal y guarda las cookies en .sesion/. Sin ARCA_CLAVE
                                hay que usar --visible y tipear la clave a mano. Nunca elude CAPTCHA ni 2FA.
  portal:diagnostico [--visible] [--sin-capturas] [--servicios "Mis Comprobantes,Portal IVA"]
                                Entra a cada servicio y guarda captura, HTML saneado y estructura en out/diagnostico/
                                (permisos 0600, CUIT e importes enmascarados, sin query strings ni cookies).
  portal:limpiar                Borra diagnóstico, descargas y sesión guardada.
  portal:mis-comprobantes --tipo emitidos|recibidos --desde AAAA-MM-DD --hasta AAAA-MM-DD [--visible]
                                Descarga la exportación de Mis Comprobantes (tramos de hasta 365 días).

Variables (.env): ARCA_ENV, ARCA_CUIT, ARCA_CERT, ARCA_KEY, ARCA_CLAVE (opcional, solo para portal)`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pto: { type: 'string' },
    tipo: { type: 'string' },
    nro: { type: 'string' },
    desde: { type: 'string' },
    hasta: { type: 'string' },
    tipos: { type: 'string' },
    out: { type: 'string' },
    anio: { type: 'string' },
    neto: { type: 'string' },
    generales: { type: 'string' },
    meses: { type: 'string' },
    proyeccion: { type: 'string' },
    json: { type: 'boolean', default: false },
    completo: { type: 'boolean', default: false },
    visible: { type: 'boolean', default: false },
    'sin-capturas': { type: 'boolean', default: false },
    servicios: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const cmd = positionals[0];
const print = (x) => console.log(JSON.stringify(x, null, 2));
const need = (name) => {
  if (!o[name]) throw new Error(`Falta --${name}`);
  return o[name];
};
const lista = (s) => s.split(',').map((x) => Number(x.trim())).filter(Boolean);

try {
  if (!cmd || o.help) {
    console.log(USO);
    process.exit(0);
  }
  if (cmd === 'dummy') {
    const cfg = loadConfig({ requireAuth: false });
    print(await new Wsfe(cfg).dummy());
    process.exit(0);
  }
  if (cmd === 'ganancias') {
    const anio = Number(need('anio'));
    let contribuyente = {};
    try { contribuyente = cargarContribuyente().contribuyente; } catch { /* sin perfil: deducción especial ap. 1, sin cargas */ }
    print(liquidacionAnual(anio, { resultadoNeto: Number(need('neto')), deduccionesGenerales: Number(o.generales ?? contribuyente.deduccionesGeneralesAnuales ?? 0) }, contribuyente));
    process.exit(0);
  }
  if (cmd === 'estimar') {
    const anio = Number(need('anio'));
    const { contribuyente, avisos } = cargarContribuyente();
    for (const a of avisos) console.error(`Aviso: ${a}`);
    const rows = estimar(anio, leerMeses(need('meses')), contribuyente, { proyeccionAnual: o.proyeccion ? Number(o.proyeccion) : null });
    if (o.json) {
      print(rows);
    } else {
      const file = escribirEstimacion(rows, o.out ?? 'out/estimacion.csv');
      const f = (n) => n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).padStart(14);
      console.log('Mes       Resultado bruto      IIBB   Autónomos   Ganancias  Ganancia real  Carga %');
      for (const r of rows) console.log(`${r.mes}  ${f(r.resultadoBruto)} ${f(r.iibb)} ${f(r.autonomos)} ${f(r.ganancias)} ${f(r.gananciaReal)}  ${String(r.cargaTributaria).padStart(6)}`);
      const u = rows.at(-1);
      console.log(`\nProyección anual neta: ${f(u.proyeccionAnual)}  Ganancias anual proyectado: ${f(u.impuestoAnualProyectado)}  Provisionado a la fecha: ${f(u.gananciasAcumulada)}`);
      console.error(`-> ${file}`);
    }
    process.exit(0);
  }

  if (cmd === 'portal:limpiar') {
    const cfg = loadConfig({ requireAuth: false });
    print({ borrados: limpiar({ outDir: cfg.outDir, sesionDir: cfg.sesionDir }) });
    process.exit(0);
  }
  if (cmd.startsWith('portal:')) {
    const cfg = loadConfig({ requireAuth: 'cuit' });
    const sesion = new Sesion(cfg, { visible: o.visible, log: (m) => console.error(m) });
    await sesion.abrir();
    try {
      await sesion.asegurarLogin();
      if (cmd === 'portal:login') {
        console.log('OK: sesión guardada.');
      } else if (cmd === 'portal:diagnostico') {
        const servicios = o.servicios ? o.servicios.split(',').map((x) => x.trim()) : SERVICIOS;
        print(await diagnosticar(sesion, { servicios, sinCapturas: o['sin-capturas'], log: (m) => console.error(m) }));
      } else if (cmd === 'portal:mis-comprobantes') {
        print(await descargarMisComprobantes(sesion, { tipo: need('tipo'), desde: need('desde'), hasta: need('hasta'), log: (m) => console.error(m) }));
      } else {
        throw new Error(`Comando desconocido: ${cmd}`);
      }
    } finally {
      await sesion.cerrar();
    }
    process.exit(0);
  }

  const cfg = loadConfig();
  const wsfe = new Wsfe(cfg);

  switch (cmd) {
    case 'login': {
      const ta = await getTicket(cfg, 'wsfe');
      print({ service: ta.service, generationTime: ta.generationTime, expirationTime: ta.expirationTime });
      break;
    }
    case 'ptos-venta':
      print(await wsfe.ptosVenta());
      break;
    case 'tipos-cbte':
      print(await wsfe.tiposCbte());
      break;
    case 'ultimo':
      print({ ultimo: await wsfe.ultimoAutorizado(Number(need('pto')), Number(need('tipo'))) });
      break;
    case 'consultar':
      print(await wsfe.consultar(Number(need('pto')), Number(need('tipo')), Number(need('nro'))));
      break;
    case 'emitidos': {
      const desde = need('desde');
      const hasta = need('hasta');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
        throw new Error('--desde y --hasta deben ser AAAA-MM-DD');
      }
      const { rows, reporte } = await exportarEmitidos(wsfe, cfg, {
        desde,
        hasta,
        tipos: o.tipos ? lista(o.tipos) : null,
        ptos: o.pto ? lista(o.pto) : null,
        completo: o.completo,
        log: (m) => console.error(m),
      });
      const rep = escribirReporte(cfg, reporte);
      if (o.json) {
        print({ reporte, comprobantes: rows });
      } else {
        const file = escribirCsv(cfg, rows, o.out);
        for (const l of resumenReporte(reporte)) console.error(l);
        console.error(`${rows.length} comprobantes, total con signo ${reporte.totales.totalConSigno.toFixed(2)} -> ${file}`);
        console.error(`Reporte de integridad -> ${rep}`);
      }
      if (!reporte.completo) process.exit(3);
      break;
    }
    default:
      console.error(`Comando desconocido: ${cmd}\n\n${USO}`);
      process.exit(2);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
