import type { ErasureFence } from "@eliotr/contracts";
import { canonicalErasureJson, erasureDigest, erasureFail, isoFromMs, stableErasureId } from "@eliotr/cloudflare-erasure";
import { currentBackupPrimaryExecution } from "./backup-primary-closure.js";
import { assertClosedGateAndInventory } from "./backup-primary-purge-gate.js";
import type { BackupPrimaryErasurePort, BackupPrimaryObjectPin } from "@eliotr/cloudflare-erasure";
import {
  loadClosure,
  exactDeleteIntent,
  pinObject,
  targetDeleteItems,
  targetEpoch,
  type DeleteRow,
  type Dependencies,
  type LoadedClosure,
} from "./backup-primary-purge-plan.js";

function rec(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", `backup primary ${label} is malformed`);
  }
  return value;
}

async function first<T>(database: D1Database, sql: string, values: readonly (string | number)[]): Promise<T | null> {
  try { return await database.prepare(sql).bind(...values).first<T>(); }
  catch (cause) { erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup primary deletion D1 read failed", true, cause); }
}

async function run(database: D1Database, sql: string, values: readonly (string | number | null)[]): Promise<void> {
  try {
    const result = await database.prepare(sql).bind(...values).run();
    if ((result as { readonly success?: boolean }).success === false) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup primary deletion intent did not settle", true);
    }
  } catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup primary deletion intent did not settle", true, cause);
  }
}

interface ObligationRow {
  readonly target_id: unknown;
  readonly primary_delete_intent_ref: unknown;
  readonly primary_delete_intent_digest: unknown;
  readonly primary_delete_receipt_ref: unknown;
  readonly primary_absence_receipt_ref: unknown;
  readonly offsite_delete_receipt_ref: unknown;
  readonly offsite_absence_receipt_ref: unknown;
  readonly delete_receipt_ref: unknown;
}
async function persistObligationIntent(
  dependencies: Dependencies,
  fence: ErasureFence,
  closure: LoadedClosure,
  targetId: string,
  epochId: string,
  intentRef: string,
  intentDigest: string,
): Promise<ObligationRow> {
  const existing = await first<ObligationRow>(dependencies.database,
    "SELECT target_id,primary_delete_intent_ref,primary_delete_intent_digest,primary_delete_receipt_ref," +
      "primary_absence_receipt_ref,offsite_delete_receipt_ref,offsite_absence_receipt_ref,delete_receipt_ref " +
      "FROM backup_purge_obligation WHERE erasure_id=?1 AND erasure_revision=?2 AND backup_epoch_id=?3 LIMIT 1",
    [fence.erasure_id, fence.revision, epochId]);
  if (existing === null || existing.target_id !== targetId) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup target lacks its durable erasure deletion obligation");
  }
  if (existing.primary_delete_intent_ref !== null || existing.primary_delete_intent_digest !== null) {
    if (existing.primary_delete_intent_ref !== intentRef || existing.primary_delete_intent_digest !== intentDigest) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "backup primary delete intent is bound to another closure plan");
    }
    return existing;
  }
  await currentBackupPrimaryExecution(dependencies.database, fence, "PURGE_EACH_LOCATION", (dependencies.now ?? Date.now)());
  await run(dependencies.database,
    "UPDATE backup_purge_obligation SET primary_delete_intent_ref=?5,primary_delete_intent_digest=?6,updated_at=?7 " +
      "WHERE erasure_id=?1 AND erasure_revision=?2 AND backup_epoch_id=?3 AND target_id=?4 " +
      "AND primary_delete_intent_ref IS NULL AND primary_delete_intent_digest IS NULL AND EXISTS (" +
      "SELECT 1 FROM backup_erasure_primary_active_plan a WHERE a.erasure_id=?1 AND a.erasure_revision=?2 " +
      "AND a.plan_lease_generation=?8 AND a.current_lease_generation=?12 AND a.current_lease_owner=?9 " +
      "AND a.current_lease_until=?10 AND a.current_lease_until>?11 AND a.execution_state='PURGE_EACH_LOCATION' " +
      "AND a.erasure_closure_digest=?13)",
    [fence.erasure_id, fence.revision, epochId, targetId, intentRef, intentDigest,
      isoFromMs((dependencies.now ?? Date.now)()), closure.plan_generation, fence.lease_owner,
      fence.lease_until_ms, (dependencies.now ?? Date.now)(), fence.lease_generation,
      closure.header.erasure_closure_digest as string]);
  const persisted = await first<ObligationRow>(dependencies.database,
    "SELECT target_id,primary_delete_intent_ref,primary_delete_intent_digest,primary_delete_receipt_ref," +
      "primary_absence_receipt_ref,offsite_delete_receipt_ref,offsite_absence_receipt_ref,delete_receipt_ref " +
      "FROM backup_purge_obligation WHERE erasure_id=?1 AND erasure_revision=?2 AND backup_epoch_id=?3 LIMIT 1",
    [fence.erasure_id, fence.revision, epochId]);
  if (persisted === null || persisted.target_id !== targetId || persisted.primary_delete_intent_ref !== intentRef ||
      persisted.primary_delete_intent_digest !== intentDigest) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "primary delete intent did not pass exact durable readback", true);
  }
  return persisted;
}

