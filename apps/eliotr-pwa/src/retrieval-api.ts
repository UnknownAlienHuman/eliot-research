import {
  IdentifierSchema, ResolvedEvidenceSchema, RetrievalTraceSchema, VersionedRefSchema,
  type ResolvedEvidence, type RetrievalTrace, type VersionedRef,
} from "@eliotr/contracts";
import { ApiRequestError, requestApi } from "./api.js";

export interface RetrievalResultView {
  readonly evidence: readonly ResolvedEvidence[];
  readonly omitted: readonly { candidate_id: string; reason_code: string }[];
  readonly scope: VersionedRef;
  readonly pack: VersionedRef;
  readonly trace: VersionedRef;
  readonly total_utf8_bytes: number;
}

export interface RetrievalTraceView {
  readonly trace: RetrievalTrace;
  readonly coverage_claim: "NONE" | "SAMPLED";
}

export const RETRIEVAL_MAX_RESULTS = 16;
const QUERY_TRACE_ID = /^query-[0-9a-f]{48}$/u;

function mismatch(): never {
  throw new ApiRequestError({
    status: 502,
    code: "RETRIEVAL_RESPONSE_INVALID",
    message: "Retrieval response is invalid; run the query again",
  });
}

// The contract schemas are the decoder, but a schema violation is still a bad response and must
// reach the panel as a coded API error rather than as a raw validation dump.
function parsed<T>(decode: () => T): T {
  try {
    return decode();
  } catch {
    mismatch();
  }
}

function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      keys.some((key) => !Object.hasOwn(raw, key)) ||
      Object.keys(raw).some((key) => !keys.includes(key))) mismatch();
  return raw as Record<string, unknown>;
}

export function retrievalBody(query: string, sourceIds: readonly string[]): string {
  if (typeof query !== "string" || query.trim().length === 0) mismatch();
  parsed(() => sourceIds.forEach((id) => IdentifierSchema.parse(id)));
  // FAST_SEARCH deliberately uses the same seven bounded keys as ORIENT. The profile
  // distinguishes active retrieval from navigation metadata at the Worker boundary.
  return JSON.stringify({
    query,
    product: "FAST_SEARCH",
    scope_expression: sourceIds.length
      ? { kind: "SELECTED_SOURCES", source_ids: sourceIds }
      : { kind: "GLOBAL_LIBRARY" },
    literals: [],
    evidence_grade: "E0",
    budget_ref: "retrieval-fast-v1",
    max_results: RETRIEVAL_MAX_RESULTS,
  });
}

export function decodeRetrievalResult(raw: unknown, expectedDeploymentGeneration?: string): RetrievalResultView {
  const envelope = record(raw, ["data", "trace_id", "deployment_generation"]);
  const deployment = parsed(() => IdentifierSchema.parse(envelope.deployment_generation));
  if (expectedDeploymentGeneration !== undefined && deployment !== expectedDeploymentGeneration) {
    throw new ApiRequestError({ status: 409, code: "RETRIEVAL_DEPLOYMENT_CHANGED", message: "Application changed; refresh the Library", retryable: true });
  }
  const data = record(envelope.data, ["evidence_pack", "trace_ref"]);
  const pack = record(data.evidence_pack,
    ["pack_ref", "scope_snapshot_ref", "resolved_evidence", "omitted_candidates", "trace_ref", "total_utf8_bytes"]);
  const rawEvidence: unknown[] = Array.isArray(pack.resolved_evidence) ? pack.resolved_evidence : mismatch();
  const rawOmitted: unknown[] = Array.isArray(pack.omitted_candidates) ? pack.omitted_candidates : mismatch();
  if (rawEvidence.length > RETRIEVAL_MAX_RESULTS) mismatch();
  // The contract schema is the decoder: a shape the Worker can emit but the PWA invented would
  // drift silently, and a resolved excerpt is citation evidence, not a preview.
  const evidence = parsed(() => rawEvidence.map((item) => ResolvedEvidenceSchema.parse(item)));
  const omitted = rawOmitted.map((item) => {
    const row = record(item, ["candidate_id", "reason_code"]);
    return parsed(() => ({ candidate_id: IdentifierSchema.parse(row.candidate_id), reason_code: IdentifierSchema.parse(row.reason_code) }));
  });
  const trace = parsed(() => VersionedRefSchema.parse(data.trace_ref));
  if (!QUERY_TRACE_ID.test(trace.id)) mismatch();
  const packTrace = parsed(() => VersionedRefSchema.parse(pack.trace_ref));
  if (packTrace.id !== trace.id || packTrace.revision !== trace.revision) mismatch();
  const bytes = pack.total_utf8_bytes;
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) mismatch();
  const declared = evidence.reduce((total, item) => total + new TextEncoder().encode(item.exact_excerpt).byteLength, 0);
  // An understated total would let a pack carry more excerpt bytes than it declares downstream.
  if (declared > (bytes as number)) mismatch();
  return {
    evidence,
    omitted,
    scope: parsed(() => VersionedRefSchema.parse(pack.scope_snapshot_ref)),
    pack: parsed(() => VersionedRefSchema.parse(pack.pack_ref)),
    trace,
    total_utf8_bytes: bytes as number,
  };
}

