import { describe, expect, it, vi } from "vitest";
import type { PrivacyController, SessionContext } from "../app/privacy";
import {
  readResearchRunHistoryWithDiagnostic,
  type ResearchHistoryReadDiagnostic,
} from "./research-history-diagnostic";

describe("Recent history diagnostics", () => {
  it("keeps the protected rejection when the opt-in observer throws and emits only bounded metadata", async () => {
    const context = {
      principal: "private-principal",
      credentialGeneration: "private-credential-generation",
      deploymentGeneration: "private-deployment-generation",
      cacheEpoch: 11,
    } as SessionContext;
    const privacy = {
      getSnapshot: () => ({ phase: "available" as const, revision: 11, context }),
      isCurrent: () => true,
    } as unknown as PrivacyController;
    const failure = Object.assign(new Error("private response body"), {
      code: "API_RESPONSE_INVALID",
      status: 502,
      traceId: "private-trace",
    });
    const observer = vi.fn((_event: ResearchHistoryReadDiagnostic) => {
      throw new Error("diagnostic sink failed");
    });

    const pending = readResearchRunHistoryWithDiagnostic({
      privacy,
      context,
      signal: new AbortController().signal,
      read: async () => { throw failure; },
      observer,
    });

    await expect(pending).rejects.toBe(failure);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer.mock.calls[0]?.[0]).toEqual({
      protocol: "eliotr.research-history-read-diagnostic.v1",
      outcome: "api_rejected",
      typedCode: "API",
      status: "HTTP_5XX",
      privacyPhase: "available",
      privacyRevision: 11,
      privacyCurrent: true,
      apiReadStarted: true,
      apiReadResolved: false,
      signalAborted: false,
    });
    const event = JSON.stringify(observer.mock.calls[0]?.[0]);
    expect(event).not.toContain("private-");
    expect(event).not.toContain("response body");
    expect(event).not.toContain("traceId");
  });
});