async function exactHead(bucket: R2Bucket, pin: BackupPrimaryObjectPin): Promise<boolean> {
  let value: unknown;
  try { value = await bucket.head(pin.key); }
  catch (cause) { erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "primary R2 head readback failed", true, cause); }
  if (value === null) return false;
  if (!rec(value) || value["key"] !== pin.key || value["size"] !== pin.size_bytes || value["etag"] !== pin.etag ||
      !rec(value["customMetadata"]) || canonicalErasureJson(value["customMetadata"]) !== canonicalErasureJson(pin.custom_metadata)) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "present primary R2 object differs from its exact immutable part pins");
  }
  return true;
}

async function readDeleteItem(
  database: D1Database,
  fence: ErasureFence,
  planGeneration: number,
  targetId: string,
  partKey: string,
): Promise<DeleteRow> {
  const row = await first<DeleteRow>(database,
    "SELECT target_id,part_key,state,delete_intent_ref,delete_intent_digest,delete_receipt_ref,absence_receipt_ref,updated_at " +
      "FROM backup_erasure_primary_delete_item WHERE erasure_id=?1 AND erasure_revision=?2 AND lease_generation=?3 " +
      "AND target_id=?4 AND part_key=?5 LIMIT 1",
    [fence.erasure_id, fence.revision, planGeneration, targetId, partKey]);
  if (row === null) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "planned primary delete item disappeared");
  return row;
}

async function transitionDeleteItem(
  dependencies: Dependencies,
  fence: ErasureFence,
  planGeneration: number,
  stage: "PURGE_EACH_LOCATION" | "VERIFY_ABSENCE_OR_BLOCK",
  old: DeleteRow,
  nextState: "DELETE_INTENT" | "UNKNOWN" | "DELETED" | "ABSENT",
  intentRef: string,
  intentDigest: string,
  deleteReceiptRef: string | null,
  absenceReceiptRef: string | null,
): Promise<DeleteRow> {
  const now = (dependencies.now ?? Date.now)();
  await currentBackupPrimaryExecution(dependencies.database, fence, stage, now);
  const updated = typeof old.updated_at === "string" && old.updated_at > isoFromMs(now) ? old.updated_at : isoFromMs(now);
  await run(dependencies.database,
    "UPDATE backup_erasure_primary_delete_item SET state=?6,delete_intent_ref=?7,delete_intent_digest=?8," +
      "delete_receipt_ref=COALESCE(?9,delete_receipt_ref),absence_receipt_ref=COALESCE(?10,absence_receipt_ref),updated_at=?11 " +
      "WHERE erasure_id=?1 AND erasure_revision=?2 AND lease_generation=?3 AND target_id=?4 AND part_key=?5 " +
      "AND state=?12 AND EXISTS (SELECT 1 FROM backup_erasure_primary_active_plan a " +
      "WHERE a.erasure_id=?1 AND a.erasure_revision=?2 AND a.plan_lease_generation=?3 " +
      "AND a.execution_state=?13 AND a.current_lease_owner=?14 AND a.current_lease_generation=?15 " +
      "AND a.current_lease_until=?16 AND a.current_lease_until>?17 AND a.erasure_closure_digest=?18)",
    [fence.erasure_id, fence.revision, planGeneration, old.target_id as string, old.part_key as string,
      nextState, intentRef, intentDigest, deleteReceiptRef, absenceReceiptRef, updated, old.state as string,
      stage, fence.lease_owner, fence.lease_generation, fence.lease_until_ms, now,
      (await currentBackupPrimaryExecution(dependencies.database, fence, stage, now)).closure_digest as string]);
  const persisted = await readDeleteItem(dependencies.database, fence, planGeneration, old.target_id as string, old.part_key as string);
  if (persisted.state !== nextState || persisted.delete_intent_ref !== intentRef ||
      persisted.delete_intent_digest !== intentDigest ||
      (deleteReceiptRef !== null && persisted.delete_receipt_ref !== deleteReceiptRef) ||
      (absenceReceiptRef !== null && persisted.absence_receipt_ref !== absenceReceiptRef)) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "primary per-key delete transition failed exact readback", true);
  }
  return persisted;
}

