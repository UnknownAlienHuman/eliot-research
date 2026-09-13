import type { ErasureAdmissionPolicyInstallPlan } from "@eliotr/cloudflare-erasure";
import {
  namespaceErasureAdmissionMatches,
  type NamespaceErasureAdmissionPolicyRow,
} from "./source-namespace-erasure-policy.js";

export interface NamespaceInitializationRow extends Record<string, unknown> {
  readonly source_namespace_id: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly profile_id: unknown;
  readonly profile_revision: unknown;
  readonly title: unknown;
  readonly idempotency_key: unknown;
  readonly owner_incarnation_ref: unknown;
  readonly source_owner_generation: unknown;
  readonly ownership_record_revision: unknown;
  readonly source_admission_policy_revision: unknown;
  readonly scope_policy_ref: unknown;
  readonly scope_policy_generation: unknown;
  readonly request_sha256: unknown;
  readonly created_at: unknown;
}

interface NamespaceOwnerRow extends Record<string, unknown> {
  readonly source_namespace_id: unknown;
  readonly ownership_record_revision: unknown;
  readonly owner_system_id: unknown;
  readonly owner_incarnation_ref: unknown;
  readonly source_owner_generation: unknown;
  readonly source_admission_policy_revision: unknown;
  readonly status: unknown;
  readonly cutover_receipt_ref: unknown;
  readonly created_at: unknown;
}

interface NamespacePolicyRow extends Record<string, unknown> {
  readonly source_namespace_id: unknown;
  readonly revision: unknown;
  readonly authorized_principal_refs_json: unknown;
  readonly allowed_ownership_modes_json: unknown;
  readonly source_class: unknown;
  readonly assurance_ceiling: unknown;
  readonly instruction_taint: unknown;
  readonly allowed_effects: unknown;
  readonly allowed_use_json: unknown;
  readonly disclosure_ceiling: unknown;
  readonly license_policy_ref: unknown;
  readonly default_storage_policy: unknown;
  readonly default_residency_profile_id: unknown;
  readonly default_retention_policy_id: unknown;
  readonly minimum_quality_state: unknown;
  readonly created_at: unknown;
}

interface NamespaceScopeRow extends Record<string, unknown> {
  readonly source_namespace_id: unknown;
  readonly principal_ref: unknown;
  readonly client_class: unknown;
  readonly policy_ref: unknown;
  readonly generation: unknown;
  readonly allowed_use_json: unknown;
  readonly disclosure_ceiling: unknown;
  readonly state: unknown;
  readonly expires_at: unknown;
  readonly created_at: unknown;
}

export interface NamespaceState {
  readonly initialization: NamespaceInitializationRow | null;
  readonly owner: NamespaceOwnerRow | null;
  readonly policy: NamespacePolicyRow | null;
  readonly scope: NamespaceScopeRow | null;
  readonly erasure_admission_policy: NamespaceErasureAdmissionPolicyRow | null;
  readonly counts: {
    readonly initialization: number;
    readonly owner: number;
    readonly policy: number;
    readonly scope: number;
    readonly source: number;
    readonly admission_decision: number;
    readonly bundle: number;
    readonly raw_capture: number;
    readonly erasure_admission_policy: number;
  };
}

export interface NamespaceStateTarget {
  readonly initialization: object;
  readonly owner: object;
  readonly policy: object;
  readonly scope: object;
  readonly erasure_admission_policy: ErasureAdmissionPolicyInstallPlan | undefined;
}

export interface NamespaceStateRead {
  readonly byKey: readonly NamespaceInitializationRow[];
  readonly byNamespace: NamespaceState;
}

