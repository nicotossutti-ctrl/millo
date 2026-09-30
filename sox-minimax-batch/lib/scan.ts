import { FOLDER_MIME, query, queryInParents } from './google';
import { groupProducts, parseAliases, type Product } from './naming';
import { catalogCodes } from './texts';

// Carpetas que no son fotos de producto.
const SKIP_FOLDER = /contexto|textura/i;

/** Todas las subcarpetas de root (en tandas, pocas llamadas a la API). */
async function folderTree(rootId: string, skip: Set<string>) {
  const all = [rootId];
  let level = [rootId];
  while (level.length) {
    const kids = await queryInParents(level, `mimeType='${FOLDER_MIME}'`);
    level = kids.filter((f) => !skip.has(f.id) && !SKIP_FOLDER.test(f.name)).map((f) => f.id);
    all.push(...level);
  }
  return all;
}

/** SKUs que ya tienen <SKU>.mp4 dentro de TERMINADOS - VIDEOS/<SKU>/ */
async function finishedSkus(outputId: string) {
  const folders = await query(`'${outputId}' in parents and trashed=false and mimeType='${FOLDER_MIME}'`);
  if (!folders.length) return new Set<string>();
  const nameById = new Map(folders.map((f) => [f.id, f.name.trim().toUpperCase()]));
  const videos = await queryInParents([...nameById.keys()], `mimeType contains 'video/'`);
  const done = new Set<string>();
  for (const v of videos) {
    const sku = nameById.get(v.parents?.[0] || '');
    if (sku && v.name.toUpperCase() === `${sku}.MP4`) done.add(sku);
  }
  return done;
}

export type ScannedProduct = Product & { done: boolean; inCatalog: boolean };

export async function scanProducts(rootId: string, outputId?: string): Promise<ScannedProduct[]> {
  const skip = new Set(outputId ? [outputId] : []);
  const [folders, knownCodes] = await Promise.all([folderTree(rootId, skip), catalogCodes().catch(() => new Set<string>())]);
  const images = await queryInParents(folders, `mimeType contains 'image/'`, 'id,name,mimeType,parents');
  // La misma foto puede aparecer en más de una carpeta (atajos/copias): dedupe por nombre.
  const seen = new Set<string>();
  const unique = images.filter((f) => (seen.has(f.name) ? false : (seen.add(f.name), true)));
  const products = groupProducts(unique, { knownCodes, aliases: parseAliases(process.env.SKU_ALIASES) });
  const done = outputId ? await finishedSkus(outputId) : new Set<string>();
  // Si el catálogo no se pudo leer no se marca nada como "fuera del catálogo".
  return products.map((p) => ({ ...p, done: done.has(p.sku), inCatalog: !knownCodes.size || knownCodes.has(p.sku) }));
}
