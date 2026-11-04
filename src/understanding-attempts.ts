import { LibraryError } from "./library";
import type { UnderstandingClaim, DistillState } from "./understanding";

// Null identifies the original revision-scoped Workflow and artifacts.
export function understandingKey(revisionId: string, name: string, attemptId?: string | null): string {
  return `source/${revisionId}/${attemptId ? `understanding/${attemptId}/` : ""}${name}`;
}
export function understandingWorkflowId(revisionId: string, attemptId?: string | null): string {
  return attemptId ? `distill-attempt-${attemptId}` : `distill-${revisionId}`;
}
export interface AttemptRevision {
  id: string; source_id: string; distill_attempt_id: string | null; distill_request_json: string | null;
  distill_state: DistillState; distill_calls: number; distill_error: string | null; distill_model: string | null;
  distill_input_tokens: number | null; distill_cached_tokens: number | null; distill_output_tokens: number | null;
  distill_estimated_cost_microusd: number | null; distill_pricing_checked_on: string | null; distill_started_at: number | null; distill_ms: number | null;
  claim_count: number; distill_report_key: string | null; distill_token_limit: number | null; distill_token_limit_kind: "published" | "unknown" | "legacy" | null;
}
export interface AttemptSnapshot { revision: AttemptRevision; claims: UnderstandingClaim[] }
export async function readUnderstandingClaims(env: Env, revisionId: string, expected: { attemptId: string | null; reportKey: string | null; state: string; claimCount: number }): Promise<UnderstandingClaim[]> {
  const claims = await env.DB.prepare("WITH owner AS (SELECT 1 FROM source_revision WHERE id=? AND distill_attempt_id IS ? AND distill_report_key IS ? AND distill_state=? AND claim_count=?) SELECT id,kind,statement,quote,block_index AS block,start_byte AS start,end_byte AS end,ambiguous,task,metric,dataset,value_text AS valueText,value_number AS valueNumber,unit,conditions,0 AS changed,ordinal FROM claim WHERE source_revision_id=? AND ordinal<(SELECT claim_count FROM source_revision WHERE id=?) AND EXISTS(SELECT 1 FROM owner) UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,-1 WHERE NOT EXISTS(SELECT 1 FROM owner) ORDER BY ordinal LIMIT 33")
    .bind(revisionId, expected.attemptId, expected.reportKey, expected.state, expected.claimCount, revisionId, revisionId).all<Omit<UnderstandingClaim, "ambiguous"> & { ambiguous: number; changed: number; ordinal: number }>();
  if (claims.results.some(claim => claim.changed)) throw new LibraryError("conflict", "Understanding changed while reading. Reload the stored result.", 409);
  return claims.results.map(({ changed: _changed, ordinal: _ordinal, ...claim }) => ({ ...claim, ambiguous: claim.ambiguous === 1 }));
}
export async function readAttemptSnapshot(env: Env, revisionId: string, attemptId: string): Promise<AttemptSnapshot> {
  const history = await env.DB.prepare("SELECT snapshot_key,rejection FROM distill_history WHERE source_revision_id=? AND attempt_id=?")
    .bind(revisionId, attemptId).first<{ snapshot_key: string | null; rejection: string | null }>();
  if (!history) throw new LibraryError("not_found", "Understanding attempt not found.", 404);
  if (history.rejection) throw new LibraryError("conflict", history.rejection, 409);
  const prefix = understandingKey(revisionId, "history/", attemptId === revisionId ? null : attemptId);
  const expected = history.snapshot_key;
  if (!expected?.startsWith(prefix) || !/^[0-9a-f-]{36}\.json$/i.test(expected.slice(prefix.length))) throw new LibraryError("unavailable", "Understanding history points outside this attempt.", 503);
  const object = await env.BUCKET.get(expected);
  if (!object) throw new LibraryError("unavailable", "Understanding history is missing. Restore storage and reload.", 503);
  const snapshot = await object.json<AttemptSnapshot>();
  if (snapshot.revision.id !== revisionId || (snapshot.revision.distill_attempt_id ?? revisionId) !== attemptId)
    throw new LibraryError("unavailable", "Understanding history has a different identity.", 503);
  return snapshot;
}
