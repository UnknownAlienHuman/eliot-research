import type {
  ErasureAdmissionPolicy,
} from "@eliotr/cloudflare-erasure";
import {
  assertErasureIdentifier,
  assertErasureInteger,
  assertErasureText,
  createErasureAdmissionPolicyStore,
  ErasureAdmissionError,
  ErasureRuntimeError,
  erasureFail,
  isoFromMs,
  parseErasureSubject,
  stableErasureId,
  validateErasureRequest,
} from "@eliotr/cloudflare-erasure";
import {
  PurgeLocationSchema,
  type ErasureRequest,
  type PurgeLocation,
  type VersionedRef,
} from "@eliotr/contracts";
import type {
  AuthenticatedRequestContext,
  OwnerErasurePreparation,
  OwnerErasurePreparationInput,
  OwnerErasureRequest,
} from "@eliotr/interfaces";
import type { Env } from "./env.js";

const MAX_REVISION_TARGETS = 10_000;

export type ErasureOwnerPreparationInput = OwnerErasurePreparationInput;

/**
 * A read-only, owner-confirmable erasure preview.  No admission row, receipt,
 * or physical effect is created by preparing this value.
 */
export type ErasureOwnerPreparation = OwnerErasurePreparation;

interface SourceRow {
  readonly source_id: unknown;
  readonly title: unknown;
  readonly source_namespace_id: unknown;
  readonly source_owner_system_id: unknown;
  readonly source_owner_generation: unknown;
}

interface OwnerRow {
  readonly owner_system_id: unknown;
  readonly source_owner_generation: unknown;
}

interface PolicyRefRow {
  readonly permission_ref: unknown;
  readonly revision: unknown;
}

interface RevisionRow {
  readonly source_revision_ref: unknown;
  readonly source_owner_generation: unknown;
}

interface D1Rows<T> {
  readonly success?: boolean;
  readonly results?: readonly T[];
}

function storageFailure(cause: unknown): never {
  if (cause instanceof ErasureRuntimeError || cause instanceof ErasureAdmissionError) {
    throw cause;
  }
  erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure preparation read failed", true, cause);
}

async function firstRow<T>(
  database: D1Database,
  statement: string,
  ...bindings: readonly unknown[]
): Promise<T | null> {
  try {
    const row = await database.prepare(statement).bind(...bindings).first<T>();
    return row ?? null;
  } catch (cause) {
    return storageFailure(cause);
  }
}

async function allRows<T>(
  database: D1Database,
  statement: string,
  ...bindings: readonly unknown[]
): Promise<readonly T[]> {
  try {
    const result = await database.prepare(statement).bind(...bindings).all<T>() as D1Rows<T>;
    if (result.success !== true || !Array.isArray(result.results)) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure revision inventory is unavailable", true);
    }
    return result.results;
  } catch (cause) {
    return storageFailure(cause);
  }
}

function ownerIdentity(row: SourceRow): {
  readonly sourceId: string;
  readonly title: string;
  readonly namespaceId: string;
  readonly ownerSystemId: string;
  readonly ownerGeneration: string;
} {
  return {
    sourceId: assertErasureIdentifier(row.source_id, "stored source ID"),
    title: assertErasureText(row.title, "stored source title"),
    namespaceId: assertErasureIdentifier(row.source_namespace_id, "stored source namespace"),
    ownerSystemId: assertErasureIdentifier(row.source_owner_system_id, "stored source owner"),
    ownerGeneration: assertErasureIdentifier(row.source_owner_generation, "stored source owner generation"),
  };
}

function assertPolicyCurrent(
  policy: ErasureAdmissionPolicy,
  permissionRef: VersionedRef,
  identity: ReturnType<typeof ownerIdentity>,
  principalRef: string,
  credentialGeneration: string,
  nowMs: number,
): void {
  if (
    policy.permission_ref.id !== permissionRef.id ||
    policy.permission_ref.revision !== permissionRef.revision ||
    policy.state !== "ACTIVE" ||
    policy.source_namespace_id !== identity.namespaceId ||
    policy.owner_system_id !== identity.ownerSystemId ||
    policy.source_owner_generation !== identity.ownerGeneration ||
    policy.principal_ref !== principalRef ||
    policy.credential_generation !== credentialGeneration
  ) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "active erasure permission is no longer current", true);
  }
  const expiresAt = Date.parse(policy.expires_at);
  const validFrom = Date.parse(policy.valid_from);
  if (!Number.isFinite(validFrom) || !Number.isFinite(expiresAt) || validFrom > nowMs || expiresAt <= nowMs) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "active erasure permission is unavailable", true);
  }
  assertErasureIdentifier(policy.legal_basis_ref, "erasure permission legal basis");
}

