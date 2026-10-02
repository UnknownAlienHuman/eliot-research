import { describe, expect, it, vi } from "vitest";
import {
  assertEmptyProofSubjectRootBinding,
  createEmptyLocationProofTarget,
  parseEmptyLocationProof,
} from "./empty-location-proof.js";
import { listR2WorkPrefix, projectionWorkPrefix } from "./empty-location-proof-r2.js";
import { createCloudflareErasureBackend } from "./backend.js";
import { createD1CoreErasureLocationPort } from "./core-location.js";
import type { ErasureFence, ErasureRequest, PurgeTarget } from "@eliotr/contracts";
import type { ErasureAuthorityPort, ErasureInvalidationPort, ErasureInventoryPort, ErasureLocationRegistry } from "./types.js";

const request: ErasureRequest = {
  protocol: "erc.privacy.erasure.v1",
  erasure_ref: { id: "erase-empty-1", revision: 1 },
  requested_by_principal_ref: "owner-1",
  exact_subject_refs: ["source-revision:revision-1"],
  required_locations: ["Projection"],
  legal_basis_ref: "owner-request-1",
  admitted_at: "2026-09-01T00:00:00.000Z",
  deadline: "2026-09-02T00:00:00.000Z",
};

const fence: ErasureFence = {
  erasure_id: "erase-empty-1",
  revision: 1,
  lease_owner: "worker-1",
  lease_generation: 1,
  lease_until_ms: Date.parse("2026-09-02T00:00:00.000Z"),
};

const proofBody = {
  request_digest: "a".repeat(64),
  exact_subject_ref: "source-revision:revision-1",
  location: "Projection",
  root_identity: {
    source_revision_ref: "revision-1",
    source_id: "source-1",
    source_namespace_id: "namespace-1",
    source_owner_system_id: "owner-system-1",
    source_owner_generation: "owner-generation-1",
    owner_incarnation_ref: "incarnation-1",
    ownership_record_revision: "1",
    content_sha256: "b".repeat(64),
    object_residency_key_digest: "c".repeat(64),
  },
  namespace_snapshot: {
    authority_digest: "d".repeat(64),
    namespace_digest: "e".repeat(64),
    namespace_generation: "r2-work-prefix-list.v1",
    namespace_ref: "projection/source-token/",
    object_count: 0,
  },
} as const;

describe("versioned location-empty proofs", () => {
  it("round-trips canonical bytes and binds the target identity to their digest", async () => {
    const target = await createEmptyLocationProofTarget(proofBody);
    await expect(parseEmptyLocationProof(target)).resolves.toEqual(proofBody);
    await expect(parseEmptyLocationProof({ ...target, identity_digest: "f".repeat(64) }))
      .rejects.toMatchObject({ code: "ERASURE_IDENTITY_CONFLICT" });
  });

  it("refuses malformed and truncated proof bytes", async () => {
    const target = await createEmptyLocationProofTarget(proofBody);
    await expect(parseEmptyLocationProof({ ...target, canonical_ref: `${target.canonical_ref.slice(0, -2)}!!` }))
      .rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
    await expect(parseEmptyLocationProof({ ...target, canonical_ref: target.canonical_ref.slice(0, -3) }))
      .rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
  });

  it("does not bind one selected subject to a different source revision root", () => {
    expect(() => assertEmptyProofSubjectRootBinding({
      ...proofBody,
      exact_subject_ref: "source-revision:revision-other",
    })).toThrowError();
  });

  it("enumerates every R2 Work page and refuses cursor loops", async () => {
    const bucket = {
      list: vi.fn()
        .mockResolvedValueOnce({ objects: [{ key: "projection/source-token/a" }], truncated: true, cursor: "next" })
        .mockResolvedValueOnce({ objects: [{ key: "projection/source-token/b" }], truncated: false }),
    } as unknown as R2Bucket;
    await expect(listR2WorkPrefix(bucket, "projection/source-token/"))
      .resolves.toEqual(["projection/source-token/a", "projection/source-token/b"]);
    expect(bucket.list).toHaveBeenCalledTimes(2);

    const stuck = {
      list: vi.fn(async () => ({ objects: [], truncated: true, cursor: "same" })),
    } as unknown as R2Bucket;
    await expect(listR2WorkPrefix(stuck, "projection/source-token/"))
      .rejects.toMatchObject({ code: "ERASURE_SETTLEMENT_UNCERTAIN" });
  });

  it("uses the projection writer's source namespace for the exhaustive scan", async () => {
    const prefix = await projectionWorkPrefix("revision-1");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("source\u0000revision-1"));
    const token = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("").slice(0, 48);
    expect(prefix).toBe(`projection/${token}/`);
  });

  it("revalidates under the fence before closure persistence, purge dispatch and separate absence readback", async () => {
    const target = await createEmptyLocationProofTarget(proofBody);
    const closure = {
      erasure_ref: request.erasure_ref,
      request_digest: "a".repeat(64),
      closure_digest: "b".repeat(64),
      targets: [target],
    };
    const authority = {
      assertFence: vi.fn(async () => undefined),
      persistClosure: vi.fn(async () => undefined),
      advance: vi.fn(async () => undefined),
      recordPurge: vi.fn(async () => undefined),
      recordAbsence: vi.fn(async () => undefined),
    } as unknown as ErasureAuthorityPort;
    const validate = vi.fn(async (_request: ErasureRequest, _fence: ErasureFence, candidate: PurgeTarget) => {
      await parseEmptyLocationProof(candidate);
    });
    const backend = createCloudflareErasureBackend({
      core_database: {} as D1Database,
      authority,
      inventory: { enumerate: vi.fn(async () => closure) } as unknown as ErasureInventoryPort,
      locations: { forLocation: vi.fn(() => null) } as unknown as ErasureLocationRegistry,
      invalidation: {} as ErasureInvalidationPort,
      validateEmptyLocationProof: validate,
    });

    await backend.enumerateDependencyClosure(request, fence);
    const deletion = await backend.purge(request, fence, target);
    const absence = await backend.verifyAbsent(request, fence, target, deletion);
    expect(absence.absent).toBe(true);
    expect(validate).toHaveBeenCalledTimes(3);
    expect(authority.persistClosure).toHaveBeenCalledTimes(1);
  });

  it("does not let the D1 Core adapter treat a direct empty target as absence", async () => {
    const adapter = createD1CoreErasureLocationPort({ database: {} as D1Database });
    const empty: PurgeTarget = {
      target_id: "forged-empty",
      target_kind: "LOCATION_EMPTY_PROOF",
      exact_subject_ref: "source-revision:revision-1",
      location: "CanonicalPayload",
      canonical_ref: "empty-proof:forged",
      identity_digest: "f".repeat(64),
      shared_live_reference_count: 0,
    };
    await expect(adapter.purge(request, fence, empty)).rejects.toMatchObject({
      code: "ERASURE_CLOSURE_INCOMPLETE",
    });
  });
});
