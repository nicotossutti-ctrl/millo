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

export function videoPrompt(loop: boolean, seconds: number) {
  return [
    'E-commerce product video of the exact sock shown in the image, standing on an invisible turntable.',
    `The sock makes exactly ONE full 360-degree turn around its vertical axis, and that single turn takes the entire ${seconds} seconds of the clip:`,
    'a slow, steady, constant speed from the first frame to the last, never more than one turn, no pauses.',
    'Order of views: front, side, back, other side, and back to the same front view it starts with.',
    loop ? 'The last frame must match the first frame.' : 'It ends facing the front again.',
    'Locked-off camera: no zoom, no pan, no orbit, no cuts. Keep the same background and lighting as the image.',
    'Keep the sock identical to the image: same colors, knit pattern, logos, text, shape and size.',
    'No hands, no feet, no people, no extra objects, no text overlays, no morphing.',
  ].join(' ');
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
