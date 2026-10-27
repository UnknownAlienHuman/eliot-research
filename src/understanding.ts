// K3 storage reader: per-source understanding and deterministic project
// overview. Product functions only: (env, actor, input). R2 holds the
// writer-validated bodies and report; D1 holds identity and verified
// claims. No model, network, page-write or schema work.
import { LibraryError } from "./library";
import type { Actor } from "./auth";
import type { Block } from "./blocks";
import type { JSONObject } from "@ai-sdk/provider";
import { estimateCost } from "./cost";
import { MODELS, modelOutputLimit } from "./models";
import { hasAvailableUnderstanding } from "./workflows/distill";

export type DistillState = "none" | "queued" | "running" | "paused" | "done" | "partial" | "failed";
export type ClaimKind = "method" | "result" | "limitation" | "dataset" | "definition" | "other";

export interface GlossaryEntry { en: string; ru: string; definition: string; labels: string[] }

export interface UnderstandingClaim { id: string; kind: ClaimKind; statement: string; quote: string;
  block: number; start: number; end: number; ambiguous: boolean; task: string | null; metric: string | null;
  dataset: string | null; valueText: string | null; valueNumber: number | null; unit: string | null; conditions: string | null }

export interface DistillUsage { calls: number; inputTokens: number | null; cachedTokens: number | null;
  outputTokens: number | null; estimatedCostMicrousd: number; wallMs: number; providerUsage?: (JSONObject | null)[] }

export interface DistillReport { questions: string[]; usage: DistillUsage; kept: number;
  dropped: { index: number; reason: string }[]; clearedNumbers: number;
  raw: { first: string | null; second: string | null }; error: string | null;
  artifacts?: { guide: string; digest: string; glossary: string } }

export interface Understanding { sourceId: string; revisionId: string; state: DistillState; error: string | null;
  canRecover: boolean;
  authors: string; published: string | null;
  progress: { attempts: number; limit: number; maximumCostMicrousd: number | null; model: string | null };
  guide: string | null; digest: string | null; glossary: GlossaryEntry[]; claims: UnderstandingClaim[];
  report: DistillReport | null; citations: { block: number; start: number; end: number }[] }

export interface OverviewSource { sourceId: string; revisionId: string; title: string; state: DistillState;
  summary: string | null; questions: string[] }

export interface Overview { sources: OverviewSource[] }

const MAX_CLAIMS = 32;

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

