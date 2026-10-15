import type { ProjectionItem } from "@eliotr/contracts";
import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  assertProjectionSha256,
  assertProjectionText,
  canonicalProjectionJson,
  projectionDigest,
  projectionFail,
  stableProjectionId,
  utf8ProjectionLength,
} from "./canonical.js";
import {
  compareManagedProjectMemberships,
  createManagedProjectProviderKey,
  createManagedProjectProviderKeyV2,
  managedProjectFolderPrefix,
  managedProjectFolderPrefixV2,
  managedProjectGenerationMetadataValue,
  parseManagedProjectMembershipId,
  type ManagedProjectMembershipIdentity,
} from "./managed-project-path.js";
import { parseManagedItemReceipt } from "./core-managed-item-receipts.js";
import type { ProjectionAuthorityPort } from "./types.js";
import type {
  CanonicalSourceProjectionReceipt,
  CanonicalProjectionResourceBounds,
  CanonicalProjectionSourceContext,
  ManagedProjectCopyMapReceipt,
  ManagedProjectCopyMapReceiptV1,
  ManagedProjectCopyMapReceiptV2,
  ManagedProjectCopyMapSetReceipt,
  ManagedProjectCopyPlan,
  ManagedProjectCopyTargetReceipt,
  ManagedProjectionItemCopy,
  ProjectCopyMembershipCopyV2,
  ProjectCopyScopeV2,
  ManagedTargetSelectionV2,
  ProjectionExecutionProfile,
  ProjectionSourceContext,
} from "./types.js";

export type ManagedItemIntent = Parameters<
  NonNullable<ProjectionAuthorityPort["prepareManagedItems"]>
>[3][number];
export type ManagedItemEffect = Awaited<
  ReturnType<NonNullable<ProjectionAuthorityPort["prepareManagedItems"]>>
>[number];
export type ManagedItemReceipt = NonNullable<ManagedItemEffect["receipt"]>;

const MAX_MANAGED_PROJECT_MEMBERSHIPS = 256;

export async function canonicalSourceProjectionIdentity(
  source: Pick<CanonicalProjectionSourceContext, "source_revision">,
  profile: Pick<
    ProjectionExecutionProfile,
    "projector_profile" | "target_item_utf8_bytes" | "maximum_item_utf8_bytes"
  >,
): Promise<{ readonly generation: string; readonly profile_sha256: string }> {
  const profileSha256 = await projectionDigest({
    projector_profile: profile.projector_profile,
    target_item_utf8_bytes: profile.target_item_utf8_bytes,
    maximum_item_utf8_bytes: profile.maximum_item_utf8_bytes,
  });
  const generation = await stableProjectionId(
    "projection",
    "eliotr.canonical-source-projection.v1",
    source.source_revision.source_revision_ref,
    source.source_revision.content_sha256,
    source.source_revision.object_residency_key_digest,
    profileSha256,
  );
  return { generation, profile_sha256: profileSha256 };
}

export function canonicalSourceResourceBounds(
  profile: Pick<
    ProjectionExecutionProfile,
    "maximum_markdown_bytes" | "maximum_synchronous_items" | "maximum_item_utf8_bytes"
  >,
  inputUtf8Bytes: number,
  items: readonly ProjectionItem[],
): CanonicalProjectionResourceBounds {
  assertProjectionInteger(inputUtf8Bytes, "canonical input UTF-8 bytes", 1, profile.maximum_markdown_bytes);
  assertProjectionInteger(
    profile.maximum_synchronous_items,
    "canonical maximum section count",
    1,
    128,
  );
  assertProjectionInteger(
    profile.maximum_item_utf8_bytes,
    "canonical maximum section UTF-8 bytes",
    1,
    256 * 1024,
  );
  if (items.length < 1 || items.length > profile.maximum_synchronous_items) {
    projectionFail("PROJECTION_INPUT_INVALID", "canonical section count exceeds the declared resource bound");
  }
  let largestSectionBytes = 0;
  for (const item of items) {
    const size = utf8ProjectionLength(item.section_text);
    if (size > profile.maximum_item_utf8_bytes) {
      projectionFail("PROJECTION_INPUT_INVALID", "canonical section exceeds the declared byte bound");
    }
    largestSectionBytes = Math.max(largestSectionBytes, size);
  }
  return Object.freeze({
    protocol: "eliotr.canonical-source-resource-bounds.v1",
    input_utf8_bytes: inputUtf8Bytes,
    maximum_input_utf8_bytes: profile.maximum_markdown_bytes,
    section_count: items.length,
    maximum_section_count: profile.maximum_synchronous_items,
    largest_section_utf8_bytes: largestSectionBytes,
    maximum_section_utf8_bytes: profile.maximum_item_utf8_bytes,
    canonical_body_put_count: items.length,
    canonical_manifest_put_count: 1,
    maximum_provider_copy_count: MAX_MANAGED_PROJECT_MEMBERSHIPS,
    maximum_provider_item_count: items.length * MAX_MANAGED_PROJECT_MEMBERSHIPS,
    maximum_copy_map_page_count: MAX_MANAGED_PROJECT_MEMBERSHIPS,
    cpu_time_budget_ms: 30_000,
    source_content_r2_get_bound: 1,
    canonical_r2_subrequest_bound: 1 + 2 * (items.length + 1),
    maximum_subrequest_bound: 10_000,
  });
}

function canonicalSectionSpan(item: ProjectionItem): {
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
} {
  const match = /^normalized-bytes:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/u.exec(
    item.normalized_offset_map_ref,
  );
  const start = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  const end = match?.[2] === undefined ? Number.NaN : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    projectionFail("PROJECTION_INPUT_INVALID", "canonical item normalized byte span is invalid");
  }
  return { normalized_start_byte: start, normalized_end_byte: end };
}

function membershipIdentities(values: readonly string[]): readonly ManagedProjectMembershipIdentity[] {
  if (!Array.isArray(values) || values.length > MAX_MANAGED_PROJECT_MEMBERSHIPS) {
    projectionFail("PROJECTION_INPUT_INVALID", "project copy membership set exceeds 256 entries");
  }
  const memberships = values.map(parseManagedProjectMembershipId);
  if (new Set(memberships.map((membership) => membership.project_membership_id)).size !== memberships.length) {
    projectionFail("PROJECTION_INPUT_INVALID", "project copy membership set contains duplicates");
  }
  return memberships.sort(compareManagedProjectMemberships);
}

export interface ManagedProjectCopyPreflight {
  readonly metadata_generation_digest: string;
  readonly layout?: "PROJECT_COPY_V2";
  readonly target_selection?: ManagedTargetSelectionV2;
  readonly scope_snapshot_id?: string;
  readonly scope_snapshot_revision?: number;
  readonly scope_snapshot_digest?: string;
  readonly provider_copy_count: number;
  readonly physical_item_count: number;
  readonly provider_copy_item_count: number;
  readonly provider_copy_item_set_sha256: string;
  readonly items: readonly {
    readonly item_key: string;
    readonly canonical_item_key: string | null;
    readonly canonical_section_id: string;
    readonly content_sha256: string;
    readonly normalized_start_byte: number;
    readonly normalized_end_byte: number;
    readonly provider_key: string;
    readonly project_id: string | null;
    readonly project_membership_id: string | null;
    readonly membership_generation: number | null;
    readonly membership_identity_version: 1 | 2 | null;
    readonly legacy_project_membership_id: string | null;
    readonly stable_project_membership_id: string | null;
    readonly membership_revision: number | null;
    readonly project_membership_generation: number | null;
  }[];
}

