import { IdentifierSchema, PositiveIntegerSchema, ScopeSnapshotSchema, type ScopeSnapshot } from "@eliotr/contracts";
import { normalizeScopeExpression, scopeSnapshotDigestPayload, scopeSnapshotIdentityPayload } from "@eliotr/domain";
import { canonicalEvidenceJson, evidenceSha256Bytes } from "./canonical.js";

export { canonicalEvidenceJson as canonicalScopeStorageJson } from "./canonical.js";

// Below D1's 2,000,000-byte row ceiling, including column/JSON encoding overhead.
export const MAX_D1_SCOPE_BYTES = 1_000_000;
const encoder = new TextEncoder();
export class ScopePersistenceError extends Error {
  public readonly code: string;
  public constructor(code: string) { super(code); this.name = "ScopePersistenceError"; this.code = code; }
}
export function scopePersistenceFailure(code: string): never { throw new ScopePersistenceError(code); }

/** Bound untrusted JS/JSON before recursive schema decoding, canonicalization or hashing. */
export function boundedScopeValue(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  const objects = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    if (++nodes > 100_000 || item.depth > 40) scopePersistenceFailure("SCOPE_STORAGE_RESOURCE_LIMIT");
    const current = item.value;
    if (typeof current === "string") {
      if (current.length > MAX_D1_SCOPE_BYTES) scopePersistenceFailure("SCOPE_STORAGE_RESOURCE_LIMIT");
      bytes += encoder.encode(current).byteLength;
    } else if (current !== null && typeof current === "object") {
      // Alias/cycle rejection prevents exponentially repeated subtrees as well as recursive inputs.
      if (objects.has(current)) scopePersistenceFailure("SCOPE_STORAGE_RESOURCE_LIMIT");
      objects.add(current);
      if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype &&
          Object.getPrototypeOf(current) !== null) scopePersistenceFailure("SCOPE_STORAGE_INVALID");
      if (Array.isArray(current) && current.length > 100_000) scopePersistenceFailure("SCOPE_STORAGE_RESOURCE_LIMIT");
      let entries = 0;
      for (const key in current) {
        if (!Object.hasOwn(current, key)) continue;
        if (nodes + pending.length >= 100_000) scopePersistenceFailure("SCOPE_STORAGE_RESOURCE_LIMIT");
        if (key.length > MAX_D1_SCOPE_BYTES) scopePersistenceFailure("SCOPE_STORAGE_RESOURCE_LIMIT");
        bytes += encoder.encode(key).byteLength + 4;
        if (bytes > MAX_D1_SCOPE_BYTES) scopePersistenceFailure("SCOPE_STORAGE_RESOURCE_LIMIT");
        const child = (current as Record<string, unknown>)[key];
        pending.push({ value: child, depth: item.depth + 1 });
        entries += 1;
      }
      if (Array.isArray(current) && entries !== current.length) scopePersistenceFailure("SCOPE_STORAGE_INVALID");
    } else if (current !== null && typeof current !== "boolean" &&
        !(typeof current === "number" && Number.isSafeInteger(current))) {
      scopePersistenceFailure("SCOPE_STORAGE_INVALID");
    }
    if (bytes > MAX_D1_SCOPE_BYTES) scopePersistenceFailure("SCOPE_STORAGE_RESOURCE_LIMIT");
  }
}

export async function scopeStorageSha256(value: unknown): Promise<string> {
  boundedScopeValue(value);
  const bytes = encoder.encode(canonicalEvidenceJson(value));
  if (bytes.byteLength > MAX_D1_SCOPE_BYTES) scopePersistenceFailure("SCOPE_STORAGE_RESOURCE_LIMIT");
  return evidenceSha256Bytes(bytes);
}

export function validateScopeStorageRef(id: unknown, revision: unknown): void {
  if (!IdentifierSchema.safeParse(id).success || !PositiveIntegerSchema.safeParse(revision).success ||
      typeof id !== "string" || id !== id.trim()) scopePersistenceFailure("SCOPE_STORAGE_INVALID");
}

