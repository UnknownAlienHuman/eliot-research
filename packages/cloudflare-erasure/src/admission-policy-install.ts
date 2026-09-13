import type { VersionedRef } from "@eliotr/contracts";
import {
  assertErasureIdentifier,
  assertErasureInteger,
  assertErasureText,
  canonicalErasureJson,
  erasureFail,
  erasureSha256Utf8,
} from "./canonical.js";
import type { ErasureAdmissionPolicyInput } from "./admission-policy.js";

export interface ErasureAdmissionPolicyInstallInput extends ErasureAdmissionPolicyInput {
  readonly permission_ref: VersionedRef;
}

export interface ErasureAdmissionPolicyInstallPlan {
  readonly input: ErasureAdmissionPolicyInstallInput;
  readonly policy_json: string;
  readonly policy_sha256: string;
  readonly created_at: string;
}

interface CanonicalErasureAdmissionPolicyDocument {
  readonly protocol: "erc.privacy.erasure-admission.v1";
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

function permissionRef(ref: VersionedRef): VersionedRef {
  return {
    id: assertErasureIdentifier(ref.id, "erasure permission ID"),
    revision: assertErasureInteger(ref.revision, "erasure permission revision", 1, Number.MAX_SAFE_INTEGER),
  };
}

function timestamp(value: string, label: string): string {
  assertErasureText(value, label, 64);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 8_640_000_000_000_000) {
    erasureFail("ERASURE_INPUT_INVALID", `${label} is invalid`);
  }
  return new Date(parsed).toISOString();
}

export function canonicalErasureAdmissionPolicyDocument(input: ErasureAdmissionPolicyInput): CanonicalErasureAdmissionPolicyDocument {
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

export function ensureErasureAdmissionPolicyTimeOrder(validFrom: string, expiresAt: string): void {
  if (Date.parse(expiresAt) <= Date.parse(validFrom)) {
    erasureFail("ERASURE_INPUT_INVALID", "erasure permission expiry must follow valid-from");
  }
}

export async function prepareErasureAdmissionPolicyInstall(
  input: ErasureAdmissionPolicyInput,
  createdAt: string,
): Promise<ErasureAdmissionPolicyInstallPlan> {
  const document = canonicalErasureAdmissionPolicyDocument(input);
  ensureErasureAdmissionPolicyTimeOrder(document.valid_from as string, document.expires_at as string);
  const policyJson = canonicalErasureJson(document);
  const policySha = await erasureSha256Utf8(policyJson);
  const preparedInput: ErasureAdmissionPolicyInstallInput = Object.freeze({
    permission_ref: Object.freeze({ ...document.permission_ref }),
    source_namespace_id: document.source_namespace_id,
    owner_system_id: document.owner_system_id,
    source_owner_generation: document.source_owner_generation,
    principal_ref: document.principal_ref,
    credential_generation: document.credential_generation,
    authorization_binding_ref: document.authorization_binding_ref,
    legal_basis_ref: document.legal_basis_ref,
    valid_from: document.valid_from,
    expires_at: document.expires_at,
  });
  return Object.freeze({
    input: preparedInput,
    policy_json: policyJson,
    policy_sha256: policySha,
    created_at: timestamp(createdAt, "erasure permission creation time"),
  });
}

export function createErasureAdmissionPolicyInsertStatement(
  database: D1Database,
  plan: ErasureAdmissionPolicyInstallPlan,
): D1PreparedStatement {
  const input = plan.input;
  const ref = input.permission_ref;
  return database.prepare(
    "INSERT INTO erasure_admission_policy(permission_ref,revision,source_namespace_id,owner_system_id," +
    "source_owner_generation,principal_ref,credential_generation,authorization_binding_ref,legal_basis_ref," +
    "valid_from,expires_at,state,policy_json,policy_sha256,created_at,revoked_at) VALUES " +
    "(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'ACTIVE',?12,?13,?14,NULL)",
  ).bind(ref.id, ref.revision, input.source_namespace_id, input.owner_system_id, input.source_owner_generation,
    input.principal_ref, input.credential_generation, input.authorization_binding_ref, input.legal_basis_ref,
    input.valid_from, input.expires_at, plan.policy_json, plan.policy_sha256, plan.created_at);
}

export { permissionRef as normalizeErasurePermissionRef, timestamp as normalizeErasureTimestamp };
