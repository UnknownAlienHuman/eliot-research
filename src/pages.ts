// K2 Save as Page → reader. Product functions only: (env, actor,
// input). No routes, model calls, or auth framework. Storage-only:
// R2 bodies first, then D1 identity/head. Same mutationId retries
// return the stored page.
import { LibraryError } from "./library";
import type { Actor } from "./auth";
import type { Citation } from "./citations";

export type PageKind = "overview" | "note" | "answer" | "report" | "wiki" | "map";

export interface SavedPage extends PageSummary {
  headRevisionId: string;
  body: string;
  citations: Citation[];
}

export interface PageSummary {
  id: string;
  title: string;
  kind: PageKind;
  headRevisionId: string | null;
  freshness: "current" | "stale";
  headRevisionNo: number;
  createdAt: number;
  updatedAt: number;
}

export interface PageList { pages: PageSummary[]; nextCursor: string | null }

const PAGE_KINDS: readonly PageKind[] = ["overview", "note", "answer", "report", "wiki", "map"];
const MAX_BODY_CHARS = 1_000_000;

// One bound parameter: the newly accepted page revision. Evaluate inside the
// guarded head UPDATE, after its immutable inputs are inserted/accepted.
export const PAGE_FRESHNESS_SQL = `SELECT CASE
  WHEN json_valid(published.inputs_json)=0 THEN 'stale'
  WHEN json_type(published.inputs_json)!='array' THEN 'stale'
  WHEN EXISTS(SELECT 1 FROM json_each(published.inputs_json) input
    LEFT JOIN source_revision revision ON input.type='text' AND revision.id=input.value
    LEFT JOIN source source ON source.id=revision.source_id
    WHERE input.type!='text' OR revision.id IS NULL OR revision.deleted_at IS NOT NULL
      OR revision.readable_state NOT IN ('readable','readable_with_warnings')
      OR source.id IS NULL OR source.state='deleted' OR source.current_revision_id IS NOT revision.id)
    THEN 'stale' ELSE 'current' END
  FROM page_revision published WHERE published.id=?`;

function cleanTitle(title: unknown): string {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (!trimmed || trimmed.length > 200) throw new LibraryError("invalid", "Give the page a title of 1 to 200 characters.", 400);
  return trimmed;
}

function toCitation(value: unknown): Citation {
  const row = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const { revisionId, sourceId, block, start, end, sourceTitle, deleted, label } = row;
  if (typeof revisionId !== "string" || !revisionId || typeof sourceId !== "string" || !sourceId
    || typeof block !== "number" || !Number.isSafeInteger(block) || typeof start !== "number"
    || !Number.isSafeInteger(start) || typeof end !== "number" || !Number.isSafeInteger(end) || start < 0 || end <= start
    || typeof sourceTitle !== "string" || !sourceTitle || typeof deleted !== "boolean"
    || typeof label !== "string" || !label) {
    throw new LibraryError("invalid", "Stored citations are invalid.", 400);
  }
  return value as Citation;
}

function toCitations(value: unknown): Citation[] {
  if (!Array.isArray(value)) throw new LibraryError("invalid", "Stored citations are invalid.", 400);
  return value.map(toCitation);
}

function storedScope(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id)) throw new LibraryError("invalid", "Stored answer scope is invalid.", 400);
  return value as string[];
}

async function mutationHit(env: Env, projectId: string, mutationId: string): Promise<string | null> {
  const hit = await env.DB.prepare("SELECT r.page_id AS pageId FROM page_revision r"
    + " JOIN page p ON p.id=r.page_id WHERE r.mutation_id=? AND p.project_id=?")
    .bind(mutationId, projectId).first<{ pageId: string }>();
  return hit ? hit.pageId : null;
}

async function readStoredTurn(env: Env, projectId: string, chatId: string, turnId: string): Promise<Record<string, unknown>> {
  const [project, chat] = await Promise.all([
    env.DB.prepare("SELECT id FROM project WHERE id=?").bind(projectId).first<{ id: string }>(),
    env.DB.prepare("SELECT project_id AS projectId FROM chat WHERE id=?").bind(chatId).first<{ projectId: string }>(),
  ]);
  if (!project) throw new LibraryError("not_found", "Project not found.", 404);
  if (!chat) throw new LibraryError("not_found", "Chat not found.", 404);
  if (chat.projectId !== projectId) throw new LibraryError("invalid", "This chat does not belong to this project.", 400);
  const turn = await env.DB.prepare("SELECT state FROM chat_turn WHERE chat_id=? AND turn_id=?").bind(chatId, turnId).first<{ state: string }>();
  if (!turn) throw new LibraryError("not_found", "Turn not found.", 404);
  try {
    const stored: unknown = await env.CHAT.getByName(chatId).getStoredTurn(projectId, turnId);
    if (typeof stored !== "object" || stored === null) throw new LibraryError("unavailable", "Eliot could not read this answer. Try again.", 503);
    return stored as Record<string, unknown>;
  } catch (error) {
    if (error instanceof LibraryError) throw error;
    throw new LibraryError("unavailable", "Eliot could not read this answer. Try again.", 503);
  }
}

