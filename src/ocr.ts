import { AuthError, type Actor } from "./auth";
import { LibraryError } from "./library";
import { scanBlocks } from "./blocks";
import { readableTextWarning } from "./ingest";
import { requireAvailableModel, modelTokenLimit, type ModelSpec } from "./models";
import { assertProviderAllowance } from "./model-quota";
import { OCR_LIMITS, ocrOutputLimit, type OcrJobView, type OcrState } from "./shared/api";

export interface OcrScope { projectId: string; sourceId: string; jobId: string }
export interface OcrPage { sha256: string; bytes: number; width: number; height: number }
export interface OcrRow {
  id: string; project_id: string; source_id: string; base_revision_id: string; base_current_revision_id: string | null;
  model_route: string; model_snapshot: string; page_count: number; pages_json: string; state: OcrState;
  calls: number; completed_pages: number; token_limit: number; input_tokens: number | null; cached_tokens: number | null;
  output_tokens: number | null; deadline_at: number | null; preview_sha256: string | null; preview_size: number | null;
  error: string | null; applied_revision_id: string | null; created_at: number; updated_at: number;
  started_at: number | null; finished_at: number | null;
}
interface Base {
  id: string; current_revision_id: string | null; original_key: string | null; original_sha256: string | null;
  original_size: number | null; original_mime: string | null; readable_state: string;
}
const invalid = (message: string) => new LibraryError("invalid", message, 400);
const conflict = (message: string) => new LibraryError("conflict", message, 409);
export const ocrKey = (job: Pick<OcrRow, "base_revision_id" | "id">, name: string) =>
  "source/" + job.base_revision_id + "/ocr/" + job.id + "/" + name;
