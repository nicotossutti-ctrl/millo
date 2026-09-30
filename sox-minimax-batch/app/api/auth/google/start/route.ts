import { NextResponse } from 'next/server';
import { googleAuthUrl } from '@/lib/google';
export async function GET() { return NextResponse.redirect(googleAuthUrl()); }
