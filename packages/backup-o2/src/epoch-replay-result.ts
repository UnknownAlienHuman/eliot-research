import type { BackupEpochDraft, BackupEpochResult } from "./epoch.js";
import { failBackup } from "./shared.js";
import { parsePersistedEpochReplay, type PersistedEpochReplay } from "./replay-authority.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hydrates every replay path from the same persisted bytes and identity check. */
export function replayPersistedEpoch(
  persisted: PersistedEpochReplay,
  idempotencyKey: string,
  intentId: string,
  expectedEpochId: string,
  vectorDigest: string,
): BackupEpochResult {
  const replayed = parsePersistedEpochReplay(persisted, idempotencyKey);
  let parsedDraft: unknown;
  try {
    parsedDraft = JSON.parse(persisted.draft_json);
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup persisted draft is corrupt", false, {}, cause);
  }
  if (!isRecord(parsedDraft) || typeof parsedDraft["epoch_id"] !== "string") {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup persisted draft is malformed", false, { intent_id: intentId });
  }
  if (parsedDraft["epoch_id"] !== expectedEpochId) {
    failBackup("BACKUP_INTENT_CONFLICT", "backup replay resolves to a divergent epoch", false, { intent_id: intentId });
  }
  return {
    draft: parsedDraft as unknown as BackupEpochDraft,
    attempt: replayed.attempt,
    receipt: replayed.receipt,
    vector_digest: vectorDigest,
  };
}
