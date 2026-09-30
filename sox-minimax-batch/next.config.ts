import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Este proyecto es independiente aunque esté dentro de otra carpeta con su propio package-lock.
  outputFileTracingRoot: __dirname,
  turbopack: { root: __dirname },
  serverExternalPackages: ['ffmpeg-static', 'sharp'],
  // El binario de ffmpeg no se importa, se ejecuta: hay que incluirlo a mano en la función.
  outputFileTracingIncludes: {
    '/api/finalize': ['./node_modules/ffmpeg-static/ffmpeg*'],
  },
};

export default nextConfig;
