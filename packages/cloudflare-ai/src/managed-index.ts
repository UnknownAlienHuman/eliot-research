import type { ProjectionItem } from "@eliotr/contracts";
import { projectionMetadata } from "@eliotr/platform-cloudflare";
import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  assertProjectionSha256,
  assertProjectionText,
  canonicalProjectionJson,
  profileIsValid,
  projectionDigest,
  projectionSha256Utf8,
  ProjectionRuntimeError,
  projectionFail,
  stableProjectionId,
  type ManagedProjectionPort,
  type ManagedProjectionReceipt,
  type ManagedProjectCopyPlan,
  type ManagedProjectCopyTargetReceipt,
  type ManagedTargetSelectionV2,
  type ProjectionAuthorityPort,
  type ProjectionExecutionProfile,
  type ProjectionManagedItemAuthorityPort,
  type ProjectionSourceContext,
} from "@eliotr/cloudflare-projection";
import {
  listExactManagedItem,
  ManagedItemRecoveryBlockedError,
  ManagedProjectionAdapterError,
  readManagedItem,
  type ManagedItemReceipt,
  type PreparedManagedItem,
  type ProjectionAiSearchInstance,
} from "./managed-index-readback.js";

export interface ProjectionAiSearchNamespace {
  get(instanceId: string): ProjectionAiSearchInstance;
}

type ManagedItemIntent = Parameters<
  NonNullable<ProjectionAuthorityPort["prepareManagedItems"]>
>[3][number];
type ManagedItemEffect = Awaited<
  ReturnType<NonNullable<ProjectionAuthorityPort["prepareManagedItems"]>>
>[number];

type ManagedItemAuthority = ProjectionManagedItemAuthorityPort;
type ManagedExecutionFence = Parameters<ManagedProjectionPort["index"]>[4];
type CurrentManagedTargetReader = (
  fence: ManagedExecutionFence,
  target: ManagedProjectCopyTargetReceipt,
) => Promise<boolean>;

class ManagedProjectionInputError extends Error {
  public readonly reason_code = "PROJECTION_INPUT_INVALID" as const;

  public constructor(cause: ProjectionRuntimeError) {
    super(cause.message, { cause });
    this.name = "ManagedProjectionInputError";
  }
}

class ManagedProjectionCurrentnessError extends Error {
  public readonly reason_code:
    | "MANAGED_GENERATION_STALE"
    | "MANAGED_GENERATION_CURRENTNESS_UNVERIFIED";

  public constructor(
    reasonCode: ManagedProjectionCurrentnessError["reason_code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ManagedProjectionCurrentnessError";
    this.reason_code = reasonCode;
  }
}

async function assertCurrentManagedTarget(
  readCurrentTarget: CurrentManagedTargetReader,
  fence: ManagedExecutionFence,
  target: ManagedProjectCopyTargetReceipt,
): Promise<void> {
  if (typeof readCurrentTarget !== "function") {
    throw new ManagedProjectionCurrentnessError(
      "MANAGED_GENERATION_CURRENTNESS_UNVERIFIED",
      "AI Search managed generation currentness reader is required",
    );
  }
  let current: boolean;
  try {
    current = await readCurrentTarget(fence, target);
  } catch (cause) {
    throw new ManagedProjectionCurrentnessError(
      "MANAGED_GENERATION_CURRENTNESS_UNVERIFIED",
      "AI Search managed generation currentness could not be verified",
      cause,
    );
  }
  if (!current) {
    throw new ManagedProjectionCurrentnessError(
      "MANAGED_GENERATION_STALE",
      "AI Search managed generation registry changed during projection execution",
    );
  }
}

const CUSTOM_METADATA_FIELDS = [
  "canonical_section_id",
  "content_sha256",
  "instruction_taint",
  "projection_generation",
  "source_revision_ref",
] as const;

function managedDocument(item: ProjectionItem): string {
  if (
    typeof item.document_context_header !== "string" ||
    typeof item.section_text !== "string"
  ) {
    projectionFail("PROJECTION_INPUT_INVALID", "projection item document is invalid");
  }
  const header = item.document_context_header.trim();
  return header.length === 0 ? item.section_text : `${header}\n\n${item.section_text}`;
}

function managedItemFilename(itemKey: string): string {
  const key = assertProjectionIdentifier(itemKey, "projection item key");
  const filename = `${key}.md`;
  if (key.includes("/") || filename.length > 128) {
    projectionFail(
      "PROJECTION_INPUT_INVALID",
      "projection item key cannot form a native AI Search filename of at most 128 characters",
    );
  }
  return filename;
}

function managedItemSpan(item: ProjectionItem): {
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
} {
  const match = /^normalized-bytes:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/u.exec(
    item.normalized_offset_map_ref,
  );
  const start = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  const end = match?.[2] === undefined ? Number.NaN : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    projectionFail("PROJECTION_INPUT_INVALID", "projection item normalized byte span is invalid");
  }
  return { normalized_start_byte: start, normalized_end_byte: end };
}