function v2ScopeForProfile(
  context: ProjectionSourceContext,
  profile: ProjectionExecutionProfile,
): ProjectCopyScopeV2 | undefined {
  const scopes = context.project_copy_scopes_v2;
  if (scopes === undefined) return undefined;
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 2) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root V2 selection scope count is outside the ACTIVE/SHADOW bound");
  }
  const matching = scopes.filter((scope) =>
    scope.target.managed_instance_id === profile.managed_instance_id &&
    scope.target.managed_generation === profile.managed_generation &&
    scope.target_selection.target.managed_instance_id === profile.managed_instance_id &&
    scope.target_selection.target.managed_generation === profile.managed_generation
  );
  if (matching.length !== 1) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root V2 scope does not select exactly this physical target");
  }
  const scope = matching[0];
  if (scope === undefined) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root V2 scope selection is missing");
  }
  if (
    scope.layout !== "PROJECT_COPY_V2" ||
    scope.representative_policy !== "ONE_CANONICAL_COPY_PER_SOURCE_REVISION" ||
    scope.target.namespace !== scope.target_selection.target.namespace ||
    scope.target.managed_instance_id !== scope.target_selection.target.managed_instance_id ||
    scope.target.managed_generation !== scope.target_selection.target.managed_generation ||
    scope.target.target_profile_identity_sha256 !== scope.target_selection.target.target_profile_identity_sha256 ||
    scope.target_selection.protocol !== "eliotr.managed-target-selection.v2" ||
    scope.target_selection.domain !== "MANAGED_SEARCH_PRODUCT" ||
    scope.target_selection.decision_version !== 2 ||
    scope.target_selection.selection_mode !== "STABLE_PHYSICAL_PROFILE_V2" ||
    scope.target_selection.product_alias !== "primary"
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root V2 scope and stable target receipt do not match");
  }
  assertProjectionIdentifier(scope.scope_snapshot_id, "V2 scope snapshot ID");
  assertProjectionInteger(scope.scope_snapshot_revision, "V2 scope snapshot revision", 1, Number.MAX_SAFE_INTEGER);
  assertProjectionSha256(scope.scope_snapshot_digest, "V2 scope snapshot digest");
  assertProjectionSha256(scope.target.target_profile_identity_sha256, "V2 target physical profile digest");
  assertProjectionInteger(scope.target_selection.registry_revision, "V2 registry revision", 1, Number.MAX_SAFE_INTEGER);
  assertProjectionSha256(scope.target_selection.registry_artifact_sha256, "V2 registry artifact digest");
  assertProjectionSha256(scope.target_selection.v1_exact_profile_identity_sha256, "V2 exact V1 profile digest");
  return scope;
}

export function managedProjectCopyScopeForProfile(
  context: ProjectionSourceContext,
  profile: ProjectionExecutionProfile,
): ProjectCopyScopeV2 | undefined {
  return v2ScopeForProfile(context, profile);
}

/** Resolve every exact physical key and document bound before the first Work or provider write. */
export async function preflightManagedProjectCopies(
  context: ProjectionSourceContext,
  profile: ProjectionExecutionProfile,
  canonicalItems: readonly ProjectionItem[],
): Promise<ManagedProjectCopyPreflight> {
  const scope = v2ScopeForProfile(context, profile);
  const targetMetadataDigest = await managedProjectGenerationMetadataValue(profile.managed_generation);
  const items: ManagedProjectCopyPreflight["items"][number][] = [];
  if (scope !== undefined) {
    if (scope.generation_metadata_value !== targetMetadataDigest) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root V2 scope generation digest differs from its selected target");
    }
    const ordered = [...scope.copies].sort(compareCopyIdentityV2);
    const seenCopies = new Set<string>();
    for (const membership of ordered) {
      const copyIdentity = copyIdentityV2(membership);
      if (
        seenCopies.has(copyIdentity) ||
        membership.source_revision_ref !== context.source_revision.source_revision_ref ||
        membership.source_owner_generation !== context.source_revision.source_owner_generation
      ) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root V2 copy scope repeats or changes source authority");
      }
      seenCopies.add(copyIdentity);
      assertProjectionIdentifier(membership.project_id, "V2 scope project ID");
      assertProjectionIdentifier(membership.project_membership_id, "V2 scope membership ID");
      assertProjectionInteger(membership.membership_generation, "V2 opening membership generation", 1, Number.MAX_SAFE_INTEGER);

      let folderPrefix: string;
      let versionFields: {
        readonly membership_identity_version: 1 | 2;
        readonly legacy_project_membership_id: string | null;
        readonly stable_project_membership_id: string | null;
        readonly membership_revision: number | null;
        readonly project_membership_generation: number;
      };
      if (membership.membership_identity_version === 1) {
        const parsed = parseManagedProjectMembershipId(membership.legacy_project_membership_id);
        const aggregateGeneration = assertProjectionInteger(
          membership.project_membership_generation,
          "V2 aggregate membership currentness generation",
          1,
          Number.MAX_SAFE_INTEGER,
        );
        if (
          membership.project_membership_id !== membership.legacy_project_membership_id ||
          parsed.project_id !== membership.project_id ||
          parsed.membership_generation !== membership.membership_generation ||
          membership.membership_generation > aggregateGeneration
        ) {
          projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V1 copy row inside V2 scope changed its original identity");
        }
        folderPrefix = await managedProjectFolderPrefix({
          instance_id: profile.managed_instance_id,
          projection_generation: profile.managed_generation,
          source_revision_ref: context.source_revision.source_revision_ref,
          project_id: membership.project_id,
          project_membership_id: membership.legacy_project_membership_id,
          membership_generation: membership.membership_generation,
        });
        versionFields = {
          membership_identity_version: 1,
          legacy_project_membership_id: membership.legacy_project_membership_id,
          stable_project_membership_id: null,
          membership_revision: null,
          project_membership_generation: aggregateGeneration,
        };
      } else {
        const stableId = assertProjectionIdentifier(
          membership.stable_project_membership_id,
          "V2 stable project/source membership ID",
        );
        const membershipRevision = assertProjectionInteger(
          membership.membership_revision,
          "V2 per-pair membership revision",
          1,
          Number.MAX_SAFE_INTEGER,
        );
        const aggregateGeneration = assertProjectionInteger(
          membership.project_membership_generation,
          "V2 aggregate membership currentness generation",
          1,
          Number.MAX_SAFE_INTEGER,
        );
        if (
          !/^project-membership-[a-f0-9]{48}$/u.test(stableId) ||
          membership.project_membership_id !== stableId ||
          membership.membership_generation > aggregateGeneration
        ) {
          projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 stable membership identity or currentness is invalid");
        }
        folderPrefix = await managedProjectFolderPrefixV2({
          instance_id: profile.managed_instance_id,
          projection_generation: profile.managed_generation,
          source_revision_ref: context.source_revision.source_revision_ref,
          project_id: membership.project_id,
          stable_project_membership_id: stableId,
          membership_revision: membershipRevision,
        });
        versionFields = {
          membership_identity_version: 2,
          legacy_project_membership_id: null,
          stable_project_membership_id: stableId,
          membership_revision: membershipRevision,
          project_membership_generation: aggregateGeneration,
        };
      }
      if (membership.folder_prefix !== folderPrefix) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "Root V2 folder differs from the shared provider-key helper");
      }
      for (const item of canonicalItems) {
        const span = canonicalSectionSpan(item);
        const document = item.document_context_header.trim().length === 0
          ? item.section_text
          : `${item.document_context_header.trim()}\n\n${item.section_text}`;
        const documentBytes = utf8ProjectionLength(document);
        if (documentBytes < 1 || documentBytes > profile.maximum_item_utf8_bytes) {
          projectionFail("PROJECTION_INPUT_INVALID", "V2 project-copy document exceeds the declared UTF-8 byte bound");
        }
        const keyIdentity = membership.membership_identity_version === 1
          ? {
            canonical_section_id: item.canonical_section_id,
            projection_generation: profile.managed_generation,
            project_membership_id: membership.legacy_project_membership_id,
          }
          : {
            protocol: "eliotr.project-copy-item.v2",
            canonical_section_id: item.canonical_section_id,
            projection_generation: profile.managed_generation,
            project_id: membership.project_id,
            stable_project_membership_id: membership.stable_project_membership_id,
            membership_revision: membership.membership_revision,
          };
        const itemKey = "projection-" + (await projectionDigest(keyIdentity)).slice(0, 48);
        const providerKey = membership.membership_identity_version === 1
          ? (await createManagedProjectProviderKey({
            instance_id: profile.managed_instance_id,
            projection_generation: profile.managed_generation,
            source_revision_ref: context.source_revision.source_revision_ref,
            project_id: membership.project_id,
            project_membership_id: membership.legacy_project_membership_id,
            membership_generation: membership.membership_generation,
            item_key: itemKey,
          })).provider_key
          : (await createManagedProjectProviderKeyV2({
            instance_id: profile.managed_instance_id,
            projection_generation: profile.managed_generation,
            source_revision_ref: context.source_revision.source_revision_ref,
            project_id: membership.project_id,
            stable_project_membership_id: membership.stable_project_membership_id,
            membership_revision: membership.membership_revision,
            item_key: itemKey,
          })).provider_key;
        items.push(Object.freeze({
          item_key: itemKey,
          canonical_item_key: item.item_key,
          canonical_section_id: item.canonical_section_id,
          content_sha256: item.content_sha256,
          normalized_start_byte: span.normalized_start_byte,
          normalized_end_byte: span.normalized_end_byte,
          provider_key: providerKey,
          project_id: membership.project_id,
          project_membership_id: membership.project_membership_id,
          membership_generation: membership.membership_generation,
          ...versionFields,
        }));
      }
    }
    return Object.freeze({
      metadata_generation_digest: targetMetadataDigest,
      layout: "PROJECT_COPY_V2",
      target_selection: scope.target_selection,
      scope_snapshot_id: scope.scope_snapshot_id,
      scope_snapshot_revision: scope.scope_snapshot_revision,
      scope_snapshot_digest: scope.scope_snapshot_digest,
      provider_copy_count: scope.copies.length,
      physical_item_count: items.length,
      provider_copy_item_count: items.length,
      provider_copy_item_set_sha256: await projectionDigest(items.map((item) => ({
        item_key: item.item_key,
        canonical_section_id: item.canonical_section_id,
        content_sha256: item.content_sha256,
        start: item.normalized_start_byte,
        end: item.normalized_end_byte,
      }))),
      items: Object.freeze(items),
    });
  }
  const memberships = membershipIdentities(context.project_membership_ids);
  if (memberships.length === 0) {
    for (const item of canonicalItems) {
      const span = canonicalSectionSpan(item);
      const document = item.document_context_header.trim().length === 0
        ? item.section_text
        : `${item.document_context_header.trim()}\n\n${item.section_text}`;
      const documentBytes = utf8ProjectionLength(document);
      if (documentBytes < 1 || documentBytes > profile.maximum_item_utf8_bytes) {
        projectionFail("PROJECTION_INPUT_INVALID", "flat provider document exceeds the declared UTF-8 byte bound");
      }
      items.push(Object.freeze({
        item_key: item.item_key,
        canonical_item_key: null,
        canonical_section_id: item.canonical_section_id,
        content_sha256: item.content_sha256,
        normalized_start_byte: span.normalized_start_byte,
        normalized_end_byte: span.normalized_end_byte,
        provider_key: item.item_key + ".md",
        project_id: null,
        project_membership_id: null,
        membership_generation: null,
        membership_identity_version: null,
        legacy_project_membership_id: null,
        stable_project_membership_id: null,
        membership_revision: null,
        project_membership_generation: null,
      }));
    }
    return Object.freeze({
      metadata_generation_digest: targetMetadataDigest,
      provider_copy_count: 0,
      physical_item_count: items.length,
      provider_copy_item_count: 0,
      provider_copy_item_set_sha256: await projectionDigest([]),
      items: Object.freeze(items),
    });
  }

  for (const membership of memberships) {
    for (const item of canonicalItems) {
      const span = canonicalSectionSpan(item);
      const document = item.document_context_header.trim().length === 0
        ? item.section_text
        : `${item.document_context_header.trim()}\n\n${item.section_text}`;
      const documentBytes = utf8ProjectionLength(document);
      if (documentBytes < 1 || documentBytes > profile.maximum_item_utf8_bytes) {
        projectionFail("PROJECTION_INPUT_INVALID", "project-copy provider document exceeds the declared UTF-8 byte bound");
      }
      const itemDigest = await projectionDigest({
        canonical_section_id: item.canonical_section_id,
        projection_generation: profile.managed_generation,
        project_membership_id: membership.project_membership_id,
      });
      const itemKey = "projection-" + itemDigest.slice(0, 48);
      const providerIdentity = await createManagedProjectProviderKey({
        instance_id: profile.managed_instance_id,
        projection_generation: profile.managed_generation,
        source_revision_ref: context.source_revision.source_revision_ref,
        project_id: membership.project_id,
        project_membership_id: membership.project_membership_id,
        membership_generation: membership.membership_generation,
        item_key: itemKey,
      });
      items.push(Object.freeze({
        item_key: itemKey,
        canonical_item_key: item.item_key,
        canonical_section_id: item.canonical_section_id,
        content_sha256: item.content_sha256,
        normalized_start_byte: span.normalized_start_byte,
        normalized_end_byte: span.normalized_end_byte,
        provider_key: providerIdentity.provider_key,
        project_id: membership.project_id,
        project_membership_id: membership.project_membership_id,
        membership_generation: membership.membership_generation,
        membership_identity_version: null,
        legacy_project_membership_id: null,
        stable_project_membership_id: null,
        membership_revision: null,
        project_membership_generation: null,
      }));
    }
  }
  const providerCopyItemSetSha256 = await projectionDigest(items.map((item) => ({
    item_key: item.item_key,
    canonical_section_id: item.canonical_section_id,
    content_sha256: item.content_sha256,
    start: item.normalized_start_byte,
    end: item.normalized_end_byte,
  })));
  assertProjectionSha256(targetMetadataDigest, "managed target metadata digest");
  return Object.freeze({
    metadata_generation_digest: targetMetadataDigest,
    provider_copy_count: memberships.length,
    physical_item_count: items.length,
    provider_copy_item_count: items.length,
    provider_copy_item_set_sha256: providerCopyItemSetSha256,
    items: Object.freeze(items),
  });
}

