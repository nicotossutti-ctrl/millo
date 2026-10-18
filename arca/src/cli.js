#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { Wsfe } from './wsfe.js';
import { getTicket } from './wsaa.js';
import { exportarEmitidos, escribirCsv, signo } from './emitidos.js';
import { liquidacionAnual } from './ganancias.js';
import { cargarContribuyente, estimar, leerMeses, escribirEstimacion } from './estimacion.js';

const USO = `Uso: npm run arca -- <comando> [opciones]

Comandos:
  dummy                         Estado de los servidores de WSFE (sin certificado)
  login                         Pide (o muestra) el ticket de acceso WSAA para wsfe
  ptos-venta                    Puntos de venta habilitados
  tipos-cbte                    Tipos de comprobante vigentes
  ultimo --pto N --tipo T       Último comprobante autorizado
  consultar --pto N --tipo T --nro X
  emitidos --desde AAAA-MM-DD --hasta AAAA-MM-DD [--tipos 1,2,3,6,7,8] [--pto 1,2] [--out out/emitidos.csv]
                                (sin --tipos recorre todos los tipos vigentes; sin --pto, todos los puntos de venta)
  ganancias --anio 2026 --neto 50000000 [--generales 1900000]
                                Liquidación anual simplificada de Ganancias para un resultado neto dado
  estimar --anio 2026 --meses out/meses.csv [--proyeccion 60000000] [--out out/estimacion.csv]
                                Provisión mensual de IIBB, autónomos y Ganancias; "ganancia real" por mes.
                                meses.csv: Mes;Ventas netas;Gastos netos. Usa params/contribuyente.json

Variables (.env): ARCA_ENV, ARCA_CUIT, ARCA_CERT, ARCA_KEY`;

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
      const rows = await exportarEmitidos(wsfe, cfg, {
        desde,
        hasta,
        tipos: o.tipos ? lista(o.tipos) : null,
        ptos: o.pto ? lista(o.pto) : null,
        log: (m) => console.error(m),
      });
      if (o.json) {
        print(rows);
      } else {
        const file = escribirCsv(cfg, rows, o.out);
        const total = rows.reduce((s, r) => s + r.impTotal * signo(r.cbteTipo), 0);
        console.error(`${rows.length} comprobantes, total neto de NC: ${total.toFixed(2)} -> ${file}`);
      }
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