function managedCopyItemIdentity(item: ManagedProjectCopyPlan["items"][number]) {
  return {
    item_key: item.item_key,
    canonical_item_key: item.canonical_item_key,
    canonical_section_id: item.canonical_section_id,
    content_sha256: item.content_sha256,
    normalized_start_byte: item.normalized_start_byte,
    normalized_end_byte: item.normalized_end_byte,
    provider_key: item.provider_key,
    canonical_body_ref: item.canonical_body_ref,
    canonical_body_sha256: item.canonical_body_sha256,
    project_id: item.project_id,
    project_membership_id: item.project_membership_id,
    membership_generation: item.membership_generation,
    copy_layout: item.copy_layout,
    membership_identity_version: item.membership_identity_version,
    legacy_project_membership_id: item.legacy_project_membership_id,
    stable_project_membership_id: item.stable_project_membership_id,
    membership_revision: item.membership_revision,
    project_membership_generation: item.project_membership_generation,
  };
}

function v2SelectionMatches(
  copy: ManagedProjectCopyPlan["copies"][number],
  selection: ManagedTargetSelectionV2 | undefined,
): boolean {
  return copy.protocol === "eliotr.managed-project-copy-map.v2" &&
    selection !== undefined &&
    canonicalProjectionJson(copy.target_selection) === canonicalProjectionJson(selection);
}

