import {
  IdentifierSchema,
  MANAGED_RETRIEVAL_TRACE_PROTOCOL,
  ManagedRetrievalTraceSchema,
  ResolvedEvidenceSchema,
  RetrievalTraceSchema,
  VersionedRefSchema,
  type ManagedRetrievalTrace,
  type RetrievalTrace,
} from "@eliotr/contracts";
import type { EvidencePack, RetrievalResult } from "./service.js";
import type { RetrievalRequestBudgets } from "./ports.js";
import { sha256HexText } from "./digest.js";

export interface RetrievalRequestDigestInput {
  readonly raw_query: string;
  readonly product: string;
  readonly literals: readonly string[];
  readonly requested_limit: number;
  readonly scope_digest: string;
  readonly budgets?: RetrievalRequestBudgets;
}

const BUDGET_KEYS = ["candidate_limit", "evidence_limit", "max_evidence_bytes", "scan_limit"] as const;
const MAX_BUDGETS = {
  candidate_limit: 512,
  scan_limit: 4_096,
  evidence_limit: 64,
  max_evidence_bytes: 64 * 1024,
} as const;

export async function retrievalSha256Hex(text: string): Promise<string> {
  return sha256HexText(text);
}

/** Versioned trace/pack identity is stable for the caller's admitted invocation, not its query or output. */
export async function managedRetrievalRefIdV1(
  scopedInvocationId: string,
  kind: "trace" | "pack",
): Promise<string> {
  if (!IdentifierSchema.safeParse(scopedInvocationId).success || (kind !== "trace" && kind !== "pack")) {
    throw new Error("managed retrieval invocation identity is invalid");
  }
  const digest = await retrievalSha256Hex(`eliotr.retrieval-ref.managed.v1\0${kind}\0${scopedInvocationId}`);
  return `${kind === "trace" ? "mrt1" : "mrp1"}-${digest.slice(0, 48)}`;
}

export interface ManagedRetrievalInvocationIdsV1 {
  /** Stable existing retrieval_query_result.operation_id; excludes credential generation and all payload digests. */
  readonly retrieval_operation_id: string;
  /** Stable identity used by managed trace outcomes and refs. */
  readonly scoped_invocation_id: string;
  /** Separate 48-hex execution lease key; it is not the retrieval row key. */
  readonly execution_id: string;
}

/**
 * Derive the invocation keys from the existing actor/client/idempotency tuple.
 * Keep this byte-compatible with the admission owner. Request and output digests
 * bind payloads separately and credential rotation never mints a new billing key.
 */
export async function managedRetrievalInvocationIdsV1(
  principalRef: string,
  clientClass: string,
  idempotencyKey: string,
): Promise<ManagedRetrievalInvocationIdsV1> {
  if (typeof principalRef !== "string" || principalRef.length === 0 ||
      typeof clientClass !== "string" || clientClass.length === 0 ||
      typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 256) {
    throw new Error("managed retrieval invocation tuple is invalid");
  }
  const digest = await retrievalSha256Hex(canonicalRetrievalJson({
    protocol: "eliotr.retrieval-scoped-invocation.v2",
    principal_ref: principalRef,
    client_class: clientClass,
    idempotency_key: idempotencyKey,
  }));
  const retrievalOperationId = `q4-${digest}`;
  return {
    retrieval_operation_id: retrievalOperationId,
    scoped_invocation_id: retrievalOperationId,
    execution_id: digest.slice(0, 48),
  };
}

/** Legacy request fields retain their exact canonical bytes when budgets are omitted. */
export async function retrievalRequestDigest(input: RetrievalRequestDigestInput): Promise<string> {
  return retrievalSha256Hex(canonicalRetrievalJson({
    raw_query: input.raw_query,
    product: input.product,
    literals: [...input.literals],
    requested_limit: input.requested_limit,
    scope_digest: input.scope_digest,
    ...(input.budgets === undefined ? {} : {
      budgets: {
        candidate_limit: input.budgets.candidate_limit,
        scan_limit: input.budgets.scan_limit,
        evidence_limit: input.budgets.evidence_limit,
        max_evidence_bytes: input.budgets.max_evidence_bytes,
      },
    }),
  }));
}

