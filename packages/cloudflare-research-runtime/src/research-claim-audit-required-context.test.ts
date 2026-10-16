import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AllowedReferenceManifest, ResolvedEvidence } from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import { ContextCompilationBlockedError, createEvidenceContextCompiler, type ContextRequestProjection } from "@eliotr/policy";
import type { ResearchClaimAuditInputSnapshot } from "@eliotr/cloudflare-research-stages";
import type { ModelCallInput } from "@eliotr/research";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { readWorkflowObject, type StageRequest } from "@eliotr/cloudflare-workflows";
import { readStartedResearchStageAttempt } from "./research-synthesis-prompt.js";
import { createResearchClaimAuditPromptDependencies, type ResearchClaimAuditPromptDependenciesInput } from "./research-claim-audit-prompt.js";

vi.mock("@eliotr/cloudflare-workflows", async (original) => ({
  ...await original() as Record<string, unknown>, readWorkflowObject: vi.fn(),
}));
vi.mock("./research-synthesis-prompt.js", async (original) => ({
  ...await original() as Record<string, unknown>, readStartedResearchStageAttempt: vi.fn(),
}));

const NOW = Date.parse("2026-10-16T16:40:10.000Z");
const encoder = new TextEncoder();
const key = (ref: { readonly id: string; readonly revision: number }) => `${ref.id}:${ref.revision}`;

function serialize(projection: ContextRequestProjection): string {
  return canonicalEvidenceJson({ evidence: projection.blocks, selection_receipt: projection.selection_receipt,
    manifest_ref: projection.manifest_ref, system_instructions: projection.system_instructions });
}

