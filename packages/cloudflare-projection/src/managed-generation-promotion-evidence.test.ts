import { describe, expect, it } from "vitest";
import {
  validateManagedGenerationArchiveAuthorization,
  validateManagedGenerationCurrentAuthority,
  MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL,
  MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL,
  MANAGED_TARGET_FENCE_PROTOCOL,
  MANAGED_GENERATION_ARCHIVE_AUTHORIZATION_PROTOCOL,
  MANAGED_GENERATION_CURRENT_AUTHORITY_PROTOCOL,
  MANAGED_GENERATION_PROMOTION_HOLD_PROTOCOL,
  type ManagedGenerationPromotionEvidenceAuthorityPort,
  type ManagedGenerationPromotionEvidenceV2,
  type ManagedGenerationPromotionTarget,
  readManagedGenerationPromotionEvidence,
  validateManagedGenerationDesiredManifest,
  validateManagedGenerationPromotionEvidence,
} from "./managed-generation-promotion-evidence.js";
import { AI_SEARCH_CUSTOM_METADATA_FIELDS } from "./ai-search-profile.js";
import {
  declareAiSearchGeneration,
  qualifyAiSearchGeneration,
  recordAiSearchShadowObservation,
} from "./ai-search-generation.js";
import { createAiSearchGenerationRegistryService } from "./ai-search-generation-registry.js";
import {
  AI_SEARCH_GENERATION_REGISTRY_SCHEMA_V1,
  type AiSearchGenerationRegistryStorePort,
  type AiSearchGenerationRegistrySnapshot,
} from "./ai-search-generation-registry-contract.js";
import {
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
} from "./ai-search-generation-registry-codec.js";
import { projectionDigest } from "./canonical.js";

const target = Object.freeze({
  namespace: "search-main",
  managed_instance_id: "search-instance-b",
  managed_generation: "generation-b",
  target_profile_identity_sha256: "a".repeat(64),
});
const desiredItemSetSha256 = "b".repeat(64);
const requiredSetSha256 = "c".repeat(64);
const fenceSha256 = "d".repeat(64);
const manifestSha256 = "e".repeat(64);

function desiredManifest(
  overrides: Record<string, unknown> = {},
  proofTarget: ManagedGenerationPromotionTarget = target,
) {
  return {
    protocol: MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL,
    target: proofTarget,
    copy_layout: "PROJECT_COPY_V1",
    as_of: "2026-10-14T18:00:00.000Z",
    target_fence: {
      protocol: MANAGED_TARGET_FENCE_PROTOCOL,
      digest: fenceSha256,
      assignment_heads_sha256: "1".repeat(64),
      required_set_sha256: requiredSetSha256,
      page_provenance_sha256: "2".repeat(64),
      assigned_project_count: 1,
      project_revision_copy_count: 0,
      page_count: 1,
    },
    registry_revision_before: 3,
    registry_revision_after: 3,
    assigned_project_count: 1,
    project_revision_copy_count: 0,
    desired_item_count: 0,
    desired_item_set_digest: desiredItemSetSha256,
    eligibility_digest: "3".repeat(64),
    required_set_digest: requiredSetSha256,
    source_authority_digest: "4".repeat(64),
    manifest_ref: "managed-target/root-b.json",
    manifest_sha256: manifestSha256,
    manifest_size_bytes: 512,
    manifest_tree_ref: "managed-target/tree-b.json",
    manifest_tree_sha256: "5".repeat(64),
    ...overrides,
  };
}

