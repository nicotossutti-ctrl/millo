import { NextResponse } from 'next/server';
import { makeFinalVideo } from '@/lib/video';
import { productText } from '@/lib/texts';
import { ensureFolder, putFile } from '@/lib/google';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const { sku, urls, colors } = (await req.json()) as { sku: string; urls: string[]; colors: string[] };
    if (!sku || !Array.isArray(urls) || !urls.length) throw new Error('Datos incompletos');
    const outputRoot = process.env.DRIVE_OUTPUT_FOLDER_ID;
    if (!outputRoot) throw new Error('Falta DRIVE_OUTPUT_FOLDER_ID');

    const [video, text, folder] = await Promise.all([
      makeFinalVideo(urls, 15),
      productText(sku, colors || []),
      ensureFolder(outputRoot, sku),
    ]);
    const [videoFile, textFile] = await Promise.all([
      putFile(folder.id, `${sku}.mp4`, 'video/mp4', video),
      putFile(folder.id, `${sku}.txt`, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8')),
    ]);
    return NextResponse.json({
      ok: true,
      folderUrl: `https://drive.google.com/drive/folders/${folder.id}`,
      videoFile,
      textFile,
      bytes: video.length,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