async function fixture(maxBytes = 4000) {
  const principal = { principal_ref: "owner-1", credential_generation: "credential-1", deployment_generation: "deployment-1" };
  const scopeRef = { id: "scope-1", revision: 1 };
  const deployment: ModelRouteDeployment = { route_ref: "dynamic/eliotr-audit-verifier", route_version: "route-1",
    prompt_generation: "prompt-1", schema_generation: "schema-1", parameters_digest: "a".repeat(64), pricing_snapshot_ref: "pricing-1" };
  const evidence: ResolvedEvidence[] = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const text = `exact-${index}:` + "x".repeat(1000);
    const bytes = encoder.encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return {
      handle: { handle_ref: { id: `handle-${index}`, revision: 1 }, source_namespace_id: "namespace-1",
        source_owner_generation: "owner-1", source_revision_ref: `source-${index < 6 ? index : 0}`,
        scope_snapshot_ref: scopeRef, anchor: { kind: "normalized_byte_range" as const, start: 0, end: bytes.byteLength },
        excerpt_sha256: sha, excerpt_byte_length: bytes.byteLength, object_residency_key_digest: "b".repeat(64),
        source_assurance_ceiling: "EXACT" as const, materializer_assurance_ceiling: "EXACT" as const,
        terminal_state: "LIVE" as const, created_at: new Date(NOW).toISOString() },
      exact_excerpt: text, verification_receipt_ref: `verified-${index}`, authorization_receipt_ref: "authorization-1",
      credential_generation: principal.credential_generation, source_revision_content_sha256: "c".repeat(64),
      scope_snapshot_digest: "d".repeat(64), instruction_taint: "DATA_ONLY" as const,
      allowed_effects: "READ_ONLY" as const, resolved_at: new Date(NOW).toISOString(),
    };
  }));
  const cited = evidence.slice(6);
  const pack = { pack_ref: { id: "pack-1", revision: 1 }, scope_snapshot_ref: scopeRef,
    resolved_evidence: evidence, omitted_candidates: [], trace_ref: { id: "trace-1", revision: 1 },
    total_utf8_bytes: evidence.reduce((total, item) => total + item.handle.excerpt_byte_length, 0) };
  const manifestPayload = { manifest_ref: { id: "manifest-1", revision: 1 }, scope_snapshot_ref: scopeRef,
    allowed_source_revision_refs: [...new Set(evidence.map((item) => item.handle.source_revision_ref))],
    allowed_evidence_handle_refs: evidence.map((item) => item.handle.handle_ref), allowed_tool_definition_refs: [],
    allowed_verifier_refs: ["verifier-1"], permitted_anchor_and_precision_ceilings: [], provider_and_policy_generations: { policy: "policy-1" },
    stale_or_revoked_entries: [], permitted_acquisition_or_expansion_routes: [], disclosure_ceiling: "PRIVATE",
    allowed_use: ["research"], expires_at: "2030-01-01T00:00:00.000Z", client_fence_ref: principal.credential_generation };
  const manifest: AllowedReferenceManifest = { ...manifestPayload, manifest_digest: await evidenceSha256(manifestPayload) };
  const freezeRef = { id: "freeze-1", revision: 1 };
  const inputSha = "e".repeat(64);
  const request: StageRequest = { protocol: "eliotr.workflow-stage.v1", operation_id: "operation-1",
    investigation_ref: { id: "investigation-1", revision: 15 }, stage: "AUDIT_CLAIMS", idempotency_key: "audit-key-1",
    handler_generation: "handler-1", input_manifest: { object_ref: "workflow/verified-input", sha256: inputSha, byte_length: 1,
      residency: { scope_domain_id: scopeRef.id, access_domain_id: principal.principal_ref, confidentiality_domain_id: "private",
        encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
        content_digest: { algorithm: "sha256", digest: inputSha } } } };
  const normalization = { section_ref: { id: "section-1", revision: 1 }, required_precision: "exact-excerpt", required_source_class: "owner_document" };
  const synthesis = { stage_attempt_ref: "synthesis-attempt", stage_request_sha256: "f".repeat(64), output_sha256: "a".repeat(64) };
  const audit = { protocol: "eliotr.research.audit-claims-input.v1", request, principal,
    context: { operation_id: request.operation_id, ...principal, manifest, stage_five: { evidence_pack: pack },
      freeze: { freeze_ref: freezeRef, scope_snapshot_ref: scopeRef } },
    verify: { operation_id: request.operation_id, synthesis, normalization, freeze_ref: freezeRef, scope_snapshot_ref: scopeRef,
      manifest_ref: manifest.manifest_ref, source_verification: { resolved: cited.map((item) => ({ handle_ref: item.handle.handle_ref })) } },
    synthesis, normalization, claims: { section_ref: normalization.section_ref, claims: [] }, evidence: cited,
    verifier: { qualified: true, current: true, deployment_generation: principal.deployment_generation,
      verifier_ref: "verifier-1", verifier_schema_generation: "verifier-schema-1", deployment },
    evidence_input_sha256: "b".repeat(64), max_context_bytes: maxBytes,
  } as unknown as ResearchClaimAuditInputSnapshot;
  const modelInput: ModelCallInput = { route_ref: deployment.route_ref, prompt_generation: deployment.prompt_generation,
    schema_generation: deployment.schema_generation, evidence_pack: pack, max_input_bytes: maxBytes,
    max_output_bytes: 65536, output_object_ref: "model-output/audit", budget_reservation_ref: "budget-1" };
  vi.mocked(readStartedResearchStageAttempt).mockResolvedValue({ request, request_sha256: "c".repeat(64), attempt_ref: "attempt-audit" });
  vi.mocked(readWorkflowObject).mockResolvedValue(new Uint8Array([1]));
  const resolveHandle = vi.fn();
  const input = { database: { prepare: vi.fn() }, work_bucket: { get: vi.fn() },
    operation_id: request.operation_id, principal, audit_input: { read: vi.fn(async () => audit) },
    navigation: { access: principal, scope: { snapshot_id: scopeRef.id, revision: 1 }, current: vi.fn(async () => ({})), sources: vi.fn() },
    evidence_resolver: { resolveHandle }, manifest_store: { get: vi.fn(async () => manifest) },
    trusted_parameters: { prompt: "Audit only the verified claims and exact evidence.", max_tokens: 100 }, request_timeout_ms: 1000,
  } as unknown as ResearchClaimAuditPromptDependenciesInput;
  return { dependencies: createResearchClaimAuditPromptDependencies(input), modelInput, deployment, audit, manifest, evidence, cited, resolveHandle };
}