async function validateManagedProjectCopyPlan(
  context: ProjectionSourceContext,
  canonicalProjectionGeneration: string,
  profile: ProjectionExecutionProfile,
  copyPlan: ManagedProjectCopyPlan,
): Promise<void> {
  const target = copyPlan.target;
  const v2Plan = copyPlan.layout === "PROJECT_COPY_V2";
  assertProjectionIdentifier(target.managed_instance_id, "managed copy target instance");
  assertProjectionIdentifier(target.managed_generation, "managed copy target generation");
  assertProjectionSha256(target.metadata_generation_digest, "managed copy target metadata digest");
  const expectedMetadataDigest = await projectionSha256Utf8(
    `eliotr.project-copy-generation.v1\u0000${target.managed_generation}`,
  );
  if (target.metadata_generation_digest !== expectedMetadataDigest) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "copy-plan target digest is not bound to its exact managed generation");
  }

  const copyCount = assertProjectionInteger(
    copyPlan.provider_copy_count,
    "managed provider copy count",
    0,
    256,
  );
  const physicalCount = assertProjectionInteger(
    copyPlan.items.length,
    "managed physical item count",
    v2Plan && copyCount === 0 ? 0 : 1,
    profile.maximum_synchronous_items,
  );
  assertProjectionSha256(copyPlan.provider_copy_set_sha256, "managed provider copy-set digest");
  assertProjectionSha256(copyPlan.provider_item_set_sha256, "managed provider item-set digest");
  const emptySetDigest = await projectionDigest([]);
  if (v2Plan) {
    const selection = copyPlan.target_selection;
    if (
      selection === undefined ||
      selection.protocol !== "eliotr.managed-target-selection.v2" ||
      selection.domain !== "MANAGED_SEARCH_PRODUCT" ||
      selection.decision_version !== 2 ||
      selection.selection_mode !== "STABLE_PHYSICAL_PROFILE_V2" ||
      selection.product_alias !== "primary" ||
      selection.target === undefined ||
      selection.target === null ||
      selection.target.managed_instance_id !== target.managed_instance_id ||
      selection.target.managed_generation !== target.managed_generation ||
      copyPlan.scope_snapshot_id === undefined ||
      copyPlan.scope_snapshot_revision === undefined ||
      copyPlan.scope_snapshot_digest === undefined ||
      copyPlan.project_copy_map_index_protocol !== "eliotr.managed-project-copy-map-index.v2" ||
      copyPlan.project_copy_map_index_ref === undefined ||
      copyPlan.project_copy_map_index_sha256 === undefined
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "PROJECT_COPY_V2 plan has no exact selection or erasure index");
    }
    assertProjectionSha256(
      selection.target.target_profile_identity_sha256,
      "V2 target physical profile digest",
    );
    assertProjectionInteger(copyPlan.scope_snapshot_revision, "V2 scope snapshot revision", 1, Number.MAX_SAFE_INTEGER);
    assertProjectionSha256(copyPlan.scope_snapshot_digest, "V2 scope snapshot digest");
    assertProjectionText(copyPlan.scope_snapshot_id, "V2 scope snapshot ID", 256);
    assertProjectionText(copyPlan.project_copy_map_index_ref, "V2 copy-map index ref", 2048);
    assertProjectionSha256(copyPlan.project_copy_map_index_sha256, "V2 copy-map index digest");
    assertProjectionInteger(selection.registry_revision, "V2 target registry revision", 1, Number.MAX_SAFE_INTEGER);
    assertProjectionSha256(selection.registry_artifact_sha256, "V2 target registry artifact digest");
    assertProjectionSha256(selection.v1_exact_profile_identity_sha256, "V2 exact V1 profile digest");
  } else if (
    copyPlan.target_selection !== undefined ||
    copyPlan.scope_snapshot_id !== undefined ||
    copyPlan.scope_snapshot_revision !== undefined ||
    copyPlan.scope_snapshot_digest !== undefined ||
    copyPlan.project_copy_map_index_protocol !== undefined ||
    copyPlan.project_copy_map_index_ref !== undefined ||
    copyPlan.project_copy_map_index_sha256 !== undefined
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "legacy V1/flat plan carries V2 selection or index fields");
  }

  if (copyCount === 0 && !v2Plan) {
    if (
      copyPlan.copies.length !== 0 ||
      copyPlan.provider_item_count !== 0 ||
      copyPlan.provider_copy_set_sha256 !== emptySetDigest ||
      copyPlan.provider_item_set_sha256 !== emptySetDigest
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "flat managed copy plan carries project-copy counts or digests");
    }
    return;
  }

  if (copyCount === 0 && v2Plan) {
    if (
      copyPlan.copies.length !== 0 ||
      copyPlan.provider_item_count !== 0 ||
      physicalCount !== 0 ||
      copyPlan.provider_copy_set_sha256 !== emptySetDigest ||
      copyPlan.provider_item_set_sha256 !== emptySetDigest
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "empty PROJECT_COPY_V2 plan carries provider items");
    }
    return;
  }

  if (
    copyPlan.copies.length !== copyCount ||
    copyPlan.provider_item_count !== physicalCount
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "project-copy plan counts differ from its complete item mapping");
  }
  const expectedProviderItems = await projectionDigest(copyPlan.items.map((item) => ({
    item_key: item.item_key,
    canonical_section_id: item.canonical_section_id,
    content_sha256: item.content_sha256,
    start: item.normalized_start_byte,
    end: item.normalized_end_byte,
  })));
  if (expectedProviderItems !== copyPlan.provider_item_set_sha256) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "project-copy item digest differs from its complete provider plan");
  }

  const mappedItems = [];
  const copySetEntries: Record<string, unknown>[] = [];
  for (const [index, copy] of copyPlan.copies.entries()) {
    const isV2Copy = copy.protocol === "eliotr.managed-project-copy-map.v2";
    if (
      (v2Plan && (!isV2Copy || copy.layout !== "PROJECT_COPY_V2")) ||
      (!v2Plan && copy.protocol !== "eliotr.managed-project-copy-map.v1") ||
      copy.source_revision_ref !== context.source_revision.source_revision_ref ||
      (isV2Copy && copy.source_owner_generation !== context.source_revision.source_owner_generation) ||
      copy.complete_residency_key_sha256 !== context.source_revision.object_residency_key_digest ||
      copy.canonical_projection_generation !== canonicalProjectionGeneration ||
      copy.target.managed_instance_id !== target.managed_instance_id ||
      copy.target.managed_generation !== target.managed_generation ||
      copy.target.metadata_generation_digest !== target.metadata_generation_digest ||
      (v2Plan && !v2SelectionMatches(copy, copyPlan.target_selection)) ||
      copy.provider_copy_count !== 1 ||
      copy.provider_item_count !== copy.items.length
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", `project-copy mapping ${index} differs from its source or target`);
    }
    assertProjectionIdentifier(copy.canonical_source_ref, "managed canonical source reference");
    assertProjectionSha256(copy.canonical_source_sha256, "managed canonical source digest");
    assertProjectionIdentifier(copy.project_id, "managed project ID");
    assertProjectionIdentifier(copy.project_membership_id, "managed project membership ID");
    assertProjectionInteger(copy.membership_generation, "managed project membership generation", 1, Number.MAX_SAFE_INTEGER);
    if (isV2Copy) {
      if (
        !/^projection\/[A-Za-z0-9_-]{43}\/$/u.test(copy.folder_prefix) ||
        new TextEncoder().encode(copy.folder_prefix).byteLength > 64
      ) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", `V2 project-copy mapping ${index} folder is invalid`);
      }
      if (copy.membership_identity_version === 1) {
        const legacyId = assertProjectionIdentifier(copy.legacy_project_membership_id, "V2-scope legacy membership ID");
        assertProjectionInteger(copy.project_membership_generation, "V2 aggregate membership generation", 1, Number.MAX_SAFE_INTEGER);
        if (
          copy.project_membership_id !== legacyId ||
          legacyId !== `project:${copy.project_id}:generation:${copy.membership_generation}` ||
          copy.membership_generation > copy.project_membership_generation ||
          copy.stable_project_membership_id !== undefined || copy.membership_revision !== undefined
        ) {
          projectionFail("PROJECTION_AUTHORITY_CONFLICT", `V2 copy mapping ${index} legacy identity is invalid`);
        }
      } else if (copy.membership_identity_version === 2) {
        const stableId = assertProjectionIdentifier(copy.stable_project_membership_id, "V2 stable membership ID");
        assertProjectionInteger(copy.membership_revision, "V2 membership revision", 1, Number.MAX_SAFE_INTEGER);
        assertProjectionInteger(copy.project_membership_generation, "V2 aggregate membership generation", 1, Number.MAX_SAFE_INTEGER);
        if (
          !/^project-membership-[a-f0-9]{48}$/u.test(stableId) ||
          copy.project_membership_id !== stableId ||
          copy.membership_generation > copy.project_membership_generation ||
          copy.legacy_project_membership_id !== undefined
        ) {
          projectionFail("PROJECTION_AUTHORITY_CONFLICT", `V2 copy mapping ${index} stable identity is invalid`);
        }
      } else {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", `V2 copy mapping ${index} identity version is invalid`);
      }
    }
    assertProjectionSha256(copy.provider_item_set_sha256, "managed project-copy item-set digest");
    assertProjectionSha256(copy.provider_copy_set_sha256, "managed project-copy receipt digest");
    const mapItemSetDigest = await projectionDigest(copy.items.map((item) => ({
      item_key: item.item_key,
      canonical_section_id: item.canonical_section_id,
      content_sha256: item.content_sha256,
      start: item.normalized_start_byte,
      end: item.normalized_end_byte,
    })));
    if (mapItemSetDigest !== copy.provider_item_set_sha256) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", `project-copy mapping ${index} item digest differs`);
    }
    if (isV2Copy) {
      for (const mapped of copy.items) {
        const itemKey = assertProjectionIdentifier(mapped.item_key, "V2 copy map provider item key");
        const providerKey = assertProjectionText(mapped.provider_key, "V2 copy map provider key", 128);
        if (
          !/^projection-[a-f0-9]{48}$/u.test(itemKey) ||
          !providerKey.startsWith(copy.folder_prefix) ||
          !providerKey.endsWith(`${itemKey}.md`)
        ) {
          projectionFail("PROJECTION_AUTHORITY_CONFLICT", `V2 copy mapping ${index} provider key differs from its folder`);
        }
        assertProjectionIdentifier(mapped.canonical_item_key, "V2 canonical item key");
        assertProjectionIdentifier(mapped.canonical_body_ref, "V2 canonical body ref");
        assertProjectionSha256(mapped.canonical_body_sha256, "V2 canonical body digest");
      }
    }
    const { provider_copy_set_sha256: copyDigest, ...copyPayload } = copy;
    if (await projectionDigest(copyPayload) !== copyDigest) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", `project-copy mapping ${index} receipt digest differs`);
    }
    copySetEntries.push(isV2Copy
      ? {
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
      }
      : {
        project_id: copy.project_id,
        project_membership_id: copy.project_membership_id,
        membership_generation: copy.membership_generation,
        provider_copy_set_sha256: copy.provider_copy_set_sha256,
      });
    for (const item of copy.items) {
      mappedItems.push({
        item_key: item.item_key,
        canonical_item_key: item.canonical_item_key,
        canonical_section_id: item.canonical_section_id,
        content_sha256: item.content_sha256,
        normalized_start_byte: item.normalized_start_byte,
        normalized_end_byte: item.normalized_end_byte,
        provider_key: item.provider_key,
        canonical_body_ref: item.canonical_body_ref,
        canonical_body_sha256: item.canonical_body_sha256,
        project_id: copy.project_id,
        project_membership_id: copy.project_membership_id,
        membership_generation: copy.membership_generation,
        copy_layout: isV2Copy ? "PROJECT_COPY_V2" : "PROJECT_COPY_V1",
        membership_identity_version: isV2Copy ? copy.membership_identity_version : null,
        legacy_project_membership_id: isV2Copy && copy.membership_identity_version === 1
          ? copy.legacy_project_membership_id
          : null,
        stable_project_membership_id: isV2Copy && copy.membership_identity_version === 2
          ? copy.stable_project_membership_id
          : null,
        membership_revision: isV2Copy && copy.membership_identity_version === 2
          ? copy.membership_revision
          : null,
        project_membership_generation: isV2Copy ? copy.project_membership_generation : null,
      });
    }
  }
  const expectedCopySet = await projectionDigest(copySetEntries);
  if (
    expectedCopySet !== copyPlan.provider_copy_set_sha256 ||
    canonicalProjectionJson(mappedItems) !== canonicalProjectionJson(copyPlan.items.map(managedCopyItemIdentity))
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "provider items differ from their complete body-free copy mappings");
  }
}

