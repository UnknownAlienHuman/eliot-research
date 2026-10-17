import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalModelGatewayJson, createModelGatewayFetchAdapter, ModelGatewayExecutionError,
  modelGatewayDynamicRouteTarget, modelGatewayRequestParametersSha256, modelGatewaySha256,
  type ModelGatewayPromptCompilerPort,
} from "@eliotr/cloudflare-ai";
import { createWorkflowCheckpointExecutor, digest, workflowFailure, WorkflowCheckpointStore } from "@eliotr/cloudflare-workflows";
import { ReferenceManifestError } from "@eliotr/cloudflare-evidence";
import {
  createGovernedModelAttemptHandler, deriveModelAttemptIdentity,
} from "../../../packages/cloudflare-research/src/model-attempt-handler.js";
import type { ModelRoutePort } from "@eliotr/research";
import { governedModelAttemptFixture as baseFixture, runtime } from "./model-attempt-fixture.js";
import { principal, workflowFixture } from "./research-workflow-fixture.js";

const code = "MODEL_GATEWAY_PROMPT_COMPILE_FAILED";
const settledFailure = { code, retryable: false, dispatch_state: "NOT_STARTED",
  references_intact: "UNKNOWN", recovery_action: "NONE" };

async function governedModelAttemptFixture(...args: Parameters<typeof baseFixture>) {
  const fixture = await baseFixture(...args);
  return { ...fixture, dependencies: { ...fixture.dependencies, prepare: async (
    context: Parameters<typeof fixture.dependencies.prepare>[0],
  ) => {
    const prepared = await fixture.dependencies.prepare(context);
    return { ...prepared, call: { ...prepared.call, route_ref: "dynamic/eliotr-balanced" },
      quote: { ...prepared.quote, selected_routes: ["dynamic/eliotr-balanced"] } };
  } } };
}

function preparedCase<T>(name: string, setup: () => Promise<T>, verify: (fixture: T) => Promise<void>) {
  describe("fresh canonical fixture", () => {
    let fixture: T;
    // Schema reset/installation takes about 10s cold; only setup gets 20s.
    // Provider failure, settlement and replay assertions keep the default 5s.
    beforeEach(async () => { fixture = await setup(); }, 20_000);
    it(name, async () => { await verify(fixture); });
  });
}

function gateway(compile?: ModelGatewayPromptCompilerPort["compile"], remoteFailure?: unknown) {
  const fetch = vi.fn(async () => {
    throw remoteFailure ?? new Error("provider dispatch must not occur");
  });
  const put = vi.fn(async () => { throw new Error("no output may be written"); });
  const route: ModelRoutePort = {
    async execute(call) {
      const parameters = { max_tokens: 32, stream: false };
      const deployment = { route_ref: "dynamic/eliotr-balanced" as const, route_version: "route-1",
        prompt_generation: call.prompt_generation, schema_generation: call.schema_generation,
        parameters_digest: await modelGatewayRequestParametersSha256(parameters), pricing_snapshot_ref: "pricing-1" };
      const target = await modelGatewayDynamicRouteTarget(deployment);
      const body = { model: target.model, messages: [{ role: "system", content: "trusted instruction" },
        { role: "user", content: "controlled input" }], ...parameters };
      return createModelGatewayFetchAdapter({
        reasoning_gateway_base_url: `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`,
        binding_transport: { fetch }, deployments: { resolve: async () => deployment },
        prompts: { compile: compile ?? (async () => ({ request_body: body,
          request_body_sha256: await modelGatewaySha256(canonicalModelGatewayJson(body)), request_timeout_ms: 5000 })) },
        outputs: { putImmutable: put }, fingerprints: { putImmutable: put, getLatest: async () => null },
        pricing: { quote: put },
      }).execute(call);
    },
  };
  return { route, fetch, put };
}

