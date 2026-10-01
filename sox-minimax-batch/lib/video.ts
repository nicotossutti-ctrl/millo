import ffmpegStatic from 'ffmpeg-static';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

const W = 1080;
const H = 1920;
const FPS = 30;

function ffmpegBin() {
  const p = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string | null);
  // npm 11+ no ejecuta el script que baja ffmpeg salvo que esté en "allowScripts" del package.json.
  if (!p || !existsSync(p)) throw new Error('ffmpeg no está instalado en el servidor (revisá "allowScripts" en package.json y volvé a publicar)');
  return p;
}

function run(args: string[], keepStdout = false) {
  return new Promise<{ code: number; stderr: string; stdout: Buffer }>((resolve, reject) => {
    const p = spawn(ffmpegBin(), args, { stdio: ['ignore', keepStdout ? 'pipe' : 'ignore', 'pipe'] });
    let stderr = '';
    const out: Buffer[] = [];
    p.stdout?.on('data', (d: Buffer) => out.push(d));
    p.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 1, stderr, stdout: Buffer.concat(out) }));
  });
}

/** Qué clips no se pudieron bajar (índices), para regenerar sólo esos. */
export class ClipDownloadError extends Error {
  constructor(public indices: number[]) {
    super(`No se pudieron bajar ${indices.length} clip(s) de MiniMax; puede haber vencido el link`);
  }
}

export type Motion = { peak: number; end: number };

/**
 * Indicador aproximado de giro: cuánto cambia la imagen respecto del primer cuadro.
 * peak bajo = la media casi no se movió; end alto = no volvió a quedar de frente.
 * No prueba que haya dado exactamente 360°, sirve para saber qué clips mirar primero.
 */
export async function motionOf(file: string): Promise<Motion> {
  const w = 36;
  const h = 64;
  const { code, stdout } = await run(['-v', 'error', '-i', file, '-vf', `fps=8,scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], true);
  const size = w * h;
  const frames = Math.floor(stdout.length / size);
  if (code !== 0 || frames < 2) return { peak: 0, end: 0 };
  const diff = (i: number) => {
    let sum = 0;
    for (let k = 0; k < size; k++) sum += Math.abs(stdout[i * size + k] - stdout[k]);
    return sum / size;
  };
  let peak = 0;
  for (let i = 1; i < frames; i++) peak = Math.max(peak, diff(i));
  return { peak: Math.round(peak * 10) / 10, end: Math.round(diff(frames - 1) * 10) / 10 };
}

async function durationOf(file: string) {
  const { stderr } = await run(['-hide_banner', '-i', file]);
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  if (!m) throw new Error(`No pude leer la duración de ${path.basename(file)}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Une los clips con corte seco en un MP4 vertical 1080x1920. `order` dice qué clip va en cada tramo
 * (puede repetir, ej. [0, 1, 0]) y cada tramo dura `segmentSeconds`. Si un clip no dura justo eso,
 * se acelera o frena apenas (no se recorta), así la vuelta entra entera.
 */
export async function makeFinalVideo(
  urls: string[],
  order: number[],
  segmentSeconds: number,
): Promise<{ video: Buffer; motion: Motion[]; clips: Buffer[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sox-video-'));
  try {
    const downloads = await Promise.allSettled(
      urls.map(async (url, i) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const file = path.join(dir, `clip${i}.mp4`);
        await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
        return file;
      }),
    );
    const bad = downloads.flatMap((d, i) => (d.status === 'rejected' ? [i] : []));
    if (bad.length) throw new ClipDownloadError(bad);
    const unique = downloads.map((d) => (d as PromiseFulfilledResult<string>).value);
    const [uniqueDurations, motion] = await Promise.all([Promise.all(unique.map(durationOf)), Promise.all(unique.map(motionOf))]);
    // Un input de ffmpeg por tramo (un clip repetido se lee dos veces del mismo archivo).
    const files = order.map((i) => unique[i]);
    const durations = order.map((i) => uniqueDurations[i]);

    const totalFrames = Math.round(order.length * segmentSeconds * FPS);
    const n = files.length;
    const framesFor = (i: number) => Math.floor(((i + 1) * totalFrames) / n) - Math.floor((i * totalFrames) / n);

    const filters = files.map((_, i) => {
      const frames = framesFor(i);
      const factor = frames / FPS / durations[i];
      return (
        `[${i}:v]setpts=(PTS-STARTPTS)*${factor.toFixed(6)},fps=${FPS},` +
        `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1,` +
        `tpad=stop_mode=clone:stop=${FPS},trim=end_frame=${frames},setpts=PTS-STARTPTS[v${i}]`
      );
    });
    const graph = `${filters.join(';')};${files.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[out]`;

    const out = path.join(dir, 'final.mp4');
    const args = [
      '-y', '-hide_banner',
      ...files.flatMap((f) => ['-i', f]),
      '-filter_complex', graph,
      '-map', '[out]', '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-r', String(FPS), '-frames:v', String(totalFrames), '-movflags', '+faststart',
      out,
    ];
    const { code, stderr } = await run(args);
    if (code !== 0) throw new Error(`ffmpeg falló: ${stderr.slice(-1500)}`);
    // Los clips tal cual los devolvió MiniMax (uno por color), para guardarlos también en Drive.
    const clips = await Promise.all(unique.map((f) => fs.readFile(f)));
    return { video: await fs.readFile(out), motion, clips };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
