import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { googleAuthUrl } from '@/lib/google';

const STATE_COOKIE = 'sox_oauth_state';

/** `state` al azar en una cookie: el callback sólo acepta la vuelta de un login que empezó en este navegador. */
export async function GET() {
  const state = crypto.randomBytes(24).toString('base64url');
  const res = NextResponse.redirect(googleAuthUrl(state));
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth/google',
    maxAge: 600,
  });
  return res;
}
