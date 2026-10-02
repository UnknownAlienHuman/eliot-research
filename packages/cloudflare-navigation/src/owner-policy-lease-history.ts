import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import type { ScopeSnapshot } from "@eliotr/contracts";
import type { EvidenceSourceAuthority } from "@eliotr/cloudflare-evidence";
import type { SourceRevision } from "@eliotr/contracts";
import type { OrientationSource } from "./orientation-authority.js";
import { memberPolicyClosureGeneration } from "./scope-service.js";

const MAX_OWNER_POLICIES = 4096;

export interface HistoricalPolicyRow {
  readonly source_namespace_id: string;
  readonly policy_ref: string;
  readonly generation: number;
  readonly allowed_use_json: string;
  readonly disclosure_ceiling: string;
  readonly expires_at: string;
}

export interface OwnerPolicyLeaseHistoryProof {
  readonly has_lease_events: boolean;
  readonly baseline_policies: readonly HistoricalPolicyRow[];
  readonly original_access: HistoricalOwnerAccess | null;
}

export interface HistoricalOwnerAccess {
  readonly principal_ref: string;
  readonly client_class: "owner_pwa";
  readonly credential_generation: string;
}

interface ProofRow {
  readonly row_kind: unknown;
  readonly valid: unknown;
  readonly has_lease_events: unknown;
  readonly source_namespace_id: unknown;
  readonly policy_ref: unknown;
  readonly generation: unknown;
  readonly allowed_use_json: unknown;
  readonly disclosure_ceiling: unknown;
  readonly expires_at: unknown;
  readonly original_credential_generation: unknown;
}

