import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";
import {
  aiSearchPhysicalProfileDigest,
  ManagedTargetManifestError,
  type AiSearchGenerationRegistrySnapshot,
  type ManagedTargetIdentity,
  type ManagedTargetManifestShadowFence,
} from "@eliotr/cloudflare-projection";

function registryFailure(
  code: ConstructorParameters<typeof ManagedTargetManifestError>[0],
  message: string,
  cause?: unknown,
): never {
  throw new ManagedTargetManifestError(code, message, cause);
}
export async function registryFence(
  snapshot: AiSearchGenerationRegistrySnapshot | null,
  target: ManagedTargetIdentity,
  targetProfile: AiSearchInstanceProfile,
): Promise<ManagedTargetManifestShadowFence> {
  if (snapshot === null) {
    return Object.freeze({
      registry_revision: null,
      registry_sha256: null,
      active_head_generation: null,
      generation_state: "UNDECLARED",
      generation_profile_identity_sha256: null,
      expected_item_count: null,
    });
  }
  const registry = snapshot.artifact.registry;
  const record = registry.generations.find((entry) => entry.generation === target.managed_generation);
  if (record === undefined) {
    return Object.freeze({
      registry_revision: snapshot.artifact.revision,
      registry_sha256: snapshot.artifact_sha256,
      active_head_generation: registry.active_head_generation,
      generation_state: "UNDECLARED",
      generation_profile_identity_sha256: null,
      expected_item_count: null,
    });
  }
  if (record.profile.id !== target.managed_instance_id || record.generation !== target.managed_generation) {
    registryFailure("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "SEARCH_DB logical generation differs from the assigned target");
  }
  let registryPhysicalProfileSha256: string;
  let targetPhysicalProfileSha256: string;
  try {
    [registryPhysicalProfileSha256, targetPhysicalProfileSha256] = await Promise.all([
      aiSearchPhysicalProfileDigest(record.profile),
      aiSearchPhysicalProfileDigest(targetProfile),
    ]);
  } catch (cause) {
    registryFailure("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "SEARCH_DB physical profile could not be identified", cause);
  }
  if (registryPhysicalProfileSha256 !== targetPhysicalProfileSha256) {
    registryFailure("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "SEARCH_DB physical index settings differ from the assigned immutable profile");
  }
  return Object.freeze({
    registry_revision: snapshot.artifact.revision,
    registry_sha256: snapshot.artifact_sha256,
    active_head_generation: registry.active_head_generation,
    generation_state: record.state,
    generation_profile_identity_sha256: registryPhysicalProfileSha256,
    expected_item_count: record.expected_item_count,
  });
}

/**
 * Core/R2 composition used by the future shared builder and promoter caller.
 * This entry point performs reads and immutable Work-R2 staging only. Search
 * registry CAS, item upload/readback, operator selection, and promotion remain
 * with their current owners.
 */
