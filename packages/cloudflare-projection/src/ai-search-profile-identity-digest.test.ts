import { describe, expect, it } from "vitest";
import { AI_SEARCH_PRIMARY_PROJECTION_PROFILE as profile } from "./ai-search-primary-profile.js";
import { canonicalAiSearchPhysicalProfile } from "./ai-search-generation-profile-identity.js";
import { aiSearchPhysicalProfileDigest, matchAiSearchProfileIdentity } from "./ai-search-profile-identity-digest.js";
import { projectionDigest } from "./canonical.js";

describe("physical profile digest and exact historical compatibility", () => {
  it("uses the registry digest across compatible corpus-label rotation", async () => {
    const digest = await aiSearchPhysicalProfileDigest(profile);
    expect(digest).toBe(await projectionDigest(canonicalAiSearchPhysicalProfile(profile)));
    expect(await matchAiSearchProfileIdentity({ ...profile, generation: "corpus-b" }, digest)).toBe("PHYSICAL_V1");
  });

  it("recognizes a legacy full-profile digest only with its original label", async () => {
    const legacy = await projectionDigest({ ...profile, index_method: { ...profile.index_method },
      metadata_fields: [...profile.metadata_fields].sort() });
    expect(await matchAiSearchProfileIdentity(profile, legacy)).toBe("LEGACY_GENERATION_V1");
    expect(await matchAiSearchProfileIdentity({ ...profile, generation: "corpus-b" }, legacy)).toBeNull();
    expect(legacy).not.toBe(await aiSearchPhysicalProfileDigest(profile));
  });

  it("rejects incompatible embedding profiles and unrecognized digests", async () => {
    const physical = await aiSearchPhysicalProfileDigest(profile);
    expect(await matchAiSearchProfileIdentity({ ...profile, embedding_model: "other/model" }, physical)).toBeNull();
    expect(await matchAiSearchProfileIdentity(profile, "a".repeat(64))).toBeNull();
    expect(await matchAiSearchProfileIdentity(profile, "unknown")).toBeNull();
  });
});
