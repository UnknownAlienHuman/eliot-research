import { textDigest } from "@eliotr/cloudflare-workflows";
import { evidenceSha256 } from "@eliotr/cloudflare-evidence";
import {
  ResearchBranchRoleSchema,
  VersionedRefSchema,
  type BranchQueryResult,
  type ResearchBranchRole,
  type ResolvedEvidence,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import type { EvidencePack } from "@eliotr/retrieval";
import { ModelAttemptError } from "@eliotr/cloudflare-model-execution";

/**
 * Variant A per-role evidence pack.
 *
 * The pack is the frozen stage-five evidence pack filtered to the role's
 * pre-selected evidence handles. Nothing is re-resolved: the excerpts,
 * digests and receipts are exactly the frozen ones, so the role model sees a
 * strict subset of the same evidence the freeze admitted. A selected handle
 * that is absent from the frozen pack fails closed — the selection and the
 * pack must agree, otherwise the model would be asked to analyze evidence it
 * was not given.
 */

const PACK_ID_PREFIX = "branch-role-evidence-pack-";
const PACK_ID_HEX_CHARS = 48;
const OMITTED_REASON_NOT_SELECTED = "NOT_SELECTED_FOR_ROLE";

function invalid(message: string): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_INPUT_INVALID", message, false);
}

function conflict(message: string): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_IDENTITY_CONFLICT", message, false);
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function compareRefs(left: VersionedRef, right: VersionedRef): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return left.revision - right.revision;
}

/**
 * Builds the role's evidence pack from the frozen stage-five pack.
 *
 * - `resolved_evidence`: the stage-five items whose handle matches a selected
 *   ref exactly (id and revision). Order follows first occurrence in the
 *   selection.
 * - `omitted_candidates`: the stage-five omitted candidates plus every
 *   frozen item the role did not select, marked `NOT_SELECTED_FOR_ROLE`.
 * - `pack_ref`: a deterministic digest over the stage-five pack ref, the
 *   role, and the sorted selection — a projection, not a new retrieval.
 * - `trace_ref`: the stage-five trace ref is kept: the underlying retrieval
 *   is identical, only the projection differs.
 * - `total_utf8_bytes`: recomputed from the selected excerpts exactly the way
 *   the retrieval pack builder computes it (UTF-8 bytes of `exact_excerpt`).
 *
 * Fails closed on an empty selection and on any selected handle that has no
 * exact match in the frozen pack.
 */
export async function buildBranchRoleEvidencePack(
  stageFivePack: EvidencePack,
  role: ResearchBranchRole,
  selectedHandleRefs: readonly VersionedRef[],
): Promise<EvidencePack> {
  const parsedRole = ResearchBranchRoleSchema.parse(role);
  if (!Array.isArray(selectedHandleRefs) || selectedHandleRefs.length === 0) {
    invalid("branch role evidence selection is empty");
  }
  const selected = selectedHandleRefs.map((ref) => VersionedRefSchema.parse(ref));
  if (typeof stageFivePack !== "object" || stageFivePack === null || !Array.isArray(stageFivePack.resolved_evidence)) {
    invalid("frozen stage-five evidence pack is malformed");
  }
  const byHandle = new Map<string, ResolvedEvidence>();
  for (const item of stageFivePack.resolved_evidence) {
    if (typeof item !== "object" || item === null || typeof item.handle !== "object" || item.handle === null) {
      invalid("frozen stage-five evidence pack is malformed");
    }
    const key = refKey(item.handle.handle_ref);
    if (!byHandle.has(key)) byHandle.set(key, item);
  }
  const resolved: ResolvedEvidence[] = [];
  const seen = new Set<string>();
  for (const ref of selected) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const item = byHandle.get(key);
    if (item === undefined) {
      conflict(`branch role evidence handle ${key} is absent from the frozen stage-five pack`);
    }
    resolved.push(item);
  }
  const omitted = [
    ...stageFivePack.omitted_candidates,
    ...stageFivePack.resolved_evidence
      .filter((item) => !seen.has(refKey(item.handle.handle_ref)))
      .map((item) => ({
        candidate_id: item.handle.handle_ref.id,
        reason_code: OMITTED_REASON_NOT_SELECTED,
      })),
  ];
  const sortedRefs = [...selected].sort(compareRefs).map((ref) => ({ id: ref.id, revision: ref.revision }));
  const identity = {
    protocol: "eliotr.research.branch-role-evidence-pack.v1",
    stage_five_pack_ref: stageFivePack.pack_ref,
    role: parsedRole,
    selected_handle_refs: sortedRefs,
  };
  const digest = await textDigest(canonicalJson(identity));
  const packRef: VersionedRef = { id: `${PACK_ID_PREFIX}${digest.slice(0, PACK_ID_HEX_CHARS)}`, revision: 1 };
  const totalUtf8Bytes = resolved.reduce(
    (sum, item) => sum + new TextEncoder().encode(item.exact_excerpt).byteLength,
    0,
  );
  return Object.freeze({
    pack_ref: packRef,
    scope_snapshot_ref: stageFivePack.scope_snapshot_ref,
    resolved_evidence: Object.freeze(resolved),
    omitted_candidates: Object.freeze(omitted),
    trace_ref: stageFivePack.trace_ref,
    total_utf8_bytes: totalUtf8Bytes,
  });
}