async function itemIntent(
  planFence: ErasureFence,
  targetId: string,
  pin: BackupPrimaryObjectPin,
  planDigest: string,
): Promise<{ readonly ref: string; readonly digest: string }> {
  return exactDeleteIntent(planFence, targetId, pin, planDigest);
}

async function markMissingDeleted(
  dependencies: Dependencies,
  fence: ErasureFence,
  closure: LoadedClosure,
  targetId: string,
  item: DeleteRow,
  pin: BackupPrimaryObjectPin,
  planDigest: string,
  stage: "PURGE_EACH_LOCATION" | "VERIFY_ABSENCE_OR_BLOCK",
): Promise<DeleteRow> {
  const intent = await itemIntent(closure.plan_fence, targetId, pin, planDigest);
  if (item.delete_intent_ref !== intent.ref || item.delete_intent_digest !== intent.digest) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "primary delete row is not bound to the exact immutable part intent");
  }
  const receipt = await stableErasureId("backup-primary-delete-readback", intent.ref, pin.key, pin.part_sha256, pin.etag);
  return transitionDeleteItem(dependencies, fence, closure.plan_generation, stage, item, "DELETED", intent.ref, intent.digest, receipt, null);
}

function plannedPin(closure: LoadedClosure, partKey: string): BackupPrimaryObjectPin {
  const pin = closure.parts.find((candidate) => candidate.key === partKey);
  if (pin === undefined) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "delete item refers to no sealed primary part pin");
  return pinObject(pin);
}

