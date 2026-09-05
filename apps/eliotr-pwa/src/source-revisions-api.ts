import { ChannelReadinessSchema, IsoDateTimeSchema, ReadinessChannelSchema,
  SourceCurrentnessSchema, SourceRevisionSchema, type ChannelReadiness, type SourceCurrentness,
  type SourceRevision } from "@eliotr/contracts";
import { ApiRequestError, requestApi } from "./api.js";

export const REVISION_PAGE_SIZE = 10;
export interface SourceRevisionPage {
  readonly source_id: string;
  readonly head_revision_ref: string;
  readonly observed_at: string;
  readonly readiness_basis: "RECORDED_ONLY";
  readonly revisions: readonly {
    readonly source_revision_ref: string; readonly content_sha256: string;
    readonly captured_at: string; readonly admitted_at: string;
    readonly quality_state: SourceRevision["quality_state"];
    readonly currentness_state: SourceCurrentness["observation_freshness"];
    readonly readiness: readonly ChannelReadiness[];
  }[];
  readonly next_cursor?: string;
  readonly generation: string;
  readonly trace: string;
}
const cursorPattern = /^[A-Za-z0-9_-]{1,2048}$/u;
function invalid(): never {
  throw new ApiRequestError({ status: 502, code: "SOURCE_REVISIONS_RESPONSE_INVALID", message: "Revision response is invalid; refresh the Library" });
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => ![...required, ...optional].includes(key))) invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) invalid();
  return value;
}
function date(value: unknown): string {
  const result = IsoDateTimeSchema.safeParse(value);
  if (!result.success || result.data.length > 64 || !Number.isFinite(Date.parse(result.data))) invalid();
  return result.data;
}
function channels(value: unknown, revision: string): ChannelReadiness[] {
  if (!Array.isArray(value) || value.length > ReadinessChannelSchema.options.length) invalid();
  const result = value.map((raw) => {
    const parsed = ChannelReadinessSchema.safeParse(raw);
    if (!parsed.success || parsed.data.source_revision_ref !== revision || parsed.data.reason_codes.length > 16 ||
        new Set(parsed.data.reason_codes).size !== parsed.data.reason_codes.length ||
        new TextEncoder().encode(JSON.stringify(parsed.data.reason_codes)).byteLength > 1024) invalid();
    parsed.data.reason_codes.forEach(id); date(parsed.data.observed_at);
    if (parsed.data.generation !== undefined) id(parsed.data.generation);
    if (parsed.data.receipt_ref !== undefined) id(parsed.data.receipt_ref);
    return parsed.data;
  });
  if (result.some((row, index) => {
    const previous = result[index - 1];
    return previous !== undefined && ReadinessChannelSchema.options.indexOf(previous.channel) >= ReadinessChannelSchema.options.indexOf(row.channel);
  })) invalid();
  return result;
}
export function decodeSourceRevisions(raw: unknown, sourceId: string, expectedGeneration: string): SourceRevisionPage {
  id(sourceId); id(expectedGeneration);
  const envelope = record(raw, ["data", "deployment_generation", "trace_id"]);
  const generation = id(envelope.deployment_generation); const trace = id(envelope.trace_id);
  if (generation !== expectedGeneration) {
    throw new ApiRequestError({ status: 409, code: "CATALOG_GENERATION_CHANGED", message: "Application changed; refresh the Library", retryable: true });
  }
  const data = record(envelope.data, ["protocol", "source_id", "head_revision_ref", "observed_at", "readiness_basis", "revisions"], ["next_cursor"]);
  if (data.protocol !== "eliotr.source-revisions.v1" || data.source_id !== sourceId || data.readiness_basis !== "RECORDED_ONLY" ||
      !Array.isArray(data.revisions) || data.revisions.length > REVISION_PAGE_SIZE) invalid();
  const revisions = data.revisions.map((raw) => {
    const row = record(raw, ["source_revision_ref", "content_sha256", "captured_at", "admitted_at", "quality_state", "currentness_state", "readiness"]);
    const ref = id(row.source_revision_ref);
    const quality = SourceRevisionSchema.shape.quality_state.safeParse(row.quality_state);
    const currentness = SourceCurrentnessSchema.shape.observation_freshness.safeParse(row.currentness_state);
    if (!quality.success || !currentness.success || typeof row.content_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.content_sha256)) invalid();
    return { source_revision_ref: ref, content_sha256: row.content_sha256, captured_at: date(row.captured_at),
      admitted_at: date(row.admitted_at), quality_state: quality.data, currentness_state: currentness.data, readiness: channels(row.readiness, ref) };
  });
  if (new Set(revisions.map((row) => row.source_revision_ref)).size !== revisions.length || revisions.some((row, index) => {
    const before = revisions[index - 1];
    return before !== undefined && (Date.parse(row.admitted_at) > Date.parse(before.admitted_at) ||
      row.admitted_at === before.admitted_at && row.source_revision_ref >= before.source_revision_ref);
  })) invalid();
  if (data.next_cursor !== undefined && (typeof data.next_cursor !== "string" || !cursorPattern.test(data.next_cursor) || !revisions.length)) invalid();
  return { source_id: sourceId, head_revision_ref: id(data.head_revision_ref), observed_at: date(data.observed_at),
    readiness_basis: "RECORDED_ONLY", revisions, generation, trace,
    ...(data.next_cursor === undefined ? {} : { next_cursor: String(data.next_cursor) }) };
}
export async function readSourceRevisionsPage(sourceId: string, generation: string, cursor?: string,
  signal?: AbortSignal): Promise<SourceRevisionPage> {
  id(sourceId); id(generation);
  const query = new URLSearchParams({ source_id: sourceId, limit: String(REVISION_PAGE_SIZE) });
  if (cursor !== undefined) { if (!cursorPattern.test(cursor)) invalid(); query.set("cursor", cursor); }
  const result = decodeSourceRevisions(await requestApi(`/api/v1/library/revisions?${query}`, signal ? { signal } : {}), sourceId, generation);
  if (result.next_cursor !== undefined && result.next_cursor === cursor) invalid();
  return result;
}
