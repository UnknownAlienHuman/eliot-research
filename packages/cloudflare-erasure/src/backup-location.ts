import type {
  AbsenceVerificationReceipt,
  ErasureFence,
  ErasureRequest,
  PurgeAttemptReceipt,
  PurgeTarget,
} from "@eliotr/contracts";
import {
  assertErasureIdentifier,
  erasureFail,
  isoFromMs,
} from "./canonical.js";
import type { BackupErasurePort, ErasureLocationPort } from "./types.js";

function epoch(target: PurgeTarget): string {
  if (target.location !== "BackupRestorePath") {
    erasureFail("ERASURE_INPUT_INVALID", "backup erasure target has the wrong purge location");
  }
  if (target.target_kind !== "OBJECT") {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "unverified backup empty proof is not executable");
  }
  const prefix = "backup:";
  if (!target.canonical_ref.startsWith(prefix)) {
    erasureFail("ERASURE_INPUT_INVALID", `unsupported backup erasure target ${target.canonical_ref}`);
  }
  return assertErasureIdentifier(target.canonical_ref.slice(prefix.length), "backup epoch ID");
}

export interface BackupErasureLocationDependencies {
  readonly database: D1Database;
  readonly port: BackupErasurePort;
  readonly now?: () => number;
}

interface BackupPurgeObligationRow {
  readonly target_id: string;
  readonly state: "PENDING" | "BLOCKED" | "ABSENT";
  readonly delete_receipt_ref: string | null;
  readonly absence_receipt_ref: string | null;
}

async function readObligation(
  database: D1Database,
  fence: ErasureFence,
  epochRef: string,
): Promise<BackupPurgeObligationRow | null> {
  try {
    const row = await database.prepare(
      "SELECT target_id,state,delete_receipt_ref,absence_receipt_ref " +
      "FROM backup_purge_obligation WHERE erasure_id=?1 AND erasure_revision=?2 AND backup_epoch_id=?3",
    ).bind(fence.erasure_id, fence.revision, epochRef).first<BackupPurgeObligationRow>();
    if (row !== null && row.state !== "PENDING" && row.state !== "BLOCKED" && row.state !== "ABSENT") {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup purge obligation has an unknown persisted state");
    }
    return row;
  } catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup purge obligation readback failed", true, cause);
  }
}

function assertFenceBindsRequest(request: ErasureRequest, fence: ErasureFence): void {
  if (request.erasure_ref.id !== fence.erasure_id || request.erasure_ref.revision !== fence.revision) {
    erasureFail("ERASURE_LEASE_LOST", "backup purge request no longer matches its execution fence", true);
  }
}

function requireObligationTarget(
  row: BackupPurgeObligationRow | null,
  target: PurgeTarget,
): asserts row is BackupPurgeObligationRow {
  if (row === null) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup purge intent was not durably read back", true);
  }
  if (row.target_id !== target.target_id) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "backup purge obligation identity is already bound to another target");
  }
}

