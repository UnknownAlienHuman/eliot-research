// Storage-only source understanding and deterministic project overview.
import { z } from "zod";
import { LibraryError } from "./library";
import type { Actor } from "./auth";
import type { Block } from "./blocks";
import type { JSONObject } from "@ai-sdk/provider";
import { modelTokenLimit, readModelCatalog } from "./models";
import { understandingKey, readAttemptSnapshot, readUnderstandingClaims } from "./understanding-attempts";
import { hasAvailableUnderstanding } from "./workflows/distill";
import type { NativeReasoningEffort } from "./shared/api";

export type DistillState = "none" | "queued" | "running" | "paused" | "done" | "partial" | "failed";
export type ClaimKind = "method" | "result" | "limitation" | "dataset" | "definition" | "other";

export interface GlossaryEntry { en: string; ru: string; definition: string; labels: string[] }

export interface UnderstandingClaim { id: string; kind: ClaimKind; statement: string; quote: string;
  block: number; start: number; end: number; ambiguous: boolean; task: string | null; metric: string | null;
  dataset: string | null; valueText: string | null; valueNumber: number | null; unit: string | null; conditions: string | null }

export interface DistillUsage { calls: number; inputTokens: number | null; cachedTokens: number | null;
  outputTokens: number | null; tokenLimit?: number | null; tokenLimitKind?: "published" | "unknown" | "legacy"; wallMs: number;
  providerUsage?: (JSONObject | null)[]; outputBudgets?: ({ requestedTokens: number; appliedTokens: number } | null)[] }

export interface DistillReport { questions: string[]; usage: DistillUsage; kept: number;
  dropped: { index: number; reason: string }[]; clearedNumbers: number;
  raw: { first: string | null; second: string | null }; error: string | null;
  producerFormat?: "compact-k3-v1";
  artifacts?: { guide: string; digest: string; glossary: string } }

export interface RecordedUnderstandingUsage { tokenLimit: number | null; tokenLimitKind: "published" | "unknown" | "legacy" | null; calls: number; inputTokens: number | null; cachedTokens: number | null;
  outputTokens: number | null; estimatedCostMicrousd: number | null; pricingCheckedOn: string | null; startedAt: number | null; wallMs: number | null }

export interface Understanding { sourceId: string; revisionId: string; state: DistillState; error: string | null;
  canRecover: boolean;
  recordedUsage: RecordedUnderstandingUsage;
  attemptId: string; currentAttemptId: string; knownRequestId?: string | null; requestRejection?: string | null;
  authors: string; published: string | null;
  progress: { attempts: number; limit: number; maximumTokens: number | null; recordedTokenLimit?: number | null; tokenLimitKind?: "published" | "unknown" | "legacy"; model: string | null; configuredModel: string | null; nativeReasoningEffort?: NativeReasoningEffort };
  guide: string | null; digest: string | null; glossary: GlossaryEntry[]; claims: UnderstandingClaim[];
  report: DistillReport | null; citations: { block: number; start: number; end: number }[] }

export interface OverviewSource { sourceId: string; revisionId: string; title: string; state: DistillState;
  summary: string | null; questions: string[] }

export interface Overview { sources: OverviewSource[]; nextCursor: string | null }


async function r2Text(env: Env, key: string): Promise<string | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  return obj.text();
}

async function r2Json<T>(env: Env, key: string): Promise<T | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  try {
    return await obj.json<T>();
  } catch {
    return null;
  }
}

async function revisionQuestions(env: Env, revisionId: string, reportKey: string | null): Promise<string[]> {
  const raw = await r2Json<{ questions: string[] }>(env, reportKey ?? `source/${revisionId}/distill.json`);
  return raw && Array.isArray(raw.questions) ? raw.questions : [];
}

