import type { ErasureRequest, PurgeLocation, VersionedRef } from "@eliotr/contracts";
import {
  assertErasureIdentifier,
  assertErasureInteger,
  assertErasureText,
  canonicalErasureJson,
  erasureFail,
  erasureSha256Utf8,
  isoFromMs,
  parseErasureSubject,
  validateErasureRequest,
} from "./canonical.js";

export interface ErasureAdmissionActor {
  readonly principal_ref: string;
  readonly credential_generation: string;
}

export interface ErasureAdmissionPolicyInput {
  readonly permission_ref: VersionedRef;
  readonly source_namespace_id: string;
  readonly owner_system_id: string;
  readonly source_owner_generation: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly authorization_binding_ref: string;
  readonly legal_basis_ref: string;
  readonly valid_from: string;
  readonly expires_at: string;
}

export interface ErasureAdmissionPolicy extends ErasureAdmissionPolicyInput {
  readonly state: "ACTIVE" | "REVOKED";
  readonly policy_json: string;
  readonly policy_sha256: string;
  readonly created_at: string;
  readonly revoked_at?: string;
}

export interface ErasureAdmissionPolicyStore {
  install(input: ErasureAdmissionPolicyInput): Promise<ErasureAdmissionPolicy>;
  read(permissionRef: VersionedRef): Promise<ErasureAdmissionPolicy | null>;
  revoke(permissionRef: VersionedRef, revokedAt?: string): Promise<ErasureAdmissionPolicy>;
  admit(
    actor: ErasureAdmissionActor,
    permissionRef: VersionedRef,
    request: ErasureRequest,
  ): Promise<ErasureRequest>;
}

export type ErasureAdmissionErrorCode =
  | "ERASURE_PERMISSION_DENIED"
  | "ERASURE_PERMISSION_CONFLICT";

export class ErasureAdmissionError extends Error {
  public readonly code: ErasureAdmissionErrorCode;
  public readonly retryable = false;

  public constructor(code: ErasureAdmissionErrorCode, message: string) {
    super(message);
    this.name = "ErasureAdmissionError";
    this.code = code;
  }
}

function admissionFail(code: ErasureAdmissionErrorCode, message: string): never {
  throw new ErasureAdmissionError(code, message);
}

const ALL_LOCATIONS: readonly PurgeLocation[] = [
  "CanonicalPayload", "Projection", "Index", "Blob", "OperationalRecovery",
  "ProviderCopy", "BackupRestorePath", "RouteContinuation",
];

interface PolicyRow {
  readonly permission_ref: unknown;
  readonly revision: unknown;
  readonly source_namespace_id: unknown;
  readonly owner_system_id: unknown;
  readonly source_owner_generation: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly authorization_binding_ref: unknown;
  readonly legal_basis_ref: unknown;
  readonly valid_from: unknown;
  readonly expires_at: unknown;
  readonly state: unknown;
  readonly policy_json: unknown;
  readonly policy_sha256: unknown;
  readonly created_at: unknown;
  readonly revoked_at: unknown;
}

interface RevisionRow {
  readonly source_revision_ref: unknown;
  readonly source_id: unknown;
  readonly source_namespace_id: unknown;
  readonly source_owner_system_id: unknown;
  readonly source_owner_generation: unknown;
  readonly current_owner_system_id: unknown;
  readonly current_owner_generation: unknown;
  readonly owner_status: unknown;
}

function permissionRef(ref: VersionedRef): VersionedRef {
  return {
    id: assertErasureIdentifier(ref.id, "erasure permission ID"),
    revision: assertErasureInteger(ref.revision, "erasure permission revision", 1, Number.MAX_SAFE_INTEGER),
  };
}

function timestamp(value: string, label: string): string {
  assertErasureText(value, label, 64);
  if (!Number.isFinite(Date.parse(value))) erasureFail("ERASURE_INPUT_INVALID", `${label} is invalid`);
  return value;
}

function policyDocument(input: ErasureAdmissionPolicyInput): Record<string, unknown> {
  const ref = permissionRef(input.permission_ref);
  return {
    protocol: "erc.privacy.erasure-admission.v1",
    permission_ref: ref,
    source_namespace_id: assertErasureIdentifier(input.source_namespace_id, "erasure permission namespace"),
    owner_system_id: assertErasureIdentifier(input.owner_system_id, "erasure permission owner"),
    source_owner_generation: assertErasureIdentifier(input.source_owner_generation, "erasure permission owner generation"),
    principal_ref: assertErasureIdentifier(input.principal_ref, "erasure permission principal"),
    credential_generation: assertErasureIdentifier(input.credential_generation, "erasure permission credential generation"),
    authorization_binding_ref: assertErasureIdentifier(input.authorization_binding_ref, "erasure permission authorization binding"),
    legal_basis_ref: assertErasureIdentifier(input.legal_basis_ref, "erasure permission legal basis"),
    valid_from: timestamp(input.valid_from, "erasure permission valid-from"),
    expires_at: timestamp(input.expires_at, "erasure permission expiry"),
  };
}

