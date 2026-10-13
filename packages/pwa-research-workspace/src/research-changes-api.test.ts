import { afterEach, describe, expect, it, vi } from "vitest";
import { readResearchChanges } from "./research-changes-api.js";

const deploymentGeneration = "deploy-1";

function item(sequence: number): Record<string, unknown> {
  return {
    sequence,
    change_ref: `change:${sequence}`,
    kind: "RESEARCH_COMPLETED",
    subject_ref: `research/subject-${sequence}`,
    subject_revision: 1,
    payload_ref: `r2/payload-${sequence}`,
    payload_sha256: "a".repeat(64),
    occurred_at: "2026-10-13T09:00:00.000Z",
    metadata: { stage: "SYNTHESIZE" },
  };
}

function envelope(data: unknown, generation = deploymentGeneration): unknown {
  return { data, trace_id: "trace-1", deployment_generation: generation };
}

function installFetch(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("PWA research changes API protocol compatibility", () => {
  it("preserves v1 decoding behavior and omits v2 scan metadata", async () => {
    installFetch(envelope({
      protocol: "eliotr.research-changes.v1",
      items: [item(2), item(1)],
      next_cursor: "legacy.cursor",
      has_more: true,
    }));

    const view = await readResearchChanges(deploymentGeneration);

    expect(view.items.map((change) => change.subject_ref)).toEqual(["research/subject-2", "research/subject-1"]);
    expect(view.next_cursor).toBe("legacy.cursor");
    expect("visibility_scan" in view).toBe(false);
  });

  it("requires the exact historical v1 result fields", async () => {
    installFetch(envelope({
      protocol: "eliotr.research-changes.v1",
      items: [],
      next_cursor: null,
      has_more: false,
      visibility_scan: { direction: "LATEST", state: "SOURCE_EXHAUSTED" },
    }));

    await expect(readResearchChanges(deploymentGeneration))
      .rejects.toMatchObject({ code: "RESEARCH_CHANGES_RESPONSE_INVALID" });
  });

  it("accepts an empty budget-stopped page with its opaque continuation", async () => {
    const fetchMock = installFetch(envelope({
      protocol: "eliotr.research-changes.v2",
      items: [],
      next_cursor: "opaque.resume",
      has_more: true,
      visibility_scan: { direction: "LATEST", state: "BUDGET_STOPPED" },
    }));

    const view = await readResearchChanges(deploymentGeneration, { startAt: "latest" });

    expect(view.items).toEqual([]);
    expect(view.next_cursor).toBe("opaque.resume");
    expect(view.has_more).toBe(true);
    expect(view.visibility_scan).toEqual({ direction: "LATEST", state: "BUDGET_STOPPED" });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(request?.body))).toEqual({
      after_cursor: null,
      limit: 20,
      kinds: ["RESEARCH_COMPLETED", "ARTIFACT_DRAFTED", "WIKI_PUBLISHED", "SOURCE_ADMITTED", "SOURCE_UPDATED"],
      start_at: "latest",
    });
  });

  it("accepts ascending completed latest pages and rejects a reordered v2 page", async () => {
    installFetch(envelope({
      protocol: "eliotr.research-changes.v2",
      items: [item(10), item(11)],
      next_cursor: "opaque.forward",
      has_more: false,
      visibility_scan: { direction: "LATEST", state: "TARGET_REACHED" },
    }));

    const view = await readResearchChanges(deploymentGeneration, { startAt: "latest" });
    expect(view.items.map((change) => change.subject_ref)).toEqual(["research/subject-10", "research/subject-11"]);
    expect(view.visibility_scan).toEqual({ direction: "LATEST", state: "TARGET_REACHED" });

    installFetch(envelope({
      protocol: "eliotr.research-changes.v2",
      items: [item(11), item(10)],
      next_cursor: "opaque.forward",
      has_more: false,
      visibility_scan: { direction: "LATEST", state: "TARGET_REACHED" },
    }));
    await expect(readResearchChanges(deploymentGeneration, { startAt: "latest" }))
      .rejects.toMatchObject({ code: "RESEARCH_CHANGES_RESPONSE_INVALID" });
  });

  it("rejects inconsistent budget-stop metadata and extra scan fields", async () => {
    installFetch(envelope({
      protocol: "eliotr.research-changes.v2",
      items: [],
      next_cursor: null,
      has_more: true,
      visibility_scan: { direction: "FORWARD", state: "BUDGET_STOPPED" },
    }));
    await expect(readResearchChanges(deploymentGeneration))
      .rejects.toMatchObject({ code: "RESEARCH_CHANGES_RESPONSE_INVALID" });

    installFetch(envelope({
      protocol: "eliotr.research-changes.v2",
      items: [],
      next_cursor: "opaque.resume",
      has_more: true,
      visibility_scan: { direction: "FORWARD", state: "BUDGET_STOPPED", hidden_rows: 4 },
    }));
    await expect(readResearchChanges(deploymentGeneration))
      .rejects.toMatchObject({ code: "RESEARCH_CHANGES_RESPONSE_INVALID" });
  });

  it("keeps the deployment-generation authority fence", async () => {
    installFetch(envelope({
      protocol: "eliotr.research-changes.v2",
      items: [],
      next_cursor: null,
      has_more: false,
      visibility_scan: { direction: "FORWARD", state: "SOURCE_EXHAUSTED" },
    }, "deploy-2"));

    await expect(readResearchChanges(deploymentGeneration))
      .rejects.toMatchObject({ code: "RESEARCH_CHANGES_DEPLOYMENT_CHANGED" });
  });
});
