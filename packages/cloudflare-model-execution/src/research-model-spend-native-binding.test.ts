import { modelGatewaySha256, type ModelGatewayTransportPolicyV1 } from "@eliotr/cloudflare-ai";
import { StageRequestSchema, textDigest } from "@eliotr/cloudflare-workflows";
import { canonicalJson, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { ProviderNativeModelSelectionV1 } from "@eliotr/cloudflare-native-models";
import { describe, expect, it } from "vitest";
import type { ModelAttemptPreparationContext } from "./model-attempt-handler.js";
import { validatedRequest } from "./model-attempt-store-common.js";
import type { ModelAttemptAuthority, ModelAttemptReservationInput } from "./model-attempt-types.js";
import {
  createD1ResearchModelAttemptRevalidator,
  type SpendAuthorizationReadRequest,
} from "./research-model-attempt-revalidator.js";
import {
  createD1ResearchModelSpendAdmissionPort,
  type ResearchModelSpendCurrentAuthority,
  type ResearchModelSpendAdmissionInput,
} from "./research-model-spend-admission.js";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();
const ADMISSION_EXPIRY = "2030-01-01T00:00:00.000Z";
const QUOTE_EXPIRY = "2031-01-01T00:00:00.000Z";
const AUTHORITY_EXPIRY = "2032-01-01T00:00:00.000Z";
const W2_EXPIRY = "2035-01-01T00:00:00.000Z";
const PRICING_EXPIRY = "2040-01-01T00:00:00.000Z";
const SHA = "a".repeat(64);
const PRINCIPAL = {
  principal_ref: "caller-1",
  credential_generation: "credential-generation-1",
  deployment_generation: "deployment-generation-1",
} as const;
const WORKFLOW_OPERATION_ID = "workflow-operation-1";
const WORKFLOW_RECEIPT = "captured-w2-authorization-receipt-1";
const WORKFLOW_BUDGET_RECEIPT = "captured-w2-budget-receipt-1";
const STAGE_ATTEMPT_REF = "workflow-attempt-1";
const MODEL_OPERATION_ID = "model-operation-1";
const MODEL_IDEMPOTENCY_KEY = "model-idempotency-1";
const RESERVATION_ID = "model-reservation-1";
const QUOTE_REF = "model-quote-1";
const SCOPE = Object.freeze({ id: "scope-snapshot-1", revision: 1 });
const DEPLOYMENT: ModelRouteDeployment = Object.freeze({
  route_ref: "dynamic/eliotr-report-section",
  route_version: "native-route-v1",
  prompt_generation: "prompt-generation-1",
  schema_generation: "schema-generation-1",
  parameters_digest: SHA,
  pricing_snapshot_ref: "native-pricing-1",
});
const NATIVE_TRANSPORT_POLICY: ModelGatewayTransportPolicyV1 = Object.freeze({
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "openrouter-chat-completions",
  provider: "openrouter",
  model: "stealth/space-bunny-alpha",
  billing: Object.freeze({ mode: "byok", alias: "openrouter-test-key", free_only: true as const }),
  capabilities: Object.freeze({ max_output_tokens_field: "max_tokens", reasoning_efforts: Object.freeze([]) }),
});
const NATIVE_SELECTION: ProviderNativeModelSelectionV1 = Object.freeze({
  candidate_kind: "provider-native-v1",
  stage: "SYNTHESIZE",
  route_ref: DEPLOYMENT.route_ref,
  route_version: DEPLOYMENT.route_version,
  candidate_ref: "native-candidate-generation-1",
  candidate_sha256: "b".repeat(64),
  qualification_ref: "native-qualification-1",
  qualification_sha256: "c".repeat(64),
  transport_policy: NATIVE_TRANSPORT_POLICY,
});
const NATIVE_BINDING = Object.freeze({ owner_ref: "captured-project-owner-1", project_id: "captured-project-1" });

type CurrentAuthorityMutation = (value: ResearchModelSpendCurrentAuthority) => ResearchModelSpendCurrentAuthority;

function currentBinding(value: ResearchModelSpendCurrentAuthority) {
  if (value.native_authority_binding === undefined) throw new Error("Native test authority has no captured binding");
  return value.native_authority_binding;
}

function currentSelection(value: ResearchModelSpendCurrentAuthority) {
  if (value.model_selection === undefined) throw new Error("Pinned test authority has no selection");
  return value.model_selection;
}

const BINDING_MUTATIONS: ReadonlyArray<readonly [string, CurrentAuthorityMutation]> = [
  ["foreign owner", (value) => ({
    ...value,
    native_authority_binding: { ...currentBinding(value), owner_ref: "foreign-owner-1" },
  })],
  ["foreign project", (value) => ({
    ...value,
    native_authority_binding: { ...currentBinding(value), project_id: "foreign-project-1" },
  })],
  ["authority generation", (value) => ({
    ...value,
    authority: { ...value.authority, credential_generation: "rotated-credential-generation" },
  })],
  ["candidate generation", (value) => ({
    ...value,
    model_selection: { ...currentSelection(value), candidate_ref: "native-candidate-generation-2" },
  })],
  ["candidate hash", (value) => ({
    ...value,
    model_selection: { ...currentSelection(value), candidate_sha256: "9".repeat(64) },
  })],
  ["qualification hash", (value) => ({
    ...value,
    model_selection: { ...currentSelection(value), qualification_sha256: "8".repeat(64) },
  })],
  ["missing binding", (value) => {
    const withoutBinding = { ...value };
    delete withoutBinding.native_authority_binding;
    return withoutBinding;
  }],
];

function stageRequest() {
  return StageRequestSchema.parse({
    protocol: "eliotr.workflow-stage.v1",
    operation_id: WORKFLOW_OPERATION_ID,
    investigation_ref: { id: "investigation-1", revision: 3 },
    stage: "SYNTHESIZE",
    idempotency_key: "workflow-stage-idempotency-1",
    handler_generation: "workflow-handler-generation-1",
    input_manifest: {
      object_ref: "objects/frozen-input-1",
      sha256: SHA,
      byte_length: 4,
      residency: {
        scope_domain_id: "scope-domain-1",
        access_domain_id: "access-domain-1",
        confidentiality_domain_id: "confidentiality-domain-1",
        encryption_key_domain_id: "encryption-domain-1",
        retention_domain_id: "retention-domain-1",
        erasure_domain_id: "erasure-domain-1",
        content_digest: { algorithm: "sha256", digest: SHA },
      },
    },
  });
}

function makeWorkflowRow(stageSha: string) {
  return {
    operation_id: WORKFLOW_OPERATION_ID,
    workflow_state: "ACTIVE",
    principal_ref: PRINCIPAL.principal_ref,
    credential_generation: PRINCIPAL.credential_generation,
    deployment_generation: PRINCIPAL.deployment_generation,
    policy_generation: "model-policy-generation-1",
    policy_authority_ref: "workflow-policy-authority-1",
    authorization_receipt_ref: WORKFLOW_RECEIPT,
    scope_snapshot_id: SCOPE.id,
    scope_snapshot_revision: SCOPE.revision,
    purge_revision: 1,
    current_revision: 3,
    ledger_revision: 3,
    next_stage_index: 12,
    attempt_ref: STAGE_ATTEMPT_REF,
    stage_request_sha256: stageSha,
    budget_receipt_ref: WORKFLOW_BUDGET_RECEIPT,
    budget_expires_at_ms: Date.parse(W2_EXPIRY),
    workflow_attempt_state: "STARTED",
    scope_expires_at: W2_EXPIRY,
    scope_invalidated_at: null,
    grant_client_class: "owner_pwa",
    grant_credential_generation: PRINCIPAL.credential_generation,
    grant_policy_authority_ref: "workflow-policy-authority-1",
    grant_authorization_receipt_ref: WORKFLOW_RECEIPT,
    grant_state: "ACTIVE",
    grant_expires_at: W2_EXPIRY,
    current_policy_state: "ACTIVE",
    current_deployment_state: "ACTIVE",
  };
}

function modelRow(prepared: ModelAttemptReservationInput, encoded: Awaited<ReturnType<typeof validatedRequest>>) {
  const intent = prepared.intent;
  const authorityJson = canonicalJson(prepared.authority);
  const quoteJson = canonicalJson(prepared.quote);
  return {
    attempt_id: "model-attempt-1",
    intent_id: intent.intent_ref.id,
    intent_revision: intent.intent_ref.revision,
    intent_operation_kind: intent.operation_kind,
    intent_principal_ref: intent.principal_ref,
    intent_idempotency_key: intent.idempotency_key,
    intent_policy_decision_ref: intent.policy_decision_ref,
    intent_budget_reservation_ref: intent.budget_reservation_ref,
    model_state: "STARTED",
    model_principal_ref: prepared.authority.principal_ref,
    model_operation_kind: intent.operation_kind,
    model_idempotency_key: prepared.idempotency_key,
    model_request_sha256: encoded.request_sha256,
    model_request_json: encoded.request_json,
    model_authority_json: authorityJson,
    model_route_ref: prepared.call.route_ref,
    model_prompt_generation: prepared.call.prompt_generation,
    model_schema_generation: prepared.call.schema_generation,
    model_credential_generation: prepared.authority.credential_generation,
    model_deployment_generation: prepared.authority.deployment_generation,
    model_stage_attempt_ref: prepared.stage_attempt_ref,
    model_stage_request_sha256: prepared.stage_request_sha256,
    reservation_id: prepared.quote.reservation_id,
    reservation_state: "RESERVED",
    reservation_request_sha256: encoded.request_sha256,
    reservation_request_json: encoded.request_json,
    reservation_principal_ref: prepared.authority.principal_ref,
    reservation_idempotency_key: prepared.idempotency_key,
    reservation_policy_decision_ref: prepared.authority.policy_decision_ref,
    reservation_credential_generation: prepared.authority.credential_generation,
    reservation_deployment_generation: prepared.authority.deployment_generation,
    reservation_quote_ref: prepared.quote.quote_ref,
    reservation_quote_json: quoteJson,
    reservation_authority_json: authorityJson,
    reservation_stage_attempt_ref: prepared.stage_attempt_ref,
    reservation_stage_request_sha256: prepared.stage_request_sha256,
    reservation_expires_at: prepared.quote.expires_at,
    operation_attempt_state: "STARTED",
  };
}

function w3ReadbackColumns(row: Record<string, unknown>): Record<string, unknown> {
  const intent = JSON.parse(String(row.intent_json)) as Record<string, unknown>;
  return {
    w3_intent_id: row.intent_id,
    w3_intent_revision: row.intent_revision,
    w3_intent_principal_ref: row.principal_ref,
    w3_intent_policy_decision_ref: row.policy_decision_ref,
    w3_intent_reservation_id: row.reservation_id,
    w3_reservation_state: "RESERVED",
    w3_reservation_principal_ref: row.principal_ref,
    w3_reservation_idempotency_key: intent.idempotency_key,
    w3_reservation_policy_decision_ref: row.policy_decision_ref,
    w3_reservation_credential_generation: row.credential_generation,
    w3_reservation_deployment_generation: row.deployment_generation,
    w3_reservation_quote_ref: row.quote_ref,
    w3_reservation_stage_attempt_ref: row.stage_attempt_ref,
    w3_reservation_stage_request_sha256: row.stage_request_sha256,
    w3_reservation_quote_json: row.quote_json,
    w3_reservation_authority_json: row.authority_json,
    w3_reservation_expires_at: row.expires_at,
    w3_model_state: "STARTED",
    w3_model_intent_id: row.intent_id,
    w3_model_intent_revision: row.intent_revision,
    w3_model_reservation_id: row.reservation_id,
    w3_model_principal_ref: row.principal_ref,
    w3_model_route_ref: row.route_ref,
    w3_model_credential_generation: row.credential_generation,
    w3_model_deployment_generation: row.deployment_generation,
    w3_model_stage_attempt_ref: row.stage_attempt_ref,
    w3_model_stage_request_sha256: row.stage_request_sha256,
    w3_model_output_object_ref: null,
    w3_operation_attempt_state: "STARTED",
    w2_budget_expires_at_ms: Date.parse(W2_EXPIRY),
  };
}

async function makeCase(options: {
  readonly mode?: "native" | "legacy" | "dynamic";
  readonly mutateOnRead?: CurrentAuthorityMutation;
} = {}) {
  const stage = stageRequest();
  const stageJson = JSON.stringify(stage);
  const stageSha = await textDigest(stageJson);
  const authority: ModelAttemptAuthority = Object.freeze({
    principal_ref: PRINCIPAL.principal_ref,
    client_class: "owner_pwa",
    policy_decision_ref: "model-policy-decision-1",
    scope_snapshot_ref: SCOPE,
    credential_generation: PRINCIPAL.credential_generation,
    deployment_generation: PRINCIPAL.deployment_generation,
    policy_generation: "model-policy-generation-1",
    currentness_digest: "d".repeat(64),
    expires_at: AUTHORITY_EXPIRY,
  });
  const intent = Object.freeze({
    intent_ref: Object.freeze({ id: MODEL_OPERATION_ID, revision: 1 }),
    operation_kind: "REPORT" as const,
    principal_ref: PRINCIPAL.principal_ref,
    idempotency_key: MODEL_IDEMPOTENCY_KEY,
    payload_ref: "model-payload-1",
    policy_decision_ref: authority.policy_decision_ref,
    budget_reservation_ref: RESERVATION_ID,
    cancellation_ref: "model-cancellation-1",
    created_at: NOW_ISO,
  });
  const quote = Object.freeze({
    quote_ref: QUOTE_REF,
    reservation_id: RESERVATION_ID,
    operation_kind: "REPORT" as const,
    estimated_model_calls: 1,
    estimated_input_tokens: 8,
    estimated_output_tokens: 16,
    estimated_embedding_tokens: 0,
    quoted_neurons: 0,
    selected_routes: [DEPLOYMENT.route_ref],
    platform_usd: 0,
    workers_ai_usd: 0,
    byok_usd: 0.01,
    max_total_usd: 0.01,
    workflow_steps: 1,
    expected_sources: 0,
    expected_sections: 1,
    confidence: 1,
    expires_at: QUOTE_EXPIRY,
  });
  const prepared: ModelAttemptReservationInput = Object.freeze({
    intent,
    idempotency_key: MODEL_IDEMPOTENCY_KEY,
    call: Object.freeze({
      route_ref: DEPLOYMENT.route_ref,
      prompt_generation: DEPLOYMENT.prompt_generation,
      schema_generation: DEPLOYMENT.schema_generation,
      evidence_pack: Object.freeze({
        pack_ref: Object.freeze({ id: "evidence-pack-1", revision: 1 }),
        scope_snapshot_ref: SCOPE,
        resolved_evidence: Object.freeze([]),
        omitted_candidates: Object.freeze([]),
        trace_ref: Object.freeze({ id: "evidence-trace-1", revision: 1 }),
        total_utf8_bytes: 0,
      }),
      output_object_ref: "model-output-1",
      max_input_bytes: 16_384,
      max_output_bytes: 16_384,
      budget_reservation_ref: RESERVATION_ID,
      cancellation_ref: "model-cancellation-1",
    }),
    quote,
    authority,
    stage_attempt_ref: STAGE_ATTEMPT_REF,
    stage_request_sha256: stageSha,
    workflow_budget_receipt_ref: WORKFLOW_BUDGET_RECEIPT,
  });
  const context = Object.freeze({
    request: stage,
    principal: PRINCIPAL,
    input_bytes: new TextEncoder().encode("captured W2 input"),
    attempt_ref: STAGE_ATTEMPT_REF,
    budget_receipt_ref: WORKFLOW_BUDGET_RECEIPT,
    model_output_object_ref: prepared.call.output_object_ref,
    stage_request_sha256: stageSha,
    model_operation_id: MODEL_OPERATION_ID,
    model_idempotency_key: MODEL_IDEMPOTENCY_KEY,
  }) as ModelAttemptPreparationContext;
  const encoded = await validatedRequest(prepared);
  const pricingDocument = Object.freeze({
    protocol: "eliotr.research-model-pricing.v1",
    pricing_snapshot_ref: DEPLOYMENT.pricing_snapshot_ref,
    route_ref: DEPLOYMENT.route_ref,
    route_version: DEPLOYMENT.route_version,
    provider: "openrouter",
    exact_model_id: NATIVE_TRANSPORT_POLICY.model,
    pricing_basis: "EXACT_TOKEN_RATES_V1",
    input_rate_usd_per_1k_tokens: "0",
    output_rate_usd_per_1k_tokens: "0",
    effective_at: "2026-01-01T00:00:00.000Z",
    expires_at: PRICING_EXPIRY,
    provenance_ref: "controlled-pricing-provenance-1",
    approval_receipt_ref: "controlled-pricing-approval-1",
  });
  const pricingJson = canonicalJson(pricingDocument);
  const pricingRow = {
    ...pricingDocument,
    snapshot_sha256: await modelGatewaySha256(pricingJson),
    snapshot_json: pricingJson,
    created_at: NOW_ISO,
  };

  const mode = options.mode ?? "native";
  const baseCurrent: ResearchModelSpendCurrentAuthority = Object.freeze({
    authority,
    expected_deployment: DEPLOYMENT,
    ...(mode === "native" ? {
      model_selection: NATIVE_SELECTION,
      native_authority_binding: NATIVE_BINDING,
      run_configuration_mode: "snapshot-v2" as const,
    } : mode === "dynamic" ? {
      model_selection: Object.freeze({
        route_ref: DEPLOYMENT.route_ref,
        route_version: DEPLOYMENT.route_version,
        candidate_ref: "dynamic-candidate-1",
        candidate_sha256: "e".repeat(64),
        qualification_ref: "dynamic-qualification-1",
        qualification_sha256: "f".repeat(64),
      }),
      run_configuration_mode: "snapshot-v1" as const,
    } : {}),
  });
  let authorityReads = 0;
  const admissionRow: { current: Record<string, unknown> | null } = { current: null };
  const database = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (sql.startsWith("INSERT INTO research_model_spend_admission")) {
                const columns = /INSERT INTO research_model_spend_admission\(([^)]+)\)/u.exec(sql)?.[1] ?? "";
                const row: Record<string, unknown> = {};
                columns.split(",").forEach((column, index) => { row[column] = params[index]; });
                admissionRow.current = row;
                return row as T;
              }
              if (sql.startsWith("SELECT s.authorization_ref")) {
                return admissionRow.current === null ? null : {
                  ...admissionRow.current,
                  ...w3ReadbackColumns(admissionRow.current),
                } as T;
              }
              if (sql.startsWith("SELECT r.operation_id")) return makeWorkflowRow(stageSha) as T;
              if (sql.startsWith("SELECT m.attempt_id")) return modelRow(prepared, encoded) as T;
              if (sql.startsWith("SELECT provider,exact_model_id")) {
                return { provider: pricingDocument.provider, exact_model_id: pricingDocument.exact_model_id } as T;
              }
              if (sql.startsWith("SELECT pricing_snapshot_ref,route_ref,route_version")) return pricingRow as T;
              throw new Error(`unexpected local D1 query: ${sql.slice(0, 72)}`);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const admissions = createD1ResearchModelSpendAdmissionPort(database, {
    now: () => NOW,
    read_current_authority: async () => {
      authorityReads += 1;
      return authorityReads === 4 && options.mutateOnRead !== undefined
        ? options.mutateOnRead(baseCurrent)
        : baseCurrent;
    },
  });
  const approvalBase = {
    protocol: "eliotr.research-model-spend-approval.v1" as const,
    approved: true as const,
    authorization_ref: "model-authorization-1",
    policy_decision_ref: authority.policy_decision_ref,
    policy_generation: authority.policy_generation,
    currentness_digest: authority.currentness_digest,
    expires_at: ADMISSION_EXPIRY,
    expected_deployment: DEPLOYMENT,
  };
  const approval = Object.freeze({
    ...approvalBase,
    decision_digest: await modelGatewaySha256(canonicalJson(approvalBase)),
  });
  const admissionInput: ResearchModelSpendAdmissionInput = Object.freeze({
    request: Object.freeze({
      operation_id: MODEL_OPERATION_ID,
      principal_ref: PRINCIPAL.principal_ref,
      stage_attempt_ref: STAGE_ATTEMPT_REF,
      stage_request_sha256: stageSha,
      reservation_id: RESERVATION_ID,
      quote_ref: QUOTE_REF,
      route_ref: DEPLOYMENT.route_ref,
      scope_snapshot_ref: SCOPE,
      workflow_authorization_receipt_ref: WORKFLOW_RECEIPT,
    }),
    workflow_operation_id: WORKFLOW_OPERATION_ID,
    stage_index: 12,
    stage_request_json: stageJson,
    workflow_budget_receipt_ref: WORKFLOW_BUDGET_RECEIPT,
    intent,
    quote,
    authority,
    expected_deployment: DEPLOYMENT,
    approval,
    max_input_bytes: 16_384,
    max_output_bytes: 16_384,
  });
  await admissions.admit(admissionInput);
  return { admissions, admissionInput, authority, baseCurrent, context, database, prepared };
}

