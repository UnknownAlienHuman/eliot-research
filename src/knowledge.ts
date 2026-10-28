// K6 project-knowledge storage. The Workflow owns admission and synthesis;
// this module reads the frozen source surface and commits accepted pages.
import type { Actor } from "./auth";
import type { Block } from "./blocks";
import type { Citation } from "./citations";
import type { ComparisonAliases, ComparisonClaim, ComparisonGroup } from "./comparisons";
import { getPage, type SavedPage } from "./pages";
import { getUnderstanding } from "./understanding";
import { LibraryError } from "./library";
import { checkWikiOutput, wikiSchema } from "./wiki";
import type { WikiOutputCheck } from "./wiki";

export interface KnowledgeSource {
  sourceId: string;
  revisionId: string;
  title: string;
  guide: string | null;
  claims: ComparisonClaim[];
}

export interface KnowledgeData {
  topics: { id: string; title: string; sourceIds: string[] }[];
  comparisons: ComparisonGroup[];
  gaps: { question: string; sourceIds: string[] }[];
  routes: { title: string; sourceIds: string[] }[];
  sources: { sourceId: string; revisionId: string; title: string }[];
  aliases?: ComparisonAliases;
}

export interface KnowledgeInputs {
  kind: "map" | "wiki";
  topicId?: string;
  sources: KnowledgeSource[];
  previous: KnowledgeData | null;
  changed: string[];
  wikiEvidence?: WikiEvidence[];
  checkedFrom?: string;
}

export interface RetainedWiki {
  pageId: string;
  originalRevisionId: string;
  inputs: KnowledgeInputs;
  checked: WikiOutputCheck;
}

export interface KnowledgeView {
  state: "none" | "running" | "paused" | "done" | "failed";
  error: string | null;
  canRecheckWiki: boolean;
  operation: { revisionId: string; pageId: string; kind: "map" | "wiki" } | null;
  page: SavedPage | null;
  data: KnowledgeData | null;
  usage: {
    calls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostMicrousd: number | null;
  } | null;
}

export interface WikiEvidence {
  quote: string;
  citation: Citation;
}

interface KnowledgeSourceRow {
  sourceId: string;
  revisionId: string;
  title: string;
}

const READABLE_STATES = "('readable','readable_with_warnings')";
const STALE_ERROR = "Project sources changed during this update. Refresh project knowledge again.";
const MAX_PAGE_BODY_CHARS = 1_000_000;
// Mirrors the existing model-call context ceiling at three UTF-8 bytes/token.
const MAX_WIKI_EVIDENCE_BYTES = 400_000 * 3;

async function currentKnowledgeSources(env: Env, projectId: string): Promise<KnowledgeSourceRow[]> {
  const rows = await env.DB.prepare(`SELECT s.id AS sourceId,r.id AS revisionId,s.title
    FROM project_source ps
    JOIN source s ON s.id=ps.source_id
    JOIN source_revision r ON r.id=s.current_revision_id AND r.source_id=s.id
    WHERE ps.project_id=? AND s.state='active' AND r.deleted_at IS NULL
      AND r.readable_state IN ${READABLE_STATES}
    ORDER BY s.title COLLATE NOCASE,s.id`)
    .bind(projectId).all<KnowledgeSourceRow>();
  return rows.results;
}

function sameSourceSnapshot(left: KnowledgeSourceRow[], right: KnowledgeSourceRow[]): boolean {
  const key = (rows: KnowledgeSourceRow[]) => JSON.stringify([...rows]
    .sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)
    .map(({ sourceId, revisionId, title }) => [sourceId, revisionId, title]));
  return key(left) === key(right);
}

export async function loadKnowledgeInputs(env: Env, actor: Actor | null, input: { projectId: string }): Promise<KnowledgeSource[]> {
  const project = await env.DB.prepare("SELECT id FROM project WHERE id=?").bind(input.projectId).first<{ id: string }>();
  if (!project) throw new LibraryError("not_found", "Project not found.", 404);

  const snapshot = await currentKnowledgeSources(env, input.projectId);
  const sources = await Promise.all(snapshot.map(async (source): Promise<KnowledgeSource> => {
    let understanding;
    try {
      understanding = await getUnderstanding(env, actor, { sourceId: source.sourceId, revisionId: source.revisionId });
    } catch (error) {
      if (error instanceof LibraryError && error.code === "not_found") {
        throw new LibraryError("conflict", "Project sources changed while loading knowledge. Reload and refresh again.", 409);
      }
      throw error;
    }
    if (understanding.revisionId !== source.revisionId) {
      throw new LibraryError("conflict", "A project source changed while loading knowledge. Reload and refresh again.", 409);
    }
    return {
      sourceId: source.sourceId,
      revisionId: source.revisionId,
      title: source.title,
      guide: understanding.guide,
      // getUnderstanding exposes only the stored, verified claim prefix.
      claims: understanding.claims.map((claim) => ({ ...claim, sourceId: source.sourceId, revisionId: source.revisionId })),
    };
  }));

  const current = await currentKnowledgeSources(env, input.projectId);
  if (!sameSourceSnapshot(snapshot, current)) {
    throw new LibraryError("conflict", "Project sources changed while loading knowledge. Reload and refresh again.", 409);
  }
  return sources;
}

function blockId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new LibraryError("invalid", "A Wiki evidence reference has an invalid block number.", 400);
  }
  return Number(value);
}

