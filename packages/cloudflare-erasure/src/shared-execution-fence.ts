import {
  assertErasureIdentifier,
  assertErasureInteger,
  erasureFail,
  erasureSha256Utf8,
} from "./canonical.js";

const SHARED_OPERATION_ID = "research-erasure-restore-shared-fence-v1";
const SHARED_OPERATION_KIND = "ERASURE_RESTORE_SHARED_FENCE";
const DEFAULT_LEASE_MS = 5 * 60_000;
const MAX_LEASE_MS = 60 * 60_000;

export interface SharedExecutionFence {
  readonly kind: "ERASURE" | "RESTORE";
  readonly operation_id: string;
  readonly lease_owner: string;
  readonly lease_generation: number;
  assertCurrent(): Promise<void>;
  release(): Promise<void>;
}

export interface D1ErasureRestoreFenceStore {
  acquireErasure(identity: { readonly erasure_id: string; readonly revision: number }): Promise<SharedExecutionFence | null>;
  acquireRestore(identity: string): Promise<SharedExecutionFence | null>;
}

interface LeaseRow {
  readonly operation_id: unknown;
  readonly operation_kind: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
  readonly attempt: unknown;
  readonly state: unknown;
}

interface StateRow {
  readonly state: unknown;
}

function safeNow(value: number): number {
  return assertErasureInteger(value, "shared execution fence clock", 0, Number.MAX_SAFE_INTEGER);
}

