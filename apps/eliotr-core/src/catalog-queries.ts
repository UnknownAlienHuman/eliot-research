/** SQL prefilters only narrow candidates. Shared source/read-policy decoding remains authoritative. */
export const catalogEligibility = (history = false) => `WITH eligible AS (
 SELECT s.source_id, s.head_rev, r.source_revision_ref,
   CASE WHEN length(CAST(s.title AS BLOB))<=4096 THEN s.title ELSE NULL END AS title
 FROM source s JOIN source_revision r ON r.source_id=s.source_id ${history ? "" : "AND r.source_revision_ref=s.head_rev"}
 JOIN source_namespace_ownership o ON o.source_namespace_id=s.source_namespace_id AND o.status='ACTIVE'
   AND o.owner_system_id=s.source_owner_system_id AND o.source_owner_generation=r.source_owner_generation
   AND s.source_owner_generation=r.source_owner_generation
 JOIN scope_read_policy p ON p.source_namespace_id=s.source_namespace_id AND p.principal_ref=?1
   AND p.client_class='owner_pwa' AND p.state='ACTIVE' AND julianday(p.expires_at)>julianday(?2)
 JOIN source_admission_decision d ON d.source_revision_ref=r.source_revision_ref AND d.decision='ADMITTED'
   AND d.decision_receipt_ref=(SELECT chosen.decision_receipt_ref FROM source_admission_decision chosen
     WHERE chosen.source_revision_ref=r.source_revision_ref AND chosen.decision='ADMITTED'
     ORDER BY chosen.created_at DESC, chosen.decision_receipt_ref DESC LIMIT 1)
 WHERE r.purge_state = 'LIVE' AND d.owner_system_id=o.owner_system_id
   AND d.source_namespace_id=s.source_namespace_id AND d.source_owner_generation=r.source_owner_generation
   AND (d.expires_at IS NULL OR julianday(d.expires_at)>julianday(?2))
   AND d.disclosure_ceiling=p.disclosure_ceiling
   AND json_type(p.allowed_use_json)='array' AND json_type(d.allowed_use_json)='array'
   AND EXISTS (SELECT 1 FROM json_each(p.allowed_use_json) WHERE value='research')
   AND EXISTS (SELECT 1 FROM json_each(d.allowed_use_json) WHERE value='research')
   AND NOT EXISTS (SELECT 1 FROM json_each(d.allowed_use_json) a
     WHERE NOT EXISTS (SELECT 1 FROM json_each(p.allowed_use_json) b WHERE b.value=a.value))
)`;
const eligible = catalogEligibility();
const membership = "julianday(m.valid_from)<=julianday(?2) AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday(?2))";

export function catalogStatements(db: D1Database, input: {
  principal: string; observed: string; project: string | null; projectAfter: string; sourceAfter: string; limit: number;
}): D1PreparedStatement[] {
  const projects = db.prepare(`${eligible}, visible_projects AS (
    SELECT p.project_id AS id,
      CASE WHEN length(CAST(p.title AS BLOB))<=4096 THEN p.title ELSE NULL END AS title, p.generation,
      (SELECT e.head_rev FROM eligible e JOIN project_source_membership m ON m.source_id=e.source_id
       WHERE m.project_id=p.project_id AND ${membership} ORDER BY e.source_id LIMIT 1) AS witness_revision
    FROM project p WHERE (?3 IS NULL OR p.project_id=?3) AND p.project_id>?4
  ) SELECT * FROM visible_projects WHERE witness_revision IS NOT NULL ORDER BY id LIMIT ?5`)
    .bind(input.principal, input.observed, input.project, input.projectAfter, input.limit);
  const sources = db.prepare(`${eligible} SELECT e.source_id AS id, e.title, e.head_rev FROM eligible e
    WHERE e.source_id>?4 AND (?3 IS NULL OR EXISTS (SELECT 1 FROM project_source_membership m
      WHERE m.source_id=e.source_id AND m.project_id=?3 AND ${membership})) ORDER BY e.source_id LIMIT ?5`)
    .bind(input.principal, input.observed, input.project, input.sourceAfter, input.limit);
  return [projects, sources];
}

export async function catalogTimeFrontier(db: D1Database, principal: string, instant: number): Promise<number> {
  const row = await db.prepare(`SELECT
    (SELECT MIN(julianday(expires_at)) FROM scope_read_policy WHERE principal_ref=?1 AND state='ACTIVE'
      AND julianday(expires_at)>julianday(?2)) AS policy_expiry,
    (SELECT MIN(julianday(expires_at)) FROM source_admission_decision
      WHERE julianday(expires_at)>julianday(?2)) AS admission_expiry,
    (SELECT MIN(julianday(valid_from)) FROM project_source_membership
      WHERE julianday(valid_from)>julianday(?2)) AS membership_start,
    (SELECT MIN(julianday(valid_to)) FROM project_source_membership
      WHERE julianday(valid_to)>julianday(?2)) AS membership_end`)
    .bind(principal, new Date(instant).toISOString()).first<Record<string, number | null>>();
  if (!row || Object.keys(row).length !== 4 || Object.values(row).some((value) => value !== null &&
      (typeof value !== "number" || !Number.isFinite(value)))) throw new Error("Catalog time frontier unavailable");
  // SQLite Julian days are floating point. Round to milliseconds, then fail closed at the boundary.
  return Math.min(instant + 300_000, ...Object.values(row).map((value) => value === null ? Infinity :
    Math.round((value - 2440587.5) * 86400000)));
}
