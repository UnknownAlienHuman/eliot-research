import { scopeExpressionAtoms } from "@eliotr/domain";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import type { ScopeSnapshot } from "@eliotr/contracts";
import type { ScopeService } from "./scope-service.js";
import { orientationFail } from "./orientation-input.js";

/** Request-local memoization, fenced by primary D1 mutation revision and the next temporal boundary.
 * Never shared across requests; every use still reads the fence. Per-artifact grant/source checks remain uncached.
 */
export function orientationCurrentness(db: D1Database, scopes: ScopeService, principal: string, now: () => number) {
  let cached: { identity: string; generation: number; checkedAt: number; validUntil: number } | undefined;
  async function generation(): Promise<number> {
    const row = await db.prepare("SELECT generation FROM orientation_authority_epoch WHERE singleton=1").first<{ generation: number }>();
    if (!row || !Number.isSafeInteger(row.generation) || row.generation < 1) orientationFail("ORIENTATION_AUTHORITY_UNAVAILABLE", 503);
    return row.generation;
  }
  return async (scope: ScopeSnapshot): Promise<ScopeSnapshot> => {
    const identity = canonicalEvidenceJson(scope); const start = now(); const before = await generation();
    const observed = now();
    if (!Number.isSafeInteger(start) || observed < start) orientationFail("ORIENTATION_AUTHORITY_CHANGED", 409, true);
    if (cached?.identity === identity && cached.generation === before && start >= cached.checkedAt && observed < cached.validUntil) return scope;
    // Read the time frontier BEFORE deep validation: a boundary crossed during validation must not be missed.
    const validUntil = await nextOrientationBoundary(db, principal, scope, start);
    const checked = await scopes.requireCurrent(scope);
    if (await generation() !== before || now() < start || now() >= validUntil) {
      cached = undefined; orientationFail("ORIENTATION_AUTHORITY_CHANGED", 409, true);
    }
    cached = { identity, generation: before, checkedAt: start, validUntil };
    return checked;
  };
}

export async function nextOrientationBoundary(db: D1Database, principal: string,
  scope: Pick<ScopeSnapshot, "resolved_scope_expression" | "member_source_revision_refs" | "expires_at">, instant: number): Promise<number> {
    const atoms = scopeExpressionAtoms(scope.resolved_scope_expression);
    const projects = atoms.flatMap((atom) => atom.kind === "PROJECT" ? [atom.project_id] : []);
    const tags = atoms.flatMap((atom) => atom.kind === "TAG" ? [atom.tag] : []);
    const scans = [
      ["scope_read_policy", "expires_at", "principal_ref=?1 AND state='ACTIVE'"],
      ["source_admission_decision", "expires_at", "source_revision_ref IN (SELECT value FROM json_each(?2))"],
      ["project_source_membership", "valid_from", "project_id IN (SELECT value FROM json_each(?3))"],
      ["project_source_membership", "valid_to", "project_id IN (SELECT value FROM json_each(?3))"],
      ["source_tag", "valid_from", "tag IN (SELECT value FROM json_each(?4))"],
      ["source_tag", "valid_to", "tag IN (SELECT value FROM json_each(?4))"],
    ] as const;
    // Scalar subqueries avoid D1's bounded compound-SELECT term limit. Order by instant, never text offsets.
    const query = "SELECT " + scans.map(([table, column, filter], index) =>
      `(SELECT ${column} FROM ${table} WHERE ${filter} AND julianday(${column})>julianday(?5) ` +
      `ORDER BY julianday(${column}) LIMIT 1) AS t${index}`).join(",");
    const result = await db.prepare(query).bind(principal, JSON.stringify(scope.member_source_revision_refs),
      JSON.stringify(projects), JSON.stringify(tags), new Date(instant).toISOString()).first<Record<string, string | null>>();
    if (!result || Object.keys(result).length !== scans.length) orientationFail("ORIENTATION_AUTHORITY_UNAVAILABLE", 503);
    const times = Object.values(result).map((at) => at === null ? Infinity : Date.parse(at));
    if (times.some(Number.isNaN)) orientationFail("ORIENTATION_AUTHORITY_UNAVAILABLE", 503);
    return Math.min(Date.parse(scope.expires_at), ...times);
  }
