import type { ErasureFence, ErasureRequest, PurgeTarget } from "@eliotr/contracts";
import { describe, expect, it, vi } from "vitest";
import { createBackupErasureLocationPort } from "./backup-location.js";
import { composeBackupErasurePort } from "./backup-location.js";
import type {
  BackupCompositeErasurePort,
  BackupErasurePort,
  BackupPrimaryErasurePort,
} from "./types.js";
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
  primary_delete_intent_ref: string | null;
  primary_delete_intent_digest: string | null;
  primary_delete_receipt_ref: string | null;
  primary_absence_receipt_ref: string | null;
  offsite_delete_receipt_ref: string | null;
  offsite_absence_receipt_ref: string | null;
}

const PRIMARY_INTENT = "primary-intent-1";
const PRIMARY_INTENT_DIGEST = "b".repeat(64);

function obligationDatabase(initial?: Partial<Obligation> & Pick<Obligation, "target_id" | "state">): {
  readonly database: D1Database;
  get(): Obligation | null;
  setFence(state: string, generation?: number): Promise<void>;
  loseFence(): void;
  setPrimaryIntent(ref?: string, digest?: string): void;
} {
  let row: Obligation | null = initial === undefined ? null : {
    target_id: initial.target_id,
    state: initial.state,
    // Preserve an explicitly undefined persisted field so the malformed-row
    // authority test reaches the production validator instead of normalizing
    // corruption into a valid NULL.
    delete_receipt_ref: Object.hasOwn(initial, "delete_receipt_ref")
      ? initial.delete_receipt_ref as string | null
      : null,
    absence_receipt_ref: initial.absence_receipt_ref ?? null,
    primary_delete_intent_ref: initial.primary_delete_intent_ref ?? null,
    primary_delete_intent_digest: initial.primary_delete_intent_digest ?? null,
    primary_delete_receipt_ref: initial.primary_delete_receipt_ref ?? null,
    primary_absence_receipt_ref: initial.primary_absence_receipt_ref ?? null,
    offsite_delete_receipt_ref: initial.offsite_delete_receipt_ref ?? null,
    offsite_absence_receipt_ref: initial.offsite_absence_receipt_ref ?? null,
  };
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
                  primary_delete_intent_ref: null,
                  primary_delete_intent_digest: null,
                  primary_delete_receipt_ref: null,
                  primary_absence_receipt_ref: null,
                  offsite_delete_receipt_ref: null,
                  offsite_absence_receipt_ref: null,
                };
              } else if (sql.startsWith("UPDATE backup_purge_obligation SET delete_receipt_ref")) {
                if (executionMatches(values[10], values[11], values[12], values[13], values[14], "PURGE_EACH_LOCATION") &&
                    row !== null && row.target_id === values[3] && row.delete_receipt_ref === null &&
                    row.primary_delete_intent_ref === values[8] && row.primary_delete_intent_digest === values[9]) {
                  row.delete_receipt_ref = String(values[4]);
                  row.primary_delete_receipt_ref = String(values[5]);
                  row.offsite_delete_receipt_ref = String(values[6]);
                }
              } else if (sql.startsWith("UPDATE backup_purge_obligation SET state")) {
                if (executionMatches(values[10], values[11], values[12], values[13], values[14], "VERIFY_ABSENCE_OR_BLOCK") &&
                    row !== null && row.target_id === values[3] && row.delete_receipt_ref === values[9] &&
                    row.primary_delete_receipt_ref !== null && row.offsite_delete_receipt_ref !== null) {
                  row.state = values[4] as Obligation["state"];
                  row.absence_receipt_ref = String(values[5]);
                  row.primary_absence_receipt_ref = String(values[6]);
                  row.offsite_absence_receipt_ref = String(values[7]);
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
    setPrimaryIntent(ref = PRIMARY_INTENT, digest = PRIMARY_INTENT_DIGEST) {
      if (row !== null) {
        row.primary_delete_intent_ref = ref;
        row.primary_delete_intent_digest = digest;
      }
    },
  };
}

function compositePort(
  purge: BackupCompositeErasurePort["purge"],
  verifyAbsent: BackupCompositeErasurePort["verifyAbsent"] = async () => ({
    absent: true,
    receipt_ref: "backup-absence-1",
    primary_absence_receipt_ref: "primary-absence-1",
    offsite_absence_receipt_ref: "offsite-absence-1",
  }),
): BackupCompositeErasurePort {
  return { purge: vi.fn(purge), verifyAbsent: vi.fn(verifyAbsent) };
}