function decodePolicy(row: PolicyRow): ErasureAdmissionPolicy {
  const ref = permissionRef({
    id: assertErasureIdentifier(row.permission_ref, "stored erasure permission ID"),
    revision: assertErasureInteger(row.revision, "stored erasure permission revision", 1, Number.MAX_SAFE_INTEGER),
  });
  const policy: ErasureAdmissionPolicyInput = {
    permission_ref: ref,
    source_namespace_id: assertErasureIdentifier(row.source_namespace_id, "stored erasure permission namespace"),
    owner_system_id: assertErasureIdentifier(row.owner_system_id, "stored erasure permission owner"),
    source_owner_generation: assertErasureIdentifier(row.source_owner_generation, "stored erasure permission owner generation"),
    principal_ref: assertErasureIdentifier(row.principal_ref, "stored erasure permission principal"),
    credential_generation: assertErasureIdentifier(row.credential_generation, "stored erasure permission credential generation"),
    authorization_binding_ref: assertErasureIdentifier(row.authorization_binding_ref, "stored erasure permission authorization binding"),
    legal_basis_ref: assertErasureIdentifier(row.legal_basis_ref, "stored erasure permission legal basis"),
    valid_from: timestamp(String(row.valid_from), "stored erasure permission valid-from"),
    expires_at: timestamp(String(row.expires_at), "stored erasure permission expiry"),
  };
  const expectedJson = canonicalErasureJson(policyDocument(policy));
  if (row.policy_json !== expectedJson || typeof row.policy_sha256 !== "string") {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure permission bytes are not canonical");
  }
  if (row.state !== "ACTIVE" && row.state !== "REVOKED") {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure permission state is invalid");
  }
  const revokedAt = row.revoked_at === null || row.revoked_at === undefined
    ? undefined
    : timestamp(String(row.revoked_at), "stored erasure permission revocation time");
  if (row.state === "REVOKED" && revokedAt === undefined) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "revoked erasure permission lacks revocation time");
  }
  return {
    ...policy,
    state: row.state,
    policy_json: expectedJson,
    policy_sha256: row.policy_sha256,
    created_at: timestamp(String(row.created_at), "stored erasure permission creation time"),
    ...(revokedAt === undefined ? {} : { revoked_at: revokedAt }),
  };
}

function actor(actor: ErasureAdmissionActor): ErasureAdmissionActor {
  return {
    principal_ref: assertErasureIdentifier(actor.principal_ref, "erasure actor principal"),
    credential_generation: assertErasureIdentifier(actor.credential_generation, "erasure actor credential generation"),
  };
}

function ensureTimeOrder(validFrom: string, expiresAt: string): void {
  if (Date.parse(expiresAt) <= Date.parse(validFrom)) {
    erasureFail("ERASURE_INPUT_INVALID", "erasure permission expiry must follow valid-from");
  }
}

export interface ErasureAdmissionPolicyDependencies {
  readonly database: D1Database;
  readonly now?: () => number;
}