const PROOF_SQL = `
WITH snapshot AS (
  SELECT s.*,b.history_event_sequence_floor,b.receipt_sequence_floor,b.pre_migration_semantic
  FROM scope_snapshot s JOIN scope_read_policy_snapshot_baseline b ON b.snapshot_id=s.snapshot_id AND b.snapshot_revision=s.revision
  WHERE s.snapshot_id=?1 AND s.revision=?2
), owner_grants AS (
  SELECT COUNT(*) AS grant_count,MIN(credential_generation) AS credential_generation,MIN(policy_authority_ref) AS policy_authority_ref
  FROM scope_access_grant WHERE snapshot_id=?1 AND snapshot_revision=?2 AND principal_ref=?3
    AND client_class='owner_pwa' AND project_client_grant_id IS NULL
), reconstructed AS MATERIALIZED (
  SELECT i.source_namespace_id,i.semantic_sequence,s.history_event_sequence_floor,
    f.history_event_sequence AS first_sequence,f.event_kind AS first_kind,f.receipt_sequence AS first_receipt,
    s.receipt_sequence_floor,CASE WHEN f.history_event_sequence IS NULL THEN p.policy_ref ELSE f.old_policy_ref END AS baseline_policy_ref,
    CASE WHEN f.history_event_sequence IS NULL THEN p.generation ELSE f.old_generation END AS baseline_generation,
    CASE WHEN f.history_event_sequence IS NULL THEN p.allowed_use_json ELSE f.old_allowed_use_json END AS baseline_allowed_use_json,
    CASE WHEN f.history_event_sequence IS NULL THEN p.disclosure_ceiling ELSE f.old_disclosure_ceiling END AS baseline_disclosure_ceiling,
    CASE WHEN f.history_event_sequence IS NULL THEN p.state ELSE f.old_state END AS baseline_state,
    CASE WHEN f.history_event_sequence IS NULL THEN p.expires_at ELSE f.old_expires_at END AS baseline_expires_at,
    CASE WHEN f.history_event_sequence IS NULL THEN p.created_at ELSE f.old_created_at END AS baseline_created_at,
    CASE WHEN l.history_event_sequence>s.history_event_sequence_floor AND (p.policy_ref IS NOT l.new_policy_ref OR p.generation IS NOT l.new_generation OR p.allowed_use_json IS NOT l.new_allowed_use_json OR p.disclosure_ceiling IS NOT l.new_disclosure_ceiling OR p.state IS NOT l.new_state OR p.expires_at IS NOT l.new_expires_at OR p.created_at IS NOT l.new_created_at) THEN 1 ELSE 0 END AS endpoint_drift
  FROM scope_read_policy_identity i CROSS JOIN snapshot s
  LEFT JOIN scope_read_policy p ON p.source_namespace_id=i.source_namespace_id AND p.principal_ref=i.principal_ref AND p.client_class=i.client_class
  LEFT JOIN scope_read_policy_history_event f ON f.history_event_sequence=(
    SELECT e.history_event_sequence FROM scope_read_policy_history_event e
    WHERE e.principal_ref=i.principal_ref AND e.client_class=i.client_class AND e.source_namespace_id=i.source_namespace_id
      AND e.history_event_sequence>s.history_event_sequence_floor ORDER BY e.history_event_sequence LIMIT 1)
  LEFT JOIN scope_read_policy_history_event l ON l.history_event_sequence=i.last_event_sequence
  WHERE i.principal_ref=?3 AND i.client_class='owner_pwa' AND i.birth_sequence<=s.history_event_sequence_floor
), policies AS MATERIALIZED (
  SELECT r.* FROM reconstructed r CROSS JOIN snapshot s WHERE r.baseline_state='ACTIVE'
    AND julianday(r.baseline_created_at)<=julianday(s.created_at) AND julianday(s.created_at)<julianday(r.baseline_expires_at)
), proof AS (
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM snapshot) OR EXISTS(SELECT 1 FROM snapshot WHERE pre_migration_semantic=1)
    OR (SELECT COUNT(*) FROM policies)>4096
    OR (?5=1 AND ((SELECT grant_count FROM owner_grants)<>1
      OR (SELECT policy_authority_ref FROM owner_grants) IS NOT (SELECT policy_authority_ref FROM snapshot)
      OR (SELECT credential_generation FROM owner_grants) IS NOT (SELECT client_fence_ref FROM snapshot)))
    OR EXISTS(SELECT 1 FROM policies WHERE semantic_sequence>history_event_sequence_floor OR endpoint_drift=1
      OR (first_kind='LEASE_REFRESH' AND first_receipt<=receipt_sequence_floor))
    OR EXISTS(SELECT 1 FROM scope_read_policy_lease_refresh_receipt WHERE principal_ref=?3 AND client_class='owner_pwa' AND state='PREPARED')
    THEN 0 ELSE 1 END AS valid,
    CASE WHEN EXISTS(SELECT 1 FROM policies WHERE first_kind='LEASE_REFRESH') THEN 1 ELSE 0 END AS has_lease_events,
    CASE WHEN ?5=1 THEN (SELECT credential_generation FROM owner_grants) ELSE NULL END AS original_credential_generation
)
SELECT 0 AS row_kind,valid,has_lease_events,NULL AS source_namespace_id,NULL AS policy_ref,NULL AS generation,
  NULL AS allowed_use_json,NULL AS disclosure_ceiling,NULL AS expires_at,original_credential_generation FROM proof
UNION ALL
SELECT 1 AS row_kind,proof.valid,proof.has_lease_events,p.source_namespace_id,p.baseline_policy_ref,p.baseline_generation,
  p.baseline_allowed_use_json,p.baseline_disclosure_ceiling,p.baseline_expires_at,NULL FROM policies p CROSS JOIN proof
ORDER BY row_kind,source_namespace_id LIMIT 4097
`;

function validPolicyRow(row: ProofRow): row is ProofRow & {
  readonly source_namespace_id: string;
  readonly policy_ref: string;
  readonly generation: number;
  readonly allowed_use_json: string;
  readonly disclosure_ceiling: string;
  readonly expires_at: string;
} {
  if (typeof row.source_namespace_id !== "string" || row.source_namespace_id.length === 0 ||
      typeof row.policy_ref !== "string" || row.policy_ref.length === 0 ||
      typeof row.generation !== "number" || !Number.isSafeInteger(row.generation) || row.generation < 1 ||
      typeof row.allowed_use_json !== "string" || typeof row.disclosure_ceiling !== "string" ||
      typeof row.expires_at !== "string") return false;
  try {
    const uses: unknown = JSON.parse(row.allowed_use_json);
    if (!Array.isArray(uses) || uses.some((value) => typeof value !== "string") ||
        canonicalEvidenceJson(uses) !== row.allowed_use_json) return false;
    const expires = Date.parse(row.expires_at);
    return Number.isSafeInteger(expires) && new Date(expires).toISOString() === row.expires_at;
  } catch (_error) { return false; }
}

/**
 * One D1 statement reconstructs policies at snapshot capture using indexed
 * first-transition and endpoint seeks. Renewals do not scan or copy all history.
 */
