import { NextResponse } from 'next/server';
import { exchangeCode, baseUrl } from '@/lib/google';
import { saveGoogleSession } from '@/lib/session';

export async function GET(req: Request) {
  const u = new URL(req.url);
  const code = u.searchParams.get('code');
  if (!code) return NextResponse.json({ error: u.searchParams.get('error') || 'Falta code' }, { status: 400 });
  try {
    await saveGoogleSession(await exchangeCode(code));
    return NextResponse.redirect(baseUrl());
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