export async function saveAnswer(env: Env, actor: Actor, input: { projectId: string; chatId: string; turnId: string; title: string; mutationId: string }): Promise<SavedPage> {
  if (!input.projectId || !input.chatId || !input.turnId || !input.mutationId) throw new LibraryError("invalid", "Check the request fields and try again.", 400);
  const title = cleanTitle(input.title);
  const project = await env.DB.prepare("SELECT id FROM project WHERE id=?").bind(input.projectId).first<{ id: string }>();
  if (!project) throw new LibraryError("not_found", "Project not found.", 404);
  const raced = await mutationHit(env, input.projectId, input.mutationId);
  if (raced) return getPage(env, actor, { projectId: input.projectId, pageId: raced });
  const stored = await readStoredTurn(env, input.projectId, input.chatId, input.turnId);
  const { state, answer, citations, revisionIds } = stored;
  if (state !== "completed" && state !== "partial") throw new LibraryError("conflict", "This answer is not ready to save yet.", 409);
  if (typeof answer !== "string" || !answer.trim() || answer.length > MAX_BODY_CHARS) throw new LibraryError("invalid", "There is no saveable answer text.", 400);
  const cited = toCitations(citations);
  const scope = storedScope(revisionIds);
  const pageId = crypto.randomUUID(), revisionId = crypto.randomUUID(), now = Date.now();
  const bodyKey = `page/${revisionId}/body.md`, citationsKey = `page/${revisionId}/citations.json`;
  try {
    await Promise.all([
      env.BUCKET.put(bodyKey, new TextEncoder().encode(answer), { httpMetadata: { contentType: "text/markdown; charset=utf-8" } }),
      env.BUCKET.put(citationsKey, JSON.stringify(cited), { httpMetadata: { contentType: "application/json" } }),
    ]);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO page(id,project_id,kind,title,head_revision_id,freshness,created_at,updated_at) VALUES(?,?,'answer',?,NULL,'current',?,?)").bind(pageId, input.projectId, title, now, now),
      env.DB.prepare("INSERT INTO page_revision(id,page_id,revision_no,status,origin,actor,body_key,citations_key,inputs_json,mutation_id,created_at) VALUES(?,?,1,'accepted','chat',?,?,?,?,?,?)").bind(revisionId, pageId, actor.type, bodyKey, citationsKey, JSON.stringify(scope), input.mutationId, now),
      env.DB.prepare(`UPDATE page SET head_revision_id=?,freshness=(${PAGE_FRESHNESS_SQL}),updated_at=? WHERE id=? AND head_revision_id IS NULL`)
        .bind(revisionId, revisionId, now, pageId),
    ]);
    const head = await env.DB.prepare("SELECT head_revision_id AS headRevisionId FROM page WHERE id=?").bind(pageId).first<{ headRevisionId: string | null }>();
    if (head?.headRevisionId !== revisionId) throw new LibraryError("conflict", "The page changed while saving. Try again.", 409);
  } catch (error) {
    if (error instanceof LibraryError && error.code === "conflict") throw error;
    let committed: { pageId: string } | null | undefined;
    try {
      committed = await env.DB.prepare("SELECT page_id AS pageId FROM page_revision WHERE id=?").bind(revisionId).first<{ pageId: string }>();
    } catch {
      committed = undefined;
    }
    if (committed) return getPage(env, actor, { projectId: input.projectId, pageId: committed.pageId });
    if (committed === undefined) throw new LibraryError("unavailable", "Eliot could not save this answer. Try again.", 503);
    const winner = await mutationHit(env, input.projectId, input.mutationId);
    await env.DB.prepare("DELETE FROM page WHERE id=? AND head_revision_id IS NULL").bind(pageId).run().catch(() => undefined);
    await env.BUCKET.delete(bodyKey).catch(() => undefined);
    await env.BUCKET.delete(citationsKey).catch(() => undefined);
    if (winner) return getPage(env, actor, { projectId: input.projectId, pageId: winner });
    if (error instanceof LibraryError) throw error;
    throw new LibraryError("unavailable", "Eliot could not save this answer. Try again.", 503);
  }
  return getPage(env, actor, { projectId: input.projectId, pageId });
}

