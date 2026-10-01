// Cambiable por si usás el endpoint de China (https://api.minimaxi.com).
const BASE = (process.env.MINIMAX_BASE_URL || 'https://api.minimax.io').replace(/\/$/, '');

function key() {
  const k = process.env.MINIMAX_API_KEY;
  if (!k) throw new Error('Falta MINIMAX_API_KEY en Vercel');
  return k;
}


export const NO_BALANCE = 'Sin saldo en MiniMax: cargá saldo en platform.minimax.io (Billing) y tocá Reintentar. No se cobró nada.';

/**
 * Cuánto dura cada color en el video final:
 * 1 color 15 s · 2 colores 7,5 s · 3 o 4 colores 5 s · 5 o más 4 s.
 * El video dura N × eso (2 y 3 colores: 15 s; 4 y 5 colores: 20 s).
 */
export function secondsPerVariant(variantCount: number) {
  if (variantCount <= 1) return 15;
  if (variantCount === 2) return 7.5;
  if (variantCount <= 4) return 5;
  return 4;
}

export function totalSeconds(variantCount: number) {
  return variantCount * secondsPerVariant(variantCount);
}

/**
 * Cuántos segundos pedirle a MiniMax por variante (entero de 4 a 15). Después el clip se
 * acelera o frena apenas para que dure exactamente secondsPerVariant: la vuelta nunca se corta.
 */
export function clipSeconds(variantCount: number) {
  return Math.min(15, Math.max(4, Math.ceil(secondsPerVariant(variantCount))));
}

export function pricePerSecond() {
  return Number(process.env.MINIMAX_PRICE_PER_SECOND || 0.08);
}

export function videoPrompt(loop: boolean) {
  return [
    'E-commerce product video of the exact sock shown in the image, standing on an invisible turntable.',
    'During the whole clip the sock rotates at a slow, constant speed around its vertical axis and completes exactly ONE full 360-degree turn:',
    'front, side, back, other side, and back to the same front view it starts with.',
    loop ? 'The last frame must match the first frame.' : 'It ends facing the front again.',
    'Locked-off camera: no zoom, no pan, no orbit, no cuts. Keep the same background and lighting as the image.',
    'Keep the sock identical to the image: same colors, knit pattern, logos, text, shape and size.',
    'No hands, no feet, no people, no extra objects, no text overlays, no morphing.',
  ].join(' ');
}

export async function createVideo(frameDataUrl: string, seconds: number, loop: boolean) {
  const content: unknown[] = [
    { type: 'text', text: videoPrompt(loop) },
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
