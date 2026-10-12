import { describe, expect, it } from "vitest";
import { decodeModelGatewayBody, type ModelGatewayTransportPolicyV1 } from "@eliotr/cloudflare-ai";
import { decodeResearchClaimAuditResult } from "@eliotr/cloudflare-research-stages";
import { createWorkflowCheckpointExecutor, readWorkflowObject } from "@eliotr/cloudflare-workflows";
import {
  auditCheckpointCount,
  readAuditStageResult,
  researchClaimAuditStageFixture,
} from "./research-claim-audit-fixture.js";
import { principal } from "./research-evidence-freeze-fixture.js";

const selectedCompat: ModelGatewayTransportPolicyV1 = {
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "compat-chat-completions",
  provider: "controlled-audit-provider",
  model: "controlled-audit-model",
  billing: { mode: "byok", alias: "default" },
  capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["low", "high"] },
};

function withReasoning(body: Readonly<Record<string, unknown>>, invalidNotes = false): unknown {
  const choices = body.choices as readonly { readonly message: { readonly content: string } }[];
  const first = choices[0];
  if (first === undefined) throw new Error("Controlled response has no choice");
  let content = first.message.content;
  if (invalidNotes) {
    const batch = JSON.parse(content) as { claims: Record<string, unknown>[] };
    batch.claims = batch.claims.map(claim => ({ ...claim, notes: "Invalid scalar notes must remain unverified." }));
    content = JSON.stringify(batch);
  }
  return {
    ...body,
    choices: [{ ...first, message: { ...first.message, content, reasoning_content: "Hidden fixture reasoning" } }],
    usage: { ...(body.usage as Record<string, unknown>), neurons: 0.25 },
  };
}

describe("AUDIT_CLAIMS stored response API binding", () => {
  it("rereads legacy compatibility output with reasoning and neurons without guessing another provider", async () => {
    const fixture = await researchClaimAuditStageFixture({ audit_response_body: withReasoning });
    const first = await fixture.fixture.freeze.executor.execute(fixture.stage14, principal, fixture.auditHandler);
    const bytes = await readAuditStageResult(fixture, first);
    const result = decodeResearchClaimAuditResult(bytes);
    expect(result.claims[0]?.disposition).toBe("UNSUPPORTED");
    expect(result.claims[0]?.source_satisfies_requirement).toBe(false);
    expect(new TextDecoder().decode(bytes)).not.toContain("Hidden fixture reasoning");
    expect(fixture.auditProviderCalls()).toBe(1);
    expect(await auditCheckpointCount(fixture)).toBe(1);
    const replay = await fixture.fixture.freeze.executor.execute(fixture.stage14, principal, fixture.auditHandler);
    expect(replay).toEqual(first);
    expect(await readWorkflowObject(fixture.fixture.freeze.bucket, replay.output_manifest, true)).toEqual(bytes);
    expect(fixture.auditProviderCalls()).toBe(1);
  }, 60_000);

  it("uses the selected compatibility API while refusing malformed semantic notes conservatively", async () => {
    const fixture = await researchClaimAuditStageFixture({
      audit_transport_policy: selectedCompat,
      audit_response_body: body => withReasoning(body, true),
    });
    const receipt = await fixture.fixture.freeze.executor.execute(fixture.stage14, principal, fixture.auditHandler);
    const result = decodeResearchClaimAuditResult(await readAuditStageResult(fixture, receipt));
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({
      reference_verification: "PASS",
      value_or_measurement_verification: "NOT_APPLICABLE",
      source_satisfies_requirement: false,
      supplied_excerpt_supports_requirement: false,
      disposition: "NOT_VERIFIABLE_IN_SCOPE",
    });
    expect(result.claims[0]?.coverage_limitations).toContain(
      "Model audit output invalid (SEMANTIC_VERIFIER_OUTPUT_INVALID); no semantic observations were accepted.",
    );
    expect(fixture.auditProviderCalls()).toBe(1);
    expect(await auditCheckpointCount(fixture)).toBe(1);
  }, 60_000);

  it("rereads a settled compatibility body during lost-W2-ACK recovery without another provider call", async () => {
    const fixture = await researchClaimAuditStageFixture({
      audit_transport_policy: selectedCompat,
      audit_response_body: withReasoning,
    });
    const executor = createWorkflowCheckpointExecutor(fixture.fixture.freeze.db, fixture.fixture.freeze.bucket,
      fixture.fixture.freeze.ports);
    await expect(executor.execute(fixture.stage14, principal, async input => {
      await fixture.auditHandler(input);
      throw new Error("Controlled W2 ACK loss after settled audit output");
    })).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(fixture.auditProviderCalls()).toBe(1);
    expect(await auditCheckpointCount(fixture)).toBe(0);
    const recoverStartedAttempt = fixture.auditFactory.recoverStartedAttempt;
    if (recoverStartedAttempt === undefined) throw new Error("Fixture has no W2 recovery reader");
    const recovery = createWorkflowCheckpointExecutor(fixture.fixture.freeze.db, fixture.fixture.freeze.bucket,
      { ...fixture.fixture.freeze.ports, recoverStartedAttempt });
    const receipt = await recovery.execute(fixture.stage14, principal, async () => {
      throw new Error("Recovery must not invoke a provider");
    });
    expect(decodeResearchClaimAuditResult(await readAuditStageResult(fixture, receipt)).claims[0]?.disposition)
      .toBe("UNSUPPORTED");
    expect(fixture.auditProviderCalls()).toBe(1);
    expect(await auditCheckpointCount(fixture)).toBe(1);
  }, 60_000);

  it("keeps provider schemas strict and never falls back from an explicit API to response heuristics", async () => {
    const body = {
      id: "stored-output", object: "chat.completion", created: 1, model: "fixture-model",
      choices: [{ index: 0, finish_reason: "stop", message: {
        role: "assistant", content: "bounded fixture content", reasoning_content: "Hidden fixture reasoning",
      } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, neurons: 0.25 },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    await expect(decodeModelGatewayBody(bytes, "openrouter-chat-completions"))
      .rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
    const unknownUsage = new TextEncoder().encode(JSON.stringify({ ...body,
      usage: { ...body.usage, unsupported_accounting: 1 } }));
    await expect(decodeModelGatewayBody(unknownUsage, "compat-chat-completions"))
      .rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
    const wrongEnvelope = new TextEncoder().encode(JSON.stringify({ ...body, object: "response" }));
    await expect(decodeModelGatewayBody(wrongEnvelope, "compat-chat-completions"))
      .rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
  });
});