function guideBlockReferences(guide: string, revisionIds: Set<string>): { revisionId: string; blockId: number }[] {
  const references: { revisionId: string; blockId: number }[] = [];
  const markers = guide.match(/\[(?:R|S)[^\]\r\n]*(?:\]|$)/g) ?? [];
  for (const marker of markers) {
    const match = /^\[R([^:\]\r\n]+):(\d+)\]$/.exec(marker);
    if (!match || !revisionIds.has(match[1] ?? "")) {
      throw new LibraryError("conflict", "A stored Wiki guide reference is outside its frozen source revision.", 409);
    }
    const id = blockId(Number(match[2]));
    if (String(id) !== match[2]) throw new LibraryError("invalid", "A Wiki guide reference has a non-canonical block number.", 400);
    references.push({ revisionId: match[1] as string, blockId: id });
  }
  return references;
}

function storedBlocks(value: unknown): Map<number, Block> {
  if (!Array.isArray(value)) throw new LibraryError("unavailable", "The frozen Wiki block map is invalid.", 503);
  const result = new Map<number, Block>();
  const blockTypes = new Set<Block["type"]>(["heading", "paragraph", "list", "table", "code", "quote"]);
  for (const item of value) {
    if (!isRecord(item) || !Number.isSafeInteger(item.id) || Number(item.id) < 1
      || !blockTypes.has(item.type as Block["type"]) || !Number.isSafeInteger(item.start)
      || !Number.isSafeInteger(item.end) || Number(item.start) < 0 || Number(item.end) <= Number(item.start)
      || (item.heading !== null && typeof item.heading !== "string")) {
      throw new LibraryError("unavailable", "The frozen Wiki block map contains an invalid range.", 503);
    }
    const block = item as unknown as Block;
    if (result.has(block.id)) throw new LibraryError("unavailable", "The frozen Wiki block map contains duplicate IDs.", 503);
    result.set(block.id, block);
  }
  return result;
}

