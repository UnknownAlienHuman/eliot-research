import {
  AllowedReferenceManifestSchema,
  ScopeSnapshotSchema,
  VersionedRefSchema,
  type AllowedReferenceManifest,
  type ScopeSnapshot,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  canonicalFederationJson,
  federationSha256Hex,
  type FederationReferenceManifestAuthority,
  type FederationScopeSnapshotAuthority,
} from "./federation-service.js";

const MAX_AUTHORITY_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

const MANIFEST_ROW_KEYS = new Set([
  "client_fence_ref",
  "expires_at",
  "manifest_digest",
  "manifest_id",
  "manifest_json",
  "revision",
  "scope_snapshot_id",
  "scope_snapshot_revision",
  "stored_at",
]);
const SCOPE_ROW_KEYS = new Set([
  "client_fence_ref",
  "created_at",
  "digest",
  "expires_at",
  "policy_authority_ref",
  "purge_ledger_revision",
  "revision",
  "snapshot_id",
  "snapshot_json",
  "stored_at",
]);

interface ManifestRow {
  readonly manifest_id: unknown;
  readonly revision: unknown;
  readonly manifest_digest: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly client_fence_ref: unknown;
  readonly expires_at: unknown;
  readonly manifest_json: unknown;
  readonly stored_at: unknown;
}

interface ScopeRow {
  readonly snapshot_id: unknown;
  readonly revision: unknown;
  readonly digest: unknown;
  readonly client_fence_ref: unknown;
  readonly policy_authority_ref: unknown;
  readonly purge_ledger_revision: unknown;
  readonly created_at: unknown;
  readonly expires_at: unknown;
  readonly snapshot_json: unknown;
  readonly stored_at: unknown;
}

export interface D1FederationReferenceAuthorities {
  readonly manifests: FederationReferenceManifestAuthority;
  readonly scopes: FederationScopeSnapshotAuthority;
}

export class FederationD1ReferenceAuthorityError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(
    code: string,
    message: string,
    options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FederationD1ReferenceAuthorityError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

function fail(
  code: string,
  message: string,
  options: ConstructorParameters<typeof FederationD1ReferenceAuthorityError>[2] = {},
): never {
  throw new FederationD1ReferenceAuthorityError(code, message, options);
}

function exactObject(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("FEDERATION_REFERENCE_READBACK_INVALID", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("FEDERATION_REFERENCE_READBACK_INVALID", `${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!expectedKeys.has(key)) {
      fail(
        "FEDERATION_REFERENCE_READBACK_INVALID",
        `${label} contains unsupported field ${key}`,
      );
    }
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      fail("FEDERATION_REFERENCE_READBACK_INVALID", `${label} is missing field ${key}`);
    }
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  const parsed = VersionedRefSchema.shape.id.safeParse(value);
  if (!parsed.success) {
    fail("FEDERATION_REFERENCE_READBACK_INVALID", `${label} is invalid`);
  }
  return parsed.data;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(
      "FEDERATION_REFERENCE_READBACK_INVALID",
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("FEDERATION_REFERENCE_READBACK_INVALID", `${label} must be lowercase SHA-256`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 20 || value.length > 35) {
    fail("FEDERATION_REFERENCE_READBACK_INVALID", `${label} is not a bounded timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("FEDERATION_REFERENCE_READBACK_INVALID", `${label} is not canonical UTC ISO-8601`);
  }
  return value;
}

function exactRef(value: VersionedRef): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) {
    fail("FEDERATION_REFERENCE_INPUT_INVALID", "authority reference is invalid");
  }
  return parsed.data;
}

