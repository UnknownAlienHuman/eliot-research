import { describe, expect, it } from "vitest";
import { StageRequestSchema, textDigest } from "@eliotr/cloudflare-workflows";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import type { EvidencePack } from "@eliotr/retrieval";
import { deriveBranchRoleStageRequest } from "./research-branch-role-model.js";
import {
  createResearchBranchRolePreparation,
  recoverBranchStageRequest,
} from "./research-branch-role-preparation.js";
import { ModelAttemptError, type ModelAttemptReservationInput } from "./model-attempt-types.js";
import type { ModelAttemptPreparationContext } from "./model-attempt-handler.js";
import type { ResearchModelSpendAdmissionRecord } from "./research-model-spend-admission.js";

const REQUEST = StageRequestSchema.parse({
  protocol: "eliotr.workflow-stage.v1",
  operation_id: "op-1",
  investigation_ref: { id: "inv-1", revision: 2 },
  stage: "ANALYZE_BRANCHES",
  idempotency_key: "stage-key",
  handler_generation: "server-owned-branch-v1",
  input_manifest: {
    object_ref: "obj-1",
    sha256: "a".repeat(64),
    byte_length: 10,
    residency: {
      scope_domain_id: "scope-1",
      access_domain_id: "access-1",
      confidentiality_domain_id: "conf-1",
      encryption_key_domain_id: "enc-1",
      retention_domain_id: "ret-1",
      erasure_domain_id: "era-1",
      content_digest: { algorithm: "sha256", digest: "a".repeat(64) },
    },
  },
});

const PRINCIPAL = { principal_ref: "principal-1", credential_generation: "cred-1", deployment_generation: "dep-1" };
const ATTEMPT_REF = "attempt-1";
const BUDGET_RECEIPT_REF = "budget-receipt-1";
const MODEL_OPERATION_ID = "model-operation-aaa";
const MODEL_IDEMPOTENCY_KEY = "model-idempotency-bbb";
const MODEL_OUTPUT_OBJECT_REF = "model-output/bbb/attempt-1";
const RESERVATION_ID = "model-reservation-ccc";
const QUOTE_REF = "model-quote-ccc";
const ROUTE_REF = "dynamic/eliotr-economy";
const FUTURE = "2030-01-01T00:00:00.000Z";

const DEPLOYMENT = {
  route_ref: ROUTE_REF,
  route_version: "v1",
  prompt_generation: "pg-1",
  schema_generation: "sg-1",
  parameters_digest: "a".repeat(64),
  pricing_snapshot_ref: "price-1",
};

function admissionRecord(roleSha: string): ResearchModelSpendAdmissionRecord {
  const intent = {
    intent_ref: { id: MODEL_OPERATION_ID, revision: 1 },
    operation_kind: "RESEARCH",
    principal_ref: PRINCIPAL.principal_ref,
    idempotency_key: MODEL_IDEMPOTENCY_KEY,
    payload_ref: "branch-role-payload-ccc",
    cancellation_ref: "branch-role-cancel-ccc",
    policy_decision_ref: "pd-1",
    budget_reservation_ref: RESERVATION_ID,
    created_at: "2026-10-01T09:00:00.000Z",
  };
  const quote = {
    quote_ref: QUOTE_REF,
    reservation_id: RESERVATION_ID,
    operation_kind: "RESEARCH",
    estimated_model_calls: 1,
    estimated_input_tokens: 10,
    estimated_output_tokens: 10,
    estimated_embedding_tokens: 0,
    quoted_neurons: 0,
    selected_routes: [ROUTE_REF],
    platform_usd: 0,
    workers_ai_usd: 0,
    byok_usd: 0,
    max_total_usd: 0.01,
    workflow_steps: 1,
    expected_sources: 1,
    expected_sections: 1,
    confidence: 0.5,
    expires_at: FUTURE,
  };
  const authority = {
    principal_ref: PRINCIPAL.principal_ref,
    client_class: "owner_pwa",
    policy_decision_ref: "pd-1",
    scope_snapshot_ref: { id: "scope-1", revision: 1 },
    credential_generation: PRINCIPAL.credential_generation,
    deployment_generation: PRINCIPAL.deployment_generation,
    policy_generation: "polgen-1",
    currentness_digest: "b".repeat(64),
    expires_at: FUTURE,
  };
  return {
    authorization_ref: "model-authorization-ccc",
    decision_digest: "c".repeat(64),
    operation_id: MODEL_OPERATION_ID,
    principal_ref: PRINCIPAL.principal_ref,
    stage_attempt_ref: ATTEMPT_REF,
    stage_request_sha256: roleSha,
    reservation_id: RESERVATION_ID,
    quote_ref: QUOTE_REF,
    route_ref: ROUTE_REF,
    scope_snapshot_ref: { id: "scope-1", revision: 1 },
    workflow_authorization_receipt_ref: "war-1",
    policy_generation: "polgen-1",
    currentness_digest: "b".repeat(64),
    expires_at: FUTURE,
    expected_deployment: DEPLOYMENT,
    admission_ref: { id: "model-authorization-ccc", revision: 1 },
    admission_sha256: "d".repeat(64),
    workflow_operation_id: "op-1",
    stage_index: 8,
    role: "SUPPORT",
    stage_request_json: JSON.stringify(REQUEST),
    workflow_budget_receipt_ref: BUDGET_RECEIPT_REF,
    intent,
    quote,
    authority,
    approval: {
      protocol: "eliotr.research-model-spend-approval.v1",
      approved: true,
      authorization_ref: "model-authorization-ccc",
      decision_digest: "c".repeat(64),
      policy_decision_ref: "pd-1",
      policy_generation: "polgen-1",
      currentness_digest: "b".repeat(64),
      expires_at: FUTURE,
      expected_deployment: DEPLOYMENT,
    },
    max_input_bytes: 1024,
    max_output_bytes: 1024,
    created_at: "2026-10-01T09:00:00.000Z",
  } as ResearchModelSpendAdmissionRecord;
}