function profileForCopyPlan(
  base: ProjectionExecutionProfile,
  copyPlan: ManagedProjectCopyPlan,
): ProjectionExecutionProfile {
  if (
    copyPlan.target.managed_instance_id !== base.managed_instance_id ||
    copyPlan.target.managed_generation !== base.managed_generation
  ) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "copy-plan target differs from its target-scoped AI Search port");
  }
  const profile = Object.freeze({
    ...base,
    managed_instance_id: copyPlan.target.managed_instance_id,
    managed_generation: copyPlan.target.managed_generation,
  });
  profileIsValid(profile);
  return profile;
}

async function prepareManagedItems(
  context: ProjectionSourceContext,
  canonicalProjectionGeneration: string,
  profile: ProjectionExecutionProfile,
  copyPlan: ManagedProjectCopyPlan,
): Promise<readonly PreparedManagedItem[]> {
  const items = copyPlan.items;
  const v2Plan = copyPlan.layout === "PROJECT_COPY_V2";
  const emptyV2Plan = v2Plan && copyPlan.provider_copy_count === 0 &&
    copyPlan.provider_item_count === 0 && copyPlan.items.length === 0;
  if (!Array.isArray(items)) {
    projectionFail("PROJECTION_INPUT_INVALID", "managed projection desired set is invalid");
  }
  assertProjectionInteger(
    items.length,
    "managed projection item count",
    emptyV2Plan ? 0 : 1,
    profile.maximum_synchronous_items,
  );
  const seenKeys = new Set<string>();
  const prepared: PreparedManagedItem[] = [];
  for (const [index, item] of items.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      projectionFail("PROJECTION_INPUT_INVALID", `managed projection item ${index} is invalid`);
    }
    const itemKey = assertProjectionIdentifier(item.item_key, `projection item ${index}.item_key`);
    const filename = managedItemFilename(itemKey);
    const key = assertProjectionText(item.provider_key, `projection item ${index}.provider_key`, 128);
    if (
      (item.copy_layout === null && key !== filename) ||
      ((item.copy_layout === "PROJECT_COPY_V1" || item.copy_layout === "PROJECT_COPY_V2") &&
        !key.endsWith(`/${filename}`))
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "provider key differs from its complete managed copy plan");
    }
    const span = managedItemSpan(item);
    if (seenKeys.has(itemKey)) {
      projectionFail("PROJECTION_INPUT_INVALID", "managed projection desired set has duplicate item keys");
    }
    seenKeys.add(itemKey);
    if (item.source_revision_ref !== context.source_revision.source_revision_ref) {
      projectionFail(
        "PROJECTION_INPUT_INVALID",
        "projection item source revision differs from the execution context",
      );
    }
    const expectedProjectionGeneration = item.copy_layout === "PROJECT_COPY_V1" || item.copy_layout === "PROJECT_COPY_V2"
      ? copyPlan.target.metadata_generation_digest
      : canonicalProjectionGeneration;
    if (
      item.projection_generation !== expectedProjectionGeneration ||
      item.canonical_projection_generation !== canonicalProjectionGeneration
    ) {
      projectionFail(
        "PROJECTION_INPUT_INVALID",
        "projection item generation differs from the canonical and managed target pins",
      );
    }
    if (
      span.normalized_start_byte !== item.normalized_start_byte ||
      span.normalized_end_byte !== item.normalized_end_byte
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item span differs from its copy-plan proof");
    }
    assertProjectionIdentifier(item.canonical_section_id, "projection item canonical_section_id");
    assertProjectionIdentifier(item.source_revision_ref, "projection item source_revision_ref");
    assertProjectionSha256(item.content_sha256, "projection item content_sha256");
    const document = managedDocument(item);
    const size = new TextEncoder().encode(document).byteLength;
    if (
      size < 1 ||
      size > profile.maximum_item_utf8_bytes ||
      size > 4 * 1024 * 1024
    ) {
      projectionFail(
        "PROJECTION_INPUT_INVALID",
        "managed projection item exceeds the AI Search Items API file envelope",
      );
    }
    if (await projectionSha256Utf8(item.section_text) !== item.content_sha256) {
      projectionFail(
        "PROJECTION_INPUT_INVALID",
        "projection item content digest differs from its section bytes",
      );
    }
    if (item.copy_layout === "PROJECT_COPY_V1") {
      if (
        item.canonical_item_key === null ||
        item.project_id === null ||
        item.project_membership_id === null ||
        item.membership_generation === null ||
        item.metadata_generation_digest !== copyPlan.target.metadata_generation_digest ||
        item.canonical_body_ref === null ||
        item.canonical_body_sha256 !== item.content_sha256 ||
        item.membership_identity_version !== null ||
        item.legacy_project_membership_id !== null ||
        item.stable_project_membership_id !== null ||
        item.membership_revision !== null ||
        item.project_membership_generation !== null
      ) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "PROJECT_COPY_V1 item lacks its canonical mapping proof");
      }
      assertProjectionIdentifier(item.canonical_item_key, "managed canonical item key");
      assertProjectionIdentifier(item.project_id, "managed project ID");
      assertProjectionIdentifier(item.project_membership_id, "managed project membership ID");
      assertProjectionInteger(item.membership_generation, "managed project membership generation", 1, Number.MAX_SAFE_INTEGER);
      assertProjectionText(item.canonical_body_ref, "managed canonical body reference", 2048);
      assertProjectionSha256(item.canonical_body_sha256, "managed canonical body digest");
      if (
        item.project_membership_ids.length !== 1 ||
        item.project_membership_ids[0] !== item.project_membership_id
      ) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "PROJECT_COPY_V1 item membership list differs from its copy mapping");
      }
    } else if (item.copy_layout === "PROJECT_COPY_V2") {
      if (
        item.canonical_item_key === null ||
        item.project_id === null ||
        item.project_membership_id === null ||
        item.membership_generation === null ||
        item.metadata_generation_digest !== copyPlan.target.metadata_generation_digest ||
        item.canonical_body_ref === null ||
        item.canonical_body_sha256 !== item.content_sha256 ||
        (item.membership_identity_version !== 1 && item.membership_identity_version !== 2)
      ) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "PROJECT_COPY_V2 item lacks its canonical identity proof");
      }
      assertProjectionIdentifier(item.canonical_item_key, "V2 managed canonical item key");
      assertProjectionIdentifier(item.project_id, "V2 managed project ID");
      assertProjectionIdentifier(item.project_membership_id, "V2 managed membership ID");
      assertProjectionInteger(item.membership_generation, "V2 opening membership generation", 1, Number.MAX_SAFE_INTEGER);
      if (item.membership_identity_version === 1) {
        const legacyId = assertProjectionIdentifier(item.legacy_project_membership_id, "V2-scope legacy membership ID");
        assertProjectionInteger(item.project_membership_generation, "V2 aggregate membership generation", 1, Number.MAX_SAFE_INTEGER);
        if (
          item.project_membership_id !== legacyId ||
          legacyId !== `project:${item.project_id}:generation:${item.membership_generation}` ||
          item.stable_project_membership_id !== null || item.membership_revision !== null ||
          item.membership_generation > item.project_membership_generation
        ) {
          projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2-scope legacy copy identity is invalid");
        }
      } else {
        const stableId = assertProjectionIdentifier(item.stable_project_membership_id, "V2 stable membership ID");
        assertProjectionInteger(item.membership_revision, "V2 membership revision", 1, Number.MAX_SAFE_INTEGER);
        assertProjectionInteger(item.project_membership_generation, "V2 aggregate membership generation", 1, Number.MAX_SAFE_INTEGER);
        if (
          !/^project-membership-[a-f0-9]{48}$/u.test(stableId) ||
          item.project_membership_id !== stableId ||
          item.legacy_project_membership_id !== null ||
          item.membership_generation > item.project_membership_generation
        ) {
          projectionFail("PROJECTION_AUTHORITY_CONFLICT", "V2 stable copy identity is invalid");
        }
      }
      assertProjectionText(item.canonical_body_ref, "V2 canonical body reference", 2048);
      assertProjectionSha256(item.canonical_body_sha256, "V2 canonical body digest");
      if (
        item.project_membership_ids.length !== 1 ||
        item.project_membership_ids[0] !== item.project_membership_id
      ) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "PROJECT_COPY_V2 membership list differs from its mapping");
      }
    } else if (
      item.copy_layout !== null ||
      item.canonical_item_key !== null ||
      item.project_id !== null ||
      item.project_membership_id !== null ||
      item.membership_generation !== null ||
      item.membership_identity_version !== null ||
      item.legacy_project_membership_id !== null ||
      item.stable_project_membership_id !== null ||
      item.membership_revision !== null ||
      item.project_membership_generation !== null ||
      item.metadata_generation_digest !== null ||
      item.canonical_body_ref !== null ||
      item.canonical_body_sha256 !== null
    ) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "flat managed item carries project-copy identity fields");
    }
    // AI Search's projection_generation is the managed profile generation; the
    // source-specific generation remains in the durable Eliot intent lineage.
    const metadata = Object.freeze({
      ...projectionMetadata(item),
      projection_generation: item.copy_layout === "PROJECT_COPY_V1" || item.copy_layout === "PROJECT_COPY_V2"
        ? copyPlan.target.metadata_generation_digest
        : profile.managed_generation,
    });
    if (
      Object.keys(metadata).sort().join("\u0000") !== CUSTOM_METADATA_FIELDS.join("\u0000") ||
      Object.values(metadata).some((value) => typeof value !== "string")
    ) {
      projectionFail("PROJECTION_INPUT_INVALID", "managed projection custom metadata is invalid");
    }
    prepared.push(Object.freeze({
      item_key: itemKey,
      key,
      document,
      size,
      ...span,
      document_sha256: await projectionSha256Utf8(document),
      metadata,
    }));
  }
  return Object.freeze(prepared);
}

