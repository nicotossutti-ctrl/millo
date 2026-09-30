import { NextResponse } from 'next/server';
import { AuthError, requireUser } from './session';

/** Para el principio de cada ruta de la API: devuelve 401 si no es una cuenta autorizada. */
export async function guard(): Promise<NextResponse | null> {
  try {
    await requireUser();
    return null;
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e instanceof AuthError ? 401 : 500 });
  }
}