function copyMapPayload(
  canonical: CanonicalSourceProjectionReceipt,
  target: ManagedProjectCopyTargetReceipt,
  membership: ManagedProjectMembershipIdentity,
  items: ManagedProjectCopyMapReceipt["items"],
  providerItemSetSha256: string,
) {
  return {
    protocol: "eliotr.managed-project-copy-map.v1" as const,
    source_revision_ref: canonical.source_revision_ref,
    complete_residency_key_sha256: canonical.complete_residency_key_sha256,
    canonical_projection_generation: canonical.canonical_projection_generation,
    target,
    project_id: membership.project_id,
    project_membership_id: membership.project_membership_id,
    membership_generation: membership.membership_generation,
    canonical_source_ref: canonical.canonical_source_ref,
    canonical_source_sha256: canonical.canonical_source_sha256,
    provider_copy_count: 1 as const,
    provider_item_count: items.length,
    provider_item_set_sha256: providerItemSetSha256,
    items,
  };
}

/** Build the body-free membership maps from one already materialized canonical source. */
export async function buildCanonicalProjectCopyMaps(
  canonical: CanonicalSourceProjectionReceipt,
  target: ManagedProjectCopyTargetReceipt,
  rawMemberships: readonly string[],
): Promise<readonly ManagedProjectCopyMapReceiptV1[]> {
  if (rawMemberships.length < 1 || rawMemberships.length > MAX_MANAGED_PROJECT_MEMBERSHIPS) {
    projectionFail("PROJECTION_INPUT_INVALID", "PROJECT_COPY_V1 requires 1 to 256 current Core memberships");
  }
  assertProjectionIdentifier(target.managed_instance_id, "project copy managed instance");
  assertProjectionIdentifier(target.managed_generation, "project copy managed generation");
  const expectedMetadataGeneration = await managedProjectGenerationMetadataValue(target.managed_generation);
  if (target.metadata_generation_digest !== expectedMetadataGeneration) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "project copy metadata generation is not the server-computed target digest");
  }
  assertProjectionSha256(canonical.complete_residency_key_sha256, "canonical residency digest");
  assertProjectionSha256(canonical.projector_profile_sha256, "canonical projector profile digest");
  assertProjectionSha256(canonical.canonical_source_sha256, "canonical source digest");
  assertProjectionSha256(canonical.canonical_section_set_sha256, "canonical section set digest");
  assertProjectionIdentifier(canonical.canonical_projection_generation, "canonical projection generation");
  if (canonical.sections.length !== canonical.canonical_section_count) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "canonical source section count differs from its receipt");
  }

  const memberships = membershipIdentities(rawMemberships);
  const copies: ManagedProjectCopyMapReceiptV1[] = [];
  for (const membership of memberships) {
    const items: ManagedProjectCopyMapReceipt["items"][number][] = [];
    for (const section of canonical.sections) {
      assertProjectionIdentifier(section.canonical_item_key, "canonical item key");
      assertProjectionIdentifier(section.canonical_section_id, "canonical section ID");
      assertProjectionSha256(section.content_sha256, "canonical section content digest");
      assertProjectionText(section.canonical_body_ref, "canonical body reference", 2048);
      assertProjectionSha256(section.canonical_body_sha256, "canonical body digest");
      if (section.canonical_body_sha256 !== section.content_sha256) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "canonical body digest differs from section content digest");
      }
      const itemDigest = await projectionDigest({
        canonical_section_id: section.canonical_section_id,
        projection_generation: target.managed_generation,
        project_membership_id: membership.project_membership_id,
      });
      const itemKey = "projection-" + itemDigest.slice(0, 48);
      const providerIdentity = await createManagedProjectProviderKey({
        instance_id: target.managed_instance_id,
        projection_generation: target.managed_generation,
        source_revision_ref: canonical.source_revision_ref,
        project_id: membership.project_id,
        project_membership_id: membership.project_membership_id,
        membership_generation: membership.membership_generation,
        item_key: itemKey,
      });
      items.push(Object.freeze({
        item_key: itemKey,
        canonical_item_key: section.canonical_item_key,
        canonical_section_id: section.canonical_section_id,
        content_sha256: section.content_sha256,
        normalized_start_byte: section.normalized_start_byte,
        normalized_end_byte: section.normalized_end_byte,
        provider_key: providerIdentity.provider_key,
        canonical_body_ref: section.canonical_body_ref,
        canonical_body_sha256: section.canonical_body_sha256,
      }));
    }
    const providerItemSetSha256 = await projectionDigest(items.map((item) => ({
      item_key: item.item_key,
      canonical_section_id: item.canonical_section_id,
      content_sha256: item.content_sha256,
      start: item.normalized_start_byte,
      end: item.normalized_end_byte,
    })));
    const payload = copyMapPayload(canonical, target, membership, Object.freeze(items), providerItemSetSha256);
    const providerCopySetSha256 = await projectionDigest(payload);
    copies.push(Object.freeze({
      ...payload,
      provider_copy_set_sha256: providerCopySetSha256,
    }));
  }
  return Object.freeze(copies);
}