export function createErasureAdmissionPolicyStore(
  dependencies: ErasureAdmissionPolicyDependencies,
): ErasureAdmissionPolicyStore {
  const database = dependencies.database;
  const clock = dependencies.now ?? Date.now;
  const readRow = async (ref: VersionedRef): Promise<ErasureAdmissionPolicy | null> => {
    const key = permissionRef(ref);
    const row = await database.prepare(
      "SELECT permission_ref,revision,source_namespace_id,owner_system_id,source_owner_generation," +
      "principal_ref,credential_generation,authorization_binding_ref,legal_basis_ref,valid_from,expires_at," +
      "state,policy_json,policy_sha256,created_at,revoked_at FROM erasure_admission_policy " +
      "WHERE permission_ref=?1 AND revision=?2 LIMIT 1",
    ).bind(key.id, key.revision).first<PolicyRow>();
    return row === null ? null : decodePolicy(row);
  };
  const currentOwner = async (namespace: string): Promise<{ owner_system_id: string; source_owner_generation: string } | null> => {
    const row = await database.prepare(
      "SELECT owner_system_id,source_owner_generation FROM source_namespace_ownership " +
      "WHERE source_namespace_id=?1 AND status='ACTIVE' LIMIT 1",
    ).bind(namespace).first<{ owner_system_id: unknown; source_owner_generation: unknown }>();
    if (row === null) return null;
    return {
      owner_system_id: assertErasureIdentifier(row.owner_system_id, "current owner system"),
      source_owner_generation: assertErasureIdentifier(row.source_owner_generation, "current owner generation"),
    };
  };
  const revisionsForSubject = async (subjectRef: string): Promise<readonly string[]> => {
    const subject = parseErasureSubject(subjectRef);
    if (subject.kind === "source_revision") return [subject.source_revision_ref];
    if (subject.kind === "source") {
      const rows = await database.prepare(
        "SELECT source_revision_ref FROM source_revision WHERE source_id=?1 ORDER BY source_revision_ref LIMIT 10001",
      ).bind(subject.source_id).all<{ source_revision_ref: unknown }>();
      if (!rows.success || !Array.isArray(rows.results) || rows.results.length > 10000) {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "source revision ownership inventory is unavailable", true);
      }
      return rows.results.map((row) => assertErasureIdentifier(row.source_revision_ref, "source revision ref"));
    }
    if (subject.kind === "evidence_handle") {
      const row = await database.prepare(
        "SELECT source_revision_ref FROM evidence_handle WHERE handle_id=?1 AND revision=?2 LIMIT 1",
      ).bind(subject.handle_id, subject.revision).first<{ source_revision_ref: unknown }>();
      if (row === null) erasureFail("ERASURE_INPUT_INVALID", "erasure evidence handle does not exist");
      return [assertErasureIdentifier(row.source_revision_ref, "evidence source revision ref")];
    }
    const row = await database.prepare(
      "SELECT member_source_revision_refs_json FROM scope_snapshot WHERE snapshot_id=?1 AND revision=?2 LIMIT 1",
    ).bind(subject.snapshot_id, subject.revision).first<{ member_source_revision_refs_json: unknown }>();
    if (row === null || typeof row.member_source_revision_refs_json !== "string") {
      erasureFail("ERASURE_INPUT_INVALID", "erasure scope snapshot does not exist");
    }
    let members: unknown;
    try { members = JSON.parse(row.member_source_revision_refs_json); }
    catch (cause) { erasureFail("ERASURE_IDENTITY_CONFLICT", "erasure scope members are malformed", false, cause); }
    if (!Array.isArray(members) || members.length === 0 || members.length > 10000) {
      erasureFail("ERASURE_INPUT_INVALID", "erasure scope has no bounded source revisions");
    }
    return members.map((value) => {
      const ref = assertErasureIdentifier(value, "scope source revision ref");
      if (!ref.startsWith("source-revision:")) erasureFail("ERASURE_IDENTITY_CONFLICT", "scope member is not a source revision");
      return ref.slice("source-revision:".length);
    });
  };
  const verifyRevisions = async (
    refs: readonly string[],
    policy: ErasureAdmissionPolicy,
  ): Promise<void> => {
    const unique = [...new Set(refs)];
    if (unique.length === 0 || unique.length > 10000) erasureFail("ERASURE_INPUT_INVALID", "erasure subject closure is outside its bound");
    const rows = await database.prepare(
      "SELECT sr.source_revision_ref,sr.source_id,s.source_namespace_id,s.source_owner_system_id," +
      "sr.source_owner_generation,o.owner_system_id AS current_owner_system_id," +
      "o.source_owner_generation AS current_owner_generation,o.status AS owner_status " +
      "FROM source_revision sr JOIN source s ON s.source_id=sr.source_id " +
      "LEFT JOIN source_namespace_ownership o ON o.source_namespace_id=s.source_namespace_id " +
      "AND o.status='ACTIVE' WHERE sr.source_revision_ref IN (SELECT value FROM json_each(?1)) " +
      "ORDER BY sr.source_revision_ref LIMIT 10001",
    ).bind(JSON.stringify(unique)).all<RevisionRow>();
    if (!rows.success || !Array.isArray(rows.results) || rows.results.length !== unique.length) {
      erasureFail("ERASURE_INPUT_INVALID", "erasure subject closure contains an unknown source revision");
    }
    for (const row of rows.results) {
      if (row.source_namespace_id !== policy.source_namespace_id ||
          row.source_owner_system_id !== policy.owner_system_id ||
          row.source_owner_generation !== policy.source_owner_generation ||
          row.current_owner_system_id !== policy.owner_system_id ||
          row.current_owner_generation !== policy.source_owner_generation ||
          row.owner_status !== "ACTIVE") {
        admissionFail("ERASURE_PERMISSION_DENIED", "erasure subject is outside the current owner authority");
      }
    }
  };
  return {
    async install(input) {
      const policy = policyDocument(input);
      ensureTimeOrder(policy.valid_from as string, policy.expires_at as string);
      const namespaceOwner = await currentOwner(policy.source_namespace_id as string);
      if (namespaceOwner === null || namespaceOwner.owner_system_id !== policy.owner_system_id ||
          namespaceOwner.source_owner_generation !== policy.source_owner_generation) {
        admissionFail("ERASURE_PERMISSION_DENIED", "erasure permission owner is not current");
      }
      const policyJson = canonicalErasureJson(policy);
      const policySha = await erasureSha256Utf8(policyJson);
      const ref = policy.permission_ref as VersionedRef;
      const createdAt = isoFromMs(clock());
      try {
        await database.prepare(
          "INSERT INTO erasure_admission_policy(permission_ref,revision,source_namespace_id,owner_system_id," +
          "source_owner_generation,principal_ref,credential_generation,authorization_binding_ref,legal_basis_ref," +
          "valid_from,expires_at,state,policy_json,policy_sha256,created_at,revoked_at) VALUES " +
          "(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'ACTIVE',?12,?13,?14,NULL)",
        ).bind(ref.id, ref.revision, policy.source_namespace_id, policy.owner_system_id,
          policy.source_owner_generation, policy.principal_ref, policy.credential_generation,
          policy.authorization_binding_ref, policy.legal_basis_ref, policy.valid_from, policy.expires_at,
          policyJson, policySha, createdAt).run();
      } catch (cause) {
        const existing = await readRow(ref);
        if (existing === null) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure permission write acknowledgement was lost", true, cause);
        if (existing.policy_sha256 !== policySha || existing.policy_json !== policyJson) {
          admissionFail("ERASURE_PERMISSION_CONFLICT", "erasure permission identity is already bound to different policy");
        }
        return existing;
      }
      const stored = await readRow(ref);
      if (stored === null || stored.policy_sha256 !== policySha || stored.state !== "ACTIVE") {
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure permission readback is incomplete", true);
      }
      return stored;
    },
    read: readRow,
    async revoke(ref, revokedAt) {
      const key = permissionRef(ref);
      const existing = await readRow(key);
      if (existing === null) erasureFail("ERASURE_INPUT_INVALID", "erasure permission does not exist");
      if (existing.state === "REVOKED") return existing;
      const at = revokedAt === undefined ? isoFromMs(clock()) : timestamp(revokedAt, "erasure permission revocation time");
      await database.prepare(
        "UPDATE erasure_admission_policy SET state='REVOKED',revoked_at=?3 WHERE permission_ref=?1 AND revision=?2 AND state='ACTIVE'",
      ).bind(key.id, key.revision, at).run();
      const stored = await readRow(key);
      if (stored === null || stored.state !== "REVOKED") erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure permission revoke readback is incomplete", true);
      return stored;
    },
    async admit(rawActor, ref, rawRequest) {
      const subjectActor = actor(rawActor);
      const request = validateErasureRequest(rawRequest);
      const policy = await readRow(ref);
      if (policy === null) admissionFail("ERASURE_PERMISSION_DENIED", "erasure permission is not installed");
      const now = clock();
      if (policy.state !== "ACTIVE" || Date.parse(policy.valid_from) > now || Date.parse(policy.expires_at) <= now) {
        admissionFail("ERASURE_PERMISSION_DENIED", "erasure permission is not currently valid");
      }
      if (policy.principal_ref !== subjectActor.principal_ref || policy.credential_generation !== subjectActor.credential_generation ||
          request.requested_by_principal_ref !== subjectActor.principal_ref || request.legal_basis_ref !== policy.legal_basis_ref) {
        admissionFail("ERASURE_PERMISSION_DENIED", "erasure request is not bound to the installed permission");
      }
      const revisionRefs = (await Promise.all(request.exact_subject_refs.map(revisionsForSubject))).flat();
      await verifyRevisions(revisionRefs, policy);
      if (Date.parse(request.deadline) <= now) erasureFail("ERASURE_INPUT_INVALID", "erasure deadline has expired");
      return {
        ...request,
        requested_by_principal_ref: subjectActor.principal_ref,
        admitted_at: isoFromMs(now),
        required_locations: [...ALL_LOCATIONS],
      };
    },
  };
}