describe("backup erasure location", () => {
  it("keeps the legacy offsite adapter shape but requires primary absence too", async () => {
    const offsite: BackupErasurePort = {
      async purge() { return { receipt_ref: "offsite-delete-1" }; },
      async verifyAbsent() { return { absent: true, receipt_ref: "offsite-absence-1" }; },
    };
    const primary: BackupPrimaryErasurePort = {
      async purge() {
        return { intent_ref: PRIMARY_INTENT, intent_digest: PRIMARY_INTENT_DIGEST, receipt_ref: "primary-delete-1" };
      },
      async verifyAbsent() { return { absent: false, receipt_ref: "primary-still-present" }; },
    };
    const composite = composeBackupErasurePort(primary, offsite);

    await expect(composite.verifyAbsent("epoch-1", "erasure-1:1", { target_id: "target-1", fence }))
      .resolves.toMatchObject({
        absent: false,
        primary_absence_receipt_ref: "primary-still-present",
        offsite_absence_receipt_ref: "offsite-absence-1",
      });
  });

  it("persists and reads back the target-bound intent before delete, then exact-reads its receipt", async () => {
    const store = obligationDatabase();
    await store.setFence("PURGE_EACH_LOCATION");
    const port = compositePort(async () => {
        expect(store.get()).toEqual({
          target_id: backupTarget.target_id,
          state: "PENDING",
          delete_receipt_ref: null,
          absence_receipt_ref: null,
          primary_delete_intent_ref: null,
          primary_delete_intent_digest: null,
          primary_delete_receipt_ref: null,
          primary_absence_receipt_ref: null,
          offsite_delete_receipt_ref: null,
          offsite_absence_receipt_ref: null,
        });
        store.setPrimaryIntent();
        return {
          receipt_ref: "backup-delete-1",
          primary_delete_intent_ref: PRIMARY_INTENT,
          primary_delete_intent_digest: PRIMARY_INTENT_DIGEST,
          primary_delete_receipt_ref: "primary-delete-1",
          offsite_delete_receipt_ref: "offsite-delete-1",
        };
      }, async () => ({
      absent: true,
      receipt_ref: "backup-absence-1",
      primary_absence_receipt_ref: "primary-absence-1",
      offsite_absence_receipt_ref: "offsite-absence-1",
    }));
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
      primary_delete_intent_ref: PRIMARY_INTENT,
      primary_delete_intent_digest: PRIMARY_INTENT_DIGEST,
      primary_delete_receipt_ref: "primary-delete-1",
      primary_absence_receipt_ref: "primary-absence-1",
      offsite_delete_receipt_ref: "offsite-delete-1",
      offsite_absence_receipt_ref: "offsite-absence-1",
    });
  });

  it("leaves durable PENDING intent when provider settlement is unknown", async () => {
    const store = obligationDatabase();
    await store.setFence("PURGE_EACH_LOCATION");
    const port = compositePort(async () => { throw new Error("ack lost"); });
    const location = createBackupErasureLocationPort({ database: store.database, port, now: () => NOW_MS });

    await expect(location.purge(request, fence, backupTarget)).rejects.toMatchObject({ code: "ERASURE_SETTLEMENT_UNCERTAIN" });
    expect(store.get()).toEqual({
      target_id: backupTarget.target_id,
      state: "PENDING",
      delete_receipt_ref: null,
      absence_receipt_ref: null,
      primary_delete_intent_ref: null,
      primary_delete_intent_digest: null,
      primary_delete_receipt_ref: null,
      primary_absence_receipt_ref: null,
      offsite_delete_receipt_ref: null,
      offsite_absence_receipt_ref: null,
    });
  });

  it("does not repeat a delete with a persisted receipt or accept another target for the same epoch", async () => {
    const port = compositePort(async () => ({
      receipt_ref: "new-delete", primary_delete_intent_ref: PRIMARY_INTENT,
      primary_delete_intent_digest: PRIMARY_INTENT_DIGEST,
      primary_delete_receipt_ref: "primary-delete-new", offsite_delete_receipt_ref: "offsite-delete-new",
    }));
    const persisted = obligationDatabase({
      target_id: backupTarget.target_id,
      state: "PENDING",
      delete_receipt_ref: "backup-delete-1",
      absence_receipt_ref: null,
      primary_delete_intent_ref: PRIMARY_INTENT,
      primary_delete_intent_digest: PRIMARY_INTENT_DIGEST,
      primary_delete_receipt_ref: "primary-delete-1",
      offsite_delete_receipt_ref: "offsite-delete-1",
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
    const port = compositePort(async () => ({
      receipt_ref: "unused", primary_delete_intent_ref: PRIMARY_INTENT,
      primary_delete_intent_digest: PRIMARY_INTENT_DIGEST,
      primary_delete_receipt_ref: "primary-delete-1", offsite_delete_receipt_ref: "offsite-delete-1",
    }), async () => ({ absent: true, receipt_ref: "absence",
      primary_absence_receipt_ref: "primary-absence", offsite_absence_receipt_ref: "offsite-absence" }));
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
    const stalePort = compositePort(async () => ({
      receipt_ref: "should-not-delete", primary_delete_intent_ref: PRIMARY_INTENT,
      primary_delete_intent_digest: PRIMARY_INTENT_DIGEST,
      primary_delete_receipt_ref: "primary-delete", offsite_delete_receipt_ref: "offsite-delete",
    }));
    const staleLocation = createBackupErasureLocationPort({ database: stale.database, port: stalePort, now: () => NOW_MS });
    await expect(staleLocation.purge(request, fence, backupTarget)).rejects.toMatchObject({ code: "ERASURE_LEASE_LOST" });
    expect(stalePort.purge).not.toHaveBeenCalled();
    expect(stale.get()).toBeNull();

    const deleteAckLost = obligationDatabase();
    await deleteAckLost.setFence("PURGE_EACH_LOCATION");
    const deletePort = compositePort(async () => {
        deleteAckLost.setPrimaryIntent();
        deleteAckLost.loseFence();
        return {
          receipt_ref: "remote-delete-may-have-happened", primary_delete_intent_ref: PRIMARY_INTENT,
          primary_delete_intent_digest: PRIMARY_INTENT_DIGEST,
          primary_delete_receipt_ref: "primary-delete-may-have-happened",
          offsite_delete_receipt_ref: "offsite-delete-may-have-happened",
        };
      });
    const deleteLocation = createBackupErasureLocationPort({ database: deleteAckLost.database, port: deletePort, now: () => NOW_MS });
    await expect(deleteLocation.purge(request, fence, backupTarget)).rejects.toMatchObject({ code: "ERASURE_LEASE_LOST" });
    expect(deleteAckLost.get()).toEqual({
      target_id: backupTarget.target_id,
      state: "PENDING",
      delete_receipt_ref: null,
      absence_receipt_ref: null,
      primary_delete_intent_ref: PRIMARY_INTENT,
      primary_delete_intent_digest: PRIMARY_INTENT_DIGEST,
      primary_delete_receipt_ref: null,
      primary_absence_receipt_ref: null,
      offsite_delete_receipt_ref: null,
      offsite_absence_receipt_ref: null,
    });

    const absenceAckLost = obligationDatabase({
      target_id: backupTarget.target_id,
      state: "PENDING",
      delete_receipt_ref: "backup-delete-1",
      absence_receipt_ref: null,
      primary_delete_intent_ref: PRIMARY_INTENT,
      primary_delete_intent_digest: PRIMARY_INTENT_DIGEST,
      primary_delete_receipt_ref: "primary-delete-1",
      offsite_delete_receipt_ref: "offsite-delete-1",
    });
    await absenceAckLost.setFence("VERIFY_ABSENCE_OR_BLOCK");
    const absencePort = compositePort(async () => ({
      receipt_ref: "unused", primary_delete_intent_ref: PRIMARY_INTENT,
      primary_delete_intent_digest: PRIMARY_INTENT_DIGEST,
      primary_delete_receipt_ref: "primary-delete-1", offsite_delete_receipt_ref: "offsite-delete-1",
    }), async () => {
        absenceAckLost.loseFence();
        return { absent: true, receipt_ref: "remote-absence-may-have-happened",
          primary_absence_receipt_ref: "primary-absence-may-have-happened",
          offsite_absence_receipt_ref: "offsite-absence-may-have-happened" };
      });
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
      primary_delete_intent_ref: PRIMARY_INTENT,
      primary_delete_intent_digest: PRIMARY_INTENT_DIGEST,
      primary_delete_receipt_ref: "primary-delete-1",
      offsite_delete_receipt_ref: "offsite-delete-1",
      primary_absence_receipt_ref: null,
      offsite_absence_receipt_ref: null,
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
    const port = compositePort(async () => ({
      receipt_ref: "should-not-delete", primary_delete_intent_ref: PRIMARY_INTENT,
      primary_delete_intent_digest: PRIMARY_INTENT_DIGEST,
      primary_delete_receipt_ref: "primary-delete", offsite_delete_receipt_ref: "offsite-delete",
    }));
    const location = createBackupErasureLocationPort({ database: malformed.database, port, now: () => NOW_MS });
    await expect(location.purge(request, fence, backupTarget)).rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
    expect(port.purge).not.toHaveBeenCalled();
  });
});
