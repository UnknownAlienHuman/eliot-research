// K2 Save as Page → reader. Product functions only: (env, actor,
// input). No routes, model calls, or auth framework. Storage-only:
// R2 bodies first, then D1 identity/head. Same mutationId retries
// return the stored page.
import { LibraryError } from "./library";
import type { Actor } from "./auth";
import type { Citation } from "./citations";

export type PageKind = "overview" | "note" | "answer" | "report" | "wiki" | "map";

export interface SavedPage {
  id: string;
  title: string;
  kind: PageKind;
  headRevisionId: string;
  freshness: "current" | "stale";
  body: string;
  citations: Citation[];
}

export interface PageSummary {
  id: string;
  title: string;
  kind: PageKind;
  headRevisionId: string | null;
  freshness: "current" | "stale";
  updatedAt: number;
}

const PAGE_KINDS: readonly PageKind[] = ["overview", "note", "answer", "report", "wiki", "map"];
const MAX_BODY_CHARS = 1_000_000;

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
      env.DB.prepare("UPDATE page SET head_revision_id=?,updated_at=? WHERE id=? AND head_revision_id IS NULL").bind(revisionId, now, pageId),
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

export async function listPages(env: Env, _actor: Actor, input: { projectId: string; cursor?: string | undefined; kind?: PageKind | undefined }): Promise<{ pages: PageSummary[]; nextCursor: string | null }> {
  const project = await env.DB.prepare("SELECT id FROM project WHERE id=?").bind(input.projectId).first<{ id: string }>();
  if (!project) throw new LibraryError("not_found", "Project not found.", 404);
  if (input.kind !== undefined && !PAGE_KINDS.includes(input.kind)) throw new LibraryError("invalid", "Unknown page kind.", 400);
  const result = await env.DB.prepare("SELECT id,title,kind,head_revision_id AS headRevisionId,freshness,updated_at AS updatedAt FROM page WHERE project_id=? AND head_revision_id IS NOT NULL AND (? IS NULL OR kind=?) AND (? IS NULL OR (updated_at,id)<(SELECT updated_at,id FROM page WHERE id=?)) ORDER BY updated_at DESC,id DESC LIMIT 51").bind(input.projectId, input.kind ?? null, input.kind ?? null, input.cursor ?? null, input.cursor ?? null).all<PageSummary>();
  return { pages: result.results.slice(0, 50), nextCursor: result.results.length > 50 ? (result.results[49]?.id ?? null) : null };
}

export async function getPage(env: Env, _actor: Actor | null, input: { projectId: string; pageId: string }): Promise<SavedPage> {
  const page = await env.DB.prepare("SELECT project_id AS projectId,title,kind,head_revision_id AS headRevisionId,freshness FROM page WHERE id=?").bind(input.pageId).first<{ projectId: string; title: string; kind: PageKind; headRevisionId: string | null; freshness: "current" | "stale" }>();
  if (!page || page.projectId !== input.projectId) throw new LibraryError("not_found", "Page not found.", 404);
  if (!page.headRevisionId) throw new LibraryError("unavailable", "This page has no readable revision yet.", 503);
  const revision = await env.DB.prepare("SELECT body_key AS bodyKey,citations_key AS citationsKey FROM page_revision WHERE id=?").bind(page.headRevisionId).first<{ bodyKey: string; citationsKey: string | null }>();
  if (!revision) throw new LibraryError("not_found", "Page revision not found.", 404);
  const bodyObj = await env.BUCKET.get(revision.bodyKey);
  if (!bodyObj) throw new LibraryError("not_found", "Page body is missing from storage.", 404);
  let citations: Citation[] = [];
  if (revision.citationsKey) {
    const citationsObj = await env.BUCKET.get(revision.citationsKey);
    if (!citationsObj) throw new LibraryError("not_found", "Page citations are missing from storage.", 404);
    try { citations = toCitations(await citationsObj.json<unknown>()); }
    catch { throw new LibraryError("unavailable", "Page citations are missing from storage.", 503); }
  }
  return { id: input.pageId, title: page.title, kind: page.kind, headRevisionId: page.headRevisionId, freshness: page.freshness, body: await bodyObj.text(), citations };
}

