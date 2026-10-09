import { ORIENTATION_PROFILE, OWNER_RESEARCH_MAX_SELECTED_SOURCES, readOwnerScopeProfile } from "@eliotr/cloudflare-navigation";
import { createD1ScopePorts, createD1ScopeProfilePort } from "@eliotr/retrieval";
import type { ScopeProfileBinding } from "@eliotr/retrieval";
import { createD1EvidenceAuthorityPort } from "@eliotr/cloudflare-evidence";
import { loadHeldResearchScope } from "@eliotr/cloudflare-research-runtime/research-retrieval-composition.js";
import {
  digest,
  RESEARCH_RUN_REQUEST_V2,
  compileInquiryLedgerObligations,
  installedInquiryProtocolDefinition,
  createResearchPlanningManifest,
} from "@eliotr/cloudflare-research";
import type { WorkflowPrincipal } from "@eliotr/cloudflare-research";
import { createD1InvestigationLedgerStore, LedgerError } from "@eliotr/research";
import type { LedgerD1Database } from "@eliotr/research";
import { SERVER_OWNED_RESEARCH_HANDLER_GENERATION, SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION, SERVER_OWNED_FREEZE_HANDLER_GENERATION, SERVER_OWNED_SEMANTIC_HANDLER_GENERATION, SERVER_OWNED_LEGACY_PROTOCOL_HANDLER_GENERATION, SERVER_OWNED_PROTOCOL_HANDLER_GENERATION, SERVER_OWNED_BRANCH_HANDLER_GENERATION, SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION, isSemanticResearchHandlerGeneration, SERVER_RETRIEVAL_SCOPE_PROFILE } from "@eliotr/cloudflare-research-runtime/research-stage-handlers.js";
import { attachResearchRunConfiguration, readResearchRunConfiguration } from "./research-run-configuration.js";
import { resolveResearchRunAdmissionConfiguration } from "./research-run-configuration-admission.js";
import { RESEARCH_QUALIFICATION_RENEWAL_MARKER } from "./research-qualification-renewal.js";
import { isResearchQuestionText, ScopeExpressionSchema, VersionedRefSchema } from "@eliotr/contracts";
import type { VersionedRef } from "@eliotr/contracts";
import { inspectScopeExpression } from "@eliotr/domain";
import type { AuthenticatedRequestContext, QueryRequest, QueryResult, ResearchRunStatus } from "@eliotr/interfaces";
import { ResearchServiceError, failResearch as fail } from "./research-service-error.js";
import { prepareClientResearchAdmission, requireClientResearchExecution } from "./research-client-execution.js";
import { bindComputerAgentRunRoute, ComputerAgentRouteError } from "./computer-agent-route-store.js";
import { loadResearchPlanningSources, prepareResearchRunScope } from "./research-run-admission.js";
import type { Env } from "./env.js";
import { RESEARCH_OWNER_MODEL_PROFILE as MODEL_PROFILE } from "@eliotr/cloudflare-research-configuration/research-owner-profile.js";
import type { ResearchWorkflowRunParams } from "./research-workflow.js";
import { createResearchRunReadEnvironment } from "./research-run-read-authorization.js";
import { createResearchQueryExecutor, mapRetrievalError } from "./research-query-execution-result.js";
import type { McpFastSearchQueryResult, ResearchQueryEnvironment } from "./research-query-execution-result.js";
import {
  createResearchQueryApplication,
  dispatchResearchSessionRunApplication,
  persistResearchSessionRunPayload,
  persistResearchSessionRunApplication,
} from "@eliotr/cloudflare-research-runtime/research-session-application.js";
import { readResearchSessionRunStatusApplication } from "@eliotr/cloudflare-research-runtime/research-session-status-application.js";
import type { ResearchSessionWorkflowDispatchInput } from "@eliotr/cloudflare-research-runtime/research-session-application.js";

