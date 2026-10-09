import { describe, expect, it } from "vitest";
import { ResolvedEvidenceSchema, type ResolvedEvidence } from "@eliotr/contracts";
import { serializeObjectResidencyKey } from "@eliotr/domain";
import type { NavigationReadAuthority, CloudflareEvidenceResolver } from "@eliotr/cloudflare-evidence";
import { createResearchSynthesisPreparation, type EvidenceFreezeSynthesisContext,
  type ModelAttemptPreparationContext, type ResearchSynthesisSpendAdmissionRecord } from "@eliotr/cloudflare-research";
import { StageRequestSchema, textDigest } from "@eliotr/cloudflare-workflows";
import type { EvidencePack } from "@eliotr/retrieval";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { createResearchSynthesisPromptDependencies } from "./research-synthesis-prompt.js";

const PRINCIPAL = { principal_ref: "owner-1", credential_generation: "credential-1", deployment_generation: "deployment-1" };
const SCOPE = { id: "scope-1", revision: 1 };
const SHA = "a".repeat(64);
const NOW = "2026-10-09T00:00:00.000Z";
const FUTURE = "2030-01-01T00:00:00.000Z";
const DEPLOYMENT: ModelRouteDeployment = { route_ref: "dynamic/eliotr-economy", route_version: "v1", prompt_generation: "prompt-1",
  schema_generation: "schema-1", parameters_digest: SHA, pricing_snapshot_ref: "pricing-1" };

async function evidence(id: string): Promise<ResolvedEvidence> {
  return ResolvedEvidenceSchema.parse({
    handle: { handle_ref: { id, revision: 1 }, source_namespace_id: "namespace-1",
      source_owner_generation: "generation-1", source_revision_ref: "revision-1", scope_snapshot_ref: SCOPE,
      anchor: { kind: "normalized_byte_range", start: 0, end: 4 }, excerpt_sha256: await textDigest("fact"),
      excerpt_byte_length: 4, object_residency_key_digest: SHA, source_assurance_ceiling: "EXACT",
      materializer_assurance_ceiling: "EXACT", terminal_state: "LIVE", created_at: NOW },
    exact_excerpt: "fact", verification_receipt_ref: "verification-1", authorization_receipt_ref: "authorization-1",
    credential_generation: PRINCIPAL.credential_generation, source_revision_content_sha256: SHA,
    scope_snapshot_digest: SHA, instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY", resolved_at: NOW,
  });
}

