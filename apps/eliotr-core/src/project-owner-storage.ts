import { MAX_SOURCE_IDS, fail } from "@eliotr/cloudflare-navigation/project-owner-contract.js";
import type { MembershipRow } from "@eliotr/cloudflare-navigation/project-owner-contract.js";
function balancedAnd(predicates: readonly string[]): string {
  let level = [...predicates];
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      if (left === undefined) continue;
      const right = level[index + 1];
      next.push(right === undefined ? left : `(${left} AND ${right})`);
    }
    level = next;
  }
  return level[0] ?? "1";
}

export function currentSourcePredicate(principal: string, observed: string): string {
  return balancedAnd([
    "r.source_revision_ref=s.head_rev",
    "r.purge_state='LIVE'",
    "o.source_namespace_id=s.source_namespace_id",
    "o.status='ACTIVE'",
    "o.owner_system_id=s.source_owner_system_id",
    "o.source_owner_generation=s.source_owner_generation",
    "r.source_owner_generation=s.source_owner_generation",
    "ap.source_namespace_id=o.source_namespace_id",
    "ap.revision=o.source_admission_policy_revision",
    "json_type(ap.allowed_use_json)='array'",
    "json_type(ap.allowed_ownership_modes_json)='array'",
    "EXISTS (SELECT 1 FROM json_each(ap.allowed_use_json) WHERE json_each.value='research')",
    "EXISTS (SELECT 1 FROM json_each(ap.allowed_ownership_modes_json) WHERE json_each.value=s.ownership_mode)",
    "d.source_revision_ref=r.source_revision_ref",
    "d.decision='ADMITTED'",
    "d.decision_receipt_ref=(SELECT chosen.decision_receipt_ref FROM source_admission_decision chosen " +
      "WHERE chosen.source_revision_ref=r.source_revision_ref AND chosen.decision='ADMITTED' " +
      "ORDER BY chosen.created_at DESC, chosen.decision_receipt_ref DESC LIMIT 1)",
    "d.owner_system_id=o.owner_system_id",
    "d.source_namespace_id=s.source_namespace_id",
    "d.source_owner_generation=s.source_owner_generation",
    "d.source_class=ap.source_class",
    "(d.expires_at IS NULL OR julianday(d.expires_at)>julianday(" + observed + "))",
    "d.disclosure_ceiling=rp.disclosure_ceiling",
    "json_type(d.allowed_use_json)='array'",
    "json_type(rp.allowed_use_json)='array'",
    "EXISTS (SELECT 1 FROM json_each(d.allowed_use_json) WHERE json_each.value='research')",
    "NOT EXISTS (SELECT 1 FROM json_each(d.allowed_use_json) used " +
      "WHERE NOT EXISTS (SELECT 1 FROM json_each(rp.allowed_use_json) permitted WHERE permitted.value=used.value))",
    "rp.source_namespace_id=s.source_namespace_id",
    "rp.principal_ref=" + principal,
    "rp.client_class='owner_pwa'",
    "rp.state='ACTIVE'",
    "julianday(rp.expires_at)>julianday(" + observed + ")",
  ]);
}

export function currentMembershipsReadableGuard(): string {
  // Keep the authority predicate in the sibling CTE. Referencing its result
  // here avoids nesting the full JSON/admission policy expression below the
  // project UPDATE, which exceeds D1's expression-depth limit.
  return "NOT EXISTS (SELECT 1 FROM project_source_membership old " +
    "WHERE old.project_id=?1 AND old.valid_to IS NULL " +
    "AND NOT EXISTS (SELECT 1 FROM current_readable_sources readable " +
    "WHERE readable.source_id=old.source_id))";
}

