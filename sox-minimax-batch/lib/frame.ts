import sharp from 'sharp';

export const FRAME_W = 1080;
export const FRAME_H = 1920;

/**
 * Convierte la foto (cuadrada en tu Drive) en un cuadro 9:16 sin franjas negras:
 * el fondo se estira desde los bordes de la propia foto y se desenfoca, y la foto va encima.
 * Con eso MiniMax genera el video directamente en vertical.
 */
export async function buildFrame(raw: Buffer): Promise<Buffer> {
  const fg = await sharp(raw)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width: FRAME_W, height: FRAME_H, fit: 'inside' })
    .toBuffer({ resolveWithObject: true });
  const { width, height } = fg.info;
  const top = Math.floor((FRAME_H - height) / 2);
  const left = Math.floor((FRAME_W - width) / 2);
  const bg = await sharp(fg.data)
    .extend({ top, bottom: FRAME_H - height - top, left, right: FRAME_W - width - left, extendWith: 'copy' })
    .blur(30)
    .toBuffer();
  return sharp(bg).composite([{ input: fg.data, top, left }]).jpeg({ quality: 90 }).toBuffer();
}

export async function frameDataUrl(raw: Buffer) {
  return `data:image/jpeg;base64,${(await buildFrame(raw)).toString('base64')}`;
}
