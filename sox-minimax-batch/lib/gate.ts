// Contraseña general delante de toda la web (APP_PASSWORD). Sin imports de Node: la usa también proxy.ts.

export const GATE_COOKIE = 'sox_gate';

/** Valor de la cookie: HMAC(APP_SECRET, APP_PASSWORD). Cambiar la contraseña invalida las sesiones. */
export async function gateToken(): Promise<string | null> {
  const password = process.env.APP_PASSWORD;
  const secret = process.env.APP_SECRET;
  if (!password) return null;
  if (!secret || secret.length < 32) throw new Error('APP_SECRET falta o es muy corto');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`gate:${password}`));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparación en tiempo constante (no revela cuántos caracteres coinciden). */
export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