export async function getUnderstanding(env: Env, _actor: Actor, input: { sourceId: string; revisionId?: string | undefined; attemptId?: string | undefined; requestId?: string | undefined }): Promise<Understanding> {
  if (!input.sourceId) throw new LibraryError("invalid", "Check the request fields and try again.", 400);
  const source = await env.DB.prepare("SELECT id, authors, published, current_revision_id AS currentRevisionId FROM source WHERE id=? AND state!='deleted'")
    .bind(input.sourceId).first<{ id: string; authors: string; published: string | null; currentRevisionId: string | null }>();
  if (!source) throw new LibraryError("not_found", "Source not found.", 404);
  const revisionId = input.revisionId ?? source.currentRevisionId;
  if (!revisionId) throw new LibraryError("not_found", "This source has no revision yet.", 404);
  let row = await env.DB.prepare("SELECT r.distill_input_tokens AS inputTokens,r.distill_cached_tokens AS cachedTokens,r.distill_output_tokens AS outputTokens,r.distill_estimated_cost_microusd AS estimatedCostMicrousd,r.distill_pricing_checked_on AS pricingCheckedOn,r.distill_started_at AS startedAt,r.distill_ms AS wallMs,r.claim_count AS claimCount,r.distill_attempt_id AS attemptId,r.id AS id, r.distill_state AS state, r.distill_error AS error,r.distill_calls AS attempts,r.distill_report_key AS reportKey,r.distill_model AS model,r.distill_token_limit AS tokenLimit,r.distill_token_limit_kind AS tokenLimitKind"
    + ",r.distill_request_json AS request FROM source_revision r JOIN source s ON s.id=r.source_id"
    + " WHERE r.id=? AND r.source_id=? AND r.deleted_at IS NULL AND s.state!='deleted'")
    .bind(revisionId, input.sourceId).first<{ request: string | null; claimCount: number; attemptId: string | null; id: string; state: DistillState; error: string | null; attempts: number; reportKey: string | null; model: string | null; tokenLimit: number | null; tokenLimitKind: "published" | "unknown" | "legacy" | null } & Omit<RecordedUnderstandingUsage, "calls">>();
  if (!row) throw new LibraryError("not_found", "Source revision not found.", 404);
  const currentAttemptId = row.attemptId ?? revisionId;
  const archived = input.attemptId && input.attemptId !== currentAttemptId ? await readAttemptSnapshot(env, revisionId, input.attemptId) : null;
  if (archived) {
    const r = archived.revision;
    row = { inputTokens: r.distill_input_tokens, cachedTokens: r.distill_cached_tokens, outputTokens: r.distill_output_tokens,
      estimatedCostMicrousd: r.distill_estimated_cost_microusd, pricingCheckedOn: r.distill_pricing_checked_on, startedAt: r.distill_started_at, wallMs: r.distill_ms, claimCount: r.claim_count, id: r.id, attemptId: r.distill_attempt_id, state: r.distill_state, error: r.distill_error, attempts: r.distill_calls,
      reportKey: r.distill_report_key, model: r.distill_model, tokenLimit: r.distill_token_limit, tokenLimitKind: r.distill_token_limit_kind, request: r.distill_request_json };
  }
  let nativeReasoningEffort: NativeReasoningEffort | undefined;
  try { nativeReasoningEffort = z.object({ nativeReasoningEffort: z.enum(["low", "high"]).optional() }).parse(JSON.parse(row.request ?? "{}")).nativeReasoningEffort; }
  catch { /* Legacy intent is not evidence of a requested profile. */ }
  const attemptId = row.attemptId ?? null;
  if (row.reportKey && row.reportKey !== understandingKey(revisionId, "distill.json", attemptId) && row.reportKey !== understandingKey(revisionId, "checked/distill.json", attemptId))
    throw new LibraryError("unavailable", "The saved report points outside this understanding attempt.", 503);
  const settings = await env.DB.prepare("SELECT distill_model AS model FROM settings WHERE id=1").first<{ model: string }>();
  const configuredModel = settings?.model ?? null;
  const storedReport = await r2Json<DistillReport>(env, row.reportKey ?? understandingKey(revisionId, "distill.json", attemptId));
  const report = storedReport ? { ...storedReport, usage: { ...storedReport.usage, tokenLimit: storedReport.usage.tokenLimit ?? null,
    tokenLimitKind: storedReport.usage.tokenLimitKind ?? "legacy" as const } } : null;
  if (row.reportKey && !report) throw new LibraryError("unavailable", "The current saved report is missing. Restore storage and reload understanding.", 503);
  const recordedTokenLimit = row.tokenLimit ?? report?.usage?.tokenLimit ?? null;
  let tokenLimitKind = row.tokenLimitKind ?? report?.usage?.tokenLimitKind ?? "legacy";
  let maximumTokens = tokenLimitKind === "published" && recordedTokenLimit !== 0 ? recordedTokenLimit : null;
  const forecastModel = row.model ?? configuredModel;
  if (recordedTokenLimit === null && row.tokenLimitKind == null && row.attempts === 0 && ["none", "queued", "paused"].includes(row.state) && forecastModel) {
    try {
      const catalog = await readModelCatalog(env);
      const entry = catalog.models.find((m) => m.route === forecastModel);
      if (entry && entry.enabled) {
        const callBound = modelTokenLimit(entry), bound = callBound === null ? null : 2 * callBound;
        if (bound !== null && Number.isSafeInteger(bound)) maximumTokens = bound;
        tokenLimitKind = bound === null ? "unknown" : "published";
      }
    } catch { maximumTokens = null; }
  }
  const artifact = (name: "guide" | "digest" | "glossary", file: string) => {
    if (!report?.artifacts) return understandingKey(revisionId, file, attemptId);
    if (report.artifacts[name] !== understandingKey(revisionId, `checked/${file}`, attemptId) && !(attemptId && report.artifacts[name] === understandingKey(revisionId, file, attemptId))) throw new LibraryError("unavailable", "The current understanding artifact points outside this revision.", 503);
    return report.artifacts[name];
  };
  const [claims, guide, digest, glossary] = await Promise.all([
    archived ? Promise.resolve(archived.claims) : readUnderstandingClaims(env, revisionId, { attemptId, reportKey: row.reportKey, state: row.state, claimCount: row.claimCount }),
    r2Text(env, artifact("guide", "guide.md")),
    r2Text(env, artifact("digest", "digest.md")),
    r2Json<GlossaryEntry[]>(env, artifact("glossary", "glossary.json")),
  ]);
  const missing = [guide === null && "guide", digest === null && "digest", report === null && "report"].filter((x) => typeof x === "string");
  if (row.state === "done" && missing.length > 0) throw new LibraryError("unavailable", `The saved ${missing.join(", ")} is missing from storage. Source reading remains available; reload understanding after storage is restored.`, 503);
  const blocks = guide || digest ? await r2Json<Block[]>(env, `source/${revisionId}/blocks.json`) : [];
  const requestKnown = input.requestId ? await env.DB.prepare("SELECT id,NULL AS rejection FROM source_revision WHERE id=? AND distill_attempt_id=? UNION ALL SELECT source_revision_id AS id,rejection FROM distill_history WHERE source_revision_id=? AND attempt_id=? LIMIT 1")
    .bind(revisionId, input.requestId, revisionId, input.requestId).first<{ id: string; rejection: string | null }>() : undefined;
  return {
    ...(requestKnown === undefined ? {} : { knownRequestId: requestKnown ? input.requestId ?? null : null, requestRejection: requestKnown?.rejection ?? null }),
    attemptId: attemptId ?? revisionId, currentAttemptId,
    sourceId: input.sourceId,
    revisionId: row.id,
    state: row.state,
    error: row.error,
    canRecover: !archived && ["done", "partial", "failed"].includes(row.state) && row.reportKey !== understandingKey(revisionId, "checked/distill.json", attemptId) && await hasAvailableUnderstanding(env, revisionId, attemptId),
    authors: source.authors,
    published: source.published,
    recordedUsage: { tokenLimit: row.tokenLimit, tokenLimitKind: row.tokenLimitKind, calls: row.attempts, inputTokens: row.inputTokens, cachedTokens: row.cachedTokens, outputTokens: row.outputTokens,
      estimatedCostMicrousd: row.estimatedCostMicrousd, pricingCheckedOn: row.pricingCheckedOn, startedAt: row.startedAt, wallMs: row.wallMs },
    progress: { attempts: row.attempts, limit: 2, maximumTokens, recordedTokenLimit, tokenLimitKind,
      model: row.model, configuredModel, ...(nativeReasoningEffort === undefined ? {} : { nativeReasoningEffort }) },
    guide,
    digest,
    glossary: Array.isArray(glossary) ? glossary : [],
    claims,
    report,
    citations: (blocks ?? []).map((block) => ({ block: block.id, start: block.start, end: block.end })),
  };
}