export async function ocrHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((n) => n.toString(16).padStart(2, "0")).join("");
}
export async function putOcrArtifact(env: Env, key: string, body: string | Uint8Array<ArrayBuffer>, metadata: Record<string, string> = {}) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const customMetadata = { ...metadata, sha256: await ocrHash(bytes) };
  const saved = await env.BUCKET.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata,
    httpMetadata: { contentType: key.endsWith(".png") ? "image/png" : key.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/json" } });
  if (saved) return;
  const existing = await env.BUCKET.get(key);
  if (!existing || await ocrHash(new Uint8Array(await existing.arrayBuffer())) !== customMetadata.sha256
    || Object.entries(customMetadata).some(([name, value]) => existing.customMetadata?.[name] !== value))
    throw conflict("A different immutable OCR artifact already exists.");
}
async function sourceBase(env: Env, actor: Actor, scope: Pick<OcrScope, "projectId" | "sourceId">): Promise<Base> {
  if (actor.type !== "owner") throw new AuthError("invalid", "Only the owner may use PDF OCR.");
  const row = await env.DB.prepare("SELECT r.id,s.current_revision_id,r.original_key,r.original_sha256,r.original_size,r.original_mime,r.readable_state " +
    "FROM project_source ps JOIN project p ON p.id=ps.project_id JOIN source s ON s.id=ps.source_id " +
    "JOIN source_revision r ON r.id=(SELECT id FROM source_revision WHERE source_id=s.id AND deleted_at IS NULL ORDER BY revision_no DESC LIMIT 1) " +
    "WHERE ps.project_id=? AND ps.source_id=? AND s.state!='deleted' AND r.deleted_at IS NULL")
    .bind(scope.projectId, scope.sourceId).first<Base>();
  if (!row) throw new LibraryError("not_found", "This source is not available in this project.", 404);
  return row;
}
export async function loadOcrRow(env: Env, id: string): Promise<OcrRow> {
  const row = await env.DB.prepare("SELECT * FROM source_ocr_job WHERE id=?").bind(id).first<OcrRow>();
  if (!row) throw new LibraryError("not_found", "OCR job not found.", 404);
  return row;
}
async function scopedJob(env: Env, actor: Actor, scope: OcrScope) {
  await sourceBase(env, actor, scope);
  const job = await loadOcrRow(env, scope.jobId);
  if (job.project_id !== scope.projectId || job.source_id !== scope.sourceId)
    throw new LibraryError("not_found", "OCR job not found in this project source.", 404);
  return job;
}
function view(job: OcrRow): OcrJobView {
  const model = JSON.parse(job.model_snapshot) as ModelSpec;
  return { id: job.id, projectId: job.project_id, sourceId: job.source_id, baseRevisionId: job.base_revision_id,
    state: job.state, modelRoute: job.model_route, modelLabel: model.label, pageCount: job.page_count,
    uploadedPages: Object.keys(JSON.parse(job.pages_json) as Record<string, OcrPage>).map(Number).sort((a, b) => a - b),
    completedPages: job.completed_pages, calls: job.calls, tokenLimit: job.token_limit, inputTokens: job.input_tokens,
    cachedTokens: job.cached_tokens, outputTokens: job.output_tokens, deadlineAt: job.deadline_at, error: job.error,
    appliedRevisionId: job.applied_revision_id, createdAt: job.created_at, updatedAt: job.updated_at };
}
function imageModel(model: ModelSpec) {
  if ("supportsImages" in model && model.supportsImages === false) throw invalid("This model does not support image input.");
  const outputReserveTokens = ocrOutputLimit(model);
  if (outputReserveTokens === null || !Number.isSafeInteger(outputReserveTokens) || outputReserveTokens <= 0)
    throw new LibraryError("unavailable", "The model has no usable OCR output limit.", 503);
  return outputReserveTokens === model.outputReserveTokens ? model : { ...model, outputReserveTokens };
}
export async function createOcrJob(env: Env, actor: Actor, input: OcrScope & {
  baseRevisionId: string; model: string; pageCount: number; originalSha256: string;
}): Promise<OcrJobView> {
  const base = await sourceBase(env, actor, input);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.jobId)
    || !Number.isInteger(input.pageCount) || input.pageCount < 1 || input.pageCount > OCR_LIMITS.maxPages
    || !/^[0-9a-f]{64}$/i.test(input.originalSha256)) throw invalid("Use a job UUID, original SHA-256 and the full PDF page count.");
  const prior = await env.DB.prepare("SELECT j.*,r.original_sha256 AS originalSha FROM source_ocr_job j JOIN source_revision r ON r.id=j.base_revision_id WHERE j.id=?")
    .bind(input.jobId).first<OcrRow & { originalSha: string }>();
  if (prior) {
    if (prior.project_id !== input.projectId || prior.source_id !== input.sourceId || prior.base_revision_id !== input.baseRevisionId
      || prior.model_route !== input.model || prior.page_count !== input.pageCount || prior.originalSha !== input.originalSha256.toLowerCase())
      throw conflict("This job UUID already identifies a different OCR request.");
    return view(prior);
  }
  if (base.id !== input.baseRevisionId) throw conflict("The latest source revision changed. Reload before preparing OCR.");
  if (base.readable_state === "pending") throw conflict("Wait for the original PDF conversion to finish before preparing OCR.");
  if (base.original_mime !== "application/pdf" || !base.original_key || base.original_sha256 !== input.originalSha256.toLowerCase())
    throw invalid("OCR requires the unchanged original PDF and its exact SHA-256.");
  const original = await env.BUCKET.get(base.original_key);
  if (!original || original.size !== base.original_size) throw conflict("The stored original PDF is missing or changed.");
  const bytes = new Uint8Array(await original.arrayBuffer());
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-" || await ocrHash(bytes) !== base.original_sha256)
    throw conflict("The stored original PDF checksum does not match.");
  const model = imageModel(await requireAvailableModel(env, input.model)), now = Date.now();
  const bound = input.pageCount * modelTokenLimit(model);
  if (!Number.isSafeInteger(bound)) throw invalid("OCR token bound is too large.");
  await env.DB.prepare("INSERT INTO source_ocr_job(id,project_id,source_id,base_revision_id,base_current_revision_id,model_route,model_snapshot,page_count,token_limit,created_by,created_at,updated_at) " +
    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
    .bind(input.jobId, input.projectId, input.sourceId, base.id, base.current_revision_id, model.route, JSON.stringify(model),
      input.pageCount, bound, actor.type, now, now).run();
  const job = await scopedJob(env, actor, input);
  if (job.base_revision_id !== base.id || job.model_route !== input.model || job.page_count !== input.pageCount)
    throw conflict("This job UUID was concurrently used for another request.");
  return view(job);
}
export async function uploadOcrPage(env: Env, actor: Actor, input: OcrScope & { pageNumber: number; request: Request }): Promise<OcrJobView> {
  const job = await scopedJob(env, actor, input), chunks: Uint8Array[] = [];
  if (job.state !== "preparing") throw conflict("OCR page inputs are immutable after Start.");
  if (!Number.isInteger(input.pageNumber) || input.pageNumber < 1 || input.pageNumber > job.page_count) throw invalid("Page is outside this PDF.");
  if (!input.request.body) throw invalid("A PNG page is required.");
  const reader = input.request.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > OCR_LIMITS.pageBytes) throw new LibraryError("invalid", "A rendered PNG page must fit within 1 MiB.", 413);
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const header = new DataView(bytes.buffer);
  if (size < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)
    || header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452) throw invalid("A PNG page with an IHDR header is required.");
  const width = header.getUint32(16), height = header.getUint32(20);
  if (!width || !height || width * height > OCR_LIMITS.pagePixels) throw invalid("A rendered page must fit within 4 million pixels.");
  const page: OcrPage = { sha256: await ocrHash(bytes), bytes: size, width, height };
  await putOcrArtifact(env, ocrKey(job, "page-" + input.pageNumber + ".png"), bytes);
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await scopedJob(env, actor, input), pages = JSON.parse(current.pages_json) as Record<string, OcrPage>;
    const old = pages[input.pageNumber];
    if (old) {
      if (old.sha256 !== page.sha256) throw conflict("A different PNG is already stored for this page.");
      return view(current);
    }
    if (current.state !== "preparing") throw conflict("OCR inputs have already been frozen.");
    pages[input.pageNumber] = page;
    const saved = await env.DB.prepare("UPDATE source_ocr_job SET pages_json=?,updated_at=? WHERE id=? AND state='preparing' AND pages_json=?")
      .bind(JSON.stringify(pages), Date.now(), job.id, current.pages_json).run();
    if (saved.meta.changes) return view(await loadOcrRow(env, job.id));
  }
  throw conflict("Page uploads changed concurrently. Upload this same page again.");
}
export async function startOcrJob(env: Env, actor: Actor, scope: OcrScope): Promise<OcrJobView> {
  const job = await scopedJob(env, actor, scope);
  if (job.state !== "preparing") return view(job);
  const pages = JSON.parse(job.pages_json) as Record<string, OcrPage>;
  if (Object.keys(pages).length !== job.page_count || Array.from({ length: job.page_count }, (_, i) => i + 1).some((n) => !pages[n]))
    throw conflict("Upload every PDF page before Start.");
  const base = await sourceBase(env, actor, scope);
  if (base.id !== job.base_revision_id || base.current_revision_id !== job.base_current_revision_id || base.readable_state === "pending")
    throw conflict("The latest source revision or readable head changed before OCR Start.");
  const model = imageModel(await requireAvailableModel(env, job.model_route));
  await assertProviderAllowance(env, model);
  if (!env.OCR) throw new LibraryError("unavailable", "PDF OCR workflow is not configured.", 503);
  const now = Date.now(), bound = job.page_count * modelTokenLimit(model);
  await env.DB.prepare("UPDATE source_ocr_job SET state='failed',error='OCR deadline elapsed; no continuation was started.',finished_at=?,updated_at=? " +
    "WHERE state IN ('queued','running') AND deadline_at<=?").bind(now, now, now).run();
  const admitted = await env.DB.prepare("UPDATE source_ocr_job SET state='queued',model_snapshot=?,token_limit=?,deadline_at=?,started_at=?,updated_at=? WHERE id=? AND state='preparing' AND pages_json=? " +
    "AND (SELECT COUNT(*) FROM source_ocr_job WHERE state IN ('queued','running'))<2 " +
    "AND EXISTS(SELECT 1 FROM source s WHERE s.id=source_ocr_job.source_id AND s.state!='deleted' AND s.current_revision_id IS source_ocr_job.base_current_revision_id " +
    "AND EXISTS(SELECT 1 FROM project_source ps WHERE ps.project_id=source_ocr_job.project_id AND ps.source_id=s.id) " +
    "AND (SELECT id FROM source_revision WHERE source_id=s.id AND deleted_at IS NULL ORDER BY revision_no DESC LIMIT 1)=source_ocr_job.base_revision_id)")
    .bind(JSON.stringify(model), bound, now + job.page_count * OCR_LIMITS.pageTimeoutMs + 60_000, now, now, job.id, job.pages_json).run();
  if (!admitted.meta.changes) {
    const current = await loadOcrRow(env, job.id);
    if (current.state !== "preparing") return view(current);
    throw new LibraryError("busy", "Two OCR jobs are already active, or page uploads changed. Start explicitly after they finish.", 409);
  }
  try { await env.OCR.create({ id: "ocr-" + job.id, params: { jobId: job.id } }); }
  catch {
    await env.DB.prepare("UPDATE source_ocr_job SET state='failed',error='Workflow start could not be confirmed. This job will not be dispatched again.',finished_at=?,updated_at=? WHERE id=? AND state='queued' AND calls=0")
      .bind(Date.now(), Date.now(), job.id).run();
  }
  return view(await loadOcrRow(env, job.id));
}
export async function getOcrJob(env: Env, actor: Actor, scope: OcrScope): Promise<OcrJobView> { return view(await scopedJob(env, actor, scope)); }
export async function listOcrJobs(env: Env, actor: Actor, scope: Pick<OcrScope, "projectId" | "sourceId">): Promise<OcrJobView[]> {
  await sourceBase(env, actor, scope);
  const rows = await env.DB.prepare("SELECT * FROM source_ocr_job WHERE project_id=? AND source_id=? ORDER BY created_at DESC,id DESC LIMIT 10")
    .bind(scope.projectId, scope.sourceId).all<OcrRow>();
  return rows.results.map(view);
}
export async function readOcrPreview(env: Env, actor: Actor, scope: OcrScope): Promise<string> {
  const job = await scopedJob(env, actor, scope);
  if (!["ready", "applied"].includes(job.state) || !job.preview_sha256) throw conflict("A complete OCR preview is not available.");
  const object = await env.BUCKET.get(ocrKey(job, "preview.md"));
  if (!object) throw new LibraryError("unavailable", "OCR preview is missing from storage.", 503);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== job.preview_size || await ocrHash(bytes) !== job.preview_sha256) throw conflict("OCR preview integrity check failed.");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
