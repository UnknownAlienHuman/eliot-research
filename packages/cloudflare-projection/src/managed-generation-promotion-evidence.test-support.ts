import { expect } from "vitest";
import {
  MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL,
  MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL,
  MANAGED_TARGET_FENCE_PROTOCOL,
  MANAGED_GENERATION_ARCHIVE_AUTHORIZATION_PROTOCOL,
  MANAGED_GENERATION_CURRENT_AUTHORITY_PROTOCOL,
  MANAGED_GENERATION_PROMOTION_HOLD_PROTOCOL,
  type ManagedGenerationPromotionEvidenceAuthorityPort,
  type ManagedGenerationPromotionEvidence,
  type ManagedGenerationPromotionTarget,
} from "./managed-generation-promotion-evidence.js";
import { AI_SEARCH_CUSTOM_METADATA_FIELDS } from "./ai-search-profile.js";
import {
  type AiSearchGenerationRegistryStorePort,
  type AiSearchGenerationRegistrySnapshot,
} from "./ai-search-generation-registry-contract.js";
import { projectionDigest } from "./canonical.js";
import { canonicalAiSearchPhysicalProfile } from "./ai-search-generation-profile-identity.js";

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
  proof: ManagedGenerationPromotionEvidence,
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
  generation = profile.generation,
): Promise<ManagedGenerationPromotionTarget> {
  return Object.freeze({
    namespace,
    managed_instance_id: profile.id,
    managed_generation: generation,
    target_profile_identity_sha256: await projectionDigest(
      canonicalAiSearchPhysicalProfile(profile),
    ),
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


export { desiredManifest, evidence, currentAuthority, profileFor, targetForProfile, MemoryRegistryStore, promotionAuthority };
