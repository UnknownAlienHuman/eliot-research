import { describe, expect, it, vi } from "vitest";
import type { ErasureFence, ErasureRequest, PurgeTarget } from "@eliotr/contracts";
import {
  createCloudflareErasureBackend,
  createD1ErasureInventory,
  createManagedSearchErasureLocationPort,
  type ErasureAuthorityPort,
  type ErasureInvalidationPort,
  type ErasureInventoryPort,
  type ErasureLocationPort,
  type ErasureLocationRegistry,
  type ManagedSearchErasureNamespace,
} from "@eliotr/cloudflare-erasure";
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

const fence: ErasureFence = {
  erasure_id: "erasure-1",
  revision: 1,
  lease_owner: "worker-1",
  lease_generation: 1,
  lease_until_ms: Date.parse("2026-09-11T00:00:00.000Z"),
};

function request(
  exactSubjectRefs: readonly string[],
  requiredLocations: ErasureRequest["required_locations"],
): ErasureRequest {
  return {
    protocol: "erc.privacy.erasure.v1",
    erasure_ref: { id: "erasure-1", revision: 1 },
    requested_by_principal_ref: "owner-1",
    exact_subject_refs: [...exactSubjectRefs],
    required_locations: [...requiredLocations],
    legal_basis_ref: "owner-request",
    admitted_at: "2026-09-10T00:00:00.000Z",
    deadline: "2026-09-11T00:00:00.000Z",
  };
}

function target(kind: PurgeTarget["target_kind"] = "OBJECT"): PurgeTarget {
  return {
    target_id: "target-1",
    target_kind: kind,
    exact_subject_ref: "evidence-handle:handle-1:1",
    location: "ProviderCopy",
    canonical_ref: kind === "OBJECT" ? "ai-search:index-1:item-1.md" : "empty-proof:ProviderCopy:invalid",
    provider_ref: "provider-generation-1",
    identity_digest: "a".repeat(64),
    shared_live_reference_count: 0,
  };
}

describe("configured erasure runtime", () => {
  it("constructs the sole exact erasure coordinator without exposing an owner hard-delete route", () => {
    const coordinator = createConfiguredErasureCoordinator(environment());
    expect(coordinator).toEqual({ execute: expect.any(Function) });
    expect(Object.keys(coordinator)).toEqual(["execute"]);
  });

  it("refuses to invent an empty-location proof when no authoritative target was enumerated", async () => {
    const inventory = createD1ErasureInventory({
      core_database: {} as D1Database,
      search_database: {} as D1Database,
    });
    await expect(inventory.enumerate(request(["evidence-handle:handle-1:1"], ["Blob"])))
      .rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
  });

  it("detects the 10001st D1 inventory row instead of truncating closure", async () => {
    const rows = Array.from({ length: 10_001 }, (_, index) => ({
      source_revision_ref: `revision-${index}`,
      source_id: "source-1",
      original_r2_key: null,
      normalized_artifact_ref: null,
      content_sha256: "a".repeat(64),
      object_residency_key_digest: "b".repeat(64),
      purge_state: "LIVE",
    }));
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ all: vi.fn(async () => ({ success: true, results: rows })) })),
      })),
    } as unknown as D1Database;
    const inventory = createD1ErasureInventory({ core_database: database, search_database: {} as D1Database });
    await expect(inventory.enumerate(request(["source:source-1"], ["CanonicalPayload"])))
      .rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
  });

  it("rejects cyclic managed-search cursors and performs no delete", async () => {
    const remove = vi.fn(async () => undefined);
    const list = vi.fn(async (cursor?: string) => ({
      items: [],
      cursor: cursor === undefined ? "cursor-a" : cursor === "cursor-a" ? "cursor-b" : "cursor-a",
    }));
    const namespace = {
      get: vi.fn(() => ({ list, delete: remove, info: vi.fn() })),
    } as unknown as ManagedSearchErasureNamespace;
    const location = createManagedSearchErasureLocationPort(namespace);
    await expect(location.purge(request(["evidence-handle:handle-1:1"], ["ProviderCopy"]), fence, target()))
      .rejects.toMatchObject({ code: "ERASURE_SETTLEMENT_UNCERTAIN" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("rejects a persisted synthetic empty proof before dispatching a location adapter", async () => {
    const purge = vi.fn<ErasureLocationPort["purge"]>();
    const authority = {
      assertFence: vi.fn(async () => undefined),
      recordPurge: vi.fn(async () => undefined),
    } as unknown as ErasureAuthorityPort;
    const locations = {
      forLocation: vi.fn(() => ({ purge, verifyAbsent: vi.fn() })),
    } as unknown as ErasureLocationRegistry;
    const backend = createCloudflareErasureBackend({
      core_database: {} as D1Database,
      authority,
      inventory: {} as ErasureInventoryPort,
      locations,
      invalidation: {} as ErasureInvalidationPort,
    });
    await expect(backend.purge(
      request(["evidence-handle:handle-1:1"], ["ProviderCopy"]),
      fence,
      target("LOCATION_EMPTY_PROOF"),
    )).rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
    expect(purge).not.toHaveBeenCalled();
    expect(locations.forLocation).not.toHaveBeenCalled();
  });
});
