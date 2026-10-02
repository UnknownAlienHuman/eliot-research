import type { ErasureFence, ErasureRequest, PurgeTarget } from "@eliotr/contracts";
import { describe, expect, it, vi } from "vitest";
import { createBackupErasureLocationPort } from "./backup-location.js";
import type { BackupErasurePort } from "./types.js";
import { canonicalErasureJson, erasureSha256Utf8 } from "./canonical.js";

const request: ErasureRequest = {
  protocol: "erc.privacy.erasure.v1",
  erasure_ref: { id: "erase-1", revision: 2 },
  requested_by_principal_ref: "privacy-officer-1",
  exact_subject_refs: ["source-revision:revision-1"],
  required_locations: ["BackupRestorePath"],
  legal_basis_ref: "delete-request-1",
  admitted_at: "2026-09-01T00:00:00.000Z",
  deadline: "2026-09-08T00:00:00.000Z",
};
const fence: ErasureFence = {
  erasure_id: "erase-1",
  revision: 2,
  lease_owner: "worker-1",
  lease_generation: 4,
  lease_until_ms: Date.UTC(2026, 8, 1, 1),
};
const NOW_MS = Date.UTC(2026, 8, 1, 0, 30);
const backupTarget: PurgeTarget = {
  target_id: "backup-target-1",
  target_kind: "OBJECT",
  exact_subject_ref: "source-revision:revision-1",
  location: "BackupRestorePath",
  canonical_ref: "backup:epoch-1",
  identity_digest: "a".repeat(64),
  shared_live_reference_count: 0,
};

interface Obligation {
  readonly target_id: string;
  state: "PENDING" | "BLOCKED" | "ABSENT";
  delete_receipt_ref: string | null;
  absence_receipt_ref: string | null;
}

function obligationDatabase(initial?: Obligation): {
  readonly database: D1Database;
  get(): Obligation | null;
  setFence(state: string, generation?: number): Promise<void>;
  loseFence(): void;
} {
  let row = initial ?? null;
  let execution: {
    readonly request_json: string;
    readonly request_sha256: string;
    readonly state: string;
    readonly lease_owner: string;
    readonly lease_generation: number;
    readonly lease_until: number;
  } | null = null;
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              const executionMatches = (
                id: unknown,
                revision: unknown,
                owner: unknown,
                generation: unknown,
                until: unknown,
                state: string,
              ) => execution !== null && execution.request_json === canonicalErasureJson(request) &&
                id === fence.erasure_id && revision === fence.revision && owner === execution.lease_owner &&
                generation === execution.lease_generation && until === NOW_MS && execution.state === state;
              if (sql.startsWith("INSERT INTO backup_purge_obligation")) {
                if (executionMatches(values[5], values[6], values[7], values[8], values[9], "PURGE_EACH_LOCATION") && row === null) row = {
                  target_id: String(values[3]),
                  state: "PENDING",
                  delete_receipt_ref: null,
                  absence_receipt_ref: null,
                };
              } else if (sql.startsWith("UPDATE backup_purge_obligation SET delete_receipt_ref")) {
                if (executionMatches(values[6], values[7], values[8], values[9], values[10], "PURGE_EACH_LOCATION") && row !== null && row.target_id === values[3] && row.delete_receipt_ref === null) {
                  row.delete_receipt_ref = String(values[4]);
                }
              } else if (sql.startsWith("UPDATE backup_purge_obligation SET state")) {
                if (executionMatches(values[8], values[9], values[10], values[11], values[12], "VERIFY_ABSENCE_OR_BLOCK") && row !== null && row.target_id === values[3] && row.delete_receipt_ref === values[7]) {
                  row.state = values[4] as Obligation["state"];
                  row.absence_receipt_ref = String(values[5]);
                }
              } else {
                throw new Error(`unexpected D1 write: ${sql}`);
              }
              return { success: true };
            },
            async first<T>() {
              if (sql.startsWith("SELECT request_json,request_sha256,state,lease_owner,lease_generation,lease_until")) {
                return execution as T | null;
              }
              if (!sql.startsWith("SELECT target_id,state,delete_receipt_ref,absence_receipt_ref")) {
                throw new Error(`unexpected D1 read: ${sql}`);
              }
              return row as T | null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return {
    database,
    get: () => row,
    async setFence(state, generation = fence.lease_generation) {
      const requestJson = canonicalErasureJson(request);
      execution = {
        request_json: requestJson,
        request_sha256: await erasureSha256Utf8(requestJson),
        state,
        lease_owner: fence.lease_owner,
        lease_generation: generation,
        lease_until: fence.lease_until_ms,
      };
    },
    loseFence() {
      if (execution !== null) execution = { ...execution, lease_generation: execution.lease_generation + 1 };
    },
  };
}

