import { describe, expect, it, vi } from "vitest";
import type { ErasureFence, ErasureRequest, PurgeTarget } from "@eliotr/contracts";
import { createD1ErasureAuthority } from "./authority.js";
import { createCloudflareErasureBackend } from "./backend.js";
import { createD1ErasureInventory } from "./inventory.js";
import { createManagedSearchErasureLocationPort } from "./provider-location.js";
import type {
  ErasureAuthorityPort,
  ErasureInvalidationPort,
  ErasureInventoryPort,
  ErasureLocationPort,
  ErasureLocationRegistry,
  ManagedSearchErasureNamespace,
} from "./types.js";

vi.mock("./authority-fence-lifecycle.js", () => ({
  createD1ErasureAuthorityFenceLifecycle: () => ({
    acquireErasure: async () => null,
    remember() {}, forget() {}, assertCurrent: async () => undefined, release: async () => undefined,
  }),
}));

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

function emptyD1(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn(async () => ({ success: true, results: [] })),
        first: vi.fn(async () => null),
      })),
    })),
  } as unknown as D1Database;
}

interface AuthorityCall { readonly sql: string; readonly values: readonly unknown[] }
interface AuthorityD1Options {
  readonly targetRow?: unknown | null;
  readonly targetError?: boolean;
  readonly holdResult?: unknown;
  readonly holdError?: boolean;
}
function authorityD1(options: AuthorityD1Options): { readonly database: D1Database; readonly calls: AuthorityCall[] } {
  const calls: AuthorityCall[] = [];
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          calls.push({ sql, values });
          return {
            async first<T>() {
              if (!sql.includes("FROM erasure_target")) throw new Error(`unexpected first query: ${sql}`);
              if (options.targetError) throw new Error("target read failed");
              return (options.targetRow ?? null) as T | null;
            },
            async all<T>() {
              if (!sql.includes("FROM erasure_hold")) throw new Error(`unexpected all query: ${sql}`);
              if (options.holdError) throw new Error("hold read failed");
              return (options.holdResult ?? { success: true, results: [] }) as T;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { database, calls };
}
function storedTarget(candidate: PurgeTarget): Record<string, unknown> {
  return {
    target_id: candidate.target_id, target_kind: candidate.target_kind, exact_subject_ref: candidate.exact_subject_ref,
    location: candidate.location, canonical_ref: candidate.canonical_ref, provider_ref: candidate.provider_ref ?? null,
    identity_digest: candidate.identity_digest, shared_live_reference_count: candidate.shared_live_reference_count,
    retention_or_hold_ref: candidate.retention_or_hold_ref ?? null, next_review_at: candidate.next_review_at ?? null,
  };
}
function authorityBlockers(options: AuthorityD1Options, candidate = target()) {
  const selectedRequest = request([candidate.exact_subject_ref], [candidate.location]);
  const fixture = authorityD1({ targetRow: storedTarget(candidate), ...options });
  const authority = createD1ErasureAuthority({ core_database: fixture.database, now: () => 1_000 });
  const closure = {
    erasure_ref: selectedRequest.erasure_ref, request_digest: "a".repeat(64), closure_digest: "b".repeat(64),
    targets: [candidate],
  };
  return { fixture, promise: authority.blockersFor(selectedRequest, fence, closure) };
}

describe("erasure closure completeness", () => {
  it("refuses to invent an empty-location proof when no authoritative target was enumerated", async () => {
    const inventory = createD1ErasureInventory({
      core_database: emptyD1(),
      search_database: emptyD1(),
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
    const inventory = createD1ErasureInventory({ core_database: database, search_database: emptyD1() });
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
      core_database: emptyD1(),
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

describe("fenced current-hold authority recheck", () => {
  it("rejects a closure target whose durable erasure_target identity changed", async () => {
    const candidate = target();
    const call = authorityBlockers({ targetRow: storedTarget({ ...candidate, canonical_ref: "durable-different" }) }, candidate);
    await expect(call.promise).rejects.toMatchObject({ code: "ERASURE_IDENTITY_CONFLICT" });
    expect(call.fixture.calls.some((item) => item.sql.includes("FROM erasure_hold"))).toBe(false);
  });

  it.each([
    ["target throw", { targetError: true }],
    ["target success false", { targetRow: { success: false } }],
    ["hold throw", { holdError: true }],
    ["hold success false", { holdResult: { success: false, results: [] } }],
  ])("fails closed on a %s", async (_label, options) => {
    const call = authorityBlockers(options);
    await expect(call.promise).rejects.toMatchObject({ code: "ERASURE_SETTLEMENT_UNCERTAIN", retryable: true });
  });

  it("scopes holds with NULL wildcards and returns exact hold metadata", async () => {
    const candidate = target();
    const unrelated = {
      hold_ref: "hold-unrelated", exact_subject_ref: "other-subject", location: candidate.location,
      canonical_ref: candidate.canonical_ref, policy_or_hold_ref: "wrong-policy", next_review_at: "2026-09-12T00:00:00.000Z",
    };
    const wildcard = {
      hold_ref: "hold-wildcard", exact_subject_ref: null, location: null, canonical_ref: null,
      policy_or_hold_ref: "wildcard-policy", next_review_at: "2026-09-13T00:00:00.000Z",
    };
    const exact = {
      hold_ref: "hold-exact", exact_subject_ref: candidate.exact_subject_ref, location: candidate.location,
      canonical_ref: candidate.canonical_ref, policy_or_hold_ref: "exact-policy", next_review_at: "2026-09-14T00:00:00.000Z",
    };
    const call = authorityBlockers({ holdResult: { success: true, results: [unrelated, wildcard, exact] } }, candidate);
    await expect(call.promise).resolves.toEqual([{
      target_id: candidate.target_id, location: candidate.location, policy_or_hold_ref: "wildcard-policy",
      next_review_at: "2026-09-13T00:00:00.000Z", reason_code: "RETENTION_OR_HOLD_ACTIVE",
    }]);
    const holdCall = call.fixture.calls.find((item) => item.sql.includes("FROM erasure_hold"));
    expect(holdCall?.sql).toContain("exact_subject_ref IS NULL OR exact_subject_ref=?1");
    expect(holdCall?.values).toEqual([candidate.exact_subject_ref, candidate.location, candidate.canonical_ref]);
  });
});