describe("Native spend admission readback binding", () => {
  it("carries the captured owner/project tuple from the real admission reader into the real revalidator", async () => {
    const value = await makeCase();
    const nativeResolutions: Array<{ readonly owner_ref: string; readonly project_id: string }> = [];
    let routeReads = 0;
    const readbacks: Array<Awaited<ReturnType<typeof value.admissions.read>>> = [];
    const revalidate = createD1ResearchModelAttemptRevalidator({
      database: value.database,
      spendAuthorization: {
        read: async (request: SpendAuthorizationReadRequest) => {
          const readback = await value.admissions.read(request);
          readbacks.push(readback);
          return readback;
        },
      },
      routeAuthority: { resolve: async () => { routeReads += 1; return null; } },
      nativeModelAuthority: {
        resolvePinned: async (request) => {
          nativeResolutions.push({ owner_ref: request.owner_ref, project_id: request.project_id });
          return {
            selection: NATIVE_SELECTION,
            candidate: { candidate: { preparation: { deployment: DEPLOYMENT } } },
          } as never;
        },
      },
      now: () => NOW,
    });

    await expect(revalidate(value.context, value.prepared)).resolves.toEqual(DEPLOYMENT);
    expect(readbacks[0]?.native_authority_binding).toEqual(NATIVE_BINDING);
    expect(nativeResolutions).toEqual([NATIVE_BINDING, NATIVE_BINDING]);
    expect(routeReads).toBe(0);
  });

  it.each(BINDING_MUTATIONS)("rejects a changed or absent %s before readback", async (_label, mutate) => {
    const value = await makeCase({ mutateOnRead: mutate });
    await expect(value.admissions.read(value.admissionInput.request))
      .rejects.toMatchObject({ code: "MODEL_ATTEMPT_AUTHORITY_STALE" });
  });

  it("keeps legacy and DynamicRoute readbacks free of Native bindings", async () => {
    const legacy = await makeCase({ mode: "legacy" });
    const legacyReadback = await legacy.admissions.read(legacy.admissionInput.request);
    expect(legacyReadback).not.toHaveProperty("model_selection");
    expect(legacyReadback).not.toHaveProperty("native_authority_binding");
    expect(legacyReadback).not.toHaveProperty("run_configuration_mode");

    const dynamic = await makeCase({ mode: "dynamic" });
    const dynamicReadback = await dynamic.admissions.read(dynamic.admissionInput.request);
    expect(dynamicReadback?.model_selection).toMatchObject({ candidate_ref: "dynamic-candidate-1" });
    expect(dynamicReadback?.run_configuration_mode).toBe("snapshot-v1");
    expect(dynamicReadback).not.toHaveProperty("native_authority_binding");
  });
});
