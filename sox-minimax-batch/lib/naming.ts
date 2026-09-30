// Interpreta los nombres de archivo de las fotos. Ejemplos reales del Drive:
//   TE132B-C1-NEGRO-01.webp        foto original, ángulo 01 del color C1
//   TE132B-C1-NEGRO-DARK.png       misma variante, versión fondo oscuro
//   TE132B-ALL.webp / -ALL-DARK    foto con todas las variantes (se descarta)
//   CI35C-C1-BLANCO-REFLECTIVO-DARK.png   toma con flash del mismo color (se usa sólo si no hay otra)
//   TE260C-NEGRO-DARK.png          variante sin número de color

export type ParsedImage = {
  sku: string;
  key: string; // identifica la variante dentro del SKU, ej. "C1-NEGRO"
  label: string; // lo que se muestra, ej. "Negro"
  order: number; // número de color (C1 → 1) para ordenar
  dark: boolean;
  reflective: boolean;
  angle: number; // 01, 02, 03… (0 si no tiene)
};

const SKU_RE = /^[A-ZÑ]+\d+[A-Z]?$/;

export function parseImageName(fileName: string): ParsedImage | null {
  const base = fileName.normalize('NFC').replace(/\.[a-z0-9]+$/i, '').trim();
  if (/[_\s()]/.test(base.split('-')[0] || '')) return null;
  const tokens = base.split('-').map((t) => t.trim().toUpperCase()).filter(Boolean);
  const sku = tokens.shift();
  if (!sku || !SKU_RE.test(sku)) return null;
  if (tokens.includes('ALL')) return null;

  let dark = false;
  let reflective = false;
  let angle = 0;
  const rest: string[] = [];
  for (const t of tokens) {
    if (t === 'DARK') dark = true;
    else if (t === 'REFLECTIVO') reflective = true;
    else rest.push(t);
  }
  if (rest.length && /^\d{1,2}$/.test(rest[rest.length - 1])) angle = Number(rest.pop());
  if (!rest.length) return null;

  const key = rest.join('-');
  const m = /^C(\d+)$/.exec(rest[0]);
  const order = m ? Number(m[1]) : 99;
  const words = m ? rest.slice(1) : rest;
  const label = (words.length ? words : rest).map(titleCase).join(' ');
  return { sku, key, label, order, dark, reflective, angle };
}

export function titleCase(w: string) {
  return w.charAt(0) + w.slice(1).toLowerCase();
}

export type FileRef = { id: string; name: string };
export type Variant = { key: string; label: string; order: number; fileId: string; fileName: string; reflective: boolean };
export type Product = {
  sku: string;
  sets: { oscuro: Variant[]; original: Variant[] };
  source: 'oscuro' | 'original';
  missingInDark: string[]; // variantes que tienen foto original pero no versión oscura
  mergedFrom: string[]; // códigos de foto que se unieron a este SKU (ej. TE215 → TE215C)
};

export type GroupOptions = {
  /** Códigos que existen en el catálogo SOX. Sin esto no se une ningún código. */
  knownCodes?: Set<string>;
  /** Uniones explícitas, ej. { TE215: 'TE215C' }. Tienen prioridad. */
  aliases?: Record<string, string>;
};

/**
 * Algunas fotos vienen sin la letra final (TE215-…) y el artículo es TE215C.
 * Sólo se une si TE215 NO es un código del catálogo y hay exactamente un código TE215<letra>.
 */
export function resolveSku(sku: string, opts: GroupOptions): string {
  const alias = opts.aliases?.[sku];
  if (alias) return alias;
  const known = opts.knownCodes;
  if (!known?.size || known.has(sku) || !/\d$/.test(sku)) return sku;
  const matches = [...known].filter((k) => k.length === sku.length + 1 && k.startsWith(sku) && /[A-Z]$/.test(k));
  return matches.length === 1 ? matches[0] : sku;
}

export function parseAliases(spec?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (spec || '').split(/[,;\s]+/)) {
    const [from, to] = pair.split(/[=:>]+/).map((x) => x?.trim().toUpperCase());
    if (from && to) out[from] = to;
  }
  return out;
}

type Candidate = FileRef & ParsedImage;

function better(a: Candidate, b: Candidate) {
  // Preferimos: no reflectiva, ángulo más bajo (01), nombre más corto.
  if (a.reflective !== b.reflective) return a.reflective ? b : a;
  const aa = a.angle || 99;
  const ba = b.angle || 99;
  if (aa !== ba) return aa < ba ? a : b;
  return a.name.length <= b.name.length ? a : b;
}

function pickVariants(cands: Candidate[]): Variant[] {
  const byKey = new Map<string, Candidate>();
  for (const c of cands) {
    const cur = byKey.get(c.key);
    byKey.set(c.key, cur ? better(cur, c) : c);
  }
  // Si existe la versión normal de un color, descartamos la toma reflectiva de ese mismo color.
  const normalKeys = new Set([...byKey.values()].filter((c) => !c.reflective).map((c) => c.key));
  return [...byKey.values()]
    .filter((c) => !c.reflective || !normalKeys.has(c.key))
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key, 'es'))
    .map((c) => ({ key: c.key, label: c.label, order: c.order, fileId: c.id, fileName: c.name, reflective: c.reflective }));
}

export function groupProducts(files: FileRef[], opts: GroupOptions = {}): Product[] {
  const bySku = new Map<string, Candidate[]>();
  const merged = new Map<string, Set<string>>();
  for (const f of files) {
    const p = parseImageName(f.name);
    if (!p) continue;
    const sku = resolveSku(p.sku, opts);
    if (sku !== p.sku) merged.set(sku, (merged.get(sku) || new Set()).add(p.sku));
    const list = bySku.get(sku) || [];
    list.push({ ...f, ...p, sku });
    bySku.set(sku, list);
  }

  const out: Product[] = [];
  for (const [sku, cands] of bySku) {
    const oscuro = pickVariants(cands.filter((c) => c.dark));
    const original = pickVariants(cands.filter((c) => !c.dark));
    if (!oscuro.length && !original.length) continue;
    const darkLabels = new Set(oscuro.map((v) => v.label));
    const missingInDark = oscuro.length ? original.filter((v) => !darkLabels.has(v.label)).map((v) => v.label) : [];
    out.push({
      sku,
      sets: { oscuro, original },
      // Fondo oscuro sólo si están todos los colores; si no, el video quedaría con colores de menos.
      source: oscuro.length && (!missingInDark.length || !original.length) ? 'oscuro' : 'original',
      missingInDark,
      mergedFrom: [...(merged.get(sku) || [])],
    });
  }
  return out.sort((a, b) => a.sku.localeCompare(b.sku, 'es', { numeric: true }));
}
