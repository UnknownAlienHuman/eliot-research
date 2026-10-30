// Proposal pages use page_revision status and retain immutable source citations.
import { LibraryError } from "./library";
import { AuthError } from "./auth";
import type { Actor } from "./auth";
import type { ProposalSummary, ProposalView } from "./shared/api";
import { isCitableBlock } from "./blocks";
import type { Citation, LabelSource } from "./citations";
import { resolveCitations } from "./citations";
import { readOutline, readText } from "./read";

export const PROPOSAL_KINDS = ["note", "answer", "report", "wiki"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const MAX_PROPOSAL_REVISION_IDS = 50, MAX_PROPOSAL_TITLE_CHARS = 200;
const MAX_BODY_BYTES = 12_000;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const isOwner = (actor: Actor): boolean => actor.type === "owner";

function cleanTitle(title: unknown): string {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (!trimmed || trimmed.length > MAX_PROPOSAL_TITLE_CHARS)
    throw new LibraryError("invalid", "Give the proposal a title of 1 to 200 characters.", 400);
  return trimmed;
}

function cleanBody(body: unknown): string {
  if (typeof body !== "string" || !body.trim())
    throw new LibraryError("invalid", "Write the proposed page body first.", 400);
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES)
    throw new LibraryError("invalid", "The proposed body exceeds 12000 UTF-8 bytes.", 400);
  return body;
}

function cleanRevisionIds(value: unknown): string[] {
  if (!Array.isArray(value))
    throw new LibraryError("invalid", "List the cited source revisions first.", 400);
  if (value.some((entry: unknown) => typeof entry !== "string" || !UUID_RE.test(entry)))
    throw new LibraryError("invalid", "Each cited revision must be a revision ID.", 400);
  const out = [...new Set(value as string[])];
  if (out.length > MAX_PROPOSAL_REVISION_IDS) throw new LibraryError("invalid", "Select at most 50 revisions for this proposal.", 400);
  return out;
}

function cleanMutationId(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new LibraryError("invalid", "Retry with the same mutation ID.", 400);
  return value;
}

function cleanKind(value: unknown): ProposalKind {
  const kind = (value ?? "note") as ProposalKind;
  if (!PROPOSAL_KINDS.includes(kind)) throw new LibraryError("invalid", "Unknown proposal kind.", 400);
  return kind;
}

interface FrozenRevision {
  revisionId: string;
  sourceId: string;
  title: string;
}

async function frozenRevisions(env: Env, projectId: string, revisionIds: string[]): Promise<FrozenRevision[]> {
  const result = await env.DB.prepare(
    "SELECT s.id AS sourceId,s.title AS title,r.id AS revisionId FROM json_each(?) wanted " +
      "JOIN source_revision r ON r.id=wanted.value JOIN project_source ps ON ps.source_id=r.source_id " +
      "JOIN source s ON s.id=ps.source_id WHERE ps.project_id=? AND ps.enabled=1 AND s.state='active' " +
      "AND r.deleted_at IS NULL AND r.readable_state IN ('readable','readable_with_warnings') ORDER BY CAST(wanted.key AS INTEGER)",
  ).bind(JSON.stringify(revisionIds), projectId).all<FrozenRevision>();
  if (result.results.length !== revisionIds.length)
    throw new LibraryError("invalid", "Each cited revision must be a readable revision attached to this project.", 400);
  return result.results;
}

