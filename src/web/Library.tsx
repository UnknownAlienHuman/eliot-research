// K1 Read route views. Presentation adapted from pinned legacy donor
// 7c034569b908d3b03a8b821b7c537477a24b10f7/sources/{projects,import,document}.
// No donor runtime/query/byte helpers. Root wires Routes/App/Shell + this CSS
// and owns routes/schema/shared/api. Ranges: UTF-8 bytes, end-exclusive.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { Project, Revision, Source } from "../shared/api";
import { MaterialSymbol } from "./ui/MaterialSymbol";
import { SourceUnderstanding } from "./Understanding";
export interface OutlineItem { label: string; start: number; end: number; }
const FILE_LIMIT = 25 * 1024 * 1024;
const POLL_MS = 3000;
const tone = (s: string) => (s === "readable" ? "ok" : s === "readable_with_warnings" ? "warn" : s === "pending" ? "busy" : s === "needs_conversion" ? "paused" : "bad");
const stateLabel = (s: string) => (s === "readable" ? "Readable" : s === "readable_with_warnings" ? "Readable with warnings" : s === "pending" ? "Converting" : s === "needs_conversion" ? "Needs readable text" : s === "failed" ? "Conversion failed" : s || "Unknown");
async function apiErrorMessage(res: Response): Promise<string> {
  try {
    const b = (await res.json()) as { error?: { message?: string } };
    if (b?.error?.message) return b.error.message;
  } catch { /* fall through to status text */ }
  return "Request failed with status " + res.status + ".";
}
async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.ok) return res.json() as Promise<T>;
  throw new Error(await apiErrorMessage(res));
}
function decodeCanonical(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
function decodeSlice(bytes: Uint8Array, start: number, end: number): string {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > bytes.length) throw new Error("Range does not fit the loaded text.");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.slice(start, end));
}
function toOutlineItems(blocks: unknown, text: string): OutlineItem[] {
  if (!Array.isArray(blocks)) return [];
  const bytes = new TextEncoder().encode(text);
  const out: OutlineItem[] = [];
  for (const raw of blocks as Array<{ type?: unknown; start?: unknown; end?: unknown }>) {
    if (raw.type !== "heading" || typeof raw.start !== "number" || typeof raw.end !== "number") continue;
    try {
      const label = decodeSlice(bytes, raw.start, raw.end).trim() || "(untitled)";
      out.push({ label, start: raw.start, end: raw.end });
    } catch { /* skip ranges that do not fit the loaded text */ }
  }
  return out;
}
function selectionBytes(pre: HTMLElement, text: string) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return undefined;
  const range = sel.getRangeAt(0);
  if (!pre.contains(range.commonAncestorContainer)) return undefined;
  const before = document.createRange();
  before.selectNodeContents(pre);
  before.setEnd(range.startContainer, range.startOffset);
  const startChar = before.toString().length;
  const selected = range.toString();
  if (!selected) return undefined;
  const enc = new TextEncoder();
  const start = enc.encode(text.slice(0, startChar)).length;
  const end = start + enc.encode(text.slice(startChar, startChar + selected.length)).length;
  if (end <= start) return undefined;
  try {
    decodeSlice(enc.encode(text), start, end);
  } catch { return undefined; }
  return { start, end };
}
function LoadGate({ text, failure, onRetry }: { text: string; failure: string; onRetry: () => void }) {
  return (<section className="er-lib" aria-busy={!failure}><p className="er-lib__hint" role={failure ? "alert" : "status"}>{failure || text}</p>{failure ? <button className="er-button er-button--tonal" type="button" onClick={onRetry}>Retry</button> : null}</section>);
}
export function Projects() {
  const [projects, setProjects] = useState<Project[] | undefined>(undefined);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; title: string } | undefined>(undefined);
  async function load() {
    try { const d = await apiJson<{ projects: Project[]; nextCursor: string | null }>("/api/projects"); setProjects(d.projects); setCursor(d.nextCursor); setFailure(""); }
    catch (err) { setFailure(err instanceof Error ? err.message : "Could not load projects."); }
  }
  useEffect(() => { void load(); }, []);
  async function loadMore() {
    if (!cursor) return;
    try { const d = await apiJson<{ projects: Project[]; nextCursor: string | null }>("/api/projects?cursor=" + encodeURIComponent(cursor)); setProjects((p) => [...(p ?? []), ...d.projects]); setCursor(d.nextCursor); }
    catch (err) { setFailure(err instanceof Error ? err.message : "Could not load more projects."); }
  }
  async function create() {
    const next = title.trim();
    if (!next || busy) return;
    setBusy(true);
    try {
      await apiJson("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: next }) });
      setTitle(""); await load();
    } catch (err) { setFailure(err instanceof Error ? err.message : "Could not create the project."); }
    setBusy(false);
  }
  async function patch(id: string, body: { title?: string; archived?: boolean }) {
    try {
      await apiJson("/api/projects/" + encodeURIComponent(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setEditing(undefined); await load();
    } catch (err) { setFailure(err instanceof Error ? err.message : "Could not update the project."); }
  }
  if (projects === undefined) return <LoadGate text="Opening your projects…" failure={failure} onRetry={() => void load()} />;
  return (
    <section className="er-lib" aria-labelledby="er-lib-projects">
      <header className="er-lib__head"><h1 className="er-lib__title" id="er-lib-projects">Projects</h1><p className="er-lib__hint">Create a project, then open its sources.</p></header>
      {failure ? <p className="er-lib__error" role="alert">{failure}</p> : null}
      <form className="er-lib__form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label className="er-field__label" htmlFor="er-lib-new-title">New project</label><input id="er-lib-new-title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} placeholder="Paper trail" maxLength={200} />
        <button className="er-button er-button--primary" type="submit" disabled={busy || !title.trim()}>Create</button>
      </form>
      {projects.length === 0 ? <p className="er-lib__empty">No projects yet. Create the first one above.</p> : (
        <ul className="er-lib__list">{projects.map((p) => (
          <li className="er-lib__row" key={p.id}>
            <span className="er-lib__row-main"><MaterialSymbol name="home" /><span><Link className="er-lib__row-title" to={"/p/" + encodeURIComponent(p.id) + "/sources"}>{p.title}</Link>{p.archivedAt !== null ? <span className="er-lib__badge">archived</span> : null}{p.description ? <span className="er-lib__row-meta">{p.description}</span> : null}</span></span>
            <span className="er-lib__actions">{editing?.id === p.id ? (<>
              <input aria-label="Project title" value={editing.title} maxLength={200} onChange={(e) => setEditing({ id: p.id, title: e.currentTarget.value })} />
              <button className="er-button er-button--tonal" type="button" disabled={!editing.title.trim()} onClick={() => void patch(p.id, { title: editing.title.trim() })}>Save</button>
              <button className="er-button er-button--text" type="button" onClick={() => setEditing(undefined)}>Cancel</button></>) : (<>
              <button className="er-button er-button--text" type="button" onClick={() => setEditing({ id: p.id, title: p.title })}>Rename</button>
              <button className="er-button er-button--text" type="button" onClick={() => void patch(p.id, { archived: p.archivedAt === null })}>{p.archivedAt === null ? "Archive" : "Unarchive"}</button></>)}
            </span>
          </li>))}
        </ul>)}
      {cursor ? <button className="er-button er-button--tonal" type="button" onClick={() => void loadMore()}>Load more</button> : null}
    </section>
  );
}
interface UploadRow { name: string; state: string; detail?: string; duplicateId?: string; duplicateTitle?: string; }
export function Library() {
  const { projectId } = useParams();
  const [sources, setSources] = useState<Source[] | undefined>(undefined);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [textTitle, setTextTitle] = useState("");
  const [textBody, setTextBody] = useState("");
  const [url, setUrl] = useState("");
  const [urlTitle, setUrlTitle] = useState("");
  const load = useMemo(() => async () => {
    if (!projectId) return;
    try { const d = await apiJson<{ sources: Source[]; nextCursor: string | null }>("/api/projects/" + encodeURIComponent(projectId) + "/sources"); setSources(d.sources); setCursor(d.nextCursor); setFailure(""); }
    catch (err) { setFailure(err instanceof Error ? err.message : "Could not load sources."); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!sources?.some((s) => s.readableState === "pending")) return;
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [sources, load]);
  async function loadMore() {
    if (!projectId || !cursor) return;
    try { const d = await apiJson<{ sources: Source[]; nextCursor: string | null }>("/api/projects/" + encodeURIComponent(projectId) + "/sources?cursor=" + encodeURIComponent(cursor)); setSources((p) => [...(p ?? []), ...d.sources]); setCursor(d.nextCursor); }
    catch (err) { setFailure(err instanceof Error ? err.message : "Could not load more sources."); }
  }
  async function uploadOne(file: File, index: number): Promise<void> {
    const mark = (p: Partial<UploadRow>) => setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...p } : r)));
    mark({ state: "uploading" });
    if (file.size > FILE_LIMIT) { mark({ state: "error", detail: "Larger than the 25 MiB file cap." }); return; }
    const form = new FormData();
    form.append("file", file, file.name);
    let res: Response;
    try {
      res = await fetch("/api/projects/" + encodeURIComponent(projectId ?? "") + "/sources/file", { method: "POST", body: form, credentials: "same-origin" });
    } catch (err) { mark({ state: "error", detail: err instanceof Error ? err.message : "Upload failed before a response arrived." }); return; }
    if (res.status === 409) {
      let dupId = "", dupTitle = "";
      try { const b = (await res.json()) as { duplicate?: { sourceId?: string; title?: string } }; dupId = b.duplicate?.sourceId ?? ""; dupTitle = b.duplicate?.title ?? ""; }
      catch { /* keep row actionable without parsed duplicate */ }
      if (!dupId) { mark({ state: "error", detail: "Duplicate details could not be read. Choose the file again to retry." }); return; }
      mark({ state: "duplicate", detail: "Exact duplicate of " + (dupTitle || file.name) + ".", duplicateId: dupId, duplicateTitle: dupTitle });
      return;
    }
    mark(res.ok ? { state: "done", detail: "Uploaded; conversion runs on the server." } : { state: "error", detail: await apiErrorMessage(res) });
  }
  async function uploadMany(files: readonly File[]) {
    if (!projectId || uploading || files.length === 0) return;
    setUploading(true);
    try {
      setRows(files.map((f) => ({ name: f.name, state: "queued" })));
      let next = 0;
      const worker = async () => { while (next < files.length) { const at = next; next += 1; const f = files[at]; if (f) await uploadOne(f, at); } };
      await Promise.all([worker(), worker()]);
      await load();
    } finally { setUploading(false); }
  }
  async function attach(sourceId: string) {
    try {
      await apiJson("/api/projects/" + encodeURIComponent(projectId ?? "") + "/sources/attach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId }) });
      await load();
    } catch (err) { setFailure(err instanceof Error ? err.message : "Could not attach the source."); }
  }
  async function submitDuplicate(path: string, label: string, payload: unknown): Promise<boolean> {
    let res: Response;
    try {
      res = await fetch("/api/projects/" + encodeURIComponent(projectId ?? "") + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), credentials: "same-origin" });
    } catch (err) { setFailure(err instanceof Error ? err.message : "The request failed before a response arrived."); return false; }
    if (res.status === 409) {
      let dupId = "", dupTitle = "";
      try { const b = (await res.json()) as { duplicate?: { sourceId?: string; title?: string } }; dupId = b.duplicate?.sourceId ?? ""; dupTitle = b.duplicate?.title ?? ""; }
      catch { /* keep row actionable without parsed duplicate */ }
      if (!dupId) { setFailure("Duplicate details could not be read. Submit again to retry."); return false; }
      setRows((prev) => [...prev, { name: label, state: "duplicate", detail: "Exact duplicate of " + (dupTitle || label) + ".", duplicateId: dupId, duplicateTitle: dupTitle }]);
      return false;
    }
    if (!res.ok) { setFailure(await apiErrorMessage(res)); return false; }
    return true;
  }
  async function submitText() {
    if (!textTitle.trim() || !textBody.trim()) return;
    const label = textTitle.trim();
    if (!await submitDuplicate("/sources/text", label, { title: label, text: textBody })) return;
    setTextTitle(""); setTextBody(""); await load();
  }
  async function submitUrl() {
    if (!url.trim()) return;
    const label = urlTitle.trim() || url.trim();
    if (!await submitDuplicate("/sources/url", label, { url: url.trim(), title: urlTitle.trim() || undefined })) return;
    setUrl(""); setUrlTitle(""); await load();
  }
  if (sources === undefined) return <LoadGate text="Loading sources…" failure={failure} onRetry={() => void load()} />;
  return (
    <section className="er-lib" aria-labelledby="er-lib-sources">
      <header className="er-lib__head"><div className="er-lib__actions"><Link className="er-button er-button--text" to="/">Projects</Link><Link className="er-button er-button--text" to={'/p/' + encodeURIComponent(projectId ?? '') + '/overview'}>Project overview</Link></div><h1 className="er-lib__title" id="er-lib-sources">Library</h1><p className="er-lib__hint">Pick many files at once: each uploads alone, two at a time. Lists and reads never start paid work.</p></header>
      {failure ? <p className="er-lib__error" role="alert">{failure}</p> : null}
      <div className="er-lib__drop"><label htmlFor="er-lib-files">Choose files (25 MiB cap each, one request per file)</label><input id="er-lib-files" type="file" multiple disabled={uploading} onChange={(e) => { void uploadMany(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value = ""; }} /></div>
      {rows.length > 0 ? (<ul className="er-lib__progress" aria-live="polite">{rows.map((r, i) => (
        <li key={r.name + i}><span>{r.name} — {r.state}{r.detail ? ": " + r.detail : ""}</span>{r.state === "duplicate" && r.duplicateId ? <button className="er-button er-button--tonal" type="button" onClick={() => void attach(r.duplicateId ?? "")}>Attach existing{r.duplicateTitle ? " (" + r.duplicateTitle + ")" : ""}</button> : null}</li>))}
      </ul>) : null}
      <form className="er-lib__form" onSubmit={(e) => { e.preventDefault(); void submitText(); }}>
        <label className="er-field__label" htmlFor="er-lib-text-title">Pasted text title</label><input id="er-lib-text-title" value={textTitle} maxLength={200} onChange={(e) => setTextTitle(e.currentTarget.value)} placeholder="Meeting notes" />
        <label className="er-field__label" htmlFor="er-lib-text-body">Text</label><textarea id="er-lib-text-body" value={textBody} onChange={(e) => setTextBody(e.currentTarget.value)} placeholder="Paste source text here" />
        <button className="er-button er-button--tonal" type="submit" disabled={!textTitle.trim() || !textBody.trim()}>Save text</button>
      </form>
      <form className="er-lib__form" onSubmit={(e) => { e.preventDefault(); void submitUrl(); }}>
        <label className="er-field__label" htmlFor="er-lib-url">Page URL (https only)</label><input id="er-lib-url" inputMode="url" value={url} onChange={(e) => setUrl(e.currentTarget.value)} placeholder="https://example.com/report" />
        <label className="er-field__label" htmlFor="er-lib-url-title">Title (optional)</label><input id="er-lib-url-title" value={urlTitle} maxLength={200} onChange={(e) => setUrlTitle(e.currentTarget.value)} />
        <button className="er-button er-button--tonal" type="submit" disabled={!url.trim()}>Add URL</button>
      </form>
      {sources.length === 0 ? <p className="er-lib__empty">No sources in this project yet.</p> : (
        <ul className="er-lib__list">{sources.map((s) => (
          <li className="er-lib__row" key={s.id}>
            <span className="er-lib__row-main"><MaterialSymbol name={s.readableState === "failed" ? "error" : "info"} /><span><Link className="er-lib__row-title" to={"/p/" + encodeURIComponent(projectId ?? "") + "/source/" + encodeURIComponent(s.id) + "?revisionId=" + encodeURIComponent(s.currentRevisionId ?? s.revisionId)}>{s.title}</Link><span className="er-lib__row-meta">{s.kind} · <span className="er-lib__badge" data-tone={tone(s.readableState)}>{stateLabel(s.readableState)}</span></span>{s.warningSummary ? <span className="er-lib__row-meta">{s.warningSummary}</span> : null}{s.error ? <span className="er-lib__error">{s.error}</span> : null}</span></span>
            <details className="er-lib__facts"><summary>Details</summary><div className="er-lib__facts-content">
              <p>Source ID: <span className="er-lib__mono">{s.id}</span></p>
              <p>Current revision: <span className="er-lib__mono">{s.currentRevisionId ?? s.revisionId}</span></p>
              <p>Current snapshot: {s.blockCount === null ? "block count unavailable" : s.blockCount + " blocks"}{s.readableSize === null ? " · readable size unavailable" : " · " + s.readableSize + " bytes of readable text"}</p>
              <p>{s.originalFilename ? s.originalFilename + " · " : ""}{s.originalSize} bytes original</p>
            </div></details>
          </li>))}
        </ul>)}
      {cursor ? <button className="er-button er-button--tonal" type="button" onClick={() => void loadMore()}>Load more</button> : null}
    </section>
  );
}
export function Reader() {
  const { projectId, sourceId } = useParams();
  const [params, setParams] = useSearchParams();
  const revisionId = params.get("revisionId") ?? "";
  const sp = params.get("start"), ep = params.get("end");
  const rangeStart = sp === null ? NaN : Number(sp);
  const rangeEnd = ep === null ? NaN : Number(ep);
  const [source, setSource] = useState<Source | undefined>(undefined);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [text, setText] = useState("");
  const [loadedRev, setLoadedRev] = useState("");
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [failure, setFailure] = useState("");
  const [copied, setCopied] = useState(false);
  const [replace, setReplace] = useState<File | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const rev = revisions.find((r) => r.id === (revisionId || source?.currentRevisionId || source?.revisionId || revisions[0]?.id || ""));
  const activeRevision = rev?.id ?? "";
  const activeRevisionNumber = rev?.revisionNo;
  const activeState = revisionId ? (rev?.readableState ?? "") : (rev?.readableState ?? source?.readableState ?? "");
  const textReady = loadedRev !== "" && loadedRev === activeRevision;
  const hasRange = textReady && Number.isSafeInteger(rangeStart) && Number.isSafeInteger(rangeEnd) && rangeStart >= 0 && rangeEnd > rangeStart;
  async function refreshMeta(signal?: AbortSignal) {
    const q = revisionId ? "?revisionId=" + encodeURIComponent(revisionId) : "";
    const d = await apiJson<{ source: Source; revisions: Revision[] }>("/api/sources/" + encodeURIComponent(sourceId ?? "") + q, signal ? { signal } : undefined);
    if (signal?.aborted) return;
    setSource(d.source); setRevisions(d.revisions);
  }
  async function reloadMeta(signal?: AbortSignal) {
    try { await refreshMeta(signal); if (!signal?.aborted) setFailure(""); }
    catch (err) { if (!signal?.aborted) setFailure(err instanceof Error ? err.message : "Could not open the source."); }
  }
  useEffect(() => { const c = new AbortController(); setFailure(""); void reloadMeta(c.signal); return () => c.abort(); }, [sourceId, revisionId]);
  useEffect(() => {
    if (!sourceId || activeState !== "pending") return;
    const timer = window.setInterval(async () => { try { await refreshMeta(); } catch { /* next tick retries */ } }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [sourceId, revisionId, activeState]);
  useEffect(() => {
    if (!activeRevision || activeState === "pending" || activeState === "failed" || activeState === "needs_conversion" || activeState === "") return;
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/revisions/" + encodeURIComponent(activeRevision) + "/text", { credentials: "same-origin" });
        if (!res.ok) throw new Error(await apiErrorMessage(res));
        const raw = decodeCanonical(await res.arrayBuffer());
        if (!live) return;
        setText(raw);
        const od = await apiJson<{ blocks: unknown }>("/api/revisions/" + encodeURIComponent(activeRevision) + "/outline");
        if (!live) return;
        setOutline(toOutlineItems(od.blocks, raw));
        setLoadedRev(activeRevision);
      } catch (err) { if (live) setFailure(err instanceof Error ? err.message : "Could not read the text."); }
    })();
    return () => { live = false; };
  }, [activeRevision, activeState]);
  const excerpt = useMemo(() => {
    if (!hasRange || !text) return "";
    try { return decodeSlice(new TextEncoder().encode(text), rangeStart, rangeEnd); }
    catch { return ""; }
  }, [hasRange, text, rangeStart, rangeEnd]);
  function copySelectionLink() {
    const pre = preRef.current;
    if (!pre || !activeRevision || !textReady) { setFailure("Open a readable revision before copying a passage link."); return; }
    const sel = selectionBytes(pre, text);
    if (!sel) { setFailure("Select a passage in the text first, then copy its link."); return; }
    setFailure("");
    const next = new URLSearchParams(params);
    next.set("revisionId", activeRevision); next.set("start", String(sel.start)); next.set("end", String(sel.end));
    setParams(next);
    void navigator.clipboard?.writeText(window.location.origin + window.location.pathname + "?" + next.toString()).then(() => setCopied(true), () => setCopied(false));
  }
  async function replaceFile() {
    if (!replace || !projectId || !source) return;
    const form = new FormData();
    form.append("file", replace, replace.name);
    form.append("sourceId", source.id);
    let res: Response;
    try {
      res = await fetch("/api/projects/" + encodeURIComponent(projectId) + "/sources/file", { method: "POST", body: form, credentials: "same-origin" });
    } catch (err) { setFailure(err instanceof Error ? err.message : "Replace failed before a response arrived."); return; }
    if (!res.ok) { setFailure(await apiErrorMessage(res)); return; }
    const body = (await res.json()) as { revisionId?: string };
    setReplace(null); setText(""); setOutline([]); setLoadedRev("");
    if (body.revisionId) setParams({ revisionId: body.revisionId });
    try { await refreshMeta(); } catch (err) { setFailure(err instanceof Error ? err.message : "Replaced, but the source would not reload."); }
  }
  if (!source) return <LoadGate text="Opening the source…" failure={failure} onRetry={() => void reloadMeta()} />;
  return (
    <section className="er-lib" aria-labelledby="er-lib-reader">
      <header className="er-lib__head"><Link className="er-button er-button--text" to={"/p/" + encodeURIComponent(projectId ?? "") + "/sources"}>Sources</Link><h1 className="er-lib__title" id="er-lib-reader">{source.title}</h1><p className="er-lib__hint"><span className="er-lib__badge" data-tone={tone(activeState)}>{stateLabel(activeState)}</span> · Passage links stay on their selected revision.</p></header>
      {failure ? <p className="er-lib__error" role="alert">{failure}</p> : null}
      {revisionId && !rev ? <p className="er-lib__error" role="alert">This revision is not part of this source. Clear the revision to open the newest readable text.</p> : null}
      {rev?.warningSummary ? <p className="er-lib__row-meta">{rev.warningSummary}</p> : null}
      <details className="er-lib__facts"><summary>Details</summary><div className="er-lib__facts-content">
        <p>Source ID: <span className="er-lib__mono">{source.id}</span></p>
        <p>Revision {activeRevisionNumber || "—"}: <span className="er-lib__mono">{activeRevision || "—"}</span></p>
        {rev ? <p>{rev.converter ?? "workers_ai_markdown"} · {rev.conversionCalls} calls{rev.conversionTokens != null ? " · " + rev.conversionTokens + " tokens" : ""}{rev.conversionMs != null ? " · " + rev.conversionMs + " ms" : ""}</p> : null}
        <p>Current source snapshot: {source.blockCount === null ? "block count unavailable" : source.blockCount + " blocks"}{source.readableSize === null ? " · readable size unavailable" : " · " + source.readableSize + " bytes of readable text"}{" · " + source.originalSize + " bytes original"}</p>
        {source.originalFilename ? <p>Original file: {source.originalFilename}</p> : null}
        {hasRange ? <p>Selected byte range [{rangeStart}, {rangeEnd}) in revision {activeRevision}.</p> : null}
        {revisions.length > 1 ? <div><p><strong>Revisions</strong></p><ul className="er-lib__revision-list">{revisions.map((r) => <li key={r.id}><Link to={"?revisionId=" + encodeURIComponent(r.id)}>{"Revision " + r.revisionNo + " · " + r.readableState}</Link><span className="er-lib__mono">{r.id}</span></li>)}</ul></div> : null}
      </div></details>
      {hasRange ? (<div className="er-lib__excerpt" role="note"><p>Selected passage from {source.title}.</p>{excerpt ? <pre>{excerpt}</pre> : <p className="er-lib__error">This passage could not be opened in the loaded text. Clear it and choose another passage.</p>}<Link className="er-button er-button--text" to={"?revisionId=" + encodeURIComponent(activeRevision)}>Clear passage</Link></div>) : null}
      <div className="er-lib__reader">
        <nav className="er-lib__outline" aria-label="Outline"><h2>Outline</h2>
          {!textReady || outline.length === 0 ? <p className="er-lib__hint">No outline for this revision.</p> : (<ul className="er-lib__outline-list">{outline.map((b, i) => (<li key={b.start + ":" + b.end + ":" + i}><Link to={"?revisionId=" + encodeURIComponent(activeRevision) + "&start=" + b.start + "&end=" + b.end}>{b.label}</Link></li>))}</ul>)}
        </nav>
        <div>
          <div className="er-lib__actions"><button className="er-button er-button--tonal" type="button" onClick={copySelectionLink}>Copy link to selection</button>{activeRevision ? <a className="er-button er-button--text" href={"/api/revisions/" + encodeURIComponent(activeRevision) + "/original"}>Original</a> : null}{copied ? <span className="er-lib__hint" role="status">Link copied; revision is pinned.</span> : null}</div>
          <form className="er-lib__form" onSubmit={(e) => { e.preventDefault(); void replaceFile(); }}>
            <label className="er-field__label" htmlFor="er-lib-replace">Replace with file (new revision of this source)</label><input id="er-lib-replace" type="file" onChange={(e) => setReplace(e.currentTarget.files?.[0] ?? null)} />
            <button className="er-button er-button--tonal" type="submit" disabled={!replace}>Upload new revision</button>
          </form>
          {activeState === "pending" ? <p className="er-lib__hint" role="status">Converting… this view refreshes on its own.</p> : null}
          {activeState === "needs_conversion" ? <p className="er-lib__hint" role="note">The original is saved. Upload a readable Markdown file to read this source.</p> : null}
          {activeState === "failed" ? <p className="er-lib__error" role="alert">{rev?.error ?? source.error ?? "Conversion failed."}</p> : null}
          <pre className="er-lib__text" ref={preRef}>{textReady ? text : ""}</pre>
        </div>
      </div>
      {(activeState === "readable" || activeState === "readable_with_warnings") && activeRevision ? <SourceUnderstanding key={(sourceId ?? "") + activeRevision} projectId={projectId ?? ""} sourceId={sourceId ?? ""} revisionId={activeRevision} sourceTitle={source.title} /> : null}
    </section>
  );
}
