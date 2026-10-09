// C2-R owner-client move of packages/pwa-source-workspace/src/source-revisions-api.ts.
// Wire/value implementation moves here verbatim; only the transport and epoch seams are injected.
// No new DTO, schema, endpoint, identifier or retry rule is introduced.
import { ChannelReadinessSchema, IsoDateTimeSchema, ReadinessChannelSchema,
  SourceCurrentnessSchema, SourceRevisionSchema, type ChannelReadiness, type SourceCurrentness,
  type SourceRevision } from "@eliotr/contracts";
import type { LegacyErrorFactory, LegacyHttpAdapter } from "../../legacy/http.js";
import type { EpochPort } from "../../transport/client.js";

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
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

/** Read-only decoder transport. Byte, status and header policy stays in the injected owner client. */
export type RevisionHttp = Pick<LegacyHttpAdapter, "requestApi">;

export type RevisionErrors = LegacyErrorFactory;

export interface RevisionApi {
  readonly REVISION_PAGE_SIZE: number;
  /** Pure decoder. No epoch, no transport, no ambient state. */
  readonly decodeSourceRevisions: (raw: unknown, sourceId: string, expectedGeneration: string) => SourceRevisionPage;
  readonly readSourceRevisionsPage: (sourceId: string, generation: string, cursor?: string, signal?: AbortSignal) => Promise<SourceRevisionPage>;
}

export function createRevisionApi(http: RevisionHttp, errors: RevisionErrors, epoch: EpochPort): RevisionApi {
  const invalid: () => never = () => {
    throw errors({
      status: 502,
      code: "SOURCE_REVISIONS_RESPONSE_INVALID",
      message: "Revision response is invalid; refresh the Library",
      traceId: null,
      retryable: false,
    });
  };

  const record = (value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        required.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => ![...required, ...optional].includes(key))) invalid();
    return value as Record<string, unknown>;
  };

  const id = (value: unknown): string => {
    if (typeof value !== "string" || !idPattern.test(value)) invalid();
    return value;
  };

  const date = (value: unknown): string => {
    const result = IsoDateTimeSchema.safeParse(value);
    if (!result.success || result.data.length > 64 || !Number.isFinite(Date.parse(result.data))) invalid();
    return result.data;
  };

  const channels = (value: unknown, revision: string): ChannelReadiness[] => {
    if (!Array.isArray(value) || value.length > ReadinessChannelSchema.options.length) invalid();
    const result = value.map((raw) => {
      const parsed = ChannelReadinessSchema.safeParse(raw);
      if (!parsed.success || parsed.data.source_revision_ref !== revision ||
          parsed.data.reason_codes.length > 16 ||
          new Set(parsed.data.reason_codes).size !== parsed.data.reason_codes.length ||
          new TextEncoder().encode(JSON.stringify(parsed.data.reason_codes)).byteLength > 1024) invalid();
      parsed.data.reason_codes.forEach(id);
      date(parsed.data.observed_at);
      if (parsed.data.generation !== undefined) id(parsed.data.generation);
      if (parsed.data.receipt_ref !== undefined) id(parsed.data.receipt_ref);
      return parsed.data;
    });
    if (result.some((row, index) => {
      const previous = result[index - 1];
      return previous !== undefined &&
        ReadinessChannelSchema.options.indexOf(previous.channel) >= ReadinessChannelSchema.options.indexOf(row.channel);
    })) invalid();
    return result;
  };

  /** Re-checks the caller epoch after the await closes the transport fence. */
  const closed = (): never => {
    throw errors({
      status: 503,
      code: "API_SESSION_CLOSED",
      message: "Response belongs to a closed owner session",
      traceId: null,
      retryable: false,
    });
  };

  const decodeSourceRevisions = (raw: unknown, sourceId: string, expectedGeneration: string): SourceRevisionPage => {
    id(sourceId); id(expectedGeneration);
    const envelope = record(raw, ["data", "deployment_generation", "trace_id"]);
    const generation = id(envelope.deployment_generation);
    const trace = id(envelope.trace_id);
    if (generation !== expectedGeneration) {
      throw errors({ status: 409, code: "CATALOG_GENERATION_CHANGED", message: "Application changed; refresh the Library", traceId: null, retryable: true });
    }
    const data = record(envelope.data,
      ["protocol", "source_id", "head_revision_ref", "observed_at", "readiness_basis", "revisions"],
      ["next_cursor"]);
    if (data.protocol !== "eliotr.source-revisions.v1" || data.source_id !== sourceId ||
        data.readiness_basis !== "RECORDED_ONLY" || !Array.isArray(data.revisions) ||
        data.revisions.length > REVISION_PAGE_SIZE) invalid();
    const revisions = data.revisions.map((row) => {
      const fields = record(row,
        ["source_revision_ref", "content_sha256", "captured_at", "admitted_at", "quality_state", "currentness_state", "readiness"]);
      const ref = id(fields.source_revision_ref);
      const quality = SourceRevisionSchema.shape.quality_state.safeParse(fields.quality_state);
      const currentness = SourceCurrentnessSchema.shape.observation_freshness.safeParse(fields.currentness_state);
      if (!quality.success || !currentness.success ||
          typeof fields.content_sha256 !== "string" || !digestPattern.test(fields.content_sha256)) invalid();
      return { source_revision_ref: ref, content_sha256: fields.content_sha256,
        captured_at: date(fields.captured_at), admitted_at: date(fields.admitted_at),
        quality_state: quality.data, currentness_state: currentness.data,
        readiness: channels(fields.readiness, ref) };
    });
    if (new Set(revisions.map((row) => row.source_revision_ref)).size !== revisions.length ||
        revisions.some((row, index) => {
          const before = revisions[index - 1];
          return before !== undefined && (Date.parse(row.admitted_at) > Date.parse(before.admitted_at) ||
            row.admitted_at === before.admitted_at && row.source_revision_ref >= before.source_revision_ref);
        })) invalid();
    if (data.next_cursor !== undefined && (typeof data.next_cursor !== "string" ||
        !cursorPattern.test(data.next_cursor) || !revisions.length)) invalid();
    return { source_id: sourceId, head_revision_ref: id(data.head_revision_ref),
      observed_at: date(data.observed_at), readiness_basis: "RECORDED_ONLY", revisions, generation, trace,
      ...(data.next_cursor === undefined ? {} : { next_cursor: String(data.next_cursor) }) };
  };

  const readSourceRevisionsPage = async (sourceId: string, generation: string, cursor?: string,
    signal?: AbortSignal): Promise<SourceRevisionPage> => {
    id(sourceId); id(generation);
    const query = new URLSearchParams({ source_id: sourceId, limit: String(REVISION_PAGE_SIZE) });
    if (cursor !== undefined) {
      if (!cursorPattern.test(cursor)) invalid();
      query.set("cursor", cursor);
    }
    const capture = epoch.capture();
    if (!capture || !epoch.isCurrent(capture)) closed();
    const raw = await http.requestApi(`/api/v1/library/revisions?${query}`, signal === undefined ? {} : { signal });
    const page = decodeSourceRevisions(raw, sourceId, generation);
    if (page.next_cursor !== undefined && page.next_cursor === cursor) invalid();
    if (!epoch.isCurrent(capture)) closed();
    return page;
  };

  return { REVISION_PAGE_SIZE, decodeSourceRevisions, readSourceRevisionsPage };
}
