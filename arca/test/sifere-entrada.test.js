import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { correrUno } from '../src/portal/orquestador.js';
import { SERVICIOS } from '../src/portal/servicios.js';

// SIFERE SIMULADO (sin datos reales).
async function navegador(t) {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { t.skip('sin Playwright'); return null; }
  try { return await chromium.launch(process.env.FISCALOS_CHROMIUM ? { executablePath: process.env.FISCALOS_CHROMIUM } : {}); } catch { t.skip('sin navegador'); return null; }
}

test('SIFERE: los listados se abren desde el menú del módulo (por la dirección, este SIFERE simulado da «Sesión expirada»)', async (t) => {
  const b = await navegador(t); if (!b) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-e-'));
  try {
    const ctx = await b.newContext(); const pg = await ctx.newPage();
    const menu = ['MostrarListaDDJJController.do', 'MostrarListaDDJJAnualController.do', 'MostrarListaVolantesPagoController.do'].map((c) => `<a class="dropdown-item" style="display:none" href="${c}">${c}</a>`).join('');
    const tabla = (enc, filas) => `<html><body>${menu}<table><thead><tr>${enc.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${filas.map((f) => `<tr>${f.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
    const pedidas = [];
    await ctx.route('https://sifereweb.comarb.gob.ar/**', (r) => {
      const u = r.request().url(); const desdeElMenu = !!r.request().headers().referer; pedidas.push(u);
      if (/Lista/.test(u) && !desdeElMenu) return r.fulfill({ status: 302, headers: { location: 'https://sifereweb.comarb.gob.ar/sifereweb/MostrarSesionExpiradaController.do' } });
      if (/SesionExpirada/.test(u)) return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<p>Sesión Expirada</p>' });
      if (/ListaDDJJController/.test(u)) return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: tabla(['Acciones', 'Anticipo', 'Estado', 'Fecha y Hora Presentación'], [['', '202609 - 0', 'Presentada', '15/10/2026 10:00']]) });
      if (/ListaDDJJAnual/.test(u)) return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: tabla(['Acciones', 'Año', 'Estado', 'Fecha y Hora Presentación'], [['', '2025', 'Presentada', '10/06/2026 10:00']]) });
      if (/VolantesPago/.test(u)) return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: tabla(['Acciones', 'Anticipo', 'Fecha Generación', 'Monto Total', 'Medio de Pago', 'Estado'], [['', '202609 - 0', '14/10/2026', '10,00', 'VEP', 'Pagado']]) });
      return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<html><body><h1>Portada</h1>${menu}</body></html>` });
    });
    await pg.goto('https://sifereweb.comarb.gob.ar/sifereweb/MostrarPortadaController.do');
    const servicio = { ...SERVICIOS.find((s) => s.id === 'sifere-consultas') };
    const sesion = { cfg: { outDir: out }, page: null, context: ctx, abrirServicio: async () => pg };
    const logs = [];
    const r = await correrUno(sesion, servicio, { log: (m) => logs.push(m), baseDir: path.join(out, 'corrida'), periodo: { desde: '2026-09-01', hasta: '2026-09-30' }, datosDir: path.join(out, 'datos') });
    assert.ok(r.filas >= 3, `${r.filas} filas · ${JSON.stringify(r.validaciones?.map((v) => [v.sub, v.filas, v.motivo]))} · ${JSON.stringify(pedidas)} · ${logs.join(' | ')}`);
    assert.ok(!pedidas.some((u) => /SesionExpirada/.test(u)), 'nunca se abrió un listado por la dirección');
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('SIFERE: si la pestaña de COMARB no carga, se informa como conexión (no como login) y no se esperan 3 minutos', async (t) => {
  const b = await navegador(t); if (!b) return;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sifere-e-'));
  try {
    const ctx = await b.newContext(); const principal = await ctx.newPage();
    await principal.setContent('<p>Portal</p>');
    // El acceso abre una pestaña a un host de COMARB que no responde (dominio inexistente: el navegador muestra su error).
    const abrirServicio = async () => { const p = await ctx.newPage(); await p.goto('http://app1.comarb.invalid/', { timeout: 15000 }).catch(() => {}); return principal; };
    const logs = [];
    const inicio = Date.now();
    const r = await correrUno({ cfg: { outDir: out }, page: principal, context: ctx, abrirServicio }, { ...SERVICIOS.find((s) => s.id === 'sifere-consultas-web') },
      { baseDir: path.join(out, 'corrida'), periodo: { desde: '2026-09-01', hasta: '2026-09-30' }, datosDir: path.join(out, 'datos'), log: (m) => logs.push(m) });
    assert.ok(Date.now() - inicio < 60000, 'no esperó los 3 minutos del login');
    assert.match(r.motivo, /no se pudo conectar con COMARB/);
    assert.ok(!logs.some((l) => /pide login/.test(l)), logs.join('\n'));
    assert.ok(!ctx.pages().some((p) => /^chrome-error:/.test(p.url())), 'la pestaña de error se cerró');
  } finally { await b.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
