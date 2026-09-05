import type { AccessVerifier } from "@eliotr/platform-cloudflare";
import { describe, expect, it } from "vitest";
import { createPlan, validateReceipt } from "./gemini-mcp-google-sync.js";
import type { GoogleSyncPlanInput } from "./gemini-mcp-tool-common.js";
import type { Env } from "./env.js";
import { handleGeminiMcp } from "./gemini-mcp.js";
import {
  GEMINI_MCP_TOOL_NAMES,
  handleGeminiMcpProtocol,
  type GeminiMcpServerDependencies,
  type McpToolCallContext,
} from "./gemini-mcp-protocol.js";
import {
  callGeminiMcpTool,
  GEMINI_MCP_TOOLS,
  type GeminiMcpToolDependencies,
} from "./gemini-mcp-tools.js";

const context: McpToolCallContext = {
  principal_ref: "gemini-spark",
  trace_id: "trace-1",
  deployment_generation: "generation-1",
};

function request(
  body: unknown,
  protocolVersion?: string,
  url = "https://mcp.example/mcp",
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (protocolVersion !== undefined) headers.set("mcp-protocol-version", protocolVersion);
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function server(): GeminiMcpServerDependencies {
  return {
    server_version: "test",
    deployment_generation: "generation-1",
    listTools: () => GEMINI_MCP_TOOLS,
    async callTool(name, input, callContext) {
      return callGeminiMcpTool(toolDependencies("gemini-mcp"), name, input, callContext);
    },
  };
}

function toolDependencies(
  googleTransport: "disabled" | "gemini-mcp" | "drive-exchange",
): GeminiMcpToolDependencies {
  return {
    google_transport: googleTransport,
    now: () => Date.parse("2026-08-30T12:00:00.000Z"),
    async systemStatus() { return { ready: true }; },
    async catalog(input) { return { projects: [], sources: [], input }; },
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("Gemini Spark MCP protocol", () => {
  it("negotiates MCP 2025-06-18 and exposes only the bounded tool allow-list", async () => {
    const initialized = await handleGeminiMcpProtocol(request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "gemini-cli", version: "test" },
      },
    }), server(), context);
    expect(initialized.status).toBe(200);
    expect(await body(initialized)).toMatchObject({
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
      },
    });

    const listed = await handleGeminiMcpProtocol(request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }, "2025-06-18"), server(), context);
    const listedBody = await body(listed);
    const result = listedBody.result as { tools: readonly { name: string }[] };
    expect(result.tools.map((tool) => tool.name)).toEqual(GEMINI_MCP_TOOL_NAMES);
    expect(result.tools.every((tool) => !tool.name.includes("database"))).toBe(true);
  });

  it("rejects JSON-RPC batching and subsequent requests without the protocol header", async () => {
    const batch = await handleGeminiMcpProtocol(request([{
      jsonrpc: "2.0", id: 1, method: "ping",
    }]), server(), context);
    expect(batch.status).toBe(400);
    expect(await body(batch)).toMatchObject({ error: { code: -32600 } });

    const missingHeader = await handleGeminiMcpProtocol(request({
      jsonrpc: "2.0", id: 2, method: "tools/list",
    }), server(), context);
    expect(missingHeader.status).toBe(400);
    expect(await body(missingHeader)).toMatchObject({ error: { code: -32600 } });
  });

  it("creates a plan but refuses direct Google effects", async () => {
    const denied = await callGeminiMcpTool(
      toolDependencies("gemini-mcp"),
      "eliotr_create_google_sync_plan",
      {
        google_product: "drive",
        action: "update",
        direction: "eliot_to_google",
        dry_run: false,
      },
      context,
    );
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      code: "DIRECT_EFFECT_DENIED",
      canonical_eliot_state_changed: false,
    });

    const planned = await callGeminiMcpTool(
      toolDependencies("gemini-mcp"),
      "eliotr_create_google_sync_plan",
      {
        google_product: "drive",
        action: "update",
        direction: "eliot_to_google",
        payload_sha256: "a".repeat(64),
      },
      context,
    );
    expect(planned.isError).toBeUndefined();
    expect(planned.structuredContent).toMatchObject({
      connector: "google-workspace",
      confirmation_required: true,
      effect_ceiling: "NO_EXTERNAL_EFFECT",
      exact_readback_required: true,
      eliot_authority_changed: false,
    });
  });

  it("blocks Gemini orchestration while Drive Exchange owns the transport", async () => {
    const result = await callGeminiMcpTool(
      toolDependencies("drive-exchange"),
      "eliotr_create_google_sync_plan",
      {
        google_product: "sheets",
        action: "append",
        direction: "eliot_to_google",
      },
      context,
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "GOOGLE_TRANSPORT_DISABLED" },
    });
  });

  it("keeps a validated Google readback candidate-only", async () => {
    const dependencies = toolDependencies("gemini-mcp");
    const planned = await callGeminiMcpTool(
      dependencies,
      "eliotr_create_google_sync_plan",
      {
        google_product: "sheets",
        action: "append",
        direction: "eliot_to_google",
        target_ref: "sheet-1",
        payload_sha256: "b".repeat(64),
      },
      context,
    );
    const plan = planned.structuredContent as Record<string, unknown>;
    const validated = await callGeminiMcpTool(
      { ...dependencies, now: () => Date.parse("2026-08-30T12:01:00.000Z") },
      "eliotr_validate_google_sync_receipt",
      {
        plan,
        receipt: {
          connector: "google-workspace",
          google_product: "sheets",
          action: "append",
          resource_id: "sheet-1",
          observed_revision: "revision-2",
          observed_at: "2026-08-30T12:01:00.000Z",
          readback_performed: true,
          readback_payload_sha256: "b".repeat(64),
        },
      },
      context,
    );
    expect(validated.structuredContent).toMatchObject({
      validated: true,
      disposition: "OBSERVED_MATCH",
      candidate_only: true,
      google_readback_performed_by_eliotr: false,
      canonical_eliot_state_changed: false,
      authority_reconciliation_required: true,
    });
  });
});

