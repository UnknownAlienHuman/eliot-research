import type {
  ErasureBackend,
  ErasureBlocker,
  ErasureDependencyClosure,
  ErasureRequest,
  PurgeAttemptReceipt,
  PurgeTarget,
} from "@eliotr/contracts";
import {
  erasureDigest,
  erasureFail,
  isoFromMs,
  parseErasureSubject,
  stableErasureId,
  validateErasureRequest,
} from "./canonical.js";
import type {
  ErasureAuthorityPort,
  ErasureInvalidationPort,
  ErasureInventoryPort,
  ErasureLocationRegistry,
} from "./types.js";

async function sourceRevisionRefs(
  database: D1Database,
  request: ErasureRequest,
): Promise<readonly string[]> {
  const output = new Set<string>();
  for (const exactSubjectRef of request.exact_subject_refs) {
    const subject = parseErasureSubject(exactSubjectRef);
    if (subject.kind === "source_revision") output.add(subject.source_revision_ref);
    if (subject.kind === "source") {
      const result = await database.prepare(
        "SELECT source_revision_ref FROM source_revision WHERE source_id=?1 " +
        "ORDER BY source_revision_ref LIMIT 10000",
      ).bind(subject.source_id).all<{ source_revision_ref: string }>();
      if ((result as { readonly success?: boolean }).success === false) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "source quarantine inventory failed", true);
      }
      for (const row of result.results ?? []) output.add(row.source_revision_ref);
    }
  }
  return [...output];
}

async function quarantine(
  database: D1Database,
  request: ErasureRequest,
  receiptRef: string,
  now: string,
): Promise<void> {
  for (const revisionRef of await sourceRevisionRefs(database, request)) {
    await database.batch([
      database.prepare(
        "UPDATE source_revision SET purge_state='PURGE_REQUESTED',currentness_state='unknown' " +
        "WHERE source_revision_ref=?1 AND purge_state IN ('LIVE','QUARANTINED','PURGE_REQUESTED')",
      ).bind(revisionRef),
      database.prepare(
        "UPDATE source_readiness SET state='redacted',reason_codes_json=" +
        "'[\"ERASURE_QUARANTINE\"]',receipt_ref=?2,updated_at=?3 " +
        "WHERE source_revision_ref=?1",
      ).bind(revisionRef, receiptRef, now),
      database.prepare(
        "UPDATE evidence_handle SET terminal_state='REDACTED',invalidation_ref=?2 " +
        "WHERE source_revision_ref=?1 AND terminal_state IN ('LIVE','STALE','COLD_RESTORABLE')",
      ).bind(revisionRef, receiptRef),
      database.prepare(
        "UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,?2)," +
        "invalidation_reason='ERASURE_QUARANTINE' WHERE EXISTS " +
        "(SELECT 1 FROM json_each(member_source_revision_refs_json) WHERE value=?1)",
      ).bind(revisionRef, now),
    ]);
  }
  for (const exactSubjectRef of request.exact_subject_refs) {
    const subject = parseErasureSubject(exactSubjectRef);
    if (subject.kind === "evidence_handle") {
      await database.prepare(
        "UPDATE evidence_handle SET terminal_state='REDACTED',invalidation_ref=?3 " +
        "WHERE handle_id=?1 AND revision=?2 AND terminal_state<>'RETENTION_BLOCKED'",
      ).bind(subject.handle_id, subject.revision, receiptRef).run();
    }
    if (subject.kind === "scope_snapshot") {
      await database.batch([
        database.prepare(
          "UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,?3)," +
          "invalidation_reason='ERASURE_QUARANTINE' WHERE snapshot_id=?1 AND revision=?2",
        ).bind(subject.snapshot_id, subject.revision, now),
        database.prepare(
          "UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 " +
          "AND snapshot_revision=?2 AND state='ACTIVE'",
        ).bind(subject.snapshot_id, subject.revision),
      ]);
    }
  }
  await database.prepare(
    "UPDATE scope_access_grant SET state='REVOKED' WHERE state='ACTIVE' AND EXISTS " +
    "(SELECT 1 FROM scope_snapshot s WHERE s.snapshot_id=scope_access_grant.snapshot_id " +
    "AND s.revision=scope_access_grant.snapshot_revision AND s.invalidated_at IS NOT NULL)",
  ).run();
}

function unavailableBlocker(target: PurgeTarget, request: ErasureRequest): ErasureBlocker {
  return {
    target_id: target.target_id,
    location: target.location,
    policy_or_hold_ref: `unavailable:${target.location}`,
    next_review_at: request.deadline,
    reason_code: "LOCATION_ADAPTER_UNAVAILABLE",
  };
}

function failureReasonCode(cause: unknown, fallback: string): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(code)) return code;
  }
  return fallback;
}

export interface CloudflareErasureBackendDependencies {
  readonly core_database: D1Database;
  readonly authority: ErasureAuthorityPort;
  readonly inventory: ErasureInventoryPort;
  readonly locations: ErasureLocationRegistry;
  readonly invalidation: ErasureInvalidationPort;
  readonly now?: () => number;
}