export async function listPages(env: Env, _actor: Actor, input: { projectId: string; cursor?: string | undefined; kind?: PageKind | undefined }): Promise<PageList> {
  const project = await env.DB.prepare("SELECT id FROM project WHERE id=?").bind(input.projectId).first<{ id: string }>();
  if (!project) throw new LibraryError("not_found", "Project not found.", 404);
  if (input.kind !== undefined && !PAGE_KINDS.includes(input.kind)) throw new LibraryError("invalid", "Unknown page kind.", 400);
  let before: { at: number; id: string } | undefined;
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== "string" || input.cursor.length > 512) throw new Error("cursor");
      const value: unknown = JSON.parse(input.cursor);
      if (!Array.isArray(value) || value.length !== 4 || value[0] !== input.projectId || value[1] !== (input.kind ?? null)
        || !Number.isSafeInteger(value[2]) || value[2] < 0 || typeof value[3] !== "string" || !value[3] || value[3].length > 128) throw new Error("cursor");
      before = { at: value[2] as number, id: value[3] };
    } catch { throw new LibraryError("invalid", "This page cursor is invalid. Refresh saved pages.", 400); }
  }
  const args: (string | number)[] = [input.projectId];
  if (input.kind) args.push(input.kind);
  if (before) args.push(before.at, before.id);
  const result = await env.DB.prepare(`SELECT p.id,p.title,p.kind,p.head_revision_id AS headRevisionId,r.revision_no AS headRevisionNo,
    p.freshness,p.created_at AS createdAt,p.updated_at AS updatedAt FROM page p JOIN page_revision r ON r.id=p.head_revision_id
    WHERE p.project_id=? AND p.head_revision_id IS NOT NULL ${input.kind ? "AND p.kind=?" : ""}
    ${before ? "AND (p.created_at,p.id)<(?,?)" : ""} ORDER BY p.created_at DESC,p.id DESC LIMIT 51`).bind(...args).all<PageSummary>();
  const pages = result.results.slice(0, 50), last = pages.at(-1);
  return { pages, nextCursor: result.results.length > 50 && last ? JSON.stringify([input.projectId, input.kind ?? null, last.createdAt, last.id]) : null };
}

export async function getPage(env: Env, _actor: Actor, input: { projectId: string; pageId: string }): Promise<SavedPage> {
  const page = await env.DB.prepare(`SELECT p.id,p.project_id AS projectId,p.title,p.kind,p.head_revision_id AS headRevisionId,p.freshness,
    p.created_at AS createdAt,p.updated_at AS updatedAt,r.revision_no AS headRevisionNo,r.body_key AS bodyKey,r.citations_key AS citationsKey
    FROM page p LEFT JOIN page_revision r ON r.id=p.head_revision_id WHERE p.id=?`).bind(input.pageId).first<PageSummary & { projectId: string; bodyKey: string | null; citationsKey: string | null }>();
  if (!page || page.projectId !== input.projectId) throw new LibraryError("not_found", "Page not found.", 404);
  if (!page.headRevisionId) throw new LibraryError("unavailable", "This page has no readable revision yet.", 503);
  if (!page.bodyKey || !page.headRevisionNo) throw new LibraryError("not_found", "Page revision not found.", 404);
  const bodyObj = await env.BUCKET.get(page.bodyKey);
  if (!bodyObj) throw new LibraryError("not_found", "Page body is missing from storage.", 404);
  let citations: Citation[] = [];
  if (page.citationsKey) {
    const citationsObj = await env.BUCKET.get(page.citationsKey);
    if (!citationsObj) throw new LibraryError("not_found", "Page citations are missing from storage.", 404);
    try { citations = toCitations(await citationsObj.json<unknown>()); }
    catch { throw new LibraryError("unavailable", "Page citations are missing from storage.", 503); }
  }
  return { id: input.pageId, title: page.title, kind: page.kind, headRevisionId: page.headRevisionId, headRevisionNo: page.headRevisionNo,
    freshness: page.freshness, createdAt: page.createdAt, updatedAt: page.updatedAt, body: await bodyObj.text(), citations };
}

