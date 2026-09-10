import type {
  ErasureReceipt,
  ErasureRequest,
  PurgeLocation,
  ErasureBackend,
  ErasureBlocker,
  ErasureDependencyClosure,
  ErasureFence,
  PurgeTarget,
} from "@eliotr/contracts";
import { describe, expect, it, vi } from "vitest";
import { createErasureCoordinator } from "./erasure-coordinator.js";

const request: ErasureRequest = {
  protocol: "erc.privacy.erasure.v1",
  erasure_ref: { id: "erasure-1", revision: 1 },
  requested_by_principal_ref: "privacy-officer-1",
  exact_subject_refs: ["source-revision:revision-1"],
  required_locations: ["CanonicalPayload", "BackupRestorePath"],
  legal_basis_ref: "delete-request-1",
  admitted_at: "2026-09-01T00:00:00.000Z",
  deadline: "2026-09-08T00:00:00.000Z",
};
const fence: ErasureFence = {
  erasure_id: "erasure-1",
  revision: 1,
  lease_owner: "worker-1",
  lease_generation: 1,
  lease_until_ms: Date.UTC(2026, 8, 1, 1),
};

function target(location: PurgeLocation, id: string): PurgeTarget {
  return {
    target_id: id,
    target_kind: "OBJECT",
    exact_subject_ref: (request.exact_subject_refs[0] ?? (() => { throw new Error("fixture requires one exact subject reference"); })()),
    location,
    canonical_ref: `${location.toLowerCase()}:${id}`,
    identity_digest: id === "target-core" ? "a".repeat(64) : "b".repeat(64),
    shared_live_reference_count: 0,
  };
}
const coreTarget = target("CanonicalPayload", "target-core");
const backupTarget = target("BackupRestorePath", "target-backup");
const closure: ErasureDependencyClosure = {
  erasure_ref: request.erasure_ref,
  request_digest: "c".repeat(64),
  closure_digest: "d".repeat(64),
  targets: [coreTarget, backupTarget],
};

function terminal(
  state: "COMPLETE" | "BLOCKED",
  completed: readonly PurgeLocation[],
  blocked: readonly ErasureBlocker[],
): ErasureReceipt {
  return {
    protocol: "erc.privacy.erasure.v1",
    erasure_ref: request.erasure_ref,
    state,
    requested_locations: [...request.required_locations],
    completed_locations: [...completed],
    blocked_locations: blocked.map((item) => ({
      location: item.location,
      policy_or_hold_ref: item.policy_or_hold_ref,
      next_review_at: item.next_review_at,
    })),
    purge_ledger_entry_ref: "purge-ledger-1",
    issued_at: "2026-09-01T00:10:00.000Z",
  };
}