function copyIdentityV2(copy: ProjectCopyMembershipCopyV2): string {
  return `${copy.membership_identity_version}:${copy.project_id}:${copy.project_membership_id}`;
}

function compareCopyIdentityV2(
  left: ProjectCopyMembershipCopyV2,
  right: ProjectCopyMembershipCopyV2,
): number {
  const projectOrder = left.project_id < right.project_id ? -1 : left.project_id > right.project_id ? 1 : 0;
  return projectOrder !== 0
    ? projectOrder
    : left.project_membership_id < right.project_membership_id
    ? -1
    : left.project_membership_id > right.project_membership_id
    ? 1
    : 0;
}

/** Build versioned mapping receipts from one canonical source; V2 rows never contain section bodies. */
export async function buildCanonicalProjectCopyMapsV2(
  canonical: CanonicalSourceProjectionReceipt,
  target: ManagedProjectCopyTargetReceipt,
  scope: ProjectCopyScopeV2,
): Promise<readonly ManagedProjectCopyMapReceiptV2[]> {
  const expectedMetadataGeneration = await managedProjectGenerationMetadataValue(target.managed_generation);
  if (
    scope.layout !== "PROJECT_COPY_V2" ||
    scope.representative_policy !== "ONE_CANONICAL_COPY_PER_SOURCE_REVISION" ||
    scope.target.managed_instance_id !== target.managed_instance_id ||
    scope.target.managed_generation !== target.managed_generation ||
    scope.target_selection.target.managed_instance_id !== target.managed_instance_id ||
    scope.target_selection.target.managed_generation !== target.managed_generation ||
    scope.target_selection.target.namespace !== scope.target.namespace ||
    scope.target_selection.target.target_profile_identity_sha256 !== scope.target.target_profile_identity_sha256 ||
    scope.generation_metadata_value !== expectedMetadataGeneration ||
    target.metadata_generation_digest !== expectedMetadataGeneration ||
    !Array.isArray(scope.copies) ||
    scope.copies.length > MAX_MANAGED_PROJECT_MEMBERSHIPS ||
    canonical.sections.length !== canonical.canonical_section_count ||
    canonical.source_revision_ref !== scope.copies[0]?.source_revision_ref && scope.copies.length > 0
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 copy scope differs from its canonical or target authority");
  }
  assertProjectionIdentifier(scope.scope_snapshot_id, "V2 copy scope snapshot ID");
  assertProjectionInteger(scope.scope_snapshot_revision, "V2 copy scope snapshot revision", 1, Number.MAX_SAFE_INTEGER);
  assertProjectionSha256(scope.scope_snapshot_digest, "V2 copy scope snapshot digest");
  assertProjectionIdentifier(scope.target_selection.target.namespace, "V2 selected target namespace");
  assertProjectionSha256(scope.target_selection.target.target_profile_identity_sha256, "V2 selected physical profile digest");
  assertProjectionInteger(scope.target_selection.registry_revision, "V2 target registry revision", 1, Number.MAX_SAFE_INTEGER);
  assertProjectionSha256(scope.target_selection.registry_artifact_sha256, "V2 target registry artifact digest");
  assertProjectionSha256(scope.target_selection.v1_exact_profile_identity_sha256, "V2 exact V1 profile digest");
  if (
    scope.target_selection.protocol !== "eliotr.managed-target-selection.v2" ||
    scope.target_selection.domain !== "MANAGED_SEARCH_PRODUCT" ||
    scope.target_selection.decision_version !== 2 ||
    scope.target_selection.selection_mode !== "STABLE_PHYSICAL_PROFILE_V2" ||
    scope.target_selection.product_alias !== "primary"
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 target selection is not the exact supported product protocol");
  }
  assertProjectionSha256(canonical.complete_residency_key_sha256, "canonical residency digest");
  assertProjectionSha256(canonical.projector_profile_sha256, "canonical projector profile digest");
  assertProjectionSha256(canonical.canonical_source_sha256, "canonical source digest");
  assertProjectionSha256(canonical.canonical_section_set_sha256, "canonical section set digest");
  assertProjectionIdentifier(canonical.canonical_projection_generation, "canonical projection generation");

  const ordered = [...scope.copies].sort(compareCopyIdentityV2);
  const seen = new Set<string>();
  const copies: ManagedProjectCopyMapReceiptV2[] = [];
  for (const membership of ordered) {
    const identity = copyIdentityV2(membership);
    if (seen.has(identity) || membership.source_revision_ref !== canonical.source_revision_ref) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 copy scope repeats or changes a source membership identity");
    }
    seen.add(identity);
    assertProjectionIdentifier(membership.source_owner_generation, "V2 copy source owner generation");
    assertProjectionIdentifier(membership.project_id, "V2 copy project ID");
    assertProjectionIdentifier(membership.project_membership_id, "V2 copy membership ID");
    assertProjectionInteger(membership.membership_generation, "V2 copy opening membership generation", 1, Number.MAX_SAFE_INTEGER);

    let expectedFolderPrefix: string;
    let membershipFields: ProjectCopyMembershipCopyV2;
    if (membership.membership_identity_version === 1) {
      const legacy = parseManagedProjectMembershipId(membership.legacy_project_membership_id);
      const aggregateGeneration = assertProjectionInteger(
        membership.project_membership_generation,
        "V2 aggregate membership currentness generation",
        1,
        Number.MAX_SAFE_INTEGER,
      );
      if (
        membership.project_membership_id !== membership.legacy_project_membership_id ||
        legacy.project_id !== membership.project_id ||
        legacy.membership_generation !== membership.membership_generation ||
        membership.membership_generation > aggregateGeneration
      ) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V1 row inside V2 scope changed its legacy identity");
      }
      expectedFolderPrefix = await managedProjectFolderPrefix({
        instance_id: target.managed_instance_id,
        projection_generation: target.managed_generation,
        source_revision_ref: canonical.source_revision_ref,
        project_id: membership.project_id,
        project_membership_id: membership.legacy_project_membership_id,
        membership_generation: membership.membership_generation,
      });
      membershipFields = membership;
    } else {
      const stableId = assertProjectionIdentifier(
        membership.stable_project_membership_id,
        "V2 stable project/source membership ID",
      );
      const membershipRevision = assertProjectionInteger(
        membership.membership_revision,
        "V2 per-pair membership revision",
        1,
        Number.MAX_SAFE_INTEGER,
      );
      const currentMembershipGeneration = assertProjectionInteger(
        membership.project_membership_generation,
        "V2 aggregate membership currentness generation",
        1,
        Number.MAX_SAFE_INTEGER,
      );
      if (
        !/^project-membership-[a-f0-9]{48}$/u.test(stableId) ||
        membership.project_membership_id !== stableId ||
        membership.membership_generation > currentMembershipGeneration
      ) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 stable membership identity or currentness is invalid");
      }
      expectedFolderPrefix = await managedProjectFolderPrefixV2({
        instance_id: target.managed_instance_id,
        projection_generation: target.managed_generation,
        source_revision_ref: canonical.source_revision_ref,
        project_id: membership.project_id,
        stable_project_membership_id: stableId,
        membership_revision: membershipRevision,
      });
      membershipFields = membership;
    }
    if (membership.folder_prefix !== expectedFolderPrefix) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 scope folder does not match the shared provider-key helper");
    }

    const items: ManagedProjectCopyMapReceiptV2["items"][number][] = [];
    for (const section of canonical.sections) {
      assertProjectionIdentifier(section.canonical_item_key, "canonical item key");
      assertProjectionIdentifier(section.canonical_section_id, "canonical section ID");
      assertProjectionSha256(section.content_sha256, "canonical section content digest");
      assertProjectionText(section.canonical_body_ref, "canonical body reference", 2048);
      assertProjectionSha256(section.canonical_body_sha256, "canonical body digest");
      if (section.canonical_body_sha256 !== section.content_sha256) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "canonical body digest differs from section content digest");
      }
      const itemIdentity = membership.membership_identity_version === 1
        ? {
          canonical_section_id: section.canonical_section_id,
          projection_generation: target.managed_generation,
          project_membership_id: membership.legacy_project_membership_id,
        }
        : {
          protocol: "eliotr.project-copy-item.v2",
          canonical_section_id: section.canonical_section_id,
          projection_generation: target.managed_generation,
          project_id: membership.project_id,
          stable_project_membership_id: membership.stable_project_membership_id,
          membership_revision: membership.membership_revision,
        };
      const itemKey = "projection-" + (await projectionDigest(itemIdentity)).slice(0, 48);
      const key = membership.membership_identity_version === 1
        ? await createManagedProjectProviderKey({
          instance_id: target.managed_instance_id,
          projection_generation: target.managed_generation,
          source_revision_ref: canonical.source_revision_ref,
          project_id: membership.project_id,
          project_membership_id: membership.legacy_project_membership_id,
          membership_generation: membership.membership_generation,
          item_key: itemKey,
        })
        : await createManagedProjectProviderKeyV2({
          instance_id: target.managed_instance_id,
          projection_generation: target.managed_generation,
          source_revision_ref: canonical.source_revision_ref,
          project_id: membership.project_id,
          stable_project_membership_id: membership.stable_project_membership_id,
          membership_revision: membership.membership_revision,
          item_key: itemKey,
        });
      if (key.folder_prefix !== membership.folder_prefix) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "provider path changed during V2 copy-map construction");
      }
      items.push(Object.freeze({
        item_key: itemKey,
        canonical_item_key: section.canonical_item_key,
        canonical_section_id: section.canonical_section_id,
        content_sha256: section.content_sha256,
        normalized_start_byte: section.normalized_start_byte,
        normalized_end_byte: section.normalized_end_byte,
        provider_key: key.provider_key,
        canonical_body_ref: section.canonical_body_ref,
        canonical_body_sha256: section.canonical_body_sha256,
      }));
    }
    const providerItemSetSha256 = await projectionDigest(items.map((item) => ({
      item_key: item.item_key,
      canonical_section_id: item.canonical_section_id,
      content_sha256: item.content_sha256,
      start: item.normalized_start_byte,
      end: item.normalized_end_byte,
    })));
    const payload = {
      ...membershipFields,
      protocol: "eliotr.managed-project-copy-map.v2" as const,
      layout: "PROJECT_COPY_V2" as const,
      source_revision_ref: canonical.source_revision_ref,
      complete_residency_key_sha256: canonical.complete_residency_key_sha256,
      canonical_projection_generation: canonical.canonical_projection_generation,
      target,
      target_selection: scope.target_selection,
      canonical_source_ref: canonical.canonical_source_ref,
      canonical_source_sha256: canonical.canonical_source_sha256,
      provider_copy_count: 1 as const,
      provider_item_count: items.length,
      provider_item_set_sha256: providerItemSetSha256,
      items: Object.freeze(items),
    };
    copies.push(Object.freeze({
      ...payload,
      provider_copy_set_sha256: await projectionDigest(payload),
    }));
  }
  return Object.freeze(copies);
}