/** Build the v2 role pack from only the exact resolved handles of its branch-local query result. */
export async function buildBranchRoleEvidencePackFromQueryResult(
  queryResult: BranchQueryResult,
  role: ResearchBranchRole,
  selectedHandleRefs: readonly VersionedRef[],
): Promise<EvidencePack> {
  const parsedRole = ResearchBranchRoleSchema.parse(role);
  if (queryResult.role !== parsedRole || queryResult.query_legs.length === 0 || selectedHandleRefs.length === 0) {
    invalid("v2 branch role query result or evidence selection is empty");
  }
  const selected = selectedHandleRefs.map((ref) => VersionedRefSchema.parse(ref));
  const byHandle = new Map(queryResult.resolved_evidence.map((item) => [refKey(item.handle.handle_ref), item]));
  const resolved: ResolvedEvidence[] = [];
  const seen = new Set<string>();
  for (const ref of selected) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const item = byHandle.get(key);
    if (item === undefined) conflict(`branch query handle ${key} is absent from its exact resolved result`);
    resolved.push(item);
  }
  const omitted = [
    ...queryResult.omitted_candidate_refs.map((candidate_id) => ({ candidate_id, reason_code: "QUERY_BUDGET_OR_RETRIEVAL_OMISSION" })),
    ...queryResult.resolved_evidence
      .filter((item) => !seen.has(refKey(item.handle.handle_ref)))
      .map((item) => ({ candidate_id: item.handle.handle_ref.id, reason_code: OMITTED_REASON_NOT_SELECTED })),
  ];
  const sortedRefs = [...selected].sort(compareRefs).map((ref) => ({ id: ref.id, revision: ref.revision }));
  const identity = {
    protocol: "eliotr.research.branch-role-query-evidence-pack.v1",
    query_result_ref: queryResult.query_result_ref,
    query_result_digest: queryResult.identity_digest,
    role: parsedRole,
    selected_handle_refs: sortedRefs,
  };
  const digest = await evidenceSha256({ domain: "eliotr.branch-role.query-evidence-pack.v1", value: identity });
  const totalUtf8Bytes = resolved.reduce(
    (sum, item) => sum + new TextEncoder().encode(item.exact_excerpt).byteLength,
    0,
  );
  const firstTrace = queryResult.query_legs.find((leg) => leg.trace !== undefined)?.trace;
  if (firstTrace === undefined) invalid("branch query evidence has no completed retrieval trace");
  return Object.freeze({
    pack_ref: { id: `eliotr.branch-role-query-pack-${digest}`, revision: 1 },
    scope_snapshot_ref: { ...queryResult.scope_snapshot_ref },
    resolved_evidence: Object.freeze(resolved),
    omitted_candidates: Object.freeze(omitted),
    // Per-leg traces are retained in the query result; this adapter keeps the first
    // completed trace as the compatibility anchor for existing manifest plumbing.
    trace_ref: { ...firstTrace.trace_ref },
    total_utf8_bytes: totalUtf8Bytes,
  });
}

/**
 * Derives the branch-role reference manifest reference from the role's
 * evidence pack identity. The pack_ref already binds the stage-five pack,
 * the role, and the exact selected handle set, so the manifest reference is
 * deterministic and needs no additional installed value.
 */
export async function deriveBranchRoleManifestRef(
  pack: EvidencePack,
  role: ResearchBranchRole,
): Promise<VersionedRef> {
  if (typeof pack !== "object" || pack === null || typeof pack.pack_ref !== "object" || pack.pack_ref === null) {
    invalid("branch role evidence pack is invalid");
  }
  const parsedRole = ResearchBranchRoleSchema.parse(role);
  return {
    id: `eliotr.reference-manifest-${await evidenceSha256({
      domain: "eliotr.branch-role.manifest-ref.v1",
      value: { pack_ref: pack.pack_ref, role: parsedRole },
    })}`,
    revision: 1,
  };
}