function backendFixture(input: {
  readonly blockers?: readonly ErasureBlocker[];
  readonly absent?: Readonly<Record<string, boolean>>;
  readonly terminal?: ErasureReceipt;
} = {}) {
  const events: string[] = [];
  const complete = vi.fn(async () => terminal("COMPLETE", request.required_locations, []));
  const block = vi.fn(async (
    _request: ErasureRequest,
    _fence: ErasureFence,
    _closure: ErasureDependencyClosure,
    completedTargets: readonly PurgeTarget[],
    blockers: readonly ErasureBlocker[],
  ) => terminal(
    "BLOCKED",
    request.required_locations.filter((location) =>
      closure.targets.filter((item) => item.location === location)
        .every((item) => completedTargets.some((done) => done.target_id === item.target_id))),
    blockers,
  ));
  const backend: ErasureBackend = {
    acquire: vi.fn(async () => input.terminal === undefined
      ? { disposition: "ACQUIRED" as const, fence }
      : { disposition: "TERMINAL" as const, receipt: input.terminal }),
    quarantineAndRevoke: vi.fn(async () => { events.push("quarantine"); return "quarantine-1"; }),
    advanceLifecycle: vi.fn(async (_r: ErasureRequest, _f: ErasureFence, _expected: string, next: string) => { events.push(next); return `stage-${next}`; }),
    enumerateDependencyClosure: vi.fn(async () => { events.push("closure"); return closure; }),
    checkRetentionAndHolds: vi.fn(async () => { events.push("holds"); return input.blockers ?? []; }),
    recordBlockedTarget: vi.fn(async () => { events.push("blocked-target"); }),
    purge: vi.fn(async (_r: ErasureRequest, _f: ErasureFence, item: PurgeTarget) => {
      events.push(`purge:${item.target_id}`);
      return { target_id: item.target_id, disposition: "DELETE_ACCEPTED" as const, receipt_ref: `delete-${item.target_id}` };
    }),
    verifyAbsent: vi.fn(async (_r: ErasureRequest, _f: ErasureFence, item: PurgeTarget) => {
      events.push(`verify:${item.target_id}`);
      const absent = input.absent?.[item.target_id] ?? true;
      return {
        target_id: item.target_id,
        absent,
        receipt_ref: `absence-${item.target_id}`,
        ...(absent ? {} : { reason_code: "COPY_REMAINS" }),
      };
    }),
    appendNonRevealingLedgerEntry: vi.fn(async () => {
      events.push("ledger");
      return { ledger_entry_ref: "purge-ledger-1", ledger_revision: 1 };
    }),
    invalidateDependents: vi.fn(async () => { events.push("invalidate"); return []; }),
    complete,
    block,
    fail: vi.fn(async () => undefined),
  };
  return { backend, events, complete, block };
}

describe("exact erasure coordinator", () => {
  it("never converts a subset purge into COMPLETE when backup is blocked", async () => {
    const blocker: ErasureBlocker = {
      target_id: backupTarget.target_id,
      location: "BackupRestorePath",
      policy_or_hold_ref: "backup-lock-1",
      next_review_at: "2026-09-07T00:00:00.000Z",
      reason_code: "RETENTION_OR_HOLD_ACTIVE",
    };
    const fixture = backendFixture({ blockers: [blocker] });
    const receipt = await createErasureCoordinator(fixture.backend).execute(request);
    expect(receipt.state).toBe("BLOCKED");
    expect(receipt.completed_locations).toEqual(["CanonicalPayload"]);
    expect(receipt.blocked_locations).toEqual([{
      location: "BackupRestorePath",
      policy_or_hold_ref: "backup-lock-1",
      next_review_at: "2026-09-07T00:00:00.000Z",
    }]);
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.block).toHaveBeenCalledOnce();
    expect(fixture.events).not.toContain(`purge:${backupTarget.target_id}`);
  });

  it("issues COMPLETE only after every exact target has an absence receipt", async () => {
    const fixture = backendFixture();
    const receipt = await createErasureCoordinator(fixture.backend).execute(request);
    expect(receipt.state).toBe("COMPLETE");
    expect(fixture.complete).toHaveBeenCalledOnce();
    expect(fixture.block).not.toHaveBeenCalled();
    expect(fixture.events).toContain(`verify:${backupTarget.target_id}`);
    expect(fixture.events.at(-1)).toBe("invalidate");
  });

  it("blocks when deletion was accepted but exact absence cannot be proven", async () => {
    const fixture = backendFixture({ absent: { [backupTarget.target_id]: false } });
    const receipt = await createErasureCoordinator(fixture.backend).execute(request);
    expect(receipt.state).toBe("BLOCKED");
    expect(receipt.completed_locations).toEqual(["CanonicalPayload"]);
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.block).toHaveBeenCalledOnce();
  });

  it("returns the immutable terminal receipt without repeating physical effects", async () => {
    const prior = terminal("COMPLETE", request.required_locations, []);
    const fixture = backendFixture({ terminal: prior });
    await expect(createErasureCoordinator(fixture.backend).execute(request)).resolves.toEqual(prior);
    expect(fixture.events).toEqual([]);
  });
});