export function createPrimaryBackupErasurePort(dependencies: Dependencies): BackupPrimaryErasurePort {
  const now = dependencies.now ?? Date.now;
  return {
    async purge(epochRef, erasureRef, context) {
      const { fence, target_id: targetId } = context;
      if (erasureRef !== `${fence.erasure_id}:${fence.revision}`) {
        erasureFail("ERASURE_LEASE_LOST", "primary backup erasure ref does not match the acquired fence", true);
      }
      const closure = await loadClosure(dependencies.database, fence, now(), "PURGE_EACH_LOCATION");
      const target = closure.targets.get(targetId);
      if (target === undefined || targetEpoch(target) !== epochRef) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "primary backup target differs from the sealed closure");
      }
      await assertClosedGateAndInventory(dependencies, fence, closure, "PURGE_EACH_LOCATION");
      const targetItems = targetDeleteItems(closure, targetId);
      const partPins = targetItems.map((item) => plannedPin(closure, String(item.part_key)));
      const planFence = closure.plan_fence;
      const intentRef = await stableErasureId("backup-primary-epoch-delete", planFence.erasure_id, String(planFence.revision),
        String(planFence.lease_generation), targetId, String(closure.header.plan_digest));
      const intentDigest = await erasureDigest({ protocol: "eliotr.backup-primary-epoch-delete-intent.v1", intent_ref: intentRef,
        erasure_id: planFence.erasure_id, revision: planFence.revision, lease_owner: planFence.lease_owner,
        lease_generation: planFence.lease_generation, lease_until_ms: planFence.lease_until_ms,
        target, closure_digest: closure.header.erasure_closure_digest, plan_digest: closure.header.plan_digest,
        part_pins: partPins });
      const obligation = await persistObligationIntent(dependencies, fence, closure, targetId, epochRef, intentRef, intentDigest);
      if (obligation.delete_receipt_ref !== null && obligation.primary_delete_receipt_ref !== null) {
        return {
          intent_ref: intentRef,
          intent_digest: intentDigest,
          receipt_ref: requiredText(obligation.primary_delete_receipt_ref, "delete receipt ref"),
        };
      }
      for (const original of targetItems) {
        let item = await readDeleteItem(dependencies.database, fence, closure.plan_generation, targetId, String(original.part_key));
        const pin = plannedPin(closure, String(item.part_key));
        const intent = await itemIntent(planFence, targetId, pin, String(closure.header.plan_digest));
        if (item.state === "ABSENT" || item.state === "DELETED") continue;
        if (item.state === "DELETE_INTENT") {
          if (item.delete_intent_ref !== intent.ref || item.delete_intent_digest !== intent.digest) {
            erasureFail("ERASURE_IDENTITY_CONFLICT", "in-flight primary delete differs from its sealed key plan");
          }
          if (!(await exactHead(dependencies.bucket, pin))) {
            await markMissingDeleted(dependencies, fence, closure, targetId, item, pin, String(closure.header.plan_digest), "PURGE_EACH_LOCATION");
            continue;
          }
          await transitionDeleteItem(dependencies, fence, closure.plan_generation, "PURGE_EACH_LOCATION", item, "UNKNOWN", intent.ref, intent.digest, null, null);
          erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "previous primary delete acknowledgement remains unresolved", true);
        }
        if (item.state === "UNKNOWN") {
          if (item.delete_intent_ref !== intent.ref || item.delete_intent_digest !== intent.digest) {
            erasureFail("ERASURE_IDENTITY_CONFLICT", "unknown primary delete is bound to another key plan");
          }
          if (!(await exactHead(dependencies.bucket, pin))) {
            await markMissingDeleted(dependencies, fence, closure, targetId, item, pin, String(closure.header.plan_digest), "PURGE_EACH_LOCATION");
            continue;
          }
          item = await transitionDeleteItem(dependencies, fence, closure.plan_generation, "PURGE_EACH_LOCATION", item, "DELETE_INTENT", intent.ref, intent.digest, null, null);
        } else if (item.state === "PINNED") {
          if (!(await exactHead(dependencies.bucket, pin))) {
            erasureFail("ERASURE_CLOSURE_INCOMPLETE", "planned primary part is absent before any durable delete intent");
          }
          item = await transitionDeleteItem(dependencies, fence, closure.plan_generation, "PURGE_EACH_LOCATION", item, "DELETE_INTENT", intent.ref, intent.digest, null, null);
        } else {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", "primary delete item has an unsupported state");
        }
        await currentBackupPrimaryExecution(dependencies.database, fence, "PURGE_EACH_LOCATION", now());
        if (!(await exactHead(dependencies.bucket, pin))) {
          await markMissingDeleted(dependencies, fence, closure, targetId, item, pin, String(closure.header.plan_digest), "PURGE_EACH_LOCATION");
          continue;
        }
        try { await dependencies.bucket.delete(pin.key); }
        catch (cause) {
          const current = await readDeleteItem(dependencies.database, fence, closure.plan_generation, targetId, pin.key);
          if (current.state === "DELETE_INTENT") {
            await transitionDeleteItem(dependencies, fence, closure.plan_generation, "PURGE_EACH_LOCATION", current, "UNKNOWN", intent.ref, intent.digest, null, null);
          }
          erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "primary R2 delete acknowledgement is unknown", true, cause);
        }
        await currentBackupPrimaryExecution(dependencies.database, fence, "PURGE_EACH_LOCATION", now());
        if (await exactHead(dependencies.bucket, pin)) {
          const current = await readDeleteItem(dependencies.database, fence, closure.plan_generation, targetId, pin.key);
          await transitionDeleteItem(dependencies, fence, closure.plan_generation, "PURGE_EACH_LOCATION", current, "UNKNOWN", intent.ref, intent.digest, null, null);
          erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "primary R2 delete readback still finds the exact planned object", true);
        }
        const current = await readDeleteItem(dependencies.database, fence, closure.plan_generation, targetId, pin.key);
        await markMissingDeleted(dependencies, fence, closure, targetId, current, pin, String(closure.header.plan_digest), "PURGE_EACH_LOCATION");
      }
      const refreshed = await loadClosure(dependencies.database, fence, now());
      await assertClosedGateAndInventory(dependencies, fence, refreshed, "PURGE_EACH_LOCATION");
      const remaining = targetDeleteItems(refreshed, targetId);
      if (remaining.some((item) => item.state !== "DELETED" && item.state !== "ABSENT")) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "primary delete plan is not terminal after exact readback", true);
      }
      const receiptRef = await stableErasureId("backup-primary-delete-receipt", intentRef, intentDigest,
        ...remaining.map((item) => String(item.delete_receipt_ref)));
      return { intent_ref: intentRef, intent_digest: intentDigest, receipt_ref: receiptRef };
    },

    async verifyAbsent(epochRef, erasureRef, context) {
      const { fence, target_id: targetId } = context;
      if (erasureRef !== `${fence.erasure_id}:${fence.revision}`) {
        erasureFail("ERASURE_LEASE_LOST", "primary backup erasure ref does not match the acquired fence", true);
      }
      const closure = await loadClosure(dependencies.database, fence, now(), "VERIFY_ABSENCE_OR_BLOCK");
      const target = closure.targets.get(targetId);
      if (target === undefined || targetEpoch(target) !== epochRef) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "primary backup absence target differs from the sealed closure");
      }
      const gate = await assertClosedGateAndInventory(dependencies, fence, closure, "VERIFY_ABSENCE_OR_BLOCK");
      const targetItems = targetDeleteItems(closure, targetId);
      const primaryPresent = targetItems.some((item) => !gate.inventory.primary_parts.missing_keys.includes(String(item.part_key)));
      const completeIntent = targetItems.every((item) => ["DELETE_INTENT", "UNKNOWN", "DELETED", "ABSENT"].includes(String(item.state)));
      if (primaryPresent || !completeIntent) {
        const receipt = await stableErasureId("backup-primary-absence-not-proven", targetId,
          String(closure.header.plan_digest), await erasureDigest(gate.inventory.primary_parts.objects));
        return { absent: false, receipt_ref: receipt };
      }
      for (const old of targetItems) {
        let item = await readDeleteItem(dependencies.database, fence, closure.plan_generation, targetId, String(old.part_key));
        const pin = plannedPin(closure, String(item.part_key));
        if (item.state === "DELETE_INTENT" || item.state === "UNKNOWN") {
          item = await markMissingDeleted(dependencies, fence, closure, targetId, item, pin,
            String(closure.header.plan_digest), "VERIFY_ABSENCE_OR_BLOCK");
        }
        if (item.state === "DELETED") {
          const intent = await itemIntent(closure.plan_fence, targetId, pin, String(closure.header.plan_digest));
          const absence = await stableErasureId("backup-primary-part-absence", intent.ref, pin.key,
            String(closure.header.primary_prefix_inventory_digest), await erasureDigest(gate.inventory.primary_parts.objects));
          await transitionDeleteItem(dependencies, fence, closure.plan_generation, "VERIFY_ABSENCE_OR_BLOCK", item, "ABSENT",
            intent.ref, intent.digest, String(item.delete_receipt_ref), absence);
        } else if (item.state !== "ABSENT") {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", "primary part lacks a durable delete receipt before absence closure");
        }
      }
      const finalClosure = await loadClosure(dependencies.database, fence, now(), "VERIFY_ABSENCE_OR_BLOCK");
      const finalGate = await assertClosedGateAndInventory(dependencies, fence, finalClosure, "VERIFY_ABSENCE_OR_BLOCK");
      if (targetDeleteItems(finalClosure, targetId).some((item) => item.state !== "ABSENT") ||
          targetDeleteItems(finalClosure, targetId).some((item) => !finalGate.inventory.primary_parts.missing_keys.includes(String(item.part_key)))) {
        erasureFail("ERASURE_ABSENCE_UNPROVEN", "primary R2 absence readback does not match all planned target keys");
      }
      return {
        absent: true,
        receipt_ref: await stableErasureId("backup-primary-absence-receipt", targetId,
          String(finalClosure.header.plan_digest), await erasureDigest(finalGate.inventory.primary_parts.objects)),
      };
    },
  };
}