export async function getOverview(env: Env, _actor: Actor, input: { projectId: string; cursor?: string | undefined }): Promise<Overview> {
  if (!input.projectId) throw new LibraryError("invalid", "Check the request fields and try again.", 400);
  const project = await env.DB.prepare("SELECT id FROM project WHERE id=?").bind(input.projectId).first<{ id: string }>();
  if (!project) throw new LibraryError("not_found", "Project not found.", 404);
  let after: { at: number; id: string } | undefined;
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== "string" || input.cursor.length > 512) throw new Error("cursor");
      const value: unknown = JSON.parse(input.cursor);
      if (!Array.isArray(value) || value.length !== 3 || value[0] !== input.projectId
        || !Number.isSafeInteger(value[1]) || value[1] < 0) throw new Error("cursor");
      after = { at: value[1] as number, id: z.uuid().parse(value[2]) };
    } catch { throw new LibraryError("invalid", "This overview cursor is invalid. Refresh the overview.", 400); }
  }
  const args: (string | number)[] = [input.projectId];
  if (after) args.push(after.at, after.id);
  const result = await env.DB.prepare("SELECT s.id AS sourceId, s.title AS title, s.current_revision_id AS revisionId,"
    + " s.created_at AS createdAt,r.distill_state AS state,r.guide_summary AS summary,r.distill_report_key AS reportKey,r.distill_attempt_id AS attemptId FROM project_source ps"
    + " JOIN source s ON s.id=ps.source_id JOIN source_revision r ON r.id=s.current_revision_id"
    + " WHERE ps.project_id=? AND s.state='active' AND r.deleted_at IS NULL"
    + " AND r.readable_state IN ('readable','readable_with_warnings')"
    + (after ? " AND (s.created_at,s.id)>(?,?)" : "") + " ORDER BY s.created_at ASC,s.id ASC LIMIT 51")
    .bind(...args).all<{ sourceId: string; title: string; revisionId: string; createdAt: number; state: DistillState; summary: string | null; reportKey: string | null; attemptId: string | null }>();
  const page = result.results.slice(0, 50), last = page.at(-1);
  const sources = await Promise.all(page.map(async (item) => ({
    sourceId: item.sourceId,
    revisionId: item.revisionId,
    title: item.title,
    state: item.state,
    summary: item.summary,
    questions: await revisionQuestions(env, item.revisionId, item.reportKey ?? understandingKey(item.revisionId, "distill.json", item.attemptId)),
  })));
  return { sources, nextCursor: result.results.length > 50 && last ? JSON.stringify([input.projectId, last.createdAt, last.sourceId]) : null };
}

