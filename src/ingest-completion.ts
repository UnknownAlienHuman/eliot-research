// Storage-only publication, shared by the owning Workflow and source reader.
import { z } from "zod";

export interface LoadedRevision { revisionId: string; sourceId: string; revisionNo: number; mime: string; filename: string; originalKey: string }
const usage = { tokens: z.number().int().nonnegative().nullable(), calls: z.number().int().min(0).max(1), ms: z.number().int().nonnegative() };
const storedSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("failed"), error: z.string(), ...usage }),
  z.object({ outcome: z.literal("needs_conversion"), warning: z.string(), ...usage }),
  z.object({ outcome: z.literal("readable"), converter: z.string(), readableSize: z.number().int().positive(), blockCount: z.number().int().nonnegative(),
    warning: z.string().nullable(), textEtag: z.string().min(1), blocksEtag: z.string().min(1), ...usage }),
]);
export type Stored = z.infer<typeof storedSchema>;
export const STORAGE_FAILURE = "The original is saved, but conversion completion could not be confirmed. Reopen this source to retry saving the existing result; conversion will not run again.";
export const STATUS_UNAVAILABLE = "The original is saved, but conversion status could not be checked. The existing conversion may still be running. Reopen this source to check again.";
const CONFLICT = "A newer revision is current; this text stays available for existing citations.";

export async function loadRevision(env: Env, revisionId: string): Promise<LoadedRevision | null> {
  const row = await env.DB.prepare(`SELECT id,source_id,revision_no,original_key,original_mime,original_filename FROM source_revision
    WHERE id=? AND deleted_at IS NULL`).bind(revisionId).first<{ id: string; source_id: string; revision_no: number; original_key: string | null; original_mime: string | null; original_filename: string | null }>();
  return row ? { revisionId: row.id, sourceId: row.source_id, revisionNo: row.revision_no, originalKey: row.original_key ?? `source/${row.id}/original`,
    mime: row.original_mime ?? "application/octet-stream", filename: row.original_filename ?? row.id } : null;
}
interface RevisionResult {
  readable_state: string; converter: string | null; readable_size: number | null; block_count: number | null;
  warning_summary: string | null; error: string | null; conversion_tokens: number | null; conversion_calls: number; conversion_ms: number | null;
}
function expected(stored: Stored) {
  return { state: stored.outcome === "readable" ? stored.warning ? "readable_with_warnings" : "readable" : stored.outcome,
    error: stored.outcome === "failed" ? stored.error : null, warning: stored.outcome === "failed" ? null : stored.warning };
}
function matches(row: RevisionResult, stored: Stored) {
  const p = expected(stored);
  const warning = row.warning_summary === p.warning || (stored.outcome === "readable" && row.warning_summary === [p.warning, CONFLICT].filter(Boolean).join(" "));
  return (row.readable_state === p.state || (stored.outcome === "readable" && row.readable_state === "readable_with_warnings" && warning))
    && warning && row.error === p.error && row.conversion_calls >= stored.calls
    && (stored.tokens === null || row.conversion_tokens === stored.tokens) && row.conversion_ms === stored.ms
    && (stored.outcome !== "readable" || (row.converter === stored.converter && row.readable_size === stored.readableSize && row.block_count === stored.blockCount));
}
const resultSql = `SELECT readable_state,converter,readable_size,block_count,warning_summary,error,conversion_tokens,conversion_calls,conversion_ms
  FROM source_revision WHERE id=? AND source_id=? AND revision_no=? AND COALESCE(original_key,'source/'||id||'/original')=? AND deleted_at IS NULL`;