async function readAttempt(fixture: Awaited<ReturnType<typeof governedModelAttemptFixture>>) {
  const identity = await deriveModelAttemptIdentity({
    stage_request_sha256: await digest(new TextEncoder().encode(JSON.stringify(fixture.request))),
    principal_ref: fixture.principal.principal_ref, credential_generation: fixture.principal.credential_generation,
    deployment_generation: fixture.principal.deployment_generation,
  });
  return fixture.dependencies.attempts.readByIdempotency({ principal_ref: fixture.principal.principal_ref,
    operation_kind: "REPORT", idempotency_key: identity.idempotency_key });
}

describe("prompt compilation failure settlement over local D1/R2", () => {
  describe.each(["throw", "malformed", "missing-reference", "stale-reference", "corrupt-reference"])("%s compiler fixture", (mode) => {
    preparedCase(`settles ${mode} before dispatch without claiming reference integrity on replay or recovery`,
      () => governedModelAttemptFixture(`prompt-${mode}`), async (fixture) => {
    const compile = vi.fn(async () => {
      if (mode === "throw") throw new Error("REQUIRED_CONTEXT_BYTE_BUDGET_EXCEEDED: private context");
      if (mode === "missing-reference") throw new ReferenceManifestError(
        "REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "reference manifest object is missing", true);
      if (mode === "stale-reference") throw new ReferenceManifestError(
        "REFERENCE_MANIFEST_SCOPE_STALE", "manifest source authority is stale", true);
      if (mode === "corrupt-reference") throw new ReferenceManifestError(
        "REFERENCE_MANIFEST_EVIDENCE_INVALID", "manifest evidence digest differs");
      return {};
    });
    const local = gateway(compile);
    const handler = createGovernedModelAttemptHandler({ ...fixture.dependencies, route: local.route });
    const input = fixture.invocation(fixture.request.stage, fixture.stageAttemptRef);
    await expect(handler.handler(input)).rejects.toMatchObject({ failure: settledFailure });
    await expect(readAttempt(fixture)).resolves.toMatchObject({
      state: "FAILED", persisted_state: "FAILED", error_code: code, receipt: null, output: null,
      operation_receipt: { outcome: "FAILED", reconciliation_required: false, output_refs: [], readback_receipt_refs: [] },
    });
    // A fresh handler must use the durable provenance, without prepare/reserve/dispatch.
    const prepare = vi.fn(fixture.dependencies.prepare);
    const replay = createGovernedModelAttemptHandler({ ...fixture.dependencies, route: local.route, prepare });
    await expect(replay.handler(input)).rejects.toMatchObject({ failure: settledFailure });
    const requestSha = await digest(new TextEncoder().encode(JSON.stringify(input.request)));
    const stored = await new WorkflowCheckpointStore(runtime.CORE_DB).attempt(input.request, requestSha);
    if (stored === null || stored.output_json === null) throw new Error("missing committed fixture stage for recovery");
    const output: { object_ref: string } = JSON.parse(stored.output_json);
    const recovery = { request: input.request, request_sha256: requestSha,
      attempt_ref: input.attempt_ref, budget_receipt_ref: input.budget_receipt_ref,
      stage_index: stored.stage_index, expected_revision: stored.expected_revision,
      budget_expires_at_ms: stored.budget_expires_at_ms, output_object_ref: output.object_ref,
      principal_ref: input.principal.principal_ref, credential_generation: input.principal.credential_generation,
      deployment_generation: input.principal.deployment_generation };
    await expect(replay.recoverStartedAttempt(recovery)).rejects.toMatchObject({ failure: settledFailure });
    await expect(replay.recoverStartedAttempt({ ...recovery, attempt_ref: "another-attempt" }))
      .rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(compile).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(local.fetch).not.toHaveBeenCalled();
    expect(local.put).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ["spoofed", Object.assign(new Error("private remote failure"), { code, dispatch_state: "NOT_STARTED" })],
    ["typed-spoofed", new ModelGatewayExecutionError(code, "remote code is not local compiler proof")],
    ["timeout", new DOMException("remote deadline exceeded", "TimeoutError")],
    ["unknown", new Error("provider may have completed")],
  ])("%s transport fixture", (tag, error) => {
    preparedCase(`keeps ${tag} transport failure uncertain and never redispatches`,
      () => governedModelAttemptFixture(`prompt-remote-${tag}`), async (fixture) => {
    const remote = gateway(undefined, error);
    const handler = createGovernedModelAttemptHandler({ ...fixture.dependencies, route: remote.route });
    const input = fixture.invocation(fixture.request.stage, fixture.stageAttemptRef);
    await expect(handler.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN",
      failure: { dispatch_state: "OUTCOME_UNKNOWN", references_intact: "UNKNOWN", retryable: false } });
    await expect(readAttempt(fixture)).resolves.toMatchObject({ state: "UNKNOWN", persisted_state: "STARTED" });
    await expect(handler.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(remote.fetch).toHaveBeenCalledTimes(1);
    expect(remote.put).not.toHaveBeenCalled();
    });
  });

  describe.each(["unwritten", "lost-ack", "wrong-binding", "unmarked"])("%s settlement fixture", (mode) => {
    preparedCase(`preserves uncertainty for ${mode} settlement`,
      () => governedModelAttemptFixture(`prompt-settle-${mode}`), async (fixture) => {
    const local = gateway(async () => { throw new Error("REQUIRED_CONTEXT_BYTE_BUDGET_EXCEEDED"); });
    const handler = createGovernedModelAttemptHandler({ ...fixture.dependencies, route: local.route, attempts: {
      ...fixture.dependencies.attempts,
      settleAttempt: async (input) => {
        if (mode === "unwritten") throw new Error("storage unavailable");
        const settled = await fixture.dependencies.attempts.settleAttempt(mode === "unmarked" && input.state === "FAILED"
          ? { ...input, reason_codes: [] } : input);
        if (mode === "lost-ack") throw new Error("settlement acknowledgment lost");
        return mode === "wrong-binding" ? { ...settled, stage_attempt_ref: "wrong-stage" } : settled;
      },
    } });
    const input = fixture.invocation(fixture.request.stage, fixture.stageAttemptRef);
    await expect(handler.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN",
      failure: { code, dispatch_state: "OUTCOME_UNKNOWN", retryable: false } });
    const replay = createGovernedModelAttemptHandler({ ...fixture.dependencies, route: local.route });
    await expect(replay.handler(input)).rejects.toMatchObject(mode === "unmarked" || mode === "unwritten"
      ? { code: "WORKFLOW_EFFECT_UNCERTAIN" } : { failure: settledFailure });
    expect(local.fetch).not.toHaveBeenCalled();
    expect(local.put).not.toHaveBeenCalled();
    });
  });

  preparedCase("retains the settled no-effect outcome through W2 failure retention", async () => {
    const workflow = await workflowFixture("prompt-w2");
    const fixture = await governedModelAttemptFixture("prompt-w2", {
      database: workflow.db, bucket: workflow.bucket, request: workflow.request, principal, inputBytes: workflow.bytes,
    });
    return { workflow, fixture };
  }, async ({ workflow, fixture }) => {
    const local = gateway(async () => { throw new Error("REQUIRED_CONTEXT_BYTE_BUDGET_EXCEEDED"); });
    const handler = createGovernedModelAttemptHandler({ ...fixture.dependencies, route: local.route });
    const executor = createWorkflowCheckpointExecutor(workflow.db, workflow.bucket, {
      ...workflow.ports, recoverStartedAttempt: handler.recoverStartedAttempt,
    });
    for (let invocation = 0; invocation < 2; invocation += 1) {
      const error = await executor.execute(workflow.request, principal, handler.handler).catch((cause: unknown) => cause);
      expect(workflowFailure(error, "STAGE", workflow.request.stage)).toMatchObject(settledFailure);
    }
    const retained = await workflow.db.prepare("SELECT failure_history_json FROM research_workflow_run WHERE operation_id=?1")
      .bind(workflow.request.operation_id).first<{ failure_history_json: string }>();
    expect(JSON.parse(retained?.failure_history_json ?? "null")).toMatchObject({ first_cause: settledFailure });
    await expect(readAttempt(fixture)).resolves.toMatchObject({ state: "FAILED", persisted_state: "FAILED" });
    expect(local.fetch).not.toHaveBeenCalled();
  });
});
