import { describe, expect, it } from "vitest";
import type { RetrievalRequest } from "@eliotr/retrieval";
import { createManagedProjectProviderKeyV2 } from "../../cloudflare-projection/src/managed-project-path.js";
import {
  AiSearchLocatorDecodeError,
  decodeAiSearchSearchResult,
  type AiSearchExpectedProjectCopy,
  type AiSearchExpectedProjectCopyV2,
  type AiSearchLocatorDecodeOptions,
} from "./ai-search.js";

const generationDigest = "a".repeat(64);
const itemKey = `projection-${"b".repeat(48)}`;
const stableIdentity = {
  instance_id: "instance-2",
  projection_generation: "managed-generation-2",
  source_revision_ref: "revision-stable",
  project_id: "project-stable",
  stable_project_membership_id: `project-membership-${"c".repeat(48)}`,
  membership_revision: 2,
} as const;
const stableProviderKey = await createManagedProjectProviderKeyV2({ ...stableIdentity, item_key: itemKey });
const stableCopy = {
  source_revision_ref: stableIdentity.source_revision_ref,
  source_owner_generation: "owner-stable",
  project_id: stableIdentity.project_id,
  project_membership_id: stableIdentity.stable_project_membership_id,
  membership_generation: 3,
  folder_prefix: stableProviderKey.folder_prefix,
  membership_identity_version: 2,
  stable_project_membership_id: stableIdentity.stable_project_membership_id,
  membership_revision: stableIdentity.membership_revision,
  project_membership_generation: 9,
} as const satisfies AiSearchExpectedProjectCopyV2;
const v1Copy = {
  source_revision_ref: "revision-legacy",
  source_owner_generation: "owner-legacy",
  project_id: "project-legacy",
  project_membership_id: "project:project-legacy:generation:4",
  membership_generation: 4,
  folder_prefix: `projection/${"e".repeat(43)}/`,
} as const satisfies AiSearchExpectedProjectCopy;
const legacyCopy = {
  ...v1Copy,
  membership_identity_version: 1,
  legacy_project_membership_id: v1Copy.project_membership_id,
} as const satisfies AiSearchExpectedProjectCopyV2;

function request(copies: readonly AiSearchExpectedProjectCopy[] = [stableCopy, legacyCopy]): RetrievalRequest {
  return {
    raw_query: "needle", product: "LOCATE", literals: [], requested_limit: 2, deadline_ms: 1000,
    scope_snapshot: {
      snapshot_id: "scope-1", revision: 1,
      resolved_scope_expression: { kind: "PROJECT", project_id: "project-stable" },
      participant_generations: {},
      member_source_revision_refs: copies.map(copy => copy.source_revision_ref),
      source_owner_generations: Object.fromEntries(copies.map(copy => [copy.source_revision_ref, copy.source_owner_generation])),
      policy_authority_ref: "policy-1", disclosure_closure_digest: "f".repeat(64),
      purge_ledger_revision: 0, digest: "1".repeat(64),
      created_at: "2026-10-14T00:00:00.000Z", expires_at: "2026-10-15T00:00:00.000Z",
    },
  };
}

type V2Options = Extract<AiSearchLocatorDecodeOptions, { readonly project_copy_layout: "PROJECT_COPY_V2" }>;
function options(overrides: Partial<V2Options> = {}): V2Options {
  return {
    project_copy_layout: "PROJECT_COPY_V2", expected_index_generation: "managed-generation-2",
    expected_generation_metadata_value: generationDigest, expected_project_copies: [stableCopy, legacyCopy],
    requested_lanes: ["SEM"], max_results: 2, max_preview_bytes: 1024,
    ...overrides,
  };
}

function chunk(copy: AiSearchExpectedProjectCopy, id = "chunk-stable") {
  return {
    id, type: "text", score: 0.9, text: "provider preview",
    item: {
      key: `${copy.folder_prefix}${itemKey}.md`,
      metadata: {
        canonical_section_id: "section-1", content_sha256: "2".repeat(64), instruction_taint: "DATA_ONLY",
        projection_generation: generationDigest, source_revision_ref: copy.source_revision_ref,
      },
    },
  };
}

function result(chunks: readonly unknown[] = [chunk(stableCopy)]) {
  return { query_kind: "text", search_query: "needle", chunks };
}

function malformedCopies(copies: readonly unknown[]): AiSearchLocatorDecodeOptions {
  return options({ expected_project_copies: copies as readonly AiSearchExpectedProjectCopyV2[] });
}

