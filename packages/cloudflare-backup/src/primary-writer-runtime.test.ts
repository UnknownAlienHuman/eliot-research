import { describe, expect, it } from "vitest";
import { backupSha256Hex, canonicalBackupJson } from "@eliotr/backup-o2";
import { parsePrimaryWriterOperation } from "./primary-writer-qualification.js";
import { readPrimaryPrefixProof } from "./primary-writer-runtime.js";

const OPERATION_NOW = "2026-10-05T00:00:00.000Z";

async function primaryWriterOperationRow(options: {
  readonly state?: string;
  readonly intent?: Record<string, unknown>;
  readonly attempt?: Record<string, unknown>;
  readonly receipt?: Record<string, unknown>;
} = {}): Promise<Record<string, unknown>> {
  const intentRef = { id: "backup-intent", revision: 1 };
  const intent = {
    intent_ref: intentRef, operation_kind: "BACKUP", principal_ref: "operator",
    idempotency_key: "writer-install-1", payload_ref: "primary-writer-qualification",
    policy_decision_ref: "policy-1", created_at: OPERATION_NOW, ...options.intent,
  };
  const admitted = options.state === "ADMITTED";
  const attempt = options.attempt ?? {
    attempt_id: "backup-attempt", intent_ref: intentRef, attempt_number: 1,
    state: admitted ? "STARTED" : "SUCCEEDED", started_at: OPERATION_NOW,
    ...(admitted ? {} : { ended_at: OPERATION_NOW }),
  };
  const receipt = options.receipt ?? {
    receipt_ref: { id: "backup-receipt", revision: 1 }, intent_ref: intentRef,
    attempt_id: "backup-attempt", outcome: admitted ? "ACCEPTED" : "SUCCEEDED",
    output_refs: admitted ? [] : ["backup-qualification"],
    readback_receipt_refs: ["backup-readback"], reconciliation_required: false,
    reason_codes: [], created_at: OPERATION_NOW,
  };
  const intentJson = canonicalBackupJson(intent);
  const attemptJson = canonicalBackupJson(attempt);
  const receiptJson = canonicalBackupJson(receipt);
  return {
    operation_ref: "backup-operation", qualification_ref: "backup-qualification", qualification_revision: 1,
    intent_ref: intent.intent_ref.id, intent_revision: intent.intent_ref.revision, intent_json: intentJson,
    intent_sha256: await backupSha256Hex(intentJson), attempt_id: "backup-attempt",
    attempt_number: 1, attempt_json: attemptJson, attempt_sha256: await backupSha256Hex(attemptJson),
    receipt_ref: "backup-receipt", receipt_json: receiptJson, receipt_sha256: await backupSha256Hex(receiptJson),
    readback_receipt_ref: "backup-readback", readback_sha256: "d".repeat(64), state: options.state ?? "COMMITTED",
    created_at: OPERATION_NOW, updated_at: OPERATION_NOW,
  };
}

async function primaryWriterOperationRowWithReceipt(overrides: Record<string, unknown>): Promise<Record<string, unknown>> {
  const row = await primaryWriterOperationRow();
  const receipt = JSON.parse(String(row.receipt_json)) as Record<string, unknown>;
  const receiptJson = canonicalBackupJson({ ...receipt, ...overrides });
  return { ...row, receipt_json: receiptJson, receipt_sha256: await backupSha256Hex(receiptJson) };
}

