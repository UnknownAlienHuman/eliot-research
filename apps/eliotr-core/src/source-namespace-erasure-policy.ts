import {
  createErasureAdmissionPolicyInsertStatement,
  prepareErasureAdmissionPolicyInstall,
  stableErasureId,
  type ErasureAdmissionPolicyInstallPlan,
} from "@eliotr/cloudflare-erasure";
import type { NamespaceBootstrapErasureAdmissionPolicy } from "./source-namespace-bootstrap-profiles.js";

const OWNER_SYSTEM_ID = "eliotr";

export interface NamespaceErasureAdmissionPolicyRow extends Record<string, unknown> {
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

interface NamespaceIdentity {
  readonly source_namespace_id: string;
  readonly source_owner_generation: string;
}

interface OwnerContext {
  readonly principal_ref: string;
  readonly credential_generation: string;
}

export async function prepareNamespaceErasureAdmissionPolicy(
  config: NamespaceBootstrapErasureAdmissionPolicy | undefined,
  identity: NamespaceIdentity,
  owner: OwnerContext,
  createdAt: string,
): Promise<ErasureAdmissionPolicyInstallPlan | undefined> {
  if (config === undefined) return undefined;
  const permissionId = await stableErasureId(
    "namespace-erasure-permission",
    identity.source_namespace_id,
    identity.source_owner_generation,
    config.permission_profile_ref.id,
    String(config.permission_profile_ref.revision),
  );
  const input = Object.freeze({
    permission_ref: Object.freeze({ id: permissionId, revision: 1 }),
    source_namespace_id: identity.source_namespace_id,
    owner_system_id: OWNER_SYSTEM_ID,
    source_owner_generation: identity.source_owner_generation,
    principal_ref: owner.principal_ref,
    credential_generation: owner.credential_generation,
    authorization_binding_ref: config.authorization_binding_ref,
    legal_basis_ref: config.legal_basis_ref,
    valid_from: config.valid_from,
    expires_at: config.expires_at,
  });
  return prepareErasureAdmissionPolicyInstall(input, createdAt);
}

export function namespaceErasureAdmissionStatement(
  database: D1Database,
  plan: ErasureAdmissionPolicyInstallPlan,
): D1PreparedStatement {
  return createErasureAdmissionPolicyInsertStatement(database, plan);
}

export function namespaceErasureAdmissionAt(
  plan: ErasureAdmissionPolicyInstallPlan | undefined,
  createdAt: string,
): ErasureAdmissionPolicyInstallPlan | undefined {
  return plan === undefined ? undefined : Object.freeze({ ...plan, created_at: createdAt });
}

export function namespaceErasureAdmissionMatches(
  row: NamespaceErasureAdmissionPolicyRow | null,
  plan: ErasureAdmissionPolicyInstallPlan | undefined,
): boolean {
  if (plan === undefined) return row === null;
  if (row === null) return false;
  const input = plan.input;
  return row.permission_ref === input.permission_ref.id &&
    row.revision === input.permission_ref.revision &&
    row.source_namespace_id === input.source_namespace_id &&
    row.owner_system_id === input.owner_system_id &&
    row.source_owner_generation === input.source_owner_generation &&
    row.principal_ref === input.principal_ref &&
    row.credential_generation === input.credential_generation &&
    row.authorization_binding_ref === input.authorization_binding_ref &&
    row.legal_basis_ref === input.legal_basis_ref &&
    row.valid_from === input.valid_from &&
    row.expires_at === input.expires_at &&
    row.state === "ACTIVE" &&
    row.policy_json === plan.policy_json &&
    row.policy_sha256 === plan.policy_sha256 &&
    row.created_at === plan.created_at &&
    row.revoked_at === null;
}