/** Bound label hydration: only body-referenced revisions/blocks are read, one canonical block range each. */
function referencedRevisionBlocks(body: string): Map<string, Set<number>> {
  const wanted = new Map<string, Set<number>>();
  for (const match of body.matchAll(/\[R([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):(\d+)\]/gu)) {
    const revisionId = match[1];
    const block = Number(match[2]);
    if (revisionId === undefined || !Number.isSafeInteger(block) || block < 1) continue;
    let set = wanted.get(revisionId);
    if (!set) {
      set = new Set<number>();
      wanted.set(revisionId, set);
    }
    set.add(block);
  }
  return wanted;
}
async function labelSources(env: Env, actor: Actor, frozen: FrozenRevision[], body: string): Promise<LabelSource[]> {
  const wanted = referencedRevisionBlocks(body);
  if (wanted.size === 0) return [];
  const byRevision = new Map(frozen.map((entry) => [entry.revisionId, entry]));
  const out: LabelSource[] = [];
  for (const [revisionId, blockIds] of wanted) {
    const entry = byRevision.get(revisionId);
    if (!entry) continue;
    const outline = await readOutline(env, actor, entry.revisionId);
    if (!outline.blocks.length) throw new LibraryError("unavailable", "Readable text is temporarily missing. Try again.", 503);
    const byId = new Map(outline.blocks.map((block) => [block.id, block]));
    const citable: typeof outline.blocks = [];
    for (const blockId of blockIds) {
      const block = byId.get(blockId);
      if (!block) continue;
      if (!Number.isSafeInteger(block.start) || !Number.isSafeInteger(block.end) ||
        block.start < 0 || block.end <= block.start) continue;
      let passage: string;
      try {
        passage = await (await readText(env, actor, entry.revisionId, { start: block.start, end: block.end })).text();
      } catch (error) { if (error instanceof LibraryError && error.code === "invalid") continue; throw error; }
      if (isCitableBlock(block, passage)) citable.push(block);
    }
    out.push({ sourceId: entry.sourceId, revisionId: entry.revisionId, title: entry.title, blocks: citable, alias: entry.revisionId });
  }
  return out;
}

interface ProposalRow extends ProposalSummary {
  bodyKey: string;
  citationsKey: string | null;
  inputsJson: string;
}

function parseInputsJson(inputsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(inputsJson);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("bad scope");
    return parsed as string[];
  } catch {
    throw new LibraryError("unavailable", "The proposal scope is unreadable.", 503);
  }
}

function parseCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) throw new LibraryError("unavailable", "Proposal citations are missing from storage.", 503);
  return raw as Citation[];
}

async function readProposal(env: Env, projectId: string, revisionId: string): Promise<ProposalView> {
  const row = await env.DB.prepare(
    "SELECT r.id AS revisionId, r.page_id AS pageId, p.title AS title, p.kind AS kind, r.status AS status, r.actor AS actor, r.created_at AS createdAt, r.base_revision_id AS baseRevisionId, p.head_revision_id AS headRevisionId, r.body_key AS bodyKey, r.citations_key AS citationsKey, r.inputs_json AS inputsJson FROM page_revision r JOIN page p ON p.id=r.page_id WHERE r.id=? AND p.project_id=?",
  )
    .bind(revisionId, projectId)
    .first<ProposalRow>();
  if (!row) throw new LibraryError("not_found", "Proposal not found.", 404);
  const { bodyKey, citationsKey, inputsJson, ...summary } = row;
  const revisionIds = parseInputsJson(inputsJson);
  const bodyObject = await env.BUCKET.get(bodyKey);
  if (!bodyObject) throw new LibraryError("not_found", "Proposal body is missing from storage.", 404);
  const body = await bodyObject.text();
  let citations: Citation[] = [];
  if (citationsKey) {
    const citationsObject = await env.BUCKET.get(citationsKey);
    if (!citationsObject) throw new LibraryError("not_found", "Proposal citations are missing from storage.", 404);
    try {
      citations = parseCitations(await citationsObject.json<unknown>());
    } catch {
      throw new LibraryError("unavailable", "Proposal citations are missing from storage.", 503);
    }
  }
  return { ...summary, body, citations, revisionIds };
}

async function mutationWinner(env: Env, projectId: string, mutationId: string): Promise<{
  pageId: string; revisionId: string
} | null> {
  const hit = await env.DB.prepare(
    "SELECT r.page_id AS pageId, r.id AS revisionId FROM page_revision r JOIN page p ON p.id=r.page_id WHERE r.mutation_id=? AND p.project_id=?",
  )
    .bind(mutationId, projectId)
    .first<{ pageId: string; revisionId: string }>();
  return hit ?? null;
}

function isMutationIdUniqueError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed:\s*page_revision\.mutation_id\b/i.test(error.message);
}

const proposalWriteUnavailable = () => new LibraryError("unavailable", "The proposal could not be saved. Try again.", 503);

