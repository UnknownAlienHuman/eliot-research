import type { VersionedRef } from "@eliotr/contracts";
import type { NamespaceBootstrapErasureAdmissionPolicy } from "./source-namespace-bootstrap-profiles.js";

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

/** Structural boundary for the erasure-owned admission plan; policy validation stays in Core's erasure adapter. */
export interface NamespaceErasureAdmissionPolicyPlan {
  readonly input: {
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
  };
  readonly policy_json: string;
  readonly policy_sha256: string;
  readonly created_at: string;
}

export interface NamespaceErasureAdmissionPolicyPort {
  prepare(
    config: NamespaceBootstrapErasureAdmissionPolicy | undefined,
    identity: { readonly source_namespace_id: string; readonly source_owner_generation: string },
    owner: { readonly principal_ref: string; readonly credential_generation: string },
    createdAt: string,
  ): Promise<NamespaceErasureAdmissionPolicyPlan | undefined>;
  statement(database: D1Database, plan: NamespaceErasureAdmissionPolicyPlan): D1PreparedStatement;
}

export function namespaceErasureAdmissionAt(
  plan: NamespaceErasureAdmissionPolicyPlan | undefined,
  createdAt: string,
): NamespaceErasureAdmissionPolicyPlan | undefined {
  return plan === undefined ? undefined : Object.freeze({ ...plan, created_at: createdAt });
}

export function namespaceErasureAdmissionMatches(
  row: NamespaceErasureAdmissionPolicyRow | null,
  plan: NamespaceErasureAdmissionPolicyPlan | undefined,
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
