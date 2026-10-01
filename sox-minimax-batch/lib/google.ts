import { requireUser, saveGoogleSession } from './session';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function baseUrl() {
  return (process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

export function googleAuthUrl(state: string) {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) throw new Error('Falta GOOGLE_CLIENT_ID');
  const p = new URLSearchParams({
    client_id: id,
    redirect_uri: `${baseUrl()}/api/auth/google/callback`,
    response_type: 'code',
    // openid + email: para saber qué cuenta entró y compararla con ALLOWED_EMAILS.
    scope: 'openid email https://www.googleapis.com/auth/drive',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/**
 * Mail de la cuenta, sacado del id_token. Como el token llega directo del endpoint de Google
 * por HTTPS (no del navegador), alcanza con revisar emisor, destinatario y mail verificado.
 */
export function emailFromIdToken(idToken: string | undefined, clientId: string) {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    const issOk = payload.iss === 'https://accounts.google.com' || payload.iss === 'accounts.google.com';
    if (!issOk || payload.aud !== clientId || payload.email_verified !== true || !payload.email) return undefined;
    return String(payload.email).toLowerCase();
  } catch {
    return undefined;
  }
}

export async function exchangeCode(code: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: `${baseUrl()}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error_description || j.error || 'No se pudo autenticar Google');
  return {
    access_token: j.access_token as string,
    refresh_token: j.refresh_token as string | undefined,
    expires_at: Date.now() + (j.expires_in || 3600) * 1000 - 60_000,
    email: emailFromIdToken(j.id_token, clientId),
  };
}

async function refresh(refreshToken: string) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      grant_type: 'refresh_token',
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Sesión de Google vencida, tocá "Conectar Google" de nuevo (${j.error_description || j.error})`);
  return { access_token: j.access_token as string, expires_in: (j.expires_in as number) || 3600 };
}

export async function accessToken() {
  // Toda llamada a Drive pasa por acá: sin cuenta autorizada no hay token.
  const s = await requireUser();
  if (s.expires_at > Date.now()) return s.access_token;
  if (!s.refresh_token) throw new Error('Sesión de Google vencida, tocá "Conectar Google" de nuevo');
  const r = await refresh(s.refresh_token);
  // En route handlers se puede reescribir la cookie; si no se puede, igual seguimos con el token nuevo.
  try {
    await saveGoogleSession({ ...s, access_token: r.access_token, expires_at: Date.now() + r.expires_in * 1000 - 60_000 });
  } catch {}
  return r.access_token;
}

async function gfetch(url: string, init: RequestInit = {}) {
  const token = await accessToken();
  const res = await fetch(url.startsWith('http') ? url : `${DRIVE}${url}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Google Drive ${res.status}: ${txt.slice(0, 500)}`);
  }
  return res;
}

export type DriveItem = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  thumbnailLink?: string;
  modifiedTime?: string;
};

/** Lista archivos con una query de Drive, recorriendo todas las páginas. */
export async function query(q: string, fields = 'id,name,mimeType,parents'): Promise<DriveItem[]> {
  const all: DriveItem[] = [];
  let pageToken = '';
  do {
    const p = new URLSearchParams({
      q,
      fields: `nextPageToken,files(${fields})`,
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) p.set('pageToken', pageToken);
    const j = await (await gfetch(`/files?${p}`)).json();
    all.push(...(j.files || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return all;
}

export const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Igual que query() pero para muchos padres a la vez, en tandas para no pasarse del largo de URL. */
export async function queryInParents(parentIds: string[], extra: string, fields?: string) {
  const out: DriveItem[] = [];
  for (let i = 0; i < parentIds.length; i += 40) {
    const chunk = parentIds.slice(i, i + 40);
    const parents = chunk.map((id) => `'${q(id)}' in parents`).join(' or ');
    out.push(...(await query(`trashed=false and (${parents}) and (${extra})`, fields)));
  }
  return out;
}

export async function listChildren(folderId: string) {
  return query(`'${q(folderId)}' in parents and trashed=false`);
}

export async function downloadFile(fileId: string): Promise<Buffer> {
  const res = await gfetch(`/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
  return Buffer.from(await res.arrayBuffer());
}

/** Texto plano de un Google Doc. */
export async function exportText(fileId: string) {
  const res = await gfetch(`/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`);
  return (await res.text()).replace(/^\uFEFF/, '');
}

export async function getFile(fileId: string, fields = 'id,name,mimeType,thumbnailLink') {
  const res = await gfetch(`/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`);
  return (await res.json()) as DriveItem;
}

/** Miniatura chica generada por Drive (mucho más liviana que bajar la foto entera). */
export async function thumbnail(fileId: string, size = 240): Promise<{ data: Buffer; type: string } | null> {
  const f = await getFile(fileId);
  if (!f.thumbnailLink) return null;
  const url = f.thumbnailLink.replace(/=s\d+$/, `=s${size}`);
  const res = await gfetch(url);
  return { data: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'image/jpeg' };
}

export async function findChild(parentId: string, name: string, mimeType?: string) {
  const extra = mimeType ? ` and mimeType='${q(mimeType)}'` : '';
  const items = await query(`'${q(parentId)}' in parents and trashed=false and name='${q(name)}'${extra}`);
  return items[0];
}

export async function createFolder(parentId: string, name: string) {
  const res = await gfetch(`/files?supportsAllDrives=true&fields=id,name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return (await res.json()) as DriveItem;
}

export async function ensureFolder(parentId: string, name: string) {
  return (await findChild(parentId, name, FOLDER_MIME)) || (await createFolder(parentId, name));
}

/** Manda un archivo a la papelera de Drive (se puede recuperar desde ahí). */
export async function trashFile(fileId: string) {
  await gfetch(`/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

type Uploaded = { id: string; name: string; webViewLink?: string };

/** Sube un archivo; si ya existe uno con el mismo nombre en esa carpeta, lo reemplaza (no duplica). */
export async function putFile(parentId: string, name: string, mimeType: string, data: Buffer): Promise<Uploaded> {
  const existing = await findChild(parentId, name);
  if (existing) {
    const res = await gfetch(
      `${UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=media&supportsAllDrives=true&fields=id,name,webViewLink`,
      { method: 'PATCH', headers: { 'Content-Type': mimeType }, body: new Uint8Array(data) },
    );
    return res.json();
  }
  const boundary = `sox_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const meta = JSON.stringify({ name, parents: [parentId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await gfetch(`${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: new Uint8Array(body),
  });
  return res.json();
}
