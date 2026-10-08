import { ChannelReadinessSchema, IsoDateTimeSchema, ReadinessChannelSchema,
  SourceCurrentnessSchema, SourceRevisionSchema, type ChannelReadiness } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, SourceRevisionsRequest, SourceRevisionsResult } from "@eliotr/interfaces";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { catalogEligibility } from "./catalog-queries.js";
import { beginCatalogRead, CatalogInputError, decodeCatalogCursor, encodeCatalogCursor, validateRequestIdentifier } from "./catalog-service.js";

const CHANNELS = ReadinessChannelSchema.options;
const PAGE_LIMIT = 10;
interface Cursor {
  version: 1; source_id: string; context_sha256: string; authority_generation: number;
  expires_at: number; admitted_at: string; revision_after: string;
}
interface RevisionRow {
  source_revision_ref: unknown; content_sha256: unknown; captured_at: unknown; admitted_at: unknown;
  quality_state: unknown; currentness_state: unknown;
}
interface ReadinessRow {
  source_revision_ref: unknown; channel: unknown; state: unknown; generation: unknown;
  reason_codes_json: unknown; receipt_ref: unknown; updated_at: unknown;
}
function invalid(): never {
  throw new CatalogInputError("SOURCE_REVISIONS_AUTHORITY_INVALID", "Stored revision metadata is invalid", 503);
}
function date(raw: unknown): string {
  const parsed = IsoDateTimeSchema.safeParse(raw);
  if (!parsed.success || parsed.data.length > 64 || !Number.isFinite(Date.parse(parsed.data))) invalid();
  return parsed.data;
}
function id(raw: unknown): string {
  try { return validateRequestIdentifier(raw, "revision metadata"); } catch { invalid(); }
}
function cursor(raw: string | undefined, sourceId: string): Cursor | null {
  if (raw === undefined) return null;
  const value = decodeCatalogCursor(raw);
  const fields = ["version", "source_id", "context_sha256", "authority_generation", "expires_at", "admitted_at", "revision_after"];
  const fail = (): never => { throw new CatalogInputError("SOURCE_REVISIONS_CURSOR_INVALID", "Revision cursor is invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      fields.some((key) => !Object.hasOwn(value, key))) fail();
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || row.source_id !== sourceId || typeof row.context_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(row.context_sha256) || !Number.isSafeInteger(row.authority_generation) ||
      Number(row.authority_generation) < 1 || !Number.isSafeInteger(row.expires_at) || Number(row.expires_at) < 1) fail();
  try { date(row.admitted_at); id(row.revision_after); } catch { fail(); }
  return { version: 1, source_id: sourceId, context_sha256: String(row.context_sha256),
    authority_generation: Number(row.authority_generation), expires_at: Number(row.expires_at),
    admitted_at: String(row.admitted_at), revision_after: String(row.revision_after) };
}
const bounded = (column: string, maximum: number) => `CASE WHEN length(CAST(${column} AS BLOB))<=${maximum} THEN ${column} ELSE NULL END`;
const pageQuery = `${catalogEligibility(true)}, revision_page AS (
 SELECT ${bounded("r.source_revision_ref", 256)} AS source_revision_ref,
   ${bounded("r.content_sha256", 64)} AS content_sha256,
   ${bounded("r.captured_at", 64)} AS captured_at, ${bounded("r.admitted_at", 64)} AS admitted_at,
   r.quality_state, r.currentness_state
 FROM eligible e JOIN source_revision r ON r.source_revision_ref=e.source_revision_ref
 WHERE e.source_id=?3 AND (?4 IS NULL OR julianday(r.admitted_at)<julianday(?4)
   OR (julianday(r.admitted_at)=julianday(?4) AND r.source_revision_ref<?5))
 ORDER BY julianday(r.admitted_at) DESC, r.source_revision_ref DESC LIMIT ?6
)`;
function decodeReadiness(row: ReadinessRow): ChannelReadiness {
  if (typeof row.reason_codes_json !== "string") invalid();
  let reasons: unknown;
  try { reasons = JSON.parse(row.reason_codes_json); } catch { invalid(); }
  if (!Array.isArray(reasons) || reasons.length > 16 || new Set(reasons).size !== reasons.length ||
      canonicalEvidenceJson(reasons) !== row.reason_codes_json) invalid();
  const result = ChannelReadinessSchema.safeParse({ source_revision_ref: id(row.source_revision_ref),
    channel: row.channel, state: row.state, observed_at: date(row.updated_at), reason_codes: reasons.map(id),
    ...(row.generation === null ? {} : { generation: id(row.generation) }),
    ...(row.receipt_ref === null ? {} : { receipt_ref: id(row.receipt_ref) }) });
  if (!result.success) invalid();
  return result.data;
}

/** Read-only owner UI history. Recorded readiness is NOT an active-index/evidence assessment.
 * Missing channel rows are absent, not invented as ready or not_requested. Ordinary D1 reads use
 * the primary; no replica session, remote provider probe or grant is introduced here.
 */
export async function readSourceRevisions(database: D1Database, context: AuthenticatedRequestContext,
  request: SourceRevisionsRequest, deployment: string, now: () => number = Date.now): Promise<SourceRevisionsResult> {
  const sourceId = validateRequestIdentifier(request.source_id, "source_id");
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > PAGE_LIMIT) {
    throw new CatalogInputError("SOURCE_REVISIONS_LIMIT_INVALID", "Revision limit must be in [1, 10]");
  }
  const after = cursor(request.cursor, sourceId);
  const fence = await beginCatalogRead(database, context, deployment, now);
  if (after && after.context_sha256 !== fence.identity) {
    throw new CatalogInputError("SOURCE_REVISIONS_CURSOR_CONTEXT", "Revision cursor belongs to another session", 403);
  }
  if (after && (after.authority_generation !== fence.generation || after.expires_at <= fence.started ||
      after.expires_at > fence.started + 300_000)) {
    throw new CatalogInputError("SOURCE_REVISIONS_CURSOR_STALE", "Library changed; refresh revisions", 409, true);
  }
  await fence.authority.requireReadPolicy();
  const observed = new Date(fence.started).toISOString();
  const headRow = await database.prepare(`${catalogEligibility()} SELECT ${bounded("head_rev", 256)} AS head_rev
    FROM eligible WHERE source_id=?3 LIMIT 1`).bind(context.principal_ref, observed, sourceId).first<{ head_rev: unknown }>();
  if (!headRow) throw new CatalogInputError("LIBRARY_SOURCE_NOT_FOUND", "Readable source not found", 404);
  const head = id(headRow.head_rev);
  const bindings = [context.principal_ref, observed, sourceId, after?.admitted_at ?? null,
    after?.revision_after ?? "", request.limit + 1];
  // Both SELECTs share one transactional D1 batch. The primary authority epoch/time fence guards
  // access across subsequent digest verification, but does not turn recorded readiness into a probe.
  const results = await database.batch<RevisionRow | ReadinessRow>([
    database.prepare(`${pageQuery} SELECT * FROM revision_page ORDER BY julianday(admitted_at) DESC, source_revision_ref DESC`).bind(...bindings),
    database.prepare(`${pageQuery} SELECT x.source_revision_ref,x.channel,x.state,
      ${bounded("x.generation", 256)} AS generation,
      CASE WHEN x.generation IS NOT NULL AND length(CAST(x.generation AS BLOB))>256 THEN NULL
        WHEN x.receipt_ref IS NOT NULL AND length(CAST(x.receipt_ref AS BLOB))>256 THEN NULL
        ELSE ${bounded("x.reason_codes_json", 1024)} END AS reason_codes_json,
      ${bounded("x.receipt_ref", 256)} AS receipt_ref, ${bounded("x.updated_at", 64)} AS updated_at
      FROM source_readiness x JOIN revision_page p ON p.source_revision_ref=x.source_revision_ref
      ORDER BY x.source_revision_ref,x.channel LIMIT 111`).bind(...bindings),
  ]);
  const [rows, readiness] = results;
  if (results.length !== 2 || !rows?.success || !readiness?.success || !Array.isArray(rows.results) ||
      !Array.isArray(readiness.results) || rows.results.length > request.limit + 1 || readiness.results.length > 110) {
    throw new CatalogInputError("SOURCE_REVISIONS_READ_FAILED", "Revision read failed", 503, true);
  }
  const revisions = rows.results as RevisionRow[];
  const refs = revisions.map((row) => id(row.source_revision_ref));
  if (new Set(refs).size !== refs.length) invalid();
  const sources = await fence.authority.sources([...new Set([head, ...refs])]);
  const byRef = new Map(sources.map((value) => [value.revision.source_revision_ref, value.revision]));
  if (byRef.get(head)?.source_id !== sourceId) invalid();
  const byRevision = new Map(refs.map((ref) => [ref, new Map<string, ChannelReadiness>()]));
  for (const raw of readiness.results as ReadinessRow[]) {
    const value = decodeReadiness(raw); const channels = byRevision.get(value.source_revision_ref);
    if (!channels || channels.has(value.channel)) invalid();
    channels.set(value.channel, value);
  }
  const decoded = revisions.map((row) => {
    const ref = id(row.source_revision_ref); const authoritative = byRef.get(ref);
    if (!authoritative || authoritative.source_id !== sourceId || row.content_sha256 !== authoritative.content_sha256 ||
        row.captured_at !== authoritative.captured_at || row.quality_state !== authoritative.quality_state) invalid();
    const quality = SourceRevisionSchema.shape.quality_state.safeParse(row.quality_state);
    const currentness = SourceCurrentnessSchema.shape.observation_freshness.safeParse(row.currentness_state);
    if (!quality.success || !currentness.success) invalid();
    const channels = byRevision.get(ref);
    return { source_revision_ref: ref, content_sha256: authoritative.content_sha256,
      captured_at: date(row.captured_at), admitted_at: date(row.admitted_at), quality_state: quality.data,
      currentness_state: currentness.data, readiness: CHANNELS.flatMap((channel) => {
        const value = channels?.get(channel); return value ? [value] : [];
      }) };
  });
  const page = decoded.slice(0, request.limit); const last = page.at(-1);
  const result: SourceRevisionsResult = { protocol: "eliotr.source-revisions.v1", source_id: sourceId,
    head_revision_ref: head, observed_at: observed, readiness_basis: "RECORDED_ONLY", revisions: page,
    ...(decoded.length > request.limit && last ? { next_cursor: encodeCatalogCursor({ version: 1,
      source_id: sourceId, context_sha256: fence.identity, authority_generation: fence.generation,
      expires_at: Math.min(fence.frontier, after?.expires_at ?? Infinity), admitted_at: last.admitted_at,
      revision_after: last.source_revision_ref }) } : {}) };
  await fence.finish();
  return result;
}
