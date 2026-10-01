// Cambiable por si usás el endpoint de China (https://api.minimaxi.com).
const BASE = (process.env.MINIMAX_BASE_URL || 'https://api.minimax.io').replace(/\/$/, '');

function key() {
  const k = process.env.MINIMAX_API_KEY;
  if (!k) throw new Error('Falta MINIMAX_API_KEY en Vercel');
  return k;
}


export const NO_BALANCE = 'Sin saldo en MiniMax: cargá saldo en platform.minimax.io (Billing) y tocá Reintentar. No se cobró nada.';

/** Cada color da una vuelta de 4 s (es también el mínimo que genera MiniMax: no hace falta acelerar). */
export const TURN_SECONDS = 4;
/** El video nunca baja de 12 s: con 1 o 2 colores se repiten clips (sin costo extra). */
export const MIN_SEGMENTS = 3;

/** Orden de los clips en el video, como índices de color: 1 → A·A·A, 2 → A·B·A, 3+ → A·B·C… */
export function sequenceFor(variantCount: number) {
  const len = Math.max(MIN_SEGMENTS, variantCount);
  return Array.from({ length: len }, (_, i) => i % variantCount);
}

export function totalSeconds(variantCount: number) {
  return sequenceFor(variantCount).length * TURN_SECONDS;
}

/** Segundos que se le piden a MiniMax por color. */
export function clipSeconds(_variantCount: number) {
  return TURN_SECONDS;
}

export function pricePerSecond() {
  return Number(process.env.MINIMAX_PRICE_PER_SECOND || 0.08);
}

/**
 * Prompt para MiniMax. H3 no lo reescribe: le llega tal cual. La prioridad absoluta es
 * no cambiar el producto (colores, tejido, logos y textos), después el giro y la cámara fija.
 */
export function videoPrompt(loop: boolean, seconds: number) {
  return [
    'PRODUCT TURNTABLE VIDEO FOR AN ONLINE STORE. The only subject is the exact real sock shown in the image. This is a photo of a real product that customers will buy, so it must look exactly like the photo.',
    '',
    'RULE 1 - DO NOT CHANGE THE PRODUCT (highest priority, never break it):',
    '- Keep every color exactly as in the image. No hue, saturation or brightness changes.',
    '- Keep the knit texture, stripes, patterns, panels, seams, cuff, heel and toe exactly as in the image.',
    '- Keep every logo and every printed word exactly as in the image: same letters, same spelling, same font, same color, same size, same position. Do not mirror or flip any text.',
    '- NEVER add, invent, complete, translate or replace any text, letters, numbers, words or logos. If a word is only partly visible, leave it exactly as it looks. Do not write words that are not in the image.',
    '- Parts of the sock that are not visible in the image must stay simple and consistent with the visible colors and materials, with NO new text, NO new logos and NO new graphics.',
    '- Keep the exact shape, length, thickness and proportions. No stretching, bending, melting or morphing.',
    '',
    `RULE 2 - MOTION: the sock stands upright on an invisible turntable and makes exactly ONE full 360-degree turn around its vertical axis. That single turn lasts the entire ${seconds} seconds, at a slow and constant speed, without pauses and never more than one turn. ${loop ? 'The last frame must be identical to the first frame.' : 'It ends facing the same way it started.'}`,
    '',
    'RULE 3 - CAMERA: fixed camera on a tripod. The framing stays identical to the first frame for the whole video: NO zoom in, NO zoom out, NO push-in, NO dolly, NO pan, NO tilt, NO reframing, NO cuts. The sock keeps the same size and stays centered in the same place.',
    '',
    'RULE 4 - SCENE: keep the same background, the same lighting and the same floor reflection as the image. No hands, no feet, no legs, no mannequin, no people, no extra objects, no text overlays, no watermark, no effects.',
  ].join('\n');
}

export async function createVideo(frameDataUrl: string, seconds: number, loop: boolean) {
  const content: unknown[] = [
    { type: 'text', text: videoPrompt(loop, seconds) },
    { type: 'image_url', image_url: { url: frameDataUrl }, role: 'first_frame' },
  ];
  // Mismo cuadro al principio y al final: obliga a que la vuelta termine donde empezó.
  if (loop) content.push({ type: 'image_url', image_url: { url: frameDataUrl }, role: 'last_frame' });

  const res = await fetch(`${BASE}/v2/video_generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MINIMAX_MODEL || 'MiniMax-H3',
      content,
      resolution: process.env.MINIMAX_RESOLUTION || '768P',
      duration: seconds,
      // Con imagen inicial MiniMax toma la proporción de la imagen: por eso la mandamos ya en 9:16.
      ratio: 'adaptive',
    }),
  });
  const text = await res.text();
  let j: any = {};
  try {
    j = JSON.parse(text);
  } catch {}
  const apiError = j.base_resp && j.base_resp.status_code !== 0 ? j.base_resp.status_msg : j.error?.message;
  const taskId = j.task_id ?? j.id ?? j.task?.id ?? j.data?.task_id;
  const detail = apiError || text.slice(0, 400);
  // 402 / código 1008: la cuenta de la API no tiene saldo (no se cobró nada).
  if (res.status === 402 || /insufficient balance|\b1008\b/i.test(detail)) throw new Error(NO_BALANCE);
  if (!res.ok || apiError || !taskId) throw new Error(`MiniMax ${res.status}: ${detail}`);
  return String(taskId);
}

export type TaskState = { taskId: string; status: 'pending' | 'succeeded' | 'failed'; url?: string; error?: string };

export async function queryVideo(taskId: string): Promise<TaskState> {
  const res = await fetch(`${BASE}/v2/query/video_generation/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${key()}` },
    cache: 'no-store',
  });
  const text = await res.text();
  let j: any = {};
  try {
    j = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(`MiniMax ${res.status}: ${text.slice(0, 300)}`);
  const t = j.task ?? j.data ?? j;
  const raw = String(t.status ?? '').toLowerCase();
  if (['succeeded', 'success'].includes(raw)) {
    const url = t.content?.url ?? t.content?.video_url ?? t.video_url ?? t.url;
    if (!url) return { taskId, status: 'failed', error: 'MiniMax terminó pero no devolvió la URL del video' };
    return { taskId, status: 'succeeded', url };
  }
  if (['failed', 'fail', 'cancelled', 'canceled', 'expired'].includes(raw)) {
    return { taskId, status: 'failed', error: t.error?.message || t.error || t.fail_reason || raw };
  }
  return { taskId, status: 'pending' };
}
