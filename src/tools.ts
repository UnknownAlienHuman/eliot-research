import type { Actor } from "./auth";
import { isCitableBlock, type Block } from "./blocks";
import { getPage } from "./pages";
import { getUnderstanding } from "./understanding";
import { getProject, getSource, LibraryError, listProjects, listSources } from "./library";
import { readOutline, readText } from "./read";

type BudgetInput = { maxTokens?: number | undefined }; type ListProjectsInput = BudgetInput & { cursor?: string | undefined };
type ListSourcesInput = BudgetInput & { projectId: string; sourceIds?: string[] | undefined; cursor?: string | undefined };
type RevisionInput = BudgetInput & { projectId: string; sourceId: string; revisionId?: string | undefined }; type OutlineInput = RevisionInput & { cursor?: number | undefined };
type ReadInput = BudgetInput & { projectId: string; revisionId: string; start: number; end: number };
type SearchInput = ListSourcesInput & { query: string; cursor?: string | undefined }; type PageInput = BudgetInput & { projectId: string; pageId: string; cursor?: number | undefined; headRevisionId?: string | undefined };
type ScopedRevision = { sourceId: string; title: string; revisionId: string; readableState: string; readableSize: number | null; blockCount: number | null; distillState: string | null };
type ListedSource = { id: string; title: string; kind: string; readableState: string; enabled: boolean; currentRevisionId: string | null; revisionId: string; createdAt: number };
type ClaimHit = { id: string; revisionId: string; sourceTitle: string; kind: string; statement: string; quote: string; block: number; start: number; end: number };
type SearchHit = { kind: "guide" | "claim"; id: string; markdown: string };

export const MAX_TOOL_OUTPUT_TOKENS = 4000, MAX_TOOL_SOURCE_SCOPE = 50;
const MAX_ROWS = 50, encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const CONTENT_SQL = "coalesce(c.statement,'') || ' ' || coalesce(c.quote,'') || ' ' || coalesce(c.task,'') || ' ' || coalesce(c.metric,'') || ' ' || coalesce(c.dataset,'')";
const SCOPED_REVISION_SELECT =
  "SELECT s.id AS sourceId,s.title AS title,r.id AS revisionId,r.readable_state AS readableState," +
  "r.readable_size AS readableSize,r.block_count AS blockCount,r.distill_state AS distillState " +
  "FROM project_source ps JOIN source s ON s.id=ps.source_id JOIN source_revision r ON r.source_id=s.id ";

function outputBudget(value: number | undefined): number {
  if (value === undefined) return MAX_TOOL_OUTPUT_TOKENS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TOOL_OUTPUT_TOKENS) throw new LibraryError("invalid", "maxTokens must be an integer from 1 to 4000.", 400);
  return value;
}
const fits = (text: string, tokens: number) => encoder.encode(text).byteLength <= tokens * 3;
const minimumTokensFor = (text: string) => Math.max(1, Math.ceil(encoder.encode(text).byteLength / 3));
const minimumBudgetMessage = (text: string, purpose = "this response") =>
  "Minimum maxTokens: " + minimumTokensFor(text) + " to fit " + purpose + ".";
const withinBudget = (text: string, tokens: number) => fits(text, tokens) ? text : minimumBudgetMessage(text);
function singleLine(value: string): string {
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  }).join("").replace(/\s+/gu, " ").trim();
}
const displayCursor = (cursor: string | number) => "Continue with cursor " + cursor + ".";

