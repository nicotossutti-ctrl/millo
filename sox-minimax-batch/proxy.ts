import { NextResponse, type NextRequest } from 'next/server';
import { GATE_COOKIE, gateToken, safeEqual } from './lib/gate';

/**
 * Si APP_PASSWORD está cargada, nada de la web responde sin haber pasado por /login.
 * Es una barrera extra: cada ruta de la API igual verifica la cuenta de Google autorizada.
 */
export async function proxy(req: NextRequest) {
  let expected: string | null;
  try {
    expected = await gateToken();
  } catch (e: any) {
    return new NextResponse(e.message, { status: 500 });
  }
  if (!expected) return NextResponse.next();
  const got = req.cookies.get(GATE_COOKIE)?.value || '';
  if (safeEqual(got, expected)) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith('/api/')) return NextResponse.json({ error: 'Falta la contraseña de la app' }, { status: 401 });
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = {
  matcher: ['/((?!login|api/login|_next/static|_next/image|favicon.ico).*)'],
};