/** Expand one canonical projector result into exact provider identities without re-projecting section text. */
export async function buildManagedProjectCopyPlan(
  context: ProjectionSourceContext,
  profile: ProjectionExecutionProfile,
  canonical: CanonicalSourceProjectionReceipt,
  canonicalItems: readonly ProjectionItem[],
  preflight?: ManagedProjectCopyPreflight,
): Promise<ManagedProjectCopyPlan> {
  if (
    canonical.source_revision_ref !== context.source_revision.source_revision_ref ||
    canonical.complete_residency_key_sha256 !== context.source_revision.object_residency_key_digest ||
    canonical.sections.length !== canonicalItems.length ||
    canonical.canonical_section_count !== canonicalItems.length
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "canonical copy plan differs from its source or projector result");
  }
  for (const [index, item] of canonicalItems.entries()) {
    const section = canonical.sections[index];
    const span = canonicalSectionSpan(item);
    if (
      section === undefined ||
      item.projection_generation !== canonical.canonical_projection_generation ||
      item.source_revision_ref !== canonical.source_revision_ref ||
      item.item_key !== section.canonical_item_key ||
      item.canonical_section_id !== section.canonical_section_id ||
      item.content_sha256 !== section.content_sha256 ||
      span.normalized_start_byte !== section.normalized_start_byte ||
      span.normalized_end_byte !== section.normalized_end_byte
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "canonical section mapping differs from projector output");
    }
  }

  const metadataGenerationDigest = await managedProjectGenerationMetadataValue(profile.managed_generation);
  const target: ManagedProjectCopyTargetReceipt = Object.freeze({
    managed_instance_id: profile.managed_instance_id,
    managed_generation: profile.managed_generation,
    metadata_generation_digest: metadataGenerationDigest,
  });
  const v2Scope = v2ScopeForProfile(context, profile);
  if (v2Scope !== undefined) {
    const resolvedPreflight = preflight ?? await preflightManagedProjectCopies(context, profile, canonicalItems);
    if (
      resolvedPreflight.layout !== "PROJECT_COPY_V2" ||
      resolvedPreflight.target_selection === undefined ||
      resolvedPreflight.target_selection.registry_artifact_sha256 !== v2Scope.target_selection.registry_artifact_sha256 ||
      resolvedPreflight.scope_snapshot_id !== v2Scope.scope_snapshot_id ||
      resolvedPreflight.scope_snapshot_revision !== v2Scope.scope_snapshot_revision ||
      resolvedPreflight.scope_snapshot_digest !== v2Scope.scope_snapshot_digest ||
      resolvedPreflight.metadata_generation_digest !== metadataGenerationDigest
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 provider plan differs from its complete Root preflight");
    }
    const copies = await buildCanonicalProjectCopyMapsV2(canonical, target, v2Scope);
    if (copies.length !== resolvedPreflight.provider_copy_count) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 mapping copy count differs from its exact preflight");
    }
    const canonicalByKey = new Map(canonicalItems.map((item) => [item.item_key, item]));
    const expectedByIdentity = new Map(resolvedPreflight.items.map((item) => [
      `${item.membership_identity_version}:${item.project_id}:${item.project_membership_id}:${item.canonical_item_key}`,
      item,
    ]));
    const copyItems: ManagedProjectionItemCopy[] = [];
    for (const copy of copies) {
      const publicMembershipId = copy.project_membership_id;
      for (const mapped of copy.items) {
        const item = canonicalByKey.get(mapped.canonical_item_key);
        const identity = `${copy.membership_identity_version}:${copy.project_id}:${publicMembershipId}:${mapped.canonical_item_key}`;
        const expected = expectedByIdentity.get(identity);
        if (
          item === undefined || expected === undefined ||
          expected.item_key !== mapped.item_key || expected.provider_key !== mapped.provider_key ||
          expected.content_sha256 !== mapped.content_sha256 ||
          expected.normalized_start_byte !== mapped.normalized_start_byte ||
          expected.normalized_end_byte !== mapped.normalized_end_byte
        ) {
          projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 copy map differs from the complete preflight key set");
        }
        const versionFields = copy.membership_identity_version === 1
          ? {
            membership_identity_version: 1 as const,
            legacy_project_membership_id: copy.legacy_project_membership_id,
            stable_project_membership_id: null,
            membership_revision: null,
            project_membership_generation: copy.project_membership_generation,
          }
          : {
            membership_identity_version: 2 as const,
            legacy_project_membership_id: null,
            stable_project_membership_id: copy.stable_project_membership_id,
            membership_revision: copy.membership_revision,
            project_membership_generation: copy.project_membership_generation,
          };
        copyItems.push(Object.freeze({
          ...item,
          normalized_start_byte: mapped.normalized_start_byte,
          normalized_end_byte: mapped.normalized_end_byte,
          item_key: mapped.item_key,
          projection_generation: target.metadata_generation_digest,
          project_membership_ids: [publicMembershipId],
          copy_layout: "PROJECT_COPY_V2",
          canonical_projection_generation: canonical.canonical_projection_generation,
          canonical_item_key: mapped.canonical_item_key,
          project_id: copy.project_id,
          project_membership_id: publicMembershipId,
          membership_generation: copy.membership_generation,
          ...versionFields,
          provider_key: mapped.provider_key,
          metadata_generation_digest: target.metadata_generation_digest,
          canonical_body_ref: mapped.canonical_body_ref,
          canonical_body_sha256: mapped.canonical_body_sha256,
        }));
      }
    }
    if (copyItems.length !== resolvedPreflight.physical_item_count) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 physical item count differs from its complete preflight");
    }
    const providerItemSetSha256 = await projectionDigest(copyItems.map((item) => ({
      item_key: item.item_key,
      canonical_section_id: item.canonical_section_id,
      content_sha256: item.content_sha256,
      start: item.normalized_start_byte,
      end: item.normalized_end_byte,
    })));
    if (providerItemSetSha256 !== resolvedPreflight.provider_copy_item_set_sha256) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 physical item set digest differs from its complete preflight");
    }
    const providerCopySetSha256 = await projectionDigest(copies.map((copy) => ({
      project_id: copy.project_id,
      project_membership_id: copy.project_membership_id,
      membership_identity_version: copy.membership_identity_version,
      legacy_project_membership_id: copy.membership_identity_version === 1
        ? copy.legacy_project_membership_id
        : null,
      stable_project_membership_id: copy.membership_identity_version === 2
        ? copy.stable_project_membership_id
        : null,
      membership_revision: copy.membership_identity_version === 2 ? copy.membership_revision : null,
      membership_generation: copy.membership_generation,
      project_membership_generation: copy.project_membership_generation,
      folder_prefix: copy.folder_prefix,
      provider_copy_set_sha256: copy.provider_copy_set_sha256,
    })));
    return Object.freeze({
      target,
      layout: "PROJECT_COPY_V2",
      target_selection: v2Scope.target_selection,
      scope_snapshot_id: v2Scope.scope_snapshot_id,
      scope_snapshot_revision: v2Scope.scope_snapshot_revision,
      scope_snapshot_digest: v2Scope.scope_snapshot_digest,
      items: Object.freeze(copyItems),
      copies,
      provider_copy_count: copies.length,
      provider_copy_set_sha256: providerCopySetSha256,
      provider_item_count: copyItems.length,
      provider_item_set_sha256: providerItemSetSha256,
    });
  }
  const memberships = membershipIdentities(context.project_membership_ids);
  if (memberships.length === 0) {
    const canonicalByKey = new Map(canonical.sections.map((section) => [section.canonical_item_key, section]));
    const items = canonicalItems.map((item): ManagedProjectionItemCopy => {
      const section = canonicalByKey.get(item.item_key);
      if (section === undefined) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "flat item has no canonical section span");
      }
      return Object.freeze({
        ...item,
        normalized_start_byte: section.normalized_start_byte,
        normalized_end_byte: section.normalized_end_byte,
        copy_layout: null,
        canonical_projection_generation: canonical.canonical_projection_generation,
        canonical_item_key: null,
        project_id: null,
        project_membership_id: null,
        membership_generation: null,
        membership_identity_version: null,
        legacy_project_membership_id: null,
        stable_project_membership_id: null,
        membership_revision: null,
        project_membership_generation: null,
        provider_key: item.item_key + ".md",
        metadata_generation_digest: null,
        canonical_body_ref: null,
        canonical_body_sha256: null,
      });
    });
    return Object.freeze({
      target,
      items: Object.freeze(items),
      copies: Object.freeze([]),
      provider_copy_count: 0,
      provider_copy_set_sha256: await projectionDigest([]),
      provider_item_count: 0,
      provider_item_set_sha256: await projectionDigest([]),
    });
  }

  const copies = await buildCanonicalProjectCopyMaps(
    canonical,
    target,
    memberships.map((membership) => membership.project_membership_id),
  );
  const canonicalByKey = new Map(canonicalItems.map((item) => [item.item_key, item]));
  const copyItems: ManagedProjectionItemCopy[] = [];
  for (const copy of copies) {
    for (const mapped of copy.items) {
      const item = canonicalByKey.get(mapped.canonical_item_key);
      if (item === undefined) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "copy map references a missing canonical item");
      }
      copyItems.push(Object.freeze({
        ...item,
        normalized_start_byte: mapped.normalized_start_byte,
        normalized_end_byte: mapped.normalized_end_byte,
        item_key: mapped.item_key,
        projection_generation: target.metadata_generation_digest,
        project_membership_ids: [copy.project_membership_id],
        copy_layout: "PROJECT_COPY_V1",
        canonical_projection_generation: canonical.canonical_projection_generation,
        canonical_item_key: mapped.canonical_item_key,
        project_id: copy.project_id,
        project_membership_id: copy.project_membership_id,
        membership_generation: copy.membership_generation,
        membership_identity_version: null,
        legacy_project_membership_id: null,
        stable_project_membership_id: null,
        membership_revision: null,
        project_membership_generation: null,
        provider_key: mapped.provider_key,
        metadata_generation_digest: target.metadata_generation_digest,
        canonical_body_ref: mapped.canonical_body_ref,
        canonical_body_sha256: mapped.canonical_body_sha256,
      }));
    }
  }
  const providerItemSetSha256 = await projectionDigest(copyItems.map((item) => ({
    item_key: item.item_key,
    canonical_section_id: item.canonical_section_id,
    content_sha256: item.content_sha256,
    start: item.normalized_start_byte,
    end: item.normalized_end_byte,
  })));
  const providerCopySetSha256 = await projectionDigest(copies.map((copy) => ({
    project_id: copy.project_id,
    project_membership_id: copy.project_membership_id,
    membership_generation: copy.membership_generation,
    provider_copy_set_sha256: copy.provider_copy_set_sha256,
  })));
  return Object.freeze({
    target,
    items: Object.freeze(copyItems),
    copies,
    provider_copy_count: copies.length,
    provider_copy_set_sha256: providerCopySetSha256,
    provider_item_count: copyItems.length,
    provider_item_set_sha256: providerItemSetSha256,
  });
}