export async function getUnderstanding(env: Env, _actor: Actor, input: { sourceId: string; revisionId?: string | undefined }): Promise<Understanding> {
  if (!input.sourceId) throw new LibraryError("invalid", "Check the request fields and try again.", 400);
  const source = await env.DB.prepare("SELECT id, authors, published, current_revision_id AS currentRevisionId FROM source WHERE id=? AND state!='deleted'")
    .bind(input.sourceId).first<{ id: string; authors: string; published: string | null; currentRevisionId: string | null }>();
  if (!source) throw new LibraryError("not_found", "Source not found.", 404);
  const revisionId = input.revisionId ?? source.currentRevisionId;
  if (!revisionId) throw new LibraryError("not_found", "This source has no revision yet.", 404);
  const row = await env.DB.prepare("SELECT r.id AS id, r.distill_state AS state, r.distill_error AS error,r.distill_calls AS attempts,r.distill_report_key AS reportKey,r.distill_model AS model"
    + " FROM source_revision r JOIN source s ON s.id=r.source_id"
    + " WHERE r.id=? AND r.source_id=? AND r.deleted_at IS NULL AND s.state!='deleted'")
    .bind(revisionId, input.sourceId).first<{ id: string; state: DistillState; error: string | null; attempts: number; reportKey: string | null; model: string | null }>();
  if (!row) throw new LibraryError("not_found", "Source revision not found.", 404);
  const settings = await env.DB.prepare("SELECT distill_model AS model FROM settings WHERE id=1").first<{ model: string }>();
  const model = MODELS.find((m) => m.route === (row.model ?? settings?.model) && m.enabled);
  const report = await r2Json<DistillReport>(env, row.reportKey ?? `source/${revisionId}/distill.json`);
  if (row.reportKey && !report) throw new LibraryError("unavailable", "The current saved report is missing. Restore storage and reload understanding.", 503);
  const artifact = (name: "guide" | "digest" | "glossary", file: string) => {
    if (!report?.artifacts) return `source/${revisionId}/${file}`;
    if (report.artifacts[name] !== `source/${revisionId}/checked/${file}`) throw new LibraryError("unavailable", "The current understanding artifact points outside this revision.", 503);
    return report.artifacts[name];
  };
  const [claims, guide, digest, glossary] = await Promise.all([
    env.DB.prepare("SELECT id, kind, statement, quote, block_index AS block, start_byte AS start, end_byte AS end,"
      + " ambiguous, task, metric, dataset, value_text AS valueText, value_number AS valueNumber, unit, conditions"
      + " FROM claim WHERE source_revision_id=? AND ordinal<(SELECT claim_count FROM source_revision WHERE id=?) ORDER BY ordinal ASC LIMIT " + MAX_CLAIMS).bind(revisionId, revisionId).all<{
      id: string; kind: ClaimKind; statement: string; quote: string; block: number; start: number; end: number;
      ambiguous: number; task: string | null; metric: string | null; dataset: string | null; valueText: string | null;
      valueNumber: number | null; unit: string | null; conditions: string | null }>(),
    r2Text(env, artifact("guide", "guide.md")),
    r2Text(env, artifact("digest", "digest.md")),
    r2Json<GlossaryEntry[]>(env, artifact("glossary", "glossary.json")),
  ]);
  const missing = [guide === null && "guide", digest === null && "digest", report === null && "report"].filter((x) => typeof x === "string");
  if (row.state === "done" && missing.length > 0) throw new LibraryError("unavailable", `The saved ${missing.join(", ")} is missing from storage. Source reading remains available; reload understanding after storage is restored.`, 503);
  const blocks = guide || digest ? await r2Json<Block[]>(env, `source/${revisionId}/blocks.json`) : [];
  return {
    sourceId: input.sourceId,
    revisionId: row.id,
    state: row.state,
    error: row.error,
    canRecover: ["done", "partial", "failed"].includes(row.state) && row.reportKey !== `source/${revisionId}/checked/distill.json` && await hasAvailableUnderstanding(env, revisionId),
    authors: source.authors,
    published: source.published,
    progress: { attempts: row.attempts, limit: 2, maximumCostMicrousd: model ? 2 * estimateCost(model, model.contextTokens, 0, modelOutputLimit(model)) : null, model: model?.route ?? null },
    guide,
    digest,
    glossary: Array.isArray(glossary) ? glossary : [],
    claims: claims.results.map((claim) => ({
      id: claim.id,
      kind: claim.kind,
      statement: claim.statement,
      quote: claim.quote,
      block: claim.block,
      start: claim.start,
      end: claim.end,
      ambiguous: claim.ambiguous === 1,
      task: claim.task,
      metric: claim.metric,
      dataset: claim.dataset,
      valueText: claim.valueText,
      valueNumber: claim.valueNumber,
      unit: claim.unit,
      conditions: claim.conditions,
    })),
    report,
    citations: (blocks ?? []).map((block) => ({ block: block.id, start: block.start, end: block.end })),
  };
}

export async function getOverview(env: Env, _actor: Actor, input: { projectId: string }): Promise<Overview> {
  if (!input.projectId) throw new LibraryError("invalid", "Check the request fields and try again.", 400);
  const project = await env.DB.prepare("SELECT id FROM project WHERE id=?").bind(input.projectId).first<{ id: string }>();
  if (!project) throw new LibraryError("not_found", "Project not found.", 404);
  const result = await env.DB.prepare("SELECT s.id AS sourceId, s.title AS title, s.current_revision_id AS revisionId,"
    + " r.distill_state AS state, r.guide_summary AS summary,r.distill_report_key AS reportKey FROM project_source ps"
    + " JOIN source s ON s.id=ps.source_id JOIN source_revision r ON r.id=s.current_revision_id"
    + " WHERE ps.project_id=? AND s.state='active' AND r.deleted_at IS NULL"
    + " AND r.readable_state IN ('readable','readable_with_warnings') ORDER BY s.created_at ASC, s.id ASC")
    .bind(input.projectId).all<{ sourceId: string; title: string; revisionId: string; state: DistillState; summary: string | null; reportKey: string | null }>();
  const sources = await Promise.all(result.results.map(async (item) => ({
    sourceId: item.sourceId,
    revisionId: item.revisionId,
    title: item.title,
    state: item.state,
    summary: item.summary,
    questions: await revisionQuestions(env, item.revisionId, item.reportKey),
  })));
  return { sources };
}