export async function readNamespaceState(
  database: D1Database,
  principal: string,
  idempotencyKey: string,
  namespace: string,
  onStorageUnavailable: (cause: unknown) => never,
): Promise<NamespaceStateRead> {
  try {
    const byKey = (await database.prepare(
      "SELECT source_namespace_id,principal_ref,credential_generation,profile_id,profile_revision,title,idempotency_key," +
      "owner_incarnation_ref,source_owner_generation,ownership_record_revision,source_admission_policy_revision,scope_policy_ref," +
      "scope_policy_generation,request_sha256,created_at FROM source_namespace_initialization " +
      "WHERE principal_ref=?1 AND idempotency_key=?2 ORDER BY source_namespace_id LIMIT 2",
    ).bind(principal, idempotencyKey).all<NamespaceInitializationRow>()).results ?? [];
    const stateRow = await database.prepare(
      "SELECT i.source_namespace_id AS init_namespace,i.principal_ref AS init_principal,i.credential_generation AS init_credential_generation," +
      "i.profile_id AS init_profile_id,i.profile_revision AS init_profile_revision,i.title AS init_title,i.idempotency_key AS init_idempotency_key," +
      "i.owner_incarnation_ref AS init_owner_incarnation,i.source_owner_generation AS init_owner_generation,i.ownership_record_revision AS init_owner_revision," +
      "i.source_admission_policy_revision AS init_policy_revision,i.scope_policy_ref AS init_scope_ref,i.scope_policy_generation AS init_scope_generation," +
      "i.request_sha256 AS init_request_sha256,i.created_at AS init_created_at," +
      "o.source_namespace_id AS owner_namespace,o.ownership_record_revision AS owner_revision,o.owner_system_id,o.owner_incarnation_ref AS owner_incarnation," +
      "o.source_owner_generation AS owner_generation,o.source_admission_policy_revision AS owner_policy_revision,o.status AS owner_status," +
      "o.cutover_receipt_ref,o.created_at AS owner_created_at," +
      "p.source_namespace_id AS policy_namespace,p.revision AS policy_revision,p.authorized_principal_refs_json,p.allowed_ownership_modes_json," +
      "p.source_class,p.assurance_ceiling,p.instruction_taint,p.allowed_effects,p.allowed_use_json,p.disclosure_ceiling,p.license_policy_ref," +
      "p.default_storage_policy,p.default_residency_profile_id,p.default_retention_policy_id,p.minimum_quality_state,p.created_at AS policy_created_at," +
      "s.source_namespace_id AS scope_namespace,s.principal_ref AS scope_principal,s.client_class AS scope_client_class,s.policy_ref AS scope_policy_ref," +
      "s.generation AS scope_generation,s.allowed_use_json AS scope_allowed_use_json,s.disclosure_ceiling AS scope_disclosure_ceiling,s.state AS scope_state," +
      "s.expires_at AS scope_expires_at,s.created_at AS scope_created_at," +
      "e.permission_ref AS erasure_permission_ref,e.revision AS erasure_permission_revision," +
      "e.source_namespace_id AS erasure_namespace,e.owner_system_id AS erasure_owner_system," +
      "e.source_owner_generation AS erasure_owner_generation,e.principal_ref AS erasure_principal," +
      "e.credential_generation AS erasure_credential,e.authorization_binding_ref AS erasure_binding," +
      "e.legal_basis_ref AS erasure_legal_basis,e.valid_from AS erasure_valid_from,e.expires_at AS erasure_expires_at," +
      "e.state AS erasure_state,e.policy_json AS erasure_policy_json,e.policy_sha256 AS erasure_policy_sha256," +
      "e.created_at AS erasure_created_at,e.revoked_at AS erasure_revoked_at," +
      "(SELECT COUNT(*) FROM source_namespace_initialization WHERE source_namespace_id=?1) AS init_count," +
      "(SELECT COUNT(*) FROM source_namespace_ownership WHERE source_namespace_id=?1) AS owner_count," +
      "(SELECT COUNT(*) FROM source_admission_policy WHERE source_namespace_id=?1) AS policy_count," +
      "(SELECT COUNT(*) FROM scope_read_policy WHERE source_namespace_id=?1) AS scope_count," +
      "(SELECT COUNT(*) FROM source WHERE source_namespace_id=?1) AS source_count," +
      "(SELECT COUNT(*) FROM source_admission_decision WHERE source_namespace_id=?1) AS admission_decision_count," +
      "(SELECT COUNT(*) FROM bundle_ingest_operation WHERE source_namespace_id=?1) AS bundle_count," +
      "(SELECT COUNT(*) FROM raw_file_capture WHERE source_namespace_id=?1) AS raw_capture_count," +
      "(SELECT COUNT(*) FROM erasure_admission_policy WHERE source_namespace_id=?1) AS erasure_admission_policy_count " +
      "FROM (SELECT ?1 AS requested_namespace) requested " +
      "LEFT JOIN source_namespace_initialization i ON i.source_namespace_id=requested.requested_namespace " +
      "LEFT JOIN source_namespace_ownership o ON o.source_namespace_id=i.source_namespace_id AND o.ownership_record_revision=i.ownership_record_revision " +
      "LEFT JOIN source_admission_policy p ON p.source_namespace_id=i.source_namespace_id AND p.revision=i.source_admission_policy_revision " +
      "LEFT JOIN scope_read_policy s ON s.source_namespace_id=i.source_namespace_id AND s.principal_ref=i.principal_ref AND s.client_class='owner_pwa' " +
      "LEFT JOIN erasure_admission_policy e ON e.source_namespace_id=i.source_namespace_id AND e.state='ACTIVE' " +
      "LIMIT 1",
    ).bind(namespace).first<Record<string, unknown>>();
    if (stateRow === null) throw new Error("namespace state read is unavailable");
    const byNamespace: NamespaceState = {
      initialization: stateRow.init_namespace === null ? null : {
        source_namespace_id: stateRow.init_namespace, principal_ref: stateRow.init_principal,
        credential_generation: stateRow.init_credential_generation, profile_id: stateRow.init_profile_id,
        profile_revision: stateRow.init_profile_revision, title: stateRow.init_title, idempotency_key: stateRow.init_idempotency_key,
        owner_incarnation_ref: stateRow.init_owner_incarnation, source_owner_generation: stateRow.init_owner_generation,
        ownership_record_revision: stateRow.init_owner_revision, source_admission_policy_revision: stateRow.init_policy_revision,
        scope_policy_ref: stateRow.init_scope_ref, scope_policy_generation: stateRow.init_scope_generation,
        request_sha256: stateRow.init_request_sha256, created_at: stateRow.init_created_at,
      },
      owner: stateRow.owner_namespace === null ? null : {
        source_namespace_id: stateRow.owner_namespace, ownership_record_revision: stateRow.owner_revision,
        owner_system_id: stateRow.owner_system_id, owner_incarnation_ref: stateRow.owner_incarnation,
        source_owner_generation: stateRow.owner_generation, source_admission_policy_revision: stateRow.owner_policy_revision,
        status: stateRow.owner_status, cutover_receipt_ref: stateRow.cutover_receipt_ref, created_at: stateRow.owner_created_at,
      },
      policy: stateRow.policy_namespace === null ? null : {
        source_namespace_id: stateRow.policy_namespace, revision: stateRow.policy_revision,
        authorized_principal_refs_json: stateRow.authorized_principal_refs_json, allowed_ownership_modes_json: stateRow.allowed_ownership_modes_json,
        source_class: stateRow.source_class, assurance_ceiling: stateRow.assurance_ceiling, instruction_taint: stateRow.instruction_taint,
        allowed_effects: stateRow.allowed_effects, allowed_use_json: stateRow.allowed_use_json, disclosure_ceiling: stateRow.disclosure_ceiling,
        license_policy_ref: stateRow.license_policy_ref, default_storage_policy: stateRow.default_storage_policy,
        default_residency_profile_id: stateRow.default_residency_profile_id, default_retention_policy_id: stateRow.default_retention_policy_id,
        minimum_quality_state: stateRow.minimum_quality_state, created_at: stateRow.policy_created_at,
      },
      scope: stateRow.scope_namespace === null ? null : {
        source_namespace_id: stateRow.scope_namespace, principal_ref: stateRow.scope_principal, client_class: stateRow.scope_client_class,
        policy_ref: stateRow.scope_policy_ref, generation: stateRow.scope_generation, allowed_use_json: stateRow.scope_allowed_use_json,
        disclosure_ceiling: stateRow.scope_disclosure_ceiling, state: stateRow.scope_state, expires_at: stateRow.scope_expires_at,
        created_at: stateRow.scope_created_at,
      },
      erasure_admission_policy: stateRow.erasure_permission_ref === null ? null : {
        permission_ref: stateRow.erasure_permission_ref, revision: stateRow.erasure_permission_revision,
        source_namespace_id: stateRow.erasure_namespace, owner_system_id: stateRow.erasure_owner_system,
        source_owner_generation: stateRow.erasure_owner_generation, principal_ref: stateRow.erasure_principal,
        credential_generation: stateRow.erasure_credential, authorization_binding_ref: stateRow.erasure_binding,
        legal_basis_ref: stateRow.erasure_legal_basis, valid_from: stateRow.erasure_valid_from,
        expires_at: stateRow.erasure_expires_at, state: stateRow.erasure_state,
        policy_json: stateRow.erasure_policy_json, policy_sha256: stateRow.erasure_policy_sha256,
        created_at: stateRow.erasure_created_at, revoked_at: stateRow.erasure_revoked_at,
      },
      counts: {
        initialization: Number(stateRow.init_count ?? 0), owner: Number(stateRow.owner_count ?? 0),
        policy: Number(stateRow.policy_count ?? 0), scope: Number(stateRow.scope_count ?? 0),
        source: Number(stateRow.source_count ?? 0), admission_decision: Number(stateRow.admission_decision_count ?? 0),
        bundle: Number(stateRow.bundle_count ?? 0), raw_capture: Number(stateRow.raw_capture_count ?? 0),
        erasure_admission_policy: Number(stateRow.erasure_admission_policy_count ?? 0),
      },
    };
    return { byKey, byNamespace };
  } catch (cause) {
    return onStorageUnavailable(cause);
  }
}

