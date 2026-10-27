import type { Actor } from "./auth";
import type { Project, Revision, Source } from "./shared/api";

export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
type Duplicate = { sourceId: string; title: string; revisionId: string };
export class LibraryError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "conflict" | "unavailable" | "budget" | "busy", message: string,
    readonly status: 400 | 404 | 409 | 413 | 503, readonly duplicate?: Duplicate) { super(message); }
}

const PROJECT_FIELDS = "id,title,description,archived_at AS archivedAt,created_at AS createdAt,updated_at AS updatedAt,instructions,answer_model AS answerModel";
const SOURCE_FIELDS = `s.id,s.title,s.kind,s.current_revision_id AS currentRevisionId,r.id AS revisionId,
  r.readable_state AS readableState,r.original_filename AS originalFilename,r.original_size AS originalSize,
  r.readable_size AS readableSize,r.block_count AS blockCount,r.warning_summary AS warningSummary,r.error,
  r.converter,r.conversion_tokens AS conversionTokens,r.conversion_calls AS conversionCalls,
  r.conversion_ms AS conversionMs,s.created_at AS createdAt`;
const LATEST_REVISION = "JOIN source_revision r ON r.source_id=s.id AND r.revision_no=(SELECT MAX(revision_no) FROM source_revision WHERE source_id=s.id AND deleted_at IS NULL)";

export async function getProject(env: Env, _actor: Actor | null, id: string): Promise<Project> {
  const project = await env.DB.prepare(`SELECT ${PROJECT_FIELDS} FROM project WHERE id=?`).bind(id).first<Project>();
  if (!project) throw new LibraryError("not_found", "Project not found.", 404);
  return project;
}
export async function listProjects(env: Env, _actor: Actor, cursor: string | undefined) {
  const result = await env.DB.prepare(`SELECT ${PROJECT_FIELDS} FROM project WHERE archived_at IS NULL
    AND (? IS NULL OR (created_at,id)<(SELECT created_at,id FROM project WHERE id=?))
    ORDER BY created_at DESC,id DESC LIMIT 51`).bind(cursor ?? null, cursor ?? null).all<Project>();
  return { projects: result.results.slice(0, 50), nextCursor: result.results.length > 50 ? result.results[49]?.id : null };
}
export async function createProject(env: Env, actor: Actor, input: { title: string; description?: string }) {
  const id = crypto.randomUUID(), now = Date.now();
  await env.DB.prepare("INSERT INTO project(id,title,description,created_at,updated_at) VALUES(?,?,?,?,?)")
    .bind(id, input.title, input.description ?? "", now, now).run();
  return getProject(env, actor, id);
}
export async function updateProject(env: Env, actor: Actor, id: string, input: { title?: string; archived?: boolean }) {
  const project = await getProject(env, actor, id);
  await env.DB.prepare("UPDATE project SET title=?,archived_at=?,updated_at=? WHERE id=?")
    .bind(input.title ?? project.title, input.archived === undefined ? project.archivedAt : input.archived ? Date.now() : null, Date.now(), id).run();
  return getProject(env, actor, id);
}
export async function listSources(env: Env, actor: Actor, projectId: string, cursor: string | undefined) {
  await getProject(env, actor, projectId);
  const result = await env.DB.prepare(`SELECT ${SOURCE_FIELDS},ps.enabled FROM project_source ps JOIN source s ON s.id=ps.source_id
    ${LATEST_REVISION} WHERE ps.project_id=? AND s.state='active'
    AND (? IS NULL OR (s.created_at,s.id)<(SELECT created_at,id FROM source WHERE id=?))
    ORDER BY s.created_at DESC,s.id DESC LIMIT 51`).bind(projectId, cursor ?? null, cursor ?? null).all<Source>();
  return { sources: result.results.slice(0, 50).map((source) => ({ ...source, enabled: Boolean(source.enabled) })), nextCursor: result.results.length > 50 ? result.results[49]?.id : null };
}
export async function setProjectScope(env: Env, actor: Actor, input: { projectId: string; sourceIds: string[] }) {
  await getProject(env, actor, input.projectId);
  const members = await env.DB.prepare("SELECT source_id FROM project_source WHERE project_id=?").bind(input.projectId).all<{ source_id: string }>();
  const allowed = new Set(members.results.map((member) => member.source_id));
  if (input.sourceIds.some((id) => !allowed.has(id))) throw new LibraryError("invalid", "A selected source is outside this project.", 400);
  await env.DB.prepare("UPDATE project_source SET enabled=CASE WHEN source_id IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END WHERE project_id=?")
    .bind(JSON.stringify(input.sourceIds), input.projectId).run();
  return { sourceIds: input.sourceIds };
}
export async function getSource(env: Env, _actor: Actor, id: string, requestedRevisionId?: string) {
  const source = await env.DB.prepare(`SELECT ${SOURCE_FIELDS} FROM source s ${LATEST_REVISION} WHERE s.id=? AND s.state!='deleted'`)
    .bind(id).first<Source>();
  if (!source) throw new LibraryError("not_found", "Source not found.", 404);
  const fields = "id,readable_state AS readableState,created_at AS createdAt,converter,conversion_tokens AS conversionTokens,conversion_calls AS conversionCalls,conversion_ms AS conversionMs,warning_summary AS warningSummary,error";
  const revisions = await env.DB.prepare(`SELECT ${fields} FROM source_revision WHERE source_id=? AND deleted_at IS NULL ORDER BY revision_no DESC LIMIT 50`)
    .bind(id).all<Revision>();
  const selectedId = requestedRevisionId ?? source.currentRevisionId;
  if (selectedId && !revisions.results.some((revision) => revision.id === selectedId)) {
    const selected = await env.DB.prepare(`SELECT ${fields} FROM source_revision WHERE source_id=? AND id=? AND deleted_at IS NULL`)
      .bind(id, selectedId).first<Revision>();
    if (!selected) throw new LibraryError("not_found", "This revision does not belong to this source.", 404);
    revisions.results.push(selected);
  }
  return { source, revisions: revisions.results };
}
export async function attachSource(env: Env, actor: Actor, projectId: string, sourceId: string) {
  await getProject(env, actor, projectId);
  await getSource(env, actor, sourceId);
  const active = await env.DB.prepare("SELECT id FROM source WHERE id=? AND state='active'").bind(sourceId).first();
  if (!active) throw new LibraryError("conflict", "Archived sources cannot be attached to a project.", 409);
  await env.DB.prepare("INSERT INTO project_source(project_id,source_id,added_by,added_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING")
    .bind(projectId, sourceId, actor.type, Date.now()).run();
  return { sourceId };
}

