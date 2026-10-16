import { describe, expect, it } from "vitest";
import { WorkflowFailureOutcomeSchema } from "@eliotr/cloudflare-workflows";
import {
  annotateNoRetrievalEffectDispatched,
  retrievalEffectNotDispatched,
  settleRetrievalFailure,
  settledReadOnlyRetrievalStop,
} from "./research-retrieval-composition.js";

/**
 * The review finding: absence of durable q4 admission rows does NOT prove that the
 * native SEM lane did not reach a provider, because that lane is not
 * `managed_outcome_capable` and performs no q4 admission. These cases pin the
 * server-local proof gate that replaces that unsound assumption.
 */
function budgetStop() {
  return Object.assign(new Error("query budget is exhausted"), { code: "RETRIEVAL_BUDGET_STOP" });
}

describe("retrieval dispatch proof gate", () => {
  it("refuses to settle an unannotated stop even for a mapped read-only code", () => {
    const error = budgetStop();
    expect(retrievalEffectNotDispatched(error)).toBe(false);
    expect(settledReadOnlyRetrievalStop({ error, code: error.code, stage: "RETRIEVE_BRANCHES" })).toBeNull();
  });

  it("refuses to settle an unannotated RESOLUTION_UNCERTAIN stop", () => {
    const error = Object.assign(new Error("settlement is uncertain"), { code: "RETRIEVAL_RESOLUTION_UNCERTAIN" });
    expect(settledReadOnlyRetrievalStop({ error, code: error.code, stage: "RETRIEVE_BRANCHES" })).toBeNull();
  });

  it("never settles RESOLUTION_UNCERTAIN even when the tracker is untouched", () => {
    // The code itself means "cannot tell", so proven non-dispatch must not turn it
    // into a settled known failure; the durable admission probe stays irrelevant.
    const error = Object.assign(new Error("stored query result is unavailable"), {
      code: "RETRIEVAL_RESOLUTION_UNCERTAIN",
    });
    annotateNoRetrievalEffectDispatched(error);
    expect(retrievalEffectNotDispatched(error)).toBe(true);
    expect(settledReadOnlyRetrievalStop({ error, code: error.code, stage: "RETRIEVE_BRANCHES" })).toBeNull();
  });

  it("refuses an annotated stop whose code is not a pre-dispatch candidate", () => {
    const error = Object.assign(new Error("managed provider execution outcome is uncertain"), {
      code: "RETRIEVAL_RESOLUTION_UNCERTAIN",
    });
    annotateNoRetrievalEffectDispatched(error);
    // Annotated, but an unproven code still cannot widen settlement beyond the map.
    const dispatchCapable = Object.assign(new Error("provider transport failed"), {
      code: "MODEL_GATEWAY_TRANSPORT_FAILED",
    });
    annotateNoRetrievalEffectDispatched(dispatchCapable);
    expect(settledReadOnlyRetrievalStop({ error: dispatchCapable, code: dispatchCapable.code, stage: "RETRIEVE_BRANCHES" }))
      .toBeNull();
  });

  it("settles only an annotated stop with a mapped pre-dispatch code", () => {
    const error = budgetStop();
    annotateNoRetrievalEffectDispatched(error);
    const settled = settledReadOnlyRetrievalStop({ error, code: error.code, stage: "RETRIEVE_BRANCHES" });
    expect(settled).toEqual({
      protocol: "eliotr.workflow-failure-outcome.v1",
      code: "WORKFLOW_BUDGET_STOP",
      phase: "STAGE",
      stage: "RETRIEVE_BRANCHES",
      retryable: false,
      dispatch_state: "NOT_STARTED",
      references_intact: "INTACT",
      recovery_action: "NONE",
    });
    expect(WorkflowFailureOutcomeSchema.safeParse(settled).success).toBe(true);
  });

  it("does not treat a browser-supplied or inherited property as dispatch proof", () => {
    const spoofed = { code: "RETRIEVAL_BUDGET_STOP", "eliotr.retrieval-no-effect-dispatched": true };
    expect(retrievalEffectNotDispatched(spoofed)).toBe(false);
    const inherited = Object.create({ "eliotr.retrieval-no-effect-dispatched": true }) as object;
    Object.assign(inherited, { code: "RETRIEVAL_BUDGET_STOP" });
    expect(retrievalEffectNotDispatched(inherited)).toBe(false);
  });

  it("reports a frozen error as unproven rather than throwing", () => {
    const frozen = Object.freeze(Object.assign(new Error("budget stop"), { code: "RETRIEVAL_BUDGET_STOP" }));
    expect(retrievalEffectNotDispatched(frozen)).toBe(false);
    expect(settledReadOnlyRetrievalStop({ error: frozen, code: "RETRIEVAL_BUDGET_STOP", stage: "RETRIEVE_BRANCHES" }))
      .toBeNull();
  });

  it("annotates only the untouched tracker and leaves a dispatched stop unproven", () => {
    const untouched = budgetStop();
    expect(() => settleRetrievalFailure({ effect_dispatched: false }, untouched)).toThrow(untouched);
    expect(retrievalEffectNotDispatched(untouched)).toBe(true);

    const dispatched = budgetStop();
    expect(() => settleRetrievalFailure({ effect_dispatched: true }, dispatched)).toThrow(dispatched);
    expect(retrievalEffectNotDispatched(dispatched)).toBe(false);
    expect(settledReadOnlyRetrievalStop({ error: dispatched, code: dispatched.code, stage: "RETRIEVE_BRANCHES" }))
      .toBeNull();
  });
});
