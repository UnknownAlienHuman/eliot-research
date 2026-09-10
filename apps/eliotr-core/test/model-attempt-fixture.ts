import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { OperationIntent } from "@eliotr/contracts";
import {
  createModelAttemptStore,
  type ModelAttemptAuthority,
  type ModelCostQuote,
  type ModelOutputBinding,
} from "../../../packages/cloudflare-research/src/model-attempt-store.js";
import type { GovernedModelAttemptDependencies, ModelAttemptPreparationContext } from "../../../packages/cloudflare-research/src/model-attempt-handler.js";
import type { ModelAttemptReservationInput, ModelAttemptStore } from "../../../packages/cloudflare-research/src/model-attempt-types.js";
import { digest, type StageRequest, type WorkflowPrincipal } from "../../../packages/cloudflare-research/src/types.js";
import type { ModelCallInput, ModelCallReceipt } from "@eliotr/research";
import type { EvidencePack } from "@eliotr/retrieval";
import type { Env } from "../src/env.js";
import { principal as workflowPrincipal, workflowFixture } from "./research-workflow-fixture.js";

export const runtime = env as unknown as Env & {
  readonly CORE_MIGRATIONS: D1Migration[];
};

export async function initializeModelAttemptRuntime(): Promise<void> {
  await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
}

function identifier(tag: string, prefix: string): string {
  return `${prefix}-${tag}`;
}

function evidencePack(tag: string, scopeRevision = 1, scopeId = identifier(tag, "scope")): EvidencePack {
  return {
    pack_ref: { id: identifier(tag, "pack"), revision: 1 },
    scope_snapshot_ref: { id: scopeId, revision: scopeRevision },
    resolved_evidence: [],
    omitted_candidates: [],
    trace_ref: { id: identifier(tag, "trace"), revision: 1 },
    total_utf8_bytes: 0,
  };
}

function bindWorkflowBudget<T extends object>(value: T, receiptRef: string): T & { readonly workflow_budget_receipt_ref: string } {
  return Object.assign(value, { workflow_budget_receipt_ref: receiptRef });
}

export interface ModelAttemptFixture {
  readonly input: ModelAttemptReservationInput;
  readonly receipt: ModelCallReceipt;
  readonly output: ModelOutputBinding;
  readonly authority: ModelAttemptAuthority;
  readonly now: () => string;
  readonly store: ReturnType<typeof createModelAttemptStore>;
}

export function createModelAttemptRuntime(database: D1Database = runtime.CORE_DB, now: () => string = () => "2026-09-10T12:00:00.000Z"): ModelAttemptStore {
  return createModelAttemptStore(database, now);
}

export function modelAttemptFixture(tag: string, options: {
  readonly now?: string;
  readonly scopeRevision?: number;
  readonly workflow?: ModelAttemptWorkflowBinding;
} = {}): ModelAttemptFixture {
  const nowValue = options.now ?? "2026-09-10T12:00:00.000Z";
  const now = () => nowValue;
  const principal = options.workflow?.principal_ref ?? identifier(tag, "principal");
  const operationKind: OperationIntent["operation_kind"] = "REPORT";
  const reservationId = identifier(tag, "reservation");
  const idempotencyKey = identifier(tag, "idempotency");
  const scopeRevision = options.scopeRevision ?? 1;
  const scopeId = options.workflow?.scope_snapshot_id ?? identifier(tag, "scope");
  const authority: ModelAttemptAuthority = {
    principal_ref: principal,
    client_class: "owner_pwa",
    policy_decision_ref: identifier(tag, "policy-decision"),
    scope_snapshot_ref: { id: scopeId, revision: scopeRevision },
    credential_generation: options.workflow?.credential_generation ?? identifier(tag, "credential"),
    deployment_generation: options.workflow?.deployment_generation ?? identifier(tag, "deployment"),
    policy_generation: identifier(tag, "policy"),
    currentness_digest: "a".repeat(64),
    expires_at: "2026-09-10T13:00:00.000Z",
  };
  const intent: OperationIntent = {
    intent_ref: { id: identifier(tag, "intent"), revision: 1 },
    operation_kind: operationKind,
    principal_ref: principal,
    idempotency_key: idempotencyKey,
    payload_ref: identifier(tag, "payload"),
    policy_decision_ref: authority.policy_decision_ref,
    budget_reservation_ref: reservationId,
    cancellation_ref: identifier(tag, "cancel"),
    created_at: nowValue,
  };
  const cancellationRef = identifier(tag, "cancel");
  const call: ModelCallInput = {
    route_ref: "dynamic/eliotr-report-section",
    prompt_generation: identifier(tag, "prompt"),
    schema_generation: identifier(tag, "schema"),
    evidence_pack: evidencePack(tag, scopeRevision, scopeId),
    output_object_ref: identifier(tag, "output"),
    max_input_bytes: 64 * 1024,
    max_output_bytes: 64 * 1024,
    budget_reservation_ref: reservationId,
    cancellation_ref: cancellationRef,
  };
  const quote: ModelCostQuote = {
    quote_ref: identifier(tag, "quote"),
    reservation_id: reservationId,
    operation_kind: operationKind,
    estimated_model_calls: 1,
    estimated_input_tokens: 16,
    estimated_output_tokens: 32,
    estimated_embedding_tokens: 0,
    quoted_neurons: 1,
    selected_routes: [call.route_ref],
    platform_usd: 0,
    workers_ai_usd: 0,
    byok_usd: 0,
    max_total_usd: 0,
    workflow_steps: 1,
    expected_sources: 0,
    expected_sections: 1,
    confidence: 1,
    expires_at: authority.expires_at,
  };
  const outputSha = "b".repeat(64);
  const receipt: ModelCallReceipt = {
    receipt_ref: identifier(tag, "receipt"),
    route_fingerprint_ref: identifier(tag, "fingerprint"),
    output_object_ref: call.output_object_ref,
    output_sha256: outputSha,
    input_tokens: 16,
    output_tokens: 32,
    billed_usd: 0,
  };
  const output: ModelOutputBinding = {
    output_object_ref: call.output_object_ref,
    output_sha256: outputSha,
    output_size_bytes: 128,
    readback_sha256: outputSha,
  };
  return {
    input: bindWorkflowBudget({
      intent,
      idempotency_key: idempotencyKey,
      call,
      quote,
      authority,
      stage_attempt_ref: options.workflow?.stage_attempt_ref ?? identifier(tag, "stage-attempt"),
      stage_request_sha256: options.workflow?.stage_request_sha256 ?? "c".repeat(64),
    }, options.workflow?.budget_receipt_ref ?? identifier(tag, "budget")),
    receipt,
    output,
    authority,
    now,
    store: createModelAttemptRuntime(runtime.CORE_DB, now),
  };
}