export function createCloudflareErasureBackend(
  dependencies: CloudflareErasureBackendDependencies,
): ErasureBackend {
  const clock = dependencies.now ?? Date.now;
  const advanceLifecycle: ErasureBackend["advanceLifecycle"] = async (
    request,
    fence,
    expectedState,
    nextState,
    payloadDigest,
  ) => {
    const receiptRef = await stableErasureId(
      "erasure-stage",
      request.erasure_ref.id,
      String(request.erasure_ref.revision),
      nextState,
      payloadDigest,
    );
    await dependencies.authority.advance(fence, expectedState, nextState, receiptRef, payloadDigest);
    return receiptRef;
  };
  return {
    acquire(request) {
      return dependencies.authority.acquire(validateErasureRequest(request));
    },

    async quarantineAndRevoke(request, fence) {
      await dependencies.authority.assertFence(fence);
      const receiptRef = await stableErasureId(
        "erasure-quarantine",
        request.erasure_ref.id,
        String(request.erasure_ref.revision),
        await erasureDigest(request.exact_subject_refs),
      );
      await quarantine(dependencies.core_database, request, receiptRef, isoFromMs(clock()));
      await dependencies.authority.advance(
        fence,
        "REQUESTED",
        "QUARANTINE_AND_REVOKE",
        receiptRef,
        await erasureDigest({ exact_subject_refs: request.exact_subject_refs, receipt_ref: receiptRef }),
      );
      return receiptRef;
    },

    advanceLifecycle,

    async enumerateDependencyClosure(request, fence): Promise<ErasureDependencyClosure> {
      await dependencies.authority.assertFence(fence);
      const closure = await dependencies.inventory.enumerate(request);
      if (
        closure.erasure_ref.id !== request.erasure_ref.id ||
        closure.erasure_ref.revision !== request.erasure_ref.revision ||
        closure.targets.length === 0
      ) {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "erasure closure is not bound to the request");
      }
      for (const location of request.required_locations) {
        if (!closure.targets.some((target) => target.location === location)) {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", `erasure closure omitted ${location}`);
        }
      }
      await dependencies.authority.persistClosure(fence, closure);
      await advanceLifecycle(
        request,
        fence,
        "QUARANTINE_AND_REVOKE",
        "ENUMERATE_DEPENDENCY_CLOSURE",
        closure.closure_digest,
      );
      return closure;
    },

    async checkRetentionAndHolds(request, fence, closure) {
      const blockers = await dependencies.authority.blockersFor(request, fence, closure);
      await advanceLifecycle(
        request,
        fence,
        "ENUMERATE_DEPENDENCY_CLOSURE",
        "CHECK_RETENTION_AND_HOLDS",
        await erasureDigest(blockers),
      );
      return blockers;
    },

    recordBlockedTarget(_request, fence, target, blocker) {
      return dependencies.authority.recordBlockedTarget(fence, target, blocker);
    },

    async purge(request, fence, target): Promise<PurgeAttemptReceipt> {
      await dependencies.authority.assertFence(fence);
      const adapter = dependencies.locations.forLocation(target.location);
      if (adapter === null) {
        const blocker = unavailableBlocker(target, request);
        const receipt: PurgeAttemptReceipt = {
          target_id: target.target_id,
          disposition: "BLOCKED",
          receipt_ref: await stableErasureId("delete-blocked", target.target_id, blocker.reason_code),
          reason_code: blocker.reason_code,
        };
        await dependencies.authority.recordPurge(fence, receipt);
        return receipt;
      }
      try {
        const receipt = await adapter.purge(request, fence, target);
        await dependencies.authority.recordPurge(fence, receipt);
        return receipt;
      } catch (cause) {
        const receipt: PurgeAttemptReceipt = {
          target_id: target.target_id,
          disposition: "BLOCKED",
          receipt_ref: await stableErasureId("delete-blocked", target.target_id, "LOCATION_DELETE_FAILED"),
          reason_code: failureReasonCode(cause, "LOCATION_DELETE_FAILED"),
        };
        await dependencies.authority.recordPurge(fence, receipt);
        return receipt;
      }
    },

    async verifyAbsent(request, fence, target, purgeReceipt) {
      await dependencies.authority.assertFence(fence);
      const adapter = dependencies.locations.forLocation(target.location);
      if (adapter === null || purgeReceipt.disposition === "BLOCKED") {
        const receipt = {
          target_id: target.target_id,
          absent: false,
          receipt_ref: await stableErasureId("absence-blocked", target.target_id),
          reason_code: "LOCATION_ADAPTER_UNAVAILABLE",
        } as const;
        await dependencies.authority.recordAbsence(fence, receipt);
        return receipt;
      }
      try {
        const receipt = await adapter.verifyAbsent(request, fence, target, purgeReceipt);
        await dependencies.authority.recordAbsence(fence, receipt);
        return receipt;
      } catch (cause) {
        const receipt = {
          target_id: target.target_id,
          absent: false,
          receipt_ref: await stableErasureId("absence-failed", target.target_id),
          reason_code: failureReasonCode(cause, "ABSENCE_READBACK_FAILED"),
        } as const;
        await dependencies.authority.recordAbsence(fence, receipt);
        return receipt;
      }
    },

    appendNonRevealingLedgerEntry(request, fence, closure, completedTargets, blockers) {
      return dependencies.authority.appendLedger(
        request,
        fence,
        closure,
        completedTargets,
        blockers,
      );
    },

    async invalidateDependents(request, fence, closure, ledgerEntryRef) {
      const invalidations = await dependencies.invalidation.invalidate(
        request,
        fence,
        closure,
        ledgerEntryRef,
      );
      await dependencies.authority.recordInvalidations(fence, invalidations);
      return invalidations.map((item) => item.dependent_ref);
    },

    complete(request, fence, closure, completedTargets, ledger) {
      return dependencies.authority.settle(
        request,
        fence,
        closure,
        completedTargets,
        [],
        ledger,
      );
    },

    block(request, fence, closure, completedTargets, blockers, ledger) {
      return dependencies.authority.settle(
        request,
        fence,
        closure,
        completedTargets,
        blockers,
        ledger,
      );
    },

    fail(_request, fence, errorCode) {
      return dependencies.authority.fail(fence, errorCode);
    },
  };
}
