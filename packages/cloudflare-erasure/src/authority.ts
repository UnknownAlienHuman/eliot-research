import {
  ErasureReceiptSchema,
  type ErasureBlocker,
  type ErasureFence,
  type ErasureReceipt,
  type ErasureRequest,
  type PurgeTarget,
} from "@eliotr/contracts";
import {
  canonicalErasureJson,
  erasureFail,
  erasureSha256Utf8,
  isoFromMs,
  validateErasureRequest,
} from "./canonical.js";
import { resetErasureAttempt } from "./authority-reset.js";
import { appendPurgeLedger } from "./ledger.js";
import type {
  ErasureAuthorityPort,
} from "./types.js";
interface ExecutionRow {
  readonly request_json: unknown;
  readonly request_sha256: unknown;
  readonly state: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
  readonly closure_digest: unknown;
  readonly terminal_receipt_json: unknown;
  readonly terminal_receipt_sha256: unknown;
}
interface LeaseRow {
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
}
interface HoldRow {
  readonly hold_ref: unknown;
  readonly exact_subject_ref: unknown;
  readonly location: unknown;
  readonly canonical_ref: unknown;
  readonly policy_or_hold_ref: unknown;
  readonly next_review_at: unknown;
}
function validLeaseRow(row: LeaseRow): ErasureFence {
  if (
    typeof row.lease_owner !== "string" ||
    typeof row.lease_generation !== "number" ||
    !Number.isSafeInteger(row.lease_generation) ||
    row.lease_generation < 1 ||
    typeof row.lease_until !== "number" ||
    !Number.isSafeInteger(row.lease_until) ||
    row.lease_until < 0
  ) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "D1 returned a malformed erasure lease");
  }
  return {
    erasure_id: "",
    revision: 0,
    lease_owner: row.lease_owner,
    lease_generation: row.lease_generation,
    lease_until_ms: row.lease_until,
  };
}
async function loadExecution(
  database: D1Database,
  request: ErasureRequest,
): Promise<ExecutionRow | null> {
  return database.prepare(
    "SELECT request_json,request_sha256,state,lease_owner,lease_generation,lease_until," +
    "closure_digest,terminal_receipt_json,terminal_receipt_sha256 FROM erasure_execution " +
    "WHERE erasure_id=?1 AND revision=?2 LIMIT 1",
  ).bind(request.erasure_ref.id, request.erasure_ref.revision).first<ExecutionRow>();
}
async function decodeTerminal(row: ExecutionRow): Promise<ErasureReceipt | null> {
  if (row.state !== "COMPLETE" && row.state !== "BLOCKED") return null;
  if (
    typeof row.terminal_receipt_json !== "string" ||
    typeof row.terminal_receipt_sha256 !== "string"
  ) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "terminal erasure receipt is incomplete", true);
  }
  let receipt: ErasureReceipt;
  try {
    const raw = JSON.parse(row.terminal_receipt_json) as unknown;
    if (canonicalErasureJson(raw) !== row.terminal_receipt_json) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "terminal erasure receipt is not canonical");
    }
    receipt = ErasureReceiptSchema.parse(raw);
  } catch (cause) {
    if (cause instanceof Error && cause.name === "ErasureRuntimeError") throw cause;
    erasureFail("ERASURE_IDENTITY_CONFLICT", "terminal erasure receipt is malformed", false, cause);
  }
  if (await erasureSha256Utf8(row.terminal_receipt_json) !== row.terminal_receipt_sha256) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "terminal erasure receipt digest mismatch");
  }
  return receipt;
}
function exactRequest(row: ExecutionRow, requestJson: string, requestSha: string): void {
  if (row.request_json !== requestJson || row.request_sha256 !== requestSha) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "erasure_ref is already bound to another exact request");
  }
}
async function exactStageReceipt(
  database: D1Database,
  fence: ErasureFence,
  stage: string,
  receiptRef: string,
  payloadDigest: string,
  now: string,
): Promise<void> {
  const result = await database.prepare(
    "INSERT INTO erasure_stage_receipt(erasure_id,erasure_revision,stage,lease_generation," +
    "receipt_ref,payload_digest,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7) " +
    "ON CONFLICT(erasure_id,erasure_revision,stage) DO UPDATE SET " +
    "lease_generation=excluded.lease_generation,created_at=excluded.created_at " +
    "WHERE erasure_stage_receipt.receipt_ref=excluded.receipt_ref " +
    "AND erasure_stage_receipt.payload_digest=excluded.payload_digest RETURNING receipt_ref",
  ).bind(
    fence.erasure_id,
    fence.revision,
    stage,
    fence.lease_generation,
    receiptRef,
    payloadDigest,
    now,
  ).first<{ receipt_ref: string }>();
  if (result?.receipt_ref !== receiptRef) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", `erasure stage ${stage} has conflicting receipt authority`);
  }
}
function blockerMatches(target: PurgeTarget, row: HoldRow): boolean {
  const subject = row.exact_subject_ref === null || row.exact_subject_ref === target.exact_subject_ref;
  const location = row.location === null || row.location === target.location;
  const canonical = row.canonical_ref === null || row.canonical_ref === target.canonical_ref;
  return subject && location && canonical;
}
export interface D1ErasureAuthorityDependencies {
  readonly core_database: D1Database;
  readonly worker_id?: string;
  readonly lease_ms?: number;
  readonly now?: () => number;
}
export function createD1ErasureAuthority(
  dependencies: D1ErasureAuthorityDependencies,
): ErasureAuthorityPort {
  const database = dependencies.core_database;
  const workerId = dependencies.worker_id ?? "eliotr-erasure-coordinator";
  const leaseMs = dependencies.lease_ms ?? 5 * 60_000;
  const clock = dependencies.now ?? Date.now;
  const assertFence = async (fence: ErasureFence): Promise<void> => {
    const row = await database.prepare(
      "SELECT lease_owner,lease_generation,lease_until FROM erasure_execution " +
      "WHERE erasure_id=?1 AND revision=?2 AND lease_owner=?3 AND lease_generation=?4 " +
      "AND lease_until>?5 AND state NOT IN ('COMPLETE','BLOCKED') LIMIT 1",
    ).bind(
      fence.erasure_id,
      fence.revision,
      fence.lease_owner,
      fence.lease_generation,
      clock(),
    ).first<LeaseRow>();
    if (row === null) erasureFail("ERASURE_LEASE_LOST", "erasure execution fence is stale", true);
  };
  return {
    async acquire(rawRequest) {
      const request = validateErasureRequest(rawRequest);
      const requestJson = canonicalErasureJson(request);
      const requestSha = await erasureSha256Utf8(requestJson);
      let existing = await loadExecution(database, request);
      if (existing === null) {
        const now = isoFromMs(clock());
        try {
          await database.batch([
            database.prepare(
              "INSERT INTO erasure_case(erasure_id,revision,state,exact_subject_refs_json," +
              "requested_locations_json,completed_locations_json,blocked_locations_json," +
              "legal_basis_ref,deadline,created_at,updated_at) VALUES " +
              "(?1,?2,'REQUESTED',?3,?4,'[]','[]',?5,?6,?7,?7)",
            ).bind(
              request.erasure_ref.id,
              request.erasure_ref.revision,
              canonicalErasureJson(request.exact_subject_refs),
              canonicalErasureJson(request.required_locations),
              request.legal_basis_ref,
              request.deadline,
              now,
            ),
            database.prepare(
              "INSERT INTO erasure_execution(erasure_id,revision,request_json,request_sha256," +
              "state,created_at,updated_at) VALUES (?1,?2,?3,?4,'REQUESTED',?5,?5)",
            ).bind(
              request.erasure_ref.id,
              request.erasure_ref.revision,
              requestJson,
              requestSha,
              now,
            ),
          ]);
        } catch (cause) {
          existing = await loadExecution(database, request);
          if (existing === null) {
            erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure request write acknowledgement was lost", true, cause);
          }
        }
        existing = await loadExecution(database, request);
      }
      if (existing === null) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure request authority is absent after admission", true);
      }
      exactRequest(existing, requestJson, requestSha);
      const terminal = await decodeTerminal(existing);
      if (terminal !== null) return { disposition: "TERMINAL", receipt: terminal };
      const nowMs = clock();
      const leaseUntil = nowMs + leaseMs;
      const row = await database.prepare(
        "UPDATE erasure_execution SET lease_owner=?3,lease_generation=lease_generation+1," +
        "lease_until=?4,state='REQUESTED',closure_digest=NULL,last_error_code=NULL,updated_at=?5 " +
        "WHERE erasure_id=?1 AND revision=?2 " +
        "AND state NOT IN ('COMPLETE','BLOCKED') " +
        "AND (lease_owner IS NULL OR lease_until<=?6 OR lease_owner=?3) " +
        "RETURNING lease_owner,lease_generation,lease_until",
      ).bind(
        request.erasure_ref.id,
        request.erasure_ref.revision,
        workerId,
        leaseUntil,
        isoFromMs(nowMs),
        nowMs,
      ).first<LeaseRow>();
      if (row === null) {
        erasureFail("ERASURE_LEASE_LOST", "another coordinator owns the erasure execution lease", true);
      }
      const decoded = validLeaseRow(row);
      const fence = {
        ...decoded,
        erasure_id: request.erasure_ref.id,
        revision: request.erasure_ref.revision,
      };
      await resetErasureAttempt(database, fence, isoFromMs(nowMs));
      return { disposition: "ACQUIRED", fence };
    },
    assertFence,
    async advance(fence, expectedState, nextState, receiptRef, payloadDigest) {
      await assertFence(fence);
      const now = isoFromMs(clock());
      const row = await database.prepare(
        "UPDATE erasure_execution SET state=?6,updated_at=?7 WHERE erasure_id=?1 AND revision=?2 " +
        "AND lease_owner=?3 AND lease_generation=?4 AND lease_until>?5 AND state=?8 " +
        "RETURNING state",
      ).bind(
        fence.erasure_id,
        fence.revision,
        fence.lease_owner,
        fence.lease_generation,
        clock(),
        nextState,
        now,
        expectedState,
      ).first<{ state: string }>();
      if (row?.state !== nextState) {
        const current = await database.prepare(
          "SELECT state FROM erasure_execution WHERE erasure_id=?1 AND revision=?2",
        ).bind(fence.erasure_id, fence.revision).first<{ state: string }>();
        if (current?.state !== nextState) {
          erasureFail("ERASURE_LEASE_LOST", `cannot advance erasure from ${expectedState} to ${nextState}`, true);
        }
      }
      await exactStageReceipt(database, fence, nextState, receiptRef, payloadDigest, now);
      await database.prepare(
        "UPDATE erasure_case SET state=?3,updated_at=?4 WHERE erasure_id=?1 AND revision=?2",
      ).bind(fence.erasure_id, fence.revision, nextState, now).run();
    },
    async persistClosure(fence, closure) {
      await assertFence(fence);
      const now = isoFromMs(clock());
      const statements: D1PreparedStatement[] = closure.targets.map((target) => database.prepare(
        "INSERT INTO erasure_target(erasure_id,erasure_revision,target_id,target_kind," +
        "exact_subject_ref,location,canonical_ref,provider_ref,identity_digest," +
        "shared_live_reference_count,retention_or_hold_ref,next_review_at,state,updated_at) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'ENUMERATED',?13) " +
        "ON CONFLICT(erasure_id,erasure_revision,target_id) DO UPDATE SET updated_at=excluded.updated_at " +
        "WHERE erasure_target.location=excluded.location " +
        "AND erasure_target.canonical_ref=excluded.canonical_ref " +
        "AND erasure_target.identity_digest=excluded.identity_digest",
      ).bind(
        fence.erasure_id,
        fence.revision,
        target.target_id,
        target.target_kind,
        target.exact_subject_ref,
        target.location,
        target.canonical_ref,
        target.provider_ref ?? null,
        target.identity_digest,
        target.shared_live_reference_count,
        target.retention_or_hold_ref ?? null,
        target.next_review_at ?? null,
        now,
      ));
      statements.push(database.prepare(
        "UPDATE erasure_execution SET closure_digest=?5,updated_at=?6 WHERE erasure_id=?1 " +
        "AND revision=?2 AND lease_owner=?3 AND lease_generation=?4",
      ).bind(
        fence.erasure_id,
        fence.revision,
        fence.lease_owner,
        fence.lease_generation,
        closure.closure_digest,
        now,
      ));
      await database.batch(statements);
      const count = await database.prepare(
        "SELECT COUNT(*) AS count FROM erasure_target WHERE erasure_id=?1 AND erasure_revision=?2",
      ).bind(fence.erasure_id, fence.revision).first<{ count: number }>();
      if (count?.count !== closure.targets.length) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure closure target readback count mismatch", true);
      }
    },
    async blockersFor(request, fence, closure) {
      await assertFence(fence);
      const rows = await database.prepare(
        "SELECT hold_ref,exact_subject_ref,location,canonical_ref,policy_or_hold_ref,next_review_at " +
        "FROM erasure_hold WHERE state='ACTIVE' ORDER BY hold_ref LIMIT 10000",
      ).all<HoldRow>();
      if ((rows as { readonly success?: boolean }).success === false) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure hold query failed", true);
      const blockers: ErasureBlocker[] = [];
      for (const target of closure.targets) {
        if (target.shared_live_reference_count > 0) {
          blockers.push({
            target_id: target.target_id,
            location: target.location,
            policy_or_hold_ref: "shared-live-reference",
            next_review_at: request.deadline,
            reason_code: "SHARED_LIVE_REFERENCE",
          });
          continue;
        }
        if (target.retention_or_hold_ref !== undefined) {
          blockers.push({
            target_id: target.target_id,
            location: target.location,
            policy_or_hold_ref: target.retention_or_hold_ref,
            next_review_at: target.next_review_at ?? request.deadline,
            reason_code: "RETENTION_OR_HOLD_ACTIVE",
          });
          continue;
        }
        for (const row of rows.results ?? []) {
          if (!blockerMatches(target, row)) continue;
          if (typeof row.policy_or_hold_ref !== "string" || typeof row.next_review_at !== "string") {
            erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure hold is malformed");
          }
          blockers.push({
            target_id: target.target_id,
            location: target.location,
            policy_or_hold_ref: row.policy_or_hold_ref,
            next_review_at: row.next_review_at,
            reason_code: "RETENTION_OR_HOLD_ACTIVE",
          });
          break;
        }
      }
      return blockers;
    },
    async recordBlockedTarget(fence, target, blocker) {
      await assertFence(fence);
      const row = await database.prepare(
        "UPDATE erasure_target SET state='BLOCKED',retention_or_hold_ref=?4,next_review_at=?5," +
        "last_error_code=?6,updated_at=?7 WHERE erasure_id=?1 AND erasure_revision=?2 " +
        "AND target_id=?3 AND state IN ('ENUMERATED','QUARANTINED','PURGE_REQUESTED','FAILED','BLOCKED') RETURNING target_id",
      ).bind(
        fence.erasure_id,
        fence.revision,
        target.target_id,
        blocker.policy_or_hold_ref,
        blocker.next_review_at,
        blocker.reason_code,
        isoFromMs(clock()),
      ).first<{ target_id: string }>();
      if (row?.target_id !== target.target_id) {
        erasureFail("ERASURE_LEASE_LOST", "blocked erasure target lost its execution fence", true);
      }
    },
    async recordPurge(fence, receipt) {
      await assertFence(fence);
      const state = receipt.disposition === "BLOCKED" ? "BLOCKED" : "PURGE_REQUESTED";
      const row = await database.prepare(
        "UPDATE erasure_target SET state=?4,delete_receipt_ref=?5,last_error_code=?6,updated_at=?7 " +
        "WHERE erasure_id=?1 AND erasure_revision=?2 AND target_id=?3 " +
        "AND state IN ('ENUMERATED','QUARANTINED','PURGE_REQUESTED','BLOCKED') RETURNING target_id",
      ).bind(
        fence.erasure_id,
        fence.revision,
        receipt.target_id,
        state,
        receipt.receipt_ref,
        receipt.reason_code ?? null,
        isoFromMs(clock()),
      ).first<{ target_id: string }>();
      if (row?.target_id !== receipt.target_id) {
        erasureFail("ERASURE_LEASE_LOST", "erasure purge receipt could not be fenced", true);
      }
    },
    async recordAbsence(fence, receipt) {
      await assertFence(fence);
      const state = receipt.absent ? "ABSENT" : "FAILED";
      const row = await database.prepare(
        "UPDATE erasure_target SET state=?4,absence_receipt_ref=?5,last_error_code=?6,updated_at=?7 " +
        "WHERE erasure_id=?1 AND erasure_revision=?2 AND target_id=?3 " +
        "AND state IN ('PURGE_REQUESTED','ABSENT','FAILED') RETURNING target_id",
      ).bind(
        fence.erasure_id,
        fence.revision,
        receipt.target_id,
        state,
        receipt.receipt_ref,
        receipt.reason_code ?? null,
        isoFromMs(clock()),
      ).first<{ target_id: string }>();
      if (row?.target_id !== receipt.target_id) {
        erasureFail("ERASURE_LEASE_LOST", "erasure absence receipt could not be fenced", true);
      }
    },
    async appendLedger(request, fence, closure, completedTargets, blockers) {
      await assertFence(fence);
      return appendPurgeLedger(
        database,
        request,
        closure,
        completedTargets,
        blockers,
        clock(),
      );
    },
    async recordInvalidations(fence, invalidations) {
      await assertFence(fence);
      const now = isoFromMs(clock());
      await database.batch(invalidations.map((item) => database.prepare(
        "INSERT INTO erasure_dependent_invalidation(erasure_id,erasure_revision,dependent_ref," +
        "dependent_kind,disposition,receipt_ref,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7) " +
        "ON CONFLICT(erasure_id,erasure_revision,dependent_ref) DO UPDATE SET " +
        "dependent_kind=excluded.dependent_kind,disposition=excluded.disposition," +
        "receipt_ref=excluded.receipt_ref WHERE " +
        "erasure_dependent_invalidation.receipt_ref=excluded.receipt_ref",
      ).bind(
        fence.erasure_id,
        fence.revision,
        item.dependent_ref,
        item.dependent_kind,
        item.disposition,
        item.receipt_ref,
        now,
      )));
    },
    async settle(request, fence, closure, completedTargets, blockers, ledger) {
      await assertFence(fence);
      const requestedLocations = [...request.required_locations].sort();
      const completedLocations = requestedLocations.filter((location) => {
        const targets = closure.targets.filter((target) => target.location === location);
        return targets.length > 0 && targets.every((target) =>
          completedTargets.some((completed) => completed.target_id === target.target_id));
      });
      const blockedByLocation = new Map<string, ErasureBlocker>();
      for (const blocker of blockers) {
        if (!blockedByLocation.has(blocker.location)) blockedByLocation.set(blocker.location, blocker);
      }
      const blockedLocations = [...blockedByLocation.values()]
        .sort((left, right) => left.location.localeCompare(right.location))
        .map((blocker) => ({
          location: blocker.location,
          policy_or_hold_ref: blocker.policy_or_hold_ref,
          next_review_at: blocker.next_review_at,
        }));
      const state = blockers.length === 0 && completedLocations.length === requestedLocations.length
        ? "COMPLETE"
        : "BLOCKED";
      const receipt = ErasureReceiptSchema.parse({
        protocol: "erc.privacy.erasure.v1",
        erasure_ref: request.erasure_ref,
        state,
        requested_locations: requestedLocations,
        completed_locations: completedLocations,
        blocked_locations: blockedLocations,
        purge_ledger_entry_ref: ledger.ledger_entry_ref,
        issued_at: isoFromMs(clock()),
      });
      const receiptJson = canonicalErasureJson(receipt);
      const receiptSha = await erasureSha256Utf8(receiptJson);
      const now = isoFromMs(clock());
      const expectedNonAbsent = state === "COMPLETE" ? 0 : -1;
      await database.batch([
        database.prepare(
          "UPDATE erasure_case SET state=?3,completed_locations_json=?4,blocked_locations_json=?5," +
          "updated_at=?6 WHERE erasure_id=?1 AND revision=?2",
        ).bind(
          fence.erasure_id,
          fence.revision,
          state,
          canonicalErasureJson(completedLocations),
          canonicalErasureJson(blockedLocations),
          now,
        ),
        database.prepare(
          "UPDATE erasure_execution SET state=?5,terminal_receipt_json=?6," +
          "terminal_receipt_sha256=?7,purge_ledger_revision=?8,lease_owner=NULL,lease_until=NULL," +
          "updated_at=?9 WHERE erasure_id=?1 AND revision=?2 AND lease_owner=?3 " +
          "AND lease_generation=?4",
        ).bind(
          fence.erasure_id,
          fence.revision,
          fence.lease_owner,
          fence.lease_generation,
          state,
          receiptJson,
          receiptSha,
          ledger.ledger_revision,
          now,
        ),
        database.prepare(
          "INSERT INTO erasure_terminal_guard(erasure_id,erasure_revision,closure_digest," +
          "requested_locations_json,completed_locations_json,blocked_locations_json," +
          "terminal_state,receipt_sha256,purge_ledger_revision,verified,created_at) " +
          "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,CASE WHEN " +
          "EXISTS (SELECT 1 FROM purge_ledger p WHERE p.ledger_revision=?9 AND p.erasure_id=?1 " +
          "AND p.receipt_ref=?10 AND p.disposition=?7) " +
          "AND EXISTS (SELECT 1 FROM erasure_stage_receipt s WHERE s.erasure_id=?1 " +
          "AND s.erasure_revision=?2 AND s.stage='INVALIDATE_DEPENDENTS') " +
          "AND (?11<0 OR (SELECT COUNT(*) FROM erasure_target t WHERE t.erasure_id=?1 " +
          "AND t.erasure_revision=?2 AND t.state<>'ABSENT')=?11) THEN 1 ELSE 0 END,?12",
        ).bind(
          fence.erasure_id,
          fence.revision,
          closure.closure_digest,
          canonicalErasureJson(requestedLocations),
          canonicalErasureJson(completedLocations),
          canonicalErasureJson(blockedLocations),
          state,
          receiptSha,
          ledger.ledger_revision,
          ledger.ledger_entry_ref,
          expectedNonAbsent,
          now,
        ),
      ]);
      const terminal = await loadExecution(database, request);
      if (terminal === null) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "terminal erasure execution disappeared", true);
      }
      const readback = await decodeTerminal(terminal);
      if (readback === null || canonicalErasureJson(readback) !== receiptJson) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "terminal erasure receipt readback mismatch", true);
      }
      return readback;
    },
    async fail(fence, errorCode) {
      await database.prepare(
        "UPDATE erasure_execution SET state='FAILED',last_error_code=?5,lease_owner=NULL," +
        "lease_until=NULL,updated_at=?6 WHERE erasure_id=?1 AND revision=?2 " +
        "AND lease_owner=?3 AND lease_generation=?4 AND state NOT IN ('COMPLETE','BLOCKED')",
      ).bind(
        fence.erasure_id,
        fence.revision,
        fence.lease_owner,
        fence.lease_generation,
        errorCode,
        isoFromMs(clock()),
      ).run();
    },
  };
}