export interface UnderstandingHistory { attempts: { attemptId: string; archivedAt: number }[]; nextCursor: string | null }
export async function getUnderstandingHistory(env: Env, input: { sourceId: string; revisionId: string; cursor?: string | undefined }): Promise<UnderstandingHistory> {
  const live = await env.DB.prepare("SELECT r.id FROM source_revision r JOIN source s ON s.id=r.source_id WHERE r.id=? AND s.id=? AND r.deleted_at IS NULL AND s.state!='deleted'").bind(input.revisionId, input.sourceId).first();
  if (!live) throw new LibraryError("not_found", "Source revision not found.", 404);
  let after: [number, string] | null = null;
  if (input.cursor) {
    try { const c: unknown = JSON.parse(input.cursor); if (!Array.isArray(c) || c.length !== 3 || c[0] !== input.revisionId || !Number.isSafeInteger(c[1])) throw new Error(); after = [c[1] as number, z.uuid().parse(c[2])]; }
    catch { throw new LibraryError("invalid", "Invalid understanding history cursor.", 400); }
  }
  const result = await env.DB.prepare("SELECT attempt_id AS attemptId,archived_at AS archivedAt FROM distill_history WHERE source_revision_id=? AND rejection IS NULL" + (after ? " AND (archived_at,attempt_id)<(?,?)" : "") + " ORDER BY archived_at DESC,attempt_id DESC LIMIT 21")
    .bind(input.revisionId, ...(after ?? [])).all<{ attemptId: string; archivedAt: number }>();
  const attempts = result.results.slice(0, 20), last = attempts.at(-1);
  return { attempts, nextCursor: result.results.length > 20 && last ? JSON.stringify([input.revisionId, last.archivedAt, last.attemptId]) : null };
}
