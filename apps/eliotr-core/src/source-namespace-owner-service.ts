import type {
  AuthenticatedRequestContext,
  OwnerNamespaceInitializeInput,
  OwnerNamespaceInitialization,
  OwnerNamespaceList,
} from "@eliotr/interfaces";
import type { VersionedRef } from "@eliotr/contracts";
import { canonicalDigest, sha256Utf8 } from "@eliotr/platform-cloudflare";
import type {
  NamespaceBootstrapProfile,
  NamespaceBootstrapProfileReader,
} from "./source-namespace-bootstrap-profiles.js";
import {
  namespaceErasureAdmissionAt,
  namespaceErasureAdmissionStatement,
  prepareNamespaceErasureAdmissionPolicy,
} from "./source-namespace-erasure-policy.js";
import {
  hasAnyNamespaceState,
  namespaceStateMatches,
  readNamespaceState,
  type NamespaceState,
} from "./source-namespace-state.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CLIENT_CLASS = "owner_pwa" as const;
const OWNER_SYSTEM_ID = "eliotr";
const MAX_TITLE_BYTES = 120;

export type SourceNamespaceOwnerErrorCode =
  | "NAMESPACE_OWNER_REQUIRED"
  | "NAMESPACE_INPUT_INVALID"
  | "NAMESPACE_PROFILE_UNAVAILABLE"
  | "NAMESPACE_PROFILE_EXPIRED"
  | "NAMESPACE_PROFILE_CONFLICT"
  | "NAMESPACE_EXISTING_LINEAGE"
  | "NAMESPACE_IDEMPOTENCY_CONFLICT"
  | "NAMESPACE_STORAGE_UNAVAILABLE"
  | "NAMESPACE_SETTLEMENT_UNCERTAIN";

export class SourceNamespaceOwnerError extends Error {
  public readonly code: SourceNamespaceOwnerErrorCode;
  public readonly status: number;
  public readonly retryable: boolean;