function jsonValue(value: unknown, label: string): {
  readonly text: string;
  readonly parsed: unknown;
} {
  if (
    typeof value !== "string" ||
    encoder.encode(value).byteLength > MAX_AUTHORITY_BYTES
  ) {
    fail(
      "FEDERATION_REFERENCE_READBACK_INVALID",
      `${label} exceeds the one-megabyte authority envelope`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (cause) {
    fail("FEDERATION_REFERENCE_READBACK_INVALID", `${label} is not valid JSON`, {
      cause,
    });
  }
  let canonical: string;
  try {
    canonical = canonicalFederationJson(parsed);
  } catch (cause) {
    fail("FEDERATION_REFERENCE_READBACK_INVALID", `${label} cannot be canonicalized`, {
      cause,
    });
  }
  if (canonical !== value) {
    fail("FEDERATION_REFERENCE_READBACK_INVALID", `${label} is not canonical JSON`);
  }
  return { text: value, parsed };
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

async function decodeManifestRow(
  raw: unknown,
  expectedRef: VersionedRef,
): Promise<AllowedReferenceManifest> {
  const row = exactObject(raw, MANIFEST_ROW_KEYS, "federation manifest row");
  const rowRef = {
    id: identifier(row.manifest_id, "manifest_id"),
    revision: positiveInteger(row.revision, "manifest revision"),
  };
  if (!sameRef(rowRef, expectedRef)) {
    fail(
      "FEDERATION_REFERENCE_READBACK_INVALID",
      "manifest row belongs to another revision",
    );
  }
  const rowDigest = digest(row.manifest_digest, "manifest digest");
  const scopeRef = {
    id: identifier(row.scope_snapshot_id, "scope_snapshot_id"),
    revision: positiveInteger(
      row.scope_snapshot_revision,
      "scope snapshot revision",
    ),
  };
  const clientFence = identifier(row.client_fence_ref, "manifest client fence");
  const expiresAt = timestamp(row.expires_at, "manifest expires_at");
  timestamp(row.stored_at, "manifest stored_at");
  const json = jsonValue(row.manifest_json, "manifest_json");
  const parsed = AllowedReferenceManifestSchema.safeParse(json.parsed);
  if (!parsed.success) {
    fail(
      "FEDERATION_REFERENCE_READBACK_INVALID",
      "stored AllowedReferenceManifest failed strict validation",
    );
  }
  const manifest = parsed.data;
  const { manifest_digest: _manifestDigest, ...digestPayload } = manifest;
  if (
    !sameRef(manifest.manifest_ref, rowRef) ||
    !sameRef(manifest.scope_snapshot_ref, scopeRef) ||
    manifest.client_fence_ref !== clientFence ||
    manifest.expires_at !== expiresAt ||
    manifest.manifest_digest !== rowDigest ||
    canonicalFederationJson(manifest) !== json.text ||
    (await federationSha256Hex(canonicalFederationJson(digestPayload))) !== rowDigest
  ) {
    fail(
      "FEDERATION_REFERENCE_READBACK_INVALID",
      "stored AllowedReferenceManifest differs from row or digest authority",
    );
  }
  return manifest;
}

async function decodeScopeRow(
  raw: unknown,
  expectedRef: VersionedRef,
): Promise<ScopeSnapshot> {
  const row = exactObject(raw, SCOPE_ROW_KEYS, "federation ScopeSnapshot row");
  const rowRef = {
    id: identifier(row.snapshot_id, "snapshot_id"),
    revision: positiveInteger(row.revision, "snapshot revision"),
  };
  if (!sameRef(rowRef, expectedRef)) {
    fail(
      "FEDERATION_REFERENCE_READBACK_INVALID",
      "ScopeSnapshot row belongs to another revision",
    );
  }
  const rowDigest = digest(row.digest, "ScopeSnapshot digest");
  const clientFence = identifier(row.client_fence_ref, "snapshot client fence");
  const policyAuthority = identifier(
    row.policy_authority_ref,
    "snapshot policy authority",
  );
  const purgeRevision = positiveInteger(
    row.purge_ledger_revision,
    "snapshot purge-ledger revision",
  );
  const createdAt = timestamp(row.created_at, "snapshot created_at");
  const expiresAt = timestamp(row.expires_at, "snapshot expires_at");
  timestamp(row.stored_at, "snapshot stored_at");
  const json = jsonValue(row.snapshot_json, "snapshot_json");
  const parsed = ScopeSnapshotSchema.safeParse(json.parsed);
  if (!parsed.success) {
    fail(
      "FEDERATION_REFERENCE_READBACK_INVALID",
      "stored ScopeSnapshot failed strict validation",
    );
  }
  const snapshot = parsed.data;
  const { digest: _snapshotDigest, ...digestPayload } = snapshot;
  if (
    snapshot.snapshot_id !== rowRef.id ||
    snapshot.revision !== rowRef.revision ||
    snapshot.digest !== rowDigest ||
    snapshot.client_fence_ref !== clientFence ||
    snapshot.policy_authority_ref !== policyAuthority ||
    snapshot.purge_ledger_revision !== purgeRevision ||
    snapshot.created_at !== createdAt ||
    snapshot.expires_at !== expiresAt ||
    canonicalFederationJson(snapshot) !== json.text ||
    (await federationSha256Hex(canonicalFederationJson(digestPayload))) !== rowDigest
  ) {
    fail(
      "FEDERATION_REFERENCE_READBACK_INVALID",
      "stored ScopeSnapshot differs from row or digest authority",
    );
  }
  return snapshot;
}

async function readAuthorityRow<T>(
  database: D1Database,
  sql: string,
  ref: VersionedRef,
): Promise<T | null> {
  try {
    return await database.prepare(sql).bind(ref.id, ref.revision).first<T>();
  } catch (cause) {
    fail("FEDERATION_REFERENCE_READ_FAILED", "federation reference authority read failed", {
      retryable: true,
      cause,
    });
  }
}

/**
 * Reads immutable federation manifests and scope snapshots from CORE_DB.
 * The adapter never trusts SQL row shape or JSON text without exact strict
 * decoding, canonical byte equality, row binding, and SHA-256 verification.
 */
export function createD1FederationReferenceAuthorities(
  database: D1Database,
): D1FederationReferenceAuthorities {
  if (
    typeof database !== "object" ||
    database === null ||
    typeof database.prepare !== "function"
  ) {
    fail("FEDERATION_REFERENCE_CONFIGURATION_INVALID", "CORE_DB binding is invalid");
  }

  return Object.freeze({
    manifests: Object.freeze({
      async get(rawRef: VersionedRef): Promise<AllowedReferenceManifest | null> {
        const ref = exactRef(rawRef);
        const row = await readAuthorityRow<ManifestRow>(
          database,
          "SELECT manifest_id,revision,manifest_digest,scope_snapshot_id," +
            "scope_snapshot_revision,client_fence_ref,expires_at,manifest_json," +
            "stored_at FROM federation_allowed_reference_manifest_authority " +
            "WHERE manifest_id=?1 AND revision=?2 LIMIT 1",
          ref,
        );
        return row === null ? null : decodeManifestRow(row, ref);
      },
    }),
    scopes: Object.freeze({
      async get(rawRef: VersionedRef): Promise<ScopeSnapshot | null> {
        const ref = exactRef(rawRef);
        const row = await readAuthorityRow<ScopeRow>(
          database,
          "SELECT snapshot_id,revision,digest,client_fence_ref," +
            "policy_authority_ref,purge_ledger_revision,created_at,expires_at," +
            "snapshot_json,stored_at FROM federation_scope_snapshot_authority " +
            "WHERE snapshot_id=?1 AND revision=?2 LIMIT 1",
          ref,
        );
        return row === null ? null : decodeScopeRow(row, ref);
      },
    }),
  });
}
