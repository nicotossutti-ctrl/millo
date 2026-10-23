import fs from 'node:fs';
import path from 'node:path';

const ENDPOINTS = {
  homo: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  },
  prod: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
  },
};

export function loadConfig({ requireAuth = true } = {}) {
  const env = (process.env.ARCA_ENV || 'homo').toLowerCase();
  if (!ENDPOINTS[env]) throw new Error(`ARCA_ENV debe ser "homo" o "prod" (recibido: ${env})`);

  const cfg = {
    env,
    endpoints: ENDPOINTS[env],
    cuit: (process.env.ARCA_CUIT || '').replace(/\D/g, ''),
    certPath: process.env.ARCA_CERT || 'certs/arca.crt',
    keyPath: process.env.ARCA_KEY || 'certs/arca.key',
    signer: process.env.ARCA_SIGNER || 'forge',
    taDir: path.resolve('.ta'),
    sesionDir: path.resolve('.sesion'),
    outDir: path.resolve('out'),
  };

  if (requireAuth === 'cuit' || requireAuth === true) {
    if (cfg.cuit.length !== 11) throw new Error('ARCA_CUIT debe tener 11 dígitos (sin guiones).');
  }
  if (requireAuth === true) {
    for (const p of [cfg.certPath, cfg.keyPath]) {
      if (!fs.existsSync(p)) throw new Error(`No existe ${p}. Ver README: generación del certificado.`);
    }
  }
  return cfg;
}