  public constructor(
    code: SourceNamespaceOwnerErrorCode,
    status: number,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SourceNamespaceOwnerError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface SourceNamespaceOwnerServiceOptions {
  readonly database: D1Database;
  readonly profiles: NamespaceBootstrapProfileReader;
  readonly now?: () => number;
}

interface OwnerTarget {
  readonly source_namespace_id: string;
  readonly ownership_record_revision: 1;
  readonly owner_system_id: typeof OWNER_SYSTEM_ID;
  readonly owner_incarnation_ref: string;
  readonly source_owner_generation: string;
  readonly source_admission_policy_revision: 1;
  readonly status: "ACTIVE";
  readonly cutover_receipt_ref: null;
  readonly created_at: string;
}

interface PolicyTarget {
  readonly source_namespace_id: string;
  readonly revision: 1;
  readonly authorized_principal_refs_json: string;
  readonly allowed_ownership_modes_json: '["immutable_import"]';
  readonly source_class: string;
  readonly assurance_ceiling: NamespaceBootstrapProfile["policy"]["assurance_ceiling"];
  readonly instruction_taint: "DATA_ONLY";
  readonly allowed_effects: "READ_ONLY";
  readonly allowed_use_json: string;
  readonly disclosure_ceiling: string;
  readonly license_policy_ref: string;
  readonly default_storage_policy: "NORMALIZED_CLOUD_ONLY";
  readonly default_residency_profile_id: string;
  readonly default_retention_policy_id: string;
  readonly minimum_quality_state: NamespaceBootstrapProfile["policy"]["minimum_quality_state"];
  readonly created_at: string;
}

interface ScopeTarget {
  readonly source_namespace_id: string;
  readonly principal_ref: string;
  readonly client_class: typeof CLIENT_CLASS;
  readonly policy_ref: string;
  readonly generation: 1;
  readonly allowed_use_json: string;
  readonly disclosure_ceiling: string;
  readonly state: "ACTIVE";
  readonly expires_at: string;
  readonly created_at: string;
}

interface InitializationTarget {
  readonly source_namespace_id: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly profile_id: string;
  readonly profile_revision: number;
  readonly title: string;
  readonly idempotency_key: string;
  readonly owner_incarnation_ref: string;
  readonly source_owner_generation: string;
  readonly ownership_record_revision: 1;
  readonly source_admission_policy_revision: 1;
  readonly scope_policy_ref: string;
  readonly scope_policy_generation: 1;
  readonly request_sha256: string;
  readonly created_at: string;
}

interface NamespaceTargets {
  readonly initialization: InitializationTarget;
  readonly owner: OwnerTarget;
  readonly policy: PolicyTarget;
  readonly scope: ScopeTarget;
  readonly erasure_admission_policy: Awaited<ReturnType<typeof prepareNamespaceErasureAdmissionPolicy>>;
}

function fail(code: SourceNamespaceOwnerErrorCode, status: number, message: string, retryable = false, cause?: unknown): never {
  throw new SourceNamespaceOwnerError(code, status, message, retryable, cause);
}

function contextSnapshot(context: AuthenticatedRequestContext): { readonly principal_ref: string; readonly credential_generation: string } {
  if (context.client_class !== CLIENT_CLASS || !IDENTIFIER.test(context.principal_ref) || !IDENTIFIER.test(context.credential_generation)) {
    fail("NAMESPACE_OWNER_REQUIRED", 403, "an authenticated owner session is required");
  }
  return Object.freeze({ principal_ref: context.principal_ref, credential_generation: context.credential_generation });
}

function canonicalNow(now: () => number): { readonly millis: number; readonly iso: string } {
  const millis = now();
  if (!Number.isSafeInteger(millis) || millis < 0) fail("NAMESPACE_INPUT_INVALID", 400, "server clock is invalid");
  return { millis, iso: new Date(millis).toISOString() };
}

function canonicalTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isSafeInteger(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail("NAMESPACE_PROFILE_CONFLICT", 503, `${label} is not canonical`, true);
  }
  return value;
}

function policyTarget(namespace: string, principal: string, profile: NamespaceBootstrapProfile, createdAt: string): PolicyTarget {
  return {
    source_namespace_id: namespace,
    revision: 1,
    authorized_principal_refs_json: JSON.stringify([principal]),
    allowed_ownership_modes_json: '["immutable_import"]',
    source_class: profile.policy.source_class,
    assurance_ceiling: profile.policy.assurance_ceiling,
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    allowed_use_json: JSON.stringify([...profile.policy.allowed_use].sort()),
    disclosure_ceiling: profile.policy.disclosure_ceiling,
    license_policy_ref: profile.policy.license_policy_ref,
    default_storage_policy: "NORMALIZED_CLOUD_ONLY",
    default_residency_profile_id: profile.policy.default_residency_profile_id,
    default_retention_policy_id: profile.policy.default_retention_policy_id,
    minimum_quality_state: profile.policy.minimum_quality_state,
    created_at: createdAt,
  };
}

function validateProfile(profile: NamespaceBootstrapProfile, principal: string, credential: string, nowMs: number): void {
  if (profile.principal_ref !== principal || profile.credential_generation !== credential) {
    fail("NAMESPACE_PROFILE_CONFLICT", 403, "installed namespace profile is not bound to this owner");
  }
  const profileExpiry = Date.parse(canonicalTime(profile.expires_at, "profile expiry"));
  const scopeExpiry = Date.parse(canonicalTime(profile.owner_read_scope.expires_at, "read scope expiry"));
  if (profileExpiry <= nowMs || scopeExpiry <= nowMs) fail("NAMESPACE_PROFILE_EXPIRED", 409, "installed namespace profile has expired");
  if (scopeExpiry > profileExpiry || profile.owner_read_scope.disclosure_ceiling !== profile.policy.disclosure_ceiling) {
    fail("NAMESPACE_PROFILE_CONFLICT", 503, "installed namespace profile has inconsistent scope", true);
  }
  const erasure = profile.erasure_admission_policy;
  if (erasure !== undefined) {
    const startsAt = Date.parse(canonicalTime(erasure.valid_from, "erasure permission valid-from"));
    const expiresAt = Date.parse(canonicalTime(erasure.expires_at, "erasure permission expiry"));
    if (expiresAt > profileExpiry || expiresAt <= startsAt) {
      fail("NAMESPACE_PROFILE_CONFLICT", 503, "erasure permission exceeds its installed profile validity", true);
    }
    if (startsAt > nowMs || expiresAt <= nowMs) {
      fail("NAMESPACE_PROFILE_UNAVAILABLE", 409, "installed erasure permission is not current");
    }
  }
  const policyUses = [...profile.policy.allowed_use];
  const scopeUses = [...profile.owner_read_scope.allowed_use];
  if (profile.policy.allowed_ownership_modes.length !== 1 || profile.policy.allowed_ownership_modes[0] !== "immutable_import" ||
      profile.policy.instruction_taint !== "DATA_ONLY" || profile.policy.allowed_effects !== "READ_ONLY" ||
      !policyUses.includes("research") || !scopeUses.includes("research") ||
      policyUses.some((use) => !scopeUses.includes(use)) || new Set(policyUses).size !== policyUses.length ||
      new Set(scopeUses).size !== scopeUses.length) {
    fail("NAMESPACE_PROFILE_CONFLICT", 503, "installed namespace profile is not an immutable research import profile", true);
  }
}

async function namespaceIdentity(principal: string, idempotencyKey: string): Promise<{
  readonly source_namespace_id: string;
  readonly owner_incarnation_ref: string;
  readonly source_owner_generation: string;
}> {
  const seed = await sha256Utf8(JSON.stringify(["eliotr.source-namespace.initial.v1", principal, idempotencyKey]));
  const ownerIncarnation = `owner-incarnation-${await sha256Utf8(JSON.stringify(["eliotr.owner-incarnation.initial.v1", principal, idempotencyKey]))}`;
  const ownerGeneration = `owner-${await sha256Utf8(JSON.stringify([
    "eliotr.source-owner.initial.v1", `namespace-${seed}`, OWNER_SYSTEM_ID, ownerIncarnation, 1, "ACTIVE",
  ]))}`;
  return {
    source_namespace_id: `namespace-${seed}`,
    owner_incarnation_ref: ownerIncarnation,
    source_owner_generation: ownerGeneration,
  };
}

async function scopePolicyRef(namespace: string, principal: string, scope: NamespaceBootstrapProfile["owner_read_scope"]): Promise<string> {
  return `owner-read-${await sha256Utf8(JSON.stringify([
    "eliotr.owner-read-policy.initial.v1", namespace, principal, CLIENT_CLASS, 1,
    [...scope.allowed_use].sort(), scope.disclosure_ceiling, scope.expires_at,
  ]))}`;
}

function initializationTarget(
  identity: Awaited<ReturnType<typeof namespaceIdentity>>,
  context: { readonly principal_ref: string; readonly credential_generation: string },
  profile: NamespaceBootstrapProfile,
  input: OwnerNamespaceInitializeInput,
  readPolicyRef: string,
  requestSha: string,
  createdAt: string,
): InitializationTarget {
  return {
    source_namespace_id: identity.source_namespace_id,
    principal_ref: context.principal_ref,
    credential_generation: context.credential_generation,
    profile_id: profile.profile_ref.id,
    profile_revision: profile.profile_ref.revision,
    title: input.title,
    idempotency_key: input.idempotency_key,
    owner_incarnation_ref: identity.owner_incarnation_ref,
    source_owner_generation: identity.source_owner_generation,
    ownership_record_revision: 1,
    source_admission_policy_revision: 1,
    scope_policy_ref: readPolicyRef,
    scope_policy_generation: 1,
    request_sha256: requestSha,
    created_at: createdAt,
  };
}

function targetsAt(target: NamespaceTargets, createdAt: string): NamespaceTargets {
  return {
    initialization: { ...target.initialization, created_at: createdAt },
    owner: { ...target.owner, created_at: createdAt },
    policy: { ...target.policy, created_at: createdAt },
    scope: { ...target.scope, created_at: createdAt },
    erasure_admission_policy: namespaceErasureAdmissionAt(target.erasure_admission_policy, createdAt),
  };
}

function exactResult(state: NamespaceState, target: NamespaceTargets): OwnerNamespaceInitialization {
  if (!namespaceStateMatches(state, target)) fail("NAMESPACE_SETTLEMENT_UNCERTAIN", 503, "namespace initialization did not read back exactly", true);
  return {
    protocol: "eliotr.owner-namespace.v1",
    source_namespace_id: target.initialization.source_namespace_id,
    title: target.initialization.title,
    created_at: target.initialization.created_at,
  };
}

function validateExisting(state: NamespaceState, target: NamespaceTargets): OwnerNamespaceInitialization {
  if (!namespaceStateMatches(state, target)) fail("NAMESPACE_IDEMPOTENCY_CONFLICT", 409, "namespace idempotency key is bound to different durable state");
  return exactResult(state, target);
}

function readRows(database: D1Database, principal: string, idempotencyKey: string, namespace: string) {
  return readNamespaceState(database, principal, idempotencyKey, namespace, (cause) => {
    if (cause instanceof SourceNamespaceOwnerError) throw cause;
    fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, "namespace state read is unavailable", true, cause);
  });
}

