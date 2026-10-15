import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";

export const PROJECT_SEARCH_GENERATION = "v1" as const;
export const PROJECT_SEARCH_INSTANCES = Object.freeze({
  prose: "private-prose-g2",
  literal: "private-literal-g2",
} as const);

export type ProjectSearchLane = keyof typeof PROJECT_SEARCH_INSTANCES;

const MAX_PROJECT_SOURCES = 256;
const MAX_ITEMS_PER_SOURCE = 1024;
const MAX_PROVIDER_KEY_BYTES = 128;
const MAX_QUERY_CHARS = 100_000;
const UPLOAD_BATCH_SIZE = 4;
const PROJECT_FOLDER_HASH_CHARS = 32;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const ITEM_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;

export type ProjectSearchErrorCode =
  | "PROJECT_SEARCH_INPUT_INVALID"
  | "PROJECT_SEARCH_MEMBERSHIP_STALE"
  | "PROJECT_SEARCH_SOURCE_NOT_READY"
  | "PROJECT_SEARCH_STORAGE_UNAVAILABLE"
  | "PROJECT_SEARCH_PROVIDER_RESPONSE_INVALID";

export class ProjectSearchError extends Error {
  public readonly code: ProjectSearchErrorCode;

  public constructor(code: ProjectSearchErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProjectSearchError";
    this.code = code;
  }
}

interface ProjectSourceRow {
  readonly source_id: unknown;
  readonly source_revision_ref: unknown;
}

interface ProjectionItemRow {
  readonly item_key: unknown;
  readonly source_revision_ref: unknown;
  readonly title: unknown;
  readonly document_context_header: unknown;
  readonly section_text: unknown;
}

export interface ProjectSearchBindings {
  readonly namespace: AiSearchNamespaceLike;
  readonly core_database: D1Database;
  readonly search_database: D1Database;
  readonly work_bucket: R2Bucket;
}

function fail(code: ProjectSearchErrorCode, message: string): never {
  throw new ProjectSearchError(code, message);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("PROJECT_SEARCH_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") fail("PROJECT_SEARCH_STORAGE_UNAVAILABLE", `${label} is invalid`);
  return value;
}

async function projectFolderId(projectId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(projectId));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")
    .slice(0, PROJECT_FOLDER_HASH_CHARS);
}

export async function projectSearchFolderPrefix(
  projectIdInput: string,
  lane: ProjectSearchLane,
): Promise<string> {
  const projectId = identifier(projectIdInput, "project_id");
  const instance = PROJECT_SEARCH_INSTANCES[lane];
  if (instance === undefined) fail("PROJECT_SEARCH_INPUT_INVALID", "search lane is invalid");
  return `projection/${PROJECT_SEARCH_GENERATION}/${instance}/${await projectFolderId(projectId)}/`;
}

async function providerKey(
  projectId: string,
  lane: ProjectSearchLane,
  itemKeyInput: unknown,
): Promise<string> {
  if (typeof itemKeyInput !== "string" || !ITEM_KEY.test(itemKeyInput)) {
    fail("PROJECT_SEARCH_STORAGE_UNAVAILABLE", "projection item key is invalid");
  }
  const key = `${await projectSearchFolderPrefix(projectId, lane)}${itemKeyInput}.md`;
  if (new TextEncoder().encode(key).byteLength > MAX_PROVIDER_KEY_BYTES) {
    fail("PROJECT_SEARCH_STORAGE_UNAVAILABLE", "project item key exceeds Cloudflare AI Search's 128-byte limit");
  }
  return key;
}

async function currentProjectRevision(
  database: D1Database,
  projectId: string,
  sourceRevisionRef: string,
  observedAt: string,
): Promise<boolean> {
  const row = await database.prepare(
    "SELECT 1 AS current FROM project_source_membership m " +
    "JOIN project p ON p.project_id=m.project_id " +
    "JOIN source s ON s.source_id=m.source_id AND s.head_rev=?2 " +
    "JOIN source_revision r ON r.source_id=s.source_id AND r.source_revision_ref=?2 " +
    "WHERE m.project_id=?1 AND julianday(m.valid_from)<=julianday(?3) " +
    "AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday(?3)) " +
    "AND r.purge_state='LIVE' LIMIT 1",
  ).bind(projectId, sourceRevisionRef, observedAt).first<{ current: number }>();
  return row?.current === 1;
}