export async function readOwnerPolicyLeaseHistory(input: {
  readonly database: D1Database;
  readonly snapshot_id: string;
  readonly snapshot_revision: number;
  readonly principal_ref: string;
  readonly now: string;
  readonly allow_lease_refresh: boolean;
}): Promise<OwnerPolicyLeaseHistoryProof | null> {
  let result: D1Result<ProofRow>;
  try {
    result = await input.database.prepare(PROOF_SQL)
      .bind(input.snapshot_id, input.snapshot_revision, input.principal_ref, input.now,
        input.allow_lease_refresh ? 1 : 0).all<ProofRow>();
  } catch (_error) { return null; }
  if (!result.success || !Array.isArray(result.results) || result.results.length < 1 ||
      result.results.length > MAX_OWNER_POLICIES + 1) return null;
  const status = result.results.filter((row) => row.row_kind === 0);
  const rows = result.results.filter((row) => row.row_kind === 1);
  if (status.length !== 1 || status[0]?.valid !== 1 ||
      (status[0]?.has_lease_events !== 0 && status[0]?.has_lease_events !== 1) ||
      rows.some((row) => row.valid !== 1 || !validPolicyRow(row))) return null;
  const policies: HistoricalPolicyRow[] = [];
  for (const row of rows) {
    if (!validPolicyRow(row)) return null;
    policies.push({ source_namespace_id: row.source_namespace_id,
      policy_ref: row.policy_ref, generation: row.generation, allowed_use_json: row.allowed_use_json,
      disclosure_ceiling: row.disclosure_ceiling, expires_at: row.expires_at });
  }
  if (new Set(policies.map((policy) => policy.source_namespace_id)).size !== policies.length) return null;
  const credential = status[0]?.original_credential_generation;
  if (input.allow_lease_refresh && (typeof credential !== "string" || credential.length === 0)) return null;
  const original_access: HistoricalOwnerAccess | null = input.allow_lease_refresh
    ? { principal_ref: input.principal_ref, client_class: "owner_pwa", credential_generation: credential as string }
    : null;
  return { has_lease_events: status[0]?.has_lease_events === 1,
    baseline_policies: policies, original_access };
}

/** Preserve the exact existing read-source policy hash payload. */
export async function historicalPolicyClosureRef(input: {
  readonly policy: HistoricalPolicyRow;
  readonly authority: EvidenceSourceAuthority;
  readonly revision: SourceRevision;
  readonly title: string;
  readonly kind: string;
}): Promise<string> {
  return `read-${await evidenceSha256({ policy: input.policy, authority: input.authority,
    revision: input.revision, title: input.title, kind: input.kind })}`;
}

/** Reuse the exact full owner policy-authority payload used by orientation freeze. */
export async function historicalPolicyAuthorityRef(input: {
  readonly access: HistoricalOwnerAccess;
  readonly policies: readonly HistoricalPolicyRow[];
  readonly members: readonly string[];
}): Promise<string> {
  const policies = [...input.policies].sort((left, right) =>
    left.source_namespace_id < right.source_namespace_id ? -1 : left.source_namespace_id > right.source_namespace_id ? 1 : 0);
  return `policy-${await evidenceSha256({ access: input.access, policies, members: input.members })}`;
}

/** Reconstruct original member and full policy hashes without altering stored bytes. */
export async function matchesHistoricalOwnerPolicyAuthority(input: {
  readonly original: ScopeSnapshot;
  readonly sources: readonly OrientationSource[];
  readonly baseline_policies: readonly HistoricalPolicyRow[];
  readonly access: HistoricalOwnerAccess;
}): Promise<boolean> {
  const policies = new Map(input.baseline_policies.map((policy) => [policy.source_namespace_id, policy]));
  const memberClosures: Record<string, string> = {};
  for (const source of input.sources) {
    const baseline = policies.get(source.revision.source_namespace_id);
    if (baseline === undefined) return false;
    memberClosures[source.revision.source_revision_ref] = await historicalPolicyClosureRef({ policy: baseline,
      authority: source.authority, revision: source.revision, title: source.title, kind: source.kind });
  }
  const expected = input.original.participant_generations["member-policy-closure"];
  if (expected === undefined || await memberPolicyClosureGeneration(memberClosures) !== expected) return false;
  const policyAuthorityRef = await historicalPolicyAuthorityRef({ access: input.access,
    policies: input.baseline_policies,
    members: input.sources.map((source) => memberClosures[source.revision.source_revision_ref]!) });
  return policyAuthorityRef === input.original.policy_authority_ref;
}
