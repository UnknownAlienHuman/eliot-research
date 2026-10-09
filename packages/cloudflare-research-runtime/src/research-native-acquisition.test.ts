import { describe, expect, it, vi } from "vitest";
import { createResearchNativeAcquisitionStageRoute } from "./research-native-acquisition.js";
import type { NativeWebSearchRawCaptureOwnerPort } from "@eliotr/platform-cloudflare";

const SHA256 = "a".repeat(64);

function selection() {
  return {
    source_mode: "corpus_plus_web" as const,
    result_limit: 3,
    search: {
      gateway_id: "research-gateway",
      provider: "exa" as const,
      timeout_ms: 1_000,
    },
    browser_markdown: {
      timeout_ms: 1_000,
      max_markdown_bytes: 16_384,
      redirect_policy: "exact_url_only" as const,
    },
  };
}

function dependencies() {
  const websearch = vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
    headers: { "content-type": "application/json" },
  }));
  const browser = { quickAction: vi.fn(async () => new Response()) };
  const capture_owner: NativeWebSearchRawCaptureOwnerPort = {
    captureRawFile: vi.fn(async () => {
      throw new Error("capture must not be reached in this fixture");
    }),
    readRawFileByIdempotency: vi.fn(async () => null),
  };
  return {
    websearch,
    browser,
    capture_owner,
    route: createResearchNativeAcquisitionStageRoute({
      selection: selection(),
      websearch_binding: { websearch },
      browser,
      capture_owner,
    }),
  };
}

describe("research native acquisition stage route", () => {
  it("requires an owner-authorized capture capability before any provider call", () => {
    const websearch = vi.fn(async () => new Response());

    expect(() => createResearchNativeAcquisitionStageRoute({
      selection: selection(),
      websearch_binding: { websearch },
      browser: { quickAction: vi.fn(async () => new Response()) },
      capture_owner: undefined,
    })).toThrow("WORKFLOW_CONFIGURATION_MISSING");
    expect(websearch).not.toHaveBeenCalled();
  });

  it("refuses a corpus-only selection before any provider call", () => {
    const websearch = vi.fn(async () => new Response());

    expect(() => createResearchNativeAcquisitionStageRoute({
      selection: { ...selection(), source_mode: "corpus_only" } as never,
      websearch_binding: { websearch },
      browser: { quickAction: vi.fn(async () => new Response()) },
      capture_owner: {
        captureRawFile: vi.fn(async () => {
          throw new Error("capture must not be reached in this fixture");
        }),
        readRawFileByIdempotency: vi.fn(async () => null),
      },
    })).toThrow("WORKFLOW_CONFIGURATION_INVALID");
    expect(websearch).not.toHaveBeenCalled();
  });

  it("does not dispatch against malformed or unbound frozen protocol input", async () => {
    const fixture = dependencies();
    const stageInput = {
      request: {
        protocol: "eliotr.workflow-stage.v1" as const,
        operation_id: "research-op-1",
        investigation_ref: { id: "investigation-1", revision: 2 },
        stage: "ACQUIRE_AND_CAPTURE" as const,
        idempotency_key: "acquire-1",
        handler_generation: "research-handlers.test.v1",
        input_manifest: {
          object_ref: "workflow/protocol-scope",
          sha256: SHA256,
          byte_length: 2,
          residency: {
            scope_domain_id: "scope-1",
            access_domain_id: "principal-1",
            confidentiality_domain_id: "private",
            encryption_key_domain_id: "key-1",
            retention_domain_id: "retention-1",
            erasure_domain_id: "erasure-1",
            content_digest: { algorithm: "sha256" as const, digest: SHA256 },
          },
        },
      },
      principal: {
        principal_ref: "principal-1",
        credential_generation: "credential-1",
        deployment_generation: "deployment-1",
      },
      input_bytes: new TextEncoder().encode("{}"),
      attempt_ref: "attempt-1",
      budget_receipt_ref: "budget-1",
    };

    await expect(fixture.route.handler(stageInput)).rejects.toThrow("WORKFLOW_OUTPUT_CORRUPT");
    expect(fixture.websearch).not.toHaveBeenCalled();
    expect(fixture.browser.quickAction).not.toHaveBeenCalled();
    expect(fixture.capture_owner.captureRawFile).not.toHaveBeenCalled();
  });

  it("leaves a lost stage acknowledgement unknown without redispatching paid effects", async () => {
    const fixture = dependencies();
    const recovered = await fixture.route.recoverStartedAttempt({
      request: {} as never,
      principal_ref: "principal-1",
      credential_generation: "credential-1",
      deployment_generation: "deployment-1",
      stage_index: 1,
      request_sha256: SHA256,
      attempt_ref: "attempt-1",
      output_object_ref: "workflow/output-1",
      expected_revision: 2,
      budget_receipt_ref: "budget-1",
      budget_expires_at_ms: 1_000,
    });

    expect(recovered).toBeNull();
    expect(fixture.websearch).not.toHaveBeenCalled();
    expect(fixture.browser.quickAction).not.toHaveBeenCalled();
    expect(fixture.capture_owner.readRawFileByIdempotency).not.toHaveBeenCalled();
  });
});