describe("primary writer prefix proof", () => {
  it("hashes a nonempty R2 listing as the consumer's full typed part pin", async () => {
    const part = {
      key: "backup-parts/epoch-1/schema/000001-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      epoch_id: "epoch-1",
      manifest: "schema",
      part_index: 1,
      part_sha256: "a".repeat(64),
      size_bytes: 12,
      etag: "etag-1",
      custom_metadata: {
        backup_epoch: "epoch-1", backup_vector_digest: "b".repeat(64), backup_manifest: "schema",
        backup_part_index: "1", backup_part_sha256: "a".repeat(64),
        eliotr_sha256: "a".repeat(64), eliotr_size_bytes: "12", eliotr_immutable: "true",
      },
    };
    const bucket = { list: async (options: R2ListOptions) => {
      expect(options.include).toEqual(["customMetadata"]);
      return { objects: [{ key: part.key, size: 12, etag: "etag-1", customMetadata: part.custom_metadata }], truncated: false };
    } } as unknown as R2Bucket;
    const result = await readPrimaryPrefixProof(bucket, "BACKUP_PARTS_BUCKET", "primary-bucket");
    expect(result.count).toBe(1);
    expect(result.digest).toBe(await backupSha256Hex(canonicalBackupJson([part])));
  });

  it("rejects an R2 readback that omits requested metadata", async () => {
    const bucket = { list: async () => ({ objects: [{
      key: "backup-parts/epoch-1/schema/000001-bad", size: 12, etag: "etag-1",
    }], truncated: false }) } as unknown as R2Bucket;
    await expect(readPrimaryPrefixProof(bucket, "BACKUP_PARTS_BUCKET", "primary-bucket")).rejects.toThrow("primary writer prefix object readback is malformed");
  });

  it("rejects duplicate keys and inconsistent size metadata", async () => {
    const customMetadata = {
        backup_epoch: "epoch-1", backup_vector_digest: "b".repeat(64), backup_manifest: "schema", backup_part_index: "1",
        backup_part_sha256: "a".repeat(64), eliotr_sha256: "a".repeat(64), eliotr_size_bytes: "12", eliotr_immutable: "true",
      };
    const bucket = { list: async () => ({ objects: [
      { key: "backup-parts/epoch-1/schema/000001-bad", size: 12, etag: "etag-1", customMetadata },
      { key: "backup-parts/epoch-1/schema/000001-bad", size: 12, etag: "etag-1", customMetadata },
    ], truncated: false }) } as unknown as R2Bucket;
    await expect(readPrimaryPrefixProof(bucket, "BACKUP_PARTS_BUCKET", "primary-bucket")).rejects.toThrow("listing contains a duplicate object key");
  });

  it("rejects a size metadata mismatch", async () => {
    const bucket = { list: async () => ({ objects: [{
      key: "backup-parts/epoch-1/schema/000001-size", size: 12, etag: "etag-1", customMetadata: {
        backup_epoch: "epoch-1", backup_vector_digest: "b".repeat(64), backup_manifest: "schema", backup_part_index: "1",
        backup_part_sha256: "a".repeat(64), eliotr_sha256: "a".repeat(64), eliotr_size_bytes: "11", eliotr_immutable: "true",
      },
    }], truncated: false }) } as unknown as R2Bucket;
    await expect(readPrimaryPrefixProof(bucket, "BACKUP_PARTS_BUCKET", "primary-bucket")).rejects.toThrow("exact immutable part pin");
  });
});

