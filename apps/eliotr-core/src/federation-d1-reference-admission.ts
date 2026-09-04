import {
  AllowedReferenceManifestSchema,
  ScopeSnapshotSchema,
  type AllowedReferenceManifest,
  type ScopeSnapshot,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  createD1FederationReferenceAuthorities,
  type D1FederationReferenceAuthorities,
} from "./federation-d1-reference-authority.js";
import {
  canonicalFederationJson,
  federationSha256Hex,
} from "./federation-service.js";

const MAX_AUTHORITY_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

export type FederationReferenceAdmissionKind =
  | "SCOPE_SNAPSHOT"
  | "ALLOWED_REFERENCE_MANIFEST";

export type FederationReferenceAdmissionOutcome =
  | "CREATED"
  | "REPLAY"
  | "RECONCILED";

export interface FederationReferenceAdmissionReceipt {
  readonly kind: FederationReferenceAdmissionKind;
  readonly outcome: FederationReferenceAdmissionOutcome;
  readonly ref: VersionedRef;
  readonly digest: string;
}

export interface D1FederationReferenceAuthorityStore
  extends D1FederationReferenceAuthorities {
  admitScopeSnapshot(
    snapshot: ScopeSnapshot,
  ): Promise<FederationReferenceAdmissionReceipt>;
  admitAllowedReferenceManifest(
    manifest: AllowedReferenceManifest,
  ): Promise<FederationReferenceAdmissionReceipt>;
}

export interface D1FederationReferenceAdmissionOptions {
  readonly now?: () => string;
}

export class FederationD1ReferenceAdmissionError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly ambiguous_effect?: "FEDERATION_REFERENCE_WRITE";

  public constructor(
    code: string,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly ambiguous_effect?: "FEDERATION_REFERENCE_WRITE";
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FederationD1ReferenceAdmissionError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.ambiguous_effect = options.ambiguous_effect;
  }
}

interface PreparedScopeSnapshot {
  readonly value: ScopeSnapshot;
  readonly ref: VersionedRef;
  readonly digest: string;
  readonly json: string;
}

interface PreparedManifest {
  readonly value: AllowedReferenceManifest;
  readonly ref: VersionedRef;
  readonly digest: string;
  readonly json: string;
}

function fail(
  code: string,
  message: string,
  options: ConstructorParameters<typeof FederationD1ReferenceAdmissionError>[2] = {},
): never {
  throw new FederationD1ReferenceAdmissionError(code, message, options);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 20 || value.length > 35) {
    fail("FEDERATION_REFERENCE_INPUT_INVALID", `${label} is not a bounded timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("FEDERATION_REFERENCE_INPUT_INVALID", `${label} is not canonical UTC ISO-8601`);
  }
  return value;
}

function canonicalBytes(value: unknown, label: string): string {
  let json: string;
  try {
    json = canonicalFederationJson(value);
  } catch (cause) {
    fail("FEDERATION_REFERENCE_INPUT_INVALID", `${label} cannot be canonicalized`, {
      cause,
    });
  }
  if (encoder.encode(json).byteLength > MAX_AUTHORITY_BYTES) {
    fail(
      "FEDERATION_REFERENCE_INPUT_INVALID",
      `${label} exceeds the one-megabyte authority envelope`,
    );
  }
  return json;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}@${ref.revision}`;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every(
    (value, index) => value === normalizedRight[index],
  );
}

function exactObjectBytes(left: unknown, right: unknown): boolean {
  return canonicalFederationJson(left) === canonicalFederationJson(right);
}

async function prepareScopeSnapshot(
  raw: ScopeSnapshot,
): Promise<PreparedScopeSnapshot> {
  const parsed = ScopeSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    fail(
      "FEDERATION_REFERENCE_INPUT_INVALID",
      "ScopeSnapshot failed strict validation",
    );
  }
  const value = parsed.data;
  if (value.client_fence_ref === undefined) {
    fail(
      "FEDERATION_REFERENCE_INPUT_INVALID",
      "federation ScopeSnapshot requires client_fence_ref",
    );
  }
  canonicalTimestamp(value.created_at, "ScopeSnapshot created_at");
  canonicalTimestamp(value.expires_at, "ScopeSnapshot expires_at");
  if (Date.parse(value.expires_at) <= Date.parse(value.created_at)) {
    fail(
      "FEDERATION_REFERENCE_INPUT_INVALID",
      "ScopeSnapshot expires_at must follow created_at",
    );
  }
  if (
    new Set(value.member_source_revision_refs).size !==
      value.member_source_revision_refs.length ||
    !sameStringSet(
      Object.keys(value.source_owner_generations),
      value.member_source_revision_refs,
    )
  ) {
    fail(
      "FEDERATION_SCOPE_MEMBERSHIP_MISMATCH",
      "ScopeSnapshot members and source-owner generations differ",
    );
  }
  const { digest: _digest, ...digestPayload } = value;
  const expectedDigest = await federationSha256Hex(
    canonicalFederationJson(digestPayload),
  );
  if (value.digest !== expectedDigest) {
    fail(
      "FEDERATION_REFERENCE_DIGEST_MISMATCH",
      "ScopeSnapshot digest does not match its content",
    );
  }
  return {
    value,
    ref: { id: value.snapshot_id, revision: value.revision },
    digest: value.digest,
    json: canonicalBytes(value, "ScopeSnapshot"),
  };
}

