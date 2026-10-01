// Interpreta los nombres de archivo de las fotos. Ejemplos reales del Drive:
//   TE132B-C1-NEGRO-01.webp        foto original, ángulo 01 del color C1
//   TE132B-C1-NEGRO-DARK.png       versión fondo oscuro (NO se usa, sólo se reporta)
//   TE132B-ALL.webp / -ALL-DARK    foto con todas las variantes (se descarta)
//   CI35C-C2-NEGRO-01-OFF.webp     toma alternativa (luz apagada) del mismo color: sólo si no hay otra
//   CI35C-C1-BLANCO-REFLECTIVO-DARK.png   idem, con flash
//   DE450C-01.webp                 producto de un solo color, sin color en el nombre → variante "Único"
//   CI35C.webp                     foto general sin color: se descarta si el SKU tiene colores
//   NI322C-C3-VERDE AGUA-01.webp   colores con espacio = con guion
//   FU36B-FRENTE.webp / -TALÓN     vistas de un mismo producto: FRENTE es la principal
//   DE170C-DAMA-C1-NEGRO-01.webp   prefijo antes del color → "Negro (Dama)"
//   Se descartan: copias "(1)" / "- copia", fotos de PACK, nombres en minúscula (descargas).

export type ParsedImage = {
  sku: string;
  key: string; // identifica la variante dentro del SKU, ej. "C1-NEGRO"
  label: string; // lo que se muestra, ej. "Negro"
  order: number; // número de color (C1 → 1) para ordenar
  dark: boolean;
  alt: boolean; // toma alternativa (OFF / REFLECTIVO)
  angle: number; // 01, 02, 03… (0 si no tiene)
};

const SKU_RE = /^[A-ZÑ]+\d+[A-Z]?$/;
// Vistas que no son colores: FRENTE es la toma principal, el resto son alternativas.
const MAIN_VIEW = new Set(['FRENTE']);
const ALT_VIEWS = new Set(['TALÓN', 'TALON', 'LATERAL', 'PERFIL', 'DETALLE', 'RELLENO', 'ESPALDA', 'SUELA', 'PLANTA', 'COSTADO']);
// Fotos grupales o de pack: no son una variante.
const GROUP = new Set(['ALL', 'PACK', 'TRIPACK', 'PACKS']);

export function parseImageName(fileName: string): ParsedImage | null {
  const base = fileName.normalize('NFC').replace(/\.[a-z0-9]+$/i, '').trim();
  const first = base.split('-')[0] || '';
  // Copias ("(1)", "- copia"), nombres con _ o en minúscula (descargas de la web) no son fotos de catálogo.
  if (/[_\s()]/.test(first) || first !== first.toUpperCase() || /\(\d+\)|\bcopia\b/i.test(base)) return null;
  const tokens = base.split(/[-\s]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
  const sku = tokens.shift();
  if (!sku || !SKU_RE.test(sku)) return null;
  if (tokens.some((t) => GROUP.has(t))) return null;

  let dark = false;
  let alt = false;
  let angle = 0;
  const rest: string[] = [];
  for (const t of tokens) {
    if (t === 'DARK') dark = true;
    else if (t === 'REFLECTIVO' || t === 'OFF' || ALT_VIEWS.has(t)) alt = true;
    else if (MAIN_VIEW.has(t)) continue;
    else rest.push(t);
  }
  if (rest.length && /^\d{1,3}$/.test(rest[rest.length - 1])) angle = Number(rest.pop());
  if (!rest.length) return { sku, key: UNICO, label: 'Único', order: 0, dark, alt, angle };

  const key = rest.join('-');
  // El número de color (C1, C2…) puede venir después de un prefijo, ej. DAMA-C1-NEGRO.
  // Si hay dos (DE170C-C2-C1-NEGRO-AMARILLO: modelo C2, color C1), el color es el último.
  const ci = rest.map((w) => /^C\d+$/.test(w)).lastIndexOf(true);
  const order = ci >= 0 ? Number(rest[ci].slice(1)) : 99;
  const prefix = ci > 0 ? rest.slice(0, ci) : [];
  const words = ci >= 0 ? rest.slice(ci + 1) : rest;
  const color = (words.length ? words : rest).map(titleCase).join(' ');
  const label = prefix.length ? `${color} (${prefix.map(titleCase).join(' ')})` : color;
  return { sku, key, label, order, dark, alt, angle };
}

export const UNICO = 'UNICO';

export function titleCase(w: string) {
  return w.charAt(0) + w.slice(1).toLowerCase();
}

export type FileRef = { id: string; name: string };
export type Variant = { key: string; label: string; order: number; fileId: string; fileName: string; alt: boolean };
export type Product = {
  sku: string;
  variants: Variant[]; // sólo fotos originales: las -DARK no se usan
  onlyInDark: string[]; // colores que existen sólo como -DARK (no entran en el video; se avisan)
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
  // Preferimos: toma normal (no OFF/REFLECTIVO), ángulo más bajo (01), nombre más corto.
  if (a.alt !== b.alt) return a.alt ? b : a;
  const aa = a.angle || 99;
  const ba = b.angle || 99;
  if (aa !== ba) return aa < ba ? a : b;
  return a.name.length <= b.name.length ? a : b;
}

function pickVariants(all: Candidate[]): Variant[] {
  // Una foto sin color (CI35C.webp) sólo cuenta si el SKU no tiene colores (producto de un solo color).
  const colored = all.filter((c) => c.key !== UNICO);
  const cands = colored.length ? colored : all;
  const byKey = new Map<string, Candidate>();
  for (const c of cands) {
    const cur = byKey.get(c.key);
    byKey.set(c.key, cur ? better(cur, c) : c);
  }
  return [...byKey.values()]
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key, 'es'))
    .map((c) => ({ key: c.key, label: c.label, order: c.order, fileId: c.id, fileName: c.name, alt: c.alt }));
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
    const variants = pickVariants(cands.filter((c) => !c.dark));
    const have = new Set(variants.map((v) => v.label));
    // En productos de un solo color ("Único") la DARK es el mismo producto: no hay nada que avisar.
    const single = variants.length === 1 && variants[0].key === UNICO;
    const onlyInDark = single ? [] : [...new Set(pickVariants(cands.filter((c) => c.dark)).map((v) => v.label))].filter((l) => l !== 'Único' && !have.has(l));
    out.push({ sku, variants, onlyInDark, mergedFrom: [...(merged.get(sku) || [])] });
  }
  return out.sort((a, b) => a.sku.localeCompare(b.sku, 'es', { numeric: true }));
}