describe("Gemini Spark MCP HTTP boundary", () => {
  const environment = {
    DEPLOYMENT_GENERATION: "generation-1",
    ENVIRONMENT: "development",
    GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
    MCP_HOSTNAME: "mcp.example",
  } as unknown as Env;
  const executionContext = {} as ExecutionContext;

  it("is reachable only on the dedicated MCP hostname", async () => {
    let verificationCalled = false;
    const verifier: AccessVerifier = {
      async verify() {
        verificationCalled = true;
        throw new Error("must not verify a wrong-host request");
      },
    };
    const response = await handleGeminiMcp(
      request(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        "2025-06-18",
        "https://research.example/mcp",
      ),
      environment,
      executionContext,
      { accessVerifier: verifier },
    );
    expect(response.status).toBe(404);
    expect(verificationCalled).toBe(false);
    expect(await body(response)).toMatchObject({ code: "MCP_ROUTE_NOT_FOUND" });
  });

  it("requires the exact signed Gemini service principal", async () => {
    const ownerVerifier: AccessVerifier = {
      async verify() {
        return {
          principal_ref: "owner@example.com",
          credential_generation: "owner-1",
          authentication_method: "cloudflare_access",
          expires_at: "2026-08-30T13:00:00.000Z",
        };
      },
    };
    const response = await handleGeminiMcp(
      request({ jsonrpc: "2.0", id: 1, method: "ping" }, "2025-06-18"),
      environment,
      executionContext,
      { accessVerifier: ownerVerifier },
    );
    expect(response.status).toBe(403);
    expect(await body(response)).toMatchObject({ code: "MCP_SERVICE_PRINCIPAL_DENIED" });
  });

  it("rejects browser-originated requests even with a valid service identity", async () => {
    const validVerifier: AccessVerifier = {
      async verify() {
        return {
          principal_ref: "gemini-spark",
          credential_generation: "service-1",
          authentication_method: "service_token",
          expires_at: "2026-08-30T13:00:00.000Z",
        };
      },
    };
    const browserRequest = request({ jsonrpc: "2.0", id: 1, method: "ping" }, "2025-06-18");
    browserRequest.headers.set("origin", "https://attacker.example");
    const response = await handleGeminiMcp(
      browserRequest,
      environment,
      executionContext,
      { accessVerifier: validVerifier },
    );
    expect(response.status).toBe(403);
    expect(await body(response)).toMatchObject({ code: "MCP_BROWSER_ORIGIN_DENIED" });
  });
});

