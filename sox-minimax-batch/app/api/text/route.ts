import { NextResponse } from 'next/server';
import { productText } from '@/lib/texts';
import { ensureFolder, putFile } from '@/lib/google';

export const runtime = 'nodejs';

/** Rehace sólo el TXT (sin tocar el video ni gastar en MiniMax), ej. después de escribir el guion. */
export async function POST(req: Request) {
  try {
    const { sku, colors, alsoNames } = (await req.json()) as { sku: string; colors: string[]; alsoNames?: string[] };
    const outputRoot = process.env.DRIVE_OUTPUT_FOLDER_ID;
    if (!sku || !outputRoot) throw new Error('Datos incompletos');
    const [{ text, hasScript }, folder] = await Promise.all([productText(sku, colors || [], alsoNames || []), ensureFolder(outputRoot, sku)]);
    await putFile(folder.id, `${sku}.txt`, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
    return NextResponse.json({ ok: true, hasScript, folderUrl: `https://drive.google.com/drive/folders/${folder.id}` });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
