'use client';
import { useEffect, useMemo, useRef, useState } from 'react';

type Variant = { key: string; label: string; fileId: string; fileName: string; reflective: boolean };
type Product = {
  sku: string;
  sets: { oscuro: Variant[]; original: Variant[] };
  source: 'oscuro' | 'original';
  missingInDark: string[];
  mergedFrom: string[];
  done: boolean;
};
type Source = 'oscuro' | 'original';
type Sel = { source: Source; off: string[] };
type Motion = { peak: number; end: number };
type Item = {
  fileId: string;
  label: string;
  seconds: number;
  taskId?: string;
  status?: 'pending' | 'succeeded' | 'failed';
  url?: string;
  error?: string;
  motion?: Motion;
  redo?: boolean; // marcado a mano para regenerar sólo este clip
};
type Job = { items: Item[]; phase: 'generando' | 'armando' | 'terminado' | 'error'; detail: string; folderUrl?: string; at: number };

const LS_JOBS = 'sox-jobs-v2';
const LS_SEL = 'sox-sel-v2';
const load = <T,>(k: string, d: T): T => {
  try {
    return JSON.parse(localStorage.getItem(k) || '') as T;
  } catch {
    return d;
  }
};
const save = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (n: number) => `USD ${n.toFixed(2)}`;
const needsGen = (it: Item) => !it.taskId || it.status === 'failed' || !!it.redo;
const fresh = (it: Item): Item => ({ fileId: it.fileId, label: it.label, seconds: it.seconds });
/** Aviso aproximado a partir del movimiento medido (ver lib/video.ts). No garantiza los 360°. */
const motionWarn = (m?: Motion) => (!m ? '' : m.peak < 2 ? 'casi quieta' : m.end > Math.max(2.5, m.peak * 0.4) ? 'no termina de frente' : '');

async function api<T = any>(url: string, body?: unknown): Promise<{ ok: boolean; status: number; j: T & { error?: string } }> {
  const r = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j: any = {};
  try {
    j = await r.json();
  } catch {
    j = { error: `Respuesta inválida del servidor (${r.status})` };
  }
  return { ok: r.ok, status: r.status, j };
}