export interface GovernedModelAttemptFixture {
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly inputBytes: Uint8Array;
  readonly dependencies: GovernedModelAttemptDependencies;
  readonly calls: () => number;
  requestFor(stage: StageRequest["stage"]): StageRequest;
  invocation(stage: StageRequest["stage"], attemptRef: string): {
    readonly request: StageRequest;
    readonly principal: WorkflowPrincipal;
    readonly input_bytes: Uint8Array;
    readonly attempt_ref: string;
    readonly budget_receipt_ref: string;
  };
}

export interface GovernedModelAttemptFixtureOptions {
  readonly database?: D1Database;
  readonly bucket?: R2Bucket;
  readonly request?: StageRequest;
  readonly principal?: WorkflowPrincipal;
  readonly inputBytes?: Uint8Array;
}

export interface ModelAttemptWorkflowBinding {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly scope_snapshot_id: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly budget_receipt_ref: string;
}

/** Production handler fixture: the route is controlled, but its output is persisted in real local R2. */
export async function governedModelAttemptFixture(tag: string, options: GovernedModelAttemptFixtureOptions = {}): Promise<GovernedModelAttemptFixture> {
  let inputBytes = options.inputBytes === undefined ? new TextEncoder().encode(`controlled W3 input ${tag} — Ж🙂`) : new Uint8Array(options.inputBytes);
  const inputSha256 = await digest(inputBytes);
  const nowValue = "2026-09-10T12:00:00.000Z";
  const defaultScopeId = identifier(tag, "scope");
  const defaultPrincipal: WorkflowPrincipal = {
    principal_ref: `${tag}-owner`, credential_generation: `${tag}-credential`, deployment_generation: `${tag}-deployment`,
  };
  const defaultRequest: StageRequest = {
    protocol: "eliotr.workflow-stage.v1", operation_id: `${tag}-run`, investigation_ref: { id: `${tag}-investigation`, revision: 1 },
    stage: "FREEZE_PROTOCOL_AND_SCOPE", idempotency_key: `${tag}-workflow-key`, handler_generation: `${tag}-handlers-v1`,
    input_manifest: {
      object_ref: `${tag}-input`, sha256: inputSha256, byte_length: inputBytes.byteLength,
      residency: {
        scope_domain_id: defaultScopeId, access_domain_id: defaultPrincipal.principal_ref, confidentiality_domain_id: `${tag}-private`,
        encryption_key_domain_id: `${tag}-encryption`, retention_domain_id: `${tag}-retention`, erasure_domain_id: `${tag}-erasure`,
        content_digest: { algorithm: "sha256", digest: inputSha256 },
      },
    },
  };
  let principal = options.principal ?? defaultPrincipal;
  let request = options.request ?? defaultRequest;
  let database = options.database ?? runtime.CORE_DB;
  let bucket = options.bucket ?? runtime.WORK_BUCKET;
  if (options.database === undefined && options.request === undefined && options.principal === undefined && options.inputBytes === undefined) {
    const workflow = await workflowFixture(`model-attempt-${tag}`);
    await workflow.executor.execute(workflow.request, workflowPrincipal, async ({ input_bytes }) => new Uint8Array(input_bytes));
    inputBytes = new Uint8Array(workflow.bytes);
    principal = workflowPrincipal;
    request = workflow.request;
    database = workflow.db;
    bucket = workflow.bucket;
  }
  const scopeId = request.input_manifest.residency.scope_domain_id;
  const boundStage = await database.prepare(
    "SELECT attempt_ref, budget_receipt_ref FROM research_workflow_attempt WHERE operation_id = ?1 AND stage_index = 0 LIMIT 1",
  ).bind(request.operation_id).first<{ readonly attempt_ref: string; readonly budget_receipt_ref: string }>();
  const store = createModelAttemptRuntime(database, () => nowValue);
  let routeCalls = 0;
  const outputBytes = new TextEncoder().encode(`controlled W3 output ${tag} — результат🙂`);
  const route = {
    execute: async (call: ModelCallInput): Promise<ModelCallReceipt> => {
      routeCalls += 1;
      const outputSha256 = await digest(outputBytes);
      await bucket.put(call.output_object_ref, outputBytes, { sha256: outputSha256 });
      return {
        receipt_ref: `${tag}-route-receipt-${routeCalls}`,
        route_fingerprint_ref: `${tag}-route-fingerprint`, output_object_ref: call.output_object_ref,
        output_sha256: outputSha256, input_tokens: 16, output_tokens: 24, billed_usd: 0,
      };
    },
  };
  const requestFor = (stage: StageRequest["stage"]): StageRequest => Object.freeze({ ...request, stage });
  const invocation = (_stage: StageRequest["stage"], _attemptRef: string) => ({
    request, principal, input_bytes: new Uint8Array(inputBytes), attempt_ref: boundStage?.attempt_ref ?? "unbound-stage",
    budget_receipt_ref: boundStage?.budget_receipt_ref ?? "unbound-budget",
  });
  const dependencies: GovernedModelAttemptDependencies = {
    operation_kind: "REPORT", attempts: store, route,
    prepare: async (context: ModelAttemptPreparationContext) => {
      const reservationId = `${context.model_operation_id}-reservation`;
      const authority: ModelAttemptAuthority = {
        principal_ref: context.principal.principal_ref, client_class: "owner_pwa",
        policy_decision_ref: `${tag}-policy-decision`, scope_snapshot_ref: { id: scopeId, revision: 1 },
        credential_generation: context.principal.credential_generation, deployment_generation: context.principal.deployment_generation,
        policy_generation: `${tag}-policy`, currentness_digest: "a".repeat(64), expires_at: "2026-09-10T13:00:00.000Z",
      };
      const intent: OperationIntent = {
        intent_ref: { id: context.model_operation_id, revision: 1 }, operation_kind: "REPORT",
        principal_ref: context.principal.principal_ref, idempotency_key: context.model_idempotency_key,
        payload_ref: `${context.model_operation_id}-payload`, policy_decision_ref: authority.policy_decision_ref,
        budget_reservation_ref: reservationId, cancellation_ref: `${context.model_operation_id}-cancel`, created_at: nowValue,
      };
      const call: ModelCallInput = {
        route_ref: "dynamic/eliotr-report-stage", prompt_generation: `${context.model_operation_id}-prompt`,
        schema_generation: `${tag}-schema`, evidence_pack: evidencePack(tag, 1, scopeId), output_object_ref: context.model_output_object_ref,
        max_input_bytes: 64 * 1024, max_output_bytes: 64 * 1024, budget_reservation_ref: reservationId,
        cancellation_ref: `${context.model_operation_id}-cancel`,
      };
      const quote: ModelCostQuote = {
        quote_ref: `${context.model_operation_id}-quote`, reservation_id: reservationId, operation_kind: "REPORT",
        estimated_model_calls: 1, estimated_input_tokens: 16, estimated_output_tokens: 24, estimated_embedding_tokens: 0,
        quoted_neurons: 1, selected_routes: [call.route_ref], platform_usd: 0, workers_ai_usd: 0, byok_usd: 0,
        max_total_usd: 0, workflow_steps: 1, expected_sources: 0, expected_sections: 1, confidence: 1,
        expires_at: authority.expires_at,
      };
      return { intent, idempotency_key: context.model_idempotency_key, call, quote, authority,
        stage_attempt_ref: context.attempt_ref, stage_request_sha256: context.stage_request_sha256,
        workflow_budget_receipt_ref: context.budget_receipt_ref };
    },
    revalidate: async () => undefined,
    now: () => Date.parse(nowValue),
    readOutput: async (binding: Pick<ModelOutputBinding, "output_object_ref" | "output_sha256">) => {
      const object = await bucket.get(binding.output_object_ref);
      if (object === null) throw new Error("controlled model output is missing");
      return new Uint8Array(await object.arrayBuffer());
    },
  };
  return { request, principal, inputBytes, dependencies, calls: () => routeCalls, requestFor, invocation };
}
