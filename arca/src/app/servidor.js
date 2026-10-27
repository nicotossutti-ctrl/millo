/**
 * Servidor local de la interfaz de FiscalOS. Solo escucha en 127.0.0.1 (no es accesible desde otra
 * computadora) y rechaza pedidos con otro Host u Origin (protección contra sitios web que intenten
 * hablarle al servidor local). No abre ARCA: muestra lo conservado y lo importado.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { panelMes, mesesDisponibles, mesAnterior, comparacionMeses } from './panel.js';
import { pendientesDeCarga } from './pendientes.js';
import { guardarManual, eliminarManual, clasificarProveedor, CLASES_PROVEEDOR } from './manuales.js';
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
      if (ruta === 'GET /api/comparacion') {
        const meses = String(url.searchParams.get('meses') ?? '').split(',').filter(Boolean);
        if (!meses.length || meses.length > 12 || meses.some((m) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(m))) return json(res, 400, { error: 'meses inválidos (AAAA-MM separados por coma, hasta 12)' });
        return json(res, 200, comparacionMeses(outDir, meses, { hoy: fecha, paramsFile }));
      }
      if (ruta === 'GET /api/pendientes') return json(res, 200, pendientesDeCarga(outDir, fecha, { paramsFile }));
      if (ruta === 'GET /api/conceptos') return json(res, 200, CONCEPTOS);
      if (ruta === 'GET /api/clases-proveedor') return json(res, 200, CLASES_PROVEEDOR);
      if (ruta === 'GET /api/importaciones') return json(res, 200, listarImportaciones(outDir).map(({ id, archivo, cuando, concepto, filas, duplicadas, descartadas, porMes, incluyeIva }) => ({ id, archivo, cuando, concepto, conceptoNombre: CONCEPTOS[concepto]?.nombre ?? concepto, filas, duplicadas, descartadas, porMes, incluyeIva })));
      if (req.method === 'POST') {
        const cuerpo = await leerCuerpo(req);
        if (ruta === 'POST /api/importar/analizar') return json(res, 200, analizarArchivo(outDir, cuerpo));
        if (ruta === 'POST /api/importar/vista') return json(res, 200, vistaPendiente(outDir, cuerpo));
        if (ruta === 'POST /api/importar/simular') { const { _nuevas, ...r } = simularImportacion(outDir, cuerpo); return json(res, 200, r); }
        if (ruta === 'POST /api/importar/confirmar') return json(res, 200, confirmarImportacion(outDir, cuerpo));
        if (ruta === 'POST /api/manuales/guardar') return json(res, 200, guardarManual(outDir, cuerpo));
        if (ruta === 'POST /api/manuales/eliminar') return json(res, 200, eliminarManual(outDir, String(cuerpo.id ?? '')));
        if (ruta === 'POST /api/proveedores/clasificar') return json(res, 200, clasificarProveedor(outDir, cuerpo));
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
