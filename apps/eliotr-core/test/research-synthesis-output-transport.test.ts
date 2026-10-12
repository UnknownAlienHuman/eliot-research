import { describe, expect, it } from "vitest";
import { decodeModelGatewayBody } from "@eliotr/cloudflare-ai";
import { decodeResearchClaimAuditResult } from "@eliotr/cloudflare-research-stages";
import { readWorkflowObject } from "@eliotr/cloudflare-workflows";
import {
  readAuditStageInput,
  readAuditStageResult,
  researchClaimAuditStageFixture,
} from "./research-claim-audit-fixture.js";
import { principal } from "./research-evidence-freeze-fixture.js";

function synthesisWithReasoning(body: Readonly<Record<string, unknown>>): unknown {
  const choices = body.choices as readonly { readonly message: Readonly<Record<string, unknown>> }[];
  const first = choices[0];
  if (first === undefined) throw new Error("Controlled synthesis has no choice");
  return {
    ...body,
    choices: [{ ...first, message: { ...first.message, reasoning_content: "Hidden synthesis fixture reasoning" } }],
    usage: { ...(body.usage as Record<string, unknown>), neurons: 0.25 },
  };
}

describe("Committed SYNTH output API binding", () => {
  it("reads legacy compatibility reasoning output through committed VERIFY and fresh AUDIT input", async () => {
    const fixture = await researchClaimAuditStageFixture({ synthesis_response_body: synthesisWithReasoning });
    const input = await readAuditStageInput(fixture);
    expect(input.claims.claims).toHaveLength(1);
    expect(input.verify.normalization.claims[0]?.claim_ref).toEqual(input.claims.claims[0]?.claim_ref);
    expect(input.verify.normalization.claims[0]?.claim_text_digest).toBe(input.claims.claims[0]?.text_digest);
    expect(fixture.fixture.provider_calls()).toBe(1);
    expect(fixture.auditProviderCalls()).toBe(0);
    const bytes = await readWorkflowObject(fixture.fixture.freeze.bucket, fixture.synthesis.output_manifest, true);
    const decoded = await decodeModelGatewayBody(bytes, "compat-chat-completions");
    expect(decoded.assistant_content).not.toContain("Hidden synthesis fixture reasoning");
    await expect(decodeModelGatewayBody(bytes, "openrouter-chat-completions"))
      .rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
  }, 60_000);

  it("propagates an explicit compatibility pin to both readers and preserves normalized audit lineage", async () => {
    const fixture = await researchClaimAuditStageFixture({
      synthesis_response_body: synthesisWithReasoning,
      synthesis_body_api: "compat-chat-completions",
    });
    const input = await readAuditStageInput(fixture);
    const receipt = await fixture.fixture.freeze.executor.execute(fixture.stage14, principal, fixture.auditHandler);
    const result = decodeResearchClaimAuditResult(await readAuditStageResult(fixture, receipt));
    expect(result.synthesis).toEqual(input.synthesis);
    expect(result.audit_input_sha256).toBe(input.evidence_input_sha256);
    expect(result.claims[0]?.claim_ref).toEqual(input.claims.claims[0]?.claim_ref);
    expect(result.claims[0]?.claim_text_digest).toBe(input.claims.claims[0]?.text_digest);
    expect(result.claims[0]?.disposition).toBe("UNSUPPORTED");
    expect(fixture.fixture.provider_calls()).toBe(1);
    expect(fixture.auditProviderCalls()).toBe(1);
  }, 60_000);

  it("refuses a mismatched explicit SYNTH API without falling back to response metadata", async () => {
    await expect(researchClaimAuditStageFixture({
      synthesis_response_body: synthesisWithReasoning,
      synthesis_body_api: "openrouter-chat-completions",
    })).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
  }, 60_000);
});