describe("backup erasure location", () => {
  it("persists and reads back the target-bound intent before delete, then exact-reads its receipt", async () => {
    const store = obligationDatabase();
    await store.setFence("PURGE_EACH_LOCATION");
    const port: BackupErasurePort = {
      purge: vi.fn(async () => {
        expect(store.get()).toEqual({
          target_id: backupTarget.target_id,
          state: "PENDING",
          delete_receipt_ref: null,
          absence_receipt_ref: null,
        });
        return { receipt_ref: "backup-delete-1" };
      }),
      verifyAbsent: vi.fn(async () => ({ absent: true, receipt_ref: "backup-absence-1" })),
    };
    const location = createBackupErasureLocationPort({ database: store.database, port, now: () => NOW_MS });

    const deleted = await location.purge(request, fence, backupTarget);
    expect(deleted).toEqual({ target_id: backupTarget.target_id, disposition: "DELETE_ACCEPTED", receipt_ref: "backup-delete-1" });
    expect(store.get()?.delete_receipt_ref).toBe("backup-delete-1");

    await store.setFence("VERIFY_ABSENCE_OR_BLOCK");
    const absence = await location.verifyAbsent(request, fence, backupTarget, deleted);
    expect(absence).toEqual({ target_id: backupTarget.target_id, absent: true, receipt_ref: "backup-absence-1" });
    expect(store.get()).toEqual({
      target_id: backupTarget.target_id,
      state: "ABSENT",
      delete_receipt_ref: "backup-delete-1",
      absence_receipt_ref: "backup-absence-1",
    });
  });

  it("leaves durable PENDING intent when provider settlement is unknown", async () => {
    const store = obligationDatabase();
    await store.setFence("PURGE_EACH_LOCATION");
    const port: BackupErasurePort = {
      purge: vi.fn(async () => { throw new Error("ack lost"); }),
      verifyAbsent: vi.fn(async () => ({ absent: true, receipt_ref: "unused" })),
    };
    const location = createBackupErasureLocationPort({ database: store.database, port, now: () => NOW_MS });

    await expect(location.purge(request, fence, backupTarget)).rejects.toMatchObject({ code: "ERASURE_SETTLEMENT_UNCERTAIN" });
    expect(store.get()).toEqual({
      target_id: backupTarget.target_id,
      state: "PENDING",
      delete_receipt_ref: null,
      absence_receipt_ref: null,
    });
  });

  it("does not repeat a delete with a persisted receipt or accept another target for the same epoch", async () => {
    const port: BackupErasurePort = {
      purge: vi.fn(async () => ({ receipt_ref: "new-delete" })),
      verifyAbsent: vi.fn(async () => ({ absent: true, receipt_ref: "unused" })),
    };
    const persisted = obligationDatabase({
      target_id: backupTarget.target_id,
      state: "PENDING",
      delete_receipt_ref: "backup-delete-1",
      absence_receipt_ref: null,
    });
    await persisted.setFence("PURGE_EACH_LOCATION");
    const location = createBackupErasureLocationPort({ database: persisted.database, port, now: () => NOW_MS });
    await expect(location.purge(request, fence, backupTarget)).resolves.toMatchObject({ receipt_ref: "backup-delete-1" });
    expect(port.purge).not.toHaveBeenCalled();

    const conflict = obligationDatabase({
      target_id: "foreign-target",
      state: "PENDING",
      delete_receipt_ref: null,
      absence_receipt_ref: null,
    });
    await conflict.setFence("PURGE_EACH_LOCATION");
    const conflictLocation = createBackupErasureLocationPort({ database: conflict.database, port, now: () => NOW_MS });
    await expect(conflictLocation.purge(request, fence, backupTarget)).rejects.toMatchObject({ code: "ERASURE_IDENTITY_CONFLICT" });
    expect(port.purge).not.toHaveBeenCalled();
  });

  it("binds absence readback to the persisted delete receipt and request fence", async () => {
    const store = obligationDatabase({
      target_id: backupTarget.target_id,
      state: "PENDING",
      delete_receipt_ref: "backup-delete-1",
      absence_receipt_ref: null,
    });
    await store.setFence("VERIFY_ABSENCE_OR_BLOCK");
    const port: BackupErasurePort = {
      purge: vi.fn(async () => ({ receipt_ref: "unused" })),
      verifyAbsent: vi.fn(async () => ({ absent: true, receipt_ref: "absence" })),
    };
    const location = createBackupErasureLocationPort({ database: store.database, port, now: () => NOW_MS });
    await expect(location.verifyAbsent(request, fence, backupTarget, {
      target_id: backupTarget.target_id,
      disposition: "DELETE_ACCEPTED",
      receipt_ref: "foreign-receipt",
    })).rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
    expect(port.verifyAbsent).not.toHaveBeenCalled();

    await expect(location.purge(request, { ...fence, erasure_id: "foreign-erasure" }, backupTarget))
      .rejects.toMatchObject({ code: "ERASURE_LEASE_LOST" });
    expect(port.purge).not.toHaveBeenCalled();
  });

  it("rejects expired or superseded leases before provider effects and preserves unknown post-effect outcomes", async () => {
    const stale = obligationDatabase();
    await stale.setFence("PURGE_EACH_LOCATION");
    stale.loseFence();
    const stalePort: BackupErasurePort = {
      purge: vi.fn(async () => ({ receipt_ref: "should-not-delete" })),
      verifyAbsent: vi.fn(async () => ({ absent: true, receipt_ref: "should-not-read" })),
    };
    const staleLocation = createBackupErasureLocationPort({ database: stale.database, port: stalePort, now: () => NOW_MS });
    await expect(staleLocation.purge(request, fence, backupTarget)).rejects.toMatchObject({ code: "ERASURE_LEASE_LOST" });
    expect(stalePort.purge).not.toHaveBeenCalled();
    expect(stale.get()).toBeNull();

    const deleteAckLost = obligationDatabase();
    await deleteAckLost.setFence("PURGE_EACH_LOCATION");
    const deletePort: BackupErasurePort = {
      purge: vi.fn(async () => {
        deleteAckLost.loseFence();
        return { receipt_ref: "remote-delete-may-have-happened" };
      }),
      verifyAbsent: vi.fn(async () => ({ absent: true, receipt_ref: "unused" })),
    };
    const deleteLocation = createBackupErasureLocationPort({ database: deleteAckLost.database, port: deletePort, now: () => NOW_MS });
    await expect(deleteLocation.purge(request, fence, backupTarget)).rejects.toMatchObject({ code: "ERASURE_LEASE_LOST" });
    expect(deleteAckLost.get()).toEqual({
      target_id: backupTarget.target_id,
      state: "PENDING",
      delete_receipt_ref: null,
      absence_receipt_ref: null,
    });

    const absenceAckLost = obligationDatabase({
      target_id: backupTarget.target_id,
      state: "PENDING",
      delete_receipt_ref: "backup-delete-1",
      absence_receipt_ref: null,
    });
    await absenceAckLost.setFence("VERIFY_ABSENCE_OR_BLOCK");
    const absencePort: BackupErasurePort = {
      purge: vi.fn(async () => ({ receipt_ref: "unused" })),
      verifyAbsent: vi.fn(async () => {
        absenceAckLost.loseFence();
        return { absent: true, receipt_ref: "remote-absence-may-have-happened" };
      }),
    };
    const absenceLocation = createBackupErasureLocationPort({ database: absenceAckLost.database, port: absencePort, now: () => NOW_MS });
    await expect(absenceLocation.verifyAbsent(request, fence, backupTarget, {
      target_id: backupTarget.target_id,
      disposition: "DELETE_ACCEPTED",
      receipt_ref: "backup-delete-1",
    })).rejects.toMatchObject({ code: "ERASURE_LEASE_LOST" });
    expect(absenceAckLost.get()).toEqual({
      target_id: backupTarget.target_id,
      state: "PENDING",
      delete_receipt_ref: "backup-delete-1",
      absence_receipt_ref: null,
    });
  });

  it("rejects undefined or malformed persisted receipt fields as authority", async () => {
    const malformed = obligationDatabase({
      target_id: backupTarget.target_id,
      state: "PENDING",
      delete_receipt_ref: undefined as unknown as null,
      absence_receipt_ref: null,
    });
    await malformed.setFence("PURGE_EACH_LOCATION");
    const port: BackupErasurePort = {
      purge: vi.fn(async () => ({ receipt_ref: "should-not-delete" })),
      verifyAbsent: vi.fn(async () => ({ absent: true, receipt_ref: "should-not-read" })),
    };
    const location = createBackupErasureLocationPort({ database: malformed.database, port, now: () => NOW_MS });
    await expect(location.purge(request, fence, backupTarget)).rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
    expect(port.purge).not.toHaveBeenCalled();
  });
});