function assertManagedItemAuthority(
  authority: ProjectionAuthorityPort,
): asserts authority is ManagedItemAuthority {
  if (
    typeof authority.prepareManagedItems !== "function" ||
    typeof authority.beginManagedItemDispatch !== "function" ||
    typeof authority.recordManagedItemProviderId !== "function" ||
    typeof authority.recordManagedItemReceipt !== "function" ||
    typeof authority.markManagedItemUnknown !== "function" ||
    typeof authority.readManagedItemGenerationProof !== "function"
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "durable managed item authority is unavailable",
    );
  }
}

function managedItemIntents(
  prepared: readonly PreparedManagedItem[],
  copyPlan: ManagedProjectCopyPlan,
): readonly ManagedItemIntent[] {
  return Object.freeze(prepared.map((item, desiredIndex) => {
    const planned = copyPlan.items[desiredIndex];
    if (planned === undefined || planned.item_key !== item.item_key || planned.provider_key !== item.key) {
      projectionFail("PROJECTION_AUTHORITY_CONFLICT", "prepared provider item differs from the complete copy plan");
    }
    return {
    desired_index: desiredIndex,
    item_key: item.item_key,
    provider_key: item.key,
    copy_layout: planned.copy_layout,
    canonical_projection_generation: planned.copy_layout === null
      ? null
      : planned.canonical_projection_generation,
    canonical_item_key: planned.canonical_item_key,
    project_id: planned.project_id,
    project_membership_id: planned.project_membership_id,
    membership_generation: planned.membership_generation,
    membership_identity_version: planned.membership_identity_version,
    legacy_project_membership_id: planned.legacy_project_membership_id,
    stable_project_membership_id: planned.stable_project_membership_id,
    membership_revision: planned.membership_revision,
    project_membership_generation: planned.project_membership_generation,
    metadata_generation_digest: planned.metadata_generation_digest,
    canonical_body_ref: planned.canonical_body_ref,
    canonical_body_sha256: planned.canonical_body_sha256,
    provider_source: "builtin" as const,
    managed_instance_id: copyPlan.target.managed_instance_id,
    managed_generation: copyPlan.target.managed_generation,
    section_content_sha256: assertProjectionSha256(
      item.metadata.content_sha256,
      "managed section content digest",
    ),
    normalized_start_byte: item.normalized_start_byte,
    normalized_end_byte: item.normalized_end_byte,
    document_sha256: item.document_sha256,
    document_size_bytes: item.size,
    metadata: item.metadata,
    };
  }));
}

