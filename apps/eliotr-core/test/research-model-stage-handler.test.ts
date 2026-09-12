import { beforeAll, describe, expect, it } from "vitest";
import { createD1ModelGatewayDeploymentRegistry } from "../../../packages/cloudflare-research/src/model-gateway-deployment-registry-d1.js";
import { createResearchModelStageHandler } from "../../../packages/cloudflare-research/src/research-model-stage-handler.js";
import { readCommittedResearchSynthesisOutput } from "../../../packages/cloudflare-research/src/research-synthesis-output-reader.js";
import { digest } from "@eliotr/cloudflare-workflows";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { initializeModelAttemptRuntime } from "./model-attempt-fixture.js";
import { principal } from "./research-workflow-fixture.js";
import {
  BASE_URL,
  ROUTE,
  compositionFixture,
  executeThroughSynthesis,
  expectPreProviderSettlement,
  promptDependencies,
} from "./research-synthesis-fixture.js";

beforeAll(initializeModelAttemptRuntime);

type CompositionFixture = Awaited<ReturnType<typeof compositionFixture>>;

function alternateDigest(value: string): string {
  const zero = "0".repeat(64);
  return value === zero ? "1".repeat(64) : zero;
}

function pinnedHandler(
  fixture: CompositionFixture,
  tag: string,
  expectedDeployment: ModelRouteDeployment,
): { readonly handler: ReturnType<typeof createResearchModelStageHandler>; readonly providerCalls: () => number } {
  let providerCalls = 0;
  const handler = createResearchModelStageHandler({
    database: fixture.workflow.db,
    work_bucket: fixture.workflow.bucket,
    operation_kind: "REPORT",
    deployment_environment: "TEST",
    gateway: {
      reasoning_gateway_base_url: BASE_URL,
      gateway_token: "controlled-gateway-token",
      fetch: async () => {
        providerCalls += 1;
        return new Response(JSON.stringify({
          id: `expected-pin-response-${tag}`,
          object: "chat.completion",
          created: 1,
          model: ROUTE,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `expected pin ${tag}` } }],
          usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cf-aig-provider": "controlled-provider",
            "cf-aig-model": "controlled-model",
            "cf-aig-log-id": `expected-pin-log-${tag}`,
          },
        });
      },
    },
    prompt: promptDependencies(tag),
    pricing: {
      quote: async () => ({
        quote_ref: `expected-pin-price-${tag}`,
        pricing_snapshot_ref: fixture.deployment.pricing_snapshot_ref,
        billed_usd: 0,
      }),
    },
    prepare: fixture.prepare,
    spend_authorization: fixture.spend_authorization,
    expected_deployment: expectedDeployment,
  });
  return { handler, providerCalls: () => providerCalls };
}

const DEPLOYMENT_PIN_MISMATCHES = [
  {
    field: "route_version",
    apply: (deployment: ModelRouteDeployment): ModelRouteDeployment => ({
      ...deployment,
      route_version: `${deployment.route_version}-mismatch`,
    }),
  },
  {
    field: "parameters_digest",
    apply: (deployment: ModelRouteDeployment): ModelRouteDeployment => ({
      ...deployment,
      parameters_digest: alternateDigest(deployment.parameters_digest),
    }),
  },
  {
    field: "pricing_snapshot_ref",
    apply: (deployment: ModelRouteDeployment): ModelRouteDeployment => ({
      ...deployment,
      pricing_snapshot_ref: `${deployment.pricing_snapshot_ref}-mismatch`,
    }),
  },
] as const;