export function eligibleSourceCte(sourceJson: string, principal: string, observed: string, projectId?: string): string {
  // Factor the complete authority/readability predicate once. The
  // mutation statements only join this bounded projection, keeping their
  // nested expression depth below the Cloudflare D1 limit.
  const projectCandidates = projectId === undefined ? "NULL" : projectId;
  return `WITH requested AS (SELECT value AS source_id FROM json_each(${sourceJson})), candidate_source_ids AS (` +
    "SELECT source_id FROM requested UNION SELECT old.source_id FROM project_source_membership old " +
    `WHERE old.project_id=${projectCandidates} AND old.valid_to IS NULL), current_readable_sources AS (` +
    "SELECT DISTINCT s.source_id FROM candidate_source_ids candidate " +
    "JOIN source s ON s.source_id=candidate.source_id " +
    "JOIN source_revision r ON r.source_id=s.source_id " +
    "JOIN source_namespace_ownership o ON o.source_namespace_id=s.source_namespace_id " +
    "JOIN source_admission_policy ap ON ap.source_namespace_id=o.source_namespace_id " +
    "JOIN source_admission_decision d ON d.source_revision_ref=r.source_revision_ref " +
    "JOIN scope_read_policy rp ON rp.source_namespace_id=s.source_namespace_id " +
    `WHERE ${currentSourcePredicate(principal, observed)}), eligible AS (` +
    "SELECT DISTINCT q.source_id FROM requested q JOIN current_readable_sources readable " +
    "ON readable.source_id=q.source_id)";
}

function sourceReadJoins(principal: string, observed: string): string {
  return "JOIN source s ON s.source_id=m.source_id " +
    "JOIN source_revision r ON r.source_id=s.source_id " +
    "JOIN source_namespace_ownership o ON o.source_namespace_id=s.source_namespace_id " +
    "JOIN source_admission_policy ap ON ap.source_namespace_id=o.source_namespace_id " +
    "JOIN source_admission_decision d ON d.source_revision_ref=r.source_revision_ref " +
    "JOIN scope_read_policy rp ON rp.source_namespace_id=s.source_namespace_id " +
    `WHERE ${currentSourcePredicate(principal, observed)}`;
}

export async function readMembershipIds(database: D1Database, principal: string, projectIds: readonly string[], observed: string): Promise<readonly MembershipRow[]> {
  if (projectIds.length === 0) return [];
  const limit = projectIds.length * MAX_SOURCE_IDS + 1;
  let result: { readonly results?: readonly MembershipRow[] };
  try {
    result = await database.prepare(
      "SELECT DISTINCT m.project_id,m.source_id FROM project_source_membership m " +
      "JOIN project p ON p.project_id=m.project_id AND p.generation=m.membership_generation " + sourceReadJoins("?2", "?3") +
      " AND m.project_id IN (SELECT value FROM json_each(?1)) " +
      "AND m.valid_to IS NULL AND julianday(m.valid_from)<=julianday(?3) " +
      "ORDER BY m.project_id,m.source_id LIMIT ?4",
    ).bind(JSON.stringify(projectIds), principal, observed, limit).all<MembershipRow>();
  } catch (cause) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project memberships read is unavailable", true, cause);
  }
  if (!Array.isArray(result.results) || result.results.length >= limit) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project memberships exceed the bounded envelope", true);
  }
  return result.results;
}

export async function eligibleCount(database: D1Database, sourceIds: readonly string[], principal: string, observed: string): Promise<number> {
  const sourceJson = JSON.stringify(sourceIds);
  const cte = eligibleSourceCte("?1", "?2", "?3");
  let row: { readonly requested_count: unknown; readonly eligible_count: unknown } | null;
  try {
    row = await database.prepare(`${cte} SELECT (SELECT COUNT(*) FROM requested) AS requested_count,COUNT(*) AS eligible_count FROM eligible`)
      .bind(sourceJson, principal, observed).first<{ requested_count: unknown; eligible_count: unknown }>();
  } catch (cause) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "source authority read is unavailable", true, cause);
  }
  if (row === null || !Number.isSafeInteger(row.requested_count) || !Number.isSafeInteger(row.eligible_count) ||
      Number(row.requested_count) !== sourceIds.length || Number(row.eligible_count) < 0 || Number(row.eligible_count) > sourceIds.length) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "source authority returned an invalid count", true);
  }
  return Number(row.eligible_count);
}