export function createD1ErasureRestoreFenceStore(input: {
  readonly database: D1Database;
  readonly now?: () => number;
  readonly lease_ms?: number;
}): D1ErasureRestoreFenceStore {
  const database = input.database;
  const clock = input.now ?? Date.now;
  const leaseMs = input.lease_ms ?? DEFAULT_LEASE_MS;
  assertErasureInteger(leaseMs, "shared execution fence lease", 1, MAX_LEASE_MS);

  async function hasActiveRestore(): Promise<boolean> {
    let result: D1Result<StateRow>;
    try {
      result = await database.prepare(
        "SELECT state FROM backup_restore_intent WHERE state IN ('ATTEMPTING','UNKNOWN') ORDER BY restore_id LIMIT 1",
      ).all<StateRow>();
    } catch (cause) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "restore intent fence inventory is unavailable", true, cause);
    }
    if (result.success !== true || !Array.isArray(result.results)) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "restore intent fence inventory is malformed", true);
    }
    if (result.results.length === 0) return false;
    if (result.results.length !== 1 || (result.results[0]?.state !== "ATTEMPTING" && result.results[0]?.state !== "UNKNOWN")) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "restore intent fence inventory contains an unknown state");
    }
    return true;
  }

  async function hasUnsettledErasure(except?: { readonly erasure_id: string; readonly revision: number }): Promise<boolean> {
    let result: D1Result<{ readonly erasure_id: unknown; readonly revision: unknown; readonly state: unknown }>;
    const sql = except === undefined
      ? "SELECT erasure_id,revision,state FROM erasure_execution WHERE state<>'COMPLETE' ORDER BY erasure_id,revision LIMIT 1"
      : "SELECT erasure_id,revision,state FROM erasure_execution WHERE state NOT IN ('COMPLETE','BLOCKED') " +
        "AND NOT (erasure_id=?1 AND revision=?2) ORDER BY erasure_id,revision LIMIT 1";
    try {
      const statement = database.prepare(sql);
      result = except === undefined
        ? await statement.all<{ readonly erasure_id: unknown; readonly revision: unknown; readonly state: unknown }>()
        : await statement.bind(except.erasure_id, except.revision).all<{ readonly erasure_id: unknown; readonly revision: unknown; readonly state: unknown }>();
    } catch (cause) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure execution fence inventory is unavailable", true, cause);
    }
    if (result.success !== true || !Array.isArray(result.results)) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure execution fence inventory is malformed", true);
    }
    if (result.results.length === 0) return false;
    const row = result.results[0];
    if (row === undefined || typeof row.erasure_id !== "string" || !Number.isSafeInteger(row.revision) ||
        typeof row.state !== "string" || row.state.length === 0) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "erasure execution fence inventory contains a malformed row");
    }
    return true;
  }

  async function acquire(kind: "ERASURE" | "RESTORE", identity: string): Promise<SharedExecutionFence | null> {
    assertErasureIdentifier(identity, "shared execution fence identity");
    if (await hasActiveRestore()) return null;
    const erasureIdentity = kind === "ERASURE" ? parseErasureIdentity(identity) : undefined;
    if (await hasUnsettledErasure(erasureIdentity)) return null;

    const now = safeNow(clock());
    const leaseUntil = assertErasureInteger(now + leaseMs, "shared execution fence expiry", now + 1, Number.MAX_SAFE_INTEGER);
    const leaseOwner = `${kind.toLowerCase()}-${await erasureSha256Utf8(identity)}`;
    let row: LeaseRow | null;
    try {
      row = await database.prepare(
        "INSERT INTO operation_execution_lease(operation_id,operation_kind,lease_owner,lease_generation," +
        "lease_until,attempt,state,created_at,updated_at) VALUES(?1,?2,?3,1,?4,1,'LEASED',?5,?5) " +
        "ON CONFLICT(operation_id) DO UPDATE SET lease_owner=excluded.lease_owner," +
        "lease_generation=operation_execution_lease.lease_generation+1,lease_until=excluded.lease_until," +
        "attempt=operation_execution_lease.attempt+1,state='LEASED',checkpoint_ref=NULL," +
        "terminal_receipt_ref=NULL,last_error_code=NULL,updated_at=excluded.updated_at " +
        "WHERE operation_execution_lease.operation_kind=excluded.operation_kind AND (" +
        "operation_execution_lease.state='FAILED' OR (operation_execution_lease.state='LEASED' " +
        "AND operation_execution_lease.lease_until<=excluded.updated_at)) " +
        "AND NOT EXISTS (SELECT 1 FROM backup_restore_intent WHERE state IN ('ATTEMPTING','UNKNOWN')) " +
        "AND ((?6='RESTORE' AND NOT EXISTS (SELECT 1 FROM erasure_execution WHERE state NOT IN ('COMPLETE','BLOCKED'))) " +
        "OR (?6='ERASURE' AND NOT EXISTS (SELECT 1 FROM erasure_execution WHERE state NOT IN ('COMPLETE','BLOCKED') " +
        "AND NOT (erasure_id=?7 AND revision=?8)))) " +
        "RETURNING operation_id,operation_kind,lease_owner,lease_generation,lease_until,attempt,state",
      ).bind(SHARED_OPERATION_ID, SHARED_OPERATION_KIND, leaseOwner, leaseUntil, now, kind,
        erasureIdentity?.erasure_id ?? "", erasureIdentity?.revision ?? 0)
        .first<LeaseRow>();
    } catch (cause) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "shared erasure/restore fence acquisition is uncertain", true, cause);
    }
    if (row === null) {
      let existing: { readonly operation_kind: unknown } | null;
      try {
        existing = await database.prepare(
          "SELECT operation_kind FROM operation_execution_lease WHERE operation_id=?1 LIMIT 1",
        ).bind(SHARED_OPERATION_ID).first<{ readonly operation_kind: unknown }>();
      } catch (cause) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "shared erasure/restore fence readback is unavailable", true, cause);
      }
      if (existing !== null && existing.operation_kind !== SHARED_OPERATION_KIND) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "shared execution fence key is already used by another operation kind");
      }
      return null;
    }
    const generation = assertErasureInteger(row.lease_generation, "shared fence lease generation", 1, Number.MAX_SAFE_INTEGER);
    if (row.operation_id !== SHARED_OPERATION_ID || row.operation_kind !== SHARED_OPERATION_KIND ||
        row.lease_owner !== leaseOwner || row.state !== "LEASED" || row.lease_until !== leaseUntil ||
        !Number.isSafeInteger(row.attempt) || (row.attempt as number) < 1) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "shared execution fence failed exact durable readback", true);
    }

    const fence: SharedExecutionFence = {
      kind,
      operation_id: SHARED_OPERATION_ID,
      lease_owner: leaseOwner,
      lease_generation: generation,
      async assertCurrent() {
        const current = safeNow(clock());
        const until = assertErasureInteger(current + leaseMs, "shared execution fence expiry", current + 1, Number.MAX_SAFE_INTEGER);
        let renewed: LeaseRow | null;
        try {
          renewed = await database.prepare(
            "UPDATE operation_execution_lease SET lease_until=?5,updated_at=?6 WHERE operation_id=?1 " +
            "AND operation_kind=?2 AND lease_owner=?3 AND lease_generation=?4 AND state='LEASED' " +
            "AND lease_until>?6 RETURNING operation_id,operation_kind,lease_owner,lease_generation,lease_until,attempt,state",
          ).bind(SHARED_OPERATION_ID, SHARED_OPERATION_KIND, leaseOwner, generation, until, current)
            .first<LeaseRow>();
        } catch (cause) {
          erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "shared erasure/restore fence renewal is uncertain", true, cause);
        }
        if (renewed === null || renewed.operation_id !== SHARED_OPERATION_ID || renewed.operation_kind !== SHARED_OPERATION_KIND ||
            renewed.lease_owner !== leaseOwner || renewed.lease_generation !== generation || renewed.lease_until !== until ||
            renewed.state !== "LEASED") {
          erasureFail("ERASURE_LEASE_LOST", "shared erasure/restore execution fence is stale", true);
        }
      },
      async release() {
        // A lease timeout never authorizes takeover of an operation whose
        // durable attempt may still have a remote effect in flight.
        try {
          if (kind === "RESTORE") {
            if (await hasActiveRestore()) return;
          } else {
            const erasure = erasureIdentity as { readonly erasure_id: string; readonly revision: number };
            let current: StateRow | null;
            try {
              current = await database.prepare(
                "SELECT state FROM erasure_execution WHERE erasure_id=?1 AND revision=?2 LIMIT 1",
              ).bind(erasure.erasure_id, erasure.revision).first<StateRow>();
            } catch { return; }
            if (current !== null && current.state !== "COMPLETE" && current.state !== "BLOCKED") return;
          }
          const releasedAt = safeNow(clock());
          await database.prepare(
            "UPDATE operation_execution_lease SET state='FAILED',last_error_code='SHARED_FENCE_RELEASED'," +
            "lease_until=?5,updated_at=?5 WHERE operation_id=?1 AND operation_kind=?2 AND lease_owner=?3 " +
            "AND lease_generation=?4 AND state='LEASED'",
          ).bind(SHARED_OPERATION_ID, SHARED_OPERATION_KIND, leaseOwner, generation, releasedAt).run();
        } catch {
          // Preserve the lease on uncertainty. Durable nonterminal operation
          // state remains the takeover blocker after the lease timestamp.
        }
      },
    };
    return fence;
  }

  return {
    acquireErasure(identity) {
      const canonicalIdentity = `${assertErasureIdentifier(identity.erasure_id, "erasure ID")}:${assertErasureInteger(identity.revision, "erasure revision", 1, Number.MAX_SAFE_INTEGER)}`;
      return acquire("ERASURE", canonicalIdentity);
    },
    acquireRestore(identity) {
      return acquire("RESTORE", identity);
    },
  };
}

function parseErasureIdentity(identity: string): { readonly erasure_id: string; readonly revision: number } {
  const separator = identity.lastIndexOf(":");
  if (separator <= 0) erasureFail("ERASURE_INPUT_INVALID", "shared erasure fence identity is malformed");
  const erasureId = assertErasureIdentifier(identity.slice(0, separator), "erasure ID");
  const revisionText = identity.slice(separator + 1);
  if (!/^[1-9][0-9]*$/u.test(revisionText)) erasureFail("ERASURE_INPUT_INVALID", "shared erasure fence revision is malformed");
  const revision = Number(revisionText);
  return { erasure_id: erasureId, revision: assertErasureInteger(revision, "erasure revision", 1, Number.MAX_SAFE_INTEGER) };
}
