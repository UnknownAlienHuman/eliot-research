import {
  MAX_WORKFLOW_RECEIPT_BYTES,
  WorkflowCheckpointStore,
  WorkflowObjectSchema,
  digest,
  type WorkflowObject,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-research";
import type {
  compileInquiryLedgerObligations,
  createResearchPlanningManifest,
} from "@eliotr/cloudflare-research";
import { createInvestigationLedgerService, LedgerError } from "@eliotr/research";
import type { InvestigationLedgerStore } from "@eliotr/research";
import type { QueryRequest, QueryResult, AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { VersionedRef } from "@eliotr/contracts";
import type { ScopeProfileBinding } from "@eliotr/retrieval";
import {
  requireMcpFastSearchCoverageClaim,
  type McpFastSearchQueryResult,
  type ResearchQueryErrorBoundary,
  type ResearchQueryExecutionResult,
} from "./research-query-execution-result.js";

type PriorInvestigation = Awaited<ReturnType<InvestigationLedgerStore["readByIdempotency"]>>;
type PlanningManifest = Awaited<ReturnType<typeof createResearchPlanningManifest>>;
type LedgerObligations = ReturnType<typeof compileInquiryLedgerObligations>;

export interface ResearchQueryApplicationPorts {
  readonly profile: ScopeProfileBinding;
  readonly maximum_profile: Pick<ScopeProfileBinding, "max_sources" | "max_results">;
  readonly execute: (
    context: AuthenticatedRequestContext,
    request: QueryRequest,
    include_coverage: boolean,
  ) => Promise<ResearchQueryExecutionResult>;
  readonly errors: ResearchQueryErrorBoundary;
}

/** Builds the public query methods around the shared Runtime executor. */
export function createResearchQueryApplication(ports: ResearchQueryApplicationPorts): {
  query(context: AuthenticatedRequestContext, request: QueryRequest): Promise<QueryResult>;
  queryForMcp(context: AuthenticatedRequestContext, request: QueryRequest): Promise<McpFastSearchQueryResult>;
} {
  if (ports.profile.max_sources > ports.maximum_profile.max_sources ||
      ports.profile.max_results > ports.maximum_profile.max_results) {
    ports.errors.fail("RESEARCH_PROFILE_UNSUPPORTED",
      "research.query scope profile exceeds the metadata-Lens bound", 422);
  }
  return {
    async query(context, request) {
      return (await ports.execute(context, request, false)).result;
    },
    async queryForMcp(context, request) {
      const execution = await ports.execute(context, request, true);
      return {
        ...execution.result,
        coverage_claim: requireMcpFastSearchCoverageClaim(execution.coverage_claim, ports.errors),
      };
    },
  };
}

export interface ResearchSessionWorkflowDispatchInput {
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly idempotency_key: string;
  readonly handler_generation: string;
  readonly initial_input_manifest: WorkflowObject;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly include_qualification_renewal: boolean;
}

export interface ResearchSessionRunPayloadInput {
  readonly request: QueryRequest;
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly payload_suffix: string;
  readonly scope_ref: VersionedRef;
  readonly planning_manifest?: PlanningManifest;
  readonly principal_ref: string;
}

export interface ResearchSessionRunPayload {
  readonly object_key: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface ResearchSessionRunPayloadPorts {
  readonly work_bucket: R2Bucket;
  readonly fail: (code: string, message: string, status?: number, retryable?: boolean) => never;
}

export interface ResearchSessionRunApplicationInput {
  readonly request: QueryRequest;
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly idempotency_key: string;
  readonly event_id: string;
  readonly scope_ref: VersionedRef;
  readonly scope_purge_revision: number;
  readonly policy_authority_ref: string;
  readonly policy_generation: string;
  readonly deployment_generation: string;
  readonly principal: WorkflowPrincipal;
  readonly handler_generation: string;
  readonly include_qualification_renewal: boolean;
  readonly lane: "confirmatory" | "exploratory" | "mixed_with_declared_split";
  readonly model_profile_ref: string;
  readonly created_at: string;
  readonly prior: PriorInvestigation;
  readonly planning_manifest?: PlanningManifest;
  readonly obligations: LedgerObligations;
  readonly payload: ResearchSessionRunPayload;
}

export interface ResearchSessionRunPersistencePorts {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly ledger_store: InvestigationLedgerStore;
  readonly fail: (code: string, message: string, status?: number, retryable?: boolean) => never;
  readonly is_research_service_error: (error: unknown) => boolean;
  readonly map_ledger_error: (error: unknown) => never;
}

export interface ResearchSessionRunDispatchPorts<TWorkflowParams> {
  readonly database: D1Database;
  readonly fail: (code: string, message: string, status?: number, retryable?: boolean) => never;
  readonly require_delegated_scope_current: () => Promise<void>;
  readonly require_client_execution: () => Promise<void>;
  readonly is_cancelled: () => boolean;
  readonly bind_and_read_configuration: () => Promise<void>;
  readonly create_workflow_params: (input: ResearchSessionWorkflowDispatchInput) => TWorkflowParams;
  readonly dispatch_workflow: (operation_id: string, params: TWorkflowParams) => Promise<void>;
}

interface LogicalRunIdentity {
  readonly investigation_id: string;
  readonly goal: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly evidence_grade: string;
  readonly lane: string;
  readonly portfolio_ref: string;
  readonly principal_ref: string;
  readonly input_digest: string;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly deployment_generation: string;
  readonly idempotency_key: string;
}

function logicalMatch(
  head: LogicalRunIdentity & { readonly model_profile_ref: string },
  expected: LogicalRunIdentity,
  modelProfileRef: string,
): boolean {
  return head.investigation_id === expected.investigation_id &&
    head.goal === expected.goal &&
    head.scope_snapshot_id === expected.scope_snapshot_id &&
    head.scope_snapshot_revision === expected.scope_snapshot_revision &&
    head.evidence_grade === expected.evidence_grade &&
    head.lane === expected.lane &&
    head.portfolio_ref === expected.portfolio_ref &&
    head.principal_ref === expected.principal_ref &&
    head.input_digest === expected.input_digest &&
    head.policy_generation === expected.policy_generation &&
    head.policy_authority_ref === expected.policy_authority_ref &&
    head.deployment_generation === expected.deployment_generation &&
    head.idempotency_key === expected.idempotency_key &&
    head.model_profile_ref === modelProfileRef;
}

/** Writes once and validates exact payload bytes before any ledger identity is created. */
export async function persistResearchSessionRunPayload(
  input: ResearchSessionRunPayloadInput,
  ports: ResearchSessionRunPayloadPorts,
): Promise<ResearchSessionRunPayload> {
  const objectKey = `research-payload-${input.payload_suffix}`;
  const bytes = new TextEncoder().encode(JSON.stringify({
    investigation_id: input.investigation_id,
    operation_id: input.operation_id,
    query: input.request.query,
    scope_snapshot_ref: input.scope_ref,
    evidence_grade: input.request.evidence_grade,
    principal_ref: input.principal_ref,
    ...(input.request.inquiry_protocol_ref === undefined ? {} : {
      inquiry_protocol_ref: input.request.inquiry_protocol_ref,
    }),
    ...(input.planning_manifest === undefined ? {} : { planning_manifest: input.planning_manifest }),
  }));
  if (bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) {
    ports.fail("RESEARCH_INPUT_LIMIT",
      `research workflow input exceeds ${MAX_WORKFLOW_RECEIPT_BYTES} UTF-8 bytes; partition the requested scope or shorten the question`,
      413);
  }
  const sha256 = await digest(bytes);
  if ((await ports.work_bucket.head(objectKey).catch(() => null)) === null) {
    await ports.work_bucket.put(objectKey, bytes, { sha256 });
  }
  const currentPayload = await ports.work_bucket.get(objectKey).catch(() => null);
  if (currentPayload === null) {
    ports.fail("RESEARCH_SETTLEMENT_UNCERTAIN", "payload readback is unavailable", 503, true);
  }
  const currentBytes = new Uint8Array(await currentPayload.arrayBuffer());
  if ((await digest(currentBytes)) !== sha256 || currentBytes.byteLength !== bytes.byteLength) {
    ports.fail("RESEARCH_CONFLICT", "idempotency identity is bound to different bytes", 409);
  }
  return { object_key: objectKey, bytes, sha256 };
}

/** Persists and reads back the canonical run ledger record. */
export async function persistResearchSessionRunApplication(
  input: ResearchSessionRunApplicationInput,
  ports: ResearchSessionRunPersistencePorts,
): Promise<WorkflowObject> {
  const payloadKey = input.payload.object_key;
  const payloadBytes = input.payload.bytes;
  const payloadHash = input.payload.sha256;

  const expectedIdentity: LogicalRunIdentity = {
    investigation_id: input.investigation_id,
    goal: input.request.query,
    scope_snapshot_id: input.scope_ref.id,
    scope_snapshot_revision: input.scope_ref.revision,
    evidence_grade: input.request.evidence_grade,
    lane: input.lane,
    portfolio_ref: payloadKey,
    principal_ref: input.principal.principal_ref,
    input_digest: payloadHash,
    policy_generation: input.policy_generation,
    policy_authority_ref: input.policy_authority_ref,
    deployment_generation: input.deployment_generation,
    idempotency_key: input.idempotency_key,
  };
  if (input.prior !== null && !logicalMatch(input.prior.head, expectedIdentity, input.model_profile_ref)) {
    ports.fail("RESEARCH_CONFLICT", "idempotency identity is bound to different bytes", 409);
  }

  const fences = {
    current: async () => {
      const globalRow = await ports.database.prepare(
        "SELECT COALESCE(MAX(ledger_revision), 0) AS n FROM purge_ledger",
      ).bind().first<{ n: number }>();
      return {
        principal_ref: input.principal.principal_ref,
        scope_snapshot_id: input.scope_ref.id,
        scope_snapshot_revision: input.scope_ref.revision,
        policy_generation: input.policy_generation,
        policy_authority_ref: input.policy_authority_ref,
        deployment_generation: input.deployment_generation,
        purge_revision: globalRow?.n ?? 0,
        scope_purge_revision: input.scope_purge_revision,
      };
    },
  };
  const handles = {
    has: async (ref: string) => (await ports.work_bucket.head(ref).catch(() => null)) !== null,
    digestFor: async (ref: string) => {
      const head = await ports.work_bucket.head(ref).catch(() => null);
      if (head === null) return null;
      const raw = (head as unknown as { checksums?: { sha256?: unknown } }).checksums?.sha256;
      if (raw instanceof ArrayBuffer) {
        return Array.from(new Uint8Array(raw), (byte) => byte.toString(16).padStart(2, "0")).join("");
      }
      return payloadHash;
    },
  };
  const ledger = createInvestigationLedgerService(ports.ledger_store, fences, handles);
  if (input.prior === null) {
    try {
      await ledger.create({
        investigation_id: input.investigation_id,
        goal: input.request.query,
        scope_snapshot_id: input.scope_ref.id,
        scope_snapshot_revision: input.scope_ref.revision,
        evidence_grade: input.request.evidence_grade,
        lane: input.lane,
        lane_registrations: [],
        obligations: input.obligations,
        hypotheses: input.planning_manifest?.hypotheses.map((item) => item.hypothesis_id) ?? [],
        portfolio_ref: payloadKey,
        debt_refs: [],
        principal_ref: input.principal.principal_ref,
        input_digest: payloadHash,
        policy_generation: input.policy_generation,
        policy_authority_ref: input.policy_authority_ref,
        deployment_generation: input.deployment_generation,
        idempotency_key: input.idempotency_key,
        model_profile_ref: input.model_profile_ref,
        event_id: input.event_id,
        payload_handle_ref: payloadKey,
        payload_digest: payloadHash,
        created_at: input.created_at,
      });
    } catch (error) {
      if (ports.is_research_service_error(error)) throw error;
      if (error instanceof LedgerError && (error.code === "LEDGER_CONFLICT" || error.code === "LEDGER_STALE_HEAD")) {
        const existing = await ports.ledger_store.readByIdempotency(input.idempotency_key).catch(() => null);
        if (existing === null || existing.head.investigation_id !== input.investigation_id ||
            !logicalMatch(existing.head, expectedIdentity, input.model_profile_ref)) {
          ports.fail("RESEARCH_CONFLICT", "idempotency identity is bound to different bytes", 409);
        }
      } else {
        ports.map_ledger_error(error);
      }
    }
  }

  const initialManifest: WorkflowObject = WorkflowObjectSchema.parse({
    object_ref: payloadKey,
    sha256: payloadHash,
    byte_length: payloadBytes.byteLength,
    residency: {
      scope_domain_id: input.scope_ref.id,
      access_domain_id: input.principal.principal_ref,
      confidentiality_domain_id: "private",
      encryption_key_domain_id: "key-1",
      retention_domain_id: "retention-1",
      erasure_domain_id: "erasure-1",
      content_digest: { algorithm: "sha256", digest: payloadHash },
    },
  });
  return initialManifest;
}

export async function dispatchResearchSessionRunApplication<TWorkflowParams>(
  input: ResearchSessionRunApplicationInput,
  initialManifest: WorkflowObject,
  ports: ResearchSessionRunDispatchPorts<TWorkflowParams>,
): Promise<void> {
  const initialStage = {
    protocol: "eliotr.workflow-stage.v1" as const,
    operation_id: input.operation_id,
    investigation_ref: { id: input.investigation_id, revision: 1 },
    stage: "FREEZE_PROTOCOL_AND_SCOPE" as const,
    idempotency_key: input.idempotency_key,
    handler_generation: input.handler_generation,
    input_manifest: initialManifest,
  };
  await ports.require_delegated_scope_current();
  await ports.require_client_execution();
  if (ports.is_cancelled()) ports.fail("RESEARCH_CANCELLED", "Research admission was cancelled", 409);
  await new WorkflowCheckpointStore(ports.database).ensureRun(initialStage, input.principal);
  await ports.bind_and_read_configuration();
  const workflowParams = ports.create_workflow_params({
    operation_id: input.operation_id,
    investigation_ref: initialStage.investigation_ref,
    idempotency_key: input.idempotency_key,
    handler_generation: input.handler_generation,
    initial_input_manifest: initialManifest,
    principal_ref: input.principal.principal_ref,
    credential_generation: input.principal.credential_generation,
    deployment_generation: input.principal.deployment_generation,
    include_qualification_renewal: input.include_qualification_renewal,
  });
  await ports.require_delegated_scope_current();
  await ports.require_client_execution();
  await ports.dispatch_workflow(input.operation_id, workflowParams);
}
