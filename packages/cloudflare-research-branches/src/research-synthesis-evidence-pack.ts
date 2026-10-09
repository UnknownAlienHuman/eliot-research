import type { ResolvedEvidence, VersionedRef } from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  evidenceSha256,
  type ResearchEvidencePack,
} from "@eliotr/cloudflare-evidence";
import { sourceBoundEvidenceIdentity, sourceBoundEvidenceMaterial } from "./research-branch-evidence-identity.js";

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameEvidenceContent(left: ResolvedEvidence, right: ResolvedEvidence): boolean {
  return sourceBoundEvidenceIdentity(left) === sourceBoundEvidenceIdentity(right);
}

function immutableProjectionValue<T>(value: T): T {
  const copy = JSON.parse(canonicalEvidenceJson(value)) as T;
  const freeze = (candidate: unknown): void => {
    if (typeof candidate !== "object" || candidate === null || Object.isFrozen(candidate)) return;
    for (const child of Object.values(candidate)) freeze(child);
    Object.freeze(candidate);
  };
  freeze(copy);
  return copy;
}

export interface SynthesisEvidencePackProjection extends ResearchEvidencePack {
  readonly projection_protocol: "eliotr.research.synthesis-evidence-pack.v1";
  readonly projection_digest: string;
  readonly stage_five_pack_ref: VersionedRef;
  readonly stage_five_trace_ref: VersionedRef;
  readonly provenance_trace_refs: readonly VersionedRef[];
  readonly branch_reconciliation_ref: VersionedRef | null;
  readonly branch_reconciliation_digest: string | null;
  readonly freeze_ref: VersionedRef | null;
  readonly manifest_digest: string | null;
}

export interface SynthesisEvidencePackProjectionInput {
  readonly stage_five_pack: ResearchEvidencePack;
  readonly branch_resolved_evidence?: readonly ResolvedEvidence[];
  readonly branch_omitted_candidate_refs?: readonly string[];
  readonly branch_trace_refs?: readonly VersionedRef[];
  readonly branch_scope_snapshot_ref?: VersionedRef;
  readonly branch_reconciliation_ref?: VersionedRef;
  readonly branch_reconciliation_digest?: string;
  readonly freeze_ref?: VersionedRef;
  readonly manifest_digest?: string;
}

/**
 * Derives the in-memory root+branch synthesis evidence projection used by both
 * manifest preparation and the post-freeze synthesis reader. No second pack is
 * persisted; the projection refs bind exact source content/identity, branch traces,
 * reconciliation and exact freeze/manifest identities.
 */