function queryTerms(query: string): string[] {
  if (typeof query !== "string" || query.trim().length < 1 || query.length > 500) throw new LibraryError("invalid", "Search query must contain 1 to 500 characters.", 400);
  return [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])];
}
const escapeLike = (value: string) => value.replace(/[\\%_]/gu, "\\$&");
const likeVariants = (term: string) => [...new Set([term, term.toLowerCase(), term.toUpperCase()])];
function outlineOrdinal(cursor: number | undefined): number {
  if (cursor === undefined || cursor === 0) return 1;
  if (!Number.isSafeInteger(cursor) || cursor < 1) {
    throw new LibraryError("invalid", "Outline cursor must be a non-negative block ordinal.", 400);
  }
  return cursor;
}
const blockLabel = (revisionId: string, block: number) => "[R" + revisionId + ":" + block + "]";
const blockRange = (block: Block) => "bytes [" + block.start + "," + block.end + ")";
/** Full canonical block passages decide labels; a wrapper keeps its bytes as structure without a label. */
/** One canonical read per request; slices are reused for predicate and rendering. No cache, table, or framework. */
async function readCanonicalBytes(env: Env, actor: Actor, revisionId: string): Promise<Uint8Array> {
  const response = await readText(env, actor, revisionId);
  return new Uint8Array(await response.arrayBuffer());
}
function citableIdsFromBytes(blocks: Block[], bytes: Uint8Array): Set<number> {
  const citable = new Set<number>();
  for (const block of blocks) {
    if (!Number.isSafeInteger(block.start) || !Number.isSafeInteger(block.end) ||
      block.start < 0 || block.end <= block.start || block.end > bytes.byteLength) continue;
    let passage: string;
    try {
      passage = decoder.decode(bytes.subarray(block.start, block.end));
    } catch {
      continue;
    }
    if (isCitableBlock(block, passage)) citable.add(block.id);
  }
  return citable;
}
function persistentLabels(body: string): Array<{ label: string; start: number; end: number }> {
  const ranges: Array<{ label: string; start: number; end: number }> = [];
  let charOffset = 0, byteOffset = 0;
  for (const match of body.matchAll(/\[R[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:\d+\]/gu)) {
    const at = match.index ?? charOffset;
    byteOffset += encoder.encode(body.slice(charOffset, at)).byteLength;
    const start = byteOffset;
    byteOffset += encoder.encode(match[0]).byteLength;
    ranges.push({ label: match[0], start, end: byteOffset });
    charOffset = at + match[0].length;
  }
  return ranges;
}
function safePageChunkEnd(bytes: Uint8Array, start: number, proposed: number, labels: readonly { start: number; end: number }[]): number {
  let end = Math.min(bytes.length, proposed);
  while (end > start && end < bytes.length && (((bytes[end] ?? 0) & 0xc0) === 0x80)) end--;
  return labels.find((range) => range.start < end && end < range.end)?.start ?? end;
}
function firstPageUnitEnd(bytes: Uint8Array, start: number, labels: readonly { start: number; end: number }[]): number {
  const label = labels.find((range) => range.start === start);
  if (label) return label.end;
  if (start >= bytes.length) return start;
  let end = start + 1;
  while (end < bytes.length && (((bytes[end] ?? 0) & 0xc0) === 0x80)) end++;
  return end;
}
function statementQuery(query: string): { terms: string[]; match: string; short: string[] } {
  const terms = queryTerms(query);
  const short = terms.filter((term) => [...term].length < 3);
  const long = terms.filter((term) => [...term].length >= 3);
  return { terms, match: long.map((term) => '"' + term.replace(/"/gu, '""') + '"').join(" AND "), short };
}

async function currentReadableScope(
  env: Env,
  actor: Actor,
  projectId: string,
  requested: string[] | undefined,
): Promise<ScopedRevision[]> {
  await getProject(env, actor, projectId);
  if (requested !== undefined && requested.length > MAX_TOOL_SOURCE_SCOPE) {
    throw new LibraryError("invalid", "Select at most 50 sources for this tool call.", 400);
  }
  const ids = requested === undefined ? undefined : [...new Set(requested)];
  if (ids?.length === 0) return [];
  if (ids !== undefined) {
    const membership = await env.DB.prepare(
      "SELECT ps.source_id AS sourceId FROM project_source ps WHERE ps.project_id=? AND ps.source_id IN (SELECT value FROM json_each(?))",
    ).bind(projectId, JSON.stringify(ids)).all<{ sourceId: string }>();
    if (new Set(membership.results.map((row) => row.sourceId)).size !== ids.length) {
      throw new LibraryError("invalid", "A selected source is outside this project.", 400);
    }
  }
  const sourceFilter = ids === undefined
    ? "AND ps.enabled=1"
    : "AND ps.enabled=1 AND ps.source_id IN (SELECT value FROM json_each(?))";
  const params: Array<string | number | null> = ids === undefined ? [projectId] : [projectId, JSON.stringify(ids)];
  const result = await env.DB.prepare(
    SCOPED_REVISION_SELECT +
      "WHERE ps.project_id=? " + sourceFilter +
      " AND r.id=s.current_revision_id AND s.state='active' AND r.deleted_at IS NULL AND r.readable_state IN ('readable','readable_with_warnings') " +
      "ORDER BY s.created_at ASC,s.id ASC LIMIT 51",
  ).bind(...params).all<ScopedRevision>();
  if (result.results.length > MAX_TOOL_SOURCE_SCOPE) {
    throw new LibraryError("invalid", "This project has more than 50 enabled readable sources. Pass sourceIds from list_sources to narrow the scope.", 400);
  }
  if (ids !== undefined && result.results.length !== ids.length) {
    throw new LibraryError("invalid", "Choose readable sources attached to this project.", 400);
  }
  return result.results;
}
async function attachedReadableRevision(
  env: Env,
  actor: Actor,
  projectId: string,
  revisionId: string | undefined,
  sourceId?: string,
): Promise<ScopedRevision> {
  await getProject(env, actor, projectId);
  const sourceFilter = sourceId === undefined ? "" : " AND s.id=?";
  const params: Array<string | null> = [projectId, revisionId ?? null];
  if (sourceId !== undefined) params.push(sourceId);
  const row = await env.DB.prepare(
    SCOPED_REVISION_SELECT +
      "WHERE ps.project_id=? AND ps.enabled=1 AND r.id=coalesce(?,s.current_revision_id)" + sourceFilter +
      " AND s.state='active' AND r.deleted_at IS NULL " +
      "AND r.readable_state IN ('readable','readable_with_warnings')",
  ).bind(...params).first<ScopedRevision>();
  if (!row) throw new LibraryError("not_found", "A readable revision attached to this project was not found.", 404);
  return row;
}
async function claimHits(
  env: Env,
  scope: readonly ScopedRevision[],
  spec: { match: string; short: string[] },
  cursor: string | undefined,
  exactId = false,
): Promise<ClaimHit[]> {
  if (scope.length === 0 || (spec.match.length === 0 && spec.short.length === 0)) return [];
  const ids = JSON.stringify(scope.map((entry) => entry.revisionId));
  const clauses = [
    "c.source_revision_id IN (SELECT value FROM json_each(?))",
    "r.id=s.current_revision_id",
    "s.state='active'",
    "r.deleted_at IS NULL",
    "r.readable_state IN ('readable','readable_with_warnings')",
    "c.ambiguous=0",
    "c.ordinal<r.claim_count",
  ];
  const values: Array<string | number | null> = [ids];
  let from = "FROM claim c JOIN source_revision r ON r.id=c.source_revision_id JOIN source s ON s.id=r.source_id";
  if (spec.match) {
    from = "FROM claim_fts JOIN claim c ON c.id=claim_fts.claim_id JOIN source_revision r ON r.id=c.source_revision_id JOIN source s ON s.id=r.source_id";
    clauses.unshift("claim_fts MATCH ?");
    values.unshift(spec.match);
  }
  for (const term of spec.short) {
    const variants = likeVariants(term);
    clauses.push("(" + variants.map(() => "(" + CONTENT_SQL + " LIKE ? ESCAPE '\\')").join(" OR ") + ")");
    for (const variant of variants) values.push("%" + escapeLike(variant) + "%");
  }
  if (cursor !== undefined) {
    clauses.push(exactId ? "c.id=?" : "c.id>?");
    values.push(cursor);
  }
  const sql =
    "SELECT c.id AS id,r.id AS revisionId,s.title AS sourceTitle,c.kind AS kind,c.statement AS statement," +
    "c.quote AS quote,c.block_index AS block,c.start_byte AS start,c.end_byte AS end " +
    from + " WHERE " + clauses.join(" AND ") + " ORDER BY c.id LIMIT " + (exactId ? "1" : "51");
  const result = await env.DB.prepare(sql).bind(...values).all<ClaimHit>();
  return result.results;
}
function claimMarkdown(hit: ClaimHit): string {
  return "- " + singleLine(hit.sourceTitle) + " (" + hit.kind + ") " + blockLabel(hit.revisionId, hit.block) +
    " bytes [" + hit.start + "," + hit.end + ")\n" +
    "  Derived claim statement (not primary evidence): " + (JSON.stringify(hit.statement) ?? '""') + "\n" +
    "  Exact stored source quote: " + (JSON.stringify(hit.quote) ?? '""');
}

function formatSearchCursor(hit: SearchHit): string {
  return hit.kind + ":" + hit.id;
}
function parseSearchCursor(cursor: string): { kind: "guide" | "claim"; id: string } {
  const match = /^(guide|claim):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(cursor);
  const kind = match?.[1], id = match?.[2];
  if ((kind !== "guide" && kind !== "claim") || id === undefined) {
    throw new LibraryError("invalid", "Search cursor must be guide:<UUID> or claim:<UUID>.", 400);
  }
  return { kind, id };
}
export async function listProjectsTool(env: Env, actor: Actor, input: ListProjectsInput): Promise<string> {
  const limit = outputBudget(input.maxTokens);
  const page = await listProjects(env, actor, input.cursor);
  const rows = page.projects.slice(0, MAX_ROWS).map((project) => "- " + singleLine(project.title) + " [" + project.id + "]" +
    (project.description ? " — " + singleLine(project.description) : ""));
  for (let count = rows.length; count >= 0; count--) {
    const cursor = count === rows.length ? page.nextCursor : count > 0 ? page.projects[count - 1]?.id : null;
    const detail = count ? rows.slice(0, count).join("\n") : rows.length ? null : "No active projects.";
    if (detail === null) continue;
    const body = "## Projects\n\n" + detail + (cursor ? "\n\n" + displayCursor(cursor) : "");
    if (fits(body, limit)) return body;
  }
  const firstCursor = rows.length > 1 ? page.projects[0]?.id : page.nextCursor;
  const firstBody = "## Projects\n\n" + (rows[0] ?? "No active projects.") +
    (firstCursor ? "\n\n" + displayCursor(firstCursor) : "");
  return minimumBudgetMessage(firstBody, "one complete result");
}
export async function listSourcesTool(env: Env, actor: Actor, input: ListSourcesInput): Promise<string> {
  const limit = outputBudget(input.maxTokens);
  let rows: ListedSource[];
  let nextCursor: string | null = null;
  if (input.sourceIds === undefined) {
    const page = await listSources(env, actor, input.projectId, input.cursor);
    rows = page.sources.map((source) => ({
      id: source.id,
      title: source.title,
      kind: source.kind,
      readableState: source.readableState,
      enabled: Boolean(source.enabled),
      currentRevisionId: source.currentRevisionId,
      revisionId: source.revisionId,
      createdAt: source.createdAt,
    }));
    nextCursor = page.nextCursor ?? null;
  } else {
    await getProject(env, actor, input.projectId);
    if (input.sourceIds.length > MAX_TOOL_SOURCE_SCOPE) {
      throw new LibraryError("invalid", "Select at most 50 sources for this tool call.", 400);
    }
    const ids = [...new Set(input.sourceIds)];
    if (ids.length === 0) {
      return withinBudget("## Sources in project " + input.projectId + "\n\nNo sources explicitly selected.", limit);
    }
    const members = await env.DB.prepare(
      "SELECT ps.source_id AS id,ps.enabled AS enabled FROM project_source ps JOIN source s ON s.id=ps.source_id " +
        "WHERE ps.project_id=? AND s.state='active' AND ps.source_id IN (SELECT value FROM json_each(?))",
    ).bind(input.projectId, JSON.stringify(ids)).all<{ id: string; enabled: number }>();
    const membership = new Map(members.results.map((row) => [row.id, row.enabled]));
    if (membership.size !== ids.length) {
      throw new LibraryError("invalid", "A selected source is outside this project or is not active.", 400);
    }
    if (input.cursor !== undefined && !ids.includes(input.cursor)) {
      throw new LibraryError("invalid", "For an explicit source selection, cursor must be a source ID from that selection.", 400);
    }
    const loaded = await Promise.all(ids.map(async (id) => {
      const result = await getSource(env, actor, id);
      const memberEnabled = membership.get(id);
      return { ...result.source, enabled: Boolean(memberEnabled) };
    }));
    loaded.sort((left, right) => right.createdAt - left.createdAt ||
      (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
    if (input.cursor !== undefined) {
      const cursorIndex = loaded.findIndex((source) => source.id === input.cursor);
      if (cursorIndex < 0) throw new LibraryError("invalid", "The source cursor is not in this selection.", 400);
      rows = loaded.slice(cursorIndex + 1);
    } else {
      rows = loaded;
    }
  }
  const lines = rows.slice(0, MAX_ROWS).map((source) => "- " + singleLine(source.title) + " [" + source.id + "] (" + source.kind + ", " +
    source.readableState + ", " + (source.enabled ? "enabled" : "disabled") + ")\n  Current revision: " +
    (source.currentRevisionId ?? "none") + "; latest revision: " + source.revisionId);
  for (let count = lines.length; count >= 0; count--) {
    const cursor = count < lines.length ? rows[count - 1]?.id : nextCursor;
    const detail = count ? lines.slice(0, count).join("\n") : lines.length ? null : "No attached sources.";
    if (detail === null) continue;
    const body = "## Sources in project " + input.projectId + "\n\n" + detail + (cursor ? "\n\n" + displayCursor(cursor) : "");
    if (fits(body, limit)) return body;
  }
  const firstCursor = lines.length > 1 ? rows[0]?.id : nextCursor;
  const firstBody = "## Sources in project " + input.projectId + "\n\n" + (lines[0] ?? "No attached sources.") +
    (firstCursor ? "\n\n" + displayCursor(firstCursor) : "");
  return minimumBudgetMessage(firstBody, "one complete result");
}
export async function getGuideTool(env: Env, actor: Actor, input: RevisionInput): Promise<string> {
  const limit = outputBudget(input.maxTokens);
  const selected = await attachedReadableRevision(env, actor, input.projectId, input.revisionId, input.sourceId);
  const understanding = await getUnderstanding(env, actor, { sourceId: selected.sourceId, revisionId: selected.revisionId });
  const header = "## Stored guide for " + singleLine(selected.title) + " [" + selected.revisionId + "]" +
    "\n\nDerived orientation only; it is not primary source evidence.";
  if (!understanding.guide) {
    return withinBudget(header + "\n\nNo stored guide is available. This read did not start understanding work.", limit);
  }
  const body = header + "\n\n" + understanding.guide.trim();
  if (fits(body, limit)) return body;
  return withinBudget(
    header + "\n\nThe complete guide exceeds this output cap. Use search for matching guide passages or outline and read for primary source text.",
    limit,
  );
}
export async function outlineTool(env: Env, actor: Actor, input: OutlineInput): Promise<string> {
  const limit = outputBudget(input.maxTokens);
  const selected = await attachedReadableRevision(env, actor, input.projectId, input.revisionId, input.sourceId);
  const startOrdinal = outlineOrdinal(input.cursor);
  const outline = await readOutline(env, actor, selected.revisionId);
  const blocks = outline.blocks.filter((block) => block.id >= startOrdinal);
  const citable = citableIdsFromBytes(blocks, await readCanonicalBytes(env, actor, selected.revisionId));
  const rows = blocks.slice(0, MAX_ROWS).map((block) => "- " + (citable.has(block.id) ? blockLabel(selected.revisionId, block.id) + " " : "") +
    blockRange(block) + " — " + block.type + (block.heading ? ": " + singleLine(block.heading) : ""));
  const title = "## Outline for " + singleLine(selected.title) + " [" + selected.revisionId + "]";
  for (let count = rows.length; count >= 0; count--) {
    const next = count < blocks.length ? blocks[count] : undefined;
    const detail = count ? rows.slice(0, count).join("\n") : blocks.length ? null : "No further blocks.";
    if (detail === null) continue;
    const footer = next ? "\n\nContinue at block " + next.id + " with integer cursor " + next.id + "." : "";
    const body = title + "\n\n" + detail + footer;
    if (fits(body, limit)) return body;
  }
  const firstNext = blocks[1];
  const firstFooter = firstNext ? "\n\nContinue at block " + firstNext.id + " with integer cursor " + firstNext.id + "." : "";
  return minimumBudgetMessage(title + "\n\n" + (rows[0] ?? "No further blocks.") + firstFooter, "one complete result");
}
export async function readTool(env: Env, actor: Actor, input: ReadInput): Promise<string> {
  const limit = outputBudget(input.maxTokens), selected = await attachedReadableRevision(env, actor, input.projectId, input.revisionId);
  const { start, end } = input;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > (selected.readableSize ?? 0))
    throw new LibraryError("invalid", "The exact passage range is outside this revision.", 400);
  const maxBytes = limit * 3;
  const roughHeader = "## Exact passage\nRequested UTF-8 byte range [" + start + "," + end + ") in revision " + selected.revisionId + ".";
  if (end - start + encoder.encode(roughHeader + "\n\n").byteLength > maxBytes)
    return withinBudget("The exact requested range is too large to return intact at this cap. Narrow start and end; the range was not changed.", limit);
  const outline = await readOutline(env, actor, selected.revisionId);
  const range = await readText(env, actor, selected.revisionId, { start, end });
  const bytes = new Uint8Array(await range.arrayBuffer());
  const blocks = outline.blocks.filter((block) => block.start >= start && block.end <= end)
    .map((block) => ({ ...block, start: block.start - start, end: block.end - start }));
  const citable = citableIdsFromBytes(blocks, bytes);
  const labels = blocks.filter((block) => citable.has(block.id)).map((block) => blockLabel(selected.revisionId, block.id)).join(", ");
  const header = "## Exact passage " + (labels || "[revision " + selected.revisionId + "]") +
    "\nRequested UTF-8 byte range [" + start + "," + end + ") in revision " + selected.revisionId + ".";
  try { decoder.decode(bytes); }
  catch { throw new LibraryError("invalid", "The passage must start and end on UTF-8 boundaries.", 400); }
  const segments: string[] = [];
  let offset = 0;
  const appendSegment = (label: string, from: number, to: number) => {
    if (to <= from) return;
    let text: string;
    try { text = decoder.decode(bytes.subarray(from, to)); }
    catch { throw new LibraryError("invalid", "The passage must start and end on UTF-8 boundaries.", 400); }
    segments.push("Source segment " + label + " — source bytes [" + (start + from) + "," + (start + to) + ")\n" + text);
  };
  for (const block of blocks) {
    if (!citable.has(block.id) || block.start < offset) continue;
    if (block.start > offset) appendSegment("unlabelled", offset, block.start);
    appendSegment(blockLabel(selected.revisionId, block.id), block.start, block.end);
    offset = block.end;
  }
  if (offset < bytes.byteLength || segments.length === 0) appendSegment("unlabelled", offset, bytes.byteLength);
  const body = header + "\n\n" + segments.join("\n\n");
  if (encoder.encode(body).byteLength > maxBytes)
    return withinBudget("The exact requested range is too large to return intact at this cap. Narrow start and end; the range was not changed.", limit);
  return body;
}
export async function findClaimsTool(env: Env, actor: Actor, input: SearchInput): Promise<string> {
  const limit = outputBudget(input.maxTokens);
  const scope = await currentReadableScope(env, actor, input.projectId, input.sourceIds);
  const spec = statementQuery(input.query);
  if (input.cursor !== undefined && (await claimHits(env, scope, spec, input.cursor, true)).length === 0) {
    throw new LibraryError("invalid", "The claim cursor is outside this query or selected project scope.", 400);
  }
  const hits = await claimHits(env, scope, spec, input.cursor);
  const note = "Only current readable revisions were searched. Claim statements are derived; their stored quotes and byte ranges identify source evidence.";
  const rows = hits.slice(0, MAX_ROWS).map(claimMarkdown);
  for (let count = rows.length; count >= 0; count--) {
    const cursor = count > 0 && count < hits.length ? hits[count - 1]?.id : null;
    const detail = count ? rows.slice(0, count).join("\n") : hits.length ? null
      : spec.terms.length === 0 ? "No searchable keywords were found." : "No verified claims matched.";
    if (detail === null) continue;
    const body = "## Verified claim matches\n\n" + note + "\n\n" + detail + (cursor ? "\n\n" + displayCursor(cursor) : "");
    if (fits(body, limit)) return body;
  }
  const firstCursor = hits.length > 1 ? hits[0]?.id : null;
  const firstDetail = rows[0] ?? (spec.terms.length === 0 ? "No searchable keywords were found." : "No verified claims matched.");
  const firstBody = "## Verified claim matches\n\n" + note + "\n\n" + firstDetail +
    (firstCursor ? "\n\n" + displayCursor(firstCursor) : "");
  return minimumBudgetMessage(firstBody, "one complete result");
}
export async function searchTool(env: Env, actor: Actor, input: SearchInput): Promise<string> {
  const limit = outputBudget(input.maxTokens);
  const cursor = input.cursor === undefined ? undefined : parseSearchCursor(input.cursor);
  const scope = await currentReadableScope(env, actor, input.projectId, input.sourceIds);
  const spec = statementQuery(input.query);
  if (scope.length === 0 || spec.terms.length === 0) {
    if (cursor !== undefined) throw new LibraryError("invalid", "Search cursor is outside this query or selected project scope.", 400);
    return withinBudget("## Search\n\nNo readable selected revisions or searchable keywords were available.", limit);
  }
  const guideHits: SearchHit[] = [];
  let unavailableGuides = 0;
  for (const selected of scope) {
    if (selected.distillState !== "done" && selected.distillState !== "partial") continue;
    try {
      const understanding = await getUnderstanding(env, actor, {
        sourceId: selected.sourceId,
        revisionId: selected.revisionId,
      });
      const guide = understanding.guide;
      if (!guide) continue;
      const folded = guide.toLowerCase();
      const positions = spec.terms.map((term) => folded.indexOf(term.toLowerCase())).filter((index) => index >= 0);
      if (positions.length !== spec.terms.length) continue;
      const at = Math.min(...positions);
      let start = Math.max(0, at - 180);
      if (start > 0 && start < guide.length && guide.charCodeAt(start) >= 0xdc00 && guide.charCodeAt(start) <= 0xdfff) start--;
      let end = Math.min(guide.length, start + 700);
      if (end > 0 && end < guide.length && guide.charCodeAt(end - 1) >= 0xd800 && guide.charCodeAt(end - 1) <= 0xdbff) end--;
      const snippet = (start > 0 ? "..." : "") + guide.slice(start, end) + (end < guide.length ? "..." : "");
      guideHits.push({
        kind: "guide",
        id: selected.revisionId,
        markdown: "- Guide for " + singleLine(selected.title) + " [R" + selected.revisionId +
          "] (derived orientation, not primary evidence): " + (JSON.stringify(snippet) ?? '""'),
      });
    } catch (error) {
      if (error instanceof LibraryError && error.code === "unavailable") {
        unavailableGuides++;
        continue;
      }
      throw error;
    }
  }
  guideHits.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  let cursorKind: "guide" | "claim" | undefined;
  if (cursor) {
    const cursorExists = cursor.kind === "guide"
      ? guideHits.some((hit) => hit.id === cursor.id)
      : (await claimHits(env, scope, spec, cursor.id, true)).length > 0;
    if (!cursorExists) throw new LibraryError("invalid", "Search cursor is outside this query or selected project scope.", 400);
    cursorKind = cursor.kind;
  }
  const pageGuides = cursorKind === "claim" ? [] : cursor
    ? guideHits.filter((hit) => hit.id > cursor.id)
    : guideHits;
  const claims = await claimHits(env, scope, spec, cursorKind === "claim" ? cursor?.id : undefined);
  const hits: SearchHit[] = [
    ...pageGuides,
    ...claims.map((hit) => ({ kind: "claim" as const, id: hit.id, markdown: claimMarkdown(hit) })),
  ];
  const note = "Literal storage search across current readable selected revisions; no model, web, or AI Search work. Guide matches and claim statements are derived; only the exact stored claim quote and byte range are source evidence." +
    (unavailableGuides > 0 ? " Stored guides were unavailable for " + unavailableGuides + " selected revision(s); claim search still ran." : "");
  const rows = hits.slice(0, MAX_ROWS);
  for (let count = rows.length; count >= 0; count--) {
    const last = count > 0 ? hits[count - 1] : undefined;
    const cursor = count < hits.length && last ? formatSearchCursor(last) : null;
    const detail = count ? rows.slice(0, count).map((hit) => hit.markdown).join("\n") : hits.length ? null
      : "No guide or verified claim matched every literal keyword.";
    if (detail === null) continue;
    const body = "## Search results\n\n" + note + "\n\n" + detail + (cursor ? "\n\n" + displayCursor(cursor) : "");
    if (fits(body, limit)) return body;
  }
  const first = hits[0];
  const firstCursor = hits.length > 1 && first ? formatSearchCursor(first) : null;
  const firstBody = "## Search results\n\n" + note + "\n\n" + (first?.markdown ?? "No guide or verified claim matched every literal keyword.") +
    (firstCursor ? "\n\n" + displayCursor(firstCursor) : "");
  return minimumBudgetMessage(firstBody, "one complete result");
}
export async function getPageTool(env: Env, actor: Actor, input: PageInput): Promise<string> {
  const limit = outputBudget(input.maxTokens);
  const page = await getPage(env, actor, { projectId: input.projectId, pageId: input.pageId });
  if (input.cursor !== undefined && input.headRevisionId === undefined) {
    throw new LibraryError("invalid", "Pass the page head revision with a continuation cursor.", 400);
  }
  if (input.headRevisionId !== undefined && input.headRevisionId !== page.headRevisionId) {
    throw new LibraryError("conflict", "The page head changed. Restart reading from byte 0 with the current head revision.", 409);
  }
  const bytes = encoder.encode(page.body), total = bytes.byteLength, start = input.cursor ?? 0;
  if (!Number.isSafeInteger(start) || start < 0 || start > total ||
    (start < total && (((bytes[start] ?? 0) & 0xc0) === 0x80))) {
    throw new LibraryError("invalid", "The page cursor must be a UTF-8 byte boundary in this page.", 400);
  }
  const labels = persistentLabels(page.body);
  if (labels.some((range) => range.start < start && start < range.end)) {
    throw new LibraryError("invalid", "The page cursor must not split a persistent citation label.", 400);
  }
  const header = "## " + singleLine(page.title) + " (" + page.kind + ", " + page.freshness + ")" +
    "\nPage " + page.id + "; immutable head revision " + page.headRevisionId + ".";
  if (start === total) {
    const result = header + "\n\nBody UTF-8 bytes [" + start + "," + start + ") of " + total +
      " (consumed through byte " + start + ").\n\n\n\nNo next cursor.";
    return fits(result, limit) ? result : minimumBudgetMessage(result);
  }
  let end = safePageChunkEnd(bytes, start, start + limit * 3, labels);
  for (;;) {
    if (end === start) {
      const firstEnd = firstPageUnitEnd(bytes, start, labels);
      const firstChunk = decoder.decode(bytes.subarray(start, firstEnd));
      const next = firstEnd < total
        ? "\n\nNext cursor: " + firstEnd + "; continue with headRevisionId " + page.headRevisionId + "."
        : "\n\nNo next cursor.";
      return minimumBudgetMessage(header + "\n\nBody UTF-8 bytes [" + start + "," + firstEnd + ") of " + total +
        " (consumed through byte " + firstEnd + ").\n\n" + firstChunk + next, "the next complete page chunk");
    }
    try {
      decoder.decode(bytes.subarray(start, end));
    } catch {
      throw new LibraryError("invalid", "The page cursor must land on a UTF-8 boundary.", 400);
    }
    const chunk = decoder.decode(bytes.subarray(start, end));
    const next = end < total
      ? "\n\nNext cursor: " + end + "; continue with headRevisionId " + page.headRevisionId + "."
      : "\n\nNo next cursor.";
    const result = header + "\n\nBody UTF-8 bytes [" + start + "," + end + ") of " + total +
      " (consumed through byte " + end + ").\n\n" + chunk + next;
    const chunkLabels = new Set(labels.filter((label) => label.start >= start && label.end <= end).map((label) => label.label));
    const citations = page.citations.filter((citation) => chunkLabels.has(blockLabel(citation.revisionId, citation.block)))
      .map((citation) => "- " + singleLine(citation.sourceTitle) + " " + blockLabel(citation.revisionId, citation.block) +
        " bytes [" + citation.start + "," + citation.end + ")" + (citation.deleted ? " (source deleted)" : ""));
    for (let visible = citations.length; visible >= 0; visible--) {
      const sections: string[] = [];
      if (visible > 0) sections.push("### Stored source citations\n" + citations.slice(0, visible).join("\n"));
      const hidden = citations.length - visible;
      if (hidden > 0) {
        sections.push(hidden + " stored source citations hidden because maxTokens was reached; increase maxTokens to include them.");
      }
      const candidate = sections.length === 0 ? result : result + "\n\n" + sections.join("\n\n");
      if (fits(candidate, limit)) return candidate;
    }
    const smaller = safePageChunkEnd(bytes, start, end - 1, labels);
    if (smaller >= end || smaller === start) {
      const firstEnd = firstPageUnitEnd(bytes, start, labels);
      const firstChunk = decoder.decode(bytes.subarray(start, firstEnd));
      const firstNext = firstEnd < total
        ? "\n\nNext cursor: " + firstEnd + "; continue with headRevisionId " + page.headRevisionId + "."
        : "\n\nNo next cursor.";
      return minimumBudgetMessage(header + "\n\nBody UTF-8 bytes [" + start + "," + firstEnd + ") of " + total +
        " (consumed through byte " + firstEnd + ").\n\n" + firstChunk + firstNext, "the next complete page chunk");
    }
    end = smaller;
  }
}
