import sharp from 'sharp';
import { downloadFile, thumbnail } from '@/lib/google';
import { guard } from '@/lib/guard';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return new Response('Falta id', { status: 400 });
  try {
    let t = await thumbnail(id).catch(() => null);
    if (!t) t = { data: await sharp(await downloadFile(id)).resize(240, 240, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer(), type: 'image/jpeg' };
    return new Response(new Uint8Array(t.data), {
      headers: { 'Content-Type': t.type, 'Cache-Control': 'private, max-age=86400' },
    });
  } catch (e: any) {
    return new Response(e.message, { status: 500 });
  }
}