export async function validateStoredScope(value: unknown): Promise<ScopeSnapshot> {
  boundedScopeValue(value);
  const parsed = ScopeSnapshotSchema.safeParse(value);
  if (!parsed.success) scopePersistenceFailure("SCOPE_STORAGE_INVALID");
  const scope = parsed.data;
  const members = scope.member_source_revision_refs;
  if (members.length > 50_000 || new Set(members).size !== members.length ||
      canonicalEvidenceJson([...members].sort()) !== canonicalEvidenceJson(members) ||
      canonicalEvidenceJson(Object.keys(scope.source_owner_generations).sort()) !== canonicalEvidenceJson(members) ||
      !Object.hasOwn(scope.participant_generations, "member-policy-closure") ||
      Date.parse(scope.created_at) >= Date.parse(scope.expires_at) ||
      canonicalEvidenceJson(normalizeScopeExpression(scope.resolved_scope_expression)) !==
        canonicalEvidenceJson(scope.resolved_scope_expression)) scopePersistenceFailure("SCOPE_STORAGE_INVALID");
  const id = `scope-${(await scopeStorageSha256(scopeSnapshotIdentityPayload(scope))).slice(0, 48)}`;
  if (scope.snapshot_id !== id || scope.digest !== await scopeStorageSha256(scopeSnapshotDigestPayload(scope))) {
    scopePersistenceFailure("SCOPE_STORAGE_INTEGRITY_MISMATCH");
  }
  return scope;
}

export interface StoredScopeRecord {
  readonly snapshot: ScopeSnapshot;
  readonly invalidated_at: string | null;
  readonly invalidation_reason: string | null;
}

export const SCOPE_COLUMNS = "snapshot_id, revision, resolved_scope_expression_json, participant_generations_json, " +
  "member_source_revision_refs_json, source_owner_generations_json, policy_authority_ref, " +
  "disclosure_closure_digest, purge_ledger_revision, client_fence_ref, snapshot_digest, created_at, expires_at, " +
  "invalidated_at, invalidation_reason";

export function scopeStorageValues(scope: ScopeSnapshot): (string | number | null)[] {
  return [scope.snapshot_id, scope.revision, canonicalEvidenceJson(scope.resolved_scope_expression),
    canonicalEvidenceJson(scope.participant_generations), canonicalEvidenceJson(scope.member_source_revision_refs),
    canonicalEvidenceJson(scope.source_owner_generations), scope.policy_authority_ref, scope.disclosure_closure_digest,
    scope.purge_ledger_revision, scope.client_fence_ref ?? null, scope.digest, scope.created_at, scope.expires_at, null, null];
}

export async function decodeStoredScopeRow(row: Record<string, unknown>): Promise<StoredScopeRecord> {
  boundedScopeValue(row);
  const json = (field: string): unknown => {
    const text = row[field];
    if (typeof text !== "string") scopePersistenceFailure("SCOPE_STORAGE_INVALID");
    let value: unknown;
    try { value = JSON.parse(text); } catch { scopePersistenceFailure("SCOPE_STORAGE_INVALID"); }
    boundedScopeValue(value);
    if (canonicalEvidenceJson(value) !== text) scopePersistenceFailure("SCOPE_STORAGE_INVALID");
    return value;
  };
  const snapshot = await validateStoredScope({
    snapshot_id: row.snapshot_id, revision: row.revision,
    resolved_scope_expression: json("resolved_scope_expression_json"),
    participant_generations: json("participant_generations_json"),
    member_source_revision_refs: json("member_source_revision_refs_json"),
    source_owner_generations: json("source_owner_generations_json"),
    policy_authority_ref: row.policy_authority_ref, disclosure_closure_digest: row.disclosure_closure_digest,
    purge_ledger_revision: row.purge_ledger_revision,
    ...(row.client_fence_ref === null ? {} : { client_fence_ref: row.client_fence_ref }),
    digest: row.snapshot_digest, created_at: row.created_at, expires_at: row.expires_at,
  });
  const invalidatedAt = row.invalidated_at;
  const reason = row.invalidation_reason;
  if (invalidatedAt !== null && (typeof invalidatedAt !== "string" || !Number.isSafeInteger(Date.parse(invalidatedAt)) ||
      new Date(Date.parse(invalidatedAt)).toISOString() !== invalidatedAt)) {
    scopePersistenceFailure("SCOPE_STORAGE_INVALID");
  }
  if (reason !== null && (typeof reason !== "string" || !IdentifierSchema.safeParse(reason).success)) {
    scopePersistenceFailure("SCOPE_STORAGE_INVALID");
  }
  if ((invalidatedAt === null) !== (reason === null)) scopePersistenceFailure("SCOPE_STORAGE_INVALID");
  return { snapshot, invalidated_at: invalidatedAt as string | null, invalidation_reason: reason as string | null };
}
