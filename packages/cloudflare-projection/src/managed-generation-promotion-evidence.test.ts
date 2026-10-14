import { describe, expect, it } from "vitest";
import {
  validateManagedGenerationArchiveAuthorization,
  validateManagedGenerationCurrentAuthority,
  MANAGED_GENERATION_ARCHIVE_AUTHORIZATION_PROTOCOL,
  readManagedGenerationPromotionEvidence,
  validateManagedGenerationDesiredManifest,
  validateManagedGenerationPromotionEvidence,
} from "./managed-generation-promotion-evidence.js";
import {
  declareAiSearchGeneration,
  qualifyAiSearchGeneration,
  recordAiSearchShadowObservation,
} from "./ai-search-generation.js";
import { createAiSearchGenerationRegistryService } from "./ai-search-generation-registry.js";
import {
  AI_SEARCH_GENERATION_REGISTRY_SCHEMA_V1,
} from "./ai-search-generation-registry-contract.js";
import {
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
} from "./ai-search-generation-registry-codec.js";
const target = Object.freeze({
  namespace: "search-main",
  managed_instance_id: "search-instance-b",
  managed_generation: "generation-b",
  target_profile_identity_sha256: "a".repeat(64),
});
const fenceSha256 = "d".repeat(64);

import { desiredManifest, evidence, currentAuthority, profileFor, targetForProfile, MemoryRegistryStore, promotionAuthority } from "./managed-generation-promotion-evidence.test-support.js";