export async function createSynthesisEvidencePackProjection(
  input: SynthesisEvidencePackProjectionInput,
): Promise<SynthesisEvidencePackProjection> {
  const branchEvidence = input.branch_resolved_evidence ?? [];
  const branchTraces = input.branch_trace_refs ?? [];
  const hasBranchIdentity = input.branch_reconciliation_ref !== undefined && input.branch_reconciliation_digest !== undefined;
  const hasFreezeIdentity = input.freeze_ref !== undefined && input.manifest_digest !== undefined;
  if ((input.branch_reconciliation_ref !== undefined) !== (input.branch_reconciliation_digest !== undefined) ||
      (input.freeze_ref !== undefined) !== (input.manifest_digest !== undefined) ||
      (hasFreezeIdentity && !hasBranchIdentity) ||
      (input.branch_scope_snapshot_ref !== undefined && !sameRef(input.branch_scope_snapshot_ref, input.stage_five_pack.scope_snapshot_ref)) ||
      (hasBranchIdentity && input.branch_scope_snapshot_ref === undefined) ||
      (input.branch_reconciliation_digest !== undefined && !/^[a-f0-9]{64}$/u.test(input.branch_reconciliation_digest)) ||
      (input.manifest_digest !== undefined && !/^[a-f0-9]{64}$/u.test(input.manifest_digest)) ||
      ((input.branch_omitted_candidate_refs?.length ?? 0) > 0 && !hasBranchIdentity) ||
      (branchTraces.length > 0 && !hasBranchIdentity) ||
      (branchEvidence.length > 0 && !hasBranchIdentity)) {
    throw new Error("synthesis evidence projection lineage is incomplete");
  }
  const byHandle = new Map<string, ResolvedEvidence>();
  for (const item of input.stage_five_pack.resolved_evidence) {
    const key = canonicalEvidenceJson(item.handle.handle_ref);
    if (byHandle.has(key)) throw new Error("stage-five evidence pack repeats a handle");
    byHandle.set(key, item);
  }
  for (const item of branchEvidence) {
    const key = canonicalEvidenceJson(item.handle.handle_ref);
    const prior = byHandle.get(key);
    if (prior !== undefined && !sameEvidenceContent(prior, item)) {
      throw new Error("root and branch query evidence disagree for one exact handle");
    }
    // Prefer the branch result's resolved bytes where findings cite this handle.
    byHandle.set(key, item);
  }
  const resolved = [...byHandle.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([, item]) => immutableProjectionValue(item));
  if (resolved.length > 512) throw new Error("combined synthesis evidence exceeds the manifest handle bound");
  const totalUtf8Bytes = resolved.reduce((sum, item) => sum + new TextEncoder().encode(item.exact_excerpt).byteLength, 0);
  const traceRefs = new Map<string, VersionedRef>();
  for (const ref of [input.stage_five_pack.trace_ref, ...branchTraces]) {
    traceRefs.set(canonicalEvidenceJson(ref), immutableProjectionValue(ref));
  }
  const provenanceTraceRefs = [...traceRefs.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([, ref]) => ref);
  const omitted = new Map<string, { candidate_id: string; reason_code: string }>();
  for (const item of input.stage_five_pack.omitted_candidates) {
    omitted.set(canonicalEvidenceJson([item.candidate_id, item.reason_code]), immutableProjectionValue(item));
  }
  for (const candidateId of input.branch_omitted_candidate_refs ?? []) {
    const item = { candidate_id: candidateId, reason_code: "BRANCH_QUERY_OMITTED" };
    omitted.set(canonicalEvidenceJson([item.candidate_id, item.reason_code]), item);
  }
  const omittedCandidates = [...omitted.entries()].sort(([, left], [, right]) =>
    left.candidate_id.localeCompare(right.candidate_id) || left.reason_code.localeCompare(right.reason_code))
    .map(([, item]) => immutableProjectionValue(item));
  const projectionMaterial = {
    protocol: "eliotr.research.synthesis-evidence-pack.v1" as const,
    stage_five_pack_ref: immutableProjectionValue(input.stage_five_pack.pack_ref),
    stage_five_trace_ref: immutableProjectionValue(input.stage_five_pack.trace_ref),
    scope_snapshot_ref: immutableProjectionValue(input.stage_five_pack.scope_snapshot_ref),
    branch_reconciliation_ref: input.branch_reconciliation_ref === undefined
      ? null
      : immutableProjectionValue(input.branch_reconciliation_ref),
    branch_reconciliation_digest: input.branch_reconciliation_digest ?? null,
    freeze_ref: input.freeze_ref === undefined ? null : immutableProjectionValue(input.freeze_ref),
    manifest_digest: input.manifest_digest ?? null,
    provenance_trace_refs: provenanceTraceRefs,
    omitted_candidates: omittedCandidates,
    evidence: await Promise.all(resolved.map(async (item) => ({
      handle_ref: item.handle.handle_ref,
      content_digest: await evidenceSha256({ domain: "eliotr.research.synthesis-evidence-item.v1", value: sourceBoundEvidenceMaterial(item) }),
    }))),
  };
  const projectionDigest = await evidenceSha256({ domain: "eliotr.research.synthesis-evidence-pack.v1", value: projectionMaterial });
  const projectionPackRef = immutableProjectionValue({
    id: `eliotr.research.synthesis-evidence-pack-${projectionDigest}`,
    revision: 1,
  });
  const projectionTraceRef = immutableProjectionValue({
    id: `eliotr.research.synthesis-evidence-trace-${projectionDigest}`,
    revision: 1,
  });
  return Object.freeze({
    pack_ref: projectionPackRef,
    scope_snapshot_ref: immutableProjectionValue(input.stage_five_pack.scope_snapshot_ref),
    resolved_evidence: Object.freeze(resolved),
    omitted_candidates: Object.freeze(omittedCandidates),
    trace_ref: projectionTraceRef,
    total_utf8_bytes: totalUtf8Bytes,
    projection_protocol: "eliotr.research.synthesis-evidence-pack.v1",
    projection_digest: projectionDigest,
    stage_five_pack_ref: immutableProjectionValue(input.stage_five_pack.pack_ref),
    stage_five_trace_ref: immutableProjectionValue(input.stage_five_pack.trace_ref),
    provenance_trace_refs: Object.freeze(provenanceTraceRefs),
    branch_reconciliation_ref: input.branch_reconciliation_ref === undefined
      ? null
      : immutableProjectionValue(input.branch_reconciliation_ref),
    branch_reconciliation_digest: input.branch_reconciliation_digest ?? null,
    freeze_ref: input.freeze_ref === undefined ? null : immutableProjectionValue(input.freeze_ref),
    manifest_digest: input.manifest_digest ?? null,
  });
}