const EVIDENCE_PACK: EvidencePack = {
  pack_ref: { id: "pack-1", revision: 1 },
  scope_snapshot_ref: { id: "scope-1", revision: 1 },
  resolved_evidence: [],
  omitted_candidates: [],
  trace_ref: { id: "trace-1", revision: 1 },
  total_utf8_bytes: 0,
};

async function contextFor(roleSha: string): Promise<ModelAttemptPreparationContext> {
  const roleRequest = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
  return {
    request: roleRequest,
    principal: PRINCIPAL,
    input_bytes: new Uint8Array(),
    attempt_ref: ATTEMPT_REF,
    budget_receipt_ref: BUDGET_RECEIPT_REF,
    model_output_object_ref: MODEL_OUTPUT_OBJECT_REF,
    stage_request_sha256: roleSha,
    model_operation_id: MODEL_OPERATION_ID,
    model_idempotency_key: MODEL_IDEMPOTENCY_KEY,
  };
}

async function conflictCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelAttemptError);
    return (error as ModelAttemptError).code;
  }
  throw new Error("expected the preparation to fail closed");
}

describe("recoverBranchStageRequest", () => {
  it("round-trips deriveBranchRoleStageRequest", async () => {
    const derived = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const recovered = await recoverBranchStageRequest(derived, "SUPPORT");
    expect(recovered.request.idempotency_key).toBe("stage-key");
    expect(canonicalJson(recovered.request)).toBe(canonicalJson(REQUEST));
    expect(recovered.sha256).toBe(await textDigest(JSON.stringify(REQUEST)));
  });

  it("gives each role its own recovered identity", async () => {
    const support = await recoverBranchStageRequest(deriveBranchRoleStageRequest(REQUEST, "SUPPORT"), "SUPPORT");
    const counter = await recoverBranchStageRequest(deriveBranchRoleStageRequest(REQUEST, "COUNTER"), "COUNTER");
    expect(support.sha256).toBe(counter.sha256);
    expect(support.request.idempotency_key).toBe("stage-key");
  });

  it("fails closed when the request is not role-scoped", async () => {
    await expect(recoverBranchStageRequest(REQUEST, "SUPPORT")).rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_MISSING" });
  });

  it("fails closed when the role does not match the suffix", async () => {
    const derived = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    await expect(recoverBranchStageRequest(derived, "COUNTER")).rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_MISSING" });
  });

  it("rejects unknown roles", async () => {
    const derived = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    await expect(recoverBranchStageRequest(derived, "NOPE" as never)).rejects.toThrow();
  });
});

