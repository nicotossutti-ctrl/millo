import { cookies } from 'next/headers';
import { EncryptJWT, jwtDecrypt } from 'jose';
import crypto from 'crypto';

const COOKIE = 'sox_google_session';

function key() {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 32) throw new Error('APP_SECRET falta o es muy corto (mínimo 32 caracteres)');
  return crypto.createHash('sha256').update(secret).digest();
}

export type GoogleSession = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  email?: string;
};

/** Cuentas de Google que pueden usar la app. Vacío = nadie (falla cerrado). */
export function allowedEmails() {
  return (process.env.ALLOWED_EMAILS || '')
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowed(email?: string) {
  return !!email && allowedEmails().includes(email.toLowerCase());
}

export class AuthError extends Error {}

export async function saveGoogleSession(s: GoogleSession) {
  const token = await new EncryptJWT(s as any)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .encrypt(key());
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function readGoogleSession(): Promise<GoogleSession | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtDecrypt(token, key());
    return payload as any;
  } catch {
    return null;
  }
}

/**
 * Sesión de Google de una cuenta autorizada, o error. Se revisa en cada request,
 * así sacar un mail de ALLOWED_EMAILS corta el acceso al instante.
 */
export async function requireUser(): Promise<GoogleSession> {
  const s = await readGoogleSession();
  if (!s) throw new AuthError('Google Drive no conectado');
  if (!isAllowed(s.email)) throw new AuthError(`La cuenta ${s.email || '(sin mail)'} no está autorizada. Tocá "desconectar" y entrá con la cuenta correcta.`);
  return s;
}

export async function clearGoogleSession() {
  const jar = await cookies();
  jar.delete(COOKIE);
}