/** Bind the immutable V2 map-index readback to the exact Core preparation plan. */
export function bindProjectCopyMapIndex(
  plan: ManagedProjectCopyPlan,
  mapSet: ManagedProjectCopyMapSetReceipt,
): ManagedProjectCopyPlan {
  if (plan.layout !== "PROJECT_COPY_V2") {
    if (mapSet.protocol === "eliotr.managed-project-copy-map-set.v2") {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 map index cannot be attached to a V1 or flat plan");
    }
    return plan;
  }
  if (
    mapSet.protocol !== "eliotr.managed-project-copy-map-set.v2" ||
    mapSet.layout !== "PROJECT_COPY_V2" ||
    plan.target_selection === undefined ||
    plan.scope_snapshot_id !== mapSet.scope_snapshot_id ||
    plan.scope_snapshot_revision !== mapSet.scope_snapshot_revision ||
    plan.scope_snapshot_digest !== mapSet.scope_snapshot_digest ||
    plan.target.managed_instance_id !== mapSet.target.managed_instance_id ||
    plan.target.managed_generation !== mapSet.target.managed_generation ||
    plan.target.metadata_generation_digest !== mapSet.target.metadata_generation_digest ||
    plan.provider_copy_count !== mapSet.provider_copy_count ||
    plan.provider_copy_set_sha256 !== mapSet.provider_copy_set_sha256 ||
    plan.provider_item_count !== mapSet.provider_item_count ||
    plan.provider_item_set_sha256 !== mapSet.provider_item_set_sha256 ||
    canonicalProjectionJson(plan.target_selection) !== canonicalProjectionJson(mapSet.target_selection)
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 map index differs from the exact prepared copy plan");
  }
  const indexRef = assertProjectionText(mapSet.copy_map_index_ref, "V2 copy-map index reference", 2048);
  const indexSha256 = assertProjectionSha256(mapSet.copy_map_index_sha256, "V2 copy-map index digest");
  return Object.freeze({
    ...plan,
    project_copy_map_index_protocol: "eliotr.managed-project-copy-map-index.v2",
    project_copy_map_index_ref: indexRef,
    project_copy_map_index_sha256: indexSha256,
  });
}