async function prepareManifest(
  raw: AllowedReferenceManifest,
): Promise<PreparedManifest> {
  const parsed = AllowedReferenceManifestSchema.safeParse(raw);
  if (!parsed.success) {
    fail(
      "FEDERATION_REFERENCE_INPUT_INVALID",
      "AllowedReferenceManifest failed strict validation",
    );
  }
  const value = parsed.data;
  canonicalTimestamp(value.expires_at, "AllowedReferenceManifest expires_at");
  const manifestMembers = value.allowed_source_revision_refs.map(refKey);
  if (new Set(manifestMembers).size !== manifestMembers.length) {
    fail(
      "FEDERATION_SCOPE_MEMBERSHIP_MISMATCH",
      "AllowedReferenceManifest contains duplicate source revisions",
    );
  }
  const { manifest_digest: _digest, ...digestPayload } = value;
  const expectedDigest = await federationSha256Hex(
    canonicalFederationJson(digestPayload),
  );
  if (value.manifest_digest !== expectedDigest) {
    fail(
      "FEDERATION_REFERENCE_DIGEST_MISMATCH",
      "AllowedReferenceManifest digest does not match its content",
    );
  }
  return {
    value,
    ref: value.manifest_ref,
    digest: value.manifest_digest,
    json: canonicalBytes(value, "AllowedReferenceManifest"),
  };
}

function receipt(
  kind: FederationReferenceAdmissionKind,
  outcome: FederationReferenceAdmissionOutcome,
  ref: VersionedRef,
  digest: string,
): FederationReferenceAdmissionReceipt {
  return Object.freeze({ kind, outcome, ref, digest });
}

async function reconcileScopeSnapshot(
  authorities: D1FederationReferenceAuthorities,
  desired: PreparedScopeSnapshot,
): Promise<ScopeSnapshot | null> {
  const observed = await authorities.scopes.get(desired.ref);
  return observed !== null && exactObjectBytes(observed, desired.value)
    ? observed
    : null;
}

async function reconcileManifest(
  authorities: D1FederationReferenceAuthorities,
  desired: PreparedManifest,
): Promise<AllowedReferenceManifest | null> {
  const observed = await authorities.manifests.get(desired.ref);
  return observed !== null && exactObjectBytes(observed, desired.value)
    ? observed
    : null;
}

/**
 * Adds immutable federation authority revisions to CORE_DB. Every unknown D1
 * mutation effect is reconciled through one exact read and is never retried.
 */