function evidence(
  overrides: Record<string, unknown> = {},
  proofTarget: ManagedGenerationPromotionTarget = target,
  manifest = desiredManifest({}, proofTarget),
) {
  const desiredCount = manifest.desired_item_count;
  const desiredSet = manifest.desired_item_set_digest;
  const sourceAuthority = manifest.source_authority_digest;
  const eligibility = manifest.eligibility_digest;
  return {
    protocol: MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL,
    target: proofTarget,
    target_fence: manifest.target_fence,
    manifest: {
      ref: manifest.manifest_ref,
      sha256: manifest.manifest_sha256,
      tree_ref: manifest.manifest_tree_ref,
      tree_sha256: manifest.manifest_tree_sha256,
      required_set_sha256: manifest.required_set_digest,
      desired_item_count: desiredCount,
      desired_item_set_sha256: desiredSet,
      source_authority_sha256: sourceAuthority,
      eligibility_sha256: eligibility,
      watermark_sha256: manifest.target_fence.digest,
    },
    item_readback: {
      required_item_set_sha256: desiredSet,
      item_effect_count: desiredCount,
      item_effect_sha256: "6".repeat(64),
      exact_readback_count: desiredCount,
      exact_readback_sha256: "7".repeat(64),
      provider_inventory_count: desiredCount,
      provider_inventory_item_set_sha256: desiredSet,
      provider_inventory_sha256: "8".repeat(64),
      removal_item_count: 2,
      removal_readback_count: 2,
      removal_item_set_sha256: "9".repeat(64),
      removal_readback_sha256: "a".repeat(64),
    },
    writer_drain: {
      protocol: "eliotr.managed-target-writer-drain.v1",
      target: proofTarget,
      state: "DRAINED",
      watermark_sha256: manifest.target_fence.digest,
      receipt_ref: "writer-drain-b",
      receipt_sha256: "b".repeat(64),
    },
    qualification: {
      protocol: "eliotr.managed-target-t2-t3-qualification.v1",
      disposition: "QUALIFIED",
      target_profile_identity_sha256: proofTarget.target_profile_identity_sha256,
      manifest_sha256: manifest.manifest_sha256,
      current_target_fence_sha256: manifest.target_fence.digest,
      t2_result_ref: "qualification/t2-b",
      t2_result_sha256: "c".repeat(64),
      t3_result_ref: "qualification/t3-b",
      t3_result_sha256: "d".repeat(64),
    },
    built_at: new Date(Date.parse(manifest.as_of) + 60_000).toISOString(),
    verified_at: new Date(Date.parse(manifest.as_of) + 120_000).toISOString(),
    ...overrides,
  };
}

function currentAuthority(
  proof: ManagedGenerationPromotionEvidenceV2,
  proofTarget: ManagedGenerationPromotionTarget = proof.target,
  overrides: Record<string, unknown> = {},
) {
  return {
    protocol: MANAGED_GENERATION_CURRENT_AUTHORITY_PROTOCOL,
    target: proofTarget,
    manifest_sha256: proof.manifest.sha256,
    desired_item_set_sha256: proof.manifest.desired_item_set_sha256,
    source_authority_sha256: proof.manifest.source_authority_sha256,
    current_target_fence_sha256: proof.target_fence.digest,
    checked_at: "2026-10-14T18:03:00.000Z",
    valid_until: "2026-10-14T19:03:00.000Z",
    expired_authorization_count: 0,
    purged_required_item_count: 0,
    unsettled_writer_count: 0,
    disposition: "CURRENT",
    receipt_ref: "current-authority/readback-b",
    receipt_sha256: "9".repeat(64),
    ...overrides,
  };
}

function profileFor(generation: string, id: string) {
  return {
    id,
    generation,
    index_method: { vector: true, keyword: true },
    fusion_method: "rrf" as const,
    keyword_tokenizer: "porter" as const,
    keyword_match_mode: "or" as const,
    embedding_model: "@cf/baai/bge-m3",
    reranking: true,
    max_num_results: 20,
    metadata_fields: [...AI_SEARCH_CUSTOM_METADATA_FIELDS],
  };
}

async function targetForProfile(
  namespace: string,
  profile: ReturnType<typeof profileFor>,
): Promise<ManagedGenerationPromotionTarget> {
  return Object.freeze({
    namespace,
    managed_instance_id: profile.id,
    managed_generation: profile.generation,
    target_profile_identity_sha256: await projectionDigest({
      ...profile,
      index_method: { ...profile.index_method },
      metadata_fields: [...profile.metadata_fields].sort(),
    }),
  });
}

class MemoryRegistryStore implements AiSearchGenerationRegistryStorePort {
  public snapshot: AiSearchGenerationRegistrySnapshot | null = null;
  public writes = 0;

  public constructor(private readonly isWriterHoldActive: () => boolean = () => false) {}

  public async read(namespace: string): Promise<unknown | null> {
    if (this.snapshot?.artifact.namespace !== namespace) return null;
    return JSON.parse(JSON.stringify(this.snapshot)) as AiSearchGenerationRegistrySnapshot;
  }