export interface ManagedItemEffectRow {
  readonly source_revision_ref: unknown;
  readonly projection_generation: unknown;
  readonly job_id: unknown;
  readonly item_key: unknown;
  readonly canonical_projection_generation: unknown;
  readonly canonical_item_key: unknown;
  readonly project_id: unknown;
  readonly project_membership_id: unknown;
  readonly membership_generation: unknown;
  readonly membership_identity_version: unknown;
  readonly legacy_project_membership_id: unknown;
  readonly stable_project_membership_id: unknown;
  readonly membership_revision: unknown;
  readonly project_membership_generation: unknown;
  readonly copy_layout: unknown;
  readonly metadata_generation_digest: unknown;
  readonly canonical_body_ref: unknown;
  readonly canonical_body_sha256: unknown;
  readonly desired_index: unknown;
  readonly normalized_start_byte: unknown;
  readonly normalized_end_byte: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly attempt_id: unknown;
  readonly execution_operation_id: unknown;
  readonly dispatch_lease_generation: unknown;
  readonly managed_instance_id: unknown;
  readonly managed_generation: unknown;
  readonly provider_source: unknown;
  readonly provider_key: unknown;
  readonly section_content_sha256: unknown;
  readonly document_sha256: unknown;
  readonly document_size_bytes: unknown;
  readonly metadata_json: unknown;
  readonly state: unknown;
  readonly provider_item_id: unknown;
  readonly readback_receipt_json: unknown;
  readonly readback_sha256: unknown;
}

const CUSTOM_METADATA_FIELDS = [
  "canonical_section_id",
  "content_sha256",
  "instruction_taint",
  "projection_generation",
  "source_revision_ref",
] as const;

