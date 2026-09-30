import ffmpegStatic from 'ffmpeg-static';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const W = 1080;
const H = 1920;
const FPS = 30;

function ffmpegBin() {
  const p = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string | null);
  if (!p) throw new Error('ffmpeg no disponible');
  return p;
}

function run(args: string[]) {
  return new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    const p = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

async function durationOf(file: string) {
  const { stderr } = await run(['-hide_banner', '-i', file]);
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  if (!m) throw new Error(`No pude leer la duración de ${path.basename(file)}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Une los clips con corte seco en un MP4 vertical 1080x1920 de exactamente `totalSeconds`.
 * Cada clip se acelera o se frena (no se recorta) para que la vuelta completa entre en su tramo.
 */
export async function makeFinalVideo(urls: string[], totalSeconds = 15): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sox-video-'));
  try {
    const files = await Promise.all(
      urls.map(async (url, i) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`No se pudo bajar el clip ${i + 1} de MiniMax (${res.status}); puede haber vencido el link`);
        const file = path.join(dir, `clip${i}.mp4`);
        await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
        return file;
      }),
    );
    const durations = await Promise.all(files.map(durationOf));

    const totalFrames = Math.round(totalSeconds * FPS);
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
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
