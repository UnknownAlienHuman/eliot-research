// K1 Read route views. Presentation adapted from pinned legacy donor
// 7c034569b908d3b03a8b821b7c537477a24b10f7/sources/{projects,import,document}.
// No donor runtime/query/byte helpers. Root wires Routes/App/Shell + this CSS
// and owns routes/schema/shared/api. Ranges: UTF-8 bytes, end-exclusive.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { apiErrorMessage, apiJson } from "./api";
import { Link, NavLink, useLocation, useParams, useSearchParams } from "react-router";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, Revision, Source, SourceSelection } from "../shared/api";
import { readableTextWarning } from "../ingest";
import { MaterialSymbol } from "./ui/MaterialSymbol";
import { SourceUnderstanding } from "./Understanding";
import type { SuggestedQuestion } from "./Understanding";
import { SourceOcr } from "./Ocr";
import { LibraryPicker } from "./LibraryPicker";
import { findReaderRange, splitReaderRange } from "./reader-range";
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
  const [archived, setArchived] = useState(false);
  const client = useQueryClient();
  const queryKey = ["projects", archived];
  const listing = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiJson<{ projects: Project[]; nextCursor: string | null }>(
      "/api/projects?archived=" + archived + (pageParam ? "&cursor=" + encodeURIComponent(pageParam) : ""), { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    gcTime: 0,
  });
  const projects = listing.data?.pages.flatMap(page => page.projects);
  const [failure, setFailure] = useState("");
  const [title, setTitle] = useState({ value: "" });
  const createAttempt = useRef<{ id: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; title: string } | undefined>(undefined);
  const loadMore = () => { if (!listing.isFetching) void listing.fetchNextPage({ cancelRefetch: false }); };
  async function create() {
    const submittedDraft = title, next = title.value.trim();
    if (!next || busy || editing !== undefined) return;
    const attempt = createAttempt.current?.title === next ? createAttempt.current : { id: crypto.randomUUID(), title: next };
    createAttempt.current = attempt;
    setBusy(true); setFailure("");
    try {
      const result = await apiJson<{ project?: Project } | null>("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(attempt) });
      if (result?.project?.id !== attempt.id) throw new Error("Could not confirm that this project was created. Create again to check the same project.");
      if (createAttempt.current === attempt) createAttempt.current = null;
      setTitle(current => current === submittedDraft ? { value: "" } : current); await client.resetQueries({ queryKey, exact: true });
    } catch (err) { setFailure(err instanceof Error ? err.message : "Could not create the project."); }
    finally { setBusy(false); }
  }
  async function patch(id: string, body: { title?: string; archived?: boolean }) {
    if (busy) return;
    const submittedEdit = editing;
    setBusy(true); setFailure("");
    try {
      await apiJson("/api/projects/" + encodeURIComponent(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setEditing(current => current === submittedEdit ? undefined : current); await client.resetQueries({ queryKey, exact: true });
    } catch (err) { setFailure(err instanceof Error ? err.message : "Could not update the project."); }
    finally { setBusy(false); }
  }
  const editVisible = projects?.some(project => project.id === editing?.id) ?? false;
  const renameControls = editing ? <>
    <input aria-label="Project title" value={editing.title} maxLength={200} autoFocus onChange={event => setEditing({ id: editing.id, title: event.currentTarget.value })} />
    <button className="er-button er-button--tonal" type="button" disabled={busy || !editing.title.trim()} onClick={() => void patch(editing.id, { title: editing.title.trim() })}>Save</button>
    <button className="er-button er-button--text" type="button" disabled={busy} onClick={() => setEditing(undefined)}>Cancel</button>
  </> : null;
  return (
    <section className="er-lib" aria-labelledby="er-lib-projects">
      <header className="er-lib__head"><h1 className="er-lib__title" id="er-lib-projects">Projects</h1><p className="er-lib__hint">{archived ? "Unarchive a project to return it to the active list." : "Create a project, then open its sources."}</p></header>
      <label className="er-field"><span>Show archived projects</span><input type="checkbox" checked={archived}
        disabled={busy || editing !== undefined} onChange={event => { setArchived(event.currentTarget.checked); setFailure(""); }} /></label>
      {failure ? <p className="er-lib__error" role="alert">{failure}</p> : null}
      {listing.error ? <p className="er-lib__error" role="alert">{listing.error.message}{" "}
        <button className="er-button er-button--text" type="button" disabled={listing.isFetching}
          onClick={() => listing.isFetchNextPageError ? loadMore() : void listing.refetch()}>Retry projects</button></p> : null}
      {!archived ? <form className="er-field er-lib__form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label className="er-field__label" htmlFor="er-lib-new-title">New project</label><input id="er-lib-new-title" value={title.value} onChange={(e) => setTitle({ value: e.currentTarget.value })} placeholder="Paper trail" maxLength={200} />
        <button className="er-button er-button--primary" type="submit" disabled={busy || editing !== undefined || !title.value.trim()}>Create</button>
      </form> : null}
      {editing && !editVisible ? <div className="er-card er-field" role="group" aria-label="Rename project">
        <p role="status">This project is not shown here. Finish or cancel its rename.</p>
        <div className="er-lib__actions">{renameControls}</div>
      </div> : null}
      {projects === undefined ? listing.error ? null : <p role="status">Opening your projects.</p>
        : projects.length === 0 ? <p className="er-card er-lib__empty">{archived ? "No archived projects." : "No projects yet. Create the first one above."}</p> : (
        <ul className="er-lib__list">{projects.map((p) => (
          <li className="er-lib__row" key={p.id}>
            <span className="er-lib__row-main"><MaterialSymbol name="home" /><span><Link className="er-lib__row-title" to={"/p/" + encodeURIComponent(p.id) + "/sources"}>{p.title}</Link>{p.archivedAt !== null ? <span className="er-chip er-lib__badge">Archived</span> : null}{p.description ? <span className="er-lib__row-meta">{p.description}</span> : null}</span></span>
            <span className="er-lib__actions">{editing?.id === p.id ? renameControls : (<>
              <button className="er-button er-button--text" type="button" disabled={busy || editing !== undefined} onClick={() => setEditing({ id: p.id, title: p.title })}>Rename</button>
              <button className="er-button er-button--text" type="button" disabled={busy || editing !== undefined} onClick={() => void patch(p.id, { archived: p.archivedAt === null })}>{p.archivedAt === null ? "Archive" : "Unarchive"}</button></>)}
            </span>
          </li>))}
        </ul>)}
      {listing.hasNextPage ? <button className="er-button er-button--tonal" type="button" disabled={listing.isFetching || busy} onClick={loadMore}>
        {listing.isFetchingNextPage ? "Loading projects." : "Load more"}</button> : null}
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
  const client = useQueryClient();
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
  const [actionFailure, setFailure] = useState("");
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [textDraft, setTextDraft] = useState({ title: "", body: "" });
  const [urlDraft, setUrlDraft] = useState({ url: "", title: "" });
  const [textPending, setTextPending] = useState(false);
  const [urlPending, setUrlPending] = useState(false);
  const textSubmitting = useRef(false);
  const urlSubmitting = useRef(false);
  const sourceQuery = useInfiniteQuery({
    queryKey: ["sources", projectId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiJson<{ sources: Source[]; nextCursor: string | null }>(
      "/api/projects/" + encodeURIComponent(projectId) + "/sources" + (pageParam ? "?cursor=" + encodeURIComponent(pageParam) : ""), { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: projectId !== "",
    networkMode: "always",
    refetchInterval: query => query.state.data?.pages.some(page => page.sources.some(source =>
      source.readableState === "pending" || source.distillState === "queued" || source.distillState === "running")) ? POLL_MS : false,
  });
  const sources = useMemo(() => sourceQuery.data?.pages.flatMap(page => page.sources), [sourceQuery.data]);
  const cursor = sourceQuery.data?.pages.at(-1)?.nextCursor ?? null;
  const failure = actionFailure || sourceQuery.error?.message || "";
  async function load() {
    await client.cancelQueries({ queryKey: ["sources", projectId], exact: true });
    const result = await sourceQuery.refetch();
    setFailure(result.error?.message ?? "");
  }
  useEffect(() => { dialogRef.current?.close(); }, [projectId]);
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
    if (!cursor || sourceQuery.isFetching) return;
    const result = await sourceQuery.fetchNextPage({ cancelRefetch: false });
    setFailure(result.error?.message ?? "");
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
  async function attach(sourceId: string): Promise<boolean> {
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
      return true;
    } catch (err) { setFailure(err instanceof Error ? err.message : "Could not attach the existing source."); return false; }
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
    const submittedDraft = textDraft;
    if (textSubmitting.current || !submittedDraft.title.trim() || !submittedDraft.body.trim()) return;
    textSubmitting.current = true; setTextPending(true);
    try {
      const label = submittedDraft.title.trim();
      if (!await submitDuplicate("/sources/text", label, { title: label, text: submittedDraft.body })) return;
      setTextDraft(current => current === submittedDraft ? { title: "", body: "" } : current);
      await load();
    } finally { textSubmitting.current = false; setTextPending(false); }
  }
  async function submitUrl() {
    const submittedDraft = urlDraft;
    if (urlSubmitting.current || !submittedDraft.url.trim()) return;
    urlSubmitting.current = true; setUrlPending(true);
    try {
      const label = submittedDraft.title.trim() || submittedDraft.url.trim();
      if (!await submitDuplicate("/sources/url", label, { url: submittedDraft.url.trim(), title: submittedDraft.title.trim() || undefined })) return;
      setUrlDraft(current => current === submittedDraft ? { url: "", title: "" } : current);
      await load();
    } finally { urlSubmitting.current = false; setUrlPending(false); }
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
        {sources !== undefined && failure ? <p className="er-lib__error" role="alert">{failure}{sourceQuery.error ? <button className="er-button er-button--text" type="button" onClick={() => sourceQuery.isFetchNextPageError ? void loadMore() : void load()}>Retry</button> : null}</p> : null}
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
                    <NavLink className="er-sources-pane__row-title" title={source.title} to={"/p/" + encodeURIComponent(projectId) + "/source/" + encodeURIComponent(source.id) + "?revisionId=" + encodeURIComponent(readerRevisionId)}>{source.title}</NavLink>
                    <div className="er-sources-pane__row-meta">
                      <span className="er-chip er-lib__badge" data-tone={status.tone}>{status.label}</span>
                      <a className="er-button er-button--text er-sources-pane__original" href={"/api/revisions/" + encodeURIComponent(source.revisionId) + "/original"} download aria-label={"Download original: " + source.title}>Original</a>
                    </div>
                    {status.latest ? <span className="er-sources-pane__latest">{status.latest}</span> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {cursor ? <button className="er-button er-button--tonal" type="button" onClick={() => void loadMore()}>Load more sources</button> : null}
      </div>
      <dialog ref={dialogRef} id={dialogId} className="er-dialog er-sources-pane__dialog" aria-labelledby={dialogHeadingId} onClose={() => setLibraryOpen(false)}>
        <div className="er-sources-pane__dialog-head">
          <h2 className="er-dialog__title" id={dialogHeadingId} ref={dialogHeadingRef} tabIndex={-1}>Add sources</h2>
          <button className="er-button er-button--text" type="button" onClick={() => dialogRef.current?.close()}>Close</button>
        </div>
        <div className="er-dialog__body">
          {failure ? <p className="er-lib__error" role="alert">{failure}</p> : null}
          {libraryOpen ? <LibraryPicker projectId={projectId} onAttach={attach} onClose={() => dialogRef.current?.close()} />
            : <button className="er-button er-button--tonal" type="button" onClick={() => setLibraryOpen(true)}>Browse Library</button>}
          <div className="er-card er-field er-lib__drop">
            <label htmlFor={fileInputId}>Choose files</label>
            <input id={fileInputId} type="file" multiple disabled={uploading} onChange={(event) => { void uploadMany(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
          </div>
          <form className="er-field er-lib__form" onSubmit={(event) => { event.preventDefault(); void submitText(); }}>
            <label className="er-field__label" htmlFor={textTitleId}>Pasted text title</label>
            <input id={textTitleId} value={textDraft.title} maxLength={200} onChange={(event) => { const title = event.currentTarget.value; setTextDraft(current => ({ ...current, title })); }} placeholder="Meeting notes" />
            <label className="er-field__label" htmlFor={textBodyId}>Text</label>
            <textarea id={textBodyId} value={textDraft.body} onChange={(event) => { const body = event.currentTarget.value; setTextDraft(current => ({ ...current, body })); }} placeholder="Paste source text here" />
            <button className="er-button er-button--tonal" type="submit" disabled={textPending || !textDraft.title.trim() || !textDraft.body.trim()}>Add text</button>
          </form>
          <form className="er-field er-lib__form" onSubmit={(event) => { event.preventDefault(); void submitUrl(); }}>
            <label className="er-field__label" htmlFor={urlId}>Page URL (https only)</label>
            <input id={urlId} inputMode="url" value={urlDraft.url} onChange={(event) => { const url = event.currentTarget.value; setUrlDraft(current => ({ ...current, url })); }} placeholder="https://example.com/report" />
            <label className="er-field__label" htmlFor={urlTitleId}>Title (optional)</label>
            <input id={urlTitleId} value={urlDraft.title} maxLength={200} onChange={(event) => { const title = event.currentTarget.value; setUrlDraft(current => ({ ...current, title })); }} />
            <button className="er-button er-button--tonal" type="submit" disabled={urlPending || !urlDraft.url.trim()}>Add URL</button>
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
export interface SourceReplacementProps {
  replacingSources: ReadonlySet<string>;
  beginReplacement: (projectId: string, sourceId: string) => boolean;
  endReplacement: (projectId: string, sourceId: string) => void;
}
interface ReaderProps extends SourceReplacementProps { onUseQuestion: (suggestion: SuggestedQuestion) => void }
export function Reader(props: ReaderProps) {
  const { projectId, sourceId } = useParams();
  return <SourceReader key={(projectId ?? "") + ":" + (sourceId ?? "")} {...props} />;
}

function SourceReader({ replacingSources, beginReplacement, endReplacement, onUseQuestion }: ReaderProps) {
  const { projectId, sourceId } = useParams();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const revisionId = params.get("revisionId") ?? "";
  const sp = params.get("start"), ep = params.get("end");
  const rangeStart = sp?.trim() ? Number(sp) : NaN;
  const rangeEnd = ep?.trim() ? Number(ep) : NaN;
  const [source, setSource] = useState<Source | undefined>(undefined);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [metaFailure, setMetaFailure] = useState("");
  const [text, setText] = useState("");
  const [loadedRev, setLoadedRev] = useState("");
  const [readError, setReadError] = useState<{ revisionId: string; message: string } | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [readLoading, setReadLoading] = useState(false);
  const readPending = useRef(false);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [failure, setFailure] = useState("");
  const [copied, setCopied] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMessage, setFindMessage] = useState("");
  const findId = useId(), findFocus = useRef(false);
  const [replace, setReplace] = useState<File | null>(null);
  const replaceInput = useRef<HTMLInputElement | null>(null);
  const replaceAttempt = useRef<{ file: File; revisionId: string } | null>(null);
  const replacing = replacingSources.has((projectId ?? "") + ":" + (sourceId ?? ""));
  const mounted = useRef(false);
  const metaSequence = useRef(0), metaAbort = useRef<AbortController | null>(null);
  const metaOwner = useRef({ projectId, sourceId, revisionId });
  if (metaOwner.current.projectId !== projectId || metaOwner.current.sourceId !== sourceId || metaOwner.current.revisionId !== revisionId)
    metaOwner.current = { projectId, sourceId, revisionId };
  const actionView = useRef({ key: location.key, path: location.pathname, search: location.search });
  if (actionView.current.key !== location.key || actionView.current.path !== location.pathname || actionView.current.search !== location.search)
    actionView.current = { key: location.key, path: location.pathname, search: location.search };
  const view = actionView.current;
  const preRef = useRef<HTMLPreElement | null>(null);
  const passageRef = useRef<HTMLElement | null>(null);
  const rev = revisions.find((r) => r.id === (revisionId || source?.currentRevisionId || source?.revisionId || revisions[0]?.id || ""));
  const activeRevision = rev?.id ?? "";
  const currentId = source?.currentRevisionId ?? source?.revisionId ?? revisions[0]?.id ?? "";
  const activeState = revisionId ? (rev?.readableState ?? "") : (rev?.readableState ?? source?.readableState ?? "");
  const conversionError = rev ? rev.error : source?.error;
  const textReady = loadedRev !== "" && loadedRev === activeRevision;
  const readFailure = readError?.revisionId === activeRevision ? readError.message : "";
  const readableWarning = useMemo(() => rev?.warningSummary ?? (textReady ? readableTextWarning(text) : null), [rev?.warningSummary, textReady, text]);
  const hasRange = sp !== null || ep !== null;
  const openingPassage = !textReady && !!activeRevision && ["pending", "readable", "readable_with_warnings"].includes(activeState) && !failure && !readFailure && !metaFailure;
  useEffect(() => { setFindQuery(""); setFindMessage(""); }, [activeRevision]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; metaSequence.current++; metaAbort.current?.abort(); };
  }, []);
  async function refreshMeta() {
    const owner = metaOwner.current, sequence = ++metaSequence.current, abort = new AbortController();
    metaAbort.current?.abort(); metaAbort.current = abort;
    const q = revisionId ? "?revisionId=" + encodeURIComponent(revisionId) : "";
    const current = () => mounted.current && metaOwner.current === owner && metaSequence.current === sequence && !abort.signal.aborted;
    try {
      const d = await apiJson<{ source: Source; revisions: Revision[] }>("/api/sources/" + encodeURIComponent(sourceId ?? "") + q, { signal: abort.signal });
      if (!current()) return;
      setSource(d.source); setRevisions(d.revisions); setMetaFailure("");
    } catch (err) { if (current()) setMetaFailure(err instanceof Error ? err.message : "Could not open the source."); }
  }
  useEffect(() => { setFailure(""); setMetaFailure(""); void refreshMeta(); return () => { metaSequence.current++; metaAbort.current?.abort(); }; }, [projectId, sourceId, revisionId]);
  useEffect(() => {
    if (!sourceId || activeState !== "pending" || metaFailure) return;
    let pending = false;
    const timer = window.setInterval(async () => { if (pending) return; pending = true; try { await refreshMeta(); } finally { pending = false; } }, POLL_MS);
    return () => { window.clearInterval(timer); metaAbort.current?.abort(); };
  }, [sourceId, revisionId, activeState, metaFailure]);
  useEffect(() => {
    if (!activeRevision || activeState === "pending" || activeState === "failed" || activeState === "needs_conversion" || activeState === "") return;
    const abort = new AbortController();
    readPending.current = true; setReadLoading(true);
    (async () => {
      try {
        const res = await fetch("/api/revisions/" + encodeURIComponent(activeRevision) + "/text", { credentials: "same-origin", signal: abort.signal });
        if (!res.ok) throw new Error(await apiErrorMessage(res));
        const raw = decodeCanonical(await res.arrayBuffer());
        if (abort.signal.aborted || !mounted.current) return;
        const od = await apiJson<{ blocks: unknown }>("/api/revisions/" + encodeURIComponent(activeRevision) + "/outline", { signal: abort.signal });
        if (abort.signal.aborted || !mounted.current) return;
        const items = toOutlineItems(od.blocks, raw);
        setText(raw); setOutline(items);
        setLoadedRev(activeRevision); setReadError(null);
      } catch (err) { if (!abort.signal.aborted && mounted.current)
        setReadError({ revisionId: activeRevision, message: err instanceof Error ? err.message : "Could not read the text." }); }
      finally { if (!abort.signal.aborted && mounted.current) { readPending.current = false; setReadLoading(false); } }
    })();
    return () => { abort.abort(); readPending.current = false; };
  }, [activeRevision, activeState, readAttempt]);
  function retryReadable() {
    if (readPending.current || !readFailure) return;
    readPending.current = true; setReadLoading(true); setReadAttempt(attempt => attempt + 1);
  }
  const passage = useMemo(() => {
    if (!textReady || !hasRange) return undefined;
    try { return splitReaderRange(text, rangeStart, rangeEnd); }
    catch { return undefined; }
  }, [textReady, hasRange, text, rangeStart, rangeEnd]);
  useEffect(() => {
    if (!passage) return;
    if (!findFocus.current) passageRef.current?.focus({ preventScroll: true });
    passageRef.current?.scrollIntoView({ block: findFocus.current ? "center" : "start", inline: "nearest" });
    findFocus.current = false;
  }, [passage, activeRevision, location.key]);
  function findPassage(backwards = false) {
    if (!textReady) return;
    const position = passage ? passage.before.length + (backwards ? 0 : passage.selected.length) : backwards ? text.length : 0;
    const match = findReaderRange(text, findQuery, position, backwards);
    setFindMessage(match ? "Match highlighted in the source." : "No matches in this revision.");
    if (!match) return;
    findFocus.current = true; setCopied(false);
    setParams({ revisionId: activeRevision, start: String(match.start), end: String(match.end) });
  }
  function copySelectionLink() {
    const pre = preRef.current;
    if (!pre || !activeRevision || !textReady) { setFailure("Open a readable revision before copying a passage link."); return; }
    const sel = selectionBytes(pre, text) ?? (passage ? { start: rangeStart, end: rangeEnd } : null);
    if (!sel) { setFailure("Select a passage in the text first, then copy its link."); return; }
    setFailure("");
    const next = new URLSearchParams(params);
    next.set("revisionId", activeRevision); next.set("start", String(sel.start)); next.set("end", String(sel.end));
    setParams(next);
    void navigator.clipboard?.writeText(window.location.origin + window.location.pathname + "?" + next.toString()).then(() => setCopied(true), () => setCopied(false));
  }
  async function replaceFile() {
    if (!replace || !projectId || !source || !beginReplacement(projectId, source.id)) return;
    const owner = actionView.current, targetSource = source.id, file = replace;
    const attempt = replaceAttempt.current?.file === file ? replaceAttempt.current : { file, revisionId: crypto.randomUUID() };
    replaceAttempt.current = attempt;
    const current = () => mounted.current && actionView.current === owner;
    setFailure("");
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("sourceId", targetSource);
      form.append("revisionId", attempt.revisionId);
      const res = await fetch("/api/projects/" + encodeURIComponent(projectId) + "/sources/file", { method: "POST", body: form, credentials: "same-origin" });
      if (!res.ok) throw new Error(await apiErrorMessage(res));
      const body = (await res.json()) as { sourceId?: string; revisionId?: string } | null;
      if (body?.sourceId !== targetSource || body.revisionId !== attempt.revisionId)
        throw new Error("Could not confirm that this replacement was received. Upload again to check the same revision.");
      await queryClient.cancelQueries({ queryKey: ["sources"] });
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
      if (!current()) return;
      if (replaceAttempt.current === attempt) replaceAttempt.current = null;
      setReplace(null);
      if (replaceInput.current) replaceInput.current.value = "";
      setParams({ revisionId: body.revisionId }); // The new revision effect owns its reads.
    } catch (err) { if (current()) setFailure(err instanceof Error ? err.message : "Replace failed before a response arrived."); }
    finally { endReplacement(projectId, targetSource); }
  }
  if (!source) return <LoadGate text="Opening the source…" failure={metaFailure || failure} onRetry={() => void refreshMeta()} />;
  return (
    <section className="er-lib" aria-labelledby="er-lib-reader">
      <header className="er-lib__head"><Link className="er-button er-button--text" to={"/p/" + encodeURIComponent(projectId ?? "") + "/sources"}>Sources</Link><h1 className="er-lib__title" id="er-lib-reader">{source.title}</h1><p className="er-lib__hint"><span className="er-chip er-lib__badge" data-tone={tone(activeState)}>{stateLabel(activeState)}</span></p></header>
      {failure ? <p className="er-lib__error" role="alert">{failure}</p> : null}
      {readFailure ? <p className="er-lib__error" role="alert">{readFailure}{" "}<button className="er-button er-button--text" type="button" disabled={readLoading} onClick={retryReadable}>Retry readable text</button></p> : null}
      {metaFailure ? <p className="er-lib__error" role="alert">{metaFailure}{" "}<button className="er-button er-button--text" type="button" onClick={() => void refreshMeta()}>Retry source status</button></p> : null}
      {revisionId && !rev ? <p className="er-lib__error" role="alert">This revision is not available for this source. Open its current revision from the Library.</p> : null}
      {readableWarning ? <p className="er-lib__row-meta">{readableWarning}</p> : null}
      {activeState !== "failed" && conversionError ? <p className="er-lib__hint" role="status">{conversionError}</p> : null}
      <details className="er-lib__facts"><summary>Details</summary><div className="er-lib__facts-content">
        <p>{sourceKindLabels[source.kind]}</p>
        {source.originalFilename ? <p>Original file: {source.originalFilename}</p> : null}
        {activeRevision ? <p><a href={"/api/revisions/" + encodeURIComponent(activeRevision) + "/original"}>Download original</a></p> : null}
        {rev ? <p>{revisionLabel(rev, currentId)}.</p> : null}
        {revisions.length > 1 ? <div className="er-field"><label className="er-field__label" htmlFor="er-lib-revision">Revision</label><select id="er-lib-revision" value={activeRevision} onChange={(e) => { const id = e.currentTarget.value; if (id) setParams({ revisionId: id }); }}>{revisions.map((r) => <option key={r.id} value={r.id}>{revisionLabel(r, currentId)}</option>)}</select></div> : null}
      </div></details>
      {hasRange ? (<div className="er-card er-field er-lib__excerpt" role="note">{openingPassage ? <p>Opening the selected passage.</p> : passage ? <p>The selected passage is highlighted in the full source text below.</p> : <p className="er-lib__error" role="alert">This passage could not be opened in the loaded text. Clear it and choose another passage.</p>}<Link className="er-button er-button--text" to={"?revisionId=" + encodeURIComponent(revisionId || activeRevision)} onClick={() => preRef.current?.focus({ preventScroll: true })}>Clear passage</Link></div>) : null}
      <div className="er-lib__reader">
        <details className="er-lib__outline"><summary>Outline</summary>
          {!textReady || outline.length === 0 ? <p className="er-lib__hint">No outline available.</p> : (<ul className="er-lib__outline-list">{outline.map((b, i) => (<li key={b.start + ":" + b.end + ":" + i}><Link to={"?revisionId=" + encodeURIComponent(activeRevision) + "&start=" + b.start + "&end=" + b.end}>{b.label}</Link></li>))}</ul>)}
        </details>
        <div>
          <div className="er-lib__actions"><button className="er-button er-button--tonal" type="button" onClick={copySelectionLink}>Copy link to selection</button>{activeRevision ? <a className="er-button er-button--text" href={"/api/revisions/" + encodeURIComponent(activeRevision) + "/original"}>Original</a> : null}{copied ? <span className="er-lib__hint" role="status">Link copied.</span> : null}</div>
          {projectId && sourceId && activeRevision && activeRevision === source.revisionId && rev?.originalMime === "application/pdf" && activeState !== "pending"
            ? <SourceOcr projectId={projectId} sourceId={sourceId} revisionId={activeRevision} onApplied={id => {
              if (!mounted.current || actionView.current !== view) return;
              void queryClient.invalidateQueries({ queryKey: ["sources", projectId], exact: true });
              if (id !== activeRevision) { setText(""); setOutline([]); setLoadedRev(""); }
              setParams({ revisionId: id });
            }} /> : null}
          <form className="er-field er-lib__form" onSubmit={(e) => { e.preventDefault(); void replaceFile(); }}>
            <label className="er-field__label" htmlFor="er-lib-replace">Replace source file</label><input ref={replaceInput} id="er-lib-replace" type="file" disabled={replacing} onChange={(e) => setReplace(e.currentTarget.files?.[0] ?? null)} />
            <button className="er-button er-button--tonal" type="submit" disabled={!replace || replacing}>{replacing ? "Uploading new revision…" : "Upload new revision"}</button>
          </form>
          {activeState === "pending" ? <p className="er-lib__hint" role="status">Converting…</p> : null}
          {activeState === "needs_conversion" ? <p className="er-lib__hint" role="note">The original is saved. Upload a readable Markdown file to read this source.</p> : null}
          {activeState === "failed" ? <p className="er-lib__error" role="alert">{rev?.error ?? source.error ?? "Conversion failed."}</p> : null}
          <form className="er-card er-field er-lib__find" role="search" aria-label="Find in source" onSubmit={e => { e.preventDefault(); findPassage(); }}>
            <label className="er-field__label" htmlFor={findId}>Find in source</label>
            <input id={findId} type="search" value={findQuery} disabled={!textReady} maxLength={256} placeholder="Word, phrase or number" onChange={e => { setFindQuery(e.currentTarget.value); setFindMessage(""); }} />
            <div className="er-lib__actions">
              <button className="er-button er-button--text" type="button" aria-label="Previous match" title="Previous match" disabled={!textReady || !findQuery.trim()} onClick={() => findPassage(true)}><span aria-hidden="true">↑</span></button>
              <button className="er-button er-button--tonal" type="submit" aria-label="Next match" title="Next match" disabled={!textReady || !findQuery.trim()}><span aria-hidden="true">↓</span></button>
            </div>
            <span className="er-lib__hint" role="status">{findMessage}</span>
          </form>
          <pre className="er-card er-lib__text" ref={preRef} tabIndex={-1}>{passage ? <>{passage.before}<mark ref={passageRef} tabIndex={-1}>{passage.selected}</mark>{passage.after}</> : textReady ? text : ""}</pre>
        </div>
      </div>
      {(activeState === "readable" || activeState === "readable_with_warnings") && activeRevision ? <SourceUnderstanding key={(sourceId ?? "") + activeRevision} projectId={projectId ?? ""} sourceId={sourceId ?? ""} revisionId={activeRevision} sourceTitle={source.title}
        onUseQuestion={activeRevision === source.currentRevisionId ? question => onUseQuestion({ sourceId: sourceId ?? "", sourceTitle: source.title, question }) : undefined} /> : null}
    </section>
  );
}
