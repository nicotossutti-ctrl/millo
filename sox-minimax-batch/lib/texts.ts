import * as XLSX from 'xlsx';
import { downloadFile, exportText, query, q } from './google';

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

/** Códigos que existen en el catálogo SOX (para validar uniones tipo TE215 → TE215C). */
export async function catalogCodes(): Promise<Set<string>> {
  const id = process.env.DRIVE_CATALOG_FILE_ID;
  if (!id) return new Set();
  const sheets = await workbook(id);
  return new Set(Object.values(sheets).flat().map((r) => s(r.Codigo).toUpperCase()).filter(Boolean));
}

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

/**
 * Tu guion hablado: un Google Doc con el nombre exacto del SKU (como los de la carpeta CLIPS).
 * Si hay varios, usa el último modificado.
 */
export async function scriptFor(sku: string, alsoNames: string[] = []) {
  const names = [sku, ...alsoNames].map((n) => `name = '${q(n)}'`).join(' or ');
  const docs = await query(`trashed=false and mimeType='application/vnd.google-apps.document' and (${names})`, 'id,name,modifiedTime');
  docs.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
  for (const d of docs) {
    const text = para(await exportText(d.id));
    if (text) return text;
  }
  return null;
}

const sheetsOf = async (id?: string) => (id ? workbook(id).catch(() => null) : null);

/** Arma el TXT que acompaña al video. Si una fuente falla, sigue con lo que haya. */
export async function productText(sku: string, colors: string[], alsoNames: string[] = []) {
  const [masterSheets, catalogSheets, script] = await Promise.all([
    sheetsOf(process.env.DRIVE_TEXTS_FILE_ID),
    sheetsOf(process.env.DRIVE_CATALOG_FILE_ID),
    scriptFor(sku, alsoNames).catch(() => null),
  ]);
  const text = composeText(sku, colors, script, masterSheets && fromMaster(masterSheets, sku), catalogSheets && fromCatalog(catalogSheets, sku));
  return { text, hasScript: !!script };
}

export function composeText(
  sku: string,
  colors: string[],
  script: string | null,
  master: ReturnType<typeof fromMaster>,
  cat: ReturnType<typeof fromCatalog>,
) {
  const title = master?.title || (cat?.name ? `Medias SOX ${titleCase(cat.name)}` : `Medias SOX ${sku}`);
  const lines = [`${sku} · ${title}`];
  if (colors.length) lines.push(`Colores del video: ${colors.join(', ')}`);
  lines.push('', 'GUION', script || `(Todavía no hay guion. Escribilo en un Google Doc llamado ${sku} y tocá "Actualizar TXT".)`);

  if (master?.description) {
    lines.push('', 'DESCRIPCIÓN MERCADO LIBRE', master.description);
  } else if (cat) {
    lines.push('', 'DATOS DEL PRODUCTO');
    if (cat.category) lines.push(`Categoría: ${cat.category}`);
    if (cat.length) lines.push(`Largo: ${cat.length}`);
    if (cat.sizes) lines.push(`Talles: ${cat.sizes}`);
    if (cat.composition) lines.push(`Composición: ${cat.composition}`);
  }
  return lines.join('\n').trim() + '\n';
}

function titleCase(t: string) {
  return t.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}