describe("composed research model stage handler", () => {
  it("reads the committed SYNTHESIZE output from its W2 stage binding and replays exactly", async () => {
    const fixture = await compositionFixture("synthesis-output", "TEST", false, "FIXTURE", "approved", false, false);
    const scopeId = fixture.workflow.request.input_manifest.residency.scope_domain_id;
    const authority = async () => ({
      investigation_id: fixture.workflow.request.investigation_ref.id,
      scope_snapshot_id: scopeId,
      scope_snapshot_revision: 1,
    });
    const readInput = {
      database: fixture.workflow.db,
      work_bucket: fixture.workflow.bucket,
      operation_id: fixture.workflow.request.operation_id,
      principal,
      recheck_authority: authority,
    } as const;
    await expect(readCommittedResearchSynthesisOutput(readInput)).resolves.toBeNull();
    const synthesisReceipt = await executeThroughSynthesis(fixture);
    const first = await readCommittedResearchSynthesisOutput(readInput);
    if (first === null) throw new Error("committed synthesis output was not readable");
    expect(first.stage).toBe("SYNTHESIZE");
    expect(first.workflow_receipt).toEqual(synthesisReceipt);
    expect(first.stage_attempt_ref).toBe(synthesisReceipt.attempt_ref);
    expect(first.stage_request_sha256).toBe(synthesisReceipt.request_sha256);
    expect(await digest(first.bytes)).toBe(first.output.output_sha256);
    expect(first.model_attempt.output?.output_object_ref).toBe(first.output.output_object_ref);
    expect(first.model_attempt.authority.scope_snapshot_ref).toEqual({ id: scopeId, revision: 1 });
    const replay = await readCommittedResearchSynthesisOutput(readInput);
    expect(replay).toEqual(first);
    expect(fixture.providerCalls()).toBe(1);
    await expect(readCommittedResearchSynthesisOutput({
      ...readInput,
      principal: { ...principal, credential_generation: "stale-credential" },
    })).rejects.toMatchObject({ code: "SYNTHESIS_OUTPUT_AUTHORITY_STALE" });
    await expect(readCommittedResearchSynthesisOutput({
      ...readInput,
      operation_id: "missing-synthesis-operation",
    })).resolves.toBeNull();
  });

  it("executes through real deployment, prompt, output, fingerprint, and pricing seams and replays durably", async () => {
    const fixture = await compositionFixture("success");
    const input = fixture.base.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.base.stageAttemptRef);
    const first = await fixture.handler.handler(input);
    expect(first).toBeInstanceOf(Uint8Array);
    expect(fixture.providerCalls()).toBe(1);
    expect(fixture.promptCalls()).toBe(1);
    expect(fixture.pricingCalls()).toBe(1);
    const fingerprint = await fixture.workflow.db.prepare(
      "SELECT fingerprint_json FROM research_model_fingerprint WHERE route_ref = ?1 ORDER BY observation_seq DESC LIMIT 1",
    ).bind(ROUTE).first<{ readonly fingerprint_json: string }>();
    if (fingerprint === null) throw new Error("controlled model fingerprint was not persisted");
    expect(JSON.parse(fingerprint.fingerprint_json)).toMatchObject({
      route_ref: fixture.deployment.route_ref,
      route_version: fixture.deployment.route_version,
      prompt_generation: fixture.deployment.prompt_generation,
      schema_generation: fixture.deployment.schema_generation,
      parameters_digest: fixture.deployment.parameters_digest,
      pricing_snapshot_ref: fixture.deployment.pricing_snapshot_ref,
    });
    const replay = await fixture.handler.handler(input);
    expect(replay).toEqual(first);
    expect(fixture.providerCalls()).toBe(1);
    expect(fixture.promptCalls()).toBe(1);
    expect(fixture.pricingCalls()).toBe(1);
  });

  it("does no fresh gateway work for a terminal replay with unusable credentials", async () => {
    const fixture = await compositionFixture("terminal-replay");
    const input = fixture.base.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.base.stageAttemptRef);
    const expected = await fixture.handler.handler(input);
    const replay = createResearchModelStageHandler({
      database: fixture.workflow.db, work_bucket: fixture.workflow.bucket, operation_kind: "REPORT", deployment_environment: "TEST",
      gateway: { reasoning_gateway_base_url: BASE_URL, gateway_token: " bearer" }, prompt: promptDependencies("terminal-replay"),
      pricing: { quote: async () => { throw new Error("terminal replay must not price"); } },
      prepare: async () => { throw new Error("terminal replay must not prepare"); },
      spend_authorization: { read: async () => { throw new Error("terminal replay must not revalidate"); } },
    });
    await expect(replay.handler(input)).resolves.toEqual(expected);
  });

  it("does no fresh preparation or gateway work when an UNKNOWN attempt is replayed", async () => {
    const fixture = await compositionFixture("unknown-replay", "TEST", true);
    const input = fixture.base.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.base.stageAttemptRef);
    await expect(fixture.handler.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(fixture.providerCalls()).toBe(1);
    const before = { prepares: fixture.prepareCalls(), prompts: fixture.promptCalls(), prices: fixture.pricingCalls() };
    const replay = createResearchModelStageHandler({
      database: fixture.workflow.db, work_bucket: fixture.workflow.bucket, operation_kind: "REPORT", deployment_environment: "TEST",
      gateway: { reasoning_gateway_base_url: BASE_URL, gateway_token: " bearer" }, prompt: promptDependencies("unknown-replay"),
      pricing: { quote: async () => { throw new Error("UNKNOWN replay must not price"); } },
      prepare: async () => { throw new Error("UNKNOWN replay must not prepare"); },
      spend_authorization: { read: async () => { throw new Error("UNKNOWN replay must not revalidate"); } },
    });
    await expect(replay.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(fixture.prepareCalls()).toBe(before.prepares);
    expect(fixture.promptCalls()).toBe(before.prompts);
    expect(fixture.pricingCalls()).toBe(before.prices);
    expect(fixture.providerCalls()).toBe(1);
  });

  it("rejects a fixture-only route under the production default before provider execution", async () => {
    const fixture = await compositionFixture("production-gate");
    await expect(createD1ModelGatewayDeploymentRegistry(fixture.workflow.db).resolve(ROUTE))
      .rejects.toMatchObject({ code: "DYNAMIC_ROUTE_LIVE_GATE_REQUIRED" });
    let productionProviderCalls = 0;
    const production = createResearchModelStageHandler({
      database: fixture.workflow.db, work_bucket: fixture.workflow.bucket, operation_kind: "REPORT",
      gateway: { reasoning_gateway_base_url: BASE_URL, gateway_token: "controlled-gateway-token", fetch: async () => { productionProviderCalls += 1; throw new Error("production fixture route must not fetch"); } },
      prompt: promptDependencies("production-gate"), pricing: { quote: async () => { throw new Error("production fixture route must not price"); } },
      prepare: fixture.prepare, spend_authorization: fixture.spend_authorization,
    });
    await expect(production.handler(fixture.base.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.base.stageAttemptRef)))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(productionProviderCalls).toBe(0);
    await expectPreProviderSettlement(fixture.workflow.db, fixture.base.stageAttemptRef, "WORKFLOW_AUTHORITY_STALE");
  });

  it("propagates a LIVE approved deployment through the production fetch pin", async () => {
    const fixture = await compositionFixture("approved-live", "PRODUCTION", false, "LIVE");
    const input = fixture.base.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.base.stageAttemptRef);
    const result = await fixture.handler.handler(input);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(fixture.providerCalls()).toBe(1);
    expect(fixture.revalidateCalls()).toBe(3);
    const fingerprint = await fixture.workflow.db.prepare(
      "SELECT fingerprint_json FROM research_model_fingerprint WHERE route_ref = ?1 ORDER BY observation_seq DESC LIMIT 1",
    ).bind(ROUTE).first<{ readonly fingerprint_json: string }>();
    if (fingerprint === null) throw new Error("approved deployment fingerprint was not persisted");
    expect(JSON.parse(fingerprint.fingerprint_json)).toMatchObject({
      route_version: fixture.deployment.route_version,
      parameters_digest: fixture.deployment.parameters_digest,
      pricing_snapshot_ref: fixture.deployment.pricing_snapshot_ref,
    });
  });

  it("refuses a registry rotation after approved revalidation before transport", async () => {
    const fixture = await compositionFixture("approved-rotation", "PRODUCTION", false, "LIVE", "approved", true);
    const input = fixture.base.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.base.stageAttemptRef);
    await expect(fixture.handler.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(fixture.revalidateCalls()).toBe(2);
    expect(fixture.providerCalls()).toBe(0);
    await expectPreProviderSettlement(fixture.workflow.db, fixture.base.stageAttemptRef, "WORKFLOW_AUTHORITY_STALE");
  });

  it.each(["missing", "malformed"] as const)("refuses %s approval before transport", async (approvalMode) => {
    const fixture = await compositionFixture(`approval-${approvalMode}`, "PRODUCTION", false, "LIVE", approvalMode);
    const input = fixture.base.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.base.stageAttemptRef);
    await expect(fixture.handler.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(fixture.providerCalls()).toBe(0);
    await expectPreProviderSettlement(fixture.workflow.db, fixture.base.stageAttemptRef, "WORKFLOW_AUTHORITY_STALE");
  });

  it.each(DEPLOYMENT_PIN_MISMATCHES)(
    "refuses a full deployment pin when $field differs before provider execution",
    async ({ field, apply }) => {
      const fixture = await compositionFixture(`expected-pin-${field}`);
      const handler = pinnedHandler(fixture, `expected-pin-${field}`, apply(fixture.deployment));
      const input = fixture.base.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.base.stageAttemptRef);
      await expect(handler.handler.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
      expect(handler.providerCalls()).toBe(0);
      expect(fixture.revalidateCalls()).toBe(1);
      await expectPreProviderSettlement(fixture.workflow.db, fixture.base.stageAttemptRef, "WORKFLOW_AUTHORITY_STALE");
    },
  );

  it("keeps a detached expected deployment pin after caller mutation", async () => {
    const fixture = await compositionFixture("expected-pin-caller-mutation");
    const expected = { ...fixture.deployment };
    const handler = pinnedHandler(fixture, "expected-pin-caller-mutation", expected);
    expected.route_version = `${expected.route_version}-caller-mutated`;
    const result = await handler.handler.handler(
      fixture.base.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.base.stageAttemptRef),
    );
    expect(result).toBeInstanceOf(Uint8Array);
    expect(handler.providerCalls()).toBe(1);
  });
});