export async function cancelOcrJob(env: Env, actor: Actor, scope: OcrScope): Promise<OcrJobView> {
  const job = await scopedJob(env, actor, scope), now = Date.now();
  await env.DB.prepare("UPDATE source_ocr_job SET state='cancelled',error='Stopped by owner. An in-flight page may still finish and record usage.',finished_at=?,updated_at=? " +
    "WHERE id=? AND state IN ('preparing','queued','running','ready')").bind(now, now, job.id).run();
  return view(await loadOcrRow(env, job.id));
}
export async function applyOcrJob(env: Env, actor: Actor, input: OcrScope & { text?: string | undefined }): Promise<{ revisionId: string }> {
  const job = await scopedJob(env, actor, input);
  if (job.state === "applied" && job.applied_revision_id) return { revisionId: job.applied_revision_id };
  if (job.state !== "ready") throw conflict("Only a complete reviewed OCR preview can be applied.");
  const text = input.text ?? await readOcrPreview(env, actor, input), bytes = new TextEncoder().encode(text);
  if (!text.trim() || bytes.length > OCR_LIMITS.previewBytes) throw new LibraryError("invalid", "Reviewed OCR text must be non-empty and at most 25 MiB.", 413);
  const id = crypto.randomUUID(), now = Date.now(), blocks = scanBlocks(text), warning = readableTextWarning(text);
  await putOcrArtifact(env, "source/" + id + "/text.md", bytes);
  await putOcrArtifact(env, "source/" + id + "/blocks.json", JSON.stringify(blocks));
  const tokens = job.input_tokens === null || job.output_tokens === null ? null : job.input_tokens + job.output_tokens;
  const guard = "j.state='ready' AND s.current_revision_id IS j.base_current_revision_id AND s.state!='deleted' AND r.deleted_at IS NULL " +
    "AND NOT EXISTS(SELECT 1 FROM source_revision newer WHERE newer.source_id=s.id AND newer.deleted_at IS NULL AND newer.revision_no>r.revision_no) " +
    "AND EXISTS(SELECT 1 FROM project_source ps WHERE ps.project_id=j.project_id AND ps.source_id=s.id)";
  const saved = await env.DB.batch([
    env.DB.prepare("INSERT INTO source_revision(id,source_id,revision_no,original_key,original_sha256,original_size,original_filename,original_mime,readable_state,converter,readable_size,block_count,warning_summary,conversion_tokens,conversion_calls,conversion_ms,created_by,created_at,distill_state) " +
      "SELECT ?,s.id,(SELECT MAX(revision_no)+1 FROM source_revision WHERE source_id=s.id),r.original_key,r.original_sha256,r.original_size,r.original_filename,r.original_mime,?,'reviewed_ocr',?,?,?,?,?,?,?,?,'none' " +
      "FROM source_ocr_job j JOIN source s ON s.id=j.source_id JOIN source_revision r ON r.id=j.base_revision_id WHERE j.id=? AND " + guard)
      .bind(id, warning ? "readable_with_warnings" : "readable", bytes.length, blocks.length, warning, tokens, job.calls,
        job.started_at !== null && job.finished_at !== null ? job.finished_at - job.started_at : null, actor.type, now, job.id),
    env.DB.prepare("UPDATE source SET current_revision_id=?,updated_at=? WHERE id=? AND current_revision_id IS ? AND EXISTS(SELECT 1 FROM source_revision WHERE id=?)")
      .bind(id, now, job.source_id, job.base_current_revision_id, id),
    env.DB.prepare("UPDATE source_ocr_job SET state='applied',applied_revision_id=?,updated_at=? WHERE id=? AND state='ready' AND EXISTS(SELECT 1 FROM source WHERE id=? AND current_revision_id=?)")
      .bind(id, now, job.id, job.source_id, id),
    env.DB.prepare("UPDATE page SET freshness='stale',updated_at=? WHERE head_revision_id IN " +
      "(SELECT pr.id FROM page_revision pr JOIN json_each(pr.inputs_json) i WHERE pr.status='accepted' AND i.type='text' AND i.value=?) " +
      "AND EXISTS(SELECT 1 FROM source_ocr_job WHERE id=? AND applied_revision_id=?)")
      .bind(now, job.base_current_revision_id ?? job.base_revision_id, job.id, id),
  ]);
  if (saved[0]?.meta.changes) return { revisionId: id };
  const current = await loadOcrRow(env, job.id);
  if (current.state === "applied" && current.applied_revision_id) return { revisionId: current.applied_revision_id };
  throw conflict("The source changed after this OCR preview was prepared. No current revision was replaced.");
}
