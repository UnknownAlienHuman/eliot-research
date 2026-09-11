import type {
  AbsenceVerificationReceipt,
  ErasureFence,
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

export function createBackupErasureLocationPort(
  dependencies: BackupErasureLocationDependencies,
): ErasureLocationPort {
  const clock = dependencies.now ?? Date.now;
  return {
    async purge(request, fence: ErasureFence, target): Promise<PurgeAttemptReceipt> {
      const epochRef = epoch(target);
      const erasureRef = `${request.erasure_ref.id}:${request.erasure_ref.revision}`;
      let receipt: { readonly receipt_ref: string };
      try { receipt = await dependencies.port.purge(epochRef, erasureRef); }
      catch (cause) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup delete settlement is unknown", true, cause);
      }
      const write = await dependencies.database.prepare(
        "INSERT INTO backup_purge_obligation(erasure_id,erasure_revision,backup_epoch_id," +
        "target_id,state,delete_receipt_ref,updated_at) VALUES (?1,?2,?3,?4,'PENDING',?5,?6) " +
        "ON CONFLICT(erasure_id,erasure_revision,backup_epoch_id) DO UPDATE SET " +
        "delete_receipt_ref=excluded.delete_receipt_ref,updated_at=excluded.updated_at",
      ).bind(
        fence.erasure_id,
        fence.revision,
        epochRef,
        target.target_id,
        receipt.receipt_ref,
        isoFromMs(clock()),
      ).run();
      if ((write as { readonly success?: boolean }).success === false) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup purge obligation did not settle", true);
      }
      return {
        target_id: target.target_id,
        disposition: "DELETE_ACCEPTED",
        receipt_ref: receipt.receipt_ref,
      };
    },

    async verifyAbsent(request, fence, target): Promise<AbsenceVerificationReceipt> {
      const epochRef = epoch(target);
      const erasureRef = `${request.erasure_ref.id}:${request.erasure_ref.revision}`;
      let result: { readonly absent: boolean; readonly receipt_ref: string };
      try { result = await dependencies.port.verifyAbsent(epochRef, erasureRef); }
      catch (cause) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup absence readback failed", true, cause);
      }
      const write = await dependencies.database.prepare(
        "UPDATE backup_purge_obligation SET state=?5,absence_receipt_ref=?6,updated_at=?7 " +
        "WHERE erasure_id=?1 AND erasure_revision=?2 AND backup_epoch_id=?3 AND target_id=?4",
      ).bind(
        fence.erasure_id,
        fence.revision,
        epochRef,
        target.target_id,
        result.absent ? "ABSENT" : "BLOCKED",
        result.receipt_ref,
        isoFromMs(clock()),
      ).run();
      if ((write as { readonly success?: boolean }).success === false) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup absence receipt did not settle", true);
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