async function fixture(withBranches: boolean) {
  const bytes = new TextEncoder().encode("frozen");
  const digest = await textDigest("frozen");
  const object = { object_ref: "work/frozen", sha256: digest, byte_length: bytes.byteLength,
    residency: { scope_domain_id: SCOPE.id, access_domain_id: PRINCIPAL.principal_ref,
      confidentiality_domain_id: "confidentiality-1", encryption_key_domain_id: "key-1",
      retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
      content_digest: { algorithm: "sha256" as const, digest } } };
  const request = StageRequestSchema.parse({ protocol: "eliotr.workflow-stage.v1", operation_id: "operation-1",
    investigation_ref: { id: "investigation-1", revision: 13 }, stage: "SYNTHESIZE", idempotency_key: "workflow-key",
    handler_generation: "research-handlers.exploratory.v7", input_manifest: object });
  const requestSha = await textDigest(JSON.stringify(request));
  const rootPack: EvidencePack = { pack_ref: { id: "pack-root", revision: 1 }, scope_snapshot_ref: SCOPE,
    resolved_evidence: [await evidence("handle-root")], omitted_candidates: [],
    trace_ref: { id: "trace-root", revision: 1 }, total_utf8_bytes: 4 };
  const branchEvidence = await evidence("handle-branch");
  const synthesisPack: EvidencePack = { ...rootPack, pack_ref: { id: "pack-synthesis", revision: 1 },
    resolved_evidence: [...rootPack.resolved_evidence, branchEvidence], total_utf8_bytes: 8 };
  // Explicit context-port fixture: canonical freeze/branch lineage is qualified by its owning reader suites.
  const frozen = { operation_id: request.operation_id, investigation_id: request.investigation_ref.id,
    current_revision: 13, ...PRINCIPAL, authorization_receipt_ref: "authorization-1",
    stage_five: { scope_snapshot_ref: SCOPE, evidence_pack: rootPack },
    stage_ten_input: { manifest_ref: { id: "manifest-1", revision: 1 }, freeze_ref: { id: "freeze-1", revision: 1 },
      model_profile_definition: { deployment: DEPLOYMENT, max_context_bytes: 8192, policy: {} } },
    stage_eleven_receipt: { output_manifest: object },
    manifest: { manifest_ref: { id: "manifest-1", revision: 1 } }, freeze: { freeze_ref: { id: "freeze-1", revision: 1 } },
    w1_head: { policy_generation: "policy-1", goal: "Compare the exact evidence" },
    ...(withBranches ? { synthesis_evidence_pack: synthesisPack, branch_findings: {
      findings: [{ statement: "Candidate only; preserve uncertainty", evidence_handle_refs: [branchEvidence.handle.handle_ref] },
        { statement: "Independent candidate", evidence_handle_refs: [branchEvidence.handle.handle_ref] }],
      reconciliation_summary: { research_debts: [], omissions: [{ reason_code: "NO_HITS" }] },
      resolved_evidence: [branchEvidence], identity_digest: SHA,
    } } : {}),
  } as unknown as EvidenceFreezeSynthesisContext;
  const preparationInput: ModelAttemptPreparationContext = {
    request, principal: PRINCIPAL, input_bytes: bytes, attempt_ref: "attempt-1", stage_request_sha256: requestSha,
    budget_receipt_ref: "workflow-budget-1", model_operation_id: "model-operation-1", model_idempotency_key: "model-key-1",
    model_output_object_ref: "work/model-output",
  };
  const admission: ResearchSynthesisSpendAdmissionRecord = {
    operation_id: request.operation_id, stage_index: 12, stage_attempt_ref: preparationInput.attempt_ref,
    stage_request_sha256: requestSha, ...PRINCIPAL, workflow_budget_receipt_ref: preparationInput.budget_receipt_ref,
    authorization_ref: "admission-1", decision_digest: SHA, reservation_id: "reservation-1", quote_ref: "quote-1",
    route_ref: DEPLOYMENT.route_ref, scope_snapshot_ref: SCOPE, workflow_authorization_receipt_ref: "authorization-1",
    policy_generation: "policy-1", currentness_digest: SHA, expires_at: FUTURE, created_at: NOW,
    admission_ref: { id: "admission-1", revision: 1 }, admission_sha256: SHA,
    intent: { intent_ref: { id: preparationInput.model_operation_id, revision: 1 }, operation_kind: "REPORT",
      principal_ref: PRINCIPAL.principal_ref, idempotency_key: preparationInput.model_idempotency_key,
      payload_ref: "payload-1", policy_decision_ref: "decision-1", budget_reservation_ref: "reservation-1", created_at: NOW },
    quote: { quote_ref: "quote-1", reservation_id: "reservation-1", operation_kind: "REPORT",
      estimated_model_calls: 1, estimated_input_tokens: 1, estimated_output_tokens: 1, estimated_embedding_tokens: 0,
      quoted_neurons: 0, selected_routes: [DEPLOYMENT.route_ref], platform_usd: 0, workers_ai_usd: 0, byok_usd: 0,
      max_total_usd: 0, workflow_steps: 1, expected_sources: 1, expected_sections: 1, confidence: 1, expires_at: FUTURE },
    authority: { ...PRINCIPAL, client_class: "owner_pwa", policy_decision_ref: "decision-1", scope_snapshot_ref: SCOPE,
      policy_generation: "policy-1", currentness_digest: SHA, expires_at: FUTURE },
    deployment: DEPLOYMENT, max_input_bytes: 8192, max_output_bytes: 1024,
  };
  const prepared = await createResearchSynthesisPreparation({
    spend_admission: { readPreparation: async () => admission },
  })(preparationInput, frozen);
  let storageReads = 0;
  const database = { prepare: () => ({ bind: () => ({ first: async () => {
    storageReads += 1;
    return { operation_id: request.operation_id, stage_index: 12, request_json: JSON.stringify(request),
      request_sha256: requestSha, attempt_ref: "attempt-1", expected_revision: 13, attempt_state: "STARTED",
      output_json: null, investigation_id: request.investigation_ref.id, current_revision: 13, next_stage_index: 12,
      run_state: "ACTIVE", ...PRINCIPAL, scope_snapshot_id: SCOPE.id, scope_snapshot_revision: SCOPE.revision,
      idempotency_key: request.idempotency_key, handler_generation: request.handler_generation, ledger_revision: 13 };
  } }) }) } as unknown as D1Database;
  const metadata = { key: object.object_ref, size: bytes.byteLength, etag: "etag-1",
    checksums: { sha256: Uint8Array.from(digest.match(/../gu) ?? [], (hex) => Number.parseInt(hex, 16)).buffer },
    customMetadata: { immutable: "true", residency: serializeObjectResidencyKey(object.residency) } };
  const workBucket = { head: async () => metadata, get: async () => ({ ...metadata,
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
  }) } as unknown as R2Bucket;
  const navigation = { access: PRINCIPAL, scope: { snapshot_id: SCOPE.id, revision: SCOPE.revision },
    current: async () => ({}), sources: async () => [] } as unknown as NavigationReadAuthority;
  const prompt = createResearchSynthesisPromptDependencies({ database, work_bucket: workBucket,
    operation_id: request.operation_id, principal: PRINCIPAL, context: { read: async () => frozen }, navigation,
    evidence_resolver: { resolveHandle: async () => { throw new Error("unexpected resolver effect"); } } as unknown as CloudflareEvidenceResolver,
    trusted_parameters: { prompt: "Use exact evidence", max_tokens: 64 }, request_timeout_ms: 1000 });
  return { prepared, prompt, frozen, rootPack, synthesisPack, storageReads: () => storageReads };
}