async function readCurrentOwner(
  database: D1Database,
  sourceId: string,
): Promise<OwnerRow | null> {
  return firstRow<OwnerRow>(
    database,
    "SELECT o.owner_system_id,o.source_owner_generation FROM source s " +
      "JOIN source_namespace_ownership o ON o.source_namespace_id=s.source_namespace_id " +
      "AND o.status='ACTIVE' AND o.owner_system_id=s.source_owner_system_id " +
      "AND o.source_owner_generation=s.source_owner_generation " +
      "WHERE s.source_id=?1 LIMIT 1",
    sourceId,
  );
}

function assertCurrentOwner(
  row: OwnerRow | null,
  identity: ReturnType<typeof ownerIdentity>,
): void {
  if (
    row === null ||
    row.owner_system_id !== identity.ownerSystemId ||
    row.source_owner_generation !== identity.ownerGeneration
  ) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "source owner authority is no longer current", true);
  }
}

function exactSubjectForRevision(sourceRevisionRef: string): string {
  const subjectRef = `source-revision:${sourceRevisionRef}`;
  const parsed = parseErasureSubject(subjectRef);
  if (parsed.kind !== "source_revision" || parsed.source_revision_ref !== sourceRevisionRef) {
    erasureFail("ERASURE_INPUT_INVALID", "source revision subject could not be canonicalized");
  }
  return assertErasureIdentifier(subjectRef, "exact source revision subject");
}

function exactSourceSubject(sourceId: string): void {
  const parsed = parseErasureSubject(`source:${sourceId}`);
  if (parsed.kind !== "source" || parsed.source_id !== sourceId) {
    erasureFail("ERASURE_INPUT_INVALID", "source subject could not be canonicalized");
  }
}

async function readActivePolicy(
  env: Env,
  permissionRef: VersionedRef,
  identity: ReturnType<typeof ownerIdentity>,
  principalRef: string,
  credentialGeneration: string,
  nowMs: number,
): Promise<ErasureAdmissionPolicy> {
  const store = createErasureAdmissionPolicyStore({ database: env.CORE_DB });
  let policy: ErasureAdmissionPolicy | null;
  try {
    policy = await store.read(permissionRef);
  } catch (cause) {
    return storageFailure(cause);
  }
  if (policy === null) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "active erasure permission is unavailable", true);
  }
  assertPolicyCurrent(policy, permissionRef, identity, principalRef, credentialGeneration, nowMs);
  return policy;
}

/**
 * Read the current owner source and build the exact erasure request that the
 * existing owner execute path can later admit.  This function has no durable
 * mutation and deliberately does not call the coordinator or create a receipt.
 */
