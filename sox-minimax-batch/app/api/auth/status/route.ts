import { NextResponse } from 'next/server';
import { isAllowed, readGoogleSession } from '@/lib/session';

export async function GET() {
  const required = ['MINIMAX_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'APP_SECRET', 'ALLOWED_EMAILS', 'NEXT_PUBLIC_BASE_URL', 'DRIVE_ROOT_FOLDER_ID', 'DRIVE_OUTPUT_FOLDER_ID'];
  const missing = required.filter((k) => !process.env[k]);
  if (process.env.APP_SECRET && process.env.APP_SECRET.length < 32) missing.push('APP_SECRET (mínimo 32 caracteres)');
  let session = null;
  try {
    session = await readGoogleSession();
  } catch {}
  const allowed = isAllowed(session?.email);
  return NextResponse.json({ connected: !!session && allowed, email: session?.email || null, denied: !!session && !allowed, missing, passwordGate: !!process.env.APP_PASSWORD });
}