function effectFor(effects: readonly ManagedItemEffect[], itemKey: string): ManagedItemEffect {
  const effect = effects.find((candidate) => candidate.item_key === itemKey);
  if (effect === undefined) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "durable managed item intent readback is incomplete");
  }
  return effect;
}

function ackItemId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  if (typeof id !== "string") return null;
  try {
    return assertProjectionIdentifier(id, "AI Search upload acknowledgement ID");
  } catch {
    return null;
  }
}

async function recoverManagedItem(
  authority: ManagedItemAuthority,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  target: ManagedProjectCopyTargetReceipt,
  fence: ManagedExecutionFence,
  instance: ProjectionAiSearchInstance,
  item: PreparedManagedItem,
  effect: ManagedItemEffect,
  readCurrentTarget: CurrentManagedTargetReader,
): Promise<ManagedItemReceipt> {
  await assertCurrentManagedTarget(readCurrentTarget, fence, target);
  let listed;
  try {
    listed = await listExactManagedItem(instance, item);
  } catch (error) {
    await authority.markManagedItemUnknown(context, projectionGeneration, item.item_key, fence);
    throw error;
  }
  if (listed === null) {
    await authority.markManagedItemUnknown(context, projectionGeneration, item.item_key, fence);
    throw new ManagedItemRecoveryBlockedError(
      `AI Search item ${item.key} is absent from the exact built-in source listing`,
    );
  }
  if (effect.provider_item_id !== null && effect.provider_item_id !== listed.id) {
    throw new ManagedItemRecoveryBlockedError(
      `AI Search exact item ${item.key} has a foreign provider ID`,
    );
  }
  await authority.recordManagedItemProviderId(
    context,
    projectionGeneration,
    item.item_key,
    listed.id,
    fence,
  );
  await assertCurrentManagedTarget(readCurrentTarget, fence, target);
  const receipt = await readManagedItem(instance, item, listed.id, listed);
  await assertCurrentManagedTarget(readCurrentTarget, fence, target);
  if (
    effect.receipt !== null &&
    canonicalProjectionJson(effect.receipt) !== canonicalProjectionJson(receipt)
  ) {
    throw new ManagedItemRecoveryBlockedError(
      `AI Search exact item ${item.key} differs from its durable readback receipt`,
    );
  }
  await authority.recordManagedItemReceipt(context, projectionGeneration, receipt, fence);
  return receipt;
}