beforeEach(() => vi.resetAllMocks());

describe("required verified evidence in audit prompt context", () => {
  it("requires exactly the fresh verified cited set while retaining the full frozen pack and bounds", async () => {
    const f = await fixture();
    const input = await f.dependencies.build_manifest_input(f.modelInput, f.deployment);
    expect(input.required_handle_refs).toEqual(f.cited.map((item) => item.handle.handle_ref));
    expect(input.evidence_pack).toEqual(f.modelInput.evidence_pack);
    expect(input.max_context_bytes).toBe(f.modelInput.max_input_bytes);
    expect(input.required_handle_refs?.[0]).not.toBe(f.cited[0]?.handle.handle_ref);
    expect(Object.isFrozen(input.required_handle_refs)).toBe(true);
    expect(Object.isFrozen(input.required_handle_refs?.[0])).toBe(true);
    expect(f.resolveHandle).not.toHaveBeenCalled();
  });

  it("retains late cited blocks despite crowded optional sources with exact deterministic bytes and digests", async () => {
    const f = await fixture();
    const input = await f.dependencies.build_manifest_input(f.modelInput, f.deployment);
    const compilerInput = { manifest: f.manifest, evidence: input.evidence_pack.resolved_evidence, modelRouteRef: input.model_route_ref,
      maxBytes: input.max_context_bytes, serializeRequestBody: serialize, preferSourceDiversity: true,
      ...(input.required_handle_refs === undefined ? {} : { requiredHandleRefs: input.required_handle_refs }) };
    const compiler = createEvidenceContextCompiler({ now: () => NOW });
    const compiled = await compiler.compile(compilerInput);
    expect(compiled.blocks.map((block) => key(block.evidence_handle_ref))).toEqual(["handle-6:1", "handle-7:1"]);
    expect(compiled.selection_receipt.admitted_candidate_refs).toEqual(["handle-6:1", "handle-7:1"]);
    for (const [index, block] of compiled.blocks.entries()) {
      expect(block.quoted_content).toBe(f.cited[index]?.exact_excerpt);
      expect(block.excerpt_sha256).toBe(f.cited[index]?.handle.excerpt_sha256);
    }
    expect(compiled.total_utf8_bytes).toBe(encoder.encode(serialize(compiled)).byteLength);
    expect(compiled.total_utf8_bytes).toBeLessThanOrEqual(input.max_context_bytes);
    expect(await compiler.compile(compilerInput)).toEqual(compiled);
  });

  it("fails closed when all required cited excerpts cannot fit rather than silently dropping support", async () => {
    const f = await fixture(2000);
    const input = await f.dependencies.build_manifest_input(f.modelInput, f.deployment);
    const pending = createEvidenceContextCompiler({ now: () => NOW }).compile({ manifest: f.manifest,
      evidence: input.evidence_pack.resolved_evidence, modelRouteRef: input.model_route_ref,
      maxBytes: input.max_context_bytes, serializeRequestBody: serialize, preferSourceDiversity: true,
      ...(input.required_handle_refs === undefined ? {} : { requiredHandleRefs: input.required_handle_refs }) });
    await expect(pending).rejects.toBeInstanceOf(ContextCompilationBlockedError);
    await expect(pending).rejects.toMatchObject({ blockers: f.cited.map((item) => ({
      handle_ref: item.handle.handle_ref, reason_code: "REQUIRED_CONTEXT_BYTE_BUDGET_EXCEEDED",
    })), selection_receipt: { admitted_candidate_refs: [] } });
  });

  it("rejects a cited set differing from the verified frozen binding before returning manifest input", async () => {
    const f = await fixture();
    const foreignToVerification = f.evidence[0];
    if (foreignToVerification === undefined) throw new Error("missing fixture evidence");
    const audit = f.audit as unknown as { evidence: readonly ResolvedEvidence[] };
    audit.evidence = [foreignToVerification];
    await expect(f.dependencies.build_manifest_input(f.modelInput, f.deployment))
      .rejects.toMatchObject({ code: "MODEL_GATEWAY_PROMPT_COMPILE_FAILED" });
    expect(f.resolveHandle).not.toHaveBeenCalled();
  });
});
