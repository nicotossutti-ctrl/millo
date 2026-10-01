import { NextResponse } from 'next/server';
import { ClipDownloadError, makeFinalVideo } from '@/lib/video';
import { productText } from '@/lib/texts';
import { ensureFolder, putFile } from '@/lib/google';
import { totalSeconds } from '@/lib/minimax';
import { guard } from '@/lib/guard';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  try {
    const { sku, urls, colors, alsoNames } = (await req.json()) as { sku: string; urls: string[]; colors: string[]; alsoNames?: string[] };
    if (!sku || !Array.isArray(urls) || !urls.length) throw new Error('Datos incompletos');
    const outputRoot = process.env.DRIVE_OUTPUT_FOLDER_ID;
    if (!outputRoot) throw new Error('Falta DRIVE_OUTPUT_FOLDER_ID');

    const [{ video, motion }, { text, hasScript }, folder] = await Promise.all([
      makeFinalVideo(urls, totalSeconds(urls.length)),
      productText(sku, colors || [], alsoNames || []),
      ensureFolder(outputRoot, sku),
    ]);
    await Promise.all([
      putFile(folder.id, `${sku}.mp4`, 'video/mp4', video),
      putFile(folder.id, `${sku}.txt`, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8')),
    ]);
    return NextResponse.json({ ok: true, folderUrl: `https://drive.google.com/drive/folders/${folder.id}`, motion, hasScript, bytes: video.length });
  } catch (e: any) {
    // 409: la página regenera sólo los clips cuyo link no se pudo bajar.
    if (e instanceof ClipDownloadError) return NextResponse.json({ error: e.message, badClips: e.indices }, { status: 409 });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