async function indexManagedItem(
  authority: ManagedItemAuthority,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  target: ManagedProjectCopyTargetReceipt,
  fence: ManagedExecutionFence,
  profile: ProjectionExecutionProfile,
  instance: ProjectionAiSearchInstance,
  item: PreparedManagedItem,
  effect: ManagedItemEffect,
  intent: ManagedItemIntent,
  readCurrentTarget: CurrentManagedTargetReader,
): Promise<ManagedItemReceipt> {
  if (effect.state !== "INTENT") {
    return recoverManagedItem(
      authority,
      context,
      projectionGeneration,
      target,
      fence,
      instance,
      item,
      effect,
      readCurrentTarget,
    );
  }
  await assertCurrentManagedTarget(readCurrentTarget, fence, target);
  if (profile.managed_generation_active) {
    throw new ManagedProjectionAdapterError(
      "new target-bound managed item keys must be built in a shadow generation before the active generation is changed",
    );
  }
  const dispatchAllowed = await authority.beginManagedItemDispatch(
    context,
    projectionGeneration,
    item.item_key,
    fence,
  );
  if (!dispatchAllowed) {
    // The exact item already left INTENT under another fenced attempt.
    const refreshed = await authority.prepareManagedItems(
      context,
      projectionGeneration,
      profile,
      [intent],
      fence,
    );
    return recoverManagedItem(
      authority,
      context,
      projectionGeneration,
      target,
      fence,
      instance,
      item,
      effectFor(refreshed, item.item_key),
      readCurrentTarget,
    );
  }

  try {
    await assertCurrentManagedTarget(readCurrentTarget, fence, target);
    const acknowledgement = await instance.items.uploadAndPoll(item.key, item.document, {
      metadata: item.metadata,
      pollIntervalMs: profile.managed_poll_interval_ms,
      timeoutMs: profile.managed_timeout_ms,
    });
    const acknowledgedId = ackItemId(acknowledgement);
    if (acknowledgedId !== null) {
      await authority.recordManagedItemProviderId(
        context,
        projectionGeneration,
        item.item_key,
        acknowledgedId,
        fence,
      );
    }
  } catch (error) {
    await authority.markManagedItemUnknown(context, projectionGeneration, item.item_key, fence);
    if (
      error instanceof ManagedItemRecoveryBlockedError ||
      error instanceof ManagedProjectionCurrentnessError
    ) throw error;
    // The durable DISPATCHED state forbids a second upload; recovery is read-only.
  }
  // Dispatch/unknown state changed only for this item; keep the full manifest out of the refresh.
  const refreshed = await authority.prepareManagedItems(
    context,
    projectionGeneration,
    profile,
    [intent],
    fence,
  );
  return recoverManagedItem(
    authority,
    context,
    projectionGeneration,
    target,
    fence,
    instance,
    item,
    effectFor(refreshed, item.item_key),
    readCurrentTarget,
  );
}