export default function Page() {
  const [status, setStatus] = useState<{ connected: boolean; missing: string[]; email?: string | null; denied?: boolean } | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [price, setPrice] = useState(0.08);
  const [clipTable, setClipTable] = useState<Record<number, number>>({});
  const [sel, setSel] = useState<Record<string, Sel>>({});
  const [jobs, setJobsState] = useState<Record<string, Job>>({});
  const jobsRef = useRef<Record<string, Job>>({});
  const [filter, setFilter] = useState('');
  const [hideDone, setHideDone] = useState(true);
  const [concurrency, setConcurrency] = useState(2);
  const [loop, setLoop] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const stopRef = useRef(false);
  const [batch, setBatch] = useState(false);
  // El armado (ffmpeg) es lo más pesado: se hace de a un SKU por vez aunque se generen varios en paralelo.
  const finalizeQueue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    api('/api/auth/status').then(({ j }) => setStatus(j as any));
    jobsRef.current = load(LS_JOBS, {});
    setJobsState(jobsRef.current);
    setSel(load(LS_SEL, {}));
  }, []);

  function patchJob(sku: string, patch: Partial<Job> | null) {
    const next = { ...jobsRef.current };
    if (patch === null) delete next[sku];
    else next[sku] = { ...(next[sku] || { items: [], phase: 'generando', detail: '', at: Date.now() }), ...patch, at: Date.now() };
    jobsRef.current = next;
    setJobsState(next);
    save(LS_JOBS, next);
  }
  function patchSel(sku: string, s: Sel) {
    setSel((cur) => {
      const next = { ...cur, [sku]: s };
      save(LS_SEL, next);
      return next;
    });
  }
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = finalizeQueue.current.catch(() => {}).then(fn);
    finalizeQueue.current = run;
    return run;
  }

  const selOf = (p: Product): Sel => sel[p.sku] || { source: p.source, off: [] };
  const variantsOf = (p: Product) => {
    const s = selOf(p);
    return (p.sets[s.source] || []).filter((v) => !s.off.includes(v.key));
  };
  const secondsFor = (n: number) => clipTable[n] || Math.min(15, Math.max(4, Math.round(15 / Math.max(1, n))));

  /** Qué se va a generar: reutiliza los clips ya pagos si la selección no cambió. */
  function planFor(p: Product, jobsMap = jobsRef.current) {
    const variants = variantsOf(p);
    const seconds = secondsFor(variants.length);
    const prev = jobsMap[p.sku];
    const same = !!prev && prev.items.length === variants.length && prev.items.every((it, i) => it.fileId === variants[i].fileId && it.seconds === seconds);
    const items: Item[] = same ? prev.items : variants.map((v) => ({ fileId: v.fileId, label: v.label, seconds }));
    const toGenerate = items.filter(needsGen).length;
    return { items, seconds, toGenerate, cost: toGenerate * seconds * price, fullCost: items.length * seconds * price };
  }

  async function scan() {
    setScanning(true);
    try {
      const { ok, j } = await api('/api/scan');
      if (!ok) throw new Error(j.error);
      setProducts(j.products);
      setPrice(j.pricePerSecond);
      setClipTable(j.clipTable);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setScanning(false);
    }
  }

  const shown = useMemo(() => {
    const f = filter.trim().toUpperCase();
    // Se ocultan sólo los que ya estaban terminados de antes; los que se procesan acá quedan a la vista para revisarlos.
    return products.filter((p) => (!f || p.sku.includes(f)) && (!hideDone || !p.done || running.has(p.sku) || !!jobs[p.sku]));
  }, [products, filter, hideDone, running, jobs]);

  async function processOne(p: Product) {
    const sku = p.sku;
    const plan = planFor(p);
    if (!plan.items.length) return;
    setRunning((r) => new Set(r).add(sku));
    try {
      let items = plan.items.map((it) => (needsGen(it) ? fresh(it) : it));
      patchJob(sku, { items, phase: 'generando', detail: 'enviando a MiniMax…', folderUrl: undefined });

      const missing = items.filter((it) => !it.taskId);
      if (missing.length) {
        const { j } = await api<{ created: { fileId: string; taskId: string }[] }>('/api/generate/start', {
          items: missing.map((it) => ({ fileId: it.fileId, seconds: plan.seconds })),
          loop,
        });
        const byFile = new Map((j.created || []).map((c) => [c.fileId, c.taskId]));
        items = items.map((it) => (!it.taskId && byFile.has(it.fileId) ? { ...it, taskId: byFile.get(it.fileId), status: 'pending' } : it));
        patchJob(sku, { items });
        if (j.error) throw new Error(j.error);
      }

      // La primera consulta refresca también los clips ya listos (sus links pueden haber cambiado).
      let refreshAll = true;
      let hiccups = 0;
      while (true) {
        const toQuery = items.filter((it) => it.taskId && (refreshAll || it.status !== 'succeeded'));
        if (!toQuery.length) break;
        type StatusReply = { tasks: { taskId: string; status: Item['status']; url?: string; error?: string }[] };
        const { ok, j } = await api<StatusReply>('/api/generate/status', { taskIds: toQuery.map((it) => it.taskId) }).catch((e) => ({
          ok: false,
          status: 0,
          j: { tasks: [], error: String(e?.message || e) } as StatusReply & { error?: string },
        }));
        if (!ok) {
          // Un corte de red momentáneo no debería marcar el SKU como fallado.
          if (++hiccups >= 4) throw new Error(j.error);
          await sleep(15000);
          continue;
        }
        hiccups = 0;
        refreshAll = false;
        const byTask = new Map(j.tasks.map((t) => [t.taskId, t]));
        items = items.map((it) => {
          const t = it.taskId ? byTask.get(it.taskId) : undefined;
          return t ? { ...it, status: t.status, url: t.url || it.url, error: t.error } : it;
        });
        const ready = items.filter((it) => it.status === 'succeeded').length;
        patchJob(sku, { items, detail: `${ready}/${items.length} variantes listas` });
        const failed = items.filter((it) => it.status === 'failed');
        if (failed.length) throw new Error(`MiniMax falló en ${failed.map((f) => `${f.label} (${f.error})`).join(', ')}. "Reintentar" regenera sólo esa variante.`);
        if (ready === items.length) break;
        await sleep(15000);
      }

      patchJob(sku, { phase: 'armando', detail: 'esperando turno para armar el video…' });
      const { ok, status: code, j } = await exclusive(() => {
        patchJob(sku, { detail: 'uniendo clips y subiendo a Drive…' });
        return api<{ folderUrl: string; motion: Motion[]; hasScript: boolean; badClips?: number[] }>('/api/finalize', {
          sku,
          urls: items.map((it) => it.url),
          colors: items.map((it) => it.label),
          alsoNames: p.mergedFrom,
        });
      });
      if (!ok) {
        if (code === 409 && j.badClips?.length) {
          // Sólo se vuelven a generar los clips cuyo link no se pudo bajar.
          const bad = new Set(j.badClips);
          items = items.map((it, i) => (bad.has(i) ? fresh(it) : it));
          patchJob(sku, { items });
          const labels = items.filter((_, i) => bad.has(i)).map((it) => it.label);
          throw new Error(`Venció el link de ${labels.join(', ')}. "Reintentar" regenera sólo ${labels.length === 1 ? 'ese clip' : 'esos clips'} (≈ ${usd(labels.length * plan.seconds * price)}).`);
        }
        throw new Error(j.error);
      }
      items = items.map((it, i) => ({ ...it, motion: j.motion?.[i], redo: false }));
      const warns = items.filter((it) => motionWarn(it.motion)).map((it) => it.label);
      const notes = [warns.length ? `revisá: ${warns.join(', ')}` : '', j.hasScript ? '' : 'TXT sin guion'].filter(Boolean);
      patchJob(sku, { items, phase: 'terminado', detail: ['MP4 + TXT en TERMINADOS', ...notes].join(' · '), folderUrl: j.folderUrl });
      setProducts((ps) => ps.map((x) => (x.sku === sku ? { ...x, done: true } : x)));
    } catch (e: any) {
      patchJob(sku, { phase: 'error', detail: e.message });
    } finally {
      setRunning((r) => {
        const n = new Set(r);
        n.delete(sku);
        return n;
      });
    }
  }

  async function runBatch() {
    const todo = shown.filter((p) => !p.done && variantsOf(p).length);
    if (!todo.length) return alert('No hay SKUs pendientes en la lista.');
    const total = todo.reduce((a, p) => a + planFor(p).cost, 0);
    if (!confirm(`Se van a procesar ${todo.length} SKUs.\nCosto estimado en MiniMax: ${usd(total)} (sin contar reintentos).\n\n¿Arrancamos?`)) return;
    stopRef.current = false;
    setBatch(true);
    const queue = [...todo];
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (queue.length && !stopRef.current) await processOne(queue.shift()!);
      }),
    );
    setBatch(false);
  }

  function runSingle(p: Product) {
    const plan = planFor(p);
    const job = jobsRef.current[p.sku];
    const finished = p.done || job?.phase === 'terminado';
    if (finished && plan.toGenerate === 0) {
      if (!confirm(`¿Regenerar TODOS los clips de ${p.sku}? ≈ ${usd(plan.fullCost)}\n(Para rehacer uno solo, tocá ↻ en ese clip.)`)) return;
      patchJob(p.sku, null);
    } else if (plan.toGenerate > 0) {
      const already = p.done && !job ? `${p.sku} ya tiene video terminado.\n` : '';
      if (!confirm(`${already}${p.sku}: generar ${plan.toGenerate} clip(s), ≈ ${usd(plan.cost)}. ¿Seguimos?`)) return;
    }
    processOne(p);
  }

  function toggleRedo(sku: string, idx: number) {
    const job = jobsRef.current[sku];
    if (!job) return;
    patchJob(sku, { items: job.items.map((it, i) => (i === idx ? { ...it, redo: !it.redo } : it)) });
  }

  async function updateText(p: Product) {
    const labels = (jobsRef.current[p.sku]?.items || variantsOf(p)).map((v) => v.label);
    const { ok, j } = await api<{ hasScript: boolean }>('/api/text', { sku: p.sku, colors: labels, alsoNames: p.mergedFrom });
    alert(ok ? (j.hasScript ? `TXT de ${p.sku} actualizado con tu guion.` : `TXT de ${p.sku} actualizado, pero no encontré un Google Doc llamado ${p.sku}.`) : j.error);
  }

  const pendingCost = shown.filter((p) => !p.done).reduce((a, p) => a + planFor(p, jobs).cost, 0);
  const ready = status?.connected && !status.missing.length;

  return (
    <main>
      <h1>SOX · Videos 360°</h1>
      <p>
        Drive → una foto por color (sin las ALL) → MiniMax gira cada media una vuelta → se ajusta la velocidad para que el total dure 15 s → MP4 vertical + TXT en
        <b> TERMINADOS - VIDEOS</b>.
      </p>

      <div className="card row">
        {status?.missing.length ? <span className="badge err">Faltan variables en Vercel: {status.missing.join(', ')}</span> : null}
        {status?.denied ? (
          <span className="badge err">La cuenta {status.email} no está autorizada</span>
        ) : (
          <span className={'badge ' + (status?.connected ? 'ok' : 'warn')}>{status?.connected ? `Drive conectado · ${status.email}` : 'Google Drive sin conectar'}</span>
        )}
        {status && !status.connected && !status.denied && (
          <a className="btn" href="/api/auth/google/start">
            Conectar Google
          </a>
        )}
        <button className="secondary" disabled={!ready || scanning} onClick={scan}>
          {scanning ? 'Escaneando…' : products.length ? 'Volver a escanear' : 'Escanear Drive'}
        </button>
        {(status?.connected || status?.denied) && (
          <a className="small-link" href="/api/auth/logout">
            desconectar
          </a>
        )}
      </div>

      {!!products.length && (
        <div className="card">
          <div className="row">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar SKU, ej. TE132" />
            <label>
              <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> ocultar terminados
            </label>
            <label title="Usa la misma foto como primer y último cuadro, así la vuelta termina de frente">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> forzar que termine de frente
            </label>
            <label title="SKUs que se generan a la vez en MiniMax. El armado final igual se hace de a uno.">
              en paralelo{' '}
              <select value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            {!batch ? (
              <button disabled={!shown.some((p) => !p.done)} onClick={runBatch}>
                Procesar {shown.filter((p) => !p.done).length} pendientes · ≈ {usd(pendingCost)}
              </button>
            ) : (
              <button className="secondary" onClick={() => (stopRef.current = true)}>
                Pausar después de lo que está en curso
              </button>
            )}
            <small>
              {products.length} SKUs · {products.filter((p) => p.done).length} terminados. Probá primero con uno solo (ej. TE132B) antes de largar todo.
            </small>
          </div>
        </div>
      )}

      {!!shown.length && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Variantes (tocá una para sacarla)</th>
                <th>Estimado</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const s = selOf(p);
                const set = p.sets[s.source];
                const job = jobs[p.sku];
                const busy = running.has(p.sku);
                const plan = planFor(p, jobs);
                const n = plan.items.length;
                const finished = p.done || job?.phase === 'terminado';
                const clips = job?.items.filter((it) => it.url) || [];
                const action = busy
                  ? '…'
                  : job?.phase === 'error'
                    ? 'Reintentar'
                    : finished && plan.toGenerate > 0 && job
                      ? `Regenerar ${plan.toGenerate} clip${plan.toGenerate > 1 ? 's' : ''}`
                      : finished
                        ? 'Rehacer todo'
                        : 'Procesar';
                return (
                  <tr key={p.sku}>
                    <td>
                      <b>{p.sku}</b>
                      <br />
                      {p.done && <span className="badge ok">terminado</span>}
                      {p.sets.oscuro.length > 0 && p.sets.original.length > 0 ? (
                        <select value={s.source} disabled={busy} onChange={(e) => patchSel(p.sku, { source: e.target.value as Source, off: [] })}>
                          <option value="oscuro">fondo oscuro</option>
                          <option value="original">fotos originales</option>
                        </select>
                      ) : (
                        <small>{s.source === 'oscuro' ? 'fondo oscuro' : 'fotos originales'}</small>
                      )}
                      {p.mergedFrom.length > 0 && (
                        <>
                          <br />
                          <small title="Fotos con este código se sumaron a este SKU porque el código sin letra no existe en el catálogo">incluye fotos {p.mergedFrom.join(', ')}</small>
                        </>
                      )}
                    </td>
                    <td>
                      <div className="variants">
                        {set.map((v) => {
                          const off = s.off.includes(v.key);
                          return (
                            <button
                              key={v.key}
                              className={'variant' + (off ? ' off' : '')}
                              disabled={busy}
                              title={v.fileName}
                              onClick={() => patchSel(p.sku, { ...s, off: off ? s.off.filter((k) => k !== v.key) : [...s.off, v.key] })}
                            >
                              <img src={`/api/thumb?id=${v.fileId}`} alt={v.label} loading="lazy" />
                              <span>{v.label}</span>
                            </button>
                          );
                        })}
                      </div>
                      {s.source === 'oscuro' && p.missingInDark.length > 0 && <small className="warn">Sin versión oscura: {p.missingInDark.join(', ')}</small>}
                      {clips.length > 0 && (
                        <div className="clips">
                          <small>Clips generados (pasá el mouse para verlos · ↻ marca uno para regenerar sólo ese):</small>
                          <div className="variants">
                            {job!.items.map((it, i) => {
                              const warn = motionWarn(it.motion);
                              return (
                                <div key={it.fileId} className={'variant clip' + (it.redo ? ' off' : '')}>
                                  {it.url ? (
                                    <video
                                      src={it.url}
                                      muted
                                      loop
                                      playsInline
                                      preload="metadata"
                                      onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                                      onMouseLeave={(e) => e.currentTarget.pause()}
                                      onClick={() => window.open(it.url, '_blank')}
                                    />
                                  ) : (
                                    <div className="placeholder" />
                                  )}
                                  <span>{it.label}</span>
                                  {warn && (
                                    <small className="warn" title={`Indicador aproximado (pico ${it.motion?.peak}, final ${it.motion?.end}). No garantiza 360°: miralo.`}>
                                      ⚠ {warn}
                                    </small>
                                  )}
                                  {it.taskId && it.status === 'succeeded' && (
                                    <button className="redo" disabled={busy} title="Regenerar sólo este clip" onClick={() => toggleRedo(p.sku, i)}>
                                      {it.redo ? 'deshacer' : '↻'}
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </td>
                    <td>
                      {n ? (
                        <>
                          {n} × {(15 / n).toFixed(2)} s
                          <br />
                          <small>
                            pide {plan.seconds} s c/u · ≈ {usd(plan.fullCost)}
                          </small>
                          {plan.toGenerate > 0 && plan.toGenerate < n && (
                            <>
                              <br />
                              <small className="ok">
                                falta generar {plan.toGenerate} · ≈ {usd(plan.cost)}
                              </small>
                            </>
                          )}
                          {n > 6 && (
                            <>
                              <br />
                              <small className="warn">muchas variantes: giro rápido</small>
                            </>
                          )}
                        </>
                      ) : (
                        <small className="err">sin variantes</small>
                      )}
                    </td>
                    <td>
                      {job && (
                        <>
                          <span className={'badge ' + (job.phase === 'terminado' ? 'ok' : job.phase === 'error' ? 'err' : 'warn')}>{busy && job.phase === 'error' ? 'reintentando' : job.phase}</span>
                          <br />
                          <small>{job.detail}</small>
                          {job.folderUrl && (
                            <>
                              <br />
                              <a href={job.folderUrl} target="_blank" rel="noreferrer">
                                abrir carpeta
                              </a>
                            </>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      <button className="secondary" disabled={busy || !n} onClick={() => runSingle(p)}>
                        {action}
                      </button>
                      {finished && !busy && (
                        <button className="link" onClick={() => updateText(p)} title="Rehace sólo el TXT (sin costo), ej. después de escribir el guion">
                          Actualizar TXT
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
