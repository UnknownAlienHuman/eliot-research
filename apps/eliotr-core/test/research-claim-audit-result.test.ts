import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { MAX_WORKFLOW_RECEIPT_BYTES } from "@eliotr/cloudflare-workflows";
import {
  decodeResearchClaimAuditResult,
  encodeResearchClaimAuditResult,
  type ResearchClaimAuditClaimInput,
  type ResearchClaimAuditResult,
  type ResearchClaimAuditResultInput,
} from "../../../packages/cloudflare-research-stages/src/research-claim-audit-result.js";
import { describe, expect, it } from "vitest";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const supportRef = { id: "evidence-support", revision: 1 } as const;
const counterRef = { id: "evidence-counter", revision: 1 } as const;
const freezeRef = { id: "freeze-audit", revision: 1 } as const;
const scopeRef = { id: "scope-audit", revision: 1 } as const;
const manifestRef = { id: "manifest-audit", revision: 1 } as const;
const sectionRef = { id: "section-audit", revision: 1 } as const;
const dispositions = [
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "UNSUPPORTED",
  "CONTRADICTED",
  "NOT_VERIFIABLE_IN_SCOPE",
] as const;

function digestFor(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function makeClaims(
  coverageLimitations: readonly string[] = ["server-owned coverage limit"],
): ResearchClaimAuditClaimInput[] {
  return dispositions.map((disposition, index) => ({
    claim_ref: { id: `research-claim-${index}`, revision: 1 },
    claim_text_digest: digestFor(100 + index),
    claim_kind: index % 2 === 0 ? "observation" : "interpretation",
    support_handle_refs: [supportRef],
    counterevidence_handle_refs: index === 0 ? [counterRef] : [],
    reference_verification: index === 2 ? "NOT_APPLICABLE" : "PASS",
    value_or_measurement_verification: index === 1 ? "FAIL" : "PASS",
    specification_compliance: "PASS",
    method_artifact_alignment: index === 3 ? "FAIL" : "PASS",
    source_satisfies_requirement: index % 2 === 0,
    supplied_excerpt_supports_requirement: index % 2 !== 0,
    evidence_grade: `E${index % 4}` as "E0" | "E1" | "E2" | "E3",
    lane: index % 2 === 0 ? "exploratory" : "mixed_with_declared_split",
    coverage_limitations: index === 0 ? [...coverageLimitations] : ["server-owned coverage limit"],
    unsupported_precision: index === 0 ? [{
      asserted_reference_or_coordinate: "Q1",
      highest_supported_precision: "source-level",
      source_and_coverage_basis: ["coverage-basis-1"],
      risk_of_false_precision: "false precision risk",
      required_probe_or_narrower_wording: "narrow wording required",
    }] : [],
    disposition,
  }));
}

function makeNormalizedClaims(claims: readonly ResearchClaimAuditClaimInput[]) {
  return claims.map((claim, index) => ({
    claim_ref: claim.claim_ref,
    text: `claim text ${index}`,
    text_digest: claim.claim_text_digest,
    kind: claim.claim_kind,
    support_handle_refs: claim.support_handle_refs,
    counterevidence_handle_refs: claim.counterevidence_handle_refs,
    required_precision: "precision-exact",
    required_source_class: "official",
    span: { start: index, end: index + 1 },
  }));
}

function makeInput(coverageLimitations: readonly string[] = ["server-owned coverage limit"]): ResearchClaimAuditResultInput {
  const claims = makeClaims(coverageLimitations);
  const normalizedClaims = makeNormalizedClaims(claims);
  const auditInput = {
    protocol: "eliotr.research.audit-claims-input.v1",
    request: {
      operation_id: "operation-audit",
      investigation_ref: { id: "investigation-audit", revision: 1 },
      stage: "AUDIT_CLAIMS",
      input_manifest: { sha256: digestFor(17) },
    },
    context: {
      operation_id: "operation-audit",
      investigation_id: "investigation-audit",
      current_revision: 1,
      freeze: { freeze_ref: freezeRef, scope_snapshot_ref: scopeRef },
      manifest: { manifest_ref: manifestRef },
    },
    verify: {
      protocol: "eliotr.research.verification.v2",
      operation_id: "operation-audit",
      stage: "VERIFY",
      stage_attempt_ref: "verify-attempt",
      stage_request_sha256: digestFor(11),
      synthesis: {
        stage_attempt_ref: "synthesis-attempt",
        stage_request_sha256: digestFor(12),
        output_sha256: digestFor(13),
      },
      freeze_ref: freezeRef,
      scope_snapshot_ref: scopeRef,
      manifest_ref: manifestRef,
      normalization: {
        section_ref: sectionRef,
        required_precision: "precision-exact",
        required_source_class: "official",
        claims: normalizedClaims.map((claim) => ({
          claim_ref: claim.claim_ref,
          claim_text_digest: claim.text_digest,
          claim_kind: claim.kind,
          support_handle_refs: claim.support_handle_refs,
          counterevidence_handle_refs: claim.counterevidence_handle_refs,
        })),
        cited_handle_refs: [supportRef, counterRef],
        binding_sha256: digestFor(14),
      },
      source_verification: {
        requested_handle_refs: [supportRef, counterRef],
        resolved: [],
      },
      semantic_verification: "NOT_EXECUTED",
      verified_at: "2026-09-12T00:00:00.000Z",
    },
    synthesis: {
      stage_attempt_ref: "synthesis-attempt",
      stage_request_sha256: digestFor(12),
      output_sha256: digestFor(13),
    },
    normalization: {
      section_ref: sectionRef,
      required_precision: "precision-exact",
      required_source_class: "official",
    },
    claims: {
      schema: "eliotr.research.synthesis-claims.v2",
      operation_id: "operation-audit",
      section_ref: sectionRef,
      section_text: "claim text 0 claim text 1 claim text 2 claim text 3 claim text 4",
      claims: normalizedClaims,
      cited_handle_refs: [supportRef, counterRef],
    },
    evidence: [],
    verifier: {
      allowed_verifier_refs: ["verifier-audit"],
      verifier_ref: "verifier-audit",
      verifier_schema_generation: "schema-generation-1",
      deployment: {
        route_ref: "route-audit",
        route_version: "route-version-1",
        prompt_generation: "prompt-generation-1",
        schema_generation: "schema-generation-1",
        parameters_digest: digestFor(18),
        pricing_snapshot_ref: "pricing-snapshot-1",
      },
      deployment_generation: "deployment-generation-1",
      qualification_receipt_ref: "qualification-audit",
      qualification_expires_at: "2026-09-13T00:00:00.000Z",
      qualified: false,
      current: false,
    },
    evidence_input_sha256: digestFor(19),
    max_context_bytes: 65536,
  } as const;

  const outputSha = digestFor(21);
  const modelAttempt = {
    attempt_id: "model-attempt-audit",
    intent: { intent_ref: { id: "model-intent-audit", revision: 1 } },
    state: "SUCCEEDED",
    persisted_state: "SUCCEEDED",
    request_sha256: digestFor(20),
    stage_attempt_ref: "audit-attempt",
    stage_request_sha256: digestFor(22),
    workflow_budget_receipt_ref: "workflow-budget-audit",
    receipt: {
      receipt_ref: "model-receipt-audit",
      route_fingerprint_ref: "route-fingerprint-audit",
      output_object_ref: "model-output-audit",
      output_sha256: outputSha,
      input_tokens: 10,
      output_tokens: 20,
      billed_usd: 0,
    },
    operation_receipt: { receipt_ref: { id: "operation-receipt-audit", revision: 1 } },
    output: {
      output_object_ref: "model-output-audit",
      output_sha256: outputSha,
      output_size_bytes: 123,
      readback_sha256: outputSha,
    },
  };

  return {
    audit_input: auditInput as unknown as ResearchClaimAuditResultInput["audit_input"],
    stage_attempt_ref: "audit-attempt",
    stage_request_sha256: digestFor(22),
    model_attempt: modelAttempt as unknown as ResearchClaimAuditResultInput["model_attempt"],
    claims,
  };
}

function expectCode(action: () => unknown, code: string): void {
  let thrown: unknown;
  try { action(); } catch (error) { thrown = error; }
  expect(thrown).toMatchObject({ code });
}

function sizedInput(targetBytes: number): ResearchClaimAuditResultInput {
  const slotCount = 16;
  const emptySlots = Array.from({ length: slotCount }, () => "");
  const emptyBytes = encodeResearchClaimAuditResult(makeInput(emptySlots));
  const extraBytes = targetBytes - emptyBytes.byteLength;
  if (extraBytes < 0 || extraBytes > slotCount * 4096) {
    throw new Error(`fixture sizing remainder ${extraBytes} is outside the bounded slots`);
  }
  return makeInput(Array.from({ length: slotCount }, (_, index) => {
    const remaining = extraBytes - index * 4096;
    return "x".repeat(Math.min(4096, Math.max(0, remaining)));
  }));
}

describe("canonical compact AUDIT_CLAIMS result", () => {
  it("preserves every disposition and independent source/excerpt flags without raw evidence text", () => {
    const input = makeInput();
    const bytes = encodeResearchClaimAuditResult(input);
    const result = decodeResearchClaimAuditResult(bytes);

    expect(result.claims.map((claim) => claim.disposition)).toEqual(dispositions);
    expect(result.claims.map((claim) => claim.source_satisfies_requirement)).toEqual([true, false, true, false, true]);
    expect(result.claims.map((claim) => claim.supplied_excerpt_supports_requirement)).toEqual([false, true, false, true, false]);
    expect(result.verifier.qualified).toBe(false);
    expect(result.verifier.current).toBe(false);
    expect(result.model_attempt.output.output_sha256).toBe(digestFor(21));

    const wire = JSON.parse(decoder.decode(bytes)) as { claims: Array<Record<string, unknown>> };
    expect(wire.claims).toHaveLength(5);
    for (const claim of wire.claims) {
      expect(claim).not.toHaveProperty("text");
      expect(claim).not.toHaveProperty("claim_text");
      expect(claim).not.toHaveProperty("exact_support_handles");
      expect(claim).not.toHaveProperty("counterevidence_handles");
      expect(claim).not.toHaveProperty("independence_and_fidelity_notes");
      expect(claim).not.toHaveProperty("excerpt");
    }
    expect(decoder.decode(bytes)).toBe(canonicalEvidenceJson(result));
  });

  it("binds normalized identities and durable model readback, rejecting duplicates and unknown fields", () => {
    const input = makeInput();
    const firstClaim = input.claims[0];
    if (firstClaim === undefined) throw new Error("fixture claim is missing");

    expectCode(() => encodeResearchClaimAuditResult({
      ...input,
      claims: [{ ...firstClaim, claim_ref: { id: "foreign-claim", revision: 1 } }, ...input.claims.slice(1)],
    }), "WORKFLOW_INPUT_INVALID");
    expectCode(() => encodeResearchClaimAuditResult({
      ...input,
      claims: input.claims.map((claim, index) => index === 0
        ? { ...claim, support_handle_refs: [supportRef, supportRef] }
        : claim),
    }), "WORKFLOW_INPUT_INVALID");
    expectCode(() => encodeResearchClaimAuditResult({
      ...input,
      model_attempt: { ...input.model_attempt, stage_request_sha256: digestFor(23) } as typeof input.model_attempt,
    }), "WORKFLOW_INPUT_INVALID");
    expectCode(() => encodeResearchClaimAuditResult({
      ...input,
      model_attempt: {
        ...input.model_attempt,
        receipt: { ...input.model_attempt.receipt!, output_sha256: digestFor(24) },
      } as typeof input.model_attempt,
    }), "WORKFLOW_INPUT_INVALID");

    const encoded = encodeResearchClaimAuditResult(input);
    const wire = JSON.parse(decoder.decode(encoded)) as ResearchClaimAuditResult & { unexpected?: boolean };
    wire.claims = [...wire.claims, wire.claims[0]!];
    expectCode(() => decodeResearchClaimAuditResult(encoder.encode(canonicalEvidenceJson(wire))), "WORKFLOW_OUTPUT_CORRUPT");

    const duplicateRef = JSON.parse(decoder.decode(encoded)) as ResearchClaimAuditResult;
    duplicateRef.claims[0] = {
      ...duplicateRef.claims[0]!,
      support_handle_refs: [supportRef, supportRef],
    };
    expectCode(() => decodeResearchClaimAuditResult(encoder.encode(canonicalEvidenceJson(duplicateRef))), "WORKFLOW_OUTPUT_CORRUPT");

    const unknown = JSON.parse(decoder.decode(encoded)) as ResearchClaimAuditResult & { unexpected?: boolean };
    unknown.unexpected = true;
    expectCode(() => decodeResearchClaimAuditResult(encoder.encode(canonicalEvidenceJson(unknown))), "WORKFLOW_OUTPUT_CORRUPT");
  });

  it("rejects noncanonical JSON and malformed UTF-8 before accepting decoded data", () => {
    const encoded = encodeResearchClaimAuditResult(makeInput());
    expectCode(() => decodeResearchClaimAuditResult(encoder.encode(`${decoder.decode(encoded)} `)), "WORKFLOW_OUTPUT_CORRUPT");
    expectCode(() => decodeResearchClaimAuditResult(Uint8Array.of(0xc3, 0x28)), "WORKFLOW_OUTPUT_CORRUPT");
  });

  it("accepts a genuinely canonical 64 KiB result and rejects 64 KiB plus one byte on both paths", () => {
    const exactInput = sizedInput(MAX_WORKFLOW_RECEIPT_BYTES);
    const exactBytes = encodeResearchClaimAuditResult(exactInput);
    expect(exactBytes.byteLength).toBe(MAX_WORKFLOW_RECEIPT_BYTES);
    expect(encodeResearchClaimAuditResult(exactInput)).toEqual(exactBytes);
    expect(decodeResearchClaimAuditResult(exactBytes)).toEqual(JSON.parse(decoder.decode(exactBytes)));

    const oversizedInput = sizedInput(MAX_WORKFLOW_RECEIPT_BYTES + 1);
    expectCode(() => encodeResearchClaimAuditResult(oversizedInput), "WORKFLOW_INPUT_INVALID");

    const exactResult = decodeResearchClaimAuditResult(exactBytes);
    const oversizedResult: ResearchClaimAuditResult = {
      ...exactResult,
      claims: exactResult.claims.map((claim, index) => index === 0
        ? {
          ...claim,
          coverage_limitations: claim.coverage_limitations.map((value, valueIndex) =>
            valueIndex === claim.coverage_limitations.length - 1 ? `${value}x` : value),
        }
        : claim),
    };
    const oversizedBytes = encoder.encode(canonicalEvidenceJson(oversizedResult));
    expect(oversizedBytes.byteLength).toBe(MAX_WORKFLOW_RECEIPT_BYTES + 1);
    expectCode(() => decodeResearchClaimAuditResult(oversizedBytes), "WORKFLOW_OUTPUT_CORRUPT");
  });
});
