import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import {
  MAX_WORKFLOW_RECEIPT_BYTES,
} from "@eliotr/cloudflare-workflows";
import {
  decodeResearchVerificationResultV2,
  encodeResearchVerificationResultV2,
  researchVerificationNormalizationBindingSha256,
  type ResearchVerificationResultV2,
} from "@eliotr/cloudflare-research-stages";
import { describe, expect, it } from "vitest";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const supportRef = { id: "evidence-support", revision: 1 } as const;
const counterRef = { id: "evidence-counter", revision: 1 } as const;

function digestFor(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function sourceReadback(handleRef: ResearchVerificationResultV2["normalization"]["section_ref"], suffix: string) {
  return {
    handle_ref: handleRef,
    source_revision_ref: `source-revision-${suffix}`,
    source_owner_generation: `owner-generation-${suffix}`,
    excerpt_sha256: digestFor(100 + suffix.length),
    source_revision_content_sha256: digestFor(200 + suffix.length),
    scope_snapshot_digest: digestFor(300 + suffix.length),
    authorization_receipt_ref: `authorization-${suffix}`,
    credential_generation: `credential-${suffix}`,
    verification_receipt_ref: `verification-${suffix}`,
  };
}

function makeResult(claimCount = 1, includeCounter = true, operationId = "operation-v2"): ResearchVerificationResultV2 {
  const claims: ResearchVerificationResultV2["normalization"]["claims"] = Array.from(
    { length: claimCount },
    (_, index) => ({
      claim_ref: { id: `research-claim:claim-${index}`, revision: 1 },
      claim_text_digest: digestFor(index + 1),
      claim_kind: "observation",
      support_handle_refs: [supportRef],
      counterevidence_handle_refs: includeCounter && index === 0 ? [counterRef] : [],
    }),
  );
  const citedHandleRefs = includeCounter ? [supportRef, counterRef] : [supportRef];
  const resolved = includeCounter
    ? [sourceReadback(supportRef, "support"), sourceReadback(counterRef, "counter")]
    : [sourceReadback(supportRef, "support")];

  return {
    protocol: "eliotr.research.verification.v2",
    operation_id: operationId,
    stage: "VERIFY",
    stage_attempt_ref: "attempt-v2",
    stage_request_sha256: digestFor(10),
    synthesis: {
      stage_attempt_ref: "synthesis-attempt-v2",
      stage_request_sha256: digestFor(11),
      output_sha256: digestFor(12),
    },
    freeze_ref: { id: "freeze-v2", revision: 1 },
    scope_snapshot_ref: { id: "scope-v2", revision: 1 },
    manifest_ref: { id: "manifest-v2", revision: 1 },
    semantic_verification: "NOT_EXECUTED",
    normalization: {
      section_ref: { id: "section-v2", revision: 1 },
      required_precision: "exact-excerpt",
      required_source_class: "official",
      claims,
      cited_handle_refs: citedHandleRefs,
      binding_sha256: digestFor(13),
    },
    source_verification: {
      requested_handle_refs: citedHandleRefs,
      resolved,
    },
    verified_at: "2026-09-12T00:00:00.000Z",
  };
}

async function withBinding(value: ResearchVerificationResultV2): Promise<ResearchVerificationResultV2> {
  const binding_sha256 = await researchVerificationNormalizationBindingSha256(value);
  return { ...value, normalization: { ...value.normalization, binding_sha256 } };
}

describe("canonical v2 research verification result", () => {
  it("round-trips a handle-only result with committed lineage and no semantic PASS", async () => {
    const value = await withBinding(makeResult());
    const encoded = await encodeResearchVerificationResultV2(value);

    expect(encoded.byteLength).toBeLessThanOrEqual(MAX_WORKFLOW_RECEIPT_BYTES);
    expect(textDecoder.decode(encoded)).toBe(canonicalEvidenceJson(value));
    expect(value.semantic_verification).toBe("NOT_EXECUTED");
    const parsed = JSON.parse(textDecoder.decode(encoded)) as Record<string, unknown>;
    expect(parsed.normalization).toMatchObject({ required_precision: "exact-excerpt", required_source_class: "official" });
    expect((parsed.normalization as { claims: Array<Record<string, unknown>> }).claims[0]).not.toHaveProperty("text");
    expect((parsed.source_verification as { resolved: Array<Record<string, unknown>> }).resolved[0]).not.toHaveProperty("excerpt");

    await expect(decodeResearchVerificationResultV2(encoded)).resolves.toEqual(value);
  });

  it("derives the normalization binding and rejects stale settings or synthesis lineage", async () => {
    const value = await withBinding(makeResult());
    const staleSettings = {
      ...value,
      normalization: { ...value.normalization, required_precision: "coarse-summary" },
    };
    await expect(encodeResearchVerificationResultV2(staleSettings)).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });

    const staleSynthesis = {
      ...value,
      synthesis: { ...value.synthesis, output_sha256: digestFor(99) },
    };
    await expect(encodeResearchVerificationResultV2(staleSynthesis)).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });

    const wire = JSON.parse(textDecoder.decode(await encodeResearchVerificationResultV2(value))) as ResearchVerificationResultV2;
    wire.normalization.required_source_class = "peer-reviewed";
    const tampered = textEncoder.encode(canonicalEvidenceJson(wire));
    await expect(decodeResearchVerificationResultV2(tampered)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
  });

  it("rejects duplicate claims and source readbacks outside the normalized union", async () => {
    const value = await withBinding(makeResult());
    const claim = value.normalization.claims[0];
    if (claim === undefined) throw new Error("fixture claim is missing");
    const duplicateClaim = {
      ...value,
      normalization: { ...value.normalization, claims: [...value.normalization.claims, claim] },
    };
    await expect(encodeResearchVerificationResultV2(duplicateClaim)).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });

    const firstReadback = value.source_verification.resolved[0];
    if (firstReadback === undefined) throw new Error("v2 source readback is missing");
    const foreignReadback = {
      ...firstReadback,
      handle_ref: { id: "evidence-foreign", revision: 1 },
    };
    const foreignSource = {
      ...value,
      source_verification: {
        ...value.source_verification,
        resolved: [foreignReadback, ...value.source_verification.resolved.slice(1)],
      },
    };
    await expect(encodeResearchVerificationResultV2(foreignSource)).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
  });

  it("rejects noncanonical, unknown-key, invalid-UTF-8, and max+1 wire payloads", async () => {
    const value = await withBinding(makeResult());
    const encoded = await encodeResearchVerificationResultV2(value);
    const canonical = textDecoder.decode(encoded);
    await expect(decodeResearchVerificationResultV2(textEncoder.encode(`${canonical} `))).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });

    const unknown = JSON.parse(canonical) as Record<string, unknown>;
    unknown.unexpected = true;
    await expect(decodeResearchVerificationResultV2(textEncoder.encode(canonicalEvidenceJson(unknown)))).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });

    await expect(decodeResearchVerificationResultV2(Uint8Array.of(0xc3, 0x28))).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });

    const maxPlusOne = new Uint8Array(MAX_WORKFLOW_RECEIPT_BYTES + 1);
    await expect(decodeResearchVerificationResultV2(maxPlusOne)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
  });

  it("accepts a valid canonical receipt at 64 KiB and rejects a valid canonical receipt at 64 KiB plus one byte", async () => {
    const exact = await withBinding(makeResult(236, false, `operation-v2${"p".repeat(46)}`));
    const oversized = await withBinding(makeResult(236, false, `operation-v2${"p".repeat(47)}`));
    const exactBytes = textEncoder.encode(canonicalEvidenceJson(exact));
    const oversizedBytes = textEncoder.encode(canonicalEvidenceJson(oversized));

    expect(exactBytes.byteLength).toBe(MAX_WORKFLOW_RECEIPT_BYTES);
    expect(oversizedBytes.byteLength).toBe(MAX_WORKFLOW_RECEIPT_BYTES + 1);
    await expect(encodeResearchVerificationResultV2(exact)).resolves.toEqual(exactBytes);
    await expect(decodeResearchVerificationResultV2(exactBytes)).resolves.toEqual(exact);
    await expect(encodeResearchVerificationResultV2(oversized)).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
    await expect(decodeResearchVerificationResultV2(oversizedBytes)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
  });
});
