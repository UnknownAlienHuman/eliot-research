import type { ErasureFence } from "@eliotr/contracts";
import {
  backupPrimaryQualificationInput,
  canonicalErasureJson,
  erasureDigest,
  erasureFail,
} from "@eliotr/cloudflare-erasure";
import type {
  BackupEpochScopeInventory,
  BackupExportCutInventory,
  BackupPrimaryPartInventorySnapshot,
  BackupPrimaryWriterQualificationReceipt,
  BackupProducerQuiescenceSnapshot,
} from "@eliotr/cloudflare-erasure";
import { parseHandoffQualification } from "@eliotr/cloudflare-erasure";
import { readD1BackupEpochScopeInventory } from "./backup-epoch-reader.js";
import { currentBackupPrimaryExecution, readBackupExportCutInventory } from "./backup-primary-closure.js";
import {
  allowedMissing,
  compareChildRows,
  currentCutPins,
  expectedClaimPins,
  pinObject,
  receiptFromHeader,
  readText,
  sameQualification,
  type Dependencies,
  type LoadedClosure,
} from "./backup-primary-purge-plan.js";

async function currentQualification(
  dependencies: Dependencies,
  fence: ErasureFence,
  closure: LoadedClosure,
  producer: BackupProducerQuiescenceSnapshot,
  cuts: BackupExportCutInventory,
  primary: BackupPrimaryPartInventorySnapshot,
): Promise<BackupPrimaryWriterQualificationReceipt> {
  if (dependencies.qualification === undefined) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "current primary writer qualification verifier is unavailable");
  }
  const requestSha = readText(closure.header.request_sha256, "request digest");
  const input = backupPrimaryQualificationInput(fence, requestSha, producer, cuts, primary);
  let verified: BackupPrimaryWriterQualificationReceipt;
  try { verified = await dependencies.qualification.assertCurrentQualification(input); }
  catch (cause) { erasureFail("ERASURE_CLOSURE_INCOMPLETE", "persisted primary writer qualification is no longer current", false, cause); }
  const original = receiptFromHeader(closure.header);
  if (await erasureDigest(original) !== closure.header.qualification_receipt_digest) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "historical primary qualification digest differs from its immutable closure");
  }
  const stored = closure.handoff === null ? original : await parseHandoffQualification(closure.handoff);
  if (!sameQualification(verified, stored) || verified.primary_prefix_inventory_digest !== primary.inventory_digest ||
      verified.producer_claims_digest !== producer.claims_digest ||
      verified.export_cut_inventory_digest !== cuts.inventory_digest) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "current primary writer qualification differs from its durable authority pins");
  }
  if (closure.handoff !== null &&
      stored.primary_prefix_inventory_digest !== closure.handoff.current_primary_prefix_inventory_digest) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "handoff qualification is not bound to its persisted current prefix readback");
  }
  return verified;
}

