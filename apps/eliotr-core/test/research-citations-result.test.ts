import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import {
  decodeResearchCitationsResult,
  encodeResearchCitationsResult,
  type ResearchCitationsResultInput,
  type ResearchClaimAuditResult,
} from "@eliotr/cloudflare-research-stages";
import { MAX_WORKFLOW_RECEIPT_BYTES } from "@eliotr/cloudflare-workflows";
import type { CitationResolutionReceipt } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const supportRef = { id: "evidence-support", revision: 1 } as const;
const counterRef = { id: "evidence-counter", revision: 1 } as const;
const freezeRef = { id: "freeze-citations", revision: 1 } as const;
const scopeRef = { id: "scope-citations", revision: 1 } as const;
const manifestRef = { id: "manifest-citations", revision: 1 } as const;
const evidencePackRef = { id: "evidence-pack-citations", revision: 1 } as const;
const dispositions = [
  "SUPPORTED", "PARTIALLY_SUPPORTED", "UNSUPPORTED", "CONTRADICTED", "NOT_VERIFIABLE_IN_SCOPE",
] as const;

function digestFor(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function makeAudit(): ResearchClaimAuditResult {
  return {
    protocol: "eliotr.research.audit-claims-result.v1",
    operation_id: "operation-citations",
    investigation_ref: { id: "investigation-citations", revision: 1 },
    stage: "AUDIT_CLAIMS",
    stage_attempt_ref: "audit-attempt-citations",
    stage_request_sha256: digestFor(10),
    synthesis: {
      stage_attempt_ref: "synthesis-attempt-citations",
      stage_request_sha256: digestFor(11),
      output_sha256: digestFor(12),
    },
    verification: {
      stage_attempt_ref: "verify-attempt-citations",
      stage_request_sha256: digestFor(13),
      output_sha256: digestFor(14),
      normalization_binding_sha256: digestFor(15),
    },
    freeze_ref: freezeRef,
    scope_snapshot_ref: scopeRef,
    manifest_ref: manifestRef,
    audit_input_sha256: digestFor(16),
    verifier: {
      allowed_verifier_refs: ["verifier-citations"],
      verifier_ref: "verifier-citations",
      verifier_schema_generation: "verifier-schema-citations",
      deployment: {
        route_ref: "route-citations",
        route_version: "route-version-citations",
        prompt_generation: "prompt-generation-citations",
        schema_generation: "schema-generation-citations",
        parameters_digest: digestFor(17),
        pricing_snapshot_ref: "pricing-citations",
      },
      deployment_generation: "deployment-citations",
      qualification_receipt_ref: "qualification-citations",
      qualification_expires_at: "2026-09-13T00:00:00.000Z",
      qualified: true,
      current: true,
    },
    model_attempt: {
      attempt_id: "model-attempt-citations",
      intent_ref: { id: "model-intent-citations", revision: 1 },
      request_sha256: digestFor(18),
      stage_attempt_ref: "audit-attempt-citations",
      stage_request_sha256: digestFor(10),
      workflow_budget_receipt_ref: "workflow-budget-citations",
      receipt: {
        receipt_ref: "model-receipt-citations",
        route_fingerprint_ref: "route-fingerprint-citations",
        output_object_ref: "model-output-citations",
        output_sha256: digestFor(19),
      },
      operation_receipt_ref: { id: "operation-receipt-citations", revision: 1 },
      output: {
        output_object_ref: "model-output-citations",
        output_sha256: digestFor(19),
        output_size_bytes: 128,
        readback_sha256: digestFor(19),
      },
    },
    claims: dispositions.map((disposition, index) => ({
      claim_ref: { id: `claim-citations-${index}`, revision: 1 },
      claim_text_digest: digestFor(20 + index),
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
      coverage_limitations: ["bounded coverage limitation"],
      unsupported_precision: [],
      disposition,
    })),
  };
}

async function makeReceipt(): Promise<CitationResolutionReceipt> {
  const draft = {
    receipt_ref: { id: "citation-receipt-citations", revision: 1 },
    scope_snapshot_ref: scopeRef,
    requested_handle_refs: [counterRef, supportRef],
    resolved: [{
      handle_ref: supportRef,
      excerpt_sha256: digestFor(40),
      verification_receipt_ref: "evidence-verification-support",
    }],
    rejected: [{ handle_ref: counterRef, reason_code: "EVIDENCE_SOURCE_NOT_CURRENT" }],
    requested_count: 2,
    resolved_count: 1,
    all_material_citations_resolved: false,
    created_at: "2026-09-12T00:00:00.000Z",
  };
  return { ...draft, receipt_digest: await evidenceSha256(draft) };
}

async function makeInput(coverageLimitations?: readonly string[]): Promise<ResearchCitationsResultInput> {
  const audit = makeAudit();
  if (coverageLimitations !== undefined) {
    const firstClaim = audit.claims[0];
    if (firstClaim === undefined) throw new Error("citation fixture claim is missing");
    audit.claims[0] = { ...firstClaim, coverage_limitations: [...coverageLimitations] };
  }
  return {
    audit,
    audit_output_sha256: digestFor(50),
    evidence_pack_ref: evidencePackRef,
    stage_attempt_ref: "citations-attempt",
    stage_request_sha256: digestFor(51),
    citation_resolution_receipt: await makeReceipt(),
  };
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await expect(action()).rejects.toMatchObject({ code });
}

async function sizedInput(targetBytes: number): Promise<ResearchCitationsResultInput> {
  const slotCount = 16;
  const empty = Array.from({ length: slotCount }, () => "");
  const base = await encodeResearchCitationsResult(await makeInput(empty));
  const extra = targetBytes - base.byteLength;
  if (extra < 0 || extra > slotCount * 4096) {
    throw new Error(`citation fixture sizing remainder ${extra} is outside bounded slots`);
  }
  return makeInput(Array.from({ length: slotCount }, (_, index) =>
    "x".repeat(Math.min(4096, Math.max(0, extra - index * 4096))),
  ));
}

describe("canonical compact RESOLVE_CITATIONS result v2", () => {
  it("round-trips Stage14 lineage and preserves compact dispositions and dimensions", async () => {
    const input = await makeInput();
    const bytes = await encodeResearchCitationsResult(input);
    const result = await decodeResearchCitationsResult(bytes);

    expect(result.protocol).toBe("eliotr.research.citations.v2");
    expect(result.audit.output_sha256).toBe(digestFor(50));
    expect(result.audit.synthesis.output_sha256).toBe(digestFor(12));
    expect(result.audit.verification.normalization_binding_sha256).toBe(digestFor(15));
    expect(result.claims.map((claim) => claim.disposition)).toEqual(dispositions);
    expect(result.claims.map((claim) => claim.reference_verification)).toEqual([
      "PASS", "PASS", "NOT_APPLICABLE", "PASS", "PASS",
    ]);
    expect(result.claims[0]?.support_handle_refs).toEqual([supportRef]);
    expect(result.claims[0]?.counterevidence_handle_refs).toEqual([counterRef]);
    expect(result.citation_resolution_receipt.resolved_count).toBe(1);
    expect(result.citation_resolution_receipt.rejected).toHaveLength(1);

    const wire = decoder.decode(bytes);
    expect(wire).not.toContain("exact_support_handles");
    expect(wire).not.toContain("counterevidence_handles");
    expect(wire).not.toContain('"claim_text":');
    expect(wire).not.toContain("exact_excerpt");
    expect(wire).toBe(canonicalEvidenceJson(result));
  });

  it("rejects receipt digest, scope, and resolved/rejected partition tampering", async () => {
    const input = await makeInput();
    const receipt = input.citation_resolution_receipt;

    await expectCode(() => encodeResearchCitationsResult({
      ...input,
      citation_resolution_receipt: { ...receipt, receipt_digest: digestFor(99) },
    }), "WORKFLOW_INPUT_INVALID");
    await expectCode(() => encodeResearchCitationsResult({
      ...input,
      citation_resolution_receipt: { ...receipt, rejected: [], all_material_citations_resolved: false },
    }), "WORKFLOW_INPUT_INVALID");
    await expectCode(() => encodeResearchCitationsResult({
      ...input,
      citation_resolution_receipt: { ...receipt, scope_snapshot_ref: { id: "foreign-scope", revision: 1 } },
    }), "WORKFLOW_INPUT_INVALID");

    const bytes = await encodeResearchCitationsResult(input);
    const lineageTampered = JSON.parse(decoder.decode(bytes)) as {
      audit: { verification: { normalization_binding_sha256: string } };
    };
    lineageTampered.audit.verification.normalization_binding_sha256 = digestFor(99);
    await expectCode(() => decodeResearchCitationsResult(
      encoder.encode(canonicalEvidenceJson(lineageTampered)),
    ), "WORKFLOW_OUTPUT_CORRUPT");
  });

  it("rejects unknown fields, noncanonical JSON, and malformed UTF-8", async () => {
    const bytes = await encodeResearchCitationsResult(await makeInput());
    const unknown = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
    unknown.unexpected = true;
    await expectCode(() => decodeResearchCitationsResult(encoder.encode(canonicalEvidenceJson(unknown))),
      "WORKFLOW_OUTPUT_CORRUPT");
    await expectCode(() => decodeResearchCitationsResult(encoder.encode(`${decoder.decode(bytes)} `)),
      "WORKFLOW_OUTPUT_CORRUPT");
    await expectCode(() => decodeResearchCitationsResult(Uint8Array.of(0xc3, 0x28)),
      "WORKFLOW_OUTPUT_CORRUPT");
  });

  it("accepts exactly 64 KiB and refuses 64 KiB plus one byte", async () => {
    const exactBytes = await encodeResearchCitationsResult(await sizedInput(MAX_WORKFLOW_RECEIPT_BYTES));
    expect(exactBytes.byteLength).toBe(MAX_WORKFLOW_RECEIPT_BYTES);
    await expect(decodeResearchCitationsResult(exactBytes)).resolves.toEqual(
      JSON.parse(decoder.decode(exactBytes)),
    );

    const oversizedInput = await sizedInput(MAX_WORKFLOW_RECEIPT_BYTES + 1);
    await expectCode(() => encodeResearchCitationsResult(oversizedInput), "WORKFLOW_INPUT_INVALID");
    const oversizedBytes = new Uint8Array(exactBytes.byteLength + 1);
    oversizedBytes.set(exactBytes);
    await expectCode(() => decodeResearchCitationsResult(oversizedBytes), "WORKFLOW_OUTPUT_CORRUPT");
  });
});
