import { NextResponse } from 'next/server';
import { readGoogleSession } from '@/lib/session';

export async function GET() {
  const missing = ['MINIMAX_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'APP_SECRET', 'NEXT_PUBLIC_BASE_URL', 'DRIVE_ROOT_FOLDER_ID', 'DRIVE_OUTPUT_FOLDER_ID'].filter(
    (k) => !process.env[k],
  );
  let connected = false;
  try {
    connected = !!(await readGoogleSession());
  } catch {}
  return NextResponse.json({ connected, missing });
}