export async function runRetrievalQuery(body: string, key: string, signal?: AbortSignal,
  expectedDeploymentGeneration?: string): Promise<RetrievalResultView> {
  const value = await requestApi("/api/v1/research/query", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "idempotency-key": key },
    ...(signal ? { signal } : {}),
  });
  return decodeRetrievalResult(value, expectedDeploymentGeneration);
}

export function assertRetrievalSelection(view: RetrievalResultView, traceView: RetrievalTraceView,
  sourceRevisionRefs: readonly string[]): void {
  const trace = traceView.trace;
  if (trace.trace_ref.id !== view.trace.id || trace.trace_ref.revision !== view.trace.revision ||
      trace.scope_snapshot.snapshot_id !== view.scope.id || trace.scope_snapshot.revision !== view.scope.revision ||
      (trace.evidence_pack_ref !== undefined &&
        trace.evidence_pack_ref !== view.pack.id)) {
    mismatch();
  }
  const scopeMembers = new Set(trace.scope_snapshot.member_source_revision_refs);
  if (sourceRevisionRefs.some((ref) => !scopeMembers.has(ref)) ||
      view.evidence.some((item) => !scopeMembers.has(item.handle.source_revision_ref))) {
    throw new ApiRequestError({ status: 409, code: "RETRIEVAL_SOURCE_HEAD_CHANGED", message: "The selected source changed; refresh the Library", retryable: true });
  }
}

export function decodeRetrievalTrace(raw: unknown, expectedDeploymentGeneration?: string): RetrievalTraceView {
  const envelope = record(raw, ["data", "trace_id", "deployment_generation"]);
  const deployment = parsed(() => IdentifierSchema.parse(envelope.deployment_generation));
  if (expectedDeploymentGeneration !== undefined && deployment !== expectedDeploymentGeneration) {
    throw new ApiRequestError({ status: 409, code: "RETRIEVAL_DEPLOYMENT_CHANGED", message: "Application changed; refresh the Library", retryable: true });
  }
  if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) mismatch();
  const { coverage_claim: claim, ...rest } = envelope.data as Record<string, unknown>;
  if (claim !== "NONE" && claim !== "SAMPLED") mismatch();
  const trace = parsed(() => RetrievalTraceSchema.parse(rest));
  if (!QUERY_TRACE_ID.test(trace.trace_ref.id)) mismatch();
  return { trace, coverage_claim: claim };
}

export async function readRetrievalTrace(ref: VersionedRef, signal?: AbortSignal,
  expectedDeploymentGeneration?: string): Promise<RetrievalTraceView> {
  if (ref.revision !== 1 || !QUERY_TRACE_ID.test(ref.id)) mismatch();
  const view = decodeRetrievalTrace(
    await requestApi(`/api/v1/research/trace/${encodeURIComponent(ref.id)}`, signal ? { signal } : {}),
    expectedDeploymentGeneration,
  );
  // A trace that is not the one asked for is a substitution, not a slow read.
  if (view.trace.trace_ref.id !== ref.id || view.trace.trace_ref.revision !== ref.revision) mismatch();
  return view;
}