const PACK_KEYS = ["pack_ref", "scope_snapshot_ref", "resolved_evidence", "omitted_candidates", "trace_ref", "total_utf8_bytes"] as const;
const RESULT_KEYS = ["evidence_pack", "trace", "coverage_claim"] as const;
const MANAGED_RESULT_KEYS = ["numeric_codec", "protocol", "result"] as const;
const MANAGED_RESULT_WITH_SETTLEMENT_KEYS = [
  "budget_settlement",
  "budget_settlement_digest",
  ...MANAGED_RESULT_KEYS,
] as const;

/** Versioned wrapper for new managed results; legacy result bytes stay unwrapped. */
export const MANAGED_RETRIEVAL_RESULT_PROTOCOL = "eliotr.retrieval-result.managed.v1";
/** Managed trace/result v1 uses finite ECMAScript JSON numbers; -0 serializes as 0. */
export const MANAGED_RETRIEVAL_NUMBER_CODEC_V1 = "eliotr.json-number.ecma-json-finite.v1";

export function isRetrievalRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasExactRetrievalKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isManagedTraceRecord(value: unknown): value is Record<string, unknown> {
  return isRetrievalRecord(value) && value.protocol === MANAGED_RETRIEVAL_TRACE_PROTOCOL;
}

export function isManagedRetrievalTrace(value: unknown): value is ManagedRetrievalTrace {
  return ManagedRetrievalTraceSchema.safeParse(value).success;
}

function isManagedResultEnvelope(value: unknown): value is Record<string, unknown> {
  return isRetrievalRecord(value) && value.protocol === MANAGED_RETRIEVAL_RESULT_PROTOCOL;
}

function canonicalManagedJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("managed retrieval JSON contains a non-finite number");
    // JSON.stringify follows ECMAScript JSON number serialization (including -0 -> 0).
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
      throw new Error("managed retrieval JSON contains a non-plain array");
    }
    const ownNames = Object.getOwnPropertyNames(value);
    if (ownNames.length !== value.length + 1 || ownNames.some((key) =>
      key !== "length" && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))) {
      throw new Error("managed retrieval JSON contains an array with extra properties");
    }
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new Error("managed retrieval JSON contains a sparse array");
      }
      entries.push(canonicalManagedJson(value[index]));
    }
    return `[${entries.join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(object).length !== 0) {
      throw new Error("managed retrieval JSON contains a non-plain object");
    }
    const ownNames = Object.getOwnPropertyNames(object);
    if (ownNames.length !== Object.keys(object).length) {
      throw new Error("managed retrieval JSON contains non-enumerable properties");
    }
    for (const key of ownNames) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("managed retrieval JSON contains an accessor property");
      }
    }
    const entries = Object.entries(object).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    if (entries.some(([, entry]) => entry === undefined)) {
      throw new Error("managed retrieval JSON contains an undefined value");
    }
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalManagedJson(entry)}`).join(",")}}`;
  }
  throw new Error("managed retrieval JSON contains an unsupported value");
}

function decodeManagedResultBody(value: unknown): RetrievalResult | null {
  if (!isRetrievalRecord(value) || !hasExactRetrievalKeys(value, RESULT_KEYS)) return null;
  const evidencePack = decodeEvidencePack(value.evidence_pack);
  const trace = ManagedRetrievalTraceSchema.safeParse(value.trace);
  if (evidencePack === null || !trace.success ||
      evidencePack.scope_snapshot_ref.id !== trace.data.scope_snapshot.snapshot_id ||
      evidencePack.scope_snapshot_ref.revision !== trace.data.scope_snapshot.revision ||
      evidencePack.trace_ref.id !== trace.data.trace_ref.id ||
      evidencePack.trace_ref.revision !== trace.data.trace_ref.revision ||
      evidencePack.pack_ref.id !== trace.data.evidence_pack_ref ||
      (value.coverage_claim !== "NONE" && value.coverage_claim !== "SAMPLED" && value.coverage_claim !== "COMPLETE_SCOPE")) {
    return null;
  }
  return { evidence_pack: evidencePack, trace: trace.data, coverage_claim: value.coverage_claim };
}

/**
 * Encode only the explicitly versioned managed trace with finite ECMAScript JSON
 * numbers. Legacy trace bytes continue through canonicalRetrievalJson unchanged.
 */
export function canonicalManagedRetrievalTraceJsonV1(value: unknown): string {
  if (!isManagedTraceRecord(value)) throw new Error("managed retrieval trace protocol is required");
  const parsed = ManagedRetrievalTraceSchema.safeParse(value);
  if (!parsed.success) throw new Error("managed retrieval trace fails strict validation");
  return canonicalManagedJson(parsed.data);
}

/** Select the new finite-number codec only for an explicitly versioned managed trace. */
export function encodeRetrievalTraceForPersistence(value: unknown): string {
  return isManagedTraceRecord(value)
    ? canonicalManagedRetrievalTraceJsonV1(value)
    : canonicalRetrievalJson(value);
}

function decodeManagedResultEnvelope(value: unknown): RetrievalResult | null {
  if (!isManagedResultEnvelope(value)) return null;
  const hasSettlement = Object.prototype.hasOwnProperty.call(value, "budget_settlement") ||
    Object.prototype.hasOwnProperty.call(value, "budget_settlement_digest");
  if (!hasExactRetrievalKeys(value, hasSettlement ? MANAGED_RESULT_WITH_SETTLEMENT_KEYS : MANAGED_RESULT_KEYS) ||
      value.numeric_codec !== MANAGED_RETRIEVAL_NUMBER_CODEC_V1 ||
      (hasSettlement && (typeof value.budget_settlement_digest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.budget_settlement_digest)))) {
    return null;
  }
  return decodeManagedResultBody(value.result);
}

/**
 * Encode a result for migration 0021. Only an explicit managed trace protocol
 * opts into fractional-number bytes; historical result objects keep the
 * original safe-integer canonical form and byte identity.
 */
export function encodeRetrievalResultForPersistence(value: unknown): string {
  if (!isRetrievalRecord(value) || !isManagedTraceRecord(value.trace)) return canonicalRetrievalJson(value);
  const hasSettlement = Object.prototype.hasOwnProperty.call(value, "budget_settlement") ||
    Object.prototype.hasOwnProperty.call(value, "budget_settlement_digest");
  const expected = hasSettlement
    ? ["budget_settlement", "budget_settlement_digest", ...RESULT_KEYS]
    : RESULT_KEYS;
  if (!hasExactRetrievalKeys(value, expected)) throw new Error("managed retrieval result has unsupported fields");
  const result = {
    evidence_pack: value.evidence_pack,
    trace: value.trace,
    coverage_claim: value.coverage_claim,
  };
  if (decodeManagedResultBody(result) === null) throw new Error("managed retrieval result fails strict validation");
  const envelope: Record<string, unknown> = {
    numeric_codec: MANAGED_RETRIEVAL_NUMBER_CODEC_V1,
    protocol: MANAGED_RETRIEVAL_RESULT_PROTOCOL,
    result,
  };
  if (hasSettlement) {
    if (typeof value.budget_settlement_digest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.budget_settlement_digest)) {
      throw new Error("managed retrieval settlement digest is invalid");
    }
    envelope.budget_settlement = value.budget_settlement;
    envelope.budget_settlement_digest = value.budget_settlement_digest;
  }
  if (decodeManagedResultEnvelope(envelope) === null) throw new Error("managed retrieval result envelope is invalid");
  return canonicalManagedJson(envelope);
}

/** Canonical public result body for output/result digests without changing historical bytes. */
export function canonicalRetrievalResultJson(value: unknown): string {
  if (isRetrievalRecord(value) && isManagedTraceRecord(value.trace)) {
    if (decodeManagedResultBody(value) === null) {
      throw new Error("managed retrieval result body fails strict validation");
    }
    return canonicalManagedJson(value);
  }
  return canonicalRetrievalJson(value);
}

/** Canonical non-circular public output identity for a managed retrieval result. */
export function canonicalManagedRetrievalPublicOutputJsonV1(value: unknown): string {
  if (decodeManagedResultBody(value) === null || !isRetrievalRecord(value)) {
    throw new Error("managed retrieval result body fails strict validation");
  }
  return canonicalManagedJson({
    evidence_pack: value.evidence_pack,
    coverage_claim: value.coverage_claim,
  });
}

export interface DecodedRetrievalPersistenceValue {
  readonly result: RetrievalResult;
  readonly budget_settlement?: unknown;
  readonly budget_settlement_digest?: string;
}

/** Decode both historical settlement wrappers and the new versioned managed envelope. */
export function decodeRetrievalPersistenceValue(value: unknown): DecodedRetrievalPersistenceValue | null {
  if (isManagedResultEnvelope(value)) {
    const hasSettlement = Object.prototype.hasOwnProperty.call(value, "budget_settlement") ||
      Object.prototype.hasOwnProperty.call(value, "budget_settlement_digest");
    const result = decodeManagedResultEnvelope(value);
    if (result === null) return null;
    return hasSettlement
      ? {
        result,
        budget_settlement: value.budget_settlement,
        budget_settlement_digest: value.budget_settlement_digest as string,
      }
      : { result };
  }
  if (isRetrievalRecord(value) && hasExactRetrievalKeys(value, [
    "budget_settlement",
    "budget_settlement_digest",
    ...RESULT_KEYS,
  ])) {
    const result = decodeRetrievalResult({
      evidence_pack: value.evidence_pack,
      trace: value.trace,
      coverage_claim: value.coverage_claim,
    });
    if (result === null || typeof value.budget_settlement_digest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.budget_settlement_digest)) return null;
    return {
      result,
      budget_settlement: value.budget_settlement,
      budget_settlement_digest: value.budget_settlement_digest,
    };
  }
  const result = decodeRetrievalResult(value);
  return result === null ? null : { result };
}

/** Strictly decode legacy or managed trace bodies without reinterpreting history. */
export function decodeRetrievalTrace(value: unknown): RetrievalTrace | ManagedRetrievalTrace | null {
  if (isManagedTraceRecord(value)) {
    const managed = ManagedRetrievalTraceSchema.safeParse(value);
    return managed.success ? managed.data : null;
  }
  const legacy = RetrievalTraceSchema.safeParse(value);
  return legacy.success ? legacy.data : null;
}

export function decodeRetrievalRequestBudgets(value: unknown): RetrievalRequestBudgets | null {
  if (!isRetrievalRecord(value) || !hasExactRetrievalKeys(value, BUDGET_KEYS)) return null;
  for (const key of BUDGET_KEYS) {
    if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) ||
        (value[key] as number) < 1 || (value[key] as number) > MAX_BUDGETS[key]) return null;
  }
  return {
    candidate_limit: value.candidate_limit as number,
    scan_limit: value.scan_limit as number,
    evidence_limit: value.evidence_limit as number,
    max_evidence_bytes: value.max_evidence_bytes as number,
  };
}

/** Decode JSON only when its bytes are the package's canonical retrieval form. */
export function decodeCanonicalRetrievalJson(text: string): unknown | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (isManagedTraceRecord(value)) {
      const trace = ManagedRetrievalTraceSchema.safeParse(value);
      return trace.success && canonicalManagedJson(trace.data) === text ? trace.data : undefined;
    }
    if (isManagedResultEnvelope(value)) {
      return decodeManagedResultEnvelope(value) !== null && canonicalManagedJson(value) === text ? value : undefined;
    }
    if (isRetrievalRecord(value) && hasExactRetrievalKeys(value, RESULT_KEYS) && isManagedTraceRecord(value.trace)) {
      return undefined;
    }
    return canonicalRetrievalJson(value) === text ? value : undefined;
  } catch {
    return undefined;
  }
}

export function decodeEvidencePack(value: unknown): EvidencePack | null {
  if (!isRetrievalRecord(value) || !hasExactRetrievalKeys(value, PACK_KEYS) ||
      !VersionedRefSchema.safeParse(value.pack_ref).success ||
      !VersionedRefSchema.safeParse(value.scope_snapshot_ref).success ||
      !VersionedRefSchema.safeParse(value.trace_ref).success ||
      !Array.isArray(value.resolved_evidence) || value.resolved_evidence.length > 512 ||
      !Array.isArray(value.omitted_candidates) || typeof value.total_utf8_bytes !== "number" ||
      !Number.isSafeInteger(value.total_utf8_bytes) || value.total_utf8_bytes < 0 || value.total_utf8_bytes > 8 * 1024 * 1024) {
    return null;
  }
  if (value.resolved_evidence.some((item) => !ResolvedEvidenceSchema.safeParse(item).success) || value.omitted_candidates.some((item) => {
    if (!isRetrievalRecord(item) || !hasExactRetrievalKeys(item, ["candidate_id", "reason_code"])) return true;
    return !IdentifierSchema.safeParse(item.candidate_id).success || !IdentifierSchema.safeParse(item.reason_code).success;
  })) return null;
  return value as unknown as EvidencePack;
}

export function decodeRetrievalResult(value: unknown): RetrievalResult | null {
  if (isManagedResultEnvelope(value)) return decodeManagedResultEnvelope(value);
  if (!isRetrievalRecord(value) || !hasExactRetrievalKeys(value, RESULT_KEYS)) return null;
  if (isManagedTraceRecord(value.trace)) return decodeManagedResultBody(value);
  const evidencePack = decodeEvidencePack(value.evidence_pack);
  const trace = RetrievalTraceSchema.safeParse(value.trace);
  if (evidencePack === null || !trace.success ||
      evidencePack.scope_snapshot_ref.id !== trace.data.scope_snapshot.snapshot_id ||
      evidencePack.scope_snapshot_ref.revision !== trace.data.scope_snapshot.revision ||
      evidencePack.trace_ref.id !== trace.data.trace_ref.id ||
      evidencePack.trace_ref.revision !== trace.data.trace_ref.revision ||
      (value.coverage_claim !== "NONE" && value.coverage_claim !== "SAMPLED" && value.coverage_claim !== "COMPLETE_SCOPE")) return null;
  return { evidence_pack: evidencePack, trace: trace.data, coverage_claim: value.coverage_claim } as RetrievalResult;
}

export function canonicalRetrievalJson(value: unknown): string {
  if (isManagedTraceRecord(value)) {
    const trace = ManagedRetrievalTraceSchema.safeParse(value);
    if (!trace.success) throw new Error("managed retrieval trace fails strict validation");
    return canonicalManagedJson(trace.data);
  }
  if (isManagedResultEnvelope(value)) {
    if (decodeManagedResultEnvelope(value) === null) throw new Error("managed retrieval result envelope fails strict validation");
    return canonicalManagedJson(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("retrieval JSON contains a non-canonical number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalRetrievalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalRetrievalJson(entry)}`).join(",")}}`;
  }
  throw new Error("retrieval JSON contains an unsupported value");
}
