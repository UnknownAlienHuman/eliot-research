// K1 Read route views. Presentation adapted from pinned legacy donor
// 7c034569b908d3b03a8b821b7c537477a24b10f7/sources/{projects,import,document}.
// No donor runtime/query/byte helpers. Root wires Routes/App/Shell + this CSS
// and owns routes/schema/shared/api. Ranges: UTF-8 bytes, end-exclusive.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { Project, Revision, Source, SourceSelection } from "../shared/api";
import { readableTextWarning } from "../ingest";
import { MaterialSymbol } from "./ui/MaterialSymbol";
import { SourceUnderstanding } from "./Understanding";
import { SourceOcr } from "./Ocr";
export interface OutlineItem { label: string; start: number; end: number; }
const FILE_LIMIT = 25 * 1024 * 1024;
const POLL_MS = 3000;
const tone = (s: string) => (s === "readable" ? "ok" : s === "readable_with_warnings" ? "warn" : s === "pending" ? "busy" : s === "needs_conversion" ? "paused" : "bad");
function stateLabel(s: string): string {
  switch (s) {
    case "readable": return "Readable";
    case "readable_with_warnings": return "Readable with warnings";
    case "pending": return "Converting";
    case "needs_conversion": return "Needs readable text";
    case "failed": return "Conversion failed";
    case "queued": return "Waiting to upload";
    case "uploading": return "Uploading";
    case "done": return "Uploaded";
    case "error": return "Upload failed";
    case "duplicate": return "Already in Library";
    case "attached": return "Added to this project";
    default: return "Unknown";
  }
}
const sourceKindLabels: Record<Source["kind"], string> = { file: "File", url: "Web page", text: "Pasted text" };
function formatRevisionDate(createdAt: number): string {
  if (!Number.isFinite(createdAt)) return "";
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function revisionLabel(r: Revision, currentId: string): string {
  const pos = r.id === currentId ? "Current" : "Saved";
  const date = formatRevisionDate(r.createdAt);
  return "Revision " + r.revisionNo + " \u00b7 " + pos + " \u00b7 " + stateLabel(r.readableState) + (date ? " \u00b7 " + date : "");
}
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
      <form className="er-field er-lib__form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label className="er-field__label" htmlFor="er-lib-new-title">New project</label><input id="er-lib-new-title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} placeholder="Paper trail" maxLength={200} />
        <button className="er-button er-button--primary" type="submit" disabled={busy || !title.trim()}>Create</button>
      </form>
      {projects.length === 0 ? <p className="er-card er-lib__empty">No projects yet. Create the first one above.</p> : (
        <ul className="er-lib__list">{projects.map((p) => (
          <li className="er-lib__row" key={p.id}>
            <span className="er-lib__row-main"><MaterialSymbol name="home" /><span><Link className="er-lib__row-title" to={"/p/" + encodeURIComponent(p.id) + "/sources"}>{p.title}</Link>{p.archivedAt !== null ? <span className="er-chip er-lib__badge">Archived</span> : null}{p.description ? <span className="er-lib__row-meta">{p.description}</span> : null}</span></span>
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
export interface SourcesPaneProps {
  projectId: string;
  selection: SourceSelection;
  onSelectionChange(next: SourceSelection): void;
}

function isReadableSource(source: Source): boolean {
  return source.currentRevisionId !== null;
}

function understandingLabel(source: Source): string {
  switch (source.distillState) {
    case "none": return "Not analyzed";
    case "queued": return "Queued";
    case "running": return "Analyzing";
    case "paused": return "Paused";
    case "done": return source.claimCount > 0 ? "Ready · " + source.claimCount + " claims" : "Ready";
    case "partial": return source.claimCount > 0 ? "Partial · " + source.claimCount + " claims" : "Partial";
    case "failed": return "Failed";
    default: return "Unknown";
  }
}

function understandingTone(state: Source["distillState"]): string {
  switch (state) {
    case "done": return "ok";
    case "partial": return "warn";
    case "queued":
    case "running": return "busy";
    case "paused":
    case "none": return "paused";
    case "failed": return "bad";
    default: return "paused";
  }
}

export function SourcesPane({ projectId, selection, onSelectionChange }: SourcesPaneProps) {
  const headingId = useId();
  const dialogId = useId();
  const dialogHeadingId = useId();
  const fileInputId = useId();
  const textTitleId = useId();
  const textBodyId = useId();
  const urlId = useId();
  const urlTitleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const dialogHeadingRef = useRef<HTMLHeadingElement | null>(null);
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
    try {
      const d = await apiJson<{ sources: Source[]; nextCursor: string | null }>("/api/projects/" + encodeURIComponent(projectId) + "/sources");
      setSources(d.sources);
      setCursor(d.nextCursor);
      setFailure("");
    } catch (err) { setFailure(err instanceof Error ? err.message : "Could not load sources."); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { dialogRef.current?.close(); }, [projectId]);
  useEffect(() => {
    if (!sources?.some((s) => s.readableState === "pending" || s.distillState === "queued" || s.distillState === "running")) return;
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [sources, load]);
  const projectDefaultIds = useMemo(
    () => (sources ?? []).filter((s) => isReadableSource(s) && s.enabled !== false).map((s) => s.id),
    [sources],
  );
  const sourceById = useMemo(() => new Map<string, Source>((sources ?? []).map((s) => [s.id, s])), [sources]);
  const defaultScopeIncomplete = selection.scopeMode === "project_default" && (sources === undefined || cursor !== null);
  function selectedIdsForEdit(): string[] {
    if (selection.scopeMode === "project_default") {
      const preserved = selection.sourceIds.filter((id) => {
        const known = sourceById.get(id);
        return !known || (isReadableSource(known) && known.enabled !== false);
      });
      return Array.from(new Set([...preserved, ...projectDefaultIds]));
    }
    return selection.scopeMode === "explicit" ? Array.from(new Set(selection.sourceIds)) : [];
  }
  function publishExplicit(ids: readonly string[]) {
    const next = Array.from(new Set(ids));
    onSelectionChange(next.length > 0
      ? { scopeMode: "explicit", sourceIds: next }
      : { scopeMode: "empty", sourceIds: [] });
  }
  function toggleSource(source: Source) {
    if (!isReadableSource(source) || defaultScopeIncomplete) return;
    const next = new Set(selectedIdsForEdit());
    if (next.has(source.id)) next.delete(source.id);
    else next.add(source.id);
    publishExplicit(Array.from(next));
  }

  function changeProjectDefault(checked: boolean) {
    if (!checked && defaultScopeIncomplete) return;
    if (checked) onSelectionChange({ scopeMode: "project_default", sourceIds: projectDefaultIds });
    else publishExplicit(selectedIdsForEdit());
  }
  function openAddDialog() {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    dialogHeadingRef.current?.focus();
  }
  async function loadMore() {
    if (!cursor) return;
    try {
      const d = await apiJson<{ sources: Source[]; nextCursor: string | null }>("/api/projects/" + encodeURIComponent(projectId) + "/sources?cursor=" + encodeURIComponent(cursor));
      setSources((previous) => [...(previous ?? []), ...d.sources]);
      setCursor(d.nextCursor);
      setFailure("");
    } catch (err) { setFailure(err instanceof Error ? err.message : "Could not load more sources."); }
  }
  async function uploadOne(file: File, index: number): Promise<void> {
    const mark = (patch: Partial<UploadRow>) => setRows((previous) => previous.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    mark({ state: "uploading" });
    if (file.size > FILE_LIMIT) { mark({ state: "error", detail: "This file is too large. Choose a smaller file." }); return; }
    const form = new FormData();
    form.append("file", file, file.name);
    let res: Response;
    try {
      res = await fetch("/api/projects/" + encodeURIComponent(projectId) + "/sources/file", { method: "POST", body: form, credentials: "same-origin" });
    } catch (err) { mark({ state: "error", detail: err instanceof Error ? err.message : "Upload failed before a response arrived." }); return; }
    if (res.status === 409) {
      let duplicateId = "", duplicateTitle = "";
      try {
        const body = (await res.json()) as { duplicate?: { sourceId?: string; title?: string } };
        duplicateId = body.duplicate?.sourceId ?? "";
        duplicateTitle = body.duplicate?.title ?? "";
      } catch { /* keep the row actionable without parsed duplicate details */ }
      if (!duplicateId) { mark({ state: "error", detail: "Duplicate details could not be read. Choose the file again to retry." }); return; }
      mark({ state: "duplicate", detail: "Exact duplicate of " + (duplicateTitle || file.name) + ".", duplicateId, duplicateTitle });
      return;
    }
    mark(res.ok ? { state: "done" } : { state: "error", detail: await apiErrorMessage(res) });
  }
  async function uploadMany(files: readonly File[]) {
    if (uploading || files.length === 0) return;
    setUploading(true);
    try {
      setRows(files.map((file) => ({ name: file.name, state: "queued" })));
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const index = next;
          next += 1;
          const file = files[index];
          if (file) await uploadOne(file, index);
        }
      };
      await Promise.all([worker(), worker()]);
      await load();
    } finally { setUploading(false); }
  }
  async function attach(sourceId: string) {
    try {
      await apiJson("/api/projects/" + encodeURIComponent(projectId) + "/sources/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId }),
      });
      setRows((previous) => previous.map((row) => row.duplicateId === sourceId
        ? { ...row, state: "attached", detail: "Attached from the shared Library." }
        : row));
      await load();
    } catch (err) { setFailure(err instanceof Error ? err.message : "Could not attach the existing source."); }
  }
  async function submitDuplicate(path: string, label: string, payload: unknown): Promise<boolean> {
    let res: Response;
    try {
      res = await fetch("/api/projects/" + encodeURIComponent(projectId) + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "same-origin",
      });
    } catch (err) { setFailure(err instanceof Error ? err.message : "The request failed before a response arrived."); return false; }
    if (res.status === 409) {
      let duplicateId = "", duplicateTitle = "";
      try {
        const body = (await res.json()) as { duplicate?: { sourceId?: string; title?: string } };
        duplicateId = body.duplicate?.sourceId ?? "";
        duplicateTitle = body.duplicate?.title ?? "";
      } catch { /* keep the row actionable without parsed duplicate details */ }
      if (!duplicateId) { setFailure("Duplicate details could not be read. Submit again to retry."); return false; }
      setRows((previous) => [...previous, {
        name: label,
        state: "duplicate",
        detail: "Exact duplicate of " + (duplicateTitle || label) + ".",
        duplicateId,
        duplicateTitle,
      }]);
      return false;
    }
    if (!res.ok) { setFailure(await apiErrorMessage(res)); return false; }
    return true;
  }
  async function submitText() {
    if (!textTitle.trim() || !textBody.trim()) return;
    const label = textTitle.trim();
    if (!await submitDuplicate("/sources/text", label, { title: label, text: textBody })) return;
    setTextTitle("");
    setTextBody("");
    await load();
  }
  async function submitUrl() {
    if (!url.trim()) return;
    const label = urlTitle.trim() || url.trim();
    if (!await submitDuplicate("/sources/url", label, { url: url.trim(), title: urlTitle.trim() || undefined })) return;
    setUrl("");
    setUrlTitle("");
    await load();
  }
  function sourceStatus(source: Source): { label: string; tone: string; latest?: string } {
    if (!isReadableSource(source)) return { label: stateLabel(source.readableState), tone: tone(source.readableState) };
    const latest = source.revisionId !== source.currentRevisionId ? "Latest version: " + stateLabel(source.readableState) : undefined;
    return {
      label: understandingLabel(source),
      tone: understandingTone(source.distillState),
      ...(latest ? { latest } : {}),
    };
  }
  if (!projectId) return <section className="er-sources-pane" aria-labelledby={headingId}><h1 className="er-lib__title" id={headingId}>Sources</h1><p role="status">Choose a project to view sources.</p></section>;
  return (
    <section className="er-sources-pane" aria-labelledby={headingId}>
      <header className="er-sources-pane__head">
        <div className="er-sources-pane__toolbar">
          <div className="er-sources-pane__heading">
            <h1 className="er-lib__title" id={headingId}>Sources</h1>
            <p className="er-lib__hint">Select readable sources for this project.</p>
          </div>
          <button className="er-button er-button--tonal" type="button" aria-haspopup="dialog" aria-controls={dialogId} onClick={openAddDialog}>
            Add
          </button>
        </div>
        <label className="er-sources-pane__default">
          <input type="checkbox" checked={selection.scopeMode === "project_default"} disabled={defaultScopeIncomplete} onChange={(event) => changeProjectDefault(event.currentTarget.checked)} />
          <span>Project default</span>
          <span className="er-sources-pane__default-hint">Use the sources enabled for this project</span>
        </label>
        {defaultScopeIncomplete ? (
          <p className="er-sources-pane__default-hint" role="status">
            {sources === undefined
              ? failure ? "Retry loading sources before customizing this scope." : "Loading sources before customizing this scope."
              : "Load remaining sources before customizing this scope. Use Load more sources below."}
          </p>
        ) : null}
      </header>
      <div className="er-sources-pane__scroll" aria-busy={sources === undefined}>
        {sources !== undefined && failure ? <p className="er-lib__error" role="alert">{failure}{cursor ? <button className="er-button er-button--text" type="button" onClick={() => void loadMore()}>Retry</button> : null}</p> : null}
        {sources === undefined ? (
          <div className="er-sources-pane__load">
            {failure ? <p className="er-lib__error" role="alert">{failure}</p> : <p className="er-sources-pane__empty" role="status">Loading sources…</p>}
            {failure ? <button className="er-button er-button--text" type="button" onClick={() => void load()}>Retry</button> : null}
          </div>
        ) : sources.length === 0 ? (
          <p className="er-sources-pane__empty">No sources in this project yet.</p>
        ) : (
          <ul className="er-sources-pane__rows">
            {sources.map((source) => {
              const readable = isReadableSource(source);
              const checked = readable && (selection.scopeMode === "project_default"
                ? source.enabled !== false
                : selection.scopeMode === "explicit" && selection.sourceIds.includes(source.id));
              const status = sourceStatus(source);
              const readerRevisionId = source.currentRevisionId ?? source.revisionId;
              return (
                <li className="er-sources-pane__row" key={source.id} data-selected={checked}>
                  <label className="er-sources-pane__checkbox">
                    <input
                      type="checkbox"
                      aria-label={"Include " + source.title + " in the current source selection"}
                      checked={checked}
                      disabled={!readable || defaultScopeIncomplete}
                      onChange={() => toggleSource(source)}
                    />
                  </label>
                  <div className="er-sources-pane__row-main">
                    <Link className="er-sources-pane__row-title" title={source.title} to={"/p/" + encodeURIComponent(projectId) + "/source/" + encodeURIComponent(source.id) + "?revisionId=" + encodeURIComponent(readerRevisionId)}>{source.title}</Link>
                    <span className="er-chip er-lib__badge" data-tone={status.tone}>{status.label}</span>
                    {status.latest ? <span className="er-sources-pane__latest">{status.latest}</span> : null}
                  </div>
                  <a className="er-button er-button--text er-sources-pane__original" href={"/api/revisions/" + encodeURIComponent(source.revisionId) + "/original"} download aria-label={"Download original: " + source.title}>Original</a>
                </li>
              );
            })}
          </ul>
        )}
        {cursor ? <button className="er-button er-button--tonal" type="button" onClick={() => void loadMore()}>Load more sources</button> : null}
      </div>
      <dialog ref={dialogRef} id={dialogId} className="er-dialog er-sources-pane__dialog" aria-labelledby={dialogHeadingId}>
        <div className="er-sources-pane__dialog-head">
          <h2 className="er-dialog__title" id={dialogHeadingId} ref={dialogHeadingRef} tabIndex={-1}>Add sources</h2>
          <button className="er-button er-button--text" type="button" onClick={() => dialogRef.current?.close()}>Close</button>
        </div>
        <div className="er-dialog__body">
          {failure ? <p className="er-lib__error" role="alert">{failure}</p> : null}
          <div className="er-card er-field er-lib__drop">
            <label htmlFor={fileInputId}>Choose files</label>
            <input id={fileInputId} type="file" multiple disabled={uploading} onChange={(event) => { void uploadMany(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
          </div>
          <form className="er-field er-lib__form" onSubmit={(event) => { event.preventDefault(); void submitText(); }}>
            <label className="er-field__label" htmlFor={textTitleId}>Pasted text title</label>
            <input id={textTitleId} value={textTitle} maxLength={200} onChange={(event) => setTextTitle(event.currentTarget.value)} placeholder="Meeting notes" />
            <label className="er-field__label" htmlFor={textBodyId}>Text</label>
            <textarea id={textBodyId} value={textBody} onChange={(event) => setTextBody(event.currentTarget.value)} placeholder="Paste source text here" />
            <button className="er-button er-button--tonal" type="submit" disabled={!textTitle.trim() || !textBody.trim()}>Add text</button>
          </form>
          <form className="er-field er-lib__form" onSubmit={(event) => { event.preventDefault(); void submitUrl(); }}>
            <label className="er-field__label" htmlFor={urlId}>Page URL (https only)</label>
            <input id={urlId} inputMode="url" value={url} onChange={(event) => setUrl(event.currentTarget.value)} placeholder="https://example.com/report" />
            <label className="er-field__label" htmlFor={urlTitleId}>Title (optional)</label>
            <input id={urlTitleId} value={urlTitle} maxLength={200} onChange={(event) => setUrlTitle(event.currentTarget.value)} />
            <button className="er-button er-button--tonal" type="submit" disabled={!url.trim()}>Add URL</button>
          </form>
          {rows.length > 0 ? (
            <ul className="er-card er-lib__progress" aria-live="polite">
              {rows.map((row, index) => (
                <li key={row.name + index}>
                  <span>{row.name} — {stateLabel(row.state)}{row.detail ? ": " + row.detail : ""}</span>
                  {row.state === "duplicate" && row.duplicateId ? <button className="er-button er-button--tonal" type="button" onClick={() => void attach(row.duplicateId ?? "")}>Attach from Library{row.duplicateTitle ? " (" + row.duplicateTitle + ")" : ""}</button> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </dialog>
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
  const currentId = source?.currentRevisionId ?? source?.revisionId ?? revisions[0]?.id ?? "";
  const activeState = revisionId ? (rev?.readableState ?? "") : (rev?.readableState ?? source?.readableState ?? "");
  const textReady = loadedRev !== "" && loadedRev === activeRevision;
  const readableWarning = useMemo(() => rev?.warningSummary ?? (textReady ? readableTextWarning(text) : null), [rev?.warningSummary, textReady, text]);
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
      <header className="er-lib__head"><Link className="er-button er-button--text" to={"/p/" + encodeURIComponent(projectId ?? "") + "/sources"}>Sources</Link><h1 className="er-lib__title" id="er-lib-reader">{source.title}</h1><p className="er-lib__hint"><span className="er-chip er-lib__badge" data-tone={tone(activeState)}>{stateLabel(activeState)}</span></p></header>
      {failure ? <p className="er-lib__error" role="alert">{failure}</p> : null}
      {revisionId && !rev ? <p className="er-lib__error" role="alert">This revision is not available for this source. Open its current revision from the Library.</p> : null}
      {readableWarning ? <p className="er-lib__row-meta">{readableWarning}</p> : null}
      <details className="er-lib__facts"><summary>Details</summary><div className="er-lib__facts-content">
        <p>{sourceKindLabels[source.kind]}</p>
        {source.originalFilename ? <p>Original file: {source.originalFilename}</p> : null}
        {activeRevision ? <p><a href={"/api/revisions/" + encodeURIComponent(activeRevision) + "/original"}>Download original</a></p> : null}
        {rev ? <p>{revisionLabel(rev, currentId)}.</p> : null}
        {revisions.length > 1 ? <div className="er-field"><label className="er-field__label" htmlFor="er-lib-revision">Revision</label><select id="er-lib-revision" value={activeRevision} onChange={(e) => { const id = e.currentTarget.value; if (id) setParams({ revisionId: id }); }}>{revisions.map((r) => <option key={r.id} value={r.id}>{revisionLabel(r, currentId)}</option>)}</select></div> : null}
      </div></details>
      {hasRange ? (<div className="er-card er-field er-lib__excerpt" role="note"><p>Selected passage from {source.title}.</p>{excerpt ? <pre>{excerpt}</pre> : <p className="er-lib__error">This passage could not be opened in the loaded text. Clear it and choose another passage.</p>}<Link className="er-button er-button--text" to={"?revisionId=" + encodeURIComponent(activeRevision)}>Clear passage</Link></div>) : null}
      <div className="er-lib__reader">
        <nav className="er-lib__outline" aria-label="Outline"><h2>Outline</h2>
          {!textReady || outline.length === 0 ? <p className="er-lib__hint">No outline available.</p> : (<ul className="er-lib__outline-list">{outline.map((b, i) => (<li key={b.start + ":" + b.end + ":" + i}><Link to={"?revisionId=" + encodeURIComponent(activeRevision) + "&start=" + b.start + "&end=" + b.end}>{b.label}</Link></li>))}</ul>)}
        </nav>
        <div>
          <div className="er-lib__actions"><button className="er-button er-button--tonal" type="button" onClick={copySelectionLink}>Copy link to selection</button>{activeRevision ? <a className="er-button er-button--text" href={"/api/revisions/" + encodeURIComponent(activeRevision) + "/original"}>Original</a> : null}{copied ? <span className="er-lib__hint" role="status">Link copied.</span> : null}</div>
          {projectId && sourceId && activeRevision && activeRevision === source.revisionId && rev?.originalMime === "application/pdf" && activeState !== "pending"
            ? <SourceOcr projectId={projectId} sourceId={sourceId} revisionId={activeRevision} onApplied={id => {
              setText(""); setOutline([]); setLoadedRev(""); setParams({ revisionId: id });
            }} /> : null}
          <form className="er-field er-lib__form" onSubmit={(e) => { e.preventDefault(); void replaceFile(); }}>
            <label className="er-field__label" htmlFor="er-lib-replace">Replace source file</label><input id="er-lib-replace" type="file" onChange={(e) => setReplace(e.currentTarget.files?.[0] ?? null)} />
            <button className="er-button er-button--tonal" type="submit" disabled={!replace}>Upload new revision</button>
          </form>
          {activeState === "pending" ? <p className="er-lib__hint" role="status">Converting…</p> : null}
          {activeState === "needs_conversion" ? <p className="er-lib__hint" role="note">The original is saved. Upload a readable Markdown file to read this source.</p> : null}
          {activeState === "failed" ? <p className="er-lib__error" role="alert">{rev?.error ?? source.error ?? "Conversion failed."}</p> : null}
          <pre className="er-card er-lib__text" ref={preRef}>{textReady ? text : ""}</pre>
        </div>
      </div>
      {(activeState === "readable" || activeState === "readable_with_warnings") && activeRevision ? <SourceUnderstanding key={(sourceId ?? "") + activeRevision} projectId={projectId ?? ""} sourceId={sourceId ?? ""} revisionId={activeRevision} sourceTitle={source.title} /> : null}
    </section>
  );
}
