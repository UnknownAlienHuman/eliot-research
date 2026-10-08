import type {
  AbsenceVerificationReceipt,
  ErasureFence,
  ErasureRequest,
  PurgeAttemptReceipt,
  PurgeTarget,
} from "@eliotr/contracts";
import {
  assertErasureIdentifier,
  canonicalErasureJson,
  erasureSha256Utf8,
  stableErasureId,
  erasureFail,
  isoFromMs,
  validateErasureRequest,
} from "./canonical.js";
import type { BackupCompositeErasurePort, BackupErasurePort, BackupPrimaryErasurePort, ErasureLocationPort } from "./types.js";

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
  readonly port: BackupCompositeErasurePort;
  readonly now?: () => number;
}

interface BackupPurgeObligationRow {
  readonly target_id: string;
  readonly state: "PENDING" | "BLOCKED" | "ABSENT";
  readonly delete_receipt_ref: string | null;
  readonly absence_receipt_ref: string | null;
  readonly primary_delete_intent_ref: string | null;
  readonly primary_delete_intent_digest: string | null;
  readonly primary_delete_receipt_ref: string | null;
  readonly primary_absence_receipt_ref: string | null;
  readonly offsite_delete_receipt_ref: string | null;
  readonly offsite_absence_receipt_ref: string | null;
}

interface ErasureExecutionFenceRow {
  readonly request_json: unknown;
  readonly request_sha256: unknown;
  readonly state: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
}