  public async compareAndSwap(command: Parameters<AiSearchGenerationRegistryStorePort["compareAndSwap"]>[0]): Promise<unknown> {
    if (
      command.operation === "QUALIFY" ||
      command.operation === "PROMOTE" ||
      command.operation === "ROLLBACK"
    ) {
      expect(this.isWriterHoldActive()).toBe(true);
    }
    const revision = this.snapshot?.artifact.revision ?? null;
    const sha256 = this.snapshot?.artifact_sha256 ?? null;
    if (revision !== command.expected_revision || sha256 !== command.expected_artifact_sha256) {
      return {
        outcome: "CONFLICT",
        namespace: this.snapshot?.artifact.namespace ?? command.namespace,
        revision: this.snapshot?.artifact.revision ?? command.artifact.revision,
        artifact_sha256: this.snapshot?.artifact_sha256 ?? command.artifact_sha256,
        transition_sha256: null,
      };
    }
    this.snapshot = JSON.parse(JSON.stringify({
      artifact: command.artifact,
      artifact_sha256: command.artifact_sha256,
    })) as AiSearchGenerationRegistrySnapshot;
    this.writes += 1;
    return {
      outcome: "APPLIED",
      namespace: command.namespace,
      revision: command.artifact.revision,
      artifact_sha256: command.artifact_sha256,
      transition_sha256: "e".repeat(64),
    };
  }
}

function promotionAuthority() {
  const state = {
    hold_active: false,
    change_fence_on_next_hold: null as string | null,
    fence_overrides: new Map<string, string>(),
    holds: 0,
    releases: 0,
  };
  const authority: ManagedGenerationPromotionEvidenceAuthorityPort = {
    async readDesiredManifest(proofTarget) {
      return desiredManifest({}, proofTarget);
    },
    async readCurrentEvidence(proofTarget) {
      return evidence({}, proofTarget, desiredManifest({}, proofTarget));
    },
    async readFreshCurrentAuthority(proofTarget, proof) {
      return currentAuthority(proof, proofTarget, {
        current_target_fence_sha256:
          state.fence_overrides.get(proofTarget.managed_generation) ?? proof.target_fence.digest,
      });
    },
    async runWithTargetWriterDrain(request, commit) {
      state.holds += 1;
      state.hold_active = true;
      const base = Object.freeze({
        protocol: MANAGED_GENERATION_PROMOTION_HOLD_PROTOCOL,
        operation_id: request.operation_id,
        operation: request.operation,
        state: "HELD" as const,
        held_at: "2026-10-14T18:03:00.000Z",
        targets: Object.freeze(request.targets.map((item, index) => Object.freeze({
          target: item.target,
          target_fence_sha256: item.target_fence_sha256 ?? fenceSha256,
          writer_epoch: `writer-epoch-${index}`,
          outstanding_writer_count: 0 as const,
          receipt_ref: `writer-drain/${item.target.managed_generation}`,
          receipt_sha256: "8".repeat(64),
        }))),
      });
      const hold = Object.freeze({ ...base, hold_sha256: await projectionDigest(base) });
      if (state.change_fence_on_next_hold !== null) {
        state.fence_overrides.set(state.change_fence_on_next_hold, "f".repeat(64));
        state.change_fence_on_next_hold = null;
      }
      try {
        return await commit(hold);
      } finally {
        state.hold_active = false;
        state.releases += 1;
      }
    },
    async assertTargetWriterDrainHold() {
      if (!state.hold_active) throw new Error("writer hold is not active");
    },
    async reconcileTargetWriterDrain() {},
    async readGenerationArchiveAuthorization(input) {
      return {
        protocol: MANAGED_GENERATION_ARCHIVE_AUTHORIZATION_PROTOCOL,
        ...input,
        rollback_window_closed_at: "2026-10-14T18:00:00.000Z",
        trusted_checked_at: "2026-10-14T18:03:00.000Z",
        valid_until: "2026-10-14T19:03:00.000Z",
        backup_ref: `registry-archive/${input.target.managed_generation}`,
        backup_sha256: input.generation_record_sha256,
        backup_readback_sha256: input.generation_record_sha256,
        disposition: "ARCHIVE_AUTHORIZED",
      };
    },
  };
  return { authority, state };
}

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
    const profileA = profileFor("generation-a", "search-instance-a");
    const targetA = await targetForProfile("search-main", profileA);
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

    const profileC = profileFor("generation-c", "search-instance-c");
    await service.declare({ namespace: "search-main", profile: profileC, declared_at: "2026-10-14T18:00:00.000Z" });
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
