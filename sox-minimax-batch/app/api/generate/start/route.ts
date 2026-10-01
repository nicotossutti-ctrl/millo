import { NextResponse } from 'next/server';
import { downloadFile } from '@/lib/google';
import { frameDataUrl } from '@/lib/frame';
import { createVideo } from '@/lib/minimax';
import { guard } from '@/lib/guard';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Item = { fileId: string; seconds: number };

/**
 * Crea una tarea de MiniMax por imagen (en paralelo). Si alguna falla devuelve igual las que
 * sí se crearon (ya están pagas) para que la página las guarde y no las vuelva a pedir.
 */
export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const { items, loop } = (await req.json()) as { items: Item[]; loop?: boolean };
  if (!Array.isArray(items) || !items.length) return NextResponse.json({ error: 'No hay imágenes' }, { status: 400 });
  // Tope por pedido: más de 15 variantes no tiene sentido en un video de producto.
  if (items.length > 15) return NextResponse.json({ error: 'Demasiadas imágenes en un solo pedido' }, { status: 400 });
  const results = await Promise.allSettled(
    items.map(async (it) => {
      const seconds = Math.min(15, Math.max(4, Math.round(Number(it.seconds) || 4)));
      const frame = await frameDataUrl(await downloadFile(it.fileId));
      return { fileId: it.fileId, taskId: await createVideo(frame, seconds, loop !== false) };
    }),
  );
  const created = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const errors = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason?.message || r.reason)] : []));
  if (!errors.length) return NextResponse.json({ created });
  return NextResponse.json({ created, error: [...new Set(errors)].join(' | ') }, { status: created.length ? 207 : 500 });
}
