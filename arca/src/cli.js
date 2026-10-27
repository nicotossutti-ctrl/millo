#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { Wsfe } from './wsfe.js';
import { getTicket } from './wsaa.js';
import { exportarEmitidos, escribirCsv, escribirReporte, resumenReporte } from './emitidos.js';
import { liquidacionAnual } from './ganancias.js';
import { cargarContribuyente, estimar, leerMeses, escribirEstimacion } from './estimacion.js';
import { Sesion } from './portal/sesion.js';
import { diagnosticar, inspeccionarPortal, limpiar, SERVICIOS } from './portal/diagnostico.js';
import { descargarMisComprobantes, diagnosticoMisComprobantes, pruebaConsulta } from './portal/misComprobantes.js';
import { ejecutarTodo } from './portal/orquestador.js';
import { SERVICIOS as SERVICIOS_FISCALES } from './portal/servicios.js';
import { escribirInformeIva } from './informeIva.js';
import { reprocesarDjIva } from './reprocesarDj.js';
import { actualizarPfos } from './pfos/actualizar.js';
import { generarClave, verificadorScram, guardarClaveEnEnv } from './pfos/clave.js';
import { iniciarServidor } from './app/servidor.js';
import { spawn } from 'node:child_process';

/** Abre la URL en el navegador predeterminado (sin esperar). */
function abrirNavegador(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* sin navegador: queda la URL en consola */ }
}
import fs from 'node:fs';
import path from 'node:path';

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

Aplicación (interfaz en el navegador, local, sin abrir ARCA):
  app [--puerto 4321] [--no-abrir]
                                Panel fiscal por mes (IVA, IIBB, Ganancias, obligaciones, rentabilidad) con
                                los datos conservados e importados; importación de CSV/Excel. Solo 127.0.0.1.

Informes (sin abrir ARCA, con los datos conservados en out/datos):
  informe:iva --periodo AAAA-MM  IVA del mes: comprobantes, declarado (DJ), pagado, retenciones, presentación,
                                vencimiento y deuda; conciliación solo con cifras existentes y validadas.
  pfos:clave [--nueva] [--texto]
                                Genera la clave del rol de solo lectura de PFOS (criptográfica), la guarda en .env y
                                muestra su verificador SCRAM para el SQL de acceso. La clave real no se muestra.
  pfos:actualizar --periodo AAAA-MM[,AAAA-MM]
                                Lee PFOS en solo lectura (solo la cuenta del contribuyente, verificada contra tus
                                comprobantes emitidos de ARCA) y guarda la foto del mes para Rentabilidad.
  dj:iva --periodo AAAA-MM      Vuelve a interpretar la DJ de IVA del mes con la última captura ya bajada
                                (vista + JSON de Portal IVA), sin abrir ARCA. Si queda validada, se conserva.

