import type { PurgeTarget } from "@eliotr/contracts";
import {
  assertErasureText,
  erasureFail,
} from "./canonical.js";
import { referencesForKey } from "./raw-ingest-inventory.js";

const R2_EVIDENCE_PREFIX = "r2-evidence:";

export interface RawPendingTargetOptions {
  readonly retention_or_hold_ref: string;
  readonly next_review_at: string;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function earlierPending(
  current: RawPendingTargetOptions | undefined,
  candidate: RawPendingTargetOptions,
): RawPendingTargetOptions {
  return current === undefined || compare(candidate.next_review_at, current.next_review_at) < 0 ? candidate : current;
}

/** Returns the exact evidence-bucket key for a canonical R2 target. */
export function evidenceR2Key(canonicalRef: string): string | undefined {
  if (!canonicalRef.startsWith(R2_EVIDENCE_PREFIX)) return undefined;
  return assertErasureText(canonicalRef.slice(R2_EVIDENCE_PREFIX.length), "R2 Evidence key", 1024);
}

function earliestReview(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return compare(left, right) <= 0 ? left : right;
}

function smallestRef(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return compare(left, right) <= 0 ? left : right;
}

export function applyPending(
  target: PurgeTarget,
  pending: RawPendingTargetOptions | undefined,
): PurgeTarget {
  if (pending === undefined) return target;
  const review = earliestReview(target.next_review_at, pending.next_review_at);
  return {
    ...target,
    ...(target.retention_or_hold_ref === undefined
      ? { retention_or_hold_ref: pending.retention_or_hold_ref }
      : {}),
    ...(review === undefined
      ? {}
      : { next_review_at: review }),
  };
}

function mergeBlockerMetadata(left: PurgeTarget, right: PurgeTarget): {
  readonly retention_or_hold_ref?: string;
  readonly next_review_at?: string;
} {
  const retention = smallestRef(left.retention_or_hold_ref, right.retention_or_hold_ref);
  const review = earliestReview(left.next_review_at, right.next_review_at);
  return {
    ...(retention === undefined ? {} : { retention_or_hold_ref: retention }),
    ...(review === undefined ? {} : { next_review_at: review }),
  };
}

/**
 * Merges targets that name one physical R2 object. Subject identity is an
 * erasure attribution, so it is chosen deterministically for one object;
 * provider identity and same-subject identity conflicts remain fatal.
 */
export function mergeTarget(existing: PurgeTarget, candidate: PurgeTarget): PurgeTarget {
  const existingKey = existing.location === "Blob" ? evidenceR2Key(existing.canonical_ref) : undefined;
  const candidateKey = candidate.location === "Blob" ? evidenceR2Key(candidate.canonical_ref) : undefined;
  const physicalR2 = existingKey !== undefined && candidateKey !== undefined;
  if (physicalR2) {
    if (existing.target_kind !== candidate.target_kind || existingKey !== candidateKey ||
        existing.provider_ref !== candidate.provider_ref || existing.provider_ref !== undefined ||
        (existing.exact_subject_ref === candidate.exact_subject_ref && existing.identity_digest !== candidate.identity_digest)) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "one R2 evidence target has conflicting physical identity");
    }
    const owner = compare(existing.exact_subject_ref, candidate.exact_subject_ref) <= 0 ? existing : candidate;
    return {
      ...owner,
      shared_live_reference_count: Math.max(existing.shared_live_reference_count, candidate.shared_live_reference_count),
      ...mergeBlockerMetadata(existing, candidate),
    };
  }
  if (existing.exact_subject_ref !== candidate.exact_subject_ref || existing.identity_digest !== candidate.identity_digest) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "one erasure target has conflicting exact identities");
  }
  return {
    ...existing,
    shared_live_reference_count: Math.max(existing.shared_live_reference_count, candidate.shared_live_reference_count),
    ...mergeBlockerMetadata(existing, candidate),
  };
}

export async function refreshR2SharedReferenceCount(
  database: D1Database,
  target: PurgeTarget,
  selectedSourceRevisionRefs: ReadonlySet<string>,
  cache: Map<string, number>,
): Promise<PurgeTarget> {
  if (target.location !== "Blob") return target;
  const key = evidenceR2Key(target.canonical_ref);
  if (key === undefined) return target;
  const cached = cache.get(key);
  const count = cached === undefined
    ? await referencesForKey(database, key, selectedSourceRevisionRefs)
    : cached;
  if (cached === undefined) cache.set(key, count);
  return {
    ...target,
    // Registry entries may also carry a live dependency count computed from
    // their retained registry references.  Keep the conservative union.
    shared_live_reference_count: Math.max(target.shared_live_reference_count, count),
  };
}
