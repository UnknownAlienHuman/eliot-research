import type {
  ErasureReceipt,
  ErasureRequest,
  PurgeLocation,
  ErasureBackend,
  ErasureBlocker,
  PurgeTarget,
} from "@eliotr/contracts";
import {
  erasureDigest,
  exactLocationEquality,
  validateErasureRequest,
} from "@eliotr/cloudflare-erasure";

export interface ErasureCoordinator {
  execute(request: ErasureRequest): Promise<ErasureReceipt>;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const value = (error as { readonly code?: unknown }).code;
    if (typeof value === "string" && /^[A-Z0-9_]{1,128}$/u.test(value)) return value;
  }
  return "ERASURE_COORDINATOR_FAILED";
}

function addBlocker(
  blockers: Map<string, ErasureBlocker>,
  blocker: ErasureBlocker,
): void {
  const existing = blockers.get(blocker.target_id);
  if (existing === undefined || blocker.reason_code.localeCompare(existing.reason_code) < 0) {
    blockers.set(blocker.target_id, blocker);
  }
}

function completedLocations(
  request: ErasureRequest,
  closureTargets: readonly PurgeTarget[],
  completedTargets: readonly PurgeTarget[],
): readonly PurgeLocation[] {
  const completedIds = new Set(completedTargets.map((target) => target.target_id));
  return request.required_locations
    .filter((location) => {
      const targets = closureTargets.filter((target) => target.location === location);
      return targets.length > 0 && targets.every((target) => completedIds.has(target.target_id));
    })
    .sort();
}

function blockerForTarget(
  request: ErasureRequest,
  target: PurgeTarget,
  reasonCode: string,
): ErasureBlocker {
  return {
    target_id: target.target_id,
    location: target.location,
    policy_or_hold_ref: `erasure-block:${reasonCode.toLowerCase()}`,
    next_review_at: request.deadline,
    reason_code: reasonCode,
  };
}

// IMPLEMENTED_NOT_LIVE: ER-28 exact erasure coordinator
export function createErasureCoordinator(backend: ErasureBackend): ErasureCoordinator {
  return {
    async execute(rawRequest): Promise<ErasureReceipt> {
      const request = validateErasureRequest(rawRequest);
      const acquired = await backend.acquire(request);
      if (acquired.disposition === "TERMINAL") return acquired.receipt;
      const fence = acquired.fence;
      try {
        await backend.quarantineAndRevoke(request, fence);
        const closure = await backend.enumerateDependencyClosure(request, fence);
        const targetIds = new Set<string>();
        for (const target of closure.targets) {
          if (targetIds.has(target.target_id)) {
            throw new Error(`duplicate erasure target ${target.target_id}`);
          }
          targetIds.add(target.target_id);
        }

        const blockers = new Map<string, ErasureBlocker>();
        for (const blocker of await backend.checkRetentionAndHolds(request, fence, closure)) {
          addBlocker(blockers, blocker);
        }
        await backend.advanceLifecycle(
          request,
          fence,
          "CHECK_RETENTION_AND_HOLDS",
          "PURGE_EACH_LOCATION",
          await erasureDigest({ closure: closure.closure_digest, blockers: [...blockers.values()] }),
        );

        const purgeReceipts = new Map<string, Awaited<ReturnType<ErasureBackend["purge"]>>>();
        for (const target of closure.targets) {
          const blocker = blockers.get(target.target_id);
          if (blocker !== undefined) {
            await backend.recordBlockedTarget(request, fence, target, blocker);
            continue;
          }
          const receipt = await backend.purge(request, fence, target);
          purgeReceipts.set(target.target_id, receipt);
          if (receipt.disposition === "BLOCKED") {
            const dynamic = blockerForTarget(
              request,
              target,
              receipt.reason_code ?? "LOCATION_DELETE_BLOCKED",
            );
            addBlocker(blockers, dynamic);
            await backend.recordBlockedTarget(request, fence, target, dynamic);
          }
        }

        await backend.advanceLifecycle(
          request,
          fence,
          "PURGE_EACH_LOCATION",
          "VERIFY_ABSENCE_OR_BLOCK",
          await erasureDigest([...purgeReceipts.values()]),
        );
        const completedTargets: PurgeTarget[] = [];
        for (const target of closure.targets) {
          if (blockers.has(target.target_id)) continue;
          const purgeReceipt = purgeReceipts.get(target.target_id);
          if (purgeReceipt === undefined) {
            const missing = blockerForTarget(request, target, "PURGE_RECEIPT_MISSING");
            addBlocker(blockers, missing);
            await backend.recordBlockedTarget(request, fence, target, missing);
            continue;
          }
          const absence = await backend.verifyAbsent(request, fence, target, purgeReceipt);
          if (absence.absent) {
            completedTargets.push(target);
            continue;
          }
          const unproven = blockerForTarget(
            request,
            target,
            absence.reason_code ?? "ABSENCE_UNPROVEN",
          );
          addBlocker(blockers, unproven);
          await backend.recordBlockedTarget(request, fence, target, unproven);
        }

        const completed = completedLocations(request, closure.targets, completedTargets);
        if (!exactLocationEquality(request.required_locations, completed) && blockers.size === 0) {
          for (const location of request.required_locations) {
            if (completed.includes(location)) continue;
            const target = closure.targets.find((candidate) => candidate.location === location);
            if (target !== undefined) addBlocker(blockers, blockerForTarget(request, target, "LOCATION_INCOMPLETE"));
          }
        }

        await backend.advanceLifecycle(
          request,
          fence,
          "VERIFY_ABSENCE_OR_BLOCK",
          "APPEND_PURGE_LEDGER",
          await erasureDigest({
            closure: closure.closure_digest,
            completed_target_ids: completedTargets.map((target) => target.target_id).sort(),
            blockers: [...blockers.values()],
          }),
        );
        const blockerList = [...blockers.values()].sort((left, right) =>
          `${left.location}:${left.target_id}`.localeCompare(`${right.location}:${right.target_id}`));
        const ledger = await backend.appendNonRevealingLedgerEntry(
          request,
          fence,
          closure,
          completedTargets,
          blockerList,
        );

        await backend.advanceLifecycle(
          request,
          fence,
          "APPEND_PURGE_LEDGER",
          "INVALIDATE_DEPENDENTS",
          await erasureDigest(ledger),
        );
        await backend.invalidateDependents(
          request,
          fence,
          closure,
          ledger.ledger_entry_ref,
        );

        const complete = blockerList.length === 0 &&
          exactLocationEquality(request.required_locations, completed);
        return complete
          ? backend.complete(request, fence, closure, completedTargets, ledger)
          : backend.block(request, fence, closure, completedTargets, blockerList, ledger);
      } catch (error) {
        try { await backend.fail(request, fence, errorCode(error)); }
        catch { /* preserve the original erasure failure */ }
        throw error;
      }
    },
  };
}