export function createD1FederationReferenceAuthorityStore(
  database: D1Database,
  options: D1FederationReferenceAdmissionOptions = {},
): D1FederationReferenceAuthorityStore {
  if (
    typeof database !== "object" ||
    database === null ||
    typeof database.prepare !== "function"
  ) {
    fail("FEDERATION_REFERENCE_CONFIGURATION_INVALID", "CORE_DB binding is invalid");
  }
  const authorities = createD1FederationReferenceAuthorities(database);
  const now = options.now ?? (() => new Date().toISOString());

  return Object.freeze({
    ...authorities,

    async admitScopeSnapshot(
      raw: ScopeSnapshot,
    ): Promise<FederationReferenceAdmissionReceipt> {
      const desired = await prepareScopeSnapshot(raw);
      const storedAt = canonicalTimestamp(now(), "reference authority clock");
      let returned: unknown | null;
      try {
        returned = await database
          .prepare(
            "INSERT INTO federation_scope_snapshot_authority(" +
              "snapshot_id,revision,digest,client_fence_ref," +
              "policy_authority_ref,purge_ledger_revision,created_at,expires_at," +
              "snapshot_json,stored_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) " +
              "ON CONFLICT(snapshot_id,revision) DO NOTHING " +
              "RETURNING snapshot_id",
          )
          .bind(
            desired.ref.id,
            desired.ref.revision,
            desired.digest,
            desired.value.client_fence_ref,
            desired.value.policy_authority_ref,
            desired.value.purge_ledger_revision,
            desired.value.created_at,
            desired.value.expires_at,
            desired.json,
            storedAt,
          )
          .first();
      } catch (cause) {
        try {
          if (await reconcileScopeSnapshot(authorities, desired)) {
            return receipt(
              "SCOPE_SNAPSHOT",
              "RECONCILED",
              desired.ref,
              desired.digest,
            );
          }
        } catch {
          // Preserve the original ambiguous mutation classification.
        }
        fail(
          "FEDERATION_REFERENCE_WRITE_UNCERTAIN",
          "ScopeSnapshot admission effect is unknown",
          {
            ambiguous_effect: "FEDERATION_REFERENCE_WRITE",
            cause,
          },
        );
      }
      const observed = await reconcileScopeSnapshot(authorities, desired);
      if (observed !== null) {
        return receipt(
          "SCOPE_SNAPSHOT",
          returned === null ? "REPLAY" : "CREATED",
          desired.ref,
          desired.digest,
        );
      }
      if (returned === null) {
        fail(
          "FEDERATION_REFERENCE_IDENTITY_CONFLICT",
          "ScopeSnapshot revision already belongs to different authority bytes",
        );
      }
      fail(
        "FEDERATION_REFERENCE_READBACK_INVALID",
        "created ScopeSnapshot lacks exact authoritative readback",
        { ambiguous_effect: "FEDERATION_REFERENCE_WRITE" },
      );
    },

    async admitAllowedReferenceManifest(
      raw: AllowedReferenceManifest,
    ): Promise<FederationReferenceAdmissionReceipt> {
      const desired = await prepareManifest(raw);
      const scope = await authorities.scopes.get(
        desired.value.scope_snapshot_ref,
      );
      if (scope === null) {
        fail(
          "FEDERATION_SCOPE_SNAPSHOT_NOT_FOUND",
          "manifest ScopeSnapshot authority was not found",
        );
      }
      const manifestMembers = desired.value.allowed_source_revision_refs.map(refKey);
      if (
        scope.client_fence_ref !== desired.value.client_fence_ref ||
        Date.parse(desired.value.expires_at) > Date.parse(scope.expires_at) ||
        !sameStringSet(scope.member_source_revision_refs, manifestMembers)
      ) {
        fail(
          "FEDERATION_REFERENCE_BINDING_MISMATCH",
          "manifest differs from its exact ScopeSnapshot fence, expiry, or members",
        );
      }

      const storedAt = canonicalTimestamp(now(), "reference authority clock");
      let returned: unknown | null;
      try {
        returned = await database
          .prepare(
            "INSERT INTO federation_allowed_reference_manifest_authority(" +
              "manifest_id,revision,manifest_digest,scope_snapshot_id," +
              "scope_snapshot_revision,client_fence_ref,expires_at," +
              "manifest_json,stored_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) " +
              "ON CONFLICT(manifest_id,revision) DO NOTHING " +
              "RETURNING manifest_id",
          )
          .bind(
            desired.ref.id,
            desired.ref.revision,
            desired.digest,
            desired.value.scope_snapshot_ref.id,
            desired.value.scope_snapshot_ref.revision,
            desired.value.client_fence_ref,
            desired.value.expires_at,
            desired.json,
            storedAt,
          )
          .first();
      } catch (cause) {
        try {
          if (await reconcileManifest(authorities, desired)) {
            return receipt(
              "ALLOWED_REFERENCE_MANIFEST",
              "RECONCILED",
              desired.ref,
              desired.digest,
            );
          }
        } catch {
          // Preserve the original ambiguous mutation classification.
        }
        fail(
          "FEDERATION_REFERENCE_WRITE_UNCERTAIN",
          "AllowedReferenceManifest admission effect is unknown",
          {
            ambiguous_effect: "FEDERATION_REFERENCE_WRITE",
            cause,
          },
        );
      }
      const observed = await reconcileManifest(authorities, desired);
      if (observed !== null) {
        return receipt(
          "ALLOWED_REFERENCE_MANIFEST",
          returned === null ? "REPLAY" : "CREATED",
          desired.ref,
          desired.digest,
        );
      }
      if (returned === null) {
        fail(
          "FEDERATION_REFERENCE_IDENTITY_CONFLICT",
          "manifest revision already belongs to different authority bytes",
        );
      }
      fail(
        "FEDERATION_REFERENCE_READBACK_INVALID",
        "created manifest lacks exact authoritative readback",
        { ambiguous_effect: "FEDERATION_REFERENCE_WRITE" },
      );
    },
  });
}