export function createBackupErasureLocationPort(
  dependencies: BackupErasureLocationDependencies,
): ErasureLocationPort {
  const clock = dependencies.now ?? Date.now;
  return {
    async purge(request, fence: ErasureFence, target): Promise<PurgeAttemptReceipt> {
      assertFenceBindsRequest(request, fence);
      const epochRef = epoch(target);
      const erasureRef = `${request.erasure_ref.id}:${request.erasure_ref.revision}`;
      // Persist the exact erasure/epoch/target intent before the provider can
      // perform an irreversible delete. On an unknown acknowledgement, the
      // PENDING row remains available to the idempotent provider replay path.
      let intentWrite: D1Result;
      try {
        intentWrite = await dependencies.database.prepare(
          "INSERT INTO backup_purge_obligation(erasure_id,erasure_revision,backup_epoch_id," +
          "target_id,state,updated_at) VALUES (?1,?2,?3,?4,'PENDING',?5) " +
          "ON CONFLICT(erasure_id,erasure_revision,backup_epoch_id) DO NOTHING",
        ).bind(
          fence.erasure_id,
          fence.revision,
          epochRef,
          target.target_id,
          isoFromMs(clock()),
        ).run();
      } catch (cause) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup purge intent did not settle", true, cause);
      }
      if ((intentWrite as { readonly success?: boolean }).success === false) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup purge intent did not settle", true);
      }
      const existing = await readObligation(dependencies.database, fence, epochRef);
      requireObligationTarget(existing, target);
      // A persisted delete receipt is sufficient for the coordinator to
      // proceed to its independent absence stage; never repeat that effect.
      if (existing.delete_receipt_ref !== null) {
        return {
          target_id: target.target_id,
          disposition: "DELETE_ACCEPTED",
          receipt_ref: existing.delete_receipt_ref,
        };
      }
      let receipt: { readonly receipt_ref: string };
      try { receipt = await dependencies.port.purge(epochRef, erasureRef); }
      catch (cause) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup delete settlement is unknown", true, cause);
      }
      let receiptWrite: D1Result;
      try {
        receiptWrite = await dependencies.database.prepare(
          "UPDATE backup_purge_obligation SET delete_receipt_ref=?5,updated_at=?6 " +
          "WHERE erasure_id=?1 AND erasure_revision=?2 AND backup_epoch_id=?3 AND target_id=?4 " +
          "AND delete_receipt_ref IS NULL",
        ).bind(
          fence.erasure_id,
          fence.revision,
          epochRef,
          target.target_id,
          receipt.receipt_ref,
          isoFromMs(clock()),
        ).run();
      } catch (cause) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup delete receipt did not settle", true, cause);
      }
      if ((receiptWrite as { readonly success?: boolean }).success === false) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup purge obligation did not settle", true);
      }
      const persisted = await readObligation(dependencies.database, fence, epochRef);
      requireObligationTarget(persisted, target);
      if (persisted.delete_receipt_ref !== receipt.receipt_ref) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup delete receipt failed exact readback", true);
      }
      return {
        target_id: target.target_id,
        disposition: "DELETE_ACCEPTED",
        receipt_ref: receipt.receipt_ref,
      };
    },

    async verifyAbsent(request, fence, target, purgeReceipt): Promise<AbsenceVerificationReceipt> {
      assertFenceBindsRequest(request, fence);
      const epochRef = epoch(target);
      const erasureRef = `${request.erasure_ref.id}:${request.erasure_ref.revision}`;
      const obligation = await readObligation(dependencies.database, fence, epochRef);
      requireObligationTarget(obligation, target);
      if (obligation.delete_receipt_ref === null || obligation.delete_receipt_ref !== purgeReceipt.receipt_ref) {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup absence check is not bound to the persisted delete receipt");
      }
      let result: { readonly absent: boolean; readonly receipt_ref: string };
      try { result = await dependencies.port.verifyAbsent(epochRef, erasureRef); }
      catch (cause) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup absence readback failed", true, cause);
      }
      let write: D1Result;
      try {
        write = await dependencies.database.prepare(
        "UPDATE backup_purge_obligation SET state=?5,absence_receipt_ref=?6,updated_at=?7 " +
        "WHERE erasure_id=?1 AND erasure_revision=?2 AND backup_epoch_id=?3 AND target_id=?4 " +
        "AND delete_receipt_ref=?8",
        ).bind(
        fence.erasure_id,
        fence.revision,
        epochRef,
        target.target_id,
        result.absent ? "ABSENT" : "BLOCKED",
        result.receipt_ref,
        isoFromMs(clock()),
          purgeReceipt.receipt_ref,
        ).run();
      } catch (cause) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup absence receipt did not settle", true, cause);
      }
      if ((write as { readonly success?: boolean }).success === false) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup absence receipt did not settle", true);
      }
      const persisted = await readObligation(dependencies.database, fence, epochRef);
      requireObligationTarget(persisted, target);
      if (
        persisted.state !== (result.absent ? "ABSENT" : "BLOCKED") ||
        persisted.absence_receipt_ref !== result.receipt_ref ||
        persisted.delete_receipt_ref !== purgeReceipt.receipt_ref
      ) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup absence receipt failed exact readback", true);
      }
      return {
        target_id: target.target_id,
        absent: result.absent,
        receipt_ref: result.receipt_ref,
        ...(result.absent ? {} : { reason_code: "BACKUP_COPY_REMAINS" }),
      };
    },
  };
}
