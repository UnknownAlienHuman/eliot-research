import {
  createErasureNamespaceAdmissionPolicyInsertStatement,
  prepareErasureNamespaceAdmissionPolicy,
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
): Promise<NamespaceErasureAdmissionPolicyPlan | undefined> {
  if (config === undefined) return undefined;
  return prepareErasureNamespaceAdmissionPolicy({
    configuration: config,
    namespace: identity,
    owner,
    created_at: createdAt,
  });
}

export function namespaceErasureAdmissionStatement(
  database: D1Database,
  plan: NamespaceErasureAdmissionPolicyPlan,
): D1PreparedStatement {
  return createErasureNamespaceAdmissionPolicyInsertStatement(database, plan);
}

export function createNamespaceErasureAdmissionPolicyPort(): NamespaceErasureAdmissionPolicyPort {
  const port = {
    prepare: prepareNamespaceErasureAdmissionPolicy,
    statement: namespaceErasureAdmissionStatement,
  } satisfies NamespaceErasureAdmissionPolicyPort;
  return Object.freeze(port);
}
