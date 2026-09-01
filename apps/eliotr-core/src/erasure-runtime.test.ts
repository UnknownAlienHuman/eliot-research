import { describe, expect, it, vi } from "vitest";
import { createConfiguredErasureCoordinator } from "./erasure-runtime.js";
import type { Env } from "./env.js";

function environment(): Env {
  return {
    CORE_DB: {} as D1Database,
    SEARCH_DB: {} as D1Database,
    EVIDENCE_BUCKET: {} as R2Bucket,
    WORK_BUCKET: {} as R2Bucket,
    JOB_QUEUE: {} as Queue<unknown>,
    RESEARCH_SESSION: {} as DurableObjectNamespace,
    RESEARCH_WORKFLOW: {} as Workflow,
    AI_SEARCH: {
      get: vi.fn(() => ({
        search: vi.fn(),
        items: {
          createOrUpdate: vi.fn(),
          uploadAndPoll: vi.fn(),
          delete: vi.fn(),
          get: vi.fn(),
          list: vi.fn(),
        },
      })),
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      search: vi.fn(),
    } as never,
    METRICS: {} as AnalyticsEngineDataset,
    ASSETS: {} as Fetcher,
    ENVIRONMENT: "development",
    DEPLOYMENT_GENERATION: "test-generation",
    AI_GATEWAY_REASONING_URL: "https://example.invalid/reasoning",
    AI_GATEWAY_RETRIEVAL_URL: "https://example.invalid/retrieval",
  };
}

describe("configured erasure runtime", () => {
  it("constructs the sole exact erasure coordinator without exposing an owner hard-delete route", () => {
    const coordinator = createConfiguredErasureCoordinator(environment());
    expect(coordinator).toEqual({ execute: expect.any(Function) });
    expect(Object.keys(coordinator)).toEqual(["execute"]);
  });
});