export async function loadWikiEvidence(env: Env, sources: readonly KnowledgeSource[]): Promise<WikiEvidence[]> {
  const sourceIds = new Set<string>();
  const revisionIds = new Set<string>();
  for (const source of sources) {
    if (!source.sourceId || !source.revisionId || !source.title || source.revisionId.includes("/")
      || source.revisionId.includes("\\") || sourceIds.has(source.sourceId) || revisionIds.has(source.revisionId)
      || !Array.isArray(source.claims) || (source.guide !== null && typeof source.guide !== "string")) {
      throw new LibraryError("invalid", "The frozen Wiki source scope is invalid.", 400);
    }
    sourceIds.add(source.sourceId);
    revisionIds.add(source.revisionId);
  }

  const requestedByRevision = new Map<string, Set<number>>();
  const requestBlock = (revisionId: string, id: number) => {
    const ids = requestedByRevision.get(revisionId) ?? new Set<number>();
    ids.add(id);
    requestedByRevision.set(revisionId, ids);
  };
  for (const source of sources) {
    for (const claim of source.claims) {
      if (claim.sourceId !== source.sourceId || claim.revisionId !== source.revisionId) {
        throw new LibraryError("conflict", "A Wiki claim is outside its frozen source revision.", 409);
      }
      requestBlock(source.revisionId, blockId(claim.block));
    }
    if (source.guide !== null) {
      for (const reference of guideBlockReferences(source.guide, revisionIds)) {
        requestBlock(reference.revisionId, reference.blockId);
      }
    }
  }
  const requested = sources.flatMap((source) => {
    const ids = requestedByRevision.get(source.revisionId);
    return ids ? [{ source, blockIds: [...ids].sort((a, b) => a - b) }] : [];
  });
  if (requested.length === 0) {
    throw new LibraryError("invalid", "This topic has no verified source passages for a Wiki page.", 400);
  }

  const blockMaps = new Map<string, Map<number, Block>>();
  for (const { source } of requested) {
    const object = await env.BUCKET.get(`source/${source.revisionId}/blocks.json`);
    if (!object) throw new LibraryError("unavailable", "A frozen Wiki source block map is missing.", 503);
    let raw: unknown;
    try { raw = await object.json<unknown>(); }
    catch { throw new LibraryError("unavailable", "A frozen Wiki source block map is invalid.", 503); }
    blockMaps.set(source.revisionId, storedBlocks(raw));
  }

  const selected: { source: KnowledgeSource; block: Block }[] = [];
  let totalBytes = 0;
  for (const { source, blockIds } of requested) {
    const blocks = blockMaps.get(source.revisionId);
    for (const id of blockIds) {
      const block = blocks?.get(id);
      if (!block) throw new LibraryError("unavailable", "A frozen Wiki citation references a missing source block.", 503);
      const length = block.end - block.start;
      totalBytes += length;
      if (totalBytes > MAX_WIKI_EVIDENCE_BYTES) {
        throw new LibraryError("invalid", "The frozen Wiki evidence exceeds the bounded model context.", 400);
      }
      selected.push({ source, block });
    }
  }

  return Promise.all(selected.map(async ({ source, block }): Promise<WikiEvidence> => {
    const object = await env.BUCKET.get(`source/${source.revisionId}/text.md`, {
      range: { offset: block.start, length: block.end - block.start },
    });
    if (!object) throw new LibraryError("unavailable", "A frozen Wiki source passage is missing.", 503);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== block.end - block.start) {
      throw new LibraryError("unavailable", "A frozen Wiki source passage is incomplete.", 503);
    }
    let quote: string;
    try { quote = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new LibraryError("unavailable", "A frozen Wiki source passage is not valid UTF-8.", 503); }
    if (new TextEncoder().encode(quote).byteLength !== bytes.byteLength) {
      throw new LibraryError("unavailable", "A frozen Wiki source passage did not round-trip as UTF-8.", 503);
    }
    return {
      quote,
      citation: {
        revisionId: source.revisionId,
        sourceId: source.sourceId,
        block: block.id,
        start: block.start,
        end: block.end,
        sourceTitle: source.title,
        deleted: false,
        label: `[R${source.revisionId}:${block.id}]`,
      },
    };
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isComparisonAliases(value: unknown): value is ComparisonAliases {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 32 && entries.every(([canonical, variants]) => canonical.trim().length > 0
    && canonical.length <= 1000 && Array.isArray(variants) && variants.length > 0 && variants.length <= 12
    && variants.every((variant) => typeof variant === "string" && variant.trim().length > 0 && variant.length <= 1000));
}

function isComparisonClaim(value: unknown): value is ComparisonClaim {
  if (!isRecord(value)) return false;
  const nullableString = (item: unknown) => item === null || typeof item === "string";
  const nullableNumber = (item: unknown) => item === null || (typeof item === "number" && Number.isFinite(item));
  return typeof value.id === "string" && typeof value.sourceId === "string" && typeof value.revisionId === "string"
    && typeof value.kind === "string" && typeof value.statement === "string" && typeof value.quote === "string"
    && Number.isSafeInteger(value.block) && Number(value.block) >= 0
    && Number.isSafeInteger(value.start) && Number(value.start) >= 0
    && Number.isSafeInteger(value.end) && Number(value.end) > Number(value.start)
    && typeof value.ambiguous === "boolean" && nullableString(value.task) && nullableString(value.metric)
    && nullableString(value.dataset) && nullableString(value.valueText) && nullableNumber(value.valueNumber)
    && nullableString(value.unit) && nullableString(value.conditions);
}

function isKnowledgeData(value: unknown): value is KnowledgeData {
  if (!isRecord(value) || !Array.isArray(value.topics) || !Array.isArray(value.comparisons)
    || !Array.isArray(value.gaps) || !Array.isArray(value.routes) || !Array.isArray(value.sources)
    || (value.aliases !== undefined && !isComparisonAliases(value.aliases))) return false;
  const topicsOk = value.topics.every((topic) => isRecord(topic) && typeof topic.id === "string"
    && typeof topic.title === "string" && isStringArray(topic.sourceIds));
  const comparisonsOk = value.comparisons.every((group) => isRecord(group) && typeof group.id === "string"
    && typeof group.task === "string" && typeof group.metric === "string" && typeof group.dataset === "string"
    && typeof group.unit === "string" && typeof group.conditions === "string" && typeof group.disagreement === "boolean"
    && Array.isArray(group.rows) && group.rows.every(isComparisonClaim));
  const gapsOk = value.gaps.every((gap) => isRecord(gap) && typeof gap.question === "string" && isStringArray(gap.sourceIds));
  const routesOk = value.routes.every((route) => isRecord(route) && typeof route.title === "string" && isStringArray(route.sourceIds));
  const sourcesOk = value.sources.every((source) => isRecord(source) && typeof source.sourceId === "string"
    && typeof source.revisionId === "string" && typeof source.title === "string");
  if (!topicsOk || !comparisonsOk || !gapsOk || !routesOk || !sourcesOk) return false;
  const sourceRows = value.sources as KnowledgeData["sources"];
  const sourceIds = new Set(sourceRows.map((source) => source.sourceId));
  const revisionIds = new Set(sourceRows.map((source) => source.revisionId));
  if (sourceIds.size !== sourceRows.length || revisionIds.size !== sourceRows.length) return false;
  const sourceById = new Map(sourceRows.map((source) => [source.sourceId, source]));
  return value.topics.every((topic) => (topic as KnowledgeData["topics"][number]).sourceIds.every((id) => sourceIds.has(id)))
    && value.gaps.every((gap) => (gap as KnowledgeData["gaps"][number]).sourceIds.every((id) => sourceIds.has(id)))
    && value.routes.every((route) => (route as KnowledgeData["routes"][number]).sourceIds.every((id) => sourceIds.has(id)))
    && value.comparisons.every((group) => (group as ComparisonGroup).rows.every((claim) => {
      const source = sourceById.get(claim.sourceId);
      return source !== undefined && source.revisionId === claim.revisionId;
    }));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function markdownText(value: string): string {
  const special = new Set(["\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "+", ".", "!", "|", ">", "~", "-"]);
  return [...value].map((character) => special.has(character) ? `\\${character}` : character).join("");
}

function sourceLabels(sourceIds: string[], sources: Map<string, KnowledgeData["sources"][number]>): string {
  const found = [...new Set(sourceIds)].flatMap((id) => {
    const source = sources.get(id);
    return source ? [{ id, title: source.title }] : [];
  }).sort((a, b) => compareText(a.title, b.title) || compareText(a.id, b.id));
  return found.map((source) => markdownText(source.title)).join(", ");
}

function claimCitation(claim: ComparisonClaim, sources: Map<string, KnowledgeData["sources"][number]>): Citation | null {
  const source = sources.get(claim.sourceId);
  if (!source || source.revisionId !== claim.revisionId || !claim.quote.trim()
    || !Number.isSafeInteger(claim.block) || claim.block < 0
    || !Number.isSafeInteger(claim.start) || claim.start < 0
    || !Number.isSafeInteger(claim.end) || claim.end <= claim.start) return null;
  return {
    revisionId: claim.revisionId,
    sourceId: claim.sourceId,
    block: claim.block,
    start: claim.start,
    end: claim.end,
    sourceTitle: source.title,
    deleted: false,
    label: `[R${claim.revisionId}:${claim.block}]`,
  };
}

export function renderKnowledge(data: KnowledgeData): { body: string; citations: Citation[] } {
  const sources = new Map(data.sources.map((source) => [source.sourceId, source]));
  const citations = new Map<string, Citation>();
  const lines = ["# Project knowledge map", "", "## Topics"];
  const topics = [...data.topics].sort((a, b) => compareText(a.id, b.id) || compareText(a.title, b.title));
  for (const topic of topics) {
    const names = sourceLabels(topic.sourceIds, sources);
    lines.push(`- **${markdownText(topic.title)}**${names ? ` — ${names}` : ""}`);
  }

  lines.push("", "## Comparisons");
  const groups = [...data.comparisons].sort((a, b) => compareText(a.id, b.id));
  for (const group of groups) {
    const rows = [...group.rows].sort((a, b) => compareText(a.sourceId, b.sourceId) || a.start - b.start || a.end - b.end);
    const renderable = rows.flatMap((claim) => {
      const citation = claimCitation(claim, sources);
      if (!citation) return [];
      const previous = citations.get(citation.label);
      if (previous && previous.sourceId === citation.sourceId && previous.sourceTitle === citation.sourceTitle) {
        citations.set(citation.label, { ...previous, start: Math.min(previous.start, citation.start), end: Math.max(previous.end, citation.end) });
      } else if (!previous) {
        citations.set(citation.label, citation);
      }
      return [{ claim, citation }];
    });
    if (!renderable.length) continue;
    const labels = [group.task, group.metric, group.dataset, group.unit, group.conditions]
      .filter((item) => item !== "").map(markdownText);
    lines.push("", `### ${labels.join(" · ")}${group.disagreement ? " · Disagreement candidate" : ""}`);
    for (const { claim, citation } of renderable) {
      const source = sources.get(claim.sourceId);
      if (!source) continue;
      const quote = claim.quote.split(/\r?\n/).map((line) => `> ${markdownText(line)}`).join("\n");
      lines.push(`- **${markdownText(source.title)}**${claim.valueText ? ` — ${markdownText(claim.valueText)}` : ""} ${citation.label}`);
      lines.push(quote);
    }
  }

  lines.push("", "## Open questions");
  for (const gap of [...data.gaps].sort((a, b) => compareText(a.question, b.question))) {
    const names = sourceLabels(gap.sourceIds, sources);
    lines.push(`- ${markdownText(gap.question)}${names ? ` — ${names}` : ""}`);
  }

  lines.push("", "## Reading routes");
  for (const route of [...data.routes].sort((a, b) => compareText(a.title, b.title))) {
    const names = sourceLabels(route.sourceIds, sources);
    lines.push(`- ${markdownText(route.title)}${names ? ` — ${names}` : ""}`);
  }

  lines.push("", "## Sources");
  for (const source of [...data.sources].sort((a, b) => compareText(a.title, b.title) || compareText(a.sourceId, b.sourceId))) {
    lines.push(`- **${markdownText(source.title)}** — revision \`${source.revisionId}\``);
  }
  return {
    body: lines.join("\n").trimEnd() + "\n",
    citations: [...citations.values()].sort((a, b) => a.revisionId < b.revisionId ? -1 : a.revisionId > b.revisionId ? 1 : a.block - b.block),
  };
}

function sourceSetMismatchSql(kind: "map" | "wiki"): string {
  const inputsMissing = `EXISTS (
    SELECT 1 FROM json_each(?) requested
    WHERE NOT EXISTS (
      SELECT 1 FROM project_source ps JOIN source s ON s.id=ps.source_id
      JOIN source_revision sr ON sr.id=s.current_revision_id AND sr.source_id=s.id
      WHERE ps.project_id=p.id AND s.state='active' AND sr.deleted_at IS NULL
        AND sr.readable_state IN ${READABLE_STATES} AND sr.id=requested.value
    )
  )`;
  if (kind === "wiki") return inputsMissing;
  return `EXISTS (
    SELECT 1 FROM project_source ps JOIN source s ON s.id=ps.source_id
    JOIN source_revision sr ON sr.id=s.current_revision_id AND sr.source_id=s.id
    WHERE ps.project_id=p.id AND s.state='active' AND sr.deleted_at IS NULL
      AND sr.readable_state IN ${READABLE_STATES}
      AND NOT EXISTS (SELECT 1 FROM json_each(?) requested WHERE requested.value=sr.id)
  ) OR ${inputsMissing}`;
}

function sourceSetMatchesSql(kind: "map" | "wiki"): string {
  const currentOutsideInputs = `NOT EXISTS (
    SELECT 1 FROM project_source ps JOIN source s ON s.id=ps.source_id
    JOIN source_revision sr ON sr.id=s.current_revision_id AND sr.source_id=s.id
    WHERE ps.project_id=p.id AND s.state='active' AND sr.deleted_at IS NULL
      AND sr.readable_state IN ${READABLE_STATES}
      AND NOT EXISTS (SELECT 1 FROM json_each(?) requested WHERE requested.value=sr.id)
  )`;
  const inputsMissing = `NOT EXISTS (
    SELECT 1 FROM json_each(?) requested
    WHERE NOT EXISTS (
      SELECT 1 FROM project_source ps JOIN source s ON s.id=ps.source_id
      JOIN source_revision sr ON sr.id=s.current_revision_id AND sr.source_id=s.id
      WHERE ps.project_id=p.id AND s.state='active' AND sr.deleted_at IS NULL
        AND sr.readable_state IN ${READABLE_STATES} AND sr.id=requested.value
    )
  )`;
  return kind === "map" ? `${currentOutsideInputs} AND ${inputsMissing}` : inputsMissing;
}

function inputRevisionIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) return null;
  const ids = value as string[];
  return new Set(ids).size === ids.length ? [...ids].sort() : null;
}

function sameRevisionIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function validCitation(value: unknown, sources: Map<string, KnowledgeData["sources"][number]>, inputs: Set<string>): value is Citation {
  if (!isRecord(value)) return false;
  const { revisionId, sourceId, block, start, end, sourceTitle, deleted, label } = value;
  if (typeof revisionId !== "string" || !inputs.has(revisionId) || typeof sourceId !== "string"
    || !Number.isSafeInteger(block) || (block as number) < 0 || !Number.isSafeInteger(start) || (start as number) < 0
    || !Number.isSafeInteger(end) || (end as number) <= (start as number) || typeof sourceTitle !== "string"
    || deleted !== false || label !== `[R${revisionId}:${block as number}]`) return false;
  const source = sources.get(sourceId);
  return source !== undefined && source.revisionId === revisionId && source.title === sourceTitle;
}

export function wikiData(inputs: KnowledgeInputs): KnowledgeData {
  if (inputs.kind !== "wiki" || !inputs.previous || !inputs.topicId) {
    throw new LibraryError("conflict", "The frozen map needed by this Wiki is missing.", 409);
  }
  const previous = inputs.previous;
  const topic = previous.topics.find((item) => item.id === inputs.topicId);
  const sources = inputs.sources.map(({ sourceId, revisionId, title }) => ({ sourceId, revisionId, title }));
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  const previousSources = new Map(previous.sources.map((source) => [source.sourceId, source]));
  if (!topic || sources.length === 0 || sourceById.size !== sources.length
    || new Set(topic.sourceIds).size !== topic.sourceIds.length || topic.sourceIds.length !== sources.length
    || sources.some((source) => !topic.sourceIds.includes(source.sourceId)
      || previousSources.get(source.sourceId)?.revisionId !== source.revisionId)) {
    throw new LibraryError("conflict", "The frozen Wiki topic and sources do not match.", 409);
  }
  const retain = <T extends { sourceIds: string[] }>(rows: T[]): T[] => rows
    .map((row) => ({ ...row, sourceIds: row.sourceIds.filter((id) => sourceById.has(id)) }))
    .filter((row) => row.sourceIds.length > 0);
  return {
    ...previous, sources, topics: retain([topic]), gaps: retain(previous.gaps), routes: retain(previous.routes),
    comparisons: previous.comparisons.map((group) => ({ ...group, rows: group.rows.filter((row) =>
      sourceById.get(row.sourceId)?.revisionId === row.revisionId) }))
      .filter((group) => new Set(group.rows.map((row) => row.sourceId)).size >= 2),
  };
}

export async function readRetainedWiki(env: Env, projectId: string, revisionId: string): Promise<RetainedWiki | null> {
  interface Operation { pageId: string; calls: number; inputsKey: string | null; inputsJson: string }
  const operation = (id: string) => env.DB.prepare(`SELECT r.page_id AS pageId,r.model_calls AS calls,
    r.generation_payload_key AS inputsKey,r.inputs_json AS inputsJson FROM page_revision r JOIN page p ON p.id=r.page_id
    WHERE r.id=? AND p.project_id=? AND p.kind='wiki' AND r.origin='job'`)
    .bind(id, projectId).first<Operation>();
  const json = async (key: string): Promise<unknown> => {
    const object = await env.BUCKET.get(key);
    if (!object) return null;
    try { return await object.json<unknown>(); } catch { return null; }
  };
  const snapshot = async (id: string, row: Operation): Promise<KnowledgeInputs | null> => {
    if (row.inputsKey !== `page/${id}/inputs.json`) return null;
    const value = await json(row.inputsKey);
    if (!isRecord(value) || value.kind !== "wiki" || typeof value.topicId !== "string"
      || !Array.isArray(value.sources) || value.sources.length === 0 || !isKnowledgeData(value.previous)
      || !isStringArray(value.changed) || (value.checkedFrom !== undefined && typeof value.checkedFrom !== "string")) return null;
    if (!value.sources.every((source) => isRecord(source) && typeof source.sourceId === "string"
      && typeof source.revisionId === "string" && typeof source.title === "string"
      && (source.guide === null || typeof source.guide === "string") && Array.isArray(source.claims)
      && source.claims.every((claim) => isComparisonClaim(claim)
        && claim.sourceId === source.sourceId && claim.revisionId === source.revisionId))) return null;
    const sources = value.sources as KnowledgeSource[];
    const revisions = inputRevisionIds(sources.map((source) => source.revisionId));
    let saved: unknown;
    try { saved = JSON.parse(row.inputsJson); } catch { return null; }
    const expected = inputRevisionIds(saved);
    if (!revisions || !expected || !sameRevisionIds(revisions, expected)) return null;
    return value as unknown as KnowledgeInputs;
  };

  const selected = await operation(revisionId);
  if (!selected) return null; // Scope before any R2 reads, including checkedFrom.
  const selectedInputs = await snapshot(revisionId, selected);
  if (!selectedInputs) return null;
  let originalRevisionId = revisionId, original = selected, inputs = selectedInputs;
  if (inputs.checkedFrom !== undefined) {
    const from = inputs.checkedFrom;
    if (!from || from === revisionId || /[/\\]/.test(from)) return null;
    const linked = await operation(from);
    if (!linked || linked.pageId !== selected.pageId) return null;
    const linkedInputs = await snapshot(from, linked);
    if (!linkedInputs || linkedInputs.checkedFrom !== undefined) return null; // Never traverse a recheck chain.
    originalRevisionId = from; original = linked; inputs = linkedInputs;
  }
  if (original.calls <= 0 || !inputs.wikiEvidence?.length) return null;
  const sources = new Map(inputs.sources.map((source) => [source.sourceId, source]));
  const revisions = new Set(inputs.sources.map((source) => source.revisionId));
  if (!Array.isArray(inputs.wikiEvidence) || !inputs.wikiEvidence.every((item) => isRecord(item)
    && typeof item.quote === "string" && item.quote.trim().length > 0 && validCitation(item.citation, sources, revisions)
    && new TextEncoder().encode(item.quote).byteLength === item.citation.end - item.citation.start)) return null;
  const labels = inputs.wikiEvidence.map((item) => item.citation.label);
  if (new Set(labels).size !== labels.length) return null;
  try { wikiData(inputs); } catch { return null; }
  const parsed = wikiSchema(inputs.wikiEvidence).safeParse(await json(`page/${originalRevisionId}/call-1.json`));
  if (!parsed.success) return null;
  const checked = checkWikiOutput(parsed.data, inputs.wikiEvidence, inputs.sources.map((source) => source.sourceId));
  return checked.kept > 0 ? { pageId: selected.pageId, originalRevisionId, inputs, checked } : null;
}

async function putKnowledgeObject(env: Env, key: string, body: string, contentType: string): Promise<void> {
  const bytes = new TextEncoder().encode(body);
  const saved = await env.BUCKET.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType },
  });
  if (saved) return;
  const existing = await env.BUCKET.get(key);
  if (!existing) throw new Error("The immutable knowledge object could not be confirmed after a conditional write.");
  const existingBytes = new Uint8Array(await existing.arrayBuffer());
  if (existingBytes.length !== bytes.length || existingBytes.some((byte, index) => byte !== bytes[index])) {
    throw new Error("A different immutable knowledge object already exists; it was not overwritten.");
  }
}

async function storedPageOrNull(env: Env, actor: Actor | null, projectId: string, pageId: string): Promise<SavedPage | null> {
  const row = await env.DB.prepare(`SELECT p.head_revision_id AS headRevisionId,r.status
    FROM page p LEFT JOIN page_revision r ON r.id=p.head_revision_id
    WHERE p.id=? AND p.project_id=?`).bind(pageId, projectId)
    .first<{ headRevisionId: string | null; status: string | null }>();
  if (!row) throw new LibraryError("not_found", "Knowledge page not found.", 404);
  if (!row.headRevisionId) return null;
  if (row.status !== "accepted") throw new LibraryError("unavailable", "The current knowledge page revision is not accepted.", 503);
  return getPage(env, actor, { projectId, pageId });
}

export async function getProjectKnowledge(env: Env, actor: Actor | null, input: { projectId: string; operationId?: string | undefined }): Promise<KnowledgeView> {
  const project = await env.DB.prepare(`SELECT knowledge_page_id AS pageId,
    knowledge_active_revision_id AS activeRevisionId FROM project WHERE id=?`)
    .bind(input.projectId).first<{ pageId: string | null; activeRevisionId: string | null }>();
  if (!project) throw new LibraryError("not_found", "Project not found.", 404);

  let state: KnowledgeView["state"] = "none";
  let error: string | null = null;
  let operation: KnowledgeView["operation"] = null;
  let usage: KnowledgeView["usage"] = null;
  const operationId = input.operationId ?? project.activeRevisionId;
  if (operationId) {
    const active = await env.DB.prepare(`SELECT r.page_id AS pageId,p.kind AS kind,r.generation_state AS state,
      r.generation_error AS error,r.model_calls AS calls,r.model_input_tokens AS inputTokens,
      r.model_output_tokens AS outputTokens,r.model_estimated_cost_microusd AS estimatedCostMicrousd
      FROM page_revision r JOIN page p ON p.id=r.page_id
      WHERE r.id=? AND p.project_id=?`)
      .bind(operationId, input.projectId)
      .first<{ pageId: string; kind: string; state: string; error: string | null; calls: number; inputTokens: number | null; outputTokens: number | null; estimatedCostMicrousd: number | null }>();
    if (!active) throw new LibraryError(input.operationId ? "not_found" : "unavailable",
      input.operationId ? "Project knowledge operation not found in this project." : "The active project knowledge revision is missing.", input.operationId ? 404 : 503);
    if (!["none", "running", "paused", "done", "failed"].includes(active.state)) {
      throw new LibraryError("unavailable", "The active project knowledge state is invalid.", 503);
    }
    if (active.kind !== "map" && active.kind !== "wiki") {
      throw new LibraryError("unavailable", "The active project knowledge kind is invalid.", 503);
    }
    state = active.state as KnowledgeView["state"];
    error = active.error;
    operation = { revisionId: operationId, pageId: active.pageId, kind: active.kind };
    usage = { calls: active.calls, inputTokens: active.inputTokens, outputTokens: active.outputTokens,
      estimatedCostMicrousd: active.estimatedCostMicrousd };
  }

  let page: SavedPage | null = null;
  let data: KnowledgeData | null = null;
  if (project.pageId) {
    page = await storedPageOrNull(env, actor, input.projectId, project.pageId);
    if (page) {
      const object = await env.BUCKET.get(`page/${page.headRevisionId}/data.json`);
      if (!object) throw new LibraryError("unavailable", "The current project knowledge data is missing from storage.", 503);
      let stored: unknown;
      try { stored = await object.json<unknown>(); }
      catch { throw new LibraryError("unavailable", "The current project knowledge data is invalid.", 503); }
      if (!isKnowledgeData(stored)) throw new LibraryError("unavailable", "The current project knowledge data is invalid.", 503);
      data = stored;
    }
  }
  const canRecheckWiki = operation?.kind === "wiki" && (state === "done" || state === "failed")
    && await readRetainedWiki(env, input.projectId, operation.revisionId) !== null;
  return { state, error, operation, page, data, usage, canRecheckWiki };
}

async function currentInputsMatch(env: Env, projectId: string, kind: "map" | "wiki", inputs: string[]): Promise<boolean> {
  const current = await currentKnowledgeSources(env, projectId);
  const currentIds = new Set(current.map((source) => source.revisionId));
  if (inputs.some((id) => !currentIds.has(id))) return false;
  return kind === "wiki" || (currentIds.size === inputs.length && current.every((source) => inputs.includes(source.revisionId)));
}

async function markKnowledgeStale(env: Env, input: { projectId: string; pageId: string; revisionId: string; inputsJson: string; inputJson: string; kind: "map" | "wiki" }): Promise<boolean> {
  const mismatch = sourceSetMismatchSql(input.kind);
  const mismatchBinds = input.kind === "map" ? [input.inputJson, input.inputJson] : [input.inputJson];
  const changedAt = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE page_revision SET generation_state='failed',generation_error=?
      WHERE id=? AND page_id=? AND generation_state='running' AND inputs_json=?
        AND EXISTS(SELECT 1 FROM project p WHERE p.id=? AND p.knowledge_active_revision_id=page_revision.id
          AND (?='wiki' OR p.knowledge_page_id=? ) AND (${mismatch}))`)
      .bind(STALE_ERROR, input.revisionId, input.pageId, input.inputsJson, input.projectId, input.kind, input.pageId, ...mismatchBinds),
    env.DB.prepare(`UPDATE page SET freshness='stale',updated_at=?
      WHERE id=? AND project_id=? AND EXISTS(SELECT 1 FROM page_revision r
        WHERE r.id=? AND r.page_id=page.id AND r.generation_state='failed' AND r.generation_error=?)`)
      .bind(changedAt, input.pageId, input.projectId, input.revisionId, STALE_ERROR),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}

export async function storeKnowledgeRevision(env: Env, actor: Actor | null, input: {
  projectId: string;
  pageId: string;
  revisionId: string;
  data: KnowledgeData;
  inputs: string[];
  title: string;
  kind: "map" | "wiki";
  body?: string;
  citations?: Citation[];
  reviewWarning?: string;
}): Promise<{ accepted: boolean; stale: boolean; page: SavedPage | null }> {
  const title = input.title.trim();
  if (!input.projectId || !input.pageId || !input.revisionId || !title || title.length > 200
    || (input.kind !== "map" && input.kind !== "wiki") || !isKnowledgeData(input.data)) {
    throw new LibraryError("invalid", "Project knowledge data is invalid.", 400);
  }
  const normalizedInputs = inputRevisionIds(input.inputs);
  if (!normalizedInputs) throw new LibraryError("invalid", "Project knowledge inputs are invalid.", 400);
  const inputJson = JSON.stringify(normalizedInputs);
  const row = await env.DB.prepare(`SELECT p.knowledge_page_id AS knowledgePageId,
    p.knowledge_active_revision_id AS activeRevisionId,r.page_id AS revisionPageId,
    r.generation_state AS generationState,r.inputs_json AS inputsJson
    FROM project p LEFT JOIN page_revision r ON r.id=? WHERE p.id=?`)
    .bind(input.revisionId, input.projectId)
    .first<{ knowledgePageId: string | null; activeRevisionId: string | null; revisionPageId: string | null; generationState: string | null; inputsJson: string | null }>();
  if (!row) throw new LibraryError("not_found", "Project not found.", 404);
  if (row.activeRevisionId !== input.revisionId || row.revisionPageId !== input.pageId || row.generationState !== "running"
    || (input.kind === "map" && row.knowledgePageId !== input.pageId)) {
    throw new LibraryError("conflict", "This project knowledge revision is no longer active.", 409);
  }
  if (!row.inputsJson) throw new LibraryError("unavailable", "The project knowledge input snapshot is missing.", 503);
  const savedInputs = (() => {
    try { return inputRevisionIds(JSON.parse(row.inputsJson as string) as unknown); }
    catch { return null; }
  })();
  if (!savedInputs || !sameRevisionIds(savedInputs, normalizedInputs)) {
    throw new LibraryError("conflict", "The project knowledge input snapshot does not match this result.", 409);
  }
  const dataRevisions = inputRevisionIds(input.data.sources.map((source) => source.revisionId));
  if (!dataRevisions || !sameRevisionIds(dataRevisions, normalizedInputs)) {
    throw new LibraryError("invalid", "Project knowledge data must match its input revision scope.", 400);
  }
  const page = await env.DB.prepare("SELECT id FROM page WHERE id=? AND project_id=?")
    .bind(input.pageId, input.projectId).first<{ id: string }>();
  if (!page) throw new LibraryError("not_found", "Knowledge page not found.", 404);

  const rendered = renderKnowledge(input.data);
  const body = input.body ?? rendered.body;
  const citations = input.citations ?? rendered.citations;
  if (body.length > MAX_PAGE_BODY_CHARS || !body.trim() || !Array.isArray(citations)) {
    throw new LibraryError("invalid", "Project knowledge page content is invalid.", 400);
  }
  const sources = new Map(input.data.sources.map((source) => [source.sourceId, source]));
  const citationLabels = new Set<string>();
  for (const citation of citations) {
    if (!validCitation(citation, sources, new Set(normalizedInputs))) {
      throw new LibraryError("invalid", "Project knowledge citations must resolve to an input source quote.", 400);
    }
    if (citationLabels.has(citation.label)) throw new LibraryError("invalid", "Project knowledge citations contain a duplicate persistent reference.", 400);
    citationLabels.add(citation.label);
  }

  const staleInput = { projectId: input.projectId, pageId: input.pageId, revisionId: input.revisionId,
    inputsJson: row.inputsJson, inputJson, kind: input.kind };
  if (!await currentInputsMatch(env, input.projectId, input.kind, normalizedInputs)) {
    const stale = await markKnowledgeStale(env, staleInput);
    return { accepted: false, stale, page: stale ? await storedPageOrNull(env, actor, input.projectId, input.pageId) : null };
  }

  const bodyKey = `page/${input.revisionId}/body.md`;
  const citationsKey = `page/${input.revisionId}/citations.json`;
  const dataKey = `page/${input.revisionId}/data.json`;
  try {
    await Promise.all([
      putKnowledgeObject(env, bodyKey, body, "text/markdown; charset=utf-8"),
      putKnowledgeObject(env, citationsKey, JSON.stringify(citations), "application/json; charset=utf-8"),
      putKnowledgeObject(env, dataKey, JSON.stringify(input.data), "application/json; charset=utf-8"),
    ]);
  } catch {
    throw new LibraryError("unavailable", "Project knowledge could not be stored. The previous page remains available.", 503);
  }

  const matches = sourceSetMatchesSql(input.kind);
  const matchBinds = input.kind === "map" ? [inputJson, inputJson] : [inputJson];
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE page_revision SET body_key=?,citations_key=?,status='accepted',
      generation_state='done',generation_error=? WHERE id=? AND page_id=? AND inputs_json=? AND generation_state='running'
      AND EXISTS(SELECT 1 FROM project p JOIN page pg ON pg.id=? AND pg.project_id=p.id
        WHERE p.id=? AND p.knowledge_active_revision_id=page_revision.id
          AND (?='wiki' OR p.knowledge_page_id=pg.id) AND (${matches}))`)
      .bind(bodyKey, citationsKey, input.reviewWarning ?? null, input.revisionId, input.pageId, row.inputsJson,
        input.pageId, input.projectId, input.kind, ...matchBinds),
    env.DB.prepare(`UPDATE page SET title=?,kind=?,head_revision_id=?,freshness='current',updated_at=?
      WHERE id=? AND project_id=? AND EXISTS(SELECT 1 FROM project p WHERE p.id=?
        AND p.knowledge_active_revision_id=? AND (?='wiki' OR p.knowledge_page_id=page.id))
        AND EXISTS(SELECT 1 FROM page_revision r WHERE r.id=? AND r.page_id=page.id
          AND r.status='accepted' AND r.generation_state='done')`)
      .bind(title, input.kind, input.revisionId, now, input.pageId, input.projectId,
        input.projectId, input.revisionId, input.kind, input.revisionId),
  ]);
  const revisionChanged = (results[0]?.meta.changes ?? 0) === 1;
  const pageChanged = (results[1]?.meta.changes ?? 0) === 1;
  if (revisionChanged && pageChanged) {
    return { accepted: true, stale: false, page: await getPage(env, actor, { projectId: input.projectId, pageId: input.pageId }) };
  }
  if (!revisionChanged) {
    const stale = await markKnowledgeStale(env, staleInput);
    return { accepted: false, stale, page: stale ? await storedPageOrNull(env, actor, input.projectId, input.pageId) : null };
  }
  throw new LibraryError("unavailable", "Project knowledge could not advance its accepted page head.", 503);
}