describe("versioned AI Search provider locator decoder", () => {
  it("accepts one stable V2 and one retained V1 row in a V2 scope without deriving folders or IDs", () => {
    expect(chunk(stableCopy).item.key).toBe(stableProviderKey.provider_key);
    const candidates = decodeAiSearchSearchResult(request(), result([
      chunk(stableCopy), chunk(legacyCopy, "chunk-legacy"),
    ]), options());
    expect(candidates.map(candidate => candidate.metadata.provider_project_membership_id))
      .toEqual([stableCopy.project_membership_id, legacyCopy.project_membership_id]);
    expect(candidates.map(candidate => candidate.metadata.provider_project_folder))
      .toEqual([stableCopy.folder_prefix, legacyCopy.folder_prefix]);
    expect(candidates.map(candidate => candidate.metadata.item_key)).toEqual([itemKey, itemKey]);
    expect(candidates.map(candidate => candidate.proof_state)).toEqual(["UNRESOLVED_LOCATOR", "UNRESOLVED_LOCATOR"]);
    expect(candidates[0]?.metadata.projection_generation).toBe("managed-generation-2");
    const current = { ...stableCopy, project_membership_generation: 12 };
    expect(decodeAiSearchSearchResult(request(), result(), options({ expected_project_copies: [current, legacyCopy] })))
      .toHaveLength(1);
  });

  it("accepts the shared writer folder for a new membership revision", async () => {
    const revisedKey = await createManagedProjectProviderKeyV2({
      ...stableIdentity, membership_revision: 11, item_key: itemKey,
    });
    expect(revisedKey.folder_prefix).not.toBe(stableProviderKey.folder_prefix);
    const revisedCopy = { ...stableCopy, membership_revision: 11, folder_prefix: revisedKey.folder_prefix };
    const candidates = decodeAiSearchSearchResult(request(), result([chunk(revisedCopy)]), options({
      expected_project_copies: [revisedCopy, legacyCopy],
    }));
    expect(candidates[0]?.metadata.provider_item_key).toBe(revisedKey.provider_key);
    expect(() => decodeAiSearchSearchResult(request(), result(), options({
      expected_project_copies: [revisedCopy, legacyCopy],
    }))).toThrow(/scope/u);
  });

  it.each([
    `projection/${"f".repeat(43)}/${itemKey}.md`,
    `${legacyCopy.folder_prefix}${itemKey}.md`,
    `${stableCopy.folder_prefix}nested/${itemKey}.md`,
    `${stableCopy.folder_prefix}${itemKey.toUpperCase()}.md`,
    `${stableCopy.folder_prefix}projection-${"b".repeat(47)}.md`,
    `${stableCopy.folder_prefix}${itemKey}.md/`,
    `${stableCopy.folder_prefix}${"k".repeat(128)}.md`,
  ])("rejects foreign, noncanonical or oversized provider key %s", key => {
    const raw = chunk(stableCopy);
    expect(() => decodeAiSearchSearchResult(request(), result([{ ...raw, item: { ...raw.item, key } }]), options()))
      .toThrow(AiSearchLocatorDecodeError);
  });

  it.each(["revision-legacy", "revision-foreign"])("rejects a stable folder with source %s", source => {
    const raw = chunk(stableCopy);
    raw.item.metadata.source_revision_ref = source;
    expect(() => decodeAiSearchSearchResult(request(), result([raw]), options()))
      .toThrow(/scope/u);
  });

  it.each([
    { membership_identity_version: undefined }, { membership_identity_version: "2" }, { membership_identity_version: 3 },
    { stable_project_membership_id: undefined }, { stable_project_membership_id: `project-membership-${"f".repeat(48)}` },
    { project_membership_id: "project:project-stable:generation:3", stable_project_membership_id: "project:project-stable:generation:3" },
    { project_membership_id: `project-membership-${"c".repeat(49)}`, stable_project_membership_id: `project-membership-${"c".repeat(49)}` },
    { membership_revision: undefined }, { membership_revision: 0 }, { membership_revision: 1.5 },
    { membership_revision: Number.MAX_SAFE_INTEGER + 1 },
    { membership_generation: 0 }, { project_membership_generation: undefined },
    { project_membership_generation: 0 }, { project_membership_generation: 2 },
    { project_membership_generation: Number.MAX_SAFE_INTEGER + 1 },
    { legacy_project_membership_id: "project:project-stable:generation:3" },
    { provider_authorized: true }, { source_owner_generation: "foreign-owner" },
  ])("rejects malformed stable V2 row %j even for an empty result", patch => {
    expect(() => decodeAiSearchSearchResult(request(), result([]), malformedCopies([
      { ...stableCopy, ...patch }, legacyCopy,
    ]))).toThrow(AiSearchLocatorDecodeError);
  });

  it.each([
    { legacy_project_membership_id: undefined },
    { legacy_project_membership_id: "project:project-legacy:generation:5" },
    { project_membership_id: stableCopy.project_membership_id, legacy_project_membership_id: stableCopy.project_membership_id },
    { stable_project_membership_id: stableCopy.project_membership_id },
    { membership_identity_version: 2 },
  ])("keeps legacy grammar strict inside V2 for row %j", patch => {
    expect(() => decodeAiSearchSearchResult(request(), result([]), malformedCopies([
      stableCopy, { ...legacyCopy, ...patch },
    ]))).toThrow(AiSearchLocatorDecodeError);
  });

  it("rejects omitted sources, repeated source representatives and ambiguous folders", () => {
    for (const copies of [
      [stableCopy], [stableCopy, stableCopy, legacyCopy],
      [stableCopy, { ...stableCopy, source_revision_ref: legacyCopy.source_revision_ref, source_owner_generation: legacyCopy.source_owner_generation }],
    ]) {
      expect(() => decodeAiSearchSearchResult(request(), result([]), malformedCopies(copies)))
        .toThrow(/scope|source/u);
    }
  });

  it("enforces the full generation digest and UTF-8 source limit", () => {
    for (const digest of [generationDigest.slice(0, 63), generationDigest.toUpperCase(), `${generationDigest.slice(0, 63)}b`]) {
      const raw = chunk(stableCopy);
      raw.item.metadata.projection_generation = digest;
      expect(() => decodeAiSearchSearchResult(request(), result([raw]), options())).toThrow(/generation/u);
      expect(() => decodeAiSearchSearchResult(request(), result([]), options({ expected_generation_metadata_value: digest.slice(0, 63) })))
        .toThrow(/digest/u);
    }
    const atLimit = { ...stableCopy, source_revision_ref: "é".repeat(32) };
    expect(decodeAiSearchSearchResult(request([atLimit]), result([chunk(atLimit)]), options({ expected_project_copies: [atLimit] })))
      .toHaveLength(1);
    const oversized = { ...stableCopy, source_revision_ref: "é".repeat(33) };
    expect(() => decodeAiSearchSearchResult(request([oversized]), result([chunk(oversized)]), options({ expected_project_copies: [oversized] })))
      .toThrow(AiSearchLocatorDecodeError);
  });

  it("does not accept new provider wire fields or duplicate chunk IDs", () => {
    const raw = chunk(stableCopy);
    for (const chunks of [
      [{ ...raw, membership_identity_version: 2 }],
      [{ ...raw, item: { ...raw.item, folder_prefix: stableCopy.folder_prefix } }],
      [{ ...raw, item: { ...raw.item, metadata: { ...raw.item.metadata, stable_project_membership_id: stableCopy.project_membership_id } } }],
      [raw, raw],
    ]) {
      expect(() => decodeAiSearchSearchResult(request(), result(chunks), options())).toThrow(AiSearchLocatorDecodeError);
    }
    expect(() => decodeAiSearchSearchResult(request(), { ...result(), provider_authorized: true }, options()))
      .toThrow(/unsupported field/u);
  });

  it("preserves unversioned PROJECT_COPY_V1 acceptance and its scope/identity negatives", () => {
    const v1Options = { ...options(), project_copy_layout: "PROJECT_COPY_V1", expected_project_copies: [v1Copy] } as const;
    expect(decodeAiSearchSearchResult(request([v1Copy]), result([chunk(v1Copy)]), v1Options)[0]?.metadata.item_key).toBe(itemKey);
    for (const copies of [
      [], [v1Copy, v1Copy], [{ ...v1Copy, source_owner_generation: "foreign-owner" }],
      [{ ...v1Copy, project_membership_id: stableCopy.project_membership_id }],
      [{ ...v1Copy, membership_generation: 0 }],
    ]) {
      expect(() => decodeAiSearchSearchResult(request([v1Copy]), result([]), { ...v1Options, expected_project_copies: copies }))
        .toThrow(/PROJECT_COPY_V1/u);
    }
    expect(() => decodeAiSearchSearchResult(request([stableCopy]), result(), {
      ...v1Options, expected_project_copies: [stableCopy],
    })).toThrow(/PROJECT_COPY_V1/u);
  });

  it("preserves exact historical LEGACY_FLAT acceptance and key/generation negatives", () => {
    const legacyOptions = {
      ...options(),
      project_copy_layout: "LEGACY_FLAT", expected_index_generation: "historical-generation",
      historical_generation: "historical-generation",
    } as const;
    const raw = chunk(v1Copy);
    raw.item.key = "legacy-item.md";
    raw.item.metadata.projection_generation = "historical-generation";
    expect(decodeAiSearchSearchResult(request([v1Copy]), result([raw]), legacyOptions)[0]?.metadata.item_key)
      .toBe("legacy-item");
    expect(() => decodeAiSearchSearchResult(request([v1Copy]), result([raw]), { ...legacyOptions, historical_generation: "other" }))
      .toThrow(/historical generation/u);
    for (const key of [`${v1Copy.folder_prefix}legacy-item.md`, `${"k".repeat(126)}.md`]) {
      expect(() => decodeAiSearchSearchResult(request([v1Copy]), result([{ ...raw, item: { ...raw.item, key } }]), legacyOptions))
        .toThrow(AiSearchLocatorDecodeError);
    }
  });
});