async function readObligation(
  database: D1Database,
  fence: ErasureFence,
  epochRef: string,
): Promise<BackupPurgeObligationRow | null> {
  try {
    const row = await database.prepare(
      "SELECT target_id,state,delete_receipt_ref,absence_receipt_ref,primary_delete_intent_ref," +
      "primary_delete_intent_digest,primary_delete_receipt_ref,primary_absence_receipt_ref," +
      "offsite_delete_receipt_ref,offsite_absence_receipt_ref " +
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

async function assertLiveFence(
  database: D1Database,
  request: ErasureRequest,
  fence: ErasureFence,
  expectedState: "PURGE_EACH_LOCATION" | "VERIFY_ABSENCE_OR_BLOCK",
  nowMs: number,
): Promise<void> {
  if (request.erasure_ref.id !== fence.erasure_id || request.erasure_ref.revision !== fence.revision) {
    erasureFail("ERASURE_LEASE_LOST", "backup purge request no longer matches its execution fence", true);
  }
  let row: ErasureExecutionFenceRow | null;
  try {
    row = await database.prepare(
      "SELECT request_json,request_sha256,state,lease_owner,lease_generation,lease_until " +
      "FROM erasure_execution WHERE erasure_id=?1 AND revision=?2 LIMIT 1",
    ).bind(fence.erasure_id, fence.revision).first<ErasureExecutionFenceRow>();
  } catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup erasure fence authority is unavailable", true, cause);
  }
  const requestJson = canonicalErasureJson(validateErasureRequest(request));
  const requestDigest = await erasureSha256Utf8(requestJson);
  if (
    row === null || row.request_json !== requestJson || row.request_sha256 !== requestDigest ||
    row.state !== expectedState || row.lease_owner !== fence.lease_owner ||
    row.lease_generation !== fence.lease_generation || row.lease_until !== fence.lease_until_ms ||
    typeof row.lease_until !== "number" || row.lease_until <= nowMs
  ) {
    erasureFail("ERASURE_LEASE_LOST", "backup operation no longer holds the persisted erasure execution fence", true);
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
  if (
    typeof row.target_id !== "string" || row.target_id.length === 0 ||
    (row.delete_receipt_ref !== null && (typeof row.delete_receipt_ref !== "string" || row.delete_receipt_ref.length === 0)) ||
    (row.absence_receipt_ref !== null && (typeof row.absence_receipt_ref !== "string" || row.absence_receipt_ref.length === 0)) ||
    (row.primary_delete_intent_ref !== null && (typeof row.primary_delete_intent_ref !== "string" || row.primary_delete_intent_ref.length === 0)) ||
    (row.primary_delete_intent_digest !== null && (typeof row.primary_delete_intent_digest !== "string" || !/^[a-f0-9]{64}$/u.test(row.primary_delete_intent_digest))) ||
    (row.primary_delete_receipt_ref !== null && (typeof row.primary_delete_receipt_ref !== "string" || row.primary_delete_receipt_ref.length === 0)) ||
    (row.primary_absence_receipt_ref !== null && (typeof row.primary_absence_receipt_ref !== "string" || row.primary_absence_receipt_ref.length === 0)) ||
    (row.offsite_delete_receipt_ref !== null && (typeof row.offsite_delete_receipt_ref !== "string" || row.offsite_delete_receipt_ref.length === 0)) ||
    (row.offsite_absence_receipt_ref !== null && (typeof row.offsite_absence_receipt_ref !== "string" || row.offsite_absence_receipt_ref.length === 0)) ||
    ((row.primary_delete_intent_ref === null) !== (row.primary_delete_intent_digest === null))
  ) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup purge obligation has malformed persisted receipt state");
  }
}

export function createBackupErasureLocationPort(
  dependencies: BackupErasureLocationDependencies,
): ErasureLocationPort {
  const clock = dependencies.now ?? Date.now;
  return {
    async purge(request, fence: ErasureFence, target): Promise<PurgeAttemptReceipt> {
      await assertLiveFence(dependencies.database, request, fence, "PURGE_EACH_LOCATION", clock());
      const epochRef = epoch(target);
      const erasureRef = `${request.erasure_ref.id}:${request.erasure_ref.revision}`;
      // Persist the exact erasure/epoch/target intent before the provider can
      // perform an irreversible delete. On an unknown acknowledgement, the
      // PENDING row remains available to the idempotent provider replay path.
      let intentWrite: D1Result;
      try {
        intentWrite = await dependencies.database.prepare(
          "INSERT INTO backup_purge_obligation(erasure_id,erasure_revision,backup_epoch_id," +
          "target_id,state,updated_at) SELECT ?1,?2,?3,?4,'PENDING',?5 WHERE EXISTS (" +
          "SELECT 1 FROM erasure_execution WHERE erasure_id=?6 AND revision=?7 AND lease_owner=?8 " +
          "AND lease_generation=?9 AND lease_until>?10 AND state='PURGE_EACH_LOCATION') " +
          "ON CONFLICT(erasure_id,erasure_revision,backup_epoch_id) DO NOTHING",
        ).bind(
          fence.erasure_id,
          fence.revision,
          epochRef,
          target.target_id,
          isoFromMs(clock()),
          fence.erasure_id,
          fence.revision,
          fence.lease_owner,
          fence.lease_generation,
          clock(),
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
        if (
          existing.primary_delete_intent_ref === null || existing.primary_delete_intent_digest === null ||
          existing.primary_delete_receipt_ref === null || existing.offsite_delete_receipt_ref === null
        ) {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", "persisted backup delete receipt lacks primary and offsite authority");
        }
        return {
          target_id: target.target_id,
          disposition: "DELETE_ACCEPTED",
          receipt_ref: existing.delete_receipt_ref,
        };
      }
      await assertLiveFence(dependencies.database, request, fence, "PURGE_EACH_LOCATION", clock());
      let receipt: Awaited<ReturnType<BackupCompositeErasurePort["purge"]>>;
      try { receipt = await dependencies.port.purge(epochRef, erasureRef, { target_id: target.target_id, fence }); }
      catch (cause) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup delete settlement is unknown", true, cause);
      }
      if (
        typeof receipt.receipt_ref !== "string" || receipt.receipt_ref.length === 0 ||
        typeof receipt.primary_delete_intent_ref !== "string" || receipt.primary_delete_intent_ref.length === 0 ||
        !/^[a-f0-9]{64}$/u.test(receipt.primary_delete_intent_digest) ||
        typeof receipt.primary_delete_receipt_ref !== "string" || receipt.primary_delete_receipt_ref.length === 0 ||
        typeof receipt.offsite_delete_receipt_ref !== "string" || receipt.offsite_delete_receipt_ref.length === 0
      ) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup delete result lacks exact primary or offsite receipts");
      // Provider success does not let a superseded lease publish its receipt.
      // If ownership changed during the irreversible call, leave the durable
      // obligation PENDING and report the effect as uncertain for the new owner
      // to reconcile from provider readback.
      await assertLiveFence(dependencies.database, request, fence, "PURGE_EACH_LOCATION", clock());
      const intentReadback = await readObligation(dependencies.database, fence, epochRef);
      requireObligationTarget(intentReadback, target);
      if (
        intentReadback.primary_delete_intent_ref !== receipt.primary_delete_intent_ref ||
        intentReadback.primary_delete_intent_digest !== receipt.primary_delete_intent_digest
      ) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "primary delete intent was not durably read back before receipt settlement", true);
      let receiptWrite: D1Result;
      try {
        receiptWrite = await dependencies.database.prepare(
          "UPDATE backup_purge_obligation SET delete_receipt_ref=?5,primary_delete_receipt_ref=?6," +
          "offsite_delete_receipt_ref=?7,updated_at=?8 " +
          "WHERE erasure_id=?1 AND erasure_revision=?2 AND backup_epoch_id=?3 AND target_id=?4 " +
          "AND delete_receipt_ref IS NULL AND primary_delete_intent_ref=?9 " +
          "AND primary_delete_intent_digest=?10 AND EXISTS (SELECT 1 FROM erasure_execution " +
          "WHERE erasure_id=?11 AND revision=?12 AND lease_owner=?13 AND lease_generation=?14 " +
          "AND lease_until>?15 AND state='PURGE_EACH_LOCATION')",
        ).bind(
          fence.erasure_id,
          fence.revision,
          epochRef,
          target.target_id,
          receipt.receipt_ref,
          receipt.primary_delete_receipt_ref,
          receipt.offsite_delete_receipt_ref,
          isoFromMs(clock()),
          receipt.primary_delete_intent_ref,
          receipt.primary_delete_intent_digest,
          fence.erasure_id,
          fence.revision,
          fence.lease_owner,
          fence.lease_generation,
          clock(),
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
      await assertLiveFence(dependencies.database, request, fence, "VERIFY_ABSENCE_OR_BLOCK", clock());
      const epochRef = epoch(target);
      const erasureRef = `${request.erasure_ref.id}:${request.erasure_ref.revision}`;
      const obligation = await readObligation(dependencies.database, fence, epochRef);
      requireObligationTarget(obligation, target);
      if (
        obligation.delete_receipt_ref === null || obligation.delete_receipt_ref !== purgeReceipt.receipt_ref ||
        obligation.primary_delete_receipt_ref === null || obligation.offsite_delete_receipt_ref === null
      ) {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup absence check is not bound to the persisted delete receipt");
      }
      await assertLiveFence(dependencies.database, request, fence, "VERIFY_ABSENCE_OR_BLOCK", clock());
      let result: Awaited<ReturnType<BackupCompositeErasurePort["verifyAbsent"]>>;
      try { result = await dependencies.port.verifyAbsent(epochRef, erasureRef, { target_id: target.target_id, fence }); }
      catch (cause) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup absence readback failed", true, cause);
      }
      await assertLiveFence(dependencies.database, request, fence, "VERIFY_ABSENCE_OR_BLOCK", clock());
      if (
        typeof result.receipt_ref !== "string" || result.receipt_ref.length === 0 ||
        typeof result.primary_absence_receipt_ref !== "string" || result.primary_absence_receipt_ref.length === 0 ||
        typeof result.offsite_absence_receipt_ref !== "string" || result.offsite_absence_receipt_ref.length === 0
      ) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup absence result lacks exact primary or offsite receipts");
      let write: D1Result;
      try {
        write = await dependencies.database.prepare(
        "UPDATE backup_purge_obligation SET state=?5,absence_receipt_ref=?6," +
        "primary_absence_receipt_ref=?7,offsite_absence_receipt_ref=?8,updated_at=?9 " +
        "WHERE erasure_id=?1 AND erasure_revision=?2 AND backup_epoch_id=?3 AND target_id=?4 " +
        "AND delete_receipt_ref=?10 AND primary_delete_receipt_ref IS NOT NULL " +
        "AND offsite_delete_receipt_ref IS NOT NULL AND EXISTS (SELECT 1 FROM erasure_execution " +
        "WHERE erasure_id=?11 AND revision=?12 AND lease_owner=?13 AND lease_generation=?14 " +
        "AND lease_until>?15 AND state='VERIFY_ABSENCE_OR_BLOCK')",
        ).bind(
        fence.erasure_id,
        fence.revision,
        epochRef,
        target.target_id,
        result.absent ? "ABSENT" : "BLOCKED",
        result.receipt_ref,
        result.primary_absence_receipt_ref,
        result.offsite_absence_receipt_ref,
          isoFromMs(clock()),
          purgeReceipt.receipt_ref,
          fence.erasure_id,
          fence.revision,
          fence.lease_owner,
          fence.lease_generation,
          clock(),
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
        persisted.delete_receipt_ref !== purgeReceipt.receipt_ref ||
        persisted.primary_absence_receipt_ref !== result.primary_absence_receipt_ref ||
        persisted.offsite_absence_receipt_ref !== result.offsite_absence_receipt_ref
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

export function composeBackupErasurePort(
  primary: BackupPrimaryErasurePort,
  offsite: BackupErasurePort,
): BackupCompositeErasurePort {
  return {
    async purge(epochRef, erasureRef, context) {
      const primaryReceipt = await primary.purge(epochRef, erasureRef, context);
      const offsiteReceipt = await offsite.purge(epochRef, erasureRef, context);
      return {
        receipt_ref: await stableErasureId("backup-composite-delete", context.target_id,
          primaryReceipt.receipt_ref, offsiteReceipt.receipt_ref),
        primary_delete_intent_ref: primaryReceipt.intent_ref,
        primary_delete_intent_digest: primaryReceipt.intent_digest,
        primary_delete_receipt_ref: primaryReceipt.receipt_ref,
        offsite_delete_receipt_ref: offsiteReceipt.receipt_ref,
      };
    },
    async verifyAbsent(epochRef, erasureRef, context) {
      const primaryResult = await primary.verifyAbsent(epochRef, erasureRef, context);
      const offsiteResult = await offsite.verifyAbsent(epochRef, erasureRef, context);
      return {
        absent: primaryResult.absent && offsiteResult.absent,
        receipt_ref: await stableErasureId("backup-composite-absence", context.target_id,
          primaryResult.receipt_ref, offsiteResult.receipt_ref),
        primary_absence_receipt_ref: primaryResult.receipt_ref,
        offsite_absence_receipt_ref: offsiteResult.receipt_ref,
      };
    },
  };
}
