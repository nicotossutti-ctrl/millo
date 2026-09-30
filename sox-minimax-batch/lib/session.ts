import { cookies } from 'next/headers';
import { EncryptJWT, jwtDecrypt } from 'jose';
import crypto from 'crypto';

const COOKIE = 'sox_google_session';

function key() {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error('Falta APP_SECRET');
  return crypto.createHash('sha256').update(secret).digest();
}

export type GoogleSession = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
};

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

export async function clearGoogleSession() {
  const jar = await cookies();
  jar.delete(COOKIE);
}
