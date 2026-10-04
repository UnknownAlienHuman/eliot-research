import {
  createErasureAdmissionPolicyInsertStatement,
  prepareErasureAdmissionPolicyInstall,
  stableErasureId,
  type ErasureAdmissionPolicyInstallPlan,
} from "@eliotr/cloudflare-erasure";
import type {
  NamespaceBootstrapErasureAdmissionPolicy,
  NamespaceErasureAdmissionPolicyPlan,
  NamespaceErasureAdmissionPolicyPort,
} from "@eliotr/cloudflare-navigation";

export {
  namespaceErasureAdmissionAt,
  namespaceErasureAdmissionMatches,
} from "@eliotr/cloudflare-navigation";
export type {
  NamespaceErasureAdmissionPolicyRow,
} from "@eliotr/cloudflare-navigation";

const OWNER_SYSTEM_ID = "eliotr";

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
  plan: NamespaceErasureAdmissionPolicyPlan,
): D1PreparedStatement {
  return createErasureAdmissionPolicyInsertStatement(database, plan);
}

export function createNamespaceErasureAdmissionPolicyPort(): NamespaceErasureAdmissionPolicyPort {
  const port = {
    prepare: prepareNamespaceErasureAdmissionPolicy,
    statement: namespaceErasureAdmissionStatement,
  } satisfies NamespaceErasureAdmissionPolicyPort;
  return Object.freeze(port);
}
