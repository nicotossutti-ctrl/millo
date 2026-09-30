import * as XLSX from 'xlsx';
import { downloadFile } from './google';

export type Row = Record<string, unknown>;
const cache = new Map<string, { at: number; sheets: Record<string, Row[]> }>();

/** Baja un Excel del Drive y lo deja en memoria 10 minutos (se usa en cada SKU del batch). */
async function workbook(fileId: string) {
  const hit = cache.get(fileId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.sheets;
  const wb = XLSX.read(await downloadFile(fileId), { type: 'buffer' });
  const sheets: Record<string, Row[]> = {};
  for (const name of wb.SheetNames) sheets[name] = XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], { defval: '' });
  cache.set(fileId, { at: Date.now(), sheets });
  return sheets;
}

const s = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
// Igual que s() pero respeta los saltos de línea (las descripciones vienen en párrafos).
const para = (v: unknown) =>
  String(v ?? '').replace(/\r/g, '').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
const codes = (v: unknown) => s(v).toUpperCase().split(/\s*[·,|/]\s*/).filter(Boolean);

/** Busca la publicación x1 del SKU en PF_Master (hoja PUBLICACIONES_OBJETIVO). */
export function fromMaster(sheets: Record<string, Row[]>, sku: string) {
  const rows = sheets['PUBLICACIONES_OBJETIVO'] || [];
  const mine = rows.filter((r) => codes(r.Articulos).includes(sku));
  const row = mine.find((r) => s(r.Formato).toLowerCase() === 'x1') || mine[0];
  if (!row) return null;
  return { title: s(row.Concepto_publicacion), description: para(row.Descripcion_conversion) };
}

/** Datos técnicos del catálogo SOX (el texto largo del catálogo viene cortado del PDF, no se usa). */
export function fromCatalog(sheets: Record<string, Row[]>, sku: string) {
  const rows = Object.values(sheets).flat().filter((r) => s(r.Codigo).toUpperCase() === sku);
  const row = rows.find((r) => s(r.Tipo_Pack).toLowerCase() === 'unitario') || rows[0];
  if (!row) return null;
  return {
    name: s(row.Nombre),
    category: s(row.Categoria),
    length: s(row.Largo_Cana),
    sizes: s(row.Talles),
    composition: s(row.Composicion).replace(/\.$/, ''),
  };
}

const sheetsOf = async (id?: string) => (id ? workbook(id).catch(() => null) : null);

/** Arma el TXT que acompaña al video. Si una fuente falla, sigue con lo que haya. */
export async function productText(sku: string, colors: string[]) {
  const [masterSheets, catalogSheets] = await Promise.all([sheetsOf(process.env.DRIVE_TEXTS_FILE_ID), sheetsOf(process.env.DRIVE_CATALOG_FILE_ID)]);
  return composeText(sku, colors, masterSheets && fromMaster(masterSheets, sku), catalogSheets && fromCatalog(catalogSheets, sku));
}

export function composeText(sku: string, colors: string[], master: ReturnType<typeof fromMaster>, cat: ReturnType<typeof fromCatalog>) {
  const title = master?.title || (cat?.name ? `Medias SOX ${titleCase(cat.name)}` : `Medias SOX ${sku}`);
  const lines = [title, `Código: ${sku}${cat?.name ? ` · Modelo: ${cat.name}` : ''}`, `Colores del video: ${colors.join(', ')}`, ''];
  if (master?.description) {
    lines.push(master.description);
  } else if (cat) {
    if (cat.category) lines.push(`Categoría: ${cat.category}`);
    if (cat.length) lines.push(`Largo: ${cat.length}`);
    if (cat.sizes) lines.push(`Talles: ${cat.sizes}`);
    if (cat.composition) lines.push(`Composición: ${cat.composition}`);
    lines.push('', 'Palermo Fitness. Si tenés dudas sobre el producto o el talle, consultanos.');
  }
  return lines.join('\n').trim() + '\n';
}

function titleCase(t: string) {
  return t.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}