export async function assertClosedGateAndInventory(
  dependencies: Dependencies,
  fence: ErasureFence,
  closure: LoadedClosure,
  stage: "PURGE_EACH_LOCATION" | "VERIFY_ABSENCE_OR_BLOCK",
): Promise<{
  readonly producer: BackupProducerQuiescenceSnapshot;
  readonly cuts: BackupExportCutInventory;
  readonly inventory: BackupEpochScopeInventory;
}> {
  const now = dependencies.now ?? Date.now;
  const execution = await currentBackupPrimaryExecution(dependencies.database, fence, stage, now());
  if (execution.request_sha256 !== closure.header.request_sha256 ||
      execution.closure_digest !== closure.header.erasure_closure_digest) {
    erasureFail("ERASURE_LEASE_LOST", "backup primary closure no longer matches the current active erasure", true);
  }
  let producer: BackupProducerQuiescenceSnapshot;
  try {
    producer = await dependencies.backup_producer_quiescence.assertQuiescent({
      erasure_id: fence.erasure_id,
      revision: fence.revision,
    });
  } catch (cause) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup producer set is no longer authoritatively quiescent", false, cause);
  }
  const cuts = await readBackupExportCutInventory(dependencies.database);
  if (producer.claims_digest !== closure.header.producer_claims_digest ||
      producer.canonical_epoch_count !== closure.header.canonical_epoch_count ||
      producer.canonical_epochs_digest !== closure.header.canonical_epochs_digest ||
      cuts.inventory_digest !== closure.header.export_cut_inventory_digest) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "backup producer or export-cut pins changed after closure sealing");
  }
  const expectedPlanDigest = await erasureDigest({
    protocol: "eliotr.backup-primary-delete-plan.v1",
    erasure_id: closure.plan_fence.erasure_id,
    revision: closure.plan_fence.revision,
    lease_owner: closure.plan_fence.lease_owner,
    lease_generation: closure.plan_fence.lease_generation,
    lease_until: closure.plan_fence.lease_until_ms,
    request_sha256: closure.header.request_sha256,
    erasure_closure_digest: closure.header.erasure_closure_digest,
    producer_claims_digest: producer.claims_digest,
    canonical_epochs_digest: producer.canonical_epochs_digest,
    export_cut_inventory_digest: cuts.inventory_digest,
    qualification_digest: closure.header.qualification_receipt_digest,
    primary_prefix_inventory_digest: closure.header.primary_prefix_inventory_digest,
    target_digest: closure.header.target_digest,
    target_part_digest: closure.header.target_part_digest,
  });
  if (expectedPlanDigest !== closure.header.plan_digest) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "backup primary plan digest differs from its exact current qualifications");
  }
  const key = [fence.erasure_id, fence.revision, closure.plan_generation] as const;
  const expectedClaimColumns = ["erasure_id", "erasure_revision", "lease_generation", "idempotency_key", "base_intent_digest",
    "attempt_nonce", "state", "epoch_id", "part_prefix", "cut_id", "cut_digest", "vector_digest", "manifest_digest",
    "intent_digest", "receipt_digest"] as const;
  await compareChildRows(dependencies.database, "backup_erasure_primary_claim_pin", expectedClaimColumns, key,
    ["idempotency_key"], expectedClaimPins(producer, closure.plan_fence));
  const expectedCuts = await currentCutPins(closure.plan_fence, cuts, producer);
  await compareChildRows(dependencies.database, "backup_erasure_primary_cut_pin", ["erasure_id", "erasure_revision",
    "lease_generation", "cut_id", "cut_digest", "state", "classification", "idempotency_key"], key, ["cut_id"], expectedCuts);
  const missing = await allowedMissing(closure);
  const inventory = await readD1BackupEpochScopeInventory(dependencies.database, dependencies.bucket, {
    allowed_missing_keys: missing,
  });
  const stored = closure.parts.map(pinObject);
  const storedByKey = new Map(stored.map((pin) => [pin.key, pin]));
  for (const pin of inventory.primary_parts.objects) {
    const storedPin = storedByKey.get(pin.key);
    if (storedPin === undefined || canonicalErasureJson(pin) !== canonicalErasureJson(storedPin)) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "a present primary R2 object differs from its sealed byte and metadata pins");
    }
  }
  const actualKeys = new Set(inventory.primary_parts.objects.map((pin) => pin.key));
  const actualMissing = new Set(inventory.primary_parts.missing_keys);
  const expectedPresent = stored.filter((pin) => actualKeys.has(pin.key));
  const expectedMissing = stored.filter((pin) => !actualKeys.has(pin.key)).map((pin) => pin.key);
  if (inventory.primary_parts.objects.length !== expectedPresent.length ||
      await erasureDigest(inventory.primary_parts.objects) !== await erasureDigest(expectedPresent) ||
      inventory.primary_parts.missing_keys.length !== expectedMissing.length ||
      expectedMissing.some((keyName) => !inventory.primary_parts.missing_keys.includes(keyName)) ||
      inventory.primary_parts.missing_keys.some((keyName) => !storedByKey.has(keyName) || !missing.has(keyName))) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "current primary prefix does not match the sealed plan and exact delete obligations");
  }
  for (const item of closure.deleteItems.values()) {
    if ((item.state === "DELETED" || item.state === "ABSENT") && !actualMissing.has(String(item.part_key))) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "a primary object reappeared after its delete readback");
    }
  }
  await currentQualification(dependencies, fence, closure, producer, cuts, inventory.primary_parts);
  return { producer, cuts, inventory };
}
