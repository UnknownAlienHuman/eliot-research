import { IdentifierSchema, RetrievalTraceSchema, Sha256Schema, VersionedRefSchema } from "@eliotr/contracts";
import type { RetrievalTrace, VersionedRef } from "@eliotr/contracts";
import { decodeCanonicalRetrievalJson, decodeEvidencePack } from "./query-codec.js";
import type { EvidencePack } from "./service.js";

export interface RetrieveBranchesCheckpoint {
  readonly protocol: "eliotr.research.retrieve-branches.v1";
  readonly workflow_stage: "RETRIEVE_BRANCHES";
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly principal_ref: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly protocol_digest: string;
  readonly denominator_digest: string;
  readonly retrieval_request_digest: string;
  readonly evidence_pack: EvidencePack;
  readonly trace: RetrievalTrace;
  readonly coverage_claim: "NONE" | "SAMPLED" | "COMPLETE_SCOPE";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Decode the persisted RETRIEVE_BRANCHES checkpoint without accepting a caller-shaped object. */
export function decodeRetrieveBranchesCheckpoint(bytes: Uint8Array): RetrieveBranchesCheckpoint | null {
  if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) return null;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
  const raw = decodeCanonicalRetrievalJson(text);
  if (!isRecord(raw) || !hasExactKeys(raw, ["protocol", "workflow_stage", "operation_id", "investigation_ref", "principal_ref", "scope_snapshot_ref", "protocol_digest", "denominator_digest", "retrieval_request_digest", "evidence_pack", "trace", "coverage_claim"]) ||
      raw.protocol !== "eliotr.research.retrieve-branches.v1" || raw.workflow_stage !== "RETRIEVE_BRANCHES" ||
      typeof raw.operation_id !== "string" || raw.operation_id.length < 1 || raw.operation_id.length > 128 ||
      !VersionedRefSchema.safeParse(raw.investigation_ref).success || !IdentifierSchema.safeParse(raw.principal_ref).success ||
      !VersionedRefSchema.safeParse(raw.scope_snapshot_ref).success || !Sha256Schema.safeParse(raw.protocol_digest).success ||
      !Sha256Schema.safeParse(raw.denominator_digest).success || !Sha256Schema.safeParse(raw.retrieval_request_digest).success ||
      decodeEvidencePack(raw.evidence_pack) === null || !RetrievalTraceSchema.safeParse(raw.trace).success ||
      (raw.coverage_claim !== "NONE" && raw.coverage_claim !== "SAMPLED" && raw.coverage_claim !== "COMPLETE_SCOPE")) return null;
  return raw as unknown as RetrieveBranchesCheckpoint;
}