export async function prepareErasureForOwner(
  env: Env,
  context: AuthenticatedRequestContext,
  input: ErasureOwnerPreparationInput,
): Promise<ErasureOwnerPreparation> {
  if (context.client_class !== "owner_pwa") {
    throw new ErasureAdmissionError("ERASURE_PERMISSION_DENIED", "erasure preparation requires an owner session");
  }

  // Snapshot request and identity scalars before the first awaited read.
  const principalRef = assertErasureIdentifier(context.principal_ref, "erasure owner principal");
  const credentialGeneration = assertErasureIdentifier(
    context.credential_generation,
    "erasure owner credential generation",
  );
  const sourceId = assertErasureIdentifier(input.source_id, "erasure source ID");
  const idempotencyKey = assertErasureIdentifier(input.idempotency_key, "erasure idempotency key");
  exactSourceSubject(sourceId);
  const observedMs = Date.now();
  const observedAt = isoFromMs(observedMs);

  const sourceRow = await firstRow<SourceRow>(
    env.CORE_DB,
    "SELECT s.source_id,s.title,s.source_namespace_id,s.source_owner_system_id,s.source_owner_generation " +
      "FROM source s JOIN source_namespace_ownership o ON o.source_namespace_id=s.source_namespace_id " +
      "AND o.status='ACTIVE' AND o.owner_system_id=s.source_owner_system_id " +
      "AND o.source_owner_generation=s.source_owner_generation WHERE s.source_id=?1 LIMIT 1",
    sourceId,
  );
  if (sourceRow === null) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "source owner authority is unavailable", true);
  }
  const identity = ownerIdentity(sourceRow);
  if (identity.sourceId !== sourceId) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored source identity does not match the requested source");
  }

  const policyRefRow = await firstRow<PolicyRefRow>(
    env.CORE_DB,
    "SELECT p.permission_ref,p.revision FROM erasure_admission_policy p " +
      "JOIN source_namespace_ownership o ON o.source_namespace_id=p.source_namespace_id " +
      "AND o.status='ACTIVE' AND o.owner_system_id=p.owner_system_id " +
      "AND o.source_owner_generation=p.source_owner_generation " +
      "WHERE p.source_namespace_id=?1 AND p.owner_system_id=?2 AND p.source_owner_generation=?3 " +
      "AND p.principal_ref=?4 AND p.credential_generation=?5 AND p.state='ACTIVE' " +
      "AND p.valid_from<=?6 AND p.expires_at>?6 ORDER BY p.revision DESC LIMIT 1",
    identity.namespaceId,
    identity.ownerSystemId,
    identity.ownerGeneration,
    principalRef,
    credentialGeneration,
    observedAt,
  );
  if (policyRefRow === null) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "active erasure permission is unavailable", true);
  }
  const permissionRef: VersionedRef = {
    id: assertErasureIdentifier(policyRefRow.permission_ref, "stored erasure permission ID"),
    revision: assertErasureInteger(
      policyRefRow.revision,
      "stored erasure permission revision",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
  const admissionPolicy = await readActivePolicy(
    env,
    permissionRef,
    identity,
    principalRef,
    credentialGeneration,
    observedMs,
  );

  const rows = await allRows<RevisionRow>(
    env.CORE_DB,
    "SELECT source_revision_ref,source_owner_generation FROM source_revision " +
      "WHERE source_id=?1 ORDER BY source_revision_ref LIMIT ?2",
    sourceId,
    MAX_REVISION_TARGETS + 1,
  );
  if (rows.length === 0) {
    erasureFail("ERASURE_INPUT_INVALID", "source has no bounded revision targets");
  }
  if (rows.length > MAX_REVISION_TARGETS) {
    erasureFail("ERASURE_INPUT_INVALID", "source revision target set exceeds its bound");
  }

  const revisionTargets: string[] = [];
  const exactSubjectRefs: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const revisionRef = assertErasureIdentifier(row.source_revision_ref, "stored source revision ref");
    if (seen.has(revisionRef)) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "source revision inventory contains a duplicate");
    }
    if (row.source_owner_generation !== identity.ownerGeneration) {
      throw new ErasureAdmissionError(
        "ERASURE_PERMISSION_DENIED",
        "source revision is outside the current owner authority",
      );
    }
    seen.add(revisionRef);
    revisionTargets.push(revisionRef);
    exactSubjectRefs.push(exactSubjectForRevision(revisionRef));
  }

  // The preview remains confirmable only if the owner and permission are
  // still the same after the revision inventory read.
  const latestOwner = await readCurrentOwner(env.CORE_DB, sourceId);
  assertCurrentOwner(latestOwner, identity);
  const latestPolicy = await readActivePolicy(
    env,
    permissionRef,
    identity,
    principalRef,
    credentialGeneration,
    Date.now(),
  );
  if (latestPolicy.policy_sha256 !== admissionPolicy.policy_sha256) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure permission changed during preparation", true);
  }

  const erasureId = await stableErasureId("erasure", principalRef, sourceId, idempotencyKey);
  const request: ErasureRequest = validateErasureRequest({
    protocol: "erc.privacy.erasure.v1",
    erasure_ref: { id: erasureId, revision: 1 },
    requested_by_principal_ref: principalRef,
    exact_subject_refs: exactSubjectRefs,
    required_locations: [...PurgeLocationSchema.options] as PurgeLocation[],
    legal_basis_ref: latestPolicy.legal_basis_ref,
    admitted_at: isoFromMs(Date.now()),
    deadline: latestPolicy.expires_at,
  });
  const ownerRequest: OwnerErasureRequest = Object.freeze({
    protocol: "eliotr.owner-erasure.v1",
    permission_ref: Object.freeze({ ...permissionRef }),
    request,
  });
  if (new TextEncoder().encode(JSON.stringify(ownerRequest)).byteLength > 262144) {
    erasureFail("ERASURE_INPUT_INVALID", "source revision inventory exceeds the owner erasure request size bound");
  }
  return Object.freeze({
    protocol: "eliotr.owner-erasure-preview.v1",
    source_id: sourceId,
    source_title: identity.title,
    revision_targets: Object.freeze([...revisionTargets]),
    request: ownerRequest,
  });
}
