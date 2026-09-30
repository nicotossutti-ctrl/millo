import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import crypto from 'crypto';
import { exchangeCode, baseUrl } from '@/lib/google';
import { allowedEmails, isAllowed, saveGoogleSession } from '@/lib/session';

const STATE_COOKIE = 'sox_oauth_state';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(status: number, raw: string) {
  const msg = esc(raw);
  const html = `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0b0d10;color:#f4f6f8;padding:40px"><h2>No se pudo conectar Google</h2><p>${msg}</p><p><a style="color:#9cc7ff" href="/">Volver</a></p>`;
  return new NextResponse(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value || '';
  jar.delete({ name: STATE_COOKIE, path: '/api/auth/google' });

  const state = u.searchParams.get('state') || '';
  const same = state.length === expected.length && expected.length > 0 && crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected));
  if (!same) return page(400, 'El inicio de sesión no empezó en este navegador o venció. Volvé a tocar "Conectar Google".');

  const code = u.searchParams.get('code');
  if (!code) return page(400, u.searchParams.get('error') || 'Google no devolvió el código.');
  if (!allowedEmails().length) return page(403, 'Falta cargar ALLOWED_EMAILS en Vercel (tu mail de Google).');
  try {
    const s = await exchangeCode(code);
    if (!isAllowed(s.email)) return page(403, `La cuenta ${s.email || '(sin mail verificado)'} no está autorizada para usar esta app.`);
    await saveGoogleSession(s);
    return NextResponse.redirect(baseUrl());
  } catch (e: any) {
    return page(500, e.message);
  }
}