describe("frozen synthesis evidence handoff", () => {
  it("carries branch evidence and candidate findings from preparation through the prompt boundary", async () => {
    const input = await fixture(true);
    const original = JSON.stringify(input.frozen);
    expect(input.prepared.call.evidence_pack).toEqual(input.synthesisPack);
    const manifest = await input.prompt.build_manifest_input(input.prepared.call, DEPLOYMENT);
    expect(manifest.evidence_pack.resolved_evidence.map((item) => item.handle.handle_ref.id))
      .toEqual(["handle-root", "handle-branch"]);
    expect(manifest.untrusted_candidate_context).toMatchObject({
      findings: input.frozen.branch_findings?.findings,
      reconciliation_summary: input.frozen.branch_findings?.reconciliation_summary,
    });
    expect(manifest.untrusted_candidate_context).not.toHaveProperty("resolved_evidence");
    expect(manifest.untrusted_candidate_context).not.toHaveProperty("identity_digest");
    expect(manifest.required_handle_refs).toEqual([{ id: "handle-branch", revision: 1 }]);
    expect(input.storageReads()).toBe(1);
    expect(JSON.stringify(input.frozen)).toBe(original);
  });

  it("preserves historical synthesis without adding branch context or mandatory references", async () => {
    const input = await fixture(false);
    expect(input.prepared.call.evidence_pack).toEqual(input.rootPack);
    const manifest = await input.prompt.build_manifest_input(input.prepared.call, DEPLOYMENT);
    expect(manifest.evidence_pack).toEqual(input.rootPack);
    expect(manifest).not.toHaveProperty("untrusted_candidate_context");
    expect(manifest).not.toHaveProperty("required_handle_refs");
  });

  it("rejects substitution of the root pack after a branch pack has been frozen", async () => {
    const input = await fixture(true);
    await expect(input.prompt.build_manifest_input({ ...input.prepared.call, evidence_pack: input.rootPack }, DEPLOYMENT))
      .rejects.toMatchObject({ code: "MODEL_GATEWAY_PROMPT_COMPILE_FAILED", retryable: false });
  });
});
