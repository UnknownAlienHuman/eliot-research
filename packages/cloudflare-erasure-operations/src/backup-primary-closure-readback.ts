import type { ErasureFence } from "@eliotr/contracts";
import { canonicalErasureJson, erasureFail } from "@eliotr/cloudflare-erasure";

interface D1Rows<T> {
  readonly success?: boolean;
  readonly results?: readonly T[];
}

async function all<T>(database: D1Database, sql: string, values: readonly (string | number)[]): Promise<readonly T[]> {
  let result: D1Rows<T>;
  try { result = await database.prepare(sql).bind(...values).all<T>(); }
  catch (cause) { erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup closure child readback failed", true, cause); }
  if (result.success !== true || !Array.isArray(result.results) || result.results.length > 100_000) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup closure child readback is malformed or over its bound");
  }
  return result.results;
}

export async function verifyBackupPrimaryClosureChildren(
  database: D1Database,
  fence: ErasureFence,
  claims: readonly Record<string, unknown>[],
  cuts: readonly Record<string, unknown>[],
  targets: readonly Record<string, unknown>[],
  parts: readonly Record<string, unknown>[],
  deletions: readonly Record<string, unknown>[],
): Promise<void> {
  const key = [fence.erasure_id, fence.revision, fence.lease_generation] as const;
  const specs: readonly [string, readonly string[], readonly string[], readonly Record<string, unknown>[]][] = [
    ["backup_erasure_primary_claim_pin", ["erasure_id", "erasure_revision", "lease_generation", "idempotency_key",
      "base_intent_digest", "attempt_nonce", "state", "epoch_id", "part_prefix", "cut_id", "cut_digest",
      "vector_digest", "manifest_digest", "intent_digest", "receipt_digest"], ["idempotency_key"], claims],
    ["backup_erasure_primary_cut_pin", ["erasure_id", "erasure_revision", "lease_generation", "cut_id", "cut_digest",
      "state", "classification", "idempotency_key"], ["cut_id"], cuts],
    ["backup_erasure_primary_target_pin", ["erasure_id", "erasure_revision", "lease_generation", "target_id",
      "backup_epoch_id", "target_json", "identity_digest", "target_digest"], ["target_id"], targets],
    ["backup_erasure_primary_part_pin", ["erasure_id", "erasure_revision", "lease_generation", "part_key",
      "backup_epoch_id", "manifest", "part_index", "part_sha256", "payload_identity_digest", "payload_part_count",
      "size_bytes", "etag", "custom_metadata_json", "object_digest", "is_target_part"], ["part_key"], parts],
    ["backup_erasure_primary_delete_item", ["erasure_id", "erasure_revision", "lease_generation", "target_id",
      "part_key", "state", "delete_intent_ref", "delete_intent_digest", "delete_receipt_ref", "absence_receipt_ref",
      "updated_at"], ["target_id", "part_key"], deletions],
  ];
  for (const [table, columns, identity, expected] of specs) {
    const select = [...columns].sort();
    const actual = await all<Record<string, unknown>>(database,
      `SELECT ${select.join(",")} FROM ${table} WHERE erasure_id=?1 AND erasure_revision=?2 AND lease_generation=?3 ORDER BY ${identity.join(",")}`,
      key);
    const sortedExpected = [...expected].sort((left, right) => identity.map((column) => String(left[column]))
      .join("\u0000").localeCompare(identity.map((column) => String(right[column])).join("\u0000")));
    const normalizedActual = actual.map((row) => Object.fromEntries(select.map((column) => [column, row[column]])));
    const normalizedExpected = sortedExpected.map((row) => Object.fromEntries(select.map((column) => [column, row[column]])));
    if (canonicalErasureJson(normalizedActual) !== canonicalErasureJson(normalizedExpected)) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", `backup primary ${table} readback diverges from its immutable plan`);
    }
  }
}
