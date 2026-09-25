// IMPLEMENTED_NOT_LIVE: ER-24 ResearchSession executes durable sessions over DO storage with W2 D1/R2 checkpoints; research.query/run are composed; hibernation WebSocket transport and live receipts remain separate.
import { DurableObject } from "cloudflare:workers";
import { ORIENTATION_PROFILE, createD1ScopeService, createOwnerScopeAuthority, createProjectClientScopeAuthority, OWNER_RESEARCH_MAX_SELECTED_SOURCES, readOwnerScopeProfile } from "@eliotr/cloudflare-navigation";
import { createD1ScopePorts, createD1ScopeProfilePort, createD1RetrievalResultStore, retrievalRequestDigest, RetrievalQueryError } from "@eliotr/retrieval";
import { createD1EvidenceAuthorityPort, createNavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { loadHeldResearchScope, retrieveWithHeldScope } from "./research-retrieval-composition.js";
import {
  createMonotoneStageExecutor,
  WorkflowCheckpointStore,
  digest,
  WorkflowObjectSchema,
  MAX_WORKFLOW_RECEIPT_BYTES,
  WorkflowCheckpointError,
  readResearchRunStatus as readStoredResearchRunStatus,
  ResearchMaterializeOutputError,
  RESEARCH_RUN_REQUEST_V2,
  compileInquiryLedgerObligations,
  installedInquiryProtocolDefinition,
  createResearchPlanningManifest,
} from "@eliotr/cloudflare-research";
import { readCommittedResearchRunResult } from "@eliotr/cloudflare-research-stages";
import type { StageReceipt, StageRequest, WorkflowExecutionPorts, WorkflowObject, WorkflowPrincipal } from "@eliotr/cloudflare-research";
import { createD1InvestigationLedgerStore, createInvestigationLedgerService, LedgerError } from "@eliotr/research";
import type { LedgerD1Database } from "@eliotr/research";
import { createResearchStageHandlerFactory, SERVER_OWNED_RESEARCH_HANDLER_GENERATION, SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION, SERVER_OWNED_FREEZE_HANDLER_GENERATION, SERVER_OWNED_SEMANTIC_HANDLER_GENERATION, SERVER_OWNED_LEGACY_PROTOCOL_HANDLER_GENERATION, SERVER_OWNED_PROTOCOL_HANDLER_GENERATION, isSemanticResearchHandlerGeneration, SERVER_RETRIEVAL_SCOPE_PROFILE } from "./research-stage-handlers.js";
import { createResearchSemanticServerHandlers, researchSemanticConfigurationInstalled } from "./research-semantic-server.js";
import { RESEARCH_QUALIFICATION_RENEWAL_MARKER } from "./research-qualification-renewal.js";
import { isResearchQuestionText, ScopeExpressionSchema, VersionedRefSchema } from "@eliotr/contracts";
import type { VersionedRef } from "@eliotr/contracts";
import { inspectScopeExpression, scopeExpressionIdentity } from "@eliotr/domain";
import type { AuthenticatedRequestContext, QueryRequest, QueryResult, ResearchRunStatus } from "@eliotr/interfaces";
import { readResearchEngineStatus, researchRunFailure } from "./research-run-failure.js";
import { ResearchServiceError, failResearch as fail } from "./research-service-error.js";
export { ResearchServiceError } from "./research-service-error.js";
import { prepareClientResearchAdmission, requireClientResearchExecution } from "./research-client-execution.js";
import { loadResearchPlanningSources, prepareResearchRunScope } from "./research-run-admission.js";
import type { Env } from "./env.js";
import { RESEARCH_OWNER_MODEL_PROFILE as MODEL_PROFILE } from "./research-owner-profile.js";
import type { ResearchWorkflowRunParams } from "./research-workflow.js";
import { researchStageBudgetLeaseMs } from "./research-runtime-duration.js";
import { prepareReauthenticatedRunRead, readReauthenticatedRunAnswer } from "./research-run-read-authorization.js";
import { prepareProjectClientRunRead, readProjectClientRunAnswer } from "./research-client-run-read.js";
import { requireResearchDeploymentCompatibility } from "./research-deployment-compatibility.js";
export const RESEARCH_SESSION_PROTOCOL = "eliotr.research-session.v1";
const RUN_BUDGET = "research-budget-v1";
const POLICY_GEN = "research-policy-v1";
const HANDLER_GEN = "research-handlers.v1";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
function checkId(value: unknown, label: string): string { if (typeof value !== "string" || !ID_RE.test(value)) fail("RESEARCH_INPUT_INVALID", `${label} is invalid`); return value as string; }
function checkQuery(value: unknown): string { if (!isResearchQuestionText(value)) fail("RESEARCH_INPUT_INVALID", "query is invalid"); return value; }
function checkScope(value: unknown, maximumSelectedSources = 64): QueryRequest["scope_expression"] { const parsed = ScopeExpressionSchema.safeParse(value); if (!parsed.success) fail("RESEARCH_INPUT_INVALID", "scope_expression is invalid"); const m = inspectScopeExpression(parsed.data); if (m.depth > 8 || m.atom_count > 16 || m.selected_source_count > maximumSelectedSources) fail("RESEARCH_INPUT_LIMIT", "scope_expression exceeds its bounds", 413); return parsed.data; }
const BASE_REQUEST_KEYS = ["query", "product", "scope_expression", "literals", "evidence_grade", "budget_ref", "max_results"] as const;
const RUN_V2_REQUEST_KEYS = [...BASE_REQUEST_KEYS, "request_version", "inquiry_protocol_ref"] as const;
function exactKeys(record: Record<string, unknown>, expected: readonly string[] = BASE_REQUEST_KEYS): void {
  if (Object.keys(record).length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) {
    fail("RESEARCH_INPUT_INVALID", "request has unknown or missing fields");
  }
}
function checkLiteralsMax(record: Record<string, unknown>): number { if (!Array.isArray(record.literals) || record.literals.length !== 0) fail("RESEARCH_INPUT_INVALID", "literals must be empty"); if (!Number.isSafeInteger(record.max_results) || (record.max_results as number) < 1 || (record.max_results as number) > 16) fail("RESEARCH_INPUT_INVALID", "max_results is invalid"); return record.max_results as number; }
export const FAST_SEARCH_PROFILE = "retrieval-fast-v1";
export function parseResearchQueryRequest(raw: unknown): QueryRequest { if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("RESEARCH_INPUT_INVALID", "query request must be an object"); const r = raw as Record<string, unknown>; exactKeys(r); const product = r.product === "FAST_SEARCH" ? "FAST_SEARCH" : "ORIENT"; const profile = product === "FAST_SEARCH" ? FAST_SEARCH_PROFILE : ORIENTATION_PROFILE; if (r.product !== product || r.evidence_grade !== "E0" || r.budget_ref !== profile) fail("RESEARCH_PROFILE_UNSUPPORTED", product === "FAST_SEARCH" ? "research.query FAST_SEARCH requires the bounded retrieval profile" : "research.query supports only the ORIENT metadata profile or FAST_SEARCH retrieval profile", 422); return { query: checkQuery(r.query), product, scope_expression: checkScope(r.scope_expression), literals: [], evidence_grade: "E0", budget_ref: profile, max_results: checkLiteralsMax(r) }; }
export function parseResearchRunRequest(raw: unknown): QueryRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("RESEARCH_INPUT_INVALID", "run request must be an object");
  const r = raw as Record<string, unknown>;
  const explicitV2 = Object.hasOwn(r, "request_version") || Object.hasOwn(r, "inquiry_protocol_ref");
  exactKeys(r, explicitV2 ? RUN_V2_REQUEST_KEYS : BASE_REQUEST_KEYS);
  if (r.product !== "RESEARCH") fail("RESEARCH_PROFILE_UNSUPPORTED", "research.run requires product RESEARCH", 422);
  if (r.evidence_grade !== "E0" && r.evidence_grade !== "E1" && r.evidence_grade !== "E2") fail("RESEARCH_PROFILE_UNSUPPORTED", "research.run supports grades E0-E2", 422);
  if (r.budget_ref !== RUN_BUDGET) fail("RESEARCH_PROFILE_UNSUPPORTED", "research.run requires the bounded research budget profile", 422);
  const base = {
    query: checkQuery(r.query), product: "RESEARCH" as const, scope_expression: checkScope(r.scope_expression, OWNER_RESEARCH_MAX_SELECTED_SOURCES), literals: [] as const,
    evidence_grade: r.evidence_grade as QueryRequest["evidence_grade"], budget_ref: RUN_BUDGET, max_results: checkLiteralsMax(r),
  };
  if (!explicitV2) return base;
  if (r.request_version !== RESEARCH_RUN_REQUEST_V2) fail("RESEARCH_PROFILE_UNSUPPORTED", "research.run request version is unsupported", 422);
  const parsedRef = VersionedRefSchema.safeParse(r.inquiry_protocol_ref);
  if (!parsedRef.success) fail("RESEARCH_INPUT_INVALID", "inquiry_protocol_ref is invalid");
  try {
    const definition = installedInquiryProtocolDefinition(parsedRef.data);
    if (!definition.allowed_grades.includes(base.evidence_grade)) {
      fail("RESEARCH_PROFILE_UNSUPPORTED", "installed inquiry protocol does not support the requested grade", 422);
    }
  } catch (error) {
    if (error instanceof ResearchServiceError) throw error;
    fail("RESEARCH_PROFILE_UNSUPPORTED", "inquiry protocol is not installed", 422);
  }
  return { ...base, request_version: RESEARCH_RUN_REQUEST_V2, inquiry_protocol_ref: parsedRef.data };
}
function idempotencyKey(context: AuthenticatedRequestContext): string { const key = context.request.headers.get("idempotency-key"); if (typeof key !== "string" || key.length < 1 || key.length > 256 || /[\u0000-\u0020\u007f]/u.test(key)) fail("RESEARCH_INPUT_INVALID", "idempotency-key header is required"); return key; }
// IMPLEMENTED_NOT_LIVE: ER-24 research.query retrieval composition over injected RetrievalQueryPorts with frozen 64-source scope-profile versioning; RETRIEVAL slice enablement remains separate.
export const RETRIEVAL_SCOPE_PROFILE_VERSION = SERVER_RETRIEVAL_SCOPE_PROFILE.version;
export const RETRIEVAL_SCOPE_MAX_SOURCES = SERVER_RETRIEVAL_SCOPE_PROFILE.max_sources;
export const RETRIEVAL_SCOPE_MAX_RESULTS = SERVER_RETRIEVAL_SCOPE_PROFILE.max_results;
const RETRIEVAL_QUERY_BUDGET_MS = 30_000;
export interface ResearchQueryOptions { readonly scopeProfile?: { readonly version: string; readonly max_sources: number; readonly max_results: number } }
function mapRetrievalError(error: unknown): never {
  if (error instanceof ResearchServiceError) throw error;
  if (!(error instanceof RetrievalQueryError)) throw error;
  const status = error.code === "RETRIEVAL_INPUT_INVALID" ? 400 : error.code === "RETRIEVAL_AUTHORITY_STALE" ? 403 : error.code === "RETRIEVAL_RESOLUTION_UNCERTAIN" ? 503 : 409;
  const code = error.code === "RETRIEVAL_INPUT_INVALID" ? "RESEARCH_INPUT_INVALID" : error.code === "RETRIEVAL_RESOLUTION_UNCERTAIN" ? "RESEARCH_SETTLEMENT_UNCERTAIN" : error.code === "RETRIEVAL_BUDGET_STOP" ? "RESEARCH_BUDGET_STOP" : error.code === "RETRIEVAL_CANCELLED" ? "RESEARCH_CANCELLED" : error.code === "RETRIEVAL_SCOPE_STALE" || error.code === "RETRIEVAL_AUTHORITY_STALE" ? "RESEARCH_AUTHORITY_STALE" : "RESEARCH_CONFLICT";
  fail(code, error.message, status, status === 503);
}
export function createResearchQueryService(env: Pick<Env, "CORE_DB" | "SEARCH_DB" | "EVIDENCE_BUCKET"> & { readonly AI_SEARCH?: Env["AI_SEARCH"] }, options?: ResearchQueryOptions): { query(context: AuthenticatedRequestContext, request: QueryRequest): Promise<QueryResult> } {
  const profile = options?.scopeProfile ?? { version: RETRIEVAL_SCOPE_PROFILE_VERSION, max_sources: RETRIEVAL_SCOPE_MAX_SOURCES, max_results: RETRIEVAL_SCOPE_MAX_RESULTS };
  if (profile.max_sources > RETRIEVAL_SCOPE_MAX_SOURCES || profile.max_results > RETRIEVAL_SCOPE_MAX_RESULTS) fail("RESEARCH_PROFILE_UNSUPPORTED", "research.query scope profile exceeds the metadata-Lens bound", 422);
  return {
    async query(context, request) {
      const parsed = parseResearchQueryRequest(request);
      if (context.client_class !== "owner_pwa" && parsed.product !== "FAST_SEARCH") {
        fail("RESEARCH_PROFILE_UNSUPPORTED", "delegated research.query currently supports FAST_SEARCH only", 422);
      }
      const key = idempotencyKey(context);
      const delegated = context.client_class === "owner_pwa" ? undefined
        : await createProjectClientScopeAuthority(env.CORE_DB, context, parsed.scope_expression);
      if (context.request.signal.aborted) fail("RESEARCH_CANCELLED", "research query is cancelled", 409);
      const access = { principal_ref: context.principal_ref, client_class: context.client_class, credential_generation: context.credential_generation };
      const scopePorts = createD1ScopePorts(env.CORE_DB, access);
      const store = createD1RetrievalResultStore(env.CORE_DB, access);
      // Replay precedes the freeze: the frozen scope carries its creation instant, so a re-freeze
      // never reproduces the stored digest. A stored result replays from its own frozen scope.
      const prior = await store.load(key).catch(mapRetrievalError);
      if (prior !== null) {
        const scope = prior.result.trace.scope_snapshot;
        await delegated?.requireScopeCurrent(scope);
        await scopePorts.requireCurrentScope(scope).catch(mapRetrievalError);
        await createD1ScopeProfilePort(env.CORE_DB).requireBinding(scope, profile).catch(mapRetrievalError);
        // The persisted snapshot retains the canonical request expression. Equal current
        // members do not make PROJECT, GLOBAL and SELECTED_SOURCES interchangeable.
        // Compare before freezing or writing; legacy result/trace bytes stay unchanged.
        if (scopeExpressionIdentity(parsed.scope_expression) !== scopeExpressionIdentity(scope.resolved_scope_expression)) {
          fail("RESEARCH_CONFLICT", "idempotency identity is bound to a different scope expression", 409);
        }
        const digest = await retrievalRequestDigest({ raw_query: parsed.query, product: parsed.product, literals: [...parsed.literals], requested_limit: parsed.max_results, scope_digest: scope.digest });
        if (digest !== prior.request_digest) fail("RESEARCH_CONFLICT", "idempotency identity is bound to different inputs", 409);
        // Hashing yields; do not disclose cached bytes after a concurrent revoke/cancel.
        await scopePorts.requireCurrentScope(scope).catch(mapRetrievalError);
        await delegated?.requireScopeCurrent(scope);
        if (context.request.signal.aborted) fail("RESEARCH_CANCELLED", "research query is cancelled", 409);
        return { evidence_pack: prior.result.evidence_pack, trace_ref: prior.result.trace.trace_ref };
      }
      // Read authorization before reserving work: a denied scope fails with zero D1 writes and no
      // grant; an expired scope fails at the currentness recheck with nothing retrieval persisted.
      const authority = delegated?.authority ?? createOwnerScopeAuthority(env.CORE_DB, context);
      await authority.requireReadPolicy();
      const freezer = createD1ScopeService(env.CORE_DB, authority, { max_snapshot_members: profile.max_sources,
        ...(delegated === undefined ? {} : { preserve_resolution_errors: true }) });
      const snapshot = await freezer.freeze(parsed.scope_expression, context.credential_generation);
      await createD1ScopeProfilePort(env.CORE_DB).recordBinding(snapshot, profile).catch(mapRetrievalError);
      // Pre-grant currentness runs through the scope service; the D1 retrieval ports below require
      // the grant, so the post-grant recheck runs through them instead.
      await freezer.requireCurrent(snapshot);
      await authority.grant(snapshot);
      await delegated?.requireScopeCurrent(snapshot);
      await scopePorts.requireCurrentScope(snapshot);
      const deadlineMs = Date.now() + RETRIEVAL_QUERY_BUDGET_MS;
      const result = await retrieveWithHeldScope(env, {
        access,
        scope_snapshot: snapshot,
        raw_query: parsed.query,
        product: parsed.product,
        literals: [],
        requested_limit: parsed.max_results,
        deadline_ms: deadlineMs,
        idempotency_key: key,
        signal: context.request.signal,
        profile,
      }).catch(mapRetrievalError);
      await delegated?.requireScopeCurrent(snapshot);
      if (context.request.signal.aborted) fail("RESEARCH_CANCELLED", "research query is cancelled", 409);
      return { evidence_pack: result.evidence_pack, trace_ref: result.trace.trace_ref };
    },
  };
}
function mapLedger(error: unknown): never { if (error instanceof ResearchServiceError) throw error; if (error instanceof LedgerError) { if (error.code === "LEDGER_INPUT_INVALID") fail("RESEARCH_INPUT_INVALID", error.message); if (error.code === "LEDGER_CONFLICT" || error.code === "LEDGER_STALE_HEAD") fail("RESEARCH_CONFLICT", error.message, 409); if (error.code === "LEDGER_PRINCIPAL_DENIED" || error.code === "LEDGER_SCOPE_FOREIGN" || error.code === "LEDGER_VERIFIER_DENIED") fail("RESEARCH_AUTHORITY_STALE", error.message, 403); if (error.code === "LEDGER_SETTLEMENT_UNCERTAIN" || error.code === "LEDGER_HANDLE_MISSING") fail("RESEARCH_SETTLEMENT_UNCERTAIN", error.message, 503, true); fail("RESEARCH_AUTHORITY_STALE", error.message, 409); } throw error; }
function portsFor(database: D1Database, operationId: string): WorkflowExecutionPorts { const grants = new Map<string, { receipt_ref: string; expires_at_ms: number }>(); return { async authorizeResidency(request, actor): Promise<void> { if (request.operation_id !== operationId || request.input_manifest.residency.access_domain_id !== actor.principal_ref) { const error = new Error("WORKFLOW_AUTHORITY_STALE") as Error & { code: string }; error.code = request.operation_id !== operationId ? "WORKFLOW_CONFLICT" : "WORKFLOW_AUTHORITY_STALE"; throw error; } }, async checkBudget(request) { const k = `${request.operation_id}:${request.stage}`; const cached = grants.get(k); if (cached !== undefined && cached.expires_at_ms > Date.now()) return cached; const grant = { receipt_ref: `research-budget:${request.operation_id}:${request.stage}`, expires_at_ms: Date.now() + researchStageBudgetLeaseMs(request.stage) }; grants.set(k, grant); return grant; } }; }
async function shaHex(text: string): Promise<string> { return digest(new TextEncoder().encode(text)); }
async function scopedPolicyGeneration(policyAuthorityRef: string): Promise<string> {
  const value = `${POLICY_GEN}:${await shaHex(policyAuthorityRef)}`;
  if (!ID_RE.test(value)) fail("RESEARCH_AUTHORITY_STALE", "policy authority generation is invalid", 409);
  return value;
}
function logicalMatch(head: { investigation_id: string; goal: string; scope_snapshot_id: string; scope_snapshot_revision: number; evidence_grade: string; lane: string; portfolio_ref: string; principal_ref: string; input_digest: string; policy_generation: string; policy_authority_ref: string; deployment_generation: string; idempotency_key: string; model_profile_ref: string }, want: { investigation_id: string; goal: string; scope_snapshot_id: string; scope_snapshot_revision: number; evidence_grade: string; lane: string; portfolio_ref: string; principal_ref: string; input_digest: string; policy_generation: string; policy_authority_ref: string; deployment_generation: string; idempotency_key: string }): boolean { return head.investigation_id === want.investigation_id && head.goal === want.goal && head.scope_snapshot_id === want.scope_snapshot_id && head.scope_snapshot_revision === want.scope_snapshot_revision && head.evidence_grade === want.evidence_grade && head.lane === want.lane && head.portfolio_ref === want.portfolio_ref && head.principal_ref === want.principal_ref && head.input_digest === want.input_digest && head.policy_generation === want.policy_generation && head.policy_authority_ref === want.policy_authority_ref && head.deployment_generation === want.deployment_generation && head.idempotency_key === want.idempotency_key && head.model_profile_ref === MODEL_PROFILE; }
function mapRunStatusFailure(error: unknown): never {
  if (error instanceof ResearchServiceError) throw error;
  if (error instanceof WorkflowCheckpointError) {
    if (error.code === "WORKFLOW_AUTHORITY_STALE") fail("RESEARCH_AUTHORITY_STALE", "research run authority is no longer current", 409);
    if (error.code === "WORKFLOW_OUTPUT_CORRUPT") fail("RESEARCH_RUN_STATUS_INVALID", "research result readback is inconsistent", 409);
    if (error.code === "WORKFLOW_INPUT_INVALID") fail("RESEARCH_INPUT_INVALID", "research run status input is invalid", 400);
    fail("RESEARCH_RUN_STATUS_UNAVAILABLE", "research run status readback is unavailable", 503, true);
  }
  if (error instanceof RetrievalQueryError) {
    if (error.code === "RETRIEVAL_AUTHORITY_STALE" || error.code === "RETRIEVAL_SCOPE_STALE") {
      fail("RESEARCH_AUTHORITY_STALE", "research run authority is no longer current", 409);
    }
    fail("RESEARCH_RUN_STATUS_UNAVAILABLE", "research run authority readback is unavailable", 503, true);
  }
  if (error instanceof ResearchMaterializeOutputError) {
    if (error.code === "MATERIALIZE_OUTPUT_AUTHORITY_STALE") fail("RESEARCH_AUTHORITY_STALE", "research materialization authority is no longer current", 409);
    if (error.code === "MATERIALIZE_OUTPUT_CORRUPT") fail("RESEARCH_RUN_STATUS_INVALID", "research materialization readback is inconsistent", 409);
    if (error.code === "MATERIALIZE_OUTPUT_INPUT_INVALID") fail("RESEARCH_INPUT_INVALID", "research materialization reference is invalid", 400);
    fail("RESEARCH_RUN_STATUS_UNAVAILABLE", "research materialization readback is unavailable", 503, true);
  }
  throw error;
}
async function readResearchRunStatus(env: Env, context: AuthenticatedRequestContext, workflowInstanceId: string): Promise<ResearchRunStatus> {
  const operationId = checkId(workflowInstanceId, "workflow_instance_id");
  const principal: WorkflowPrincipal = {
    principal_ref: context.principal_ref,
    credential_generation: context.credential_generation,
    deployment_generation: env.DEPLOYMENT_GENERATION,
  };
  const recheckAuthority = async () => {
    const held = await loadHeldResearchScope({ CORE_DB: env.CORE_DB, SEARCH_DB: env.SEARCH_DB }, {
      principal_ref: context.principal_ref, client_class: context.client_class,
      credential_generation: context.credential_generation,
    } as const, operationId, env.DEPLOYMENT_GENERATION).catch(mapRunStatusFailure);
    return {
      investigation_id: held.investigation_id,
      scope_snapshot_id: held.scope_snapshot_ref.id,
      scope_snapshot_revision: held.scope_snapshot_ref.revision,
    };
  };
  const isOwner = context.client_class === "owner_pwa";
  const delegated = isOwner ? null : await prepareProjectClientRunRead(env, context, operationId).catch(mapRunStatusFailure);
  if (!isOwner && delegated === null) fail("RESEARCH_RUN_NOT_FOUND", "research run does not exist", 404);
  const refreshed = isOwner ? await prepareReauthenticatedRunRead(env, context, operationId).catch(mapRunStatusFailure) : null;
  const status = delegated?.status ?? refreshed?.status ?? await readStoredResearchRunStatus({
    database: env.CORE_DB, operation_id: operationId, principal, recheck_authority: recheckAuthority,
  }).catch(mapRunStatusFailure);
  if (status === null) fail("RESEARCH_RUN_NOT_FOUND", "research run does not exist", 404);
  const engine = status.state === "ACTIVE" ? await readResearchEngineStatus(env, operationId) : undefined;
  const failure = researchRunFailure(status, engine);
  const generation = delegated?.handler_generation ?? refreshed?.handler_generation ?? (await env.CORE_DB.prepare(
    "SELECT handler_generation FROM research_workflow_run WHERE operation_id=?1 AND principal_ref=?2",
  ).bind(operationId, context.principal_ref).first<{ handler_generation: string }>())?.handler_generation;
  let answer: ResearchRunStatus["answer"] = { availability: "unavailable" };
  if (delegated !== null) {
    if (isSemanticResearchHandlerGeneration(generation)) {
      answer = await readProjectClientRunAnswer(env, context, delegated, generation).catch(mapRunStatusFailure);
    }
    await delegated.requireCurrent().catch(mapRunStatusFailure);
  } else if (refreshed !== null) {
    if (isSemanticResearchHandlerGeneration(generation)) {
      answer = await readReauthenticatedRunAnswer(env, context, refreshed, generation).catch(mapRunStatusFailure);
    }
    await refreshed.requireCurrent().catch(mapRunStatusFailure);
  } else if (status.state === "ENGINE_COMPLETED" && isSemanticResearchHandlerGeneration(generation)) {
    const completed = await readCommittedResearchRunResult({
      database: env.CORE_DB,
      work_bucket: env.WORK_BUCKET,
      operation_id: operationId,
      principal,
      materialize_handler_generation: generation,
      recheck_authority: recheckAuthority,
    }).catch(mapRunStatusFailure);
    if (completed !== null) answer = { availability: "draft", artifact_ref: completed.materialization.materialization.draft.artifact_ref };
  }
  return {
    protocol: failure === undefined ? "eliotr.research-run-status.v1" : "eliotr.research-run-status.v2",
    workflow_instance_id: status.operation_id,
    investigation_ref: { id: status.investigation_id, revision: status.current_revision },
    execution_state: status.state,
    ...(engine === undefined ? {} : {
      engine_status: engine.status,
      ...(failure === undefined ? {} : { failure }),
    }),
    next_stage_index: status.next_stage_index,
    answer,
    ...(status.cancellation_receipt_ref === null ? {} : { cancellation_receipt_ref: status.cancellation_receipt_ref }),
  };
}
export function createResearchRunService(env: Env): { run(context: AuthenticatedRequestContext, request: QueryRequest): Promise<{ investigation_ref: VersionedRef; workflow_instance_id: string }>; runStatus(context: AuthenticatedRequestContext, workflowInstanceId: string): Promise<ResearchRunStatus> } {
  return {
    async run(context, raw) {
      const request = parseResearchRunRequest(raw);
      const installedProtocol = request.inquiry_protocol_ref === undefined ? null : installedInquiryProtocolDefinition(request.inquiry_protocol_ref);
      if (context.client_class !== "owner_pwa" && installedProtocol !== null && installedProtocol.lane !== "exploratory") {
        fail("RESEARCH_PRODUCT_UNSUPPORTED", "Machine Research currently supports the exploratory protocol lane", 400);
      }
      const inputGeneration = await env.CORE_DB.prepare("SELECT value FROM schema_state WHERE key='research_question_generation'").first<string>("value");
      if (inputGeneration !== "research-question-v2-utf8-envelopes") fail("RESEARCH_INPUT_SCHEMA_MISMATCH", "Research input requires Core migration 0069", 503);
      const key = idempotencyKey(context);
      const requestDigest = await shaHex(JSON.stringify(request));
      const base = await shaHex(`${context.principal_ref}|${key}|${requestDigest}`);
      const hex = base.slice(0, 48);
      const investigation_id = checkId(`research-${hex}`, "investigation_id");
      const operation_id = checkId(`run-${hex}`, "operation_id");
      const delegated = context.client_class === "owner_pwa" ? undefined
        : await prepareClientResearchAdmission(env, context, request, operation_id);
      const db = env.CORE_DB;
      const bucket = env.WORK_BUCKET;
      const store = createD1InvestigationLedgerStore(db as unknown as LedgerD1Database);
      // An unavailable identity lookup is not permission to freeze another scope.
      const pre = await store.readByIdempotency(key).catch(() =>
        fail("RESEARCH_SETTLEMENT_UNCERTAIN", "research identity readback is unavailable", 503, true));
      if (pre !== null && (pre.head.investigation_id !== investigation_id ||
          pre.head.principal_ref !== context.principal_ref)) {
        fail("RESEARCH_CONFLICT", "idempotency identity is bound to a different request", 409);
      }
      if (pre === null && !researchSemanticConfigurationInstalled(env)) {
        fail("RESEARCH_AGENT_NOT_CONFIGURED", "Research agents require the installed model, prompt and report configuration", 503);
      }
      const scopeRef = await prepareResearchRunScope(env, context, request, operation_id, requestDigest,
        pre === null ? undefined : { id: pre.head.scope_snapshot_id, revision: pre.head.scope_snapshot_revision }, delegated)
        .catch(mapRetrievalError);
      const snapshotRow = await db.prepare("SELECT policy_authority_ref, purge_ledger_revision FROM scope_snapshot WHERE snapshot_id = ?1 AND revision = ?2").bind(scopeRef.id, scopeRef.revision).first<{ policy_authority_ref: string; purge_ledger_revision: number }>();
      if (!snapshotRow || typeof snapshotRow.policy_authority_ref !== "string") fail("RESEARCH_AUTHORITY_STALE", "scope snapshot is unavailable", 409);
      const priorWorkflow = pre === null ? null : await db.prepare("SELECT handler_generation FROM research_workflow_run WHERE idempotency_key = ?1")
        .bind(key).first<{ handler_generation: string }>();
      const supportedGenerations = new Set([HANDLER_GEN, SERVER_OWNED_RESEARCH_HANDLER_GENERATION, SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION, SERVER_OWNED_FREEZE_HANDLER_GENERATION, SERVER_OWNED_SEMANTIC_HANDLER_GENERATION, SERVER_OWNED_LEGACY_PROTOCOL_HANDLER_GENERATION, SERVER_OWNED_PROTOCOL_HANDLER_GENERATION]);
      // A machine's first admission may stop after W1 but before W2. No stage can
      // have run without W2; resume that exact initial head, never freeze a new scope.
      const interruptedMachineAdmission = delegated !== undefined && pre?.head.revision === 1 && priorWorkflow === null;
      if (pre !== null && !interruptedMachineAdmission && (priorWorkflow === null || !supportedGenerations.has(priorWorkflow.handler_generation))) {
        fail("RESEARCH_CONFLICT", "persisted workflow handler generation is unsupported", 409);
      }
      const currentPolicy = await db.prepare("SELECT policy_generation, state FROM investigation_current_policy WHERE policy_authority_ref = ?1 ORDER BY CASE state WHEN 'ACTIVE' THEN 0 ELSE 1 END LIMIT 1")
        .bind(snapshotRow.policy_authority_ref).first<{ policy_generation: string; state: "ACTIVE" | "RETIRED" }>();
      if (currentPolicy?.state === "RETIRED") fail("RESEARCH_AUTHORITY_STALE", "scope policy authority is retired", 409);
      const newPolicyGeneration = pre?.head.policy_generation ?? currentPolicy?.policy_generation ?? await scopedPolicyGeneration(snapshotRow.policy_authority_ref);
      const now = new Date().toISOString();
      if (currentPolicy === null) {
        await db.prepare("INSERT OR IGNORE INTO investigation_current_policy (policy_generation, policy_authority_ref, state, created_at) VALUES (?1,?2,'ACTIVE',?3)").bind(newPolicyGeneration, snapshotRow.policy_authority_ref, now).run().catch(mapLedger);
      }
      await db.prepare("INSERT OR IGNORE INTO investigation_current_deployment (deployment_generation, state, created_at) VALUES (?1,'ACTIVE',?2)").bind(env.DEPLOYMENT_GENERATION, now).run().catch(mapLedger);
      const evidenceAuthority = createD1EvidenceAuthorityPort({ core_database: db, search_database: env.SEARCH_DB });
      const scopeAuthority = await evidenceAuthority.loadScope(scopeRef);
      if (scopeAuthority === null) fail("RESEARCH_AUTHORITY_STALE", "scope snapshot is unavailable", 409);
      const planningSources = installedProtocol === null
        ? []
        : await loadResearchPlanningSources(
          db,
          scopeAuthority.snapshot.member_source_revision_refs,
          scopeAuthority.snapshot.source_owner_generations,
        );
      const planningManifest = installedProtocol === null
        ? undefined
        : await createResearchPlanningManifest({
          investigation_id,
          operation_id,
          question: request.query,
          inquiry_protocol_ref: installedProtocol.definition_ref,
          scope_snapshot_ref: scopeRef,
          scope_created_at: scopeAuthority.snapshot.created_at,
          definition: installedProtocol,
          sources: planningSources,
        });
      const payloadKey = `research-payload-${hex}`;
      const payloadBytes = new TextEncoder().encode(JSON.stringify({
        investigation_id, operation_id, query: request.query, scope_snapshot_ref: scopeRef,
        evidence_grade: request.evidence_grade, principal_ref: context.principal_ref,
        ...(request.inquiry_protocol_ref === undefined ? {} : { inquiry_protocol_ref: request.inquiry_protocol_ref }),
        ...(planningManifest === undefined ? {} : { planning_manifest: planningManifest }),
      }));
      if (payloadBytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) {
        fail("RESEARCH_INPUT_LIMIT", `research workflow input exceeds ${MAX_WORKFLOW_RECEIPT_BYTES} UTF-8 bytes; partition the requested scope or shorten the question`, 413);
      }
      const payloadHash = await digest(payloadBytes);
      if ((await bucket.head(payloadKey).catch(() => null)) === null) {
        await bucket.put(payloadKey, payloadBytes, { sha256: payloadHash });
      }
      const currentPayload = await bucket.get(payloadKey).catch(() => null);
      if (currentPayload === null) fail("RESEARCH_SETTLEMENT_UNCERTAIN", "payload readback is unavailable", 503, true);
      const currentPayloadBytes = new Uint8Array(await currentPayload.arrayBuffer());
      if ((await digest(currentPayloadBytes)) !== payloadHash || currentPayloadBytes.byteLength !== payloadBytes.byteLength) {
        fail("RESEARCH_CONFLICT", "idempotency identity is bound to different bytes", 409);
      }
      const principal: WorkflowPrincipal = { principal_ref: context.principal_ref, credential_generation: context.credential_generation, deployment_generation: env.DEPLOYMENT_GENERATION };
      const installedObligations = installedProtocol === null ? [] : compileInquiryLedgerObligations(installedProtocol);
      // Existing confirmatory heads retain their original generation for historical replay;
      // new server-owned runs use the authority-bound generation above.
      const policyGeneration = pre?.head.policy_generation === POLICY_GEN ? POLICY_GEN : newPolicyGeneration;
      const lane = pre === null ? installedProtocol?.lane ?? "exploratory" :
        pre.head.lane === "confirmatory" || pre.head.lane === "exploratory" || pre.head.lane === "mixed_with_declared_split" ? pre.head.lane : null;
      if (lane === null) fail("RESEARCH_CONFLICT", "idempotency identity has an unsupported investigation lane", 409);
      if (pre !== null && lane === "exploratory" && priorWorkflow?.handler_generation === HANDLER_GEN) {
        fail("RESEARCH_CONFLICT", "exploratory workflow uses a confirmatory handler generation", 409);
      }
      if (pre !== null && lane === "confirmatory" && priorWorkflow?.handler_generation !== HANDLER_GEN) {
        fail("RESEARCH_CONFLICT", "confirmatory workflow uses a server-owned handler generation", 409);
      }
      const handlerGeneration = lane === "exploratory"
        ? priorWorkflow?.handler_generation ?? (request.inquiry_protocol_ref === undefined
          ? SERVER_OWNED_SEMANTIC_HANDLER_GENERATION
          : SERVER_OWNED_PROTOCOL_HANDLER_GENERATION)
        : HANDLER_GEN;
      const wantHead = { investigation_id, goal: request.query, scope_snapshot_id: scopeRef.id, scope_snapshot_revision: scopeRef.revision, evidence_grade: request.evidence_grade, lane, portfolio_ref: payloadKey, principal_ref: context.principal_ref, input_digest: payloadHash, policy_generation: policyGeneration, policy_authority_ref: snapshotRow.policy_authority_ref, deployment_generation: env.DEPLOYMENT_GENERATION, idempotency_key: key };
      let skipCreate = false;
      if (pre !== null) {
        if (pre.head.investigation_id !== investigation_id || !logicalMatch(pre.head, wantHead)) fail("RESEARCH_CONFLICT", "idempotency identity is bound to different bytes", 409);
        skipCreate = true;
      }
      const fences = { current: async () => { const globalRow = await (db as unknown as LedgerD1Database).prepare("SELECT COALESCE(MAX(ledger_revision), 0) AS n FROM purge_ledger").bind().first<{ n: number }>(); return { principal_ref: context.principal_ref, scope_snapshot_id: scopeRef.id, scope_snapshot_revision: scopeRef.revision, policy_generation: policyGeneration, policy_authority_ref: snapshotRow.policy_authority_ref, deployment_generation: env.DEPLOYMENT_GENERATION, purge_revision: globalRow?.n ?? 0, scope_purge_revision: snapshotRow.purge_ledger_revision ?? 0 }; } };
      const handles = { has: async (ref: string) => (await bucket.head(ref).catch(() => null)) !== null, digestFor: async (ref: string) => { const head = await bucket.head(ref).catch(() => null); if (head === null) return null; const raw = (head as unknown as { checksums?: { sha256?: unknown } }).checksums?.sha256; if (raw instanceof ArrayBuffer) return Array.from(new Uint8Array(raw), (b) => b.toString(16).padStart(2, "0")).join(""); return payloadHash; } };
      const ledger = createInvestigationLedgerService(store, fences, handles);
      const eventId = checkId(`evt-${hex}`, "event_id");
      if (!skipCreate) {
        try {
          await ledger.create({ investigation_id, goal: request.query, scope_snapshot_id: scopeRef.id, scope_snapshot_revision: scopeRef.revision, evidence_grade: request.evidence_grade, lane, lane_registrations: [], obligations: installedObligations, hypotheses: planningManifest?.hypotheses.map((item) => item.hypothesis_id) ?? [], portfolio_ref: payloadKey, debt_refs: [], principal_ref: context.principal_ref, input_digest: payloadHash, policy_generation: policyGeneration, policy_authority_ref: snapshotRow.policy_authority_ref, deployment_generation: env.DEPLOYMENT_GENERATION, idempotency_key: key, model_profile_ref: MODEL_PROFILE, event_id: eventId, payload_handle_ref: payloadKey, payload_digest: payloadHash, created_at: now });
        } catch (error) {
          if (error instanceof LedgerError && (error.code === "LEDGER_CONFLICT" || error.code === "LEDGER_STALE_HEAD")) {
            const existing = await store.readByIdempotency(key).catch(() => null);
            if (existing === null || existing.head.investigation_id !== investigation_id || !logicalMatch(existing.head, wantHead)) fail("RESEARCH_CONFLICT", "idempotency identity is bound to different bytes", 409);
            skipCreate = true;
          } else mapLedger(error);
        }
      }
      void skipCreate;
      const initialManifest: WorkflowObject = WorkflowObjectSchema.parse({ object_ref: payloadKey, sha256: payloadHash, byte_length: payloadBytes.byteLength, residency: { scope_domain_id: scopeRef.id, access_domain_id: context.principal_ref, confidentiality_domain_id: "private", encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1", content_digest: { algorithm: "sha256", digest: payloadHash } } });
      const initialStage: StageRequest = {
        protocol: "eliotr.workflow-stage.v1",
        operation_id,
        investigation_ref: { id: investigation_id, revision: 1 },
        stage: "FREEZE_PROTOCOL_AND_SCOPE",
        idempotency_key: key,
        handler_generation: handlerGeneration,
        input_manifest: initialManifest,
      };
      if (lane === "exploratory" && (handlerGeneration === SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION || isSemanticResearchHandlerGeneration(handlerGeneration))) {
        await createD1ScopeProfilePort(db).recordBinding(scopeAuthority.snapshot, {
          ...await readOwnerScopeProfile(db, scopeAuthority.snapshot),
          max_results: request.max_results,
        }).catch(mapRetrievalError);
      }
      try {
        // Reserve the first durable status before creating the Workflow instance so
        // the owner can immediately poll ACTIVE/next_stage_index=0 after launch.
        await delegated?.requireScopeCurrent(scopeAuthority.snapshot);
        if (delegated) await requireClientResearchExecution(env, context, scopeAuthority.snapshot, operation_id, env.DEPLOYMENT_GENERATION);
        if (context.request.signal.aborted) fail("RESEARCH_CANCELLED", "Research admission was cancelled", 409);
        await new WorkflowCheckpointStore(db).ensureRun(initialStage, principal);
        const workflowParams: ResearchWorkflowRunParams = {
          operation_id,
          investigation_ref: { id: investigation_id, revision: 1 },
          idempotency_key: key,
          handler_generation: handlerGeneration,
          initial_input_manifest: initialManifest,
          principal_ref: principal.principal_ref,
          credential_generation: principal.credential_generation,
          deployment_generation: principal.deployment_generation,
          ...(delegated === undefined && isSemanticResearchHandlerGeneration(handlerGeneration)
            ? { qualification_renewal: RESEARCH_QUALIFICATION_RENEWAL_MARKER }
            : {}),
        };
        await delegated?.requireScopeCurrent(scopeAuthority.snapshot);
        if (delegated) await requireClientResearchExecution(env, context, scopeAuthority.snapshot, operation_id, env.DEPLOYMENT_GENERATION);
        let instance: WorkflowInstance;
        try {
          instance = await env.RESEARCH_WORKFLOW.create({ id: operation_id, params: workflowParams });
        } catch {
          // A lost create ACK is reconciled against the deterministic instance ID;
          // never create a second Workflow for the same idempotency identity.
          instance = await env.RESEARCH_WORKFLOW.get(operation_id);
        }
        if (instance.id !== operation_id) fail("RESEARCH_SETTLEMENT_UNCERTAIN", "workflow instance readback is unavailable", 503, true);
        const instanceStatus = await instance.status();
        if (instanceStatus.status === "unknown") fail("RESEARCH_SETTLEMENT_UNCERTAIN", "workflow instance status is unavailable", 503, true);
      } catch (error) {
        if (error instanceof ResearchServiceError) throw error;
        const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "WORKFLOW_EFFECT_UNCERTAIN";
        if (code === "RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID") fail("RESEARCH_INPUT_INVALID", code, 400);
        if (code === "RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE") fail("RESEARCH_AUTHORITY_STALE", code, 409);
        if (code === "RESEARCH_PROTOCOL_FREEZE_AUTHORITY_INVALID") fail("RESEARCH_CONFLICT", code, 409);
        if (code === "WORKFLOW_CONFLICT" || code === "WORKFLOW_STAGE_OUT_OF_ORDER" || code === "WORKFLOW_INPUT_INVALID") fail("RESEARCH_CONFLICT", code, 409);
        if (code === "WORKFLOW_AUTHORITY_STALE") fail("RESEARCH_AUTHORITY_STALE", code, 409);
        if (code === "WORKFLOW_CANCELLED") fail("RESEARCH_CANCELLED", code, 409);
        if (code === "WORKFLOW_BUDGET_STOP") fail("RESEARCH_BUDGET_STOP", code, 409);
        fail("RESEARCH_SETTLEMENT_UNCERTAIN", code, 503, true);
      }
      return { investigation_ref: { id: investigation_id, revision: 1 }, workflow_instance_id: operation_id };
    },
    runStatus: (context, workflowInstanceId) => readResearchRunStatus(env, context, workflowInstanceId),
  };
}
interface SessionRecord { protocol: typeof RESEARCH_SESSION_PROTOCOL; session_id: string; investigation_id: string; investigation_revision: number; operation_id: string; idempotency_key: string; handler_generation: string; principal_ref: string; credential_generation: string; deployment_generation: string; state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED"; receipt_refs: readonly string[]; output_manifest_ref: string | null; updated_at: string; }
function callerOf(request: Request, body?: Record<string, unknown>): WorkflowPrincipal { const pick = (name: string, fallback?: unknown) => request.headers.get(name) ?? (typeof fallback === "string" ? fallback : undefined); const principal_ref = pick("x-research-principal", body?.principal_ref); const credential_generation = pick("x-research-credential", body?.credential_generation); const deployment_generation = pick("x-research-deployment", body?.deployment_generation); if (typeof principal_ref !== "string" || typeof credential_generation !== "string" || typeof deployment_generation !== "string") fail("RESEARCH_INPUT_INVALID", "research session caller identity is required"); return { principal_ref, credential_generation, deployment_generation }; }
function json(request: Request, value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function problem(request: Request, status: number, code: string, retryable = status === 503): Response { return json(request, { code, trace_id: request.headers.get("cf-ray") ?? crypto.randomUUID(), retryable }, status); }
function workflowProblem(request: Request, error: WorkflowCheckpointError): Response {
  const code = error.failure?.code ?? error.code;
  const conflict = ["WORKFLOW_CONFLICT", "WORKFLOW_STAGE_OUT_OF_ORDER", "WORKFLOW_AUTHORITY_STALE", "WORKFLOW_CANCELLED", "WORKFLOW_BUDGET_STOP"].includes(error.code);
  return problem(request, error.code === "WORKFLOW_INPUT_INVALID" ? 400 : conflict ? 409 : 503,
    code, error.failure?.retryable === true);
}
export class ResearchSession extends DurableObject<Env> {
  private load(id: string): Promise<SessionRecord | null> { return this.ctx.storage.get<SessionRecord>(`session:${id}`).then((value) => value ?? null); }
  private save(record: SessionRecord): Promise<void> { if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 256 * 1024) fail("RESEARCH_INPUT_LIMIT", "session state exceeds its persist bound", 413); return this.ctx.storage.put(`session:${record.session_id}`, record); }
  /** Short storage-only transaction: an old execute callback must not overwrite a
   * terminal decision published by another request. D1 remains the authority. */
  private async settleTerminal(
    expected: SessionRecord,
    change: Pick<SessionRecord, "state"> & Partial<Pick<SessionRecord, "investigation_revision" | "receipt_refs" | "output_manifest_ref">>,
  ): Promise<SessionRecord> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = `session:${expected.session_id}`;
      const current = await transaction.get<SessionRecord>(key);
      if (current === undefined || current.operation_id !== expected.operation_id ||
          current.investigation_id !== expected.investigation_id || current.principal_ref !== expected.principal_ref ||
          current.credential_generation !== expected.credential_generation ||
          current.deployment_generation !== expected.deployment_generation) {
        throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE");
      }
      if (current.state !== "ACTIVE") {
        if (current.state !== change.state) throw new WorkflowCheckpointError("WORKFLOW_CONFLICT");
        return current;
      }
      const next: SessionRecord = { ...current, ...change, updated_at: new Date().toISOString() };
      if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 256 * 1024) {
        fail("RESEARCH_INPUT_LIMIT", "session state exceeds its persist bound", 413);
      }
      await transaction.put(key, next);
      return next;
    });
  }
  public override async fetch(request: Request): Promise<Response> { const url = new URL(request.url); try { if (url.pathname === "/status") { if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return problem(request, 501, "SESSION_WEBSOCKET_PENDING"); return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, state: "READY", persisted_state_authoritative: true, durable_copy_location: "DO storage + D1 Core + R2 checkpoints" }); } if (url.pathname === "/session/start" && request.method === "POST") return await this.start(request); const match = url.pathname.match(/^\/session\/([^/]+)(\/(run|cancel))?$/u); const sid = match?.[1]; if (sid === undefined) return problem(request, 501, "SESSION_IMPLEMENTATION_PENDING"); checkId(sid, "session_id"); if (request.method === "GET" && (match?.[2] ?? null) === null) return await this.read(request, sid); if (request.method === "POST" && match?.[3] === "run") return await this.execute(request, sid); if (request.method === "POST" && match?.[3] === "cancel") return await this.cancel(request, sid); return problem(request, 501, "SESSION_IMPLEMENTATION_PENDING"); } catch (error) { if (error instanceof ResearchServiceError) return problem(request, error.status, error.code, error.retryable); if (error instanceof WorkflowCheckpointError && error.failure !== undefined) return workflowProblem(request, error); const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "INTERNAL_ERROR"; if (code === "WORKFLOW_CONFLICT" || code === "WORKFLOW_CANCELLED" || code === "WORKFLOW_AUTHORITY_STALE" || code === "WORKFLOW_BUDGET_STOP") return problem(request, 409, code); if (code.startsWith("WORKFLOW_") || code.startsWith("LEDGER_")) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN"); return problem(request, 500, "INTERNAL_ERROR"); } }
  private async start(request: Request): Promise<Response> { let body: unknown; try { body = await request.json(); } catch { return problem(request, 400, "RESEARCH_INPUT_INVALID"); } if (typeof body !== "object" || body === null) return problem(request, 400, "RESEARCH_INPUT_INVALID"); const value = body as Record<string, unknown>; const allowed = new Set(["session_id", "investigation_id", "investigation_revision", "operation_id", "idempotency_key", "handler_generation", "initial_input_manifest", "principal_ref", "credential_generation", "deployment_generation"]); if (Object.keys(value).some((key) => !allowed.has(key))) return problem(request, 400, "RESEARCH_INPUT_INVALID"); try { const session_id = checkId(value.session_id, "session_id"); const investigation_id = checkId(value.investigation_id, "investigation_id"); const operation_id = checkId(value.operation_id, "operation_id"); const idempotency_key = checkId(value.idempotency_key, "idempotency_key"); const handler_generation = checkId(value.handler_generation, "handler_generation"); const caller = callerOf(request, value); if (caller.principal_ref !== value.principal_ref || caller.credential_generation !== value.credential_generation || caller.deployment_generation !== value.deployment_generation) return problem(request, 403, "SESSION_FOREIGN"); if (!Number.isSafeInteger(value.investigation_revision) || (value.investigation_revision as number) < 1) return problem(request, 400, "RESEARCH_INPUT_INVALID"); const manifest = WorkflowObjectSchema.safeParse(value.initial_input_manifest); if (!manifest.success || manifest.data.residency.access_domain_id !== caller.principal_ref) return problem(request, 400, "RESEARCH_INPUT_INVALID"); const existing = await this.load(session_id); if (existing !== null) { if (existing.investigation_id !== investigation_id || existing.operation_id !== operation_id || existing.idempotency_key !== idempotency_key || existing.principal_ref !== caller.principal_ref) return problem(request, 409, "SESSION_CONFLICT"); return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id, state: existing.state, operation_id, investigation_ref: { id: existing.investigation_id, revision: existing.investigation_revision } }); } const now = new Date().toISOString(); await this.save({ protocol: RESEARCH_SESSION_PROTOCOL, session_id, investigation_id, investigation_revision: value.investigation_revision as number, operation_id, idempotency_key, handler_generation, principal_ref: caller.principal_ref, credential_generation: caller.credential_generation, deployment_generation: caller.deployment_generation, state: "ACTIVE", receipt_refs: [], output_manifest_ref: null, updated_at: now }); return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id, state: "ACTIVE", operation_id, investigation_ref: { id: investigation_id, revision: value.investigation_revision as number } }); } catch (error) { if (error instanceof ResearchServiceError) return problem(request, error.status, error.code); return problem(request, 400, "RESEARCH_INPUT_INVALID"); } }
  private async read(request: Request, sid: string): Promise<Response> {
    const stored = await this.load(sid);
    if (stored === null) return problem(request, 404, "SESSION_NOT_FOUND");
    let caller: WorkflowPrincipal;
    try { caller = callerOf(request); }
    catch { return problem(request, 400, "RESEARCH_INPUT_INVALID"); }
    if (caller.principal_ref !== stored.principal_ref) return problem(request, 403, "SESSION_FOREIGN");
    if (caller.credential_generation !== stored.credential_generation) return problem(request, 409, "SESSION_AUTHORITY_STALE");
    if (!this.env?.CORE_DB) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    try { await requireResearchDeploymentCompatibility(this.env.CORE_DB, stored.deployment_generation, caller.deployment_generation); }
    catch { return problem(request, 409, "SESSION_AUTHORITY_STALE"); }
    return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id: sid, state: stored.state,
      operation_id: stored.operation_id, investigation_ref: { id: stored.investigation_id, revision: stored.investigation_revision },
      receipt_refs: [...stored.receipt_refs], output_manifest_ref: stored.output_manifest_ref });
  }
  private async execute(request: Request, sid: string): Promise<Response> { const stored = await this.load(sid); if (stored === null) return problem(request, 404, "SESSION_NOT_FOUND"); let caller: WorkflowPrincipal; try { caller = callerOf(request); } catch { return problem(request, 400, "RESEARCH_INPUT_INVALID"); } if (caller.principal_ref !== stored.principal_ref) return problem(request, 403, "SESSION_FOREIGN"); if (caller.credential_generation !== stored.credential_generation) return problem(request, 409, "SESSION_AUTHORITY_STALE"); if (stored.state === "CANCELLED") return problem(request, 409, "SESSION_CANCELLED"); if (stored.state === "ENGINE_COMPLETED") return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id: sid, state: "ENGINE_COMPLETED", operation_id: stored.operation_id, investigation_ref: { id: stored.investigation_id, revision: stored.investigation_revision }, receipt_refs: [...stored.receipt_refs], output_manifest_ref: stored.output_manifest_ref }); const env = this.env; if (!env?.CORE_DB || !env?.SEARCH_DB || !env?.WORK_BUCKET) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN"); try { await requireResearchDeploymentCompatibility(env.CORE_DB, stored.deployment_generation, caller.deployment_generation); } catch { return problem(request, 409, "SESSION_AUTHORITY_STALE"); } const ledgerStore = createD1InvestigationLedgerStore(env.CORE_DB as unknown as LedgerD1Database); const investigation = await ledgerStore.read(stored.investigation_id).catch(() => null); if (investigation === null) return problem(request, 409, "SESSION_AUTHORITY_STALE"); const lane = investigation.head.lane; if (lane !== "exploratory" && lane !== "confirmatory") return problem(request, 409, "SESSION_AUTHORITY_STALE"); const exploratory = lane === "exploratory"; const expectedHandlerGeneration = exploratory ? (isSemanticResearchHandlerGeneration(stored.handler_generation) ? stored.handler_generation : stored.handler_generation === SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION ? SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION : SERVER_OWNED_RESEARCH_HANDLER_GENERATION) : HANDLER_GEN; if (stored.handler_generation !== expectedHandlerGeneration) return problem(request, 409, "SESSION_AUTHORITY_STALE"); const manifestRow = await env.CORE_DB.prepare("SELECT initial_manifest_json FROM research_workflow_run WHERE operation_id = ?1").bind(stored.operation_id).first<{ initial_manifest_json: string }>().catch(() => null); let initialManifest: WorkflowObject; if (manifestRow !== null) { try { initialManifest = WorkflowObjectSchema.parse(JSON.parse(manifestRow.initial_manifest_json)); } catch { return problem(request, 409, "SESSION_AUTHORITY_STALE"); } } else { return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN"); } const principal: WorkflowPrincipal = { principal_ref: stored.principal_ref, credential_generation: stored.credential_generation, deployment_generation: stored.deployment_generation }; let handlers: ReturnType<typeof createResearchStageHandlerFactory>; if (exploratory) { const scopeRef = { id: investigation.head.scope_snapshot_id, revision: investigation.head.scope_snapshot_revision }; const evidence = createD1EvidenceAuthorityPort({ core_database: env.CORE_DB, search_database: env.SEARCH_DB }); const authority = await evidence.loadScope(scopeRef); if (authority === null) return problem(request, 409, "SESSION_AUTHORITY_STALE"); const access = { principal_ref: stored.principal_ref, client_class: "owner_pwa" as const, credential_generation: stored.credential_generation }; const scopePorts = createD1ScopePorts(env.CORE_DB, access); const navigation = createNavigationReadAuthority({ database: env.CORE_DB, scope_snapshot: authority.snapshot, access, require_current: async (scope) => { await scopePorts.requireCurrentScope(scope); return scope; } }); const serverGeneration = stored.handler_generation === SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION ? SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION : SERVER_OWNED_RESEARCH_HANDLER_GENERATION; handlers = isSemanticResearchHandlerGeneration(stored.handler_generation) ? await createResearchSemanticServerHandlers({ env, operation_id: stored.operation_id, investigation_id: stored.investigation_id, principal, navigation, ledger: ledgerStore, initial_manifest: initialManifest }) : createResearchStageHandlerFactory({ kind: "server-owned-exploratory", generation: serverGeneration, navigation, ledger: ledgerStore, environment: env }); } else { handlers = createResearchStageHandlerFactory({ kind: "legacy-deterministic" }); } let receipts: StageReceipt[]; try { const driver = createMonotoneStageExecutor(env.CORE_DB, env.WORK_BUCKET, { ...portsFor(env.CORE_DB, stored.operation_id), ...(handlers.recoverStartedAttempt === undefined ? {} : { recoverStartedAttempt: handlers.recoverStartedAttempt }) }); receipts = await driver.executeOperation({ operation_id: stored.operation_id, investigation_id: stored.investigation_id, initial_revision: stored.investigation_revision, idempotency_key: stored.idempotency_key, handler_generation: stored.handler_generation, initial_input_manifest: initialManifest }, principal, handlers); } catch (error) { const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "SESSION_SETTLEMENT_UNCERTAIN"; if (code === "WORKFLOW_CANCELLED") { const cancelled = await new WorkflowCheckpointStore(env.CORE_DB).readRunStatus(stored.operation_id, principal); if (cancelled?.state !== "CANCELLED") return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN"); await this.settleTerminal(stored, { state: "CANCELLED" }); return problem(request, 409, "SESSION_CANCELLED"); } if (code === "WORKFLOW_CONFLICT" || code === "WORKFLOW_STAGE_OUT_OF_ORDER" || code === "WORKFLOW_INPUT_INVALID" || code === "WORKFLOW_AUTHORITY_STALE" || code === "WORKFLOW_BUDGET_STOP") return problem(request, 409, code); if (error instanceof WorkflowCheckpointError) return workflowProblem(request, error); return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN"); } for (const receipt of receipts) { if (new TextEncoder().encode(JSON.stringify(receipt)).byteLength > MAX_WORKFLOW_RECEIPT_BYTES || "completion_disposition" in receipt) return problem(request, 409, "WORKFLOW_INPUT_INVALID"); } const last = receipts.at(-1); if (!last) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN"); const completed = await new WorkflowCheckpointStore(env.CORE_DB).readRunStatus(stored.operation_id, principal); if (completed?.state !== "ENGINE_COMPLETED" || completed.final_receipt?.receipt_ref !== last.receipt_ref) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN"); await this.settleTerminal(stored, { state: "ENGINE_COMPLETED", investigation_revision: last.investigation_ref.revision, receipt_refs: receipts.map((item) => item.receipt_ref), output_manifest_ref: last.output_manifest.object_ref }); return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id: sid, state: "ENGINE_COMPLETED", operation_id: stored.operation_id, investigation_ref: { ...last.investigation_ref }, receipt_refs: receipts.map((item) => item.receipt_ref), output_manifest_ref: last.output_manifest.object_ref }); }
  private async cancel(request: Request, sid: string): Promise<Response> {
    const stored = await this.load(sid);
    if (stored === null) return problem(request, 404, "SESSION_NOT_FOUND");
    let caller: WorkflowPrincipal;
    try { caller = callerOf(request); }
    catch { return problem(request, 400, "RESEARCH_INPUT_INVALID"); }
    if (caller.principal_ref !== stored.principal_ref) return problem(request, 403, "SESSION_FOREIGN");
    if (caller.credential_generation !== stored.credential_generation) {
      return problem(request, 409, "SESSION_AUTHORITY_STALE");
    }
    if (!this.env?.CORE_DB) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    try { await requireResearchDeploymentCompatibility(this.env.CORE_DB, stored.deployment_generation, caller.deployment_generation); }
    catch { return problem(request, 409, "SESSION_AUTHORITY_STALE"); }
    const storedPrincipal: WorkflowPrincipal = { principal_ref: stored.principal_ref,
      credential_generation: stored.credential_generation, deployment_generation: stored.deployment_generation };
    const store = new WorkflowCheckpointStore(this.env.CORE_DB);
    // Never manufacture a receipt from cached DO state. In particular, a failed
    // canonical cancel is not a best-effort success, even on a repeated request.
    const before = await store.readRunStatus(stored.operation_id, storedPrincipal);
    if (before === null) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    if (before.state === "ENGINE_COMPLETED") return problem(request, 409, "SESSION_CONFLICT");
    const cancellationReceipt = await store.cancel(stored.operation_id, storedPrincipal);
    const after = await store.readRunStatus(stored.operation_id, storedPrincipal);
    if (after?.state !== "CANCELLED" || after.cancellation_receipt_ref !== cancellationReceipt) {
      return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    }
    await this.settleTerminal(stored, { state: "CANCELLED" });
    return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id: sid,
      state: "CANCELLED", operation_id: stored.operation_id, cancellation_receipt_ref: cancellationReceipt });
  }
}
