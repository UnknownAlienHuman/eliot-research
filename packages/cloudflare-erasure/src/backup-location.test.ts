import type { ErasureFence, ErasureRequest, PurgeTarget } from "@eliotr/contracts";
import { describe, expect, it, vi } from "vitest";
import { createBackupErasureLocationPort } from "./backup-location.js";
import type { BackupErasurePort } from "./types.js";

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

function obligationDatabase(initial?: Obligation): { readonly database: D1Database; get(): Obligation | null } {
  let row = initial ?? null;
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              if (sql.startsWith("INSERT INTO backup_purge_obligation")) {
                if (row === null) row = {
                  target_id: String(values[3]),
                  state: "PENDING",
                  delete_receipt_ref: null,
                  absence_receipt_ref: null,
                };
              } else if (sql.startsWith("UPDATE backup_purge_obligation SET delete_receipt_ref")) {
                if (row !== null && row.target_id === values[3] && row.delete_receipt_ref === null) {
                  row.delete_receipt_ref = String(values[4]);
                }
              } else if (sql.startsWith("UPDATE backup_purge_obligation SET state")) {
                if (row !== null && row.target_id === values[3] && row.delete_receipt_ref === values[7]) {
                  row.state = values[4] as Obligation["state"];
                  row.absence_receipt_ref = String(values[5]);
                }
              } else {
                throw new Error(`unexpected D1 write: ${sql}`);
              }
              return { success: true };
            },
            async first<T>() {
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
  return { database, get: () => row };
}

describe("backup erasure location", () => {
  it("persists and reads back the target-bound intent before delete, then exact-reads its receipt", async () => {
    const store = obligationDatabase();
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
    const location = createBackupErasureLocationPort({ database: store.database, port, now: () => 1_800_000_000_000 });

    const deleted = await location.purge(request, fence, backupTarget);
    expect(deleted).toEqual({ target_id: backupTarget.target_id, disposition: "DELETE_ACCEPTED", receipt_ref: "backup-delete-1" });
    expect(store.get()?.delete_receipt_ref).toBe("backup-delete-1");

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
    const port: BackupErasurePort = {
      purge: vi.fn(async () => { throw new Error("ack lost"); }),
      verifyAbsent: vi.fn(async () => ({ absent: true, receipt_ref: "unused" })),
    };
    const location = createBackupErasureLocationPort({ database: store.database, port, now: () => 1_800_000_000_000 });

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
    const location = createBackupErasureLocationPort({ database: persisted.database, port, now: () => 1_800_000_000_000 });
    await expect(location.purge(request, fence, backupTarget)).resolves.toMatchObject({ receipt_ref: "backup-delete-1" });
    expect(port.purge).not.toHaveBeenCalled();

    const conflict = obligationDatabase({
      target_id: "foreign-target",
      state: "PENDING",
      delete_receipt_ref: null,
      absence_receipt_ref: null,
    });
    const conflictLocation = createBackupErasureLocationPort({ database: conflict.database, port, now: () => 1_800_000_000_000 });
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
    const port: BackupErasurePort = {
      purge: vi.fn(async () => ({ receipt_ref: "unused" })),
      verifyAbsent: vi.fn(async () => ({ absent: true, receipt_ref: "absence" })),
    };
    const location = createBackupErasureLocationPort({ database: store.database, port, now: () => 1_800_000_000_000 });
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
});