async function projectSources(
  database: D1Database,
  projectId: string,
  sourceIds: readonly string[],
): Promise<readonly { readonly source_id: string; readonly source_revision_ref: string }[]> {
  const observedAt = new Date().toISOString();
  const result = await database.prepare(
    "SELECT s.source_id,s.head_rev AS source_revision_ref FROM project_source_membership m " +
    "JOIN project p ON p.project_id=m.project_id " +
    "JOIN source s ON s.source_id=m.source_id " +
    "JOIN source_revision r ON r.source_id=s.source_id AND r.source_revision_ref=s.head_rev " +
    "WHERE m.project_id=?1 AND m.source_id IN (SELECT value FROM json_each(?2)) " +
    "AND julianday(m.valid_from)<=julianday(?3) " +
    "AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday(?3)) " +
    "AND r.purge_state='LIVE' ORDER BY s.source_id LIMIT ?4",
  ).bind(projectId, JSON.stringify(sourceIds), observedAt, sourceIds.length + 1)
    .all<ProjectSourceRow>();
  if (!result.success || !Array.isArray(result.results)) {
    fail("PROJECT_SEARCH_STORAGE_UNAVAILABLE", "current project sources are unavailable");
  }
  const rows = result.results.map((row) => ({
    source_id: identifier(row.source_id, "stored source_id"),
    source_revision_ref: identifier(row.source_revision_ref, "stored source_revision_ref"),
  }));
  if (rows.length !== sourceIds.length || new Set(rows.map((row) => row.source_id)).size !== rows.length) {
    fail("PROJECT_SEARCH_MEMBERSHIP_STALE", "one or more sources are no longer current project members");
  }
  return Object.freeze(rows);
}

async function projectionItems(
  database: D1Database,
  sourceRevisionRef: string,
): Promise<readonly {
  readonly item_key: string;
  readonly source_revision_ref: string;
  readonly document: string;
}[]> {
  const result = await database.prepare(
    "SELECT item_key,source_revision_ref,title,document_context_header,section_text " +
    "FROM projection_item WHERE source_revision_ref=?1 AND active=1 ORDER BY item_key LIMIT ?2",
  ).bind(sourceRevisionRef, MAX_ITEMS_PER_SOURCE + 1).all<ProjectionItemRow>();
  if (!result.success || !Array.isArray(result.results)) {
    fail("PROJECT_SEARCH_STORAGE_UNAVAILABLE", "D1 Search projection items are unavailable");
  }
  if (result.results.length === 0) {
    fail("PROJECT_SEARCH_SOURCE_NOT_READY", "the admitted source has no active section projection in D1 Search");
  }
  if (result.results.length > MAX_ITEMS_PER_SOURCE) {
    fail("PROJECT_SEARCH_STORAGE_UNAVAILABLE", "source exceeds the StructuralProjector item limit");
  }
  return Object.freeze(result.results.map((row) => {
    const itemKey = stringValue(row.item_key, "projection item key");
    if (!ITEM_KEY.test(itemKey) || row.source_revision_ref !== sourceRevisionRef) {
      fail("PROJECT_SEARCH_STORAGE_UNAVAILABLE", "D1 Search projection identity is inconsistent");
    }
    const title = stringValue(row.title, "projection title");
    const context = stringValue(row.document_context_header, "projection context");
    const section = stringValue(row.section_text, "projection section");
    if (section.length === 0) fail("PROJECT_SEARCH_STORAGE_UNAVAILABLE", "projection section is empty");
    return Object.freeze({
      item_key: itemKey,
      source_revision_ref: sourceRevisionRef,
      document: `${context || title}\n\n${section}`,
    });
  }));
}

async function uploadOne(
  input: ProjectSearchBindings,
  projectId: string,
  lane: ProjectSearchLane,
  item: { readonly item_key: string; readonly document: string },
): Promise<void> {
  const key = await providerKey(projectId, lane, item.item_key);
  await input.work_bucket.put(key, item.document, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });
  await input.namespace.get(PROJECT_SEARCH_INSTANCES[lane]).items.uploadAndPoll(
    key,
    new Blob([item.document], { type: "text/markdown" }),
  );
}

