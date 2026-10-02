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
  SELECT s.snapshot_id,s.revision,s.created_at,s.policy_authority_ref,s.client_fence_ref,
    b.receipt_sequence AS receipt_floor
  FROM scope_snapshot s JOIN scope_read_policy_history_event b
    ON b.snapshot_id=s.snapshot_id AND b.snapshot_revision=s.revision AND b.event_kind='SNAPSHOT_BASELINE'
  WHERE s.snapshot_id=?1 AND s.revision=?2
), owner_grants AS (
  SELECT COUNT(g.snapshot_id) AS grant_count,MIN(g.credential_generation) AS credential_generation,
    MIN(g.policy_authority_ref) AS policy_authority_ref
  FROM snapshot s LEFT JOIN scope_access_grant g ON g.snapshot_id=s.snapshot_id
    AND g.snapshot_revision=s.revision AND g.principal_ref=?3 AND g.client_class='owner_pwa'
    AND g.project_client_grant_id IS NULL
), events AS (
  SELECT e.* FROM scope_read_policy_history_event e
  WHERE e.snapshot_id=?1 AND e.snapshot_revision=?2 AND e.event_kind<>'SNAPSHOT_BASELINE'
), sequenced AS (
  SELECT e.*,
    LAG(new_source_namespace_id) OVER w AS previous_namespace,
    LAG(new_principal_ref) OVER w AS previous_principal,
    LAG(new_policy_ref) OVER w AS previous_policy,
    LAG(new_generation) OVER w AS previous_generation,
    LAG(new_allowed_use_json) OVER w AS previous_allowed_use,
    LAG(new_disclosure_ceiling) OVER w AS previous_disclosure,
    LAG(new_state) OVER w AS previous_state,
    LAG(new_expires_at) OVER w AS previous_expiry,
    LAG(new_created_at) OVER w AS previous_created_at,
    ROW_NUMBER() OVER w AS chain_position,
    COUNT(*) OVER w AS chain_length
  FROM events e
  WHERE event_kind='LEASE_REFRESH'
  WINDOW w AS (PARTITION BY old_source_namespace_id,old_principal_ref,old_policy_ref ORDER BY receipt_sequence)
), checked AS (
  SELECT s.*,
    SUM(CASE WHEN chain_position>1 AND (
      old_source_namespace_id IS NOT previous_namespace OR old_principal_ref IS NOT previous_principal OR
      old_policy_ref IS NOT previous_policy OR old_generation IS NOT previous_generation OR
      old_allowed_use_json IS NOT previous_allowed_use OR old_disclosure_ceiling IS NOT previous_disclosure OR
      old_state IS NOT previous_state OR old_expires_at IS NOT previous_expiry OR old_created_at IS NOT previous_created_at
    ) THEN 1 ELSE 0 END) OVER(
      PARTITION BY old_source_namespace_id,old_principal_ref,old_policy_ref
    ) AS chain_gaps,
    FIRST_VALUE(old_generation) OVER(
      PARTITION BY old_source_namespace_id,old_principal_ref,old_policy_ref ORDER BY receipt_sequence
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS baseline_generation,
    FIRST_VALUE(old_allowed_use_json) OVER(
      PARTITION BY old_source_namespace_id,old_principal_ref,old_policy_ref ORDER BY receipt_sequence
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS baseline_allowed_use,
    FIRST_VALUE(old_disclosure_ceiling) OVER(
      PARTITION BY old_source_namespace_id,old_principal_ref,old_policy_ref ORDER BY receipt_sequence
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS baseline_disclosure,
    FIRST_VALUE(old_expires_at) OVER(
      PARTITION BY old_source_namespace_id,old_principal_ref,old_policy_ref ORDER BY receipt_sequence
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS baseline_expiry,
    LAST_VALUE(new_generation) OVER(
      PARTITION BY old_source_namespace_id,old_principal_ref,old_policy_ref ORDER BY receipt_sequence
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS endpoint_generation,
    LAST_VALUE(new_allowed_use_json) OVER(
      PARTITION BY old_source_namespace_id,old_principal_ref,old_policy_ref ORDER BY receipt_sequence
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS endpoint_allowed_use,
    LAST_VALUE(new_disclosure_ceiling) OVER(
      PARTITION BY old_source_namespace_id,old_principal_ref,old_policy_ref ORDER BY receipt_sequence
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS endpoint_disclosure,
    LAST_VALUE(new_state) OVER(
      PARTITION BY old_source_namespace_id,old_principal_ref,old_policy_ref ORDER BY event_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS endpoint_state,
    LAST_VALUE(new_expires_at) OVER(
      PARTITION BY old_source_namespace_id,old_principal_ref,old_policy_ref ORDER BY event_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS endpoint_expiry,
    LAST_VALUE(new_created_at) OVER(
      PARTITION BY old_source_namespace_id,old_principal_ref,old_policy_ref ORDER BY event_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS endpoint_created_at,
    MAX(chain_length) OVER(
      PARTITION BY old_source_namespace_id,old_principal_ref,old_policy_ref
    ) AS transition_count
  FROM sequenced s
), chains AS (
  SELECT old_source_namespace_id AS source_namespace_id, old_principal_ref AS principal_ref,
    old_policy_ref AS policy_ref, baseline_generation, baseline_allowed_use, baseline_disclosure,
    baseline_expiry, endpoint_generation, endpoint_allowed_use, endpoint_disclosure,
    endpoint_state, endpoint_expiry, endpoint_created_at, chain_gaps, transition_count
  FROM checked WHERE chain_position=1
), current_policies AS (
  SELECT p.source_namespace_id,p.policy_ref,p.generation,p.allowed_use_json,p.disclosure_ceiling,
    p.state,p.expires_at,p.created_at,COUNT(*) OVER() AS policy_count,
    ROW_NUMBER() OVER(ORDER BY p.source_namespace_id) AS policy_position
  FROM scope_read_policy p
  WHERE p.principal_ref=?3 AND p.client_class='owner_pwa' AND p.state='ACTIVE'
    AND julianday(p.expires_at)>julianday(?4)
), proof AS (
  SELECT CASE WHEN
    NOT EXISTS(SELECT 1 FROM snapshot) OR
    (SELECT COUNT(*) FROM current_policies)=0 OR
    COALESCE((SELECT MAX(policy_count) FROM current_policies),0)>4096 OR
    (?5=1 AND (
      COALESCE((SELECT grant_count FROM owner_grants),0)<>1 OR
      (SELECT policy_authority_ref FROM owner_grants) IS NOT (SELECT policy_authority_ref FROM snapshot) OR
      (SELECT credential_generation FROM owner_grants) IS NOT (SELECT client_fence_ref FROM snapshot)
    )) OR
    EXISTS(SELECT 1 FROM events WHERE event_kind<>'LEASE_REFRESH') OR
    EXISTS(
      SELECT 1 FROM events e
      WHERE e.event_kind='LEASE_REFRESH' AND NOT EXISTS(
        SELECT 1 FROM scope_read_policy_lease_refresh_receipt r
        JOIN source_namespace_initialization i ON i.source_namespace_id=r.source_namespace_id
          AND i.principal_ref=r.principal_ref AND i.ownership_record_revision=r.ownership_record_revision
          AND i.owner_incarnation_ref=r.owner_incarnation_ref AND i.source_owner_generation=r.source_owner_generation
          AND i.source_admission_policy_revision=r.source_admission_policy_revision AND i.scope_policy_ref=r.policy_ref
        JOIN source_namespace_ownership o ON o.source_namespace_id=i.source_namespace_id
          AND o.ownership_record_revision=i.ownership_record_revision
          AND o.owner_incarnation_ref=i.owner_incarnation_ref AND o.source_owner_generation=i.source_owner_generation
          AND o.source_admission_policy_revision=i.source_admission_policy_revision
        JOIN source_admission_policy a ON a.source_namespace_id=i.source_namespace_id
          AND a.revision=i.source_admission_policy_revision
        WHERE r.refresh_id=e.refresh_id AND r.state='APPLIED' AND r.client_class='owner_pwa'
          AND r.source_namespace_id=e.old_source_namespace_id AND r.principal_ref=e.old_principal_ref
          AND r.policy_ref=e.old_policy_ref AND r.old_generation=e.old_generation
          AND r.new_generation=e.new_generation AND r.old_allowed_use_json=e.old_allowed_use_json
          AND r.old_disclosure_ceiling=e.old_disclosure_ceiling AND r.old_expires_at=e.old_expires_at
          AND r.new_expires_at=e.new_expires_at AND r.access_expires_at=e.new_expires_at
          AND e.old_state='ACTIVE' AND e.new_state='ACTIVE'
          AND e.new_source_namespace_id=e.old_source_namespace_id AND e.new_principal_ref=e.old_principal_ref
          AND e.new_policy_ref=e.old_policy_ref AND e.new_allowed_use_json=e.old_allowed_use_json
          AND e.new_disclosure_ceiling=e.old_disclosure_ceiling AND e.new_created_at=e.old_created_at
          AND o.owner_system_id='eliotr' AND o.status='ACTIVE'
          AND a.instruction_taint='DATA_ONLY' AND a.allowed_effects='READ_ONLY'
          AND a.disclosure_ceiling=e.old_disclosure_ceiling
          AND EXISTS(SELECT 1 FROM json_each(a.authorized_principal_refs_json) WHERE value=e.old_principal_ref)
          AND EXISTS(SELECT 1 FROM json_each(a.allowed_ownership_modes_json) WHERE value='immutable_import')
          AND EXISTS(SELECT 1 FROM json_each(a.allowed_use_json) WHERE value='research')
          AND NOT EXISTS(SELECT 1 FROM json_each(e.old_allowed_use_json) u
            WHERE NOT EXISTS(SELECT 1 FROM json_each(a.allowed_use_json) x WHERE x.value=u.value))
      )
    ) OR
    EXISTS(
      SELECT 1 FROM chains c LEFT JOIN current_policies p
        ON p.source_namespace_id=c.source_namespace_id
      WHERE p.source_namespace_id IS NULL OR c.principal_ref<>?3 OR c.chain_gaps<>0 OR
        p.policy_ref<>c.policy_ref OR p.generation<>c.endpoint_generation OR
        p.allowed_use_json<>c.endpoint_allowed_use OR p.disclosure_ceiling<>c.endpoint_disclosure OR
        p.state<>'ACTIVE' OR p.expires_at<>c.endpoint_expiry OR p.created_at<>c.endpoint_created_at OR
        c.endpoint_state<>'ACTIVE'
    ) OR
    EXISTS(
      SELECT 1 FROM scope_read_policy_lease_refresh_receipt r, snapshot s
      WHERE r.principal_ref=?3 AND r.client_class='owner_pwa' AND r.state='APPLIED'
        AND r.receipt_sequence>s.receipt_floor AND NOT EXISTS(
          SELECT 1 FROM events e WHERE e.refresh_id=r.refresh_id AND e.event_kind='LEASE_REFRESH'
        )
    ) OR
    EXISTS(
      SELECT 1 FROM scope_read_policy_lease_refresh_receipt r, snapshot s
      WHERE r.principal_ref=?3 AND r.client_class='owner_pwa' AND r.state='PREPARED'
    )
    THEN 0 ELSE 1 END AS valid,
    CASE WHEN EXISTS(SELECT 1 FROM events WHERE event_kind='LEASE_REFRESH') THEN 1 ELSE 0 END AS has_lease_events,
    CASE WHEN ?5=1 THEN (SELECT credential_generation FROM owner_grants) ELSE NULL END AS original_credential_generation
), bounded_policies AS (
  SELECT p.*,c.baseline_generation,c.baseline_allowed_use,c.baseline_disclosure,c.baseline_expiry
  FROM current_policies p LEFT JOIN chains c ON c.source_namespace_id=p.source_namespace_id
  WHERE p.policy_position<=4096
)
SELECT 0 AS row_kind,proof.valid,proof.has_lease_events,
  NULL AS source_namespace_id,NULL AS policy_ref,NULL AS generation,NULL AS allowed_use_json,
  NULL AS disclosure_ceiling,NULL AS expires_at,proof.original_credential_generation
FROM proof
UNION ALL
SELECT 1 AS row_kind,proof.valid,proof.has_lease_events,p.source_namespace_id,p.policy_ref,
  COALESCE(p.baseline_generation,p.generation) AS generation,
  COALESCE(p.baseline_allowed_use,p.allowed_use_json) AS allowed_use_json,
  COALESCE(p.baseline_disclosure,p.disclosure_ceiling) AS disclosure_ceiling,
  COALESCE(p.baseline_expiry,p.expires_at) AS expires_at,NULL AS original_credential_generation
FROM bounded_policies p CROSS JOIN proof
ORDER BY row_kind,source_namespace_id
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
 * One D1 statement proves the complete per-snapshot lease chain. Window scans
 * cover every immutable event, while only current policy rows (max 4096) cross
 * the Worker boundary; there is no renewal-count cap or history paging loop.
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