export async function commitRevision(env: Env, loaded: LoadedRevision, stored: Stored): Promise<{ outcome: string; advanced: boolean }> {
  const identity = [loaded.revisionId, loaded.sourceId, loaded.revisionNo, loaded.originalKey];
  const before = await env.DB.prepare(resultSql).bind(...identity).first<RevisionResult>();
  if (!before) return { outcome: "unavailable-revision", advanced: false };
  if (before.readable_state !== "pending" && !(before.readable_state === "failed" && before.error === STORAGE_FAILURE) && !matches(before, stored))
    throw new Error("Stored conversion result differs from the terminal revision; neither is overwritten.");
  if (stored.outcome === "readable") {
    const [text, blocks] = await Promise.all([env.BUCKET.head(`source/${loaded.revisionId}/text.md`), env.BUCKET.head(`source/${loaded.revisionId}/blocks.json`)]);
    if (!text || !blocks || text.etag !== stored.textEtag || blocks.etag !== stored.blocksEtag || text.size !== stored.readableSize)
      throw new Error("The completed conversion artifacts are missing or changed. Conversion is not repeated.");
  }
  const p = expected(stored);
  const writable = "AND (readable_state='pending' OR (readable_state='failed' AND error=?))";
  const statements = [env.DB.prepare(`UPDATE source_revision SET readable_state=?,error=?,warning_summary=?,
    converter=COALESCE(?,converter),readable_size=COALESCE(?,readable_size),block_count=COALESCE(?,block_count),
    conversion_tokens=COALESCE(conversion_tokens,?),conversion_calls=MAX(conversion_calls,?),conversion_ms=?
    WHERE id=? AND source_id=? AND revision_no=? AND COALESCE(original_key,'source/'||id||'/original')=? AND deleted_at IS NULL ${writable}`)
    .bind(p.state, p.error, p.warning, stored.outcome === "readable" ? stored.converter : null,
      stored.outcome === "readable" ? stored.readableSize : null, stored.outcome === "readable" ? stored.blockCount : null,
      stored.tokens, stored.calls, stored.ms, ...identity, STORAGE_FAILURE)];
  if (stored.outcome === "readable") {
    // A monotonic CAS plus the newest-readable guard is evaluated inside the same
    // transaction as publication. A concurrent older head cannot create a false race.
    const headGuard = `id=? AND state!='deleted'
      AND (current_revision_id IS NULL OR current_revision_id IN (SELECT id FROM source_revision WHERE source_id=? AND revision_no<?))
      AND NOT EXISTS (SELECT 1 FROM source_revision WHERE source_id=? AND revision_no>? AND deleted_at IS NULL AND readable_state IN ('readable','readable_with_warnings'))
      AND EXISTS (SELECT 1 FROM source_revision WHERE id=? AND source_id=? AND deleted_at IS NULL AND readable_state IN ('readable','readable_with_warnings')
        AND converter=? AND readable_size=? AND block_count=? AND conversion_ms=? AND error IS NULL
        AND conversion_tokens IS COALESCE(?,conversion_tokens) AND conversion_calls>=?)`;
    const headValues = [loaded.sourceId, loaded.sourceId, loaded.revisionNo, loaded.sourceId, loaded.revisionNo,
      loaded.revisionId, loaded.sourceId, stored.converter, stored.readableSize, stored.blockCount, stored.ms, stored.tokens, stored.calls];
    const now = Date.now();
    statements.push(env.DB.prepare(`UPDATE page SET freshness='stale',updated_at=? WHERE head_revision_id IN
      (SELECT pr.id FROM page_revision pr JOIN json_each(pr.inputs_json) i WHERE pr.status='accepted' AND i.type='text'
        AND i.value=(SELECT current_revision_id FROM source WHERE id=?))
      AND EXISTS(SELECT 1 FROM source WHERE ${headGuard})`).bind(now, loaded.sourceId, ...headValues));
    statements.push(env.DB.prepare(`UPDATE source SET current_revision_id=?,updated_at=? WHERE ${headGuard}`)
      .bind(loaded.revisionId, now, ...headValues));
    statements.push(env.DB.prepare(`UPDATE source_revision SET readable_state='readable_with_warnings',warning_summary=?
      WHERE id=? AND source_id=? AND deleted_at IS NULL AND readable_state IN ('readable','readable_with_warnings')
      AND converter=? AND readable_size=? AND block_count=? AND conversion_ms=? AND error IS NULL
      AND conversion_tokens IS COALESCE(?,conversion_tokens) AND conversion_calls>=?
      AND EXISTS (SELECT 1 FROM source_revision WHERE source_id=? AND revision_no>? AND deleted_at IS NULL AND readable_state IN ('readable','readable_with_warnings'))`)
      .bind([stored.warning, CONFLICT].filter(Boolean).join(" "), loaded.revisionId, loaded.sourceId, stored.converter, stored.readableSize, stored.blockCount, stored.ms, stored.tokens, stored.calls, loaded.sourceId, loaded.revisionNo));
  }
  let advanced = false;
  try { const results = await env.DB.batch(statements); advanced = (results[2]?.meta.changes ?? 0) > 0; }
  catch { /* A batch may have committed without its reply; confirm the whole result below. */ }
  const after = await env.DB.prepare(resultSql).bind(...identity).first<RevisionResult>();
  if (!after || !matches(after, stored)) throw new Error("Conversion completion was not confirmed.");
  if (stored.outcome === "readable") {
    const head = await env.DB.prepare(`SELECT current_revision_id,
      EXISTS(SELECT 1 FROM source_revision WHERE source_id=? AND revision_no>? AND deleted_at IS NULL AND readable_state IN ('readable','readable_with_warnings')) AS newer
      FROM source WHERE id=? AND state!='deleted'`).bind(loaded.sourceId, loaded.revisionNo, loaded.sourceId).first<{ current_revision_id: string | null; newer: number }>();
    if (!head || (head.current_revision_id !== loaded.revisionId && !head.newer)) throw new Error("Readable text was not published; storage completion needs another attempt.");
  }
  return { outcome: after.readable_state, advanced };
}

