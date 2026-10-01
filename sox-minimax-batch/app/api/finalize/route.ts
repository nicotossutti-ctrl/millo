import { NextResponse } from 'next/server';
import { ClipDownloadError, makeFinalVideo } from '@/lib/video';
import { productText } from '@/lib/texts';
import { ensureFolder, listChildren, putFile, trashFile } from '@/lib/google';
import { secondsPerVariant, sequenceFor } from '@/lib/minimax';
import { guard } from '@/lib/guard';

export const runtime = 'nodejs';
export const maxDuration = 300;

const clipName = (sku: string, i: number, label: string) => `${sku}-${String(i + 1).padStart(2, '0')}-${label.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'color'}.mp4`;

/**
 * Sube los clips sueltos de MiniMax a TERMINADOS - VIDEOS/<SKU>/clips/. Si cambió la selección de
 * colores, los clips viejos que ya no corresponden van a la papelera. No frena el video final si falla.
 */
async function uploadClips(skuFolderId: string, sku: string, clips: Buffer[], colors: string[]) {
  const folder = await ensureFolder(skuFolderId, 'clips');
  const names = clips.map((_, i) => clipName(sku, i, colors[i] || ''));
  const results = await Promise.allSettled(clips.map((c, i) => putFile(folder.id, names[i], 'video/mp4', c)));
  const keep = new Set(names);
  const old = (await listChildren(folder.id).catch(() => [])).filter((f) => f.name.toLowerCase().endsWith('.mp4') && !keep.has(f.name));
  await Promise.allSettled(old.map((f) => trashFile(f.id)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  return { folderUrl: `https://drive.google.com/drive/folders/${folder.id}`, failed };
}

export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  try {
    const { sku, urls, colors, alsoNames } = (await req.json()) as { sku: string; urls: string[]; colors: string[]; alsoNames?: string[] };
    if (!sku || !Array.isArray(urls) || !urls.length) throw new Error('Datos incompletos');
    const outputRoot = process.env.DRIVE_OUTPUT_FOLDER_ID;
    if (!outputRoot) throw new Error('Falta DRIVE_OUTPUT_FOLDER_ID');

    const [{ video, motion, clips }, { text, hasScript }, folder] = await Promise.all([
      makeFinalVideo(urls, sequenceFor(urls.length), secondsPerVariant(urls.length)),
      productText(sku, colors || [], alsoNames || []),
      ensureFolder(outputRoot, sku),
    ]);
    const [, , clipsResult] = await Promise.all([
      putFile(folder.id, `${sku}.mp4`, 'video/mp4', video),
      putFile(folder.id, `${sku}.txt`, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8')),
      uploadClips(folder.id, sku, clips, colors || []).catch(() => ({ folderUrl: '', failed: clips.length })),
    ]);
    return NextResponse.json({
      ok: true,
      folderUrl: `https://drive.google.com/drive/folders/${folder.id}`,
      clipsFailed: clipsResult.failed,
      motion,
      hasScript,
      bytes: video.length,
    });
  } catch (e: any) {
    // 409: la página regenera sólo los clips cuyo link no se pudo bajar.
    if (e instanceof ClipDownloadError) return NextResponse.json({ error: e.message, badClips: e.indices }, { status: 409 });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
