import { NextResponse } from 'next/server';
import { clearGoogleSession } from '@/lib/session';
import { baseUrl } from '@/lib/google';

export async function GET() {
  await clearGoogleSession();
  return NextResponse.redirect(baseUrl());
}