describe("primary writer operation readback", () => {
  it("accepts an admitted plan and a fully linked committed receipt", async () => {
    const admitted = await parsePrimaryWriterOperation(await primaryWriterOperationRow({ state: "ADMITTED" }));
    expect(admitted.state).toBe("ADMITTED");
    const committed = await parsePrimaryWriterOperation(await primaryWriterOperationRow());
    expect(committed.state).toBe("COMMITTED");
    expect(committed.receipt.output_refs).toContain(committed.qualification_ref);
    expect(committed.receipt.readback_receipt_refs).toContain(committed.readback_receipt_ref);
  });

  it("rejects attempts and receipts linked to another intent revision", async () => {
    const attemptRow = await primaryWriterOperationRow({ attempt: {
      attempt_id: "backup-attempt", intent_ref: { id: "backup-intent", revision: 2 }, attempt_number: 1,
      state: "SUCCEEDED", started_at: OPERATION_NOW, ended_at: OPERATION_NOW,
    } });
    await expect(parsePrimaryWriterOperation(attemptRow)).rejects.toThrow("primary writer operation identity diverges");

    const receiptRow = await primaryWriterOperationRow({ receipt: {
      receipt_ref: { id: "backup-receipt", revision: 1 }, intent_ref: { id: "backup-intent", revision: 2 },
      attempt_id: "backup-attempt", outcome: "SUCCEEDED", output_refs: ["backup-qualification"],
      readback_receipt_refs: ["backup-readback"], reconciliation_required: false, reason_codes: [], created_at: OPERATION_NOW,
    } });
    await expect(parsePrimaryWriterOperation(receiptRow)).rejects.toThrow("primary writer operation identity diverges");
  });

  it("rejects a failed or incomplete attempt on a committed operation", async () => {
    const failed = await primaryWriterOperationRow({ attempt: {
      attempt_id: "backup-attempt", intent_ref: { id: "backup-intent", revision: 1 }, attempt_number: 1,
      state: "FAILED", started_at: OPERATION_NOW, ended_at: OPERATION_NOW, error_code: "WRITE_FAILED",
    } });
    await expect(parsePrimaryWriterOperation(failed)).rejects.toThrow("lacks an exact successful receipt and readback");

    const incomplete = await primaryWriterOperationRow({ attempt: {
      attempt_id: "backup-attempt", intent_ref: { id: "backup-intent", revision: 1 }, attempt_number: 1,
      state: "SUCCEEDED", started_at: OPERATION_NOW,
    } });
    await expect(parsePrimaryWriterOperation(incomplete)).rejects.toThrow("lacks an exact successful receipt and readback");

    const successWithError = await primaryWriterOperationRow({ attempt: {
      attempt_id: "backup-attempt", intent_ref: { id: "backup-intent", revision: 1 }, attempt_number: 1,
      state: "SUCCEEDED", started_at: OPERATION_NOW, ended_at: OPERATION_NOW, error_code: "STALE_ERROR",
    } });
    await expect(parsePrimaryWriterOperation(successWithError)).rejects.toThrow("lacks an exact successful receipt and readback");
  });

  it("rejects an unsuccessful receipt and missing output/readback pins on commit", async () => {
    const failedReceipt = await primaryWriterOperationRowWithReceipt({ outcome: "FAILED" });
    await expect(parsePrimaryWriterOperation(failedReceipt)).rejects.toThrow("lacks an exact successful receipt and readback");

    const reconciliationPending = await primaryWriterOperationRowWithReceipt({ reconciliation_required: true });
    await expect(parsePrimaryWriterOperation(reconciliationPending)).rejects.toThrow("lacks an exact successful receipt and readback");

    const hasErrorReasons = await primaryWriterOperationRowWithReceipt({ reason_codes: ["WRITE_FAILED"] });
    await expect(parsePrimaryWriterOperation(hasErrorReasons)).rejects.toThrow("lacks an exact successful receipt and readback");

    const missingOutput = await primaryWriterOperationRowWithReceipt({ output_refs: [] });
    await expect(parsePrimaryWriterOperation(missingOutput)).rejects.toThrow("lacks an exact successful receipt and readback");

    const missingReadback = await primaryWriterOperationRowWithReceipt({ readback_receipt_refs: [] });
    await expect(parsePrimaryWriterOperation(missingReadback)).rejects.toThrow("lacks an exact successful receipt and readback");
  });

  it("rejects unknown states, malformed IDs, and divergent canonical digests", async () => {
    await expect(parsePrimaryWriterOperation(await primaryWriterOperationRow({ state: "SUCCESS" }))).rejects.toThrow("primary writer operation state is invalid");

    const malformedIntent = await primaryWriterOperationRow({ intent: { principal_ref: "" } });
    await expect(parsePrimaryWriterOperation(malformedIntent)).rejects.toThrow();

    const changedDigest = await primaryWriterOperationRow();
    changedDigest.receipt_sha256 = "0".repeat(64);
    await expect(parsePrimaryWriterOperation(changedDigest)).rejects.toThrow("primary writer operation digest diverges");
  });
});
