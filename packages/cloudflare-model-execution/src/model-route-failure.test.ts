import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWorkflowCheckpointErrorMessage } from "@eliotr/cloudflare-workflows";
import { modelRouteFailure } from "./model-attempt-handler.js";

describe("model route failure diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());
  it("keeps a recognized cause through the native failure envelope with the paid outcome unknown", () => {
    const cause = Object.assign(new Error("private provider payload must never enter diagnostics"), {
      code: "MODEL_GATEWAY_PROMPT_COMPILE_FAILED", retryable: true,
    });
    const error = modelRouteFailure(cause, "SYNTHESIZE");
    expect(error.code).toBe("WORKFLOW_EFFECT_UNCERTAIN");
    expect(error.failure).toMatchObject({ code: "MODEL_GATEWAY_PROMPT_COMPILE_FAILED", phase: "STAGE",
      stage: "SYNTHESIZE", retryable: false, dispatch_state: "OUTCOME_UNKNOWN",
      references_intact: "UNKNOWN", recovery_action: "RECONCILE" });
    expect(parseWorkflowCheckpointErrorMessage(error.message)?.failure?.code).toBe("MODEL_GATEWAY_PROMPT_COMPILE_FAILED");
    expect(error.message).not.toContain(cause.message);
  });

  it("does not serialize unknown messages or execute a code getter", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let getterRead = false;
    const cause = Object.defineProperty(new Error("secret"), "code", { get() { getterRead = true; return "MODEL_GATEWAY_REQUEST_INVALID"; } });
    const error = modelRouteFailure(cause, "SYNTHESIZE");
    expect(getterRead).toBe(false);
    expect(error.failure?.code).toBe("WORKFLOW_EFFECT_UNCERTAIN");
    expect(error.message).not.toContain("secret");
    expect(log.mock.calls.flat().join("")).not.toContain("secret");
  });

  it("retains only closed response diagnostics without changing paid-outcome uncertainty", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cause = Object.assign(new Error("private response"), { code: "MODEL_GATEWAY_RESPONSE_INVALID",
      http_status: 403, safe_response_reason: "LOG_CORRELATION_INVALID", payload: "private payload" });
    const error = modelRouteFailure(cause, "SYNTHESIZE");
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ event: "research_model_route_failed",
      code: "MODEL_GATEWAY_RESPONSE_INVALID", stage: "SYNTHESIZE", http_status: 403,
      safe_response_reason: "LOG_CORRELATION_INVALID" });
    expect(error.failure).toMatchObject({ dispatch_state: "OUTCOME_UNKNOWN", retryable: false });
    let getterRead = false;
    Object.defineProperty(cause, "safe_response_reason", { get() { getterRead = true; return "secret"; } });
    Object.defineProperty(cause, "http_status", { get() { getterRead = true; return 401; } });
    modelRouteFailure(cause, "SYNTHESIZE");
    expect(getterRead).toBe(false);
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toEqual({ event: "research_model_route_failed",
      code: "MODEL_GATEWAY_RESPONSE_INVALID", stage: "SYNTHESIZE" });
    expect(log.mock.calls.flat().join("")).not.toContain("private");
  });
});
