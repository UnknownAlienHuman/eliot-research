import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";
import { projectionDigest } from "./canonical.js";
import { canonicalAiSearchPhysicalProfile } from "./ai-search-generation-profile-identity.js";

export type AiSearchProfileIdentityProtocol = "PHYSICAL_V1" | "LEGACY_GENERATION_V1";

/** The same physical identity used by the reviewed registry; never includes the corpus label. */
export function aiSearchPhysicalProfileDigest(profile: AiSearchInstanceProfile): Promise<string> {
  return projectionDigest(canonicalAiSearchPhysicalProfile(profile));
}

/**
 * Recognizes exact historical bytes without converting the pinned digest. A caller that accepts
 * LEGACY_GENERATION_V1 must also require the logical generation to equal profile.generation.
 * Unknown hashes and incompatible profiles cannot acquire either identity.
 */
export async function matchAiSearchProfileIdentity(
  profile: AiSearchInstanceProfile,
  expected: string,
): Promise<AiSearchProfileIdentityProtocol | null> {
  if (!/^[a-f0-9]{64}$/u.test(expected)) return null;
  if (expected === await aiSearchPhysicalProfileDigest(profile)) return "PHYSICAL_V1";
  const legacyProfile = {
    ...profile,
    index_method: { ...profile.index_method },
    metadata_fields: [...profile.metadata_fields].sort(),
  };
  return expected === await projectionDigest(legacyProfile) ? "LEGACY_GENERATION_V1" : null;
}