const INITIALIZATION_KEYS = [
  "source_namespace_id", "principal_ref", "credential_generation", "profile_id", "profile_revision", "title", "idempotency_key",
  "owner_incarnation_ref", "source_owner_generation", "ownership_record_revision", "source_admission_policy_revision", "scope_policy_ref",
  "scope_policy_generation", "request_sha256", "created_at",
] as const;
const OWNER_KEYS = [
  "source_namespace_id", "ownership_record_revision", "owner_system_id", "owner_incarnation_ref", "source_owner_generation",
  "source_admission_policy_revision", "status", "cutover_receipt_ref", "created_at",
] as const;
const POLICY_KEYS = [
  "source_namespace_id", "revision", "authorized_principal_refs_json", "allowed_ownership_modes_json", "source_class", "assurance_ceiling",
  "instruction_taint", "allowed_effects", "allowed_use_json", "disclosure_ceiling", "license_policy_ref", "default_storage_policy",
  "default_residency_profile_id", "default_retention_policy_id", "minimum_quality_state", "created_at",
] as const;
const SCOPE_KEYS = [
  "source_namespace_id", "principal_ref", "client_class", "policy_ref", "generation", "allowed_use_json", "disclosure_ceiling", "state", "expires_at", "created_at",
] as const;

function exactObject(row: Record<string, unknown> | null, target: object, keys: readonly string[]): boolean {
  const candidate = target as Record<string, unknown>;
  return row !== null && keys.every((key) => row[key] === candidate[key]);
}

export function namespaceStateMatches(state: NamespaceState, target: NamespaceStateTarget): boolean {
  return state.counts.initialization === 1 && state.counts.owner === 1 && state.counts.policy === 1 && state.counts.scope === 1 &&
    state.counts.erasure_admission_policy === (target.erasure_admission_policy === undefined ? 0 : 1) &&
    exactObject(state.initialization, target.initialization, INITIALIZATION_KEYS) &&
    exactObject(state.owner, target.owner, OWNER_KEYS) &&
    exactObject(state.policy, target.policy, POLICY_KEYS) &&
    exactObject(state.scope, target.scope, SCOPE_KEYS) &&
    namespaceErasureAdmissionMatches(state.erasure_admission_policy, target.erasure_admission_policy);
}

export function hasAnyNamespaceState(state: NamespaceState): boolean {
  return Object.values(state.counts).some((count) => count !== 0);
}