function listNamespaceRow(row: Record<string, unknown>, nowMs: number): { readonly source_namespace_id: string; readonly title: string } | null {
  let uses: unknown;
  try { uses = typeof row.scope_allowed_use_json === "string" ? JSON.parse(row.scope_allowed_use_json) : undefined; } catch { uses = undefined; }
  if (typeof row.source_namespace_id !== "string" || !IDENTIFIER.test(row.source_namespace_id) ||
      typeof row.title !== "string" || row.title.length === 0 || row.title.length > MAX_TITLE_BYTES ||
      row.owner_status !== "ACTIVE" || row.scope_client_class !== CLIENT_CLASS || row.scope_state !== "ACTIVE" ||
      row.scope_principal !== row.principal_ref || typeof row.scope_expires_at !== "string" ||
      !Number.isSafeInteger(Date.parse(row.scope_expires_at)) || Date.parse(row.scope_expires_at) <= nowMs ||
      !Array.isArray(uses) || !uses.includes("research")) {
    return null;
  }
  return { source_namespace_id: row.source_namespace_id, title: row.title };
}

export function createSourceNamespaceOwnerService(options: SourceNamespaceOwnerServiceOptions) {
  const now = options.now ?? Date.now;
  const list = async (requestContext: AuthenticatedRequestContext): Promise<OwnerNamespaceList> => {
    const context = contextSnapshot(requestContext);
    const clock = canonicalNow(now);
    const profiles = options.profiles.listCurrent(context, clock.millis);
    let rows: readonly Record<string, unknown>[];
    try {
      rows = (await options.database.prepare(
        "SELECT o.source_namespace_id,COALESCE(i.title,substr(o.source_namespace_id,1,120)) AS title,?1 AS principal_ref," +
        "o.status AS owner_status,s.principal_ref AS scope_principal,s.client_class AS scope_client_class,s.state AS scope_state," +
        "s.expires_at AS scope_expires_at,s.allowed_use_json AS scope_allowed_use_json FROM source_namespace_ownership o JOIN scope_read_policy s " +
        "ON s.source_namespace_id=o.source_namespace_id AND s.principal_ref=?1 AND s.client_class='owner_pwa' " +
        "JOIN source_admission_policy p ON p.source_namespace_id=o.source_namespace_id AND p.revision=o.source_admission_policy_revision " +
        "LEFT JOIN source_namespace_initialization i ON i.source_namespace_id=o.source_namespace_id " +
        "WHERE o.status='ACTIVE' AND s.state='ACTIVE' AND s.expires_at>?2 " +
        "AND EXISTS (SELECT 1 FROM json_each(s.allowed_use_json) WHERE json_each.value='research') " +
        "AND EXISTS (SELECT 1 FROM json_each(p.authorized_principal_refs_json) WHERE json_each.value=?1) " +
        "AND EXISTS (SELECT 1 FROM json_each(p.allowed_ownership_modes_json) WHERE json_each.value='immutable_import') " +
        "ORDER BY o.created_at,o.source_namespace_id LIMIT 257",
      ).bind(context.principal_ref, clock.iso).all<Record<string, unknown>>()).results ?? [];
    } catch (cause) {
      fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, "namespace list is unavailable", true, cause);
    }
    if (rows.length > 256) fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, "namespace list exceeds its bounded envelope", true);
    const namespaces = rows.map((row) => listNamespaceRow(row, clock.millis)).filter((row): row is { readonly source_namespace_id: string; readonly title: string } => row !== null);
    return { protocol: "eliotr.owner-namespaces.v1", profiles, namespaces };
  };
  const initialize = async (
    requestContext: AuthenticatedRequestContext,
    input: OwnerNamespaceInitializeInput,
  ): Promise<OwnerNamespaceInitialization> => {
    const context = contextSnapshot(requestContext);
    if (!input || typeof input !== "object" || !IDENTIFIER.test(input.idempotency_key) ||
        typeof input.title !== "string" || input.title.length < 1 || input.title.length > MAX_TITLE_BYTES ||
        input.title !== input.title.trim() || /[\u0000-\u001f\u007f]/u.test(input.title) ||
        !input.profile_ref || typeof input.profile_ref.id !== "string" || !IDENTIFIER.test(input.profile_ref.id) ||
        !Number.isSafeInteger(input.profile_ref.revision) || input.profile_ref.revision < 1) {
      fail("NAMESPACE_INPUT_INVALID", 400, "namespace initialization input is invalid");
    }
    const clock = canonicalNow(now);
    const profile = options.profiles.requireCurrent(context, input.profile_ref as VersionedRef, clock.millis);
    validateProfile(profile, context.principal_ref, context.credential_generation, clock.millis);
    const identity = await namespaceIdentity(context.principal_ref, input.idempotency_key);
    const owner: OwnerTarget = {
      source_namespace_id: identity.source_namespace_id, ownership_record_revision: 1, owner_system_id: OWNER_SYSTEM_ID,
      owner_incarnation_ref: identity.owner_incarnation_ref, source_owner_generation: identity.source_owner_generation,
      source_admission_policy_revision: 1, status: "ACTIVE", cutover_receipt_ref: null, created_at: clock.iso,
    };
    const policy = policyTarget(identity.source_namespace_id, context.principal_ref, profile, clock.iso);
    const readPolicyRef = await scopePolicyRef(identity.source_namespace_id, context.principal_ref, profile.owner_read_scope);
    const scope: ScopeTarget = {
      source_namespace_id: identity.source_namespace_id, principal_ref: context.principal_ref, client_class: CLIENT_CLASS,
      policy_ref: readPolicyRef, generation: 1, allowed_use_json: JSON.stringify([...profile.owner_read_scope.allowed_use].sort()),
      disclosure_ceiling: profile.owner_read_scope.disclosure_ceiling, state: "ACTIVE", expires_at: profile.owner_read_scope.expires_at, created_at: clock.iso,
    };
    const erasureAdmission = await prepareNamespaceErasureAdmissionPolicy(
      profile.erasure_admission_policy,
      identity,
      context,
      clock.iso,
    );
    const requestSha = await canonicalDigest({
      protocol: "eliotr.owner-namespace.v1", principal_ref: context.principal_ref, credential_generation: context.credential_generation,
      profile_ref: profile.profile_ref, profile_expires_at: profile.expires_at, provenance_ref: profile.provenance_ref,
      title: input.title, idempotency_key: input.idempotency_key,
      owner: {
        source_namespace_id: owner.source_namespace_id, ownership_record_revision: owner.ownership_record_revision,
        owner_system_id: owner.owner_system_id, owner_incarnation_ref: owner.owner_incarnation_ref,
        source_owner_generation: owner.source_owner_generation, source_admission_policy_revision: owner.source_admission_policy_revision,
        status: owner.status, cutover_receipt_ref: owner.cutover_receipt_ref,
      },
      policy: {
        source_namespace_id: policy.source_namespace_id, revision: policy.revision,
        authorized_principal_refs_json: policy.authorized_principal_refs_json,
        allowed_ownership_modes_json: policy.allowed_ownership_modes_json, source_class: policy.source_class,
        assurance_ceiling: policy.assurance_ceiling, instruction_taint: policy.instruction_taint,
        allowed_effects: policy.allowed_effects, allowed_use_json: policy.allowed_use_json,
        disclosure_ceiling: policy.disclosure_ceiling, license_policy_ref: policy.license_policy_ref,
        default_storage_policy: policy.default_storage_policy, default_residency_profile_id: policy.default_residency_profile_id,
        default_retention_policy_id: policy.default_retention_policy_id, minimum_quality_state: policy.minimum_quality_state,
      },
      scope: {
        source_namespace_id: scope.source_namespace_id, principal_ref: scope.principal_ref,
        client_class: scope.client_class, policy_ref: scope.policy_ref, generation: scope.generation,
        allowed_use_json: scope.allowed_use_json, disclosure_ceiling: scope.disclosure_ceiling,
        state: scope.state, expires_at: scope.expires_at,
      },
      ...(erasureAdmission === undefined ? {} : {
        erasure_admission_policy: {
          ...erasureAdmission.input,
          policy_json: erasureAdmission.policy_json,
          policy_sha256: erasureAdmission.policy_sha256,
        },
      }),
    });
    if (!SHA256.test(requestSha)) fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, "namespace request fingerprint is invalid", true);
    const initialization = initializationTarget(identity, context, profile, input, readPolicyRef, requestSha, clock.iso);
    const target = { initialization, owner, policy, scope, erasure_admission_policy: erasureAdmission };
    const before = await readRows(options.database, context.principal_ref, input.idempotency_key, identity.source_namespace_id);
    if (before.byKey.length > 1) fail("NAMESPACE_STORAGE_UNAVAILABLE", 503, "namespace idempotency ledger is ambiguous", true);
    if (before.byKey[0] !== undefined) {
      if (before.byKey[0].source_namespace_id !== identity.source_namespace_id || before.byKey[0].request_sha256 !== requestSha) {
        fail("NAMESPACE_IDEMPOTENCY_CONFLICT", 409, "namespace idempotency key is bound to another request");
      }
      const storedCreatedAt = before.byNamespace.initialization?.created_at;
      if (typeof storedCreatedAt !== "string") fail("NAMESPACE_IDEMPOTENCY_CONFLICT", 409, "namespace initialization timestamp is invalid");
      return validateExisting(before.byNamespace, targetsAt(target, storedCreatedAt));
    }
    if (hasAnyNamespaceState(before.byNamespace)) fail("NAMESPACE_EXISTING_LINEAGE", 409, "source namespace already has durable lineage");
    const freshClock = canonicalNow(now);
    const freshProfile = options.profiles.requireCurrent(context, input.profile_ref as VersionedRef, freshClock.millis);
    if (JSON.stringify(freshProfile) !== JSON.stringify(profile)) {
      fail("NAMESPACE_PROFILE_CONFLICT", 503, "installed namespace profile changed during initialization", true);
    }
    try {
      const statements: D1PreparedStatement[] = [
        options.database.prepare(
          "INSERT INTO source_admission_policy (source_namespace_id,revision,authorized_principal_refs_json,allowed_ownership_modes_json,source_class,assurance_ceiling,instruction_taint,allowed_effects,allowed_use_json,disclosure_ceiling,license_policy_ref,default_storage_policy,default_residency_profile_id,default_retention_policy_id,minimum_quality_state,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        ).bind(policy.source_namespace_id, policy.revision, policy.authorized_principal_refs_json, policy.allowed_ownership_modes_json,
          policy.source_class, policy.assurance_ceiling, policy.instruction_taint, policy.allowed_effects, policy.allowed_use_json,
          policy.disclosure_ceiling, policy.license_policy_ref, policy.default_storage_policy, policy.default_residency_profile_id,
          policy.default_retention_policy_id, policy.minimum_quality_state, policy.created_at),
        options.database.prepare(
          "INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,cutover_receipt_ref,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        ).bind(owner.source_namespace_id, owner.ownership_record_revision, owner.owner_system_id, owner.owner_incarnation_ref,
          owner.source_owner_generation, owner.source_admission_policy_revision, owner.status, owner.cutover_receipt_ref, owner.created_at),
        ...(erasureAdmission === undefined ? [] : [namespaceErasureAdmissionStatement(options.database, erasureAdmission)]),
        options.database.prepare(
          "INSERT INTO scope_read_policy (source_namespace_id,principal_ref,client_class,policy_ref,generation,allowed_use_json,disclosure_ceiling,state,expires_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        ).bind(scope.source_namespace_id, scope.principal_ref, scope.client_class, scope.policy_ref, scope.generation, scope.allowed_use_json,
          scope.disclosure_ceiling, scope.state, scope.expires_at, scope.created_at),
        options.database.prepare(
          "INSERT INTO source_namespace_initialization (source_namespace_id,principal_ref,credential_generation,profile_id,profile_revision,title,idempotency_key,owner_incarnation_ref,source_owner_generation,ownership_record_revision,source_admission_policy_revision,scope_policy_ref,scope_policy_generation,request_sha256,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        ).bind(initialization.source_namespace_id, initialization.principal_ref, initialization.credential_generation, initialization.profile_id,
          initialization.profile_revision, initialization.title, initialization.idempotency_key, initialization.owner_incarnation_ref,
          initialization.source_owner_generation, initialization.ownership_record_revision, initialization.source_admission_policy_revision,
          initialization.scope_policy_ref, initialization.scope_policy_generation, initialization.request_sha256, initialization.created_at),
      ];
      await options.database.batch(statements);
    } catch {
      const afterFailure = await readRows(options.database, context.principal_ref, input.idempotency_key, identity.source_namespace_id);
      if (afterFailure.byKey[0]?.request_sha256 === requestSha) {
        const storedCreatedAt = afterFailure.byNamespace.initialization?.created_at;
        if (typeof storedCreatedAt !== "string") fail("NAMESPACE_SETTLEMENT_UNCERTAIN", 503, "namespace initialization timestamp is unavailable", true);
        return exactResult(afterFailure.byNamespace, targetsAt(target, storedCreatedAt));
      }
      if (hasAnyNamespaceState(afterFailure.byNamespace) || afterFailure.byKey.length > 0) {
        fail("NAMESPACE_IDEMPOTENCY_CONFLICT", 409, "namespace initialization conflicts with durable state");
      }
      fail("NAMESPACE_SETTLEMENT_UNCERTAIN", 503, "namespace initialization settlement is uncertain", true);
    }
    const after = await readRows(options.database, context.principal_ref, input.idempotency_key, identity.source_namespace_id);
    if (after.byKey[0]?.request_sha256 !== requestSha) fail("NAMESPACE_SETTLEMENT_UNCERTAIN", 503, "namespace initialization did not settle", true);
    const storedCreatedAt = after.byNamespace.initialization?.created_at;
    if (typeof storedCreatedAt !== "string") fail("NAMESPACE_SETTLEMENT_UNCERTAIN", 503, "namespace initialization timestamp is unavailable", true);
    return exactResult(after.byNamespace, targetsAt(target, storedCreatedAt));
  };
  return Object.freeze({ list, initialize });
}
