import { createD1EvidenceAuthorityPort } from "@eliotr/cloudflare-evidence";
import type { ScopeAuthority } from "@eliotr/cloudflare-evidence";
import type { ScopeSnapshot, VersionedRef } from "@eliotr/contracts";

export interface HeldResearchScopeAccess {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly client_class: string;
}
export interface HeldResearchScope {
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly scope_snapshot: ScopeSnapshot;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly authorization_receipt_ref: string;
  readonly purge_revision: number;
  readonly deployment_generation: string;
}
export class ResearchHeldScopeError extends Error {
  constructor(readonly code: "RESEARCH_HELD_SCOPE_STALE" | "RESEARCH_HELD_SCOPE_UNAVAILABLE") {
    super(code);
    this.name = "ResearchHeldScopeError";
  }
}
interface StoredRunScopeRow {
  readonly operation_id: unknown;
  readonly investigation_id: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly deployment_generation: unknown;
  readonly policy_generation: unknown;
  readonly policy_authority_ref: unknown;
  readonly authorization_receipt_ref: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly purge_revision: unknown;
}
function stale(): never { throw new ResearchHeldScopeError("RESEARCH_HELD_SCOPE_STALE"); }
function unavailable(): never { throw new ResearchHeldScopeError("RESEARCH_HELD_SCOPE_UNAVAILABLE"); }
function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) unavailable();
  return value;
}
function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) unavailable();
  return value as number;
}
function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) unavailable();
  return value as number;
}
export async function readHeldResearchScope(input: {
  readonly core_database: D1Database;
  readonly search_database: D1Database;
  readonly access: HeldResearchScopeAccess;
  readonly operation_id: string;
  readonly deployment_generation: string;
  readonly require_current_scope: (scope: ScopeSnapshot) => Promise<unknown>;
}): Promise<HeldResearchScope> {
  requiredString(input.deployment_generation);
  let row: StoredRunScopeRow | null;
  try {
    row = await input.core_database.prepare(
      "SELECT operation_id, investigation_id, principal_ref, credential_generation, deployment_generation, " +
      "policy_generation, policy_authority_ref, authorization_receipt_ref, scope_snapshot_id, " +
      "scope_snapshot_revision, purge_revision FROM research_workflow_current " +
      "WHERE operation_id = ?1 AND principal_ref = ?2 AND credential_generation = ?3 " +
      "AND deployment_generation = ?4 LIMIT 1",
    ).bind(input.operation_id, input.access.principal_ref, input.access.credential_generation, input.deployment_generation)
      .first<StoredRunScopeRow>();
  } catch { unavailable(); }
  if (row === null) stale();
  const scopeRef = { id: requiredString(row.scope_snapshot_id), revision: positiveRevision(row.scope_snapshot_revision) };
  let authority: ScopeAuthority | null;
  try {
    authority = await createD1EvidenceAuthorityPort({
      core_database: input.core_database,
      search_database: input.search_database,
    }).loadScope(scopeRef);
  } catch { unavailable(); }
  if (authority === null || authority.invalidated_at !== null) stale();
  const scope = authority.snapshot;
  await input.require_current_scope(scope);
  if (requiredString(row.operation_id) !== input.operation_id ||
      requiredString(row.principal_ref) !== input.access.principal_ref ||
      requiredString(row.credential_generation) !== input.access.credential_generation ||
      requiredString(row.deployment_generation) !== input.deployment_generation ||
      scope.snapshot_id !== scopeRef.id || scope.revision !== scopeRef.revision) stale();
  return Object.freeze({
    operation_id: input.operation_id,
    investigation_id: requiredString(row.investigation_id),
    scope_snapshot_ref: scopeRef,
    scope_snapshot: scope,
    policy_generation: requiredString(row.policy_generation),
    policy_authority_ref: requiredString(row.policy_authority_ref),
    authorization_receipt_ref: requiredString(row.authorization_receipt_ref),
    purge_revision: nonnegativeInteger(row.purge_revision),
    deployment_generation: requiredString(row.deployment_generation),
  });
}
