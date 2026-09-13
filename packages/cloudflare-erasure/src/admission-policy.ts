import type { ErasureRequest, PurgeLocation, VersionedRef } from "@eliotr/contracts";
import {
  assertErasureIdentifier,
  assertErasureInteger,
  assertErasureSha256,
  canonicalErasureJson,
  erasureFail,
  erasureSha256Utf8,
  isoFromMs,
  parseErasureSubject,
  validateErasureRequest,
} from "./canonical.js";
import {
  canonicalErasureAdmissionPolicyDocument,
  createErasureAdmissionPolicyInsertStatement,
  normalizeErasurePermissionRef as permissionRef,
  normalizeErasureTimestamp as timestamp,
  prepareErasureAdmissionPolicyInstall,
} from "./admission-policy-install.js";

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

interface AdmissionRow {
  readonly erasure_id: unknown;
  readonly erasure_revision: unknown;
  readonly permission_ref: unknown;
  readonly permission_revision: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly permission_sha256: unknown;
  readonly request_json: unknown;
  readonly request_sha256: unknown;
  readonly request_identity_sha256: unknown;
  readonly admitted_at: unknown;
  readonly created_at: unknown;
}

async function decodePolicy(row: PolicyRow): Promise<ErasureAdmissionPolicy> {
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
  const expectedJson = canonicalErasureJson(canonicalErasureAdmissionPolicyDocument(policy));
  const storedSha = assertErasureSha256(row.policy_sha256, "stored erasure permission digest");
  if (row.policy_json !== expectedJson || storedSha !== await erasureSha256Utf8(expectedJson)) {
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
    policy_sha256: storedSha,
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

function admissionIdentityDocument(
  request: ErasureRequest,
  actorValue: ErasureAdmissionActor,
  permission: Pick<ErasureAdmissionPolicy, "permission_ref" | "policy_sha256">,
): Record<string, unknown> {
  return {
    request: {
      protocol: request.protocol,
      erasure_ref: request.erasure_ref,
      requested_by_principal_ref: actorValue.principal_ref,
      exact_subject_refs: request.exact_subject_refs,
      required_locations: ALL_LOCATIONS,
      legal_basis_ref: request.legal_basis_ref,
      deadline: request.deadline,
    },
    permission_ref: permission.permission_ref,
    permission_sha256: permission.policy_sha256,
    principal_ref: actorValue.principal_ref,
    credential_generation: actorValue.credential_generation,
  };
}

function finalAdmissionRequest(
  request: ErasureRequest,
  actorValue: ErasureAdmissionActor,
  admittedAt: string,
): ErasureRequest {
  return {
    ...request,
    requested_by_principal_ref: actorValue.principal_ref,
    admitted_at: admittedAt,
    required_locations: [...ALL_LOCATIONS],
  };
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
    return row === null ? null : await decodePolicy(row);
  };
  const readAdmission = async (ref: VersionedRef): Promise<{
    readonly request: ErasureRequest;
    readonly permission_ref: VersionedRef;
    readonly principal_ref: string;
    readonly credential_generation: string;
    readonly permission_sha256: string;
    readonly request_identity_sha256: string;
  } | null> => {
    const key = permissionRef(ref);
    const row = await database.prepare(
      "SELECT erasure_id,erasure_revision,permission_ref,permission_revision,principal_ref," +
      "credential_generation,permission_sha256,request_json,request_sha256,request_identity_sha256," +
      "admitted_at,created_at FROM erasure_admission_request WHERE erasure_id=?1 AND erasure_revision=?2 LIMIT 1",
    ).bind(key.id, key.revision).first<AdmissionRow>();
    if (row === null) return null;
    const erasureId = assertErasureIdentifier(row.erasure_id, "stored erasure ID");
    const erasureRevision = assertErasureInteger(row.erasure_revision, "stored erasure revision", 1, Number.MAX_SAFE_INTEGER);
    if (erasureId !== key.id || erasureRevision !== key.revision || typeof row.request_json !== "string") {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure admission identity is malformed");
    }
    let decoded: unknown;
    try { decoded = JSON.parse(row.request_json); }
    catch (cause) { erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure admission request is malformed", false, cause); }
    const validatedRequest = validateErasureRequest(decoded as ErasureRequest);
    if (canonicalErasureJson(decoded) !== row.request_json ||
        validatedRequest.erasure_ref.id !== key.id || validatedRequest.erasure_ref.revision !== key.revision ||
        validatedRequest.required_locations.length !== ALL_LOCATIONS.length ||
        ALL_LOCATIONS.some((location) => !validatedRequest.required_locations.includes(location))) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure admission request is not canonical");
    }
    const request = decoded as ErasureRequest;
    const permission = permissionRef({
      id: assertErasureIdentifier(row.permission_ref, "stored admission permission ID"),
      revision: assertErasureInteger(row.permission_revision, "stored admission permission revision", 1, Number.MAX_SAFE_INTEGER),
    });
    const principalRef = assertErasureIdentifier(row.principal_ref, "stored admission principal");
    const credentialGeneration = assertErasureIdentifier(row.credential_generation, "stored admission credential generation");
    const permissionSha = assertErasureSha256(row.permission_sha256, "stored admission permission digest");
    const requestSha = assertErasureSha256(row.request_sha256, "stored admission request digest");
    const identitySha = assertErasureSha256(row.request_identity_sha256, "stored admission identity digest");
    if (requestSha !== await erasureSha256Utf8(row.request_json) ||
        identitySha !== await erasureSha256Utf8(canonicalErasureJson(admissionIdentityDocument(request, {
          principal_ref: principalRef,
          credential_generation: credentialGeneration,
        }, {
          permission_ref: permission,
          policy_sha256: permissionSha,
        })))) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure admission digest is invalid");
    }
    if (row.admitted_at !== request.admitted_at || row.created_at === null || row.created_at === undefined) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure admission time is invalid");
    }
    timestamp(String(row.created_at), "stored erasure admission creation time");
    return {
      request,
      permission_ref: permission,
      principal_ref: principalRef,
      credential_generation: credentialGeneration,
      permission_sha256: permissionSha,
      request_identity_sha256: identitySha,
    };
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
      return ref.startsWith("source-revision:")
        ? assertErasureIdentifier(ref.slice("source-revision:".length), "scope source revision ref")
        : ref;
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
      const createdAt = isoFromMs(clock());
      const plan = await prepareErasureAdmissionPolicyInstall(input, createdAt);
      const policy = plan.input;
      const namespaceOwner = await currentOwner(policy.source_namespace_id);
      if (namespaceOwner === null || namespaceOwner.owner_system_id !== policy.owner_system_id ||
          namespaceOwner.source_owner_generation !== policy.source_owner_generation) {
        admissionFail("ERASURE_PERMISSION_DENIED", "erasure permission owner is not current");
      }
      const ref = policy.permission_ref;
      try {
        await createErasureAdmissionPolicyInsertStatement(database, plan).run();
      } catch (cause) {
        const existing = await readRow(ref);
        if (existing === null) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure permission write acknowledgement was lost", true, cause);
        if (existing.policy_sha256 !== plan.policy_sha256 || existing.policy_json !== plan.policy_json || existing.state !== "ACTIVE") {
          admissionFail("ERASURE_PERMISSION_CONFLICT", "erasure permission identity is already bound to different policy");
        }
        return existing;
      }
      const stored = await readRow(ref);
      if (stored === null || stored.policy_sha256 !== plan.policy_sha256 || stored.policy_json !== plan.policy_json || stored.state !== "ACTIVE") {
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
      const permission = permissionRef(ref);
      const assertAdmissible = (candidate: ErasureAdmissionPolicy, now: number): void => {
        if (candidate.state !== "ACTIVE" || Date.parse(candidate.valid_from) > now || Date.parse(candidate.expires_at) <= now) {
          admissionFail("ERASURE_PERMISSION_DENIED", "erasure permission is not currently valid");
        }
        if (candidate.principal_ref !== subjectActor.principal_ref || candidate.credential_generation !== subjectActor.credential_generation ||
            request.requested_by_principal_ref !== subjectActor.principal_ref || request.legal_basis_ref !== candidate.legal_basis_ref) {
          admissionFail("ERASURE_PERMISSION_DENIED", "erasure request is not bound to the installed permission");
        }
        if (Date.parse(request.deadline) <= now) erasureFail("ERASURE_INPUT_INVALID", "erasure deadline has expired");
      };
      const policy = await readRow(permission);
      if (policy === null) admissionFail("ERASURE_PERMISSION_DENIED", "erasure permission is not installed");
      assertAdmissible(policy, clock());
      const revisionRefs: string[] = [];
      const revisionSet = new Set<string>();
      for (const subject of request.exact_subject_refs) {
        const subjectRefs = await revisionsForSubject(subject);
        for (const revision of subjectRefs) {
          if (revisionSet.has(revision)) continue;
          if (revisionSet.size >= 10000) erasureFail("ERASURE_INPUT_INVALID", "erasure subject closure is outside its bound");
          revisionSet.add(revision);
          revisionRefs.push(revision);
        }
      }
      await verifyRevisions(revisionRefs, policy);
      const finalAuthorityGuard = async (expected: ErasureAdmissionPolicy): Promise<ErasureAdmissionPolicy> => {
        const latest = await readRow(permission);
        if (latest === null) admissionFail("ERASURE_PERMISSION_DENIED", "erasure permission is no longer installed");
        assertAdmissible(latest, clock());
        if (latest.policy_sha256 !== expected.policy_sha256) {
          admissionFail("ERASURE_PERMISSION_CONFLICT", "erasure permission digest changed during admission");
        }
        const owner = await currentOwner(latest.source_namespace_id);
        if (owner === null || owner.owner_system_id !== latest.owner_system_id ||
            owner.source_owner_generation !== latest.source_owner_generation) {
          admissionFail("ERASURE_PERMISSION_DENIED", "erasure permission owner is no longer current");
        }
        await verifyRevisions(revisionRefs, latest);
        return latest;
      };
      const confirmedPolicy = await finalAuthorityGuard(policy);
      const identitySha = await erasureSha256Utf8(canonicalErasureJson(admissionIdentityDocument(request, subjectActor, confirmedPolicy)));
      const existing = await readAdmission(request.erasure_ref);
      if (existing !== null) {
        if (existing.permission_ref.id !== confirmedPolicy.permission_ref.id || existing.permission_ref.revision !== confirmedPolicy.permission_ref.revision ||
            existing.principal_ref !== subjectActor.principal_ref || existing.credential_generation !== subjectActor.credential_generation ||
            existing.permission_sha256 !== confirmedPolicy.policy_sha256 || existing.request_identity_sha256 !== identitySha) {
          admissionFail("ERASURE_PERMISSION_CONFLICT", "erasure reference is already bound to different admission");
        }
        await finalAuthorityGuard(confirmedPolicy);
        return existing.request;
      }
      const admittedAt = isoFromMs(clock());
      if (Date.parse(request.deadline) <= Date.parse(admittedAt)) erasureFail("ERASURE_INPUT_INVALID", "erasure deadline has expired");
      const admitted = finalAdmissionRequest(request, subjectActor, admittedAt);
      const requestJson = canonicalErasureJson(admitted);
      const requestSha = await erasureSha256Utf8(requestJson);
      const createdAt = isoFromMs(clock());
      try {
        await database.prepare(
          "INSERT INTO erasure_admission_request(erasure_id,erasure_revision,permission_ref,permission_revision," +
          "principal_ref,credential_generation,permission_sha256,request_json,request_sha256,request_identity_sha256," +
          "admitted_at,created_at) SELECT ?1,?2,p.permission_ref,p.revision,p.principal_ref,p.credential_generation," +
          "p.policy_sha256,?3,?4,?5,?6,?7 FROM erasure_admission_policy p JOIN source_namespace_ownership o " +
          "ON o.source_namespace_id=p.source_namespace_id AND o.status='ACTIVE' " +
          "AND o.owner_system_id=p.owner_system_id AND o.source_owner_generation=p.source_owner_generation " +
          "WHERE p.permission_ref=?8 AND p.revision=?9 AND p.state='ACTIVE' AND p.valid_from<=?10 AND p.expires_at>?10 " +
          "AND p.principal_ref=?11 AND p.credential_generation=?12 AND p.policy_sha256=?13",
        ).bind(admitted.erasure_ref.id, admitted.erasure_ref.revision, requestJson, requestSha, identitySha,
          admitted.admitted_at, createdAt, confirmedPolicy.permission_ref.id, confirmedPolicy.permission_ref.revision,
          admittedAt, subjectActor.principal_ref, subjectActor.credential_generation, confirmedPolicy.policy_sha256).run();
      } catch (cause) {
        const raced = await readAdmission(admitted.erasure_ref);
        if (raced === null) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure admission write acknowledgement was lost", true, cause);
        if (raced.permission_ref.id !== confirmedPolicy.permission_ref.id || raced.permission_ref.revision !== confirmedPolicy.permission_ref.revision ||
            raced.principal_ref !== subjectActor.principal_ref || raced.credential_generation !== subjectActor.credential_generation ||
            raced.permission_sha256 !== confirmedPolicy.policy_sha256 || raced.request_identity_sha256 !== identitySha) {
          admissionFail("ERASURE_PERMISSION_CONFLICT", "erasure reference is already bound to different admission");
        }
        await finalAuthorityGuard(confirmedPolicy);
        return raced.request;
      }
      const stored = await readAdmission(admitted.erasure_ref);
      if (stored === null) {
        const latest = await readRow(permission);
        if (latest === null) admissionFail("ERASURE_PERMISSION_DENIED", "erasure permission disappeared before admission");
        assertAdmissible(latest, clock());
        erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "erasure admission readback is incomplete", true);
      }
      if (stored.permission_ref.id !== confirmedPolicy.permission_ref.id || stored.permission_ref.revision !== confirmedPolicy.permission_ref.revision ||
          stored.principal_ref !== subjectActor.principal_ref || stored.credential_generation !== subjectActor.credential_generation ||
          stored.permission_sha256 !== confirmedPolicy.policy_sha256 || stored.request_identity_sha256 !== identitySha) {
        admissionFail("ERASURE_PERMISSION_CONFLICT", "erasure reference is already bound to different admission");
      }
      await finalAuthorityGuard(confirmedPolicy);
      return stored.request;
    },
  };
}