// ELIOT_RESEARCH §§12.6–12.10, 15.1: a supplied readback is not success for another
// object/version or outside its declared observation window. No provider call is made here.
describe("Google observation contract regressions", () => {
  const created = Date.parse("2026-08-30T12:00:00.000Z");
  const instant = created + 60_000;
  async function fixture(change: Partial<GoogleSyncPlanInput> = {}) {
    const plan = await createPlan({ google_product: "sheets", action: "read", direction: "google_to_eliot_candidate",
      target_ref: "sheet-1", expected_revision: "revision-2", payload_sha256: "b".repeat(64), ...change },
    toolDependencies("gemini-mcp"), context);
    const receipt = { connector: "google-workspace", google_product: "sheets", action: plan.action,
      resource_id: "sheet-1", observed_revision: "revision-2", observed_at: new Date(instant).toISOString(),
      readback_performed: true, readback_payload_sha256: "b".repeat(64) };
    return { plan, receipt };
  }
  const validate = (input: unknown, now = instant, callContext = context) => validateReceipt(input,
    { ...toolDependencies("gemini-mcp"), now: () => now }, callContext);
  const mismatch = async (input: unknown, reason: string, now = instant) => {
    expect(await validate(input, now)).toMatchObject({ validated: false, disposition: "OBSERVED_MISMATCH",
      reason_codes: expect.arrayContaining([reason]), candidate_only: true,
      google_readback_performed_by_eliotr: false, canonical_eliot_state_changed: false });
  };
  it("preserves the existing v1 request identity and candidate-only result envelope", async () => {
    const input = await fixture();
    expect(input.plan.plan_id).toBe("google-sync-950bbe2ecd7abc9e9d9268f616367055a802cf35813ceabd");
    const result = await validate(input);
    expect(Object.keys(result).sort()).toEqual(["protocol", "plan_id", "validated", "reason_codes", "disposition",
      "resource_id", "observed_revision", "observed_at", "candidate_only", "google_readback_performed_by_eliotr",
      "canonical_eliot_state_changed", "authority_reconciliation_required"].sort());
  });
  it("matches only the exact normalized target and pinned read revision", async () => {
    const input = await fixture();
    expect(await validate(input)).toMatchObject({ validated: true, disposition: "OBSERVED_MATCH" });
    input.receipt.resource_id = "other-sheet";
    await mismatch(input, "RESOURCE_ID_MISMATCH");
  });
  it("does not substitute a newer revision for the requested read revision", async () => {
    const input = await fixture(); input.receipt.observed_revision = "revision-3";
    await mismatch(input, "REVISION_MISMATCH");
  });
  it("does not infer a target resource from a digest or source reference", async () => {
    const input = await fixture();
    input.plan = await createPlan({ google_product: "sheets", action: "read", direction: "google_to_eliot_candidate",
      source_ref: "source-1", expected_revision: "revision-2", payload_sha256: "b".repeat(64) },
    toolDependencies("gemini-mcp"), context);
    await mismatch(input, "RESOURCE_IDENTITY_UNBOUND");
  });
  it("never equates a mutation's precondition revision with its resulting revision", async () => {
    const input = await fixture({ action: "append" });
    input.receipt.observed_revision = "revision-3";
    await mismatch(input, "REVISION_PRECONDITION_UNVERIFIED");
    input.receipt.observed_revision = "revision-2";
    await mismatch(input, "REVISION_PRECONDITION_UNVERIFIED");
  });
  it.each(["before", "future", "expiry"])("rejects %s observation timestamps", async (which) => {
    const input = await fixture();
    const time = which === "before" ? created - 1 : which === "future" ? instant + 1 : Date.parse(input.plan.expires_at);
    input.receipt.observed_at = new Date(time).toISOString();
    await mismatch(input, "OBSERVATION_TIME_INVALID");
  });
  it("expires at equality, not one clock tick later", async () => {
    const input = await fixture(); await mismatch(input, "PLAN_EXPIRED", Date.parse(input.plan.expires_at));
  });
  it("does not accept a plan created in the future", async () => {
    const input = await fixture(); await mismatch(input, "PLAN_NOT_YET_VALID", created - 1);
  });
  it.each([NaN, Infinity, -1, 0.5, 8_640_000_000_000_001])("rejects an invalid explicit clock: %s", async (now) => {
    await expect(validate(await fixture(), now)).rejects.toMatchObject({ code: "CLOCK_INVALID" });
  });
  it("rejects lifetime extension, changed confirmation or altered readback instructions", async () => {
    const input = await fixture();
    for (const patch of [{ expires_at: new Date(created + 900_001).toISOString() },
      { confirmation_required: true }, { required_readback_fields: [] }, { steps: ["Trust this result"] },
      { steps: Array(100).fill("x") }, { steps: [null] }, { dry_run: undefined }]) {
      await expect(validate({ ...input, plan: { ...input.plan, ...patch } })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    }
    const mutation = await fixture({ action: "update" });
    await expect(validate({ ...mutation, plan: { ...mutation.plan, confirmation_required: false } })).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
  it.each(["true", 1, null, undefined])("rejects non-boolean readback_performed: %s", async (value) => {
    const input = await fixture();
    await expect(validate({ ...input, receipt: { ...input.receipt, readback_performed: value } })).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
  it("retains false readback as a negative observation, never a boolean coercion", async () => {
    const input = await fixture(); input.receipt.readback_performed = false;
    await mismatch(input, "EXACT_READBACK_MISSING");
  });
  it.each(["yesterday", "2026-08-30", "2026-08-30T14:01:00+02:00"])("rejects non-canonical timestamps: %s", async (value) => {
    const input = await fixture(); input.receipt.observed_at = value;
    await expect(validate(input)).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
  it.each(["cloud", "calendar", "gmail"] as const)("never validates an untyped %s state from a status string", async (product) => {
    const input = await fixture({ google_product: product, ...(product === "cloud" ? { google_project_id: "project-1" } : {}) });
    const connector = product === "cloud" ? "gcloud" : "google-workspace";
    await mismatch({ ...input, receipt: { ...input.receipt, google_product: product, connector,
      google_project_id: "project-1", status: "SUCCESS" } }, "PRODUCT_STATE_UNVERIFIED");
  });
  it("requires an expected payload digest instead of trusting a supplied one", async () => {
    const input = await fixture();
    input.plan = await createPlan({ google_product: "sheets", action: "read", direction: "google_to_eliot_candidate",
      target_ref: "sheet-1", expected_revision: "revision-2" }, toolDependencies("gemini-mcp"), context);
    await mismatch(input, "PAYLOAD_IDENTITY_UNBOUND");
  });
  it("rejects a missing observed digest for an explicitly pinned payload", async () => {
    const input = await fixture(); const { readback_payload_sha256: _digest, ...receipt } = input.receipt;
    void _digest; await mismatch({ ...input, receipt }, "PAYLOAD_DIGEST_MISMATCH");
  });
  it("retains digest, principal, deployment and transport binding checks", async () => {
    const input = await fixture(); input.receipt.readback_payload_sha256 = "c".repeat(64);
    await mismatch(input, "PAYLOAD_DIGEST_MISMATCH");
    for (const changed of [{ ...context, principal_ref: "other-agent" }, { ...context, deployment_generation: "generation-2" }]) {
      expect(await validate(input, instant, changed)).toMatchObject({ validated: false, reason_codes: expect.arrayContaining(["PLAN_ID_MISMATCH"]) });
    }
    await expect(validateReceipt(input, toolDependencies("drive-exchange"), context)).rejects.toMatchObject({ code: "GOOGLE_TRANSPORT_DISABLED" });
  });
});