export interface NewSource {
  title: string;
  kind: Source["kind"];
  bytes: ArrayBuffer;
  filename: string;
  mimeType: string;
  url?: string;
  sourceId?: string;
}
export async function addSource(env: Env, actor: Actor, projectId: string, input: NewSource) {
  await getProject(env, actor, projectId);
  if (!input.bytes.byteLength || input.bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new LibraryError("invalid", "Choose a non-empty source of at most 25 MiB.", 413);
  }
  const digest = await crypto.subtle.digest("SHA-256", input.bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const duplicate = await env.DB.prepare(`SELECT s.id AS sourceId,s.title,r.id AS revisionId FROM source_revision r
    JOIN source s ON s.id=r.source_id WHERE r.original_sha256=? AND r.deleted_at IS NULL AND s.state!='deleted' LIMIT 1`)
    .bind(hash).first<Duplicate>();
  if (duplicate && duplicate.sourceId !== input.sourceId) throw new LibraryError("conflict", "This exact source is already in the Library. Attach it to this project.", 409, duplicate);
  const sourceId = input.sourceId ?? crypto.randomUUID(), revisionId = crypto.randomUUID(), now = Date.now();
  let revisionNo = 1;
  if (input.sourceId) {
    const existing = await env.DB.prepare(`SELECT MAX(r.revision_no) AS revisionNo FROM project_source ps
      JOIN source_revision r ON r.source_id=ps.source_id WHERE ps.project_id=? AND ps.source_id=?`)
      .bind(projectId, sourceId).first<{ revisionNo: number | null }>();
    if (existing?.revisionNo == null) throw new LibraryError("not_found", "Attach this source before replacing it.", 404);
    revisionNo = existing.revisionNo + 1;
  }
  const originalKey = `source/${revisionId}/original`;
  await env.BUCKET.put(originalKey, input.bytes, { httpMetadata: { contentType: input.mimeType } });
  const statements: D1PreparedStatement[] = [];
  if (!input.sourceId) statements.push(env.DB.prepare(`INSERT INTO source(id,title,kind,origin_url,created_by,created_at,updated_at)
    SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM source_revision r JOIN source s ON s.id=r.source_id
    WHERE r.original_sha256=? AND r.deleted_at IS NULL AND s.state!='deleted')`)
    .bind(sourceId, input.title, input.kind, input.url ?? null, actor.type, now, now, hash));
  statements.push(env.DB.prepare(`INSERT INTO source_revision(id,source_id,revision_no,original_key,original_sha256,original_size,
    original_filename,original_mime,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .bind(revisionId, sourceId, revisionNo, originalKey, hash, input.bytes.byteLength, input.filename, input.mimeType, actor.type, now));
  if (!input.sourceId) statements.push(env.DB.prepare("INSERT INTO project_source(project_id,source_id,added_by,added_at) VALUES(?,?,?,?)")
    .bind(projectId, sourceId, actor.type, now));
  try { await env.DB.batch(statements); }
  catch (error) {
    const inserted = await env.DB.prepare("SELECT id FROM source_revision WHERE id=?").bind(revisionId).first();
    if (!inserted) {
      // This request owns the immutable key and no D1 revision points to it.
      await env.BUCKET.delete(originalKey).catch(() => undefined);
      const raced = await env.DB.prepare(`SELECT s.id AS sourceId,s.title,r.id AS revisionId FROM source_revision r
        JOIN source s ON s.id=r.source_id WHERE r.original_sha256=? AND r.deleted_at IS NULL LIMIT 1`).bind(hash).first<Duplicate>();
      if (raced && raced.sourceId !== input.sourceId) throw new LibraryError("conflict", "This exact source was just added to the Library. Attach it.", 409, raced);
      if (input.sourceId) throw new LibraryError("conflict", "The source changed while replacing it. Reload and try again.", 409);
      throw error;
    }
  }
  try { await env.INGEST.create({ id: `ingest-${revisionId}`, params: { revisionId } }); }
  catch {
    try {
      const instance = await env.INGEST.get(`ingest-${revisionId}`);
      await instance.status();
      return { sourceId, revisionId, state: "pending" as const };
    } catch { /* The original and failed revision remain available to the owner. */ }
    await env.DB.prepare("UPDATE source_revision SET readable_state='failed',error=? WHERE id=?")
      .bind("Conversion could not start. The original is saved; replace it to retry deliberately.", revisionId).run();
    throw new LibraryError("unavailable", "The original is saved, but conversion could not start. Open the source for details.", 503);
  }
  return { sourceId, revisionId, state: "pending" as const };
}