describe("createResearchBranchRolePreparation", () => {
  it("builds the reservation from a bound admission", async () => {
    const roleRequest = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const roleSha = await textDigest(JSON.stringify(roleRequest));
    const prepare = createResearchBranchRolePreparation();
    const prepared: ModelAttemptReservationInput = await prepare(
      await contextFor(roleSha), "SUPPORT", admissionRecord(roleSha), EVIDENCE_PACK);
    expect(prepared.idempotency_key).toBe(MODEL_IDEMPOTENCY_KEY);
    expect(prepared.stage_attempt_ref).toBe(ATTEMPT_REF);
    expect(prepared.stage_request_sha256).toBe(roleSha);
    expect(prepared.workflow_stage_request_sha256).toBe(await textDigest(JSON.stringify(REQUEST)));
    expect(prepared.workflow_budget_receipt_ref).toBe(BUDGET_RECEIPT_REF);
    expect(prepared.intent.intent_ref.id).toBe(MODEL_OPERATION_ID);
    expect(prepared.intent.operation_kind).toBe("RESEARCH");
    expect(prepared.call.route_ref).toBe(ROUTE_REF);
    expect(prepared.call.prompt_generation).toBe("pg-1");
    expect(prepared.call.schema_generation).toBe("sg-1");
    expect(prepared.call.output_object_ref).toBe(MODEL_OUTPUT_OBJECT_REF);
    expect(prepared.call.budget_reservation_ref).toBe(RESERVATION_ID);
    expect(prepared.call.cancellation_ref).toBe("branch-role-cancel-ccc");
    expect(prepared.call.max_input_bytes).toBe(1024);
    expect(prepared.call.max_output_bytes).toBe(1024);
    expect(prepared.quote.reservation_id).toBe(RESERVATION_ID);
    expect(prepared.authority.policy_decision_ref).toBe("pd-1");
  });

  it("fails closed when the admission operation does not match the context", async () => {
    const roleRequest = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const roleSha = await textDigest(JSON.stringify(roleRequest));
    const prepare = createResearchBranchRolePreparation();
    const admission = { ...admissionRecord(roleSha), operation_id: "other-operation" };
    expect(await conflictCode(async () => prepare(await contextFor(roleSha), "SUPPORT", admission, EVIDENCE_PACK)))
      .toBe("MODEL_ATTEMPT_IDENTITY_CONFLICT");
  });

  it("fails closed when the admission idempotency key does not match", async () => {
    const roleRequest = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const roleSha = await textDigest(JSON.stringify(roleRequest));
    const prepare = createResearchBranchRolePreparation();
    const admission = admissionRecord(roleSha);
    const tampered = { ...admission, intent: { ...admission.intent, idempotency_key: "other-key" } };
    expect(await conflictCode(async () => prepare(await contextFor(roleSha), "SUPPORT", tampered, EVIDENCE_PACK)))
      .toBe("MODEL_ATTEMPT_IDENTITY_CONFLICT");
  });

  it("fails closed when the admission stage sha does not match the context", async () => {
    const roleRequest = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const roleSha = await textDigest(JSON.stringify(roleRequest));
    const prepare = createResearchBranchRolePreparation();
    const admission = { ...admissionRecord(roleSha), stage_request_sha256: "e".repeat(64) };
    expect(await conflictCode(async () => prepare(await contextFor(roleSha), "SUPPORT", admission, EVIDENCE_PACK)))
      .toBe("MODEL_ATTEMPT_IDENTITY_CONFLICT");
  });

  it("fails closed when the admission budget receipt does not match", async () => {
    const roleRequest = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const roleSha = await textDigest(JSON.stringify(roleRequest));
    const prepare = createResearchBranchRolePreparation();
    const admission = { ...admissionRecord(roleSha), workflow_budget_receipt_ref: "other-receipt" };
    expect(await conflictCode(async () => prepare(await contextFor(roleSha), "SUPPORT", admission, EVIDENCE_PACK)))
      .toBe("MODEL_ATTEMPT_IDENTITY_CONFLICT");
  });

  it("fails closed when the admission stage attempt does not match the context", async () => {
    const roleRequest = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const roleSha = await textDigest(JSON.stringify(roleRequest));
    const prepare = createResearchBranchRolePreparation();
    const admission = { ...admissionRecord(roleSha), stage_attempt_ref: "other-attempt" };
    expect(await conflictCode(async () => prepare(await contextFor(roleSha), "SUPPORT", admission, EVIDENCE_PACK)))
      .toBe("MODEL_ATTEMPT_IDENTITY_CONFLICT");
  });

  it("fails closed when the admission stage request is not JSON", async () => {
    const roleRequest = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const roleSha = await textDigest(JSON.stringify(roleRequest));
    const prepare = createResearchBranchRolePreparation();
    const admission = { ...admissionRecord(roleSha), stage_request_json: "not json" };
    expect(await conflictCode(async () => prepare(await contextFor(roleSha), "SUPPORT", admission, EVIDENCE_PACK)))
      .toBe("MODEL_ATTEMPT_INPUT_INVALID");
  });

  it("fails closed when the admitted stage bytes differ from the recovered stage request", async () => {
    const roleRequest = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const roleSha = await textDigest(JSON.stringify(roleRequest));
    const prepare = createResearchBranchRolePreparation();
    const tamperedRequest = { ...REQUEST, idempotency_key: "tampered-key" };
    const admission = { ...admissionRecord(roleSha), stage_request_json: JSON.stringify(tamperedRequest) };
    expect(await conflictCode(async () => prepare(await contextFor(roleSha), "SUPPORT", admission, EVIDENCE_PACK)))
      .toBe("MODEL_ATTEMPT_IDENTITY_CONFLICT");
  });
});