export function assertManagedItemIntent(
  context: ProjectionSourceContext,
  projectionGeneration: string,
  profile: ProjectionExecutionProfile,
  intent: ManagedItemIntent,
  expectedIndex: number,
  canonicalProjectionGeneration?: string,
): void {
  const maxItems = profile.maximum_synchronous_items * MAX_MANAGED_PROJECT_MEMBERSHIPS;
  assertProjectionInteger(intent.desired_index, "managed item desired index", 0, maxItems - 1);
  assertProjectionIdentifier(intent.item_key, "managed item key");
  assertProjectionIdentifier(intent.provider_key, "managed provider key");
  assertProjectionIdentifier(intent.managed_instance_id, "managed instance ID");
  assertProjectionIdentifier(intent.managed_generation, "managed generation");
  assertProjectionSha256(intent.section_content_sha256, "managed section digest");
  assertProjectionSha256(intent.document_sha256, "managed document digest");
  assertProjectionInteger(
    intent.document_size_bytes,
    "managed document size",
    1,
    profile.maximum_item_utf8_bytes,
  );
  assertProjectionInteger(
    intent.normalized_start_byte,
    "managed item normalized start byte",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  assertProjectionInteger(
    intent.normalized_end_byte,
    "managed item normalized end byte",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const metadataKeys = Object.keys(intent.metadata).sort();
  const projectCopyV1 = intent.copy_layout === "PROJECT_COPY_V1";
  const projectCopyV2 = intent.copy_layout === "PROJECT_COPY_V2";
  const projectCopy = projectCopyV1 || projectCopyV2;
  let copyIdentityValid: boolean;
  if (projectCopyV1 || projectCopyV2) {
    const copyCanonicalGeneration = assertProjectionIdentifier(
      intent.canonical_projection_generation,
      "canonical projection generation",
    );
    const membershipId = assertProjectionIdentifier(intent.project_membership_id, "project membership ID");
    assertProjectionIdentifier(intent.canonical_item_key, "canonical item key");
    const projectId = assertProjectionIdentifier(intent.project_id, "project ID");
    const membershipGeneration = assertProjectionInteger(
      intent.membership_generation,
      "project membership generation",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const metadataGenerationDigest = assertProjectionSha256(
      intent.metadata_generation_digest,
      "managed metadata generation digest",
    );
    const canonicalBodyRef = assertProjectionText(intent.canonical_body_ref, "canonical body reference", 2048);
    const canonicalBodySha256 = assertProjectionSha256(
      intent.canonical_body_sha256,
      "canonical body digest",
    );
    const commonCopyIdentityValid =
      (canonicalProjectionGeneration === undefined ||
        copyCanonicalGeneration === canonicalProjectionGeneration) &&
      /^projection-[a-f0-9]{48}$/u.test(intent.item_key) &&
      intent.provider_key.endsWith(intent.item_key + ".md") &&
      intent.provider_key.length <= 128 &&
      intent.metadata_generation_digest === metadataGenerationDigest &&
      canonicalBodyRef.length > 0 &&
      canonicalBodySha256 === intent.section_content_sha256;
    if (projectCopyV1) {
      const membership = parseManagedProjectMembershipId(membershipId);
      copyIdentityValid = commonCopyIdentityValid &&
        intent.provider_key.startsWith("projection/") &&
        membership.project_id === projectId &&
        membership.membership_generation === membershipGeneration &&
        intent.membership_identity_version === null &&
        intent.legacy_project_membership_id === null &&
        intent.stable_project_membership_id === null &&
        intent.membership_revision === null &&
        intent.project_membership_generation === null;
    } else {
      const identityVersion = assertProjectionInteger(
        intent.membership_identity_version,
        "V2 membership identity version",
        1,
        2,
      );
      const validProviderPath =
        /^projection\/[A-Za-z0-9_-]{43}\/projection-[a-f0-9]{48}\.md$/u.test(intent.provider_key);
      if (identityVersion === 1) {
        const legacyId = assertProjectionIdentifier(
          intent.legacy_project_membership_id,
          "V2-scope legacy membership ID",
        );
        const membership = parseManagedProjectMembershipId(legacyId);
        const aggregateGeneration = assertProjectionInteger(
          intent.project_membership_generation,
          "aggregate project membership generation",
          1,
          Number.MAX_SAFE_INTEGER,
        );
        copyIdentityValid = commonCopyIdentityValid && validProviderPath &&
          membershipId === legacyId && membership.project_id === projectId &&
          membership.membership_generation === membershipGeneration &&
          intent.stable_project_membership_id === null &&
          intent.membership_revision === null &&
          membershipGeneration <= aggregateGeneration;
      } else {
        const stableId = assertProjectionIdentifier(
          intent.stable_project_membership_id,
          "stable project/source membership ID",
        );
        const membershipRevision = assertProjectionInteger(
          intent.membership_revision,
          "per-pair membership revision",
          1,
          Number.MAX_SAFE_INTEGER,
        );
        const aggregateGeneration = assertProjectionInteger(
          intent.project_membership_generation,
          "aggregate project membership generation",
          1,
          Number.MAX_SAFE_INTEGER,
        );
        copyIdentityValid = commonCopyIdentityValid && validProviderPath &&
          /^project-membership-[a-f0-9]{48}$/u.test(stableId) &&
          membershipId === stableId &&
          intent.legacy_project_membership_id === null &&
          membershipRevision > 0 && membershipGeneration <= aggregateGeneration;
      }
    }
  } else {
    copyIdentityValid =
      intent.copy_layout === null &&
      intent.canonical_projection_generation === null &&
      intent.canonical_item_key === null &&
      intent.project_id === null &&
      intent.project_membership_id === null &&
      intent.membership_generation === null &&
      intent.membership_identity_version === null &&
      intent.legacy_project_membership_id === null &&
      intent.stable_project_membership_id === null &&
      intent.membership_revision === null &&
      intent.project_membership_generation === null &&
      intent.metadata_generation_digest === null &&
      intent.canonical_body_ref === null &&
      intent.canonical_body_sha256 === null &&
      intent.provider_key === intent.item_key + ".md";
  }
  if (
    intent.desired_index !== expectedIndex ||
    intent.provider_source !== "builtin" ||
    !copyIdentityValid ||
    intent.normalized_end_byte <= intent.normalized_start_byte ||
    intent.managed_instance_id !== profile.managed_instance_id ||
    intent.managed_generation !== profile.managed_generation ||
    intent.metadata.content_sha256 !== intent.section_content_sha256 ||
    intent.metadata.instruction_taint !== context.instruction_taint ||
    intent.metadata.projection_generation !== (
      projectCopy ? intent.metadata_generation_digest : profile.managed_generation
    ) ||
    (projectCopy && canonicalProjectionGeneration !== undefined &&
      intent.canonical_projection_generation !== canonicalProjectionGeneration) ||
    intent.metadata.source_revision_ref !== context.source_revision.source_revision_ref ||
    metadataKeys.length !== CUSTOM_METADATA_FIELDS.length ||
    metadataKeys.some((key, index) => key !== CUSTOM_METADATA_FIELDS[index]) ||
    typeof intent.metadata.canonical_section_id !== "string" ||
    intent.metadata.canonical_section_id.length === 0 ||
    Object.values(intent.metadata).some((value) => typeof value !== "string")
  ) {
    projectionFail(
      "PROJECTION_INPUT_INVALID",
      "managed item intent differs from the exact source, profile, or five-field metadata",
    );
  }
}

export function decodeEffectRow(
  row: ManagedItemEffectRow,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  profile: ProjectionExecutionProfile,
  operationId: string,
  intent: ManagedItemIntent,
): ManagedItemEffect {
  const receipt = parseManagedItemReceipt(row.readback_receipt_json, "managed item receipt");
  const metadataJson = canonicalProjectionJson(intent.metadata);
  if (
    row.source_revision_ref !== context.source_revision.source_revision_ref ||
    row.projection_generation !== projectionGeneration ||
    row.job_id !== context.job_id ||
    row.item_key !== intent.item_key ||
    row.canonical_projection_generation !== (
      intent.copy_layout === "PROJECT_COPY_V1" || intent.copy_layout === "PROJECT_COPY_V2"
        ? intent.canonical_projection_generation
        : null
    ) ||
    row.canonical_item_key !== intent.canonical_item_key ||
    row.project_id !== intent.project_id ||
    row.project_membership_id !== intent.project_membership_id ||
    row.membership_generation !== intent.membership_generation ||
    row.membership_identity_version !== intent.membership_identity_version ||
    row.legacy_project_membership_id !== intent.legacy_project_membership_id ||
    row.stable_project_membership_id !== intent.stable_project_membership_id ||
    row.membership_revision !== intent.membership_revision ||
    row.project_membership_generation !== intent.project_membership_generation ||
    row.copy_layout !== intent.copy_layout ||
    row.metadata_generation_digest !== intent.metadata_generation_digest ||
    row.canonical_body_ref !== intent.canonical_body_ref ||
    row.canonical_body_sha256 !== intent.canonical_body_sha256 ||
    row.desired_index !== intent.desired_index ||
    row.normalized_start_byte !== intent.normalized_start_byte ||
    row.normalized_end_byte !== intent.normalized_end_byte ||
    row.intent_id !== context.intent_ref.id ||
    row.intent_revision !== context.intent_ref.revision ||
    row.attempt_id !== context.acceptance_attempt_id ||
    row.execution_operation_id !== operationId ||
    row.managed_instance_id !== profile.managed_instance_id ||
    row.managed_generation !== profile.managed_generation ||
    row.provider_source !== intent.provider_source ||
    row.provider_key !== intent.provider_key ||
    row.section_content_sha256 !== intent.section_content_sha256 ||
    row.document_sha256 !== intent.document_sha256 ||
    row.document_size_bytes !== intent.document_size_bytes ||
    row.metadata_json !== metadataJson ||
    (row.state !== "INTENT" && row.state !== "DISPATCHED" &&
      row.state !== "UNKNOWN" && row.state !== "READBACK_VERIFIED")
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "stored managed item intent differs from the exact desired generation",
    );
  }
  const providerItemId = row.provider_item_id === null
    ? null
    : assertProjectionIdentifier(row.provider_item_id, "stored provider item ID");
  if (row.state === "READBACK_VERIFIED") {
    if (
      receipt === null ||
      row.readback_receipt_json !== canonicalProjectionJson(receipt) ||
      providerItemId === null ||
      receipt.item_key !== intent.item_key ||
      receipt.provider_key !== intent.provider_key ||
      receipt.provider_item_id !== providerItemId ||
      receipt.file_size !== intent.document_size_bytes ||
      receipt.content_sha256 !== intent.document_sha256 ||
      row.readback_sha256 !== receipt.readback_sha256
    ) {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "stored managed item readback receipt is incomplete or mismatched",
      );
    }
  } else if (receipt !== null || row.readback_sha256 !== null) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "unverified managed item intent contains a receipt",
    );
  }
  if (
    (row.state === "INTENT" && row.dispatch_lease_generation !== null) ||
    (row.state !== "INTENT" &&
      (typeof row.dispatch_lease_generation !== "number" ||
        !Number.isSafeInteger(row.dispatch_lease_generation) ||
        row.dispatch_lease_generation < 1))
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item dispatch fence is invalid");
  }
  return {
    item_key: intent.item_key,
    state: row.state,
    provider_item_id: providerItemId,
    receipt,
  };
}

export function assertLineage(
  row: ManagedItemEffectRow,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  operationId: string,
): void {
  if (
    row.source_revision_ref !== context.source_revision.source_revision_ref ||
    row.projection_generation !== projectionGeneration ||
    row.job_id !== context.job_id ||
    row.intent_id !== context.intent_ref.id ||
    row.intent_revision !== context.intent_ref.revision ||
    row.attempt_id !== context.acceptance_attempt_id ||
    row.execution_operation_id !== operationId
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item effect lineage changed");
  }
}
