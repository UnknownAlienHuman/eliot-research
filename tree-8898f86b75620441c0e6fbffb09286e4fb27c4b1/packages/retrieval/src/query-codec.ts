import {
  IdentifierSchema,
  ResolvedEvidenceSchema,
  RetrievalTraceSchema,
  VersionedRefSchema,
} from "@eliotr/contracts";
import type { EvidencePack, RetrievalResult } from "./service.js";

const PACK_KEYS = ["pack_ref", "scope_snapshot_ref", "resolved_evidence", "omitted_candidates", "trace_ref", "total_utf8_bytes"] as const;
const RESULT_KEYS = ["evidence_pack", "trace", "coverage_claim"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Decode JSON only when its bytes are the package's canonical retrieval form. */
export function decodeCanonicalRetrievalJson(text: string): unknown | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return canonicalRetrievalJson(value) === text ? value : undefined;
  } catch {
    return undefined;
  }
}

export function decodeEvidencePack(value: unknown): EvidencePack | null {
  if (!isRecord(value) || !hasExactKeys(value, PACK_KEYS) ||
      !VersionedRefSchema.safeParse(value.pack_ref).success ||
      !VersionedRefSchema.safeParse(value.scope_snapshot_ref).success ||
      !VersionedRefSchema.safeParse(value.trace_ref).success ||
      !Array.isArray(value.resolved_evidence) || value.resolved_evidence.length > 512 ||
      !Array.isArray(value.omitted_candidates) || typeof value.total_utf8_bytes !== "number" ||
      !Number.isSafeInteger(value.total_utf8_bytes) || value.total_utf8_bytes < 0 || value.total_utf8_bytes > 8 * 1024 * 1024) {
    return null;
  }
  if (value.resolved_evidence.some((item) => !ResolvedEvidenceSchema.safeParse(item).success) || value.omitted_candidates.some((item) => {
    if (!isRecord(item) || !hasExactKeys(item, ["candidate_id", "reason_code"])) return true;
    return !IdentifierSchema.safeParse(item.candidate_id).success || !IdentifierSchema.safeParse(item.reason_code).success;
  })) return null;
  return value as unknown as EvidencePack;
}

export function decodeRetrievalResult(value: unknown): RetrievalResult | null {
  if (!isRecord(value) || !hasExactKeys(value, RESULT_KEYS)) return null;
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
