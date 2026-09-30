import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { GATE_COOKIE, gateToken } from '@/lib/gate';
import { baseUrl } from '@/lib/google';

export const runtime = 'nodejs';

const digest = (s: string) => crypto.createHash('sha256').update(s).digest();

export async function POST(req: Request) {
  const form = await req.formData();
  const given = String(form.get('password') || '');
  const password = process.env.APP_PASSWORD || '';
  const token = await gateToken();
  if (!password || !token) return NextResponse.redirect(`${baseUrl()}/`, 303);
  if (!crypto.timingSafeEqual(digest(given), digest(password))) {
    // Frena los intentos por fuerza bruta.
    await new Promise((r) => setTimeout(r, 1500));
    return NextResponse.redirect(`${baseUrl()}/login?e=1`, 303);
  }
  const res = NextResponse.redirect(`${baseUrl()}/`, 303);
  res.cookies.set(GATE_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