export interface ManagedProjectionDependencies {
  readonly namespace: ProjectionAiSearchNamespace;
  readonly profile: ProjectionExecutionProfile;
  readonly authority: ManagedItemAuthority;
  readonly isCurrentTarget: CurrentManagedTargetReader;
}

export function createManagedProjectionPort(
  dependencies: ManagedProjectionDependencies,
): ManagedProjectionPort {
  return {
    async index(
      context,
      executionGeneration,
      canonicalProjectionGeneration,
      copyPlan,
      fence,
    ): Promise<ManagedProjectionReceipt> {
      const itemCount = Array.isArray(copyPlan?.items) ? copyPlan.items.length : 0;
      const fallbackTarget = copyPlan?.target ?? {
        managed_instance_id: dependencies.profile.managed_instance_id,
        managed_generation: dependencies.profile.managed_generation,
        metadata_generation_digest: "",
      };
      try {
        assertProjectionIdentifier(executionGeneration, "managed execution generation");
        assertProjectionIdentifier(canonicalProjectionGeneration, "canonical projection generation");
        const profile = profileForCopyPlan(dependencies.profile, copyPlan);
        await validateManagedProjectCopyPlan(
          context,
          canonicalProjectionGeneration,
          profile,
          copyPlan,
        );
        await assertCurrentManagedTarget(dependencies.isCurrentTarget, fence, copyPlan.target);
        let prepared: readonly PreparedManagedItem[];
        try {
          prepared = await prepareManagedItems(
            context,
            canonicalProjectionGeneration,
            profile,
            copyPlan,
          );
        } catch (error) {
          if (error instanceof ProjectionRuntimeError) {
            throw new ManagedProjectionInputError(error);
          }
          throw error;
        }
        assertManagedItemAuthority(dependencies.authority);
        const intents = managedItemIntents(prepared, copyPlan);
        const effects = await dependencies.authority.prepareManagedItems(
          context,
          executionGeneration,
          profile,
          intents,
          fence,
          copyPlan,
        );
        if (
          effects.length !== prepared.length ||
          effects.some((effect, index) => effect.item_key !== prepared[index]?.item_key)
        ) {
          projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item intents are not the exact desired set");
        }
        const instance = dependencies.namespace.get(copyPlan.target.managed_instance_id);
        const receipts: ManagedItemReceipt[] = [];
        for (let index = 0; index < prepared.length; index += 1) {
          const item = prepared[index];
          const effect = effects[index];
          const intent = intents[index];
          if (item === undefined || effect === undefined || intent === undefined) {
            projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item progress is incomplete");
          }
          receipts.push(await indexManagedItem(
            dependencies.authority,
            context,
            executionGeneration,
            copyPlan.target,
            fence,
            profile,
            instance,
            item,
            effect,
            intent,
            dependencies.isCurrentTarget,
          ));
        }
        if (receipts.length !== prepared.length) {
          throw new ManagedProjectionAdapterError(
            "AI Search settled item count differs from the prepared desired set",
          );
        }
        const readbackDigest = await projectionDigest(receipts);
        const receiptRef = await stableProjectionId(
          "managed-search-receipt",
          context.source_revision.source_revision_ref,
          executionGeneration,
          copyPlan.target.managed_generation,
          readbackDigest,
        );
        await assertCurrentManagedTarget(dependencies.isCurrentTarget, fence, copyPlan.target);
        if (!profile.managed_generation_active) {
          return {
            state: "DEGRADED",
            item_count: prepared.length,
            instance_id: copyPlan.target.managed_instance_id,
            managed_generation: copyPlan.target.managed_generation,
            shadow_receipt_ref: receiptRef,
            shadow_readback_digest: readbackDigest,
            reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
          };
        }
        return {
          state: "READY",
          receipt_ref: receiptRef,
          readback_digest: readbackDigest,
          item_count: prepared.length,
          instance_id: copyPlan.target.managed_instance_id,
          managed_generation: copyPlan.target.managed_generation,
          reason_codes: [],
        };
      } catch (error) {
        if (
          error instanceof ManagedItemRecoveryBlockedError ||
          (error instanceof ProjectionRuntimeError && error.retryable)
        ) {
          throw error;
        }
        return {
          state: "DEGRADED",
          item_count: itemCount,
          instance_id: fallbackTarget.managed_instance_id,
          managed_generation: fallbackTarget.managed_generation,
          reason_codes: [
            error instanceof ManagedProjectionCurrentnessError
              ? error.reason_code
              : error instanceof ManagedProjectionInputError || error instanceof ManagedProjectionAdapterError
              ? error.reason_code
              : "MANAGED_INDEX_READBACK_FAILED",
          ],
        };
      }
    },
  };
}