describe("managed generation promotion evidence v2", () => {
  it("qualifies an assigned empty target only with exact empty inventory and deletion readbacks", async () => {
    const manifest = validateManagedGenerationDesiredManifest(desiredManifest(), target);
    const proof = await validateManagedGenerationPromotionEvidence(evidence(), target);
    expect(manifest.assigned_project_count).toBe(1);
    expect(manifest.project_revision_copy_count).toBe(0);
    expect(manifest.desired_item_count).toBe(0);
    expect(proof.item_readback.provider_inventory_count).toBe(0);
    expect(proof.item_readback.removal_readback_count).toBe(2);
    expect(proof.evidence_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a zero denominator without an assigned project or with a provider item", async () => {
    expect(() => validateManagedGenerationDesiredManifest(
      desiredManifest({ assigned_project_count: 0 }),
      target,
    )).toThrow(/assigned_project_count/u);
    await expect(validateManagedGenerationPromotionEvidence(evidence({
      item_readback: {
        ...evidence().item_readback,
        provider_inventory_count: 1,
      },
    }), target)).rejects.toThrow(/complete desired item set/u);
  });

  it("rejects unfinished deletions, foreign inventory identities, and incomplete exact readback", async () => {
    await expect(validateManagedGenerationPromotionEvidence(evidence({
      item_readback: {
        ...evidence().item_readback,
        removal_readback_count: 1,
      },
    }), target)).rejects.toThrow(/complete desired item set/u);
    await expect(validateManagedGenerationPromotionEvidence(evidence({
      item_readback: {
        ...evidence().item_readback,
        provider_inventory_item_set_sha256: "f".repeat(64),
      },
    }), target)).rejects.toThrow(/complete desired item set/u);
    await expect(validateManagedGenerationPromotionEvidence(evidence({
      item_readback: {
        ...evidence().item_readback,
        exact_readback_count: 1,
      },
    }), target)).rejects.toThrow(/complete desired item set/u);
  });

  it("rejects changed target fences and missing or foreign T2/T3 qualification", async () => {
    await expect(validateManagedGenerationPromotionEvidence(evidence({
      writer_drain: {
        ...evidence().writer_drain,
        watermark_sha256: "f".repeat(64),
      },
    }), target)).rejects.toThrow(/writer drain/u);
    await expect(validateManagedGenerationPromotionEvidence(evidence({
      qualification: {
        ...evidence().qualification,
        disposition: "PENDING",
      },
    }), target)).rejects.toThrow(/T2\/T3/u);
    await expect(validateManagedGenerationPromotionEvidence(evidence(), {
      ...target,
      managed_generation: "another-generation",
    })).rejects.toThrow(/another target/u);
    await expect(validateManagedGenerationPromotionEvidence(evidence(), {
      ...target,
      target_profile_identity_sha256: "f".repeat(64),
    })).rejects.toThrow(/another target/u);
  });

  it("keeps caller counters as progress only and qualifies zero only from exact evidence", async () => {
    const declared = declareAiSearchGeneration([], {
      namespace: target.namespace,
      profile: profileFor(target.managed_generation, target.managed_instance_id),
      expected_item_count: 0,
      declared_at: "2026-10-14T18:00:00.000Z",
    });
    expect(() => recordAiSearchShadowObservation(declared, {
      generation: target.managed_generation,
      indexed_item_count: 0,
      readback_item_count: 0,
      failed_item_count: 0,
      mismatch_count: 0,
      observed_at: "2026-10-14T18:01:00.000Z",
      golden_set_result_ref: "operator-asserted-golden-ref",
    } as never)).toThrow(/fields are not exact/u);
    expect(() => recordAiSearchShadowObservation(declared, {
      generation: target.managed_generation,
      indexed_item_count: 1,
      readback_item_count: 1,
      failed_item_count: 0,
      mismatch_count: 0,
      observed_at: "2026-10-14T18:01:00.000Z",
    })).toThrow(/declared bounds/u);

    const transient = recordAiSearchShadowObservation(declared, {
      generation: target.managed_generation,
      indexed_item_count: 0,
      readback_item_count: 0,
      failed_item_count: 1,
      mismatch_count: 0,
      observed_at: "2026-10-14T18:01:00.000Z",
    });
    expect(transient.state).toBe("SHADOW_BUILDING");
    expect(transient.failed_item_count).toBe(1);
    const qualified = qualifyAiSearchGeneration(
      transient,
      await validateManagedGenerationPromotionEvidence(evidence(), target),
    );
    expect(qualified.state).toBe("SHADOW_COMPLETE");
    expect(qualified.expected_item_count).toBe(0);
    expect(qualified.failed_item_count).toBe(0);
    expect(qualified.promotion_evidence_v2?.item_readback.provider_inventory_count).toBe(0);
  });

  it("obtains evidence only through the authoritative readback port", async () => {
    let reads = 0;
    const authority = {
      async readDesiredManifest() {
        return desiredManifest();
      },
      async readCurrentEvidence() {
        reads += 1;
        return evidence();
      },
      async readFreshCurrentAuthority() {
        throw new Error("fresh currentness is not exercised by this readback test");
      },
      async runWithTargetWriterDrain<_T>() {
        throw new Error("writer drain is not exercised by this readback test");
      },
      async assertTargetWriterDrainHold() {},
      async reconcileTargetWriterDrain() {},
      async readGenerationArchiveAuthorization() {
        throw new Error("archive authorization is not exercised by this readback test");
      },
    };
    const result = await readManagedGenerationPromotionEvidence(authority, target);
    expect(reads).toBe(1);
    expect(result.manifest.desired_item_count).toBe(0);
    expect(result.item_readback.removal_readback_count).toBe(2);
  });

  it("requires fresh trusted-time authority to match the exact manifest fence", async () => {
    const proof = await validateManagedGenerationPromotionEvidence(evidence(), target);
    expect(validateManagedGenerationCurrentAuthority(
      currentAuthority(proof),
      target,
      proof,
    ).current_target_fence_sha256).toBe(fenceSha256);

    expect(() => validateManagedGenerationCurrentAuthority(
      currentAuthority(proof, target, {
        current_target_fence_sha256: "f".repeat(64),
      }),
      target,
      proof,
    )).toThrow(/fresh trusted-time authority/u);
    expect(() => validateManagedGenerationCurrentAuthority(
      currentAuthority(proof, target, {
        valid_until: "2026-10-14T18:03:00.000Z",
      }),
      target,
      proof,
    )).toThrow(/fresh trusted-time authority/u);
    expect(() => validateManagedGenerationCurrentAuthority(
      currentAuthority(proof, target, {
        checked_at: "2026-10-14T18:01:00.000Z",
      }),
      target,
      proof,
    )).toThrow(/fresh trusted-time authority/u);
    expect(() => validateManagedGenerationCurrentAuthority(
      currentAuthority(proof, target, {
        expired_authorization_count: 1,
      }),
      target,
      proof,
    )).toThrow(/fresh trusted-time authority/u);
  });

  it("requires an exact closed rollback window and backup readback before archive", () => {
    const request = {
      target,
      registry_revision: 7,
      registry_artifact_sha256: "1".repeat(64),
      generation_record_sha256: "2".repeat(64),
    };
    const authorization = {
      protocol: MANAGED_GENERATION_ARCHIVE_AUTHORIZATION_PROTOCOL,
      ...request,
      rollback_window_closed_at: "2026-10-14T18:00:00.000Z",
      trusted_checked_at: "2026-10-14T18:03:00.000Z",
      valid_until: "2026-10-14T19:03:00.000Z",
      backup_ref: "registry-archive/generation-b",
      backup_sha256: request.generation_record_sha256,
      backup_readback_sha256: request.generation_record_sha256,
      disposition: "ARCHIVE_AUTHORIZED",
    };
    expect(validateManagedGenerationArchiveAuthorization(authorization, request))
      .toMatchObject({ disposition: "ARCHIVE_AUTHORIZED" });
    expect(() => validateManagedGenerationArchiveAuthorization({
      ...authorization,
      backup_readback_sha256: "3".repeat(64),
    }, request)).toThrow(/exact archive backup readback/u);
    expect(() => validateManagedGenerationArchiveAuthorization({
      ...authorization,
      trusted_checked_at: "2026-10-14T17:59:00.000Z",
    }, request)).toThrow(/exact archive backup readback/u);
  });

  it("keeps A rollbackable through B promotion and fences rollback if current authority changes", async () => {
    const authorityFixture = promotionAuthority();
    const store = new MemoryRegistryStore(() => authorityFixture.state.hold_active);
    const service = createAiSearchGenerationRegistryService(store, {
      promotion_evidence: authorityFixture.authority,
    });
    const profileA = profileFor("physical-profile-v2", "search-instance-a");
    const targetA = await targetForProfile("search-main", profileA, "generation-a");
    const profileB = profileFor("legacy-profile-generation-b", "search-instance-a");

    await service.declare({ namespace: "search-main", generation: "generation-a", profile: profileA, declared_at: "2026-10-14T18:00:00.000Z" });
    await service.qualify("search-main", { generation: "generation-a" });
    await service.promote("search-main", {
      expected_active_head_generation: null,
      target_generation: "generation-a",
      promoted_at: "2026-10-14T18:04:00.000Z",
    });

    const writesBeforeIncompatibleProfile = store.writes;
    await expect(service.declare({
      namespace: "search-main",
      generation: "generation-b",
      profile: { ...profileB, embedding_model: "incompatible-embedding-model" },
      declared_at: "2026-10-14T18:00:00.000Z",
    })).rejects.toMatchObject({ code: "AI_SEARCH_PROFILE_IMMUTABLE_MISMATCH" });
    expect(store.writes).toBe(writesBeforeIncompatibleProfile);

    await service.declare({ namespace: "search-main", generation: "generation-b", profile: profileB, declared_at: "2026-10-14T18:00:00.000Z" });
    await service.qualify("search-main", { generation: "generation-b" });
    await service.promote("search-main", {
      expected_active_head_generation: "generation-a",
      target_generation: "generation-b",
      promoted_at: "2026-10-14T18:05:00.000Z",
    });
    expect(store.snapshot?.artifact.registry.active_head_generation).toBe("generation-b");
    expect(store.snapshot?.artifact.registry.generations.find((item) => item.generation === "generation-a")?.state)
      .toBe("INACTIVE_QUALIFIED");

    const writesBeforeStaleHead = store.writes;
    await expect(service.rollback("search-main", {
      expected_active_head_generation: "generation-a",
      target_generation: "generation-a",
      rolled_back_at: "2026-10-14T18:05:30.000Z",
    })).rejects.toMatchObject({ code: "AI_SEARCH_ACTIVE_HEAD_CONFLICT" });
    expect(store.writes).toBe(writesBeforeStaleHead);

    const profileC = {
      ...profileFor("generation-c", "search-instance-c"),
      embedding_model: "incompatible-embedding-model",
    };
    await service.declare({
      namespace: "search-main",
      generation: "generation-c",
      profile: profileC,
      declared_at: "2026-10-14T18:00:00.000Z",
    });
    const writesBeforeUnqualifiedRollback = store.writes;
    await expect(service.rollback("search-main", {
      expected_active_head_generation: "generation-b",
      target_generation: "generation-c",
      rolled_back_at: "2026-10-14T18:05:45.000Z",
    })).rejects.toMatchObject({ code: "AI_SEARCH_REGISTRY_EVIDENCE_UNAVAILABLE" });
    expect(store.writes).toBe(writesBeforeUnqualifiedRollback);

    const writesBeforeStaleRollback = store.writes;
    authorityFixture.state.change_fence_on_next_hold = targetA.managed_generation;
    await expect(service.rollback("search-main", {
      expected_active_head_generation: "generation-b",
      target_generation: "generation-a",
      rolled_back_at: "2026-10-14T18:06:00.000Z",
    })).rejects.toMatchObject({ code: "MANAGED_GENERATION_EVIDENCE_STALE" });
    expect(store.writes).toBe(writesBeforeStaleRollback);
    expect(store.snapshot?.artifact.registry.active_head_generation).toBe("generation-b");

    authorityFixture.state.fence_overrides.delete(targetA.managed_generation);
    await service.rollback("search-main", {
      expected_active_head_generation: "generation-b",
      target_generation: "generation-a",
      rolled_back_at: "2026-10-14T18:07:00.000Z",
    });
    expect(store.snapshot?.artifact.registry.active_head_generation).toBe("generation-a");
    expect(store.snapshot?.artifact.registry.generations.find((item) => item.generation === "generation-a")?.state)
      .toBe("ACTIVE");
    expect(store.snapshot?.artifact.registry.generations.find((item) => item.generation === "generation-b")?.state)
      .toBe("INACTIVE_QUALIFIED");
    expect(authorityFixture.state.hold_active).toBe(false);
    expect(authorityFixture.state.holds).toBe(authorityFixture.state.releases);
  });

  it("archives one inactive generation only after exact authority approval and backup readback", async () => {
    const authorityFixture = promotionAuthority();
    const store = new MemoryRegistryStore(() => authorityFixture.state.hold_active);
    const service = createAiSearchGenerationRegistryService(store, {
      promotion_evidence: authorityFixture.authority,
    });
    const profileA = profileFor("generation-a", "search-instance-a");
    const profileB = profileFor("generation-b", "search-instance-b");
    await service.declare({ namespace: "search-main", profile: profileA, declared_at: "2026-10-14T18:00:00.000Z" });
    await service.qualify("search-main", { generation: "generation-a" });
    await service.promote("search-main", {
      expected_active_head_generation: null,
      target_generation: "generation-a",
      promoted_at: "2026-10-14T18:04:00.000Z",
    });
    await service.declare({ namespace: "search-main", profile: profileB, declared_at: "2026-10-14T18:00:00.000Z" });
    await service.qualify("search-main", { generation: "generation-b" });
    await service.promote("search-main", {
      expected_active_head_generation: "generation-a",
      target_generation: "generation-b",
      promoted_at: "2026-10-14T18:05:00.000Z",
    });

    const archived = await service.archive("search-main", { generation: "generation-a" });
    expect(archived).toMatchObject({ operation: "ARCHIVE", generation: "generation-a" });
    expect(store.snapshot?.artifact.registry.active_head_generation).toBe("generation-b");
    expect(store.snapshot?.artifact.registry.generations.map((item) => item.generation)).toEqual(["generation-b"]);
  });

  it("requires explicit archive before a 65th declaration and admits one after the audit-backed removal", async () => {
    const authorityFixture = promotionAuthority();
    const store = new MemoryRegistryStore(() => authorityFixture.state.hold_active);
    const records = Array.from({ length: 64 }, (_, index) => {
      const suffix = String(index).padStart(2, "0");
      return {
        namespace: "search-main",
        generation: `generation-${suffix}`,
        profile: profileFor(`generation-${suffix}`, `search-instance-${suffix}`),
        state: index === 0 ? "INACTIVE_UNQUALIFIED" as const : "DECLARED" as const,
        expected_item_count: 0,
        indexed_item_count: 0,
        readback_item_count: 0,
        failed_item_count: 0,
        mismatch_count: 0,
        declared_at: "2026-10-14T18:00:00.000Z",
        ...(index === 0 ? { inactive_at: "2026-10-14T18:01:00.000Z" } : {}),
      };
    });
    const artifact = buildAiSearchGenerationRegistryArtifact("search-main", 64, {
      active_head_generation: null,
      generations: records,
    });
    store.snapshot = {
      artifact,
      artifact_sha256: await aiSearchGenerationRegistryArtifactDigest(artifact),
    };
    const service = createAiSearchGenerationRegistryService(store, {
      promotion_evidence: authorityFixture.authority,
    });
    const nextProfile = profileFor("generation-64", "search-instance-64");

    await expect(service.declare({
      namespace: "search-main",
      profile: nextProfile,
      declared_at: "2026-10-14T18:02:00.000Z",
    })).rejects.toMatchObject({ code: "AI_SEARCH_REGISTRY_INPUT_INVALID" });
    expect(store.writes).toBe(0);

    await service.archive("search-main", { generation: "generation-00" });
    expect(store.snapshot?.artifact.registry.generations).toHaveLength(63);
    await service.declare({
      namespace: "search-main",
      profile: nextProfile,
      declared_at: "2026-10-14T18:02:00.000Z",
    });
    expect(store.snapshot?.artifact.registry.generations).toHaveLength(64);
    expect(store.writes).toBe(2);
  });

  it("fails closed when promotion or declaration lacks the evidence producer", async () => {
    const store = new MemoryRegistryStore();
    const service = createAiSearchGenerationRegistryService(store);
    await expect(service.declare({
      namespace: "search-main",
      profile: profileFor("generation-a", "search-instance-a"),
      declared_at: "2026-10-14T18:00:00.000Z",
    })).rejects.toMatchObject({ code: "AI_SEARCH_REGISTRY_EVIDENCE_UNAVAILABLE" });
    expect(store.writes).toBe(0);

    const legacyRecord = {
      namespace: "search-main",
      generation: "generation-a",
      profile: profileFor("generation-a", "search-instance-a"),
      state: "SHADOW_COMPLETE" as const,
      expected_item_count: 1,
      indexed_item_count: 1,
      readback_item_count: 1,
      failed_item_count: 0,
      mismatch_count: 0,
      golden_set_result_ref: "unverified-golden-ref",
      declared_at: "2026-10-14T18:00:00.000Z",
      observed_at: "2026-10-14T18:01:00.000Z",
    };
    const artifact = buildAiSearchGenerationRegistryArtifact("search-main", 1, {
      active_head_generation: null,
      generations: [legacyRecord],
    }, AI_SEARCH_GENERATION_REGISTRY_SCHEMA_V1);
    store.snapshot = {
      artifact,
      artifact_sha256: await aiSearchGenerationRegistryArtifactDigest(artifact),
    };
    await expect(service.promote("search-main", {
      expected_active_head_generation: null,
      target_generation: "generation-a",
      promoted_at: "2026-10-14T18:04:00.000Z",
    })).rejects.toMatchObject({ code: "AI_SEARCH_REGISTRY_EVIDENCE_UNAVAILABLE" });
    expect(store.writes).toBe(0);
  });
});
