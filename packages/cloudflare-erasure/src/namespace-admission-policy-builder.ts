import type { VersionedRef } from "@eliotr/contracts";
import { stableErasureId } from "./canonical.js";
import {
  createErasureAdmissionPolicyInsertStatement,
  prepareErasureAdmissionPolicyInstall,
  type ErasureAdmissionPolicyInstallPlan,
} from "./admission-policy-install.js";

const OWNER_SYSTEM_ID = "eliotr";

export interface ErasureNamespaceAdmissionPolicyConfiguration {
  readonly permission_profile_ref: VersionedRef;
  readonly authorization_binding_ref: string;
  readonly legal_basis_ref: string;
  readonly valid_from: string;
  readonly expires_at: string;
}

export interface ErasureNamespaceIdentity {
  readonly source_namespace_id: string;
  readonly source_owner_generation: string;
}

export interface ErasureNamespaceOwnerIdentity {
  readonly principal_ref: string;
  readonly credential_generation: string;
}

export interface ErasureNamespaceAdmissionPolicyPreparation {
  readonly configuration: ErasureNamespaceAdmissionPolicyConfiguration;
  readonly namespace: ErasureNamespaceIdentity;
  readonly owner: ErasureNamespaceOwnerIdentity;
  readonly created_at: string;
}

/** Builds the immutable Erasure-owned permission plan from already-authorized namespace inputs. */
export async function prepareErasureNamespaceAdmissionPolicy(
  input: ErasureNamespaceAdmissionPolicyPreparation,
): Promise<ErasureAdmissionPolicyInstallPlan> {
  const permissionRef = await stableErasureId(
    "namespace-erasure-permission",
    input.namespace.source_namespace_id,
    input.namespace.source_owner_generation,
    input.configuration.permission_profile_ref.id,
    String(input.configuration.permission_profile_ref.revision),
  );
  return prepareErasureAdmissionPolicyInstall({
    permission_ref: { id: permissionRef, revision: 1 },
    source_namespace_id: input.namespace.source_namespace_id,
    owner_system_id: OWNER_SYSTEM_ID,
    source_owner_generation: input.namespace.source_owner_generation,
    principal_ref: input.owner.principal_ref,
    credential_generation: input.owner.credential_generation,
    authorization_binding_ref: input.configuration.authorization_binding_ref,
    legal_basis_ref: input.configuration.legal_basis_ref,
    valid_from: input.configuration.valid_from,
    expires_at: input.configuration.expires_at,
  }, input.created_at);
}

export function createErasureNamespaceAdmissionPolicyInsertStatement(
  database: D1Database,
  plan: ErasureAdmissionPolicyInstallPlan,
): D1PreparedStatement {
  return createErasureAdmissionPolicyInsertStatement(database, plan);
}