Portal (sesión autenticada con navegador, sin certificado):
  portal:login [--visible]      Inicia sesión en el portal y guarda las cookies en .sesion/. Sin ARCA_CLAVE
                                hay que usar --visible y tipear la clave a mano. Nunca elude CAPTCHA ni 2FA.
  portal:inspeccionar [--visible] [--sin-capturas]
                                Releva la página principal del portal (documento, frames, shadow DOM):
                                inputs, botones, enlaces, iframes y menús, saneados, en out/diagnostico/portal/.
                                Imprime un resumen para pegar en el chat. No abre ningún servicio.
  portal:diagnostico [--visible] [--sin-capturas] [--servicios "Mis Comprobantes,Portal IVA"]
                                Entra a cada servicio y guarda captura, HTML saneado y estructura en out/diagnostico/
                                (permisos 0600, CUIT e importes enmascarados, sin query strings ni cookies).
  portal:todo [--desde AAAA-MM-DD --hasta AAAA-MM-DD] [--servicios "id1,id2"] [--rehacer] [--visible]
                                Recorre TODOS los servicios fiscales en modo lectura, aísla fallos, descarga lo
                                que puede y guarda la corrida en out/corridas/<fecha>/ con un informe cobertura.md.
  portal:limpiar                Borra diagnóstico, descargas y sesión guardada.
  portal:mc-diagnostico --tipo recibidos|emitidos [--visible]
                                Entra a Mis Comprobantes > Recibidos/Emitidos por el enlace real y releva filtros,
                                botones y exportación, sin tocar nada. Resumen en out/diagnostico/mis-comprobantes-<tipo>/.
  portal:mc-consulta --tipo recibidos|emitidos --desde AAAA-MM-DD --hasta AAAA-MM-DD [--visible]
                                Prueba real de consulta: carga el rango en #fechaEmision, pulsa #buscarComprobantes,
                                abre Resultados y releva tablas, paginación y exportación. No descarga nada.
  portal:mis-comprobantes --tipo recibidos|emitidos --desde AAAA-MM-DD --hasta AAAA-MM-DD [--visible]
                                Consulta y, solo si hay exportación visible, descarga y valida el archivo.

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
    rehacer: { type: 'boolean', default: false },
    nueva: { type: 'boolean', default: false },
    texto: { type: 'boolean', default: false },
    servicios: { type: 'string' },
    periodo: { type: 'string' },
    puerto: { type: 'string' },
    'no-abrir': { type: 'boolean', default: false },
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

  if (cmd === 'informe:iva') {
    // No abre ARCA: usa solo lo conservado en out/datos.
    const cfg = loadConfig({ requireAuth: false });
    const mes = need('periodo');
    if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error('--periodo tiene que ser AAAA-MM (p. ej. 2026-09)');
    const r = escribirInformeIva(cfg.outDir ?? 'out', mes);
    console.log(r.texto);
    console.error(`\nInforme guardado en ${r.archivo}`);
    process.exit(0);
  }

  if (cmd === 'app') {
    const cfg = loadConfig({ requireAuth: false });
    const puerto = Number(o.puerto ?? 4321);
    if (!(puerto > 0 && puerto < 65536)) throw new Error('--puerto inválido');
    const { url } = await iniciarServidor({ outDir: cfg.outDir ?? 'out', puerto });
    console.error(`FiscalOS está abierto en ${url}  (dejá esta ventana abierta; Ctrl+C para cerrar)`);
    if (!o['no-abrir']) abrirNavegador(url);
    await new Promise(() => {}); // el servidor mantiene vivo el proceso hasta Ctrl+C
  }

  if (cmd === 'pfos:clave') {
    // Genera la clave del rol fiscalos_lectura con el generador criptográfico, la guarda SOLO en .env y muestra el
    // verificador SCRAM (la clave cifrada) para docs/pfos-acceso.sql. La clave real nunca se imprime.
    const env = path.resolve('.env');
    const previo = fs.existsSync(env) ? fs.readFileSync(env, 'utf8') : '';
    if (/^FISCALOS_PFOS_CLAVE=/m.test(previo) && !o.nueva) {
      throw new Error('ya hay una FISCALOS_PFOS_CLAVE en .env. Si el rol todavía no se creó o querés cambiarla, corré con --nueva (después hay que actualizar la clave del rol en Neon con el verificador nuevo)');
    }
    const clave = generarClave();
    guardarClaveEnEnv(env, clave);
    if (o.texto) {
      // Solo si Neon rechaza la clave cifrada: la clave real, una vez, para pegarla en el SQL en lugar de <VERIFICADOR>.
      console.log(clave);
      console.error(`\nClave guardada en ${env}. Arriba está la clave REAL (solo porque pediste --texto): pegala en el SQL y después borrá ese SQL del historial del SQL Editor de Neon.`);
    } else {
      console.log(verificadorScram(clave));
      console.error(`\nClave nueva guardada en ${env} (FISCALOS_PFOS_CLAVE). No se muestra ni se sube a GitHub.`);
      console.error('Arriba está el VERIFICADOR (la clave cifrada): pegalo en docs/pfos-acceso.sql en lugar de <VERIFICADOR>.');
    }
    process.exit(0);
  }

  if (cmd === 'pfos:actualizar') {
    // Lee PFOS en SOLO LECTURA (rol fiscalos_lectura) y guarda una foto por mes en out/pfos/. No escribe en PFOS.
    const cfg = loadConfig({ requireAuth: false });
    const meses = String(need('periodo')).split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!meses.length || meses.some((m) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(m))) throw new Error('--periodo tiene que ser AAAA-MM (uno o varios, separados por coma)');
    const fotos = await actualizarPfos({ outDir: cfg.outDir ?? 'out', meses });
    for (const f of fotos) {
      console.log(`\n${f.mes} · cuenta ${f.cuenta.verificada ? 'VERIFICADA' : 'NO verificada'}: ${f.cuenta.motivo}`);
      for (const [k, l] of Object.entries(f.lineas)) console.log(`  ${k}: ${l.importe} (${l.nivel}${l.completo ? ', completo' : `, INCOMPLETO: ${l.faltan.join('; ')}`})`);
      if (f.costo.sinCosto.length) console.log(`  sin costo: ${f.costo.sinCosto.slice(0, 10).map((x) => `${x.sku} (${x.unidades} u.: ${x.motivo})`).join(' · ')}`);
    }
    console.error('\nFotos guardadas en out/pfos/. Abrí la app para verlas en Rentabilidad.');
    process.exit(0);
  }

  if (cmd === 'dj:iva') {
    // No abre ARCA: reinterpreta la última captura de la vista de la DJ guardada en out/datos.
    const cfg = loadConfig({ requireAuth: false });
    const mes = need('periodo');
    if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error('--periodo tiene que ser AAAA-MM (p. ej. 2026-09)');
    const r = reprocesarDjIva({ datosDir: path.join(cfg.outDir ?? 'out', 'datos'), mes });
    console.log(fs.readFileSync(r.archivoAnalisis, 'utf8'));
    console.error(`Captura usada: ${r.corrida} · intento ${r.cuando}`);
    console.error(`Conservación: ${r.conservacion.promovido ? 'PROMOVIDO al vigente' : 'no promovido'} — ${r.conservacion.motivo}`);
    console.error(`Análisis guardado en ${r.archivoAnalisis}`);
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
      } else if (cmd === 'portal:inspeccionar') {
        await inspeccionarPortal(sesion, { sinCapturas: o['sin-capturas'], log: (m) => console.log(m) });
        console.error('\nGuardado en out/diagnostico/portal/. Pegá en el chat el contenido de resumen.txt.');
      } else if (cmd === 'portal:diagnostico') {
        const servicios = o.servicios ? o.servicios.split(',').map((x) => x.trim()) : SERVICIOS;
        print(await diagnosticar(sesion, { servicios, sinCapturas: o['sin-capturas'], log: (m) => console.error(m) }));
      } else if (cmd === 'portal:mc-diagnostico') {
        await diagnosticoMisComprobantes(sesion, { tipo: need('tipo'), sinCapturas: o['sin-capturas'], log: (m) => console.log(m) });
      } else if (cmd === 'portal:todo') {
        const hoy = new Date();
        const haceUnMes = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
        const finMesPasado = new Date(hoy.getFullYear(), hoy.getMonth(), 0);
        const periodo = { desde: o.desde ?? haceUnMes.toISOString().slice(0, 10), hasta: o.hasta ?? finMesPasado.toISOString().slice(0, 10), rehacer: o.rehacer };
        const pedidos = o.servicios ? o.servicios.split(',').map((x) => x.trim()) : null;
        const servicios = pedidos ? SERVICIOS_FISCALES.filter((s) => pedidos.includes(s.id)) : SERVICIOS_FISCALES;
        if (!servicios.length) throw new Error(`Ningún servicio coincide con --servicios. Ids: ${SERVICIOS_FISCALES.map((s) => s.id).join(', ')}`);
        const { baseDir, cobertura } = await ejecutarTodo(sesion, { servicios, periodo, log: (m) => console.error(m) });
        console.log('\n' + cobertura.texto);
        console.error(`\nCorrida guardada en ${baseDir}`);
      } else if (cmd === 'portal:mc-consulta') {
        await pruebaConsulta(sesion, { tipo: need('tipo'), desde: need('desde'), hasta: need('hasta'), sinCapturas: o['sin-capturas'], log: (m) => console.log(m) });
      } else if (cmd === 'portal:mis-comprobantes') {
        print(await descargarMisComprobantes(sesion, { tipo: need('tipo'), desde: need('desde'), hasta: need('hasta'), rehacer: o.rehacer, log: (m) => console.error(m) }));
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