const RUN_BUDGET = "research-budget-v1";
const POLICY_GEN = "research-policy-v1";
const HANDLER_GEN = "research-handlers.v1";
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
export function checkId(value: unknown, label: string): string { if (typeof value !== "string" || !ID_RE.test(value)) fail("RESEARCH_INPUT_INVALID", `${label} is invalid`); return value as string; }
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
export interface ResearchQueryOptions { readonly scopeProfile?: ScopeProfileBinding }
function mapComputerAgentRouteError(error: unknown): never {
  if (!(error instanceof ComputerAgentRouteError)) throw error;
  if (error.retryable) {
    fail("RESEARCH_SETTLEMENT_UNCERTAIN",
      "Computer-agent project route is temporarily unavailable", 503, true);
  }
  if (error.status === 403 || error.status === 404) {
    fail("RESEARCH_AUTHORITY_STALE", "Computer-agent project route is not current", 403);
  }
  fail("RESEARCH_CONFLICT", "Computer-agent project route conflicts with this run", 409);
}
export function createResearchQueryService(env: ResearchQueryEnvironment, options?: ResearchQueryOptions): {
  query(context: AuthenticatedRequestContext, request: QueryRequest): Promise<QueryResult>;
  queryForMcp(context: AuthenticatedRequestContext, request: QueryRequest): Promise<McpFastSearchQueryResult>;
} {
  const profile = options?.scopeProfile ?? { version: RETRIEVAL_SCOPE_PROFILE_VERSION, max_sources: RETRIEVAL_SCOPE_MAX_SOURCES, max_results: RETRIEVAL_SCOPE_MAX_RESULTS };
  const errors = {
    fail,
    isResearchServiceError: (error: unknown): error is ResearchServiceError => error instanceof ResearchServiceError,
  };
  return createResearchQueryApplication({
    profile,
    maximum_profile: { max_sources: RETRIEVAL_SCOPE_MAX_SOURCES, max_results: RETRIEVAL_SCOPE_MAX_RESULTS },
    execute: createResearchQueryExecutor({
      env,
      profile,
      parseRequest: parseResearchQueryRequest,
      idempotencyKey,
    }),
    errors,
  });
}
function mapLedger(error: unknown): never { if (error instanceof ResearchServiceError) throw error; if (error instanceof LedgerError) { if (error.code === "LEDGER_INPUT_INVALID") fail("RESEARCH_INPUT_INVALID", error.message); if (error.code === "LEDGER_CONFLICT" || error.code === "LEDGER_STALE_HEAD") fail("RESEARCH_CONFLICT", error.message, 409); if (error.code === "LEDGER_PRINCIPAL_DENIED" || error.code === "LEDGER_SCOPE_FOREIGN" || error.code === "LEDGER_VERIFIER_DENIED") fail("RESEARCH_AUTHORITY_STALE", error.message, 403); if (error.code === "LEDGER_SETTLEMENT_UNCERTAIN" || error.code === "LEDGER_HANDLE_MISSING") fail("RESEARCH_SETTLEMENT_UNCERTAIN", error.message, 503, true); fail("RESEARCH_AUTHORITY_STALE", error.message, 409); } throw error; }
async function shaHex(text: string): Promise<string> { return digest(new TextEncoder().encode(text)); }
async function scopedPolicyGeneration(policyAuthorityRef: string): Promise<string> {
  const value = `${POLICY_GEN}:${await shaHex(policyAuthorityRef)}`;
  if (!ID_RE.test(value)) fail("RESEARCH_AUTHORITY_STALE", "policy authority generation is invalid", 409);
  return value;
}
export async function readResearchRunStatus(env: Env, context: AuthenticatedRequestContext, workflowInstanceId: string): Promise<ResearchRunStatus> {
  const operationId = checkId(workflowInstanceId, "workflow_instance_id");
  const runRead = createResearchRunReadEnvironment(env);
  return readResearchSessionRunStatusApplication({
    database: env.CORE_DB,
    work_bucket: env.WORK_BUCKET,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    run_read: runRead,
    get_workflow: (operation_id) => env.RESEARCH_WORKFLOW.get(operation_id),
    load_held_scope: async (currentContext, operation_id, deployment_generation) => {
      const held = await loadHeldResearchScope({ CORE_DB: env.CORE_DB, SEARCH_DB: env.SEARCH_DB }, {
        principal_ref: currentContext.principal_ref,
        client_class: currentContext.client_class,
        credential_generation: currentContext.credential_generation,
      } as const, operation_id, deployment_generation);
      return { investigation_id: held.investigation_id, scope_snapshot_ref: held.scope_snapshot_ref };
    },
    errors: {
      fail,
      is_research_service_error: (error) => error instanceof ResearchServiceError,
    },
  }, context, operationId);
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
      const pre = await store.readByIdempotency(key).catch(() =>
        fail("RESEARCH_SETTLEMENT_UNCERTAIN", "research identity readback is unavailable", 503, true));
      if (pre !== null && (pre.head.investigation_id !== investigation_id ||
          pre.head.principal_ref !== context.principal_ref)) {
        fail("RESEARCH_CONFLICT", "idempotency identity is bound to a different request", 409);
      }
      const admittedDeploymentGeneration = pre?.head.deployment_generation ?? env.DEPLOYMENT_GENERATION;
      const scopeRef = await prepareResearchRunScope(env, context, request, operation_id, requestDigest,
        pre === null ? undefined : { id: pre.head.scope_snapshot_id, revision: pre.head.scope_snapshot_revision }, delegated)
        .catch(mapRetrievalError);
      const snapshotRow = await db.prepare("SELECT policy_authority_ref, purge_ledger_revision FROM scope_snapshot WHERE snapshot_id = ?1 AND revision = ?2").bind(scopeRef.id, scopeRef.revision).first<{ policy_authority_ref: string; purge_ledger_revision: number }>();
      if (!snapshotRow || typeof snapshotRow.policy_authority_ref !== "string") fail("RESEARCH_AUTHORITY_STALE", "scope snapshot is unavailable", 409);
      const priorWorkflow = pre === null ? null : await db.prepare("SELECT handler_generation,configuration_required,configuration_ref FROM research_workflow_run WHERE idempotency_key = ?1")
        .bind(key).first<{ handler_generation: string; configuration_required: number; configuration_ref: string | null }>();
      const supportedGenerations = new Set([HANDLER_GEN, SERVER_OWNED_RESEARCH_HANDLER_GENERATION, SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION, SERVER_OWNED_FREEZE_HANDLER_GENERATION, SERVER_OWNED_SEMANTIC_HANDLER_GENERATION, SERVER_OWNED_LEGACY_PROTOCOL_HANDLER_GENERATION, SERVER_OWNED_PROTOCOL_HANDLER_GENERATION, SERVER_OWNED_BRANCH_HANDLER_GENERATION, SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION]);
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
      const runConfigurationActor = Object.freeze({ operation_id, investigation_id,
        principal_ref: context.principal_ref, deployment_generation: admittedDeploymentGeneration });
      const admissionConfiguration = await resolveResearchRunAdmissionConfiguration(env, {
        actor: runConfigurationActor, context, scope_expression: request.scope_expression, new_run: pre === null,
        ...(priorWorkflow === null ? {} : { configuration_required: priorWorkflow.configuration_required }),
        require_current_scope: async () => {
          const scopePorts = createD1ScopePorts(db, { principal_ref: context.principal_ref,
            client_class: context.client_class, credential_generation: context.credential_generation });
          await scopePorts.requireCurrentScope(scopeAuthority.snapshot).catch(mapRetrievalError);
          await delegated?.requireScopeCurrent(scopeAuthority.snapshot);
        },
      });
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
      const payload = await persistResearchSessionRunPayload({
        request,
        operation_id,
        investigation_id,
        payload_suffix: hex,
        scope_ref: scopeRef,
        principal_ref: context.principal_ref,
        ...(planningManifest === undefined ? {} : { planning_manifest: planningManifest }),
      }, { work_bucket: bucket, fail });
      const principal: WorkflowPrincipal = { principal_ref: context.principal_ref, credential_generation: context.credential_generation, deployment_generation: admittedDeploymentGeneration };
      const installedObligations = installedProtocol === null ? [] : compileInquiryLedgerObligations(installedProtocol);
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
          : delegated === undefined ? SERVER_OWNED_BRANCH_HANDLER_GENERATION : SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION)
        : HANDLER_GEN;
      if (handlerGeneration === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION &&
          (delegated === undefined || !delegated.lease.grant.allowed_operations.includes("recover") ||
            !delegated.lease.grant.allowed_operations.includes("evidence"))) {
        fail("RESEARCH_AUTHORITY_STALE",
          "Computer-agent Research requires the same grant revision to authorize run, recover and evidence", 403);
      }
      if (handlerGeneration === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION && delegated !== undefined) {
        await bindComputerAgentRunRoute({
          database: db,
          context,
          grant: delegated.lease.grant,
          operation_id,
          task_kind: "RESEARCH_BRANCH_ANALYSIS",
        }).catch(mapComputerAgentRouteError);
      }
      const eventId = checkId(`evt-${hex}`, "event_id");
      const runApplicationInput = {
        request,
        operation_id,
        investigation_id,
        idempotency_key: key,
        event_id: eventId,
        scope_ref: scopeRef,
        scope_purge_revision: snapshotRow.purge_ledger_revision ?? 0,
        policy_authority_ref: snapshotRow.policy_authority_ref,
        policy_generation: policyGeneration,
        deployment_generation: admittedDeploymentGeneration,
        principal,
        handler_generation: handlerGeneration,
        include_qualification_renewal: delegated === undefined && isSemanticResearchHandlerGeneration(handlerGeneration),
        lane,
        model_profile_ref: MODEL_PROFILE,
        created_at: now,
        prior: pre,
        ...(planningManifest === undefined ? {} : { planning_manifest: planningManifest }),
        obligations: installedObligations,
        payload,
      };
      const initialManifest = await persistResearchSessionRunApplication(runApplicationInput, {
        database: db,
        work_bucket: bucket,
        ledger_store: store,
        fail,
        is_research_service_error: (error) => error instanceof ResearchServiceError,
        map_ledger_error: mapLedger,
      });
      if (lane === "exploratory" && (handlerGeneration === SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION || isSemanticResearchHandlerGeneration(handlerGeneration))) {
        await createD1ScopeProfilePort(db).recordBinding(scopeAuthority.snapshot, {
          ...await readOwnerScopeProfile(db, scopeAuthority.snapshot),
          max_results: request.max_results,
        }).catch(mapRetrievalError);
      }
      try {
        await dispatchResearchSessionRunApplication(runApplicationInput, initialManifest, {
          database: db,
          fail,
          require_delegated_scope_current: async () => {
            await delegated?.requireScopeCurrent(scopeAuthority.snapshot);
          },
          require_client_execution: async () => {
            if (delegated) await requireClientResearchExecution(env, context, scopeAuthority.snapshot,
              operation_id, env.DEPLOYMENT_GENERATION);
          },
          is_cancelled: () => context.request.signal.aborted,
          bind_and_read_configuration: async () => {
            if (admissionConfiguration.mode !== "legacy-installed") {
              await attachResearchRunConfiguration(env, runConfigurationActor, admissionConfiguration);
            } else if (pre === null) {
              fail("RESEARCH_AGENT_NOT_CONFIGURED", "new research runs require a saved project model configuration", 503);
            }
            const boundConfiguration = await readResearchRunConfiguration(env, runConfigurationActor);
            if (boundConfiguration.mode !== admissionConfiguration.mode ||
                boundConfiguration.configuration_ref !== admissionConfiguration.configuration_ref ||
                boundConfiguration.configuration_sha256 !== admissionConfiguration.configuration_sha256) {
              fail("RESEARCH_AUTHORITY_STALE", "run configuration binding changed before workflow dispatch", 409);
            }
          },
          create_workflow_params: (dispatch: ResearchSessionWorkflowDispatchInput): ResearchWorkflowRunParams => ({
            operation_id: dispatch.operation_id,
            investigation_ref: dispatch.investigation_ref,
            idempotency_key: dispatch.idempotency_key,
            handler_generation: dispatch.handler_generation,
            initial_input_manifest: dispatch.initial_input_manifest,
            principal_ref: dispatch.principal_ref,
            credential_generation: dispatch.credential_generation,
            deployment_generation: dispatch.deployment_generation,
            ...(dispatch.include_qualification_renewal
              ? { qualification_renewal: RESEARCH_QUALIFICATION_RENEWAL_MARKER }
              : {}),
          }),
          dispatch_workflow: async (id: string, params: ResearchWorkflowRunParams) => {
            let instance: WorkflowInstance;
            try {
              instance = await env.RESEARCH_WORKFLOW.create({ id, params });
            } catch {
              instance = await env.RESEARCH_WORKFLOW.get(id);
            }
            if (instance.id !== id) fail("RESEARCH_SETTLEMENT_UNCERTAIN", "workflow instance readback is unavailable", 503, true);
            const instanceStatus = await instance.status();
            if (instanceStatus.status === "unknown") {
              fail("RESEARCH_SETTLEMENT_UNCERTAIN", "workflow instance status is unavailable", 503, true);
            }
          },
        });
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