export async function recordStorageFailure(env: Env, revisionId: string, stored?: Stored) {
  // A completed terminal projection must not be downgraded after a lost reply.
  await env.DB.prepare(`UPDATE source_revision SET readable_state='failed',error=?,conversion_tokens=COALESCE(conversion_tokens,?),
    conversion_calls=MAX(conversion_calls,?),conversion_ms=COALESCE(conversion_ms,?) WHERE id=? AND readable_state='pending' AND deleted_at IS NULL`)
    .bind(STORAGE_FAILURE, stored?.tokens ?? null, stored?.calls ?? 0, stored?.ms ?? null, revisionId).run();
}
export async function recoverIngest(env: Env, revisionId: string): Promise<string | null> {
  let status: InstanceStatus;
  try { status = await (await env.INGEST.get(`ingest-${revisionId}`)).status(); }
  catch { return STATUS_UNAVAILABLE; }
  if (status.status === "unknown") return STATUS_UNAVAILABLE;
  if (["queued", "running", "waiting", "paused", "waitingForPause"].includes(status.status)) {
    try {
      await env.DB.prepare("UPDATE source_revision SET error=NULL WHERE id=? AND readable_state='pending' AND error IN (?,?)")
        .bind(revisionId, STATUS_UNAVAILABLE, STORAGE_FAILURE).run();
    } catch { return STATUS_UNAVAILABLE; }
    return null;
  }
  try {
    const output = z.object({ revisionId: z.literal(revisionId), stored: storedSchema }).safeParse(status.output);
    if (status.status === "complete" && output.success) {
      const loaded = await loadRevision(env, revisionId);
      if (loaded) await commitRevision(env, loaded, output.data.stored);
      return null;
    }
    await recordStorageFailure(env, revisionId);
    return STORAGE_FAILURE;
  } catch { return STORAGE_FAILURE; } // No read/reconciliation path recreates or restarts conversion.
}