export async function proposePage(
  env: Env,
  actor: Actor,
  input: {
    projectId: string;
    pageId?: string | undefined;
    kind?: ProposalKind | undefined;
    title: string;
    body: string;
    revisionIds: string[];
    mutationId: string;
  },
): Promise<ProposalView> {
  const title = cleanTitle(input.title);
  const body = cleanBody(input.body);
  const revisionIds = cleanRevisionIds(input.revisionIds);
  if (revisionIds.length === 0) throw new LibraryError("invalid", "A proposal must cite at least one readable source revision.", 400);
  const mutationId = cleanMutationId(input.mutationId);
  const project = await env.DB.prepare("SELECT id FROM project WHERE id=?")
    .bind(input.projectId)
    .first<{ id: string }>();
  if (!project) throw new LibraryError("not_found", "Project not found.", 404);
  const raced = await mutationWinner(env, input.projectId, mutationId);
  if (raced) return readProposal(env, input.projectId, raced.revisionId);
  const frozen = await frozenRevisions(env, input.projectId, revisionIds);
  const resolved = resolveCitations(body, await labelSources(env, actor, frozen, body));
  if (resolved.invalidLabels > 0)
    throw new LibraryError("invalid", "Some proposal references are unknown or outside this project. Use exact [Rrevision:block] labels.", 400);
  if (resolved.citations.length === 0)
    throw new LibraryError("invalid", "Cite at least one frozen passage with an exact [Rrevision:block] label.", 400);
  let pageId = input.pageId;
  const newPage = pageId === undefined;
  let base: string | null = null;
  let kind: ProposalKind = cleanKind(input.kind);
  if (pageId !== undefined) {
    const page = await env.DB.prepare("SELECT id, title, kind, head_revision_id AS headRevisionId FROM page WHERE id=? AND project_id=?")
      .bind(pageId, input.projectId)
      .first<{ id: string; title: string; kind: string; headRevisionId: string | null }>();
    if (!page) throw new LibraryError("not_found", "Page not found.", 404);
    if (page.title !== title) throw new LibraryError("invalid", "The proposal title is immutable. Reject it or propose a new revision.", 400);
    if (input.kind === undefined) kind = page.kind as ProposalKind;
    else if (page.kind !== kind)
      throw new LibraryError("invalid", "The proposal title and kind are immutable. Reject it or propose a new revision.", 400);
    base = page.headRevisionId;
  }
  const revisionId = crypto.randomUUID();
  const now = Date.now();
  const bodyKey = "page/" + revisionId + "/body.md";
  const citationsKey = "page/" + revisionId + "/citations.json";
  try {
    const bodyStored = await env.BUCKET.put(bodyKey, new TextEncoder().encode(body), {
      onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    if (!bodyStored) throw new Error("Proposal body key already exists.");
    const citationsStored = await env.BUCKET.put(citationsKey, JSON.stringify(resolved.citations), {
      onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" },
    });
    if (!citationsStored) throw new Error("Proposal citations key already exists.");
  } catch {
    throw proposalWriteUnavailable();
  }
  pageId ??= crypto.randomUUID();
  let revisionNo = 1;
  const origin = actor.type === "agent" ? "agent" : "owner";
  try {
    if (!newPage) revisionNo = (await env.DB.prepare("SELECT COALESCE(MAX(revision_no),0)+1 AS nextNo FROM page_revision WHERE page_id=?")
      .bind(pageId).first<{ nextNo: number }>())?.nextNo ?? 1;
    await env.DB.batch([
      ...(newPage ? [env.DB.prepare(
        "INSERT INTO page(id,project_id,kind,title,head_revision_id,freshness,created_at,updated_at) VALUES(?,?,?,?,NULL,'current',?,?)",
      ).bind(pageId, input.projectId, kind, title, now, now)] : []),
      env.DB.prepare(
        "INSERT INTO page_revision(id,page_id,revision_no,status,origin,actor,body_key,citations_key,inputs_json,mutation_id,base_revision_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(revisionId, pageId, revisionNo, "proposed", origin, actor.id, bodyKey, citationsKey, JSON.stringify(revisionIds), mutationId, base, now),
    ]);
  } catch (error) {
    if (isMutationIdUniqueError(error)) {
      let winner: { pageId: string; revisionId: string } | null;
      try { winner = await mutationWinner(env, input.projectId, mutationId); }
      catch { throw proposalWriteUnavailable(); }
      if (winner) {
        try {
          return await readProposal(env, input.projectId, winner.revisionId);
        } catch (readError) {
          if (readError instanceof LibraryError) throw readError;
          throw proposalWriteUnavailable();
        }
      }
      throw new LibraryError("conflict", "This proposal was already recorded. Retry with the same mutation ID.", 409);
    }
    throw proposalWriteUnavailable();
  }
  return readProposal(env, input.projectId, revisionId);
}

export async function listProposals(
  env: Env,
  actor: Actor,
  input: { projectId: string; cursor?: string | undefined },
): Promise<{ proposals: ProposalSummary[]; nextCursor: string | null }> {
  if (!isOwner(actor)) throw new AuthError("invalid", "Only the owner may review proposals.");
  const project = await env.DB.prepare("SELECT id FROM project WHERE id=?")
    .bind(input.projectId)
    .first<{ id: string }>();
  if (!project) throw new LibraryError("not_found", "Project not found.", 404);
  const result = await env.DB.prepare(
    "SELECT r.id AS revisionId, r.page_id AS pageId, p.title AS title, p.kind AS kind, r.status AS status, r.actor AS actor, r.created_at AS createdAt, r.base_revision_id AS baseRevisionId, p.head_revision_id AS headRevisionId FROM page_revision r JOIN page p ON p.id=r.page_id WHERE p.project_id=? AND r.status='proposed' AND (? IS NULL OR (r.created_at,r.id)<(SELECT created_at,id FROM page_revision WHERE id=?)) ORDER BY r.created_at DESC,r.id DESC LIMIT 51",
  )
    .bind(input.projectId, input.cursor ?? null, input.cursor ?? null)
    .all<ProposalSummary>();
  const proposals = result.results.slice(0, 50);
  return {
    proposals,
    nextCursor: result.results.length > 50 ? (proposals[49]?.revisionId ?? null) : null,
  };
}

export async function getProposal(
  env: Env,
  actor: Actor,
  input: { projectId: string; revisionId: string },
): Promise<ProposalView> {
  if (!isOwner(actor)) throw new AuthError("invalid", "Only the owner may review proposals.");
  return readProposal(env, input.projectId, input.revisionId);
}

export async function decideProposal(
  env: Env,
  actor: Actor,
  input: {
    projectId: string;
    revisionId: string;
    decision: "accept" | "reject";
    expectedHeadRevisionId: string | null;
    title?: string | undefined;
    kind?: ProposalKind | undefined;
  },
): Promise<ProposalView> {
  if (!isOwner(actor)) throw new AuthError("invalid", "Only the owner accepts or rejects proposals.");
  if (input.decision !== "accept" && input.decision !== "reject")
    throw new LibraryError("invalid", "Choose accept or reject.", 400);
  const stored = await readProposal(env, input.projectId, input.revisionId);
  if (input.title !== undefined || input.kind !== undefined) {
    const wantTitle = input.title === undefined ? stored.title : cleanTitle(input.title);
    const wantKind = input.kind === undefined ? stored.kind : cleanKind(input.kind);
    if (wantTitle !== stored.title || wantKind !== stored.kind)
      throw new LibraryError("invalid", "The proposal title and kind are immutable. Reject it or propose a new revision.", 400);
  }
  const decidedStatus = input.decision === "accept" ? "accepted" : "rejected";
  if (stored.status === decidedStatus) return stored;
  if (stored.status !== "proposed")
    throw new LibraryError("conflict", "This proposal is already decided.", 409);
  if (input.decision === "reject") {
    const changed = await env.DB.prepare("UPDATE page_revision SET status='rejected' WHERE id=? AND status='proposed'")
      .bind(input.revisionId)
      .run();
    if (changed.meta.changes !== 1) throw new LibraryError("conflict", "This proposal is already decided.", 409);
    return readProposal(env, input.projectId, input.revisionId);
  }
  if (input.expectedHeadRevisionId === undefined)
    throw new LibraryError("invalid", "Confirm the current accepted head first.", 400);
  const now = Date.now();
  const acceptBatch = await env.DB.batch([
    env.DB.prepare(
      "UPDATE page_revision SET status='accepted' WHERE id=? AND status='proposed' AND base_revision_id IS ? AND EXISTS (SELECT 1 FROM page p WHERE p.id=page_revision.page_id AND p.project_id=? AND p.head_revision_id IS ?)",
    ).bind(input.revisionId, input.expectedHeadRevisionId, input.projectId, input.expectedHeadRevisionId),
    env.DB.prepare(
      "UPDATE page SET head_revision_id=?,updated_at=? WHERE id=? AND project_id=? AND head_revision_id IS ? AND EXISTS (SELECT 1 FROM page_revision r WHERE r.id=? AND r.page_id=page.id AND r.status='accepted' AND r.base_revision_id IS ?)",
    ).bind(input.revisionId, now, stored.pageId, input.projectId, input.expectedHeadRevisionId, input.revisionId, input.expectedHeadRevisionId),
  ]);
  const acceptChanges = acceptBatch.map((result) => result.meta.changes);
  if (acceptChanges[0] === 1 && acceptChanges[1] === 1) {
    return readProposal(env, input.projectId, input.revisionId);
  }
  const winner = await readProposal(env, input.projectId, input.revisionId);
  if (winner.status === "accepted") return winner;
  throw new LibraryError("conflict", "The accepted head changed. Request a new proposal against the current head.", 409);
}