/** Uploads the existing section-level D1 projection to Cloudflare's shared built-in indexes. */
export async function indexProjectSources(input: ProjectSearchBindings & {
  readonly project_id: string;
  readonly source_ids: readonly string[];
}): Promise<number> {
  const projectId = identifier(input.project_id, "project_id");
  if (!Array.isArray(input.source_ids) || input.source_ids.length > MAX_PROJECT_SOURCES ||
      new Set(input.source_ids).size !== input.source_ids.length) {
    fail("PROJECT_SEARCH_INPUT_INVALID", "source_ids must be a unique bounded list");
  }
  const sourceIds = input.source_ids.map((id) => identifier(id, "source_id"));
  if (sourceIds.length === 0) return 0;
  const sources = await projectSources(input.core_database, projectId, sourceIds);
  let uploadedItems = 0;
  for (const source of sources) {
    const items = await projectionItems(input.search_database, source.source_revision_ref);
    const observedAt = new Date().toISOString();
    if (!await currentProjectRevision(input.core_database, projectId, source.source_revision_ref, observedAt)) {
      fail("PROJECT_SEARCH_MEMBERSHIP_STALE", "project membership changed before AI Search upload");
    }
    for (let offset = 0; offset < items.length; offset += UPLOAD_BATCH_SIZE) {
      const batch = items.slice(offset, offset + UPLOAD_BATCH_SIZE);
      await Promise.all(batch.flatMap((item) => ([
        uploadOne(input, projectId, "prose", item),
        uploadOne(input, projectId, "literal", item),
      ])));
    }
    if (!await currentProjectRevision(input.core_database, projectId, source.source_revision_ref, new Date().toISOString())) {
      fail("PROJECT_SEARCH_MEMBERSHIP_STALE", "project membership changed during AI Search upload");
    }
    uploadedItems += items.length;
  }
  return uploadedItems;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function sourceRevisionForItem(
  database: D1Database,
  itemKey: string,
): Promise<string | null> {
  const result = await database.prepare(
    "SELECT source_revision_ref FROM projection_item WHERE item_key=?1 AND active=1 LIMIT 2",
  ).bind(itemKey).all<{ source_revision_ref: unknown }>();
  if (!result.success || !Array.isArray(result.results) || result.results.length > 1) {
    fail("PROJECT_SEARCH_STORAGE_UNAVAILABLE", "D1 Search item mapping is unavailable or ambiguous");
  }
  const source = result.results[0]?.source_revision_ref;
  return source === undefined ? null : identifier(source, "stored source_revision_ref");
}

/** Native AI Search with a mandatory Cloudflare folder filter and live D1 membership readback. */
export async function searchProject(
  input: Pick<ProjectSearchBindings, "namespace" | "core_database" | "search_database"> & {
    readonly project_id: string;
    readonly lane: ProjectSearchLane;
    readonly query: string;
  },
): Promise<unknown> {
  const projectId = identifier(input.project_id, "project_id");
  if (typeof input.query !== "string" || input.query.trim().length === 0 || input.query.length > MAX_QUERY_CHARS) {
    fail("PROJECT_SEARCH_INPUT_INVALID", "query is empty or exceeds its byte bound");
  }
  const folder = await projectSearchFolderPrefix(projectId, input.lane);
  const folderEnd = `${folder.slice(0, -1)}0`;
  const raw = await input.namespace.get(PROJECT_SEARCH_INSTANCES[input.lane]).search({
    messages: [{ role: "user", content: input.query }],
    ai_search_options: { retrieval: { filters: { folder: { $gte: folder, $lt: folderEnd } } } },
  });
  const response = record(raw);
  if (response === null || !Array.isArray(response.chunks) || response.chunks.length > 50) {
    fail("PROJECT_SEARCH_PROVIDER_RESPONSE_INVALID", "AI Search returned an invalid chunk list");
  }
  const chunks: unknown[] = [];
  for (const rawChunk of response.chunks) {
    const chunk = record(rawChunk);
    const item = chunk === null ? null : record(chunk.item);
    const key = item?.key;
    if (typeof key !== "string" || !key.startsWith(folder) || !key.endsWith(".md")) continue;
    const itemKey = key.slice(folder.length, -3);
    if (!ITEM_KEY.test(itemKey)) continue;
    const sourceRevisionRef = await sourceRevisionForItem(input.search_database, itemKey);
    if (sourceRevisionRef === null) continue;
    if (await currentProjectRevision(input.core_database, projectId, sourceRevisionRef, new Date().toISOString())) {
      chunks.push(rawChunk);
    }
  }
  return { ...response, chunks };
}
