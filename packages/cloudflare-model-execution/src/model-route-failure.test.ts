import { describe, expect, it } from "vitest";
import { parseWorkflowCheckpointErrorMessage } from "@eliotr/cloudflare-workflows";
import { modelRouteFailure } from "./model-attempt-handler.js";

describe("model route failure diagnostics", () => {
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
    let getterRead = false;
    const cause = Object.defineProperty(new Error("secret"), "code", { get() { getterRead = true; return "MODEL_GATEWAY_REQUEST_INVALID"; } });
    const error = modelRouteFailure(cause, "SYNTHESIZE");
    expect(getterRead).toBe(false);
    expect(error.failure?.code).toBe("WORKFLOW_EFFECT_UNCERTAIN");
    expect(error.message).not.toContain("secret");
  });
});
