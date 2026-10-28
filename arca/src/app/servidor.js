/**
 * Servidor local de la interfaz de FiscalOS. Solo escucha en 127.0.0.1 (no es accesible desde otra
 * computadora) y rechaza pedidos con otro Host u Origin (protección contra sitios web que intenten
 * hablarle al servidor local). No abre ARCA: muestra lo conservado y lo importado.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { panelMes, mesesDisponibles, mesAnterior } from './panel.js';
import { pendientesDeCarga } from './pendientes.js';
import { guardarManual, eliminarManual } from './manuales.js';
import { importarCm03, listarCm03, eliminarCm03 } from './cm03.js';
import { importarDdjjGanancias, listarDdjjGanancias, eliminarDdjjGanancias } from './ddjjGanancias.js';
import { importarPdfFiscal } from './pdfFiscal.js';
import { analizarArchivo, vistaPendiente, simularImportacion, confirmarImportacion, eliminarImportacion, listarImportaciones, CONCEPTOS } from './importar.js';

const PUBLICO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ESTATICOS = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/estilos.css': ['estilos.css', 'text/css; charset=utf-8'] };
const LIMITE_CUERPO = 40 * 1024 * 1024; // un Excel mensual de 20-30 MB en base64

const hoyLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    const partes = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > LIMITE_CUERPO) { reject(Object.assign(new Error('archivo demasiado grande'), { status: 413 })); req.destroy(); } else partes.push(c); });
    req.on('end', () => { try { resolve(n ? JSON.parse(Buffer.concat(partes).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('pedido inválido'), { status: 400 })); } });
    req.on('error', reject);
  });
}

/** Crea el servidor (sin escuchar). `opciones.hoy` permite fijar la fecha en pruebas. */
export function crearServidor({ outDir = 'out', paramsFile = path.resolve('params/contribuyente.json'), hoy = null, puerto = 4321 } = {}) {
  const permitidos = new Set([`127.0.0.1:${puerto}`, `localhost:${puerto}`]);
  const origenes = new Set([...permitidos].map((h) => `http://${h}`));
  const json = (res, status, cuerpo) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(cuerpo));
  };
  return http.createServer(async (req, res) => {
    try {
      if (!permitidos.has(String(req.headers.host ?? ''))) return json(res, 403, { error: 'host no permitido' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const fecha = hoy ?? hoyLocal();
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && ESTATICOS[url.pathname]) {
        const [archivo, tipo] = ESTATICOS[url.pathname];
        res.writeHead(200, { 'content-type': tipo, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'" });
        return res.end(fs.readFileSync(path.join(PUBLICO, archivo)));
      }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'no existe' });
      if (req.method === 'POST') {
        const origen = req.headers.origin;
        if (origen && !origenes.has(origen)) return json(res, 403, { error: 'origen no permitido' });
        if (!/application\/json/.test(String(req.headers['content-type'] ?? ''))) return json(res, 415, { error: 'se espera JSON' });
      }
      const ruta = `${req.method} ${url.pathname}`;
      if (ruta === 'GET /api/meses') {
        return json(res, 200, { hoy: fecha, porDefecto: mesAnterior(fecha), meses: mesesDisponibles(outDir, fecha) });
      }
      if (ruta === 'GET /api/panel') {
        const mes = url.searchParams.get('mes') ?? mesAnterior(fecha);
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return json(res, 400, { error: 'mes inválido (AAAA-MM)' });
        return json(res, 200, panelMes(outDir, mes, { hoy: fecha, paramsFile }));
      }
      if (ruta === 'GET /api/pendientes') return json(res, 200, pendientesDeCarga(outDir, fecha, { paramsFile }));
      if (ruta === 'GET /api/conceptos') return json(res, 200, CONCEPTOS);
      if (ruta === 'GET /api/pdf') return json(res, 200, [
        ...listarCm03(outDir).map((c) => ({ documento: 'cm03', id: c.id, archivo: c.archivo, cuando: c.cuando, periodo: c.periodo, version: c.rectificativa, estado: c.estado, motivos: c.motivos, determinado: c.impuestoDeterminadoTotal, aPagar: c.totalAPagarDeclarado })),
        ...listarDdjjGanancias(outDir).map((d) => ({ documento: 'ddjj-ganancias', id: d.id, archivo: d.archivo, cuando: d.cuando, periodo: d.anio, formulario: d.formulario, version: d.secuencia, estado: d.estado, motivos: d.motivos, determinado: d.impuestoDeterminado,
          aPagar: d.saldoAFavorArca == null ? null : d.saldoAFavorArca - (d.saldoAFavorContribuyente ?? 0) }))].sort((a, b) => a.cuando.localeCompare(b.cuando)));
      if (ruta === 'GET /api/cm03') return json(res, 200, listarCm03(outDir).map(({ id, archivo, cuando, periodo, rectificativa, estado, motivos, impuestoDeterminadoTotal, totalAPagarDeclarado }) => ({ id, archivo, cuando, periodo, rectificativa, estado, motivos, impuestoDeterminadoTotal, totalAPagarDeclarado })));
      if (ruta === 'GET /api/importaciones') return json(res, 200, listarImportaciones(outDir).map(({ id, archivo, cuando, concepto, filas, duplicadas, descartadas, porMes, incluyeIva }) => ({ id, archivo, cuando, concepto, conceptoNombre: CONCEPTOS[concepto]?.nombre ?? concepto, filas, duplicadas, descartadas, porMes, incluyeIva })));
      if (req.method === 'POST') {
        const cuerpo = await leerCuerpo(req);
        if (ruta === 'POST /api/importar/analizar') return json(res, 200, analizarArchivo(outDir, cuerpo));
        if (ruta === 'POST /api/importar/vista') return json(res, 200, vistaPendiente(outDir, cuerpo));
        if (ruta === 'POST /api/importar/simular') { const { _nuevas, ...r } = simularImportacion(outDir, cuerpo); return json(res, 200, r); }
        if (ruta === 'POST /api/importar/confirmar') return json(res, 200, confirmarImportacion(outDir, cuerpo));
        if (ruta === 'POST /api/manuales/guardar') return json(res, 200, guardarManual(outDir, cuerpo));
        if (ruta === 'POST /api/manuales/eliminar') return json(res, 200, eliminarManual(outDir, String(cuerpo.id ?? '')));
        if (ruta === 'POST /api/cm03/importar') return json(res, 200, await importarCm03(outDir, { nombre: cuerpo.nombre, contenido: cuerpo.contenido, mes: cuerpo.mes || null }));
        if (ruta === 'POST /api/pdf/importar') return json(res, 200, await importarPdfFiscal(outDir, { tipo: cuerpo.tipo || null, nombre: cuerpo.nombre, contenido: cuerpo.contenido, mes: cuerpo.mes || null, anio: cuerpo.anio || null }));
        if (ruta === 'POST /api/pdf/eliminar') return json(res, 200, cuerpo.documento === 'ddjj-ganancias' ? eliminarDdjjGanancias(outDir, String(cuerpo.id ?? '')) : eliminarCm03(outDir, String(cuerpo.id ?? '')));
        if (ruta === 'POST /api/cm03/eliminar') return json(res, 200, eliminarCm03(outDir, String(cuerpo.id ?? '')));
        if (ruta === 'POST /api/importaciones/eliminar') return json(res, 200, eliminarImportacion(outDir, String(cuerpo.id ?? '')));
      }
      return json(res, 404, { error: 'no existe' });
    } catch (e) {
      return json(res, e.status ?? 400, { error: String(e?.message ?? e) });
    }
  });
}

/** Levanta el servidor en 127.0.0.1:puerto. Devuelve { servidor, url }. */
export function iniciarServidor(opciones = {}) {
  const puerto = opciones.puerto ?? 4321;
  const servidor = crearServidor({ ...opciones, puerto });
  return new Promise((resolve, reject) => {
    servidor.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`el puerto ${puerto} está ocupado: ¿FiscalOS ya está abierto? Probá http://127.0.0.1:${puerto} o usá --puerto`) : e));
    servidor.listen(puerto, '127.0.0.1', () => resolve({ servidor, url: `http://127.0.0.1:${puerto}/` }));
  });
}
