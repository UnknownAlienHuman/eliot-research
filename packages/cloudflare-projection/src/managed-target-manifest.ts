import type { AiSearchInstanceProfile, EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import {
  assertProjectionIdentifier,
  assertProjectionSha256,
  canonicalProjectionJson,
  projectionDigest,
  projectionSha256Utf8,
  projectionByteStream,
  profileIsValid,
  utf8ProjectionBytes,
} from "./canonical.js";
import type { ManagedTargetIdentity } from "./managed-target-assignment.js";
import {
  MANAGED_REQUIRED_ITEM_COPY_LAYOUT,
  projectManagedRequiredItemCopy,
} from "./projection/managed-required-items.js";
import {
  enumerateManagedRequiredSet,
  type ManagedRequiredProjectRevisionCopy,
} from "./managed-required-set.js";

export const MANAGED_TARGET_MANIFEST_PROTOCOL = "eliotr.managed-target-desired-items.v2" as const;
export const MANAGED_TARGET_MANIFEST_COPY_LAYOUT = MANAGED_REQUIRED_ITEM_COPY_LAYOUT;

const MAX_TREE_FANOUT = 256;
const SHA256 = /^[a-f0-9]{64}$/u;

import {
  type ManagedTargetManifestShadowFence,
  type ManagedTargetManifestProfile,
  type ManagedTargetManifestSourceAuthority,
  type ManagedTargetManifestInput,
  type ManagedTargetManifestReceipt,
  type ManagedTargetManifestErrorCode,
  ManagedTargetManifestError
} from "./managed-target-manifest-contract.js";
export {
  type ManagedTargetManifestShadowState,
  type ManagedTargetManifestShadowFence,
  type ManagedTargetManifestShadowAuthorityPort,
  type ManagedTargetManifestProfile,
  type ManagedTargetManifestSourceAuthority,
  type ManagedTargetManifestDocument,
  type ManagedTargetManifestDocumentPort,
  type ManagedTargetManifestInput,
  type ManagedTargetManifestReceipt,
  type ManagedTargetManifestErrorCode,
  ManagedTargetManifestError
} from "./managed-target-manifest-contract.js";

function fail(code: ManagedTargetManifestErrorCode, message: string, cause?: unknown): never {
  throw new ManagedTargetManifestError(code, message, cause);
}

function canonicalAiSearchProfile(profile: AiSearchInstanceProfile): AiSearchInstanceProfile {
  return Object.freeze({
    ...profile,
    index_method: Object.freeze({ ...profile.index_method }),
    metadata_fields: Object.freeze([...profile.metadata_fields].sort()),
  });
}

function validateTarget(target: ManagedTargetIdentity): void {
  assertProjectionIdentifier(target.namespace, "target namespace");
  assertProjectionIdentifier(target.managed_instance_id, "managed instance id");
  assertProjectionIdentifier(target.managed_generation, "managed generation");
  assertProjectionSha256(target.target_profile_identity_sha256, "target profile identity digest");
}

function validateProfile(target: ManagedTargetIdentity, profile: ManagedTargetManifestProfile): void {
  if (profile.copy_layout !== MANAGED_TARGET_MANIFEST_COPY_LAYOUT) {
    fail("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "target-wide manifests require an explicit PROJECT_COPY_V1 layout");
  }
  try { profileIsValid(profile.projection_profile); }
  catch (cause) { fail("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "projection profile failed canonical profile validation", cause); }
  const targetProfile = canonicalAiSearchProfile(profile.target_profile);
  if (
    targetProfile.id !== target.managed_instance_id ||
    targetProfile.generation !== target.managed_generation ||
    profile.projection_profile.managed_instance_id !== target.managed_instance_id ||
    profile.projection_profile.managed_generation !== target.managed_generation ||
    profile.projection_profile.managed_generation_active
  ) {
    fail("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "projection and immutable target profiles do not identify this non-active generation");
  }
}

function validateShadowFence(
  fence: ManagedTargetManifestShadowFence,
  target: ManagedTargetIdentity,
): void {
  if (
    fence.registry_revision !== null &&
    (!Number.isSafeInteger(fence.registry_revision) || fence.registry_revision < 1)
  ) fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "SEARCH_DB registry revision is invalid");
  if (fence.registry_sha256 !== null && !SHA256.test(fence.registry_sha256)) {
    fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "SEARCH_DB registry digest is invalid");
  }
  if ((fence.registry_revision === null) !== (fence.registry_sha256 === null)) {
    fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "SEARCH_DB registry revision and digest are incomplete");
  }
  if (fence.active_head_generation !== null) {
    assertProjectionIdentifier(fence.active_head_generation, "active managed generation");
  }
  if (fence.active_head_generation === target.managed_generation ||
      fence.generation_state === "ACTIVE" ||
      fence.generation_state === "RETIRED" ||
      fence.generation_state === "BLOCKED") {
    fail("MANAGED_TARGET_MANIFEST_SHADOW_REQUIRED", "PROJECT_COPY_V1 is limited to a declared or fresh shadow generation");
  }
  if (fence.generation_state === "UNDECLARED") {
    if (fence.generation_profile_identity_sha256 !== null || fence.expected_item_count !== null) {
      fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "undeclared registry generation carries record fields");
    }
    return;
  }
  if (
    fence.generation_state !== "DECLARED" &&
    fence.generation_state !== "SHADOW_BUILDING" &&
    fence.generation_state !== "SHADOW_COMPLETE"
  ) fail("MANAGED_TARGET_MANIFEST_SHADOW_REQUIRED", "target generation is not in a shadow state");
  if (fence.generation_profile_identity_sha256 !== target.target_profile_identity_sha256) {
    fail("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "SEARCH_DB generation profile differs from the assigned immutable profile");
  }
  if (!Number.isSafeInteger(fence.expected_item_count) || (fence.expected_item_count ?? 0) < 1) {
    fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "declared shadow item count is invalid");
  }
}

async function shadowFingerprint(fence: ManagedTargetManifestShadowFence): Promise<string> {
  return projectionDigest({
    protocol: "eliotr.managed-target-shadow-fence.v1",
    registry_revision: fence.registry_revision,
    registry_sha256: fence.registry_sha256,
    active_head_generation: fence.active_head_generation,
    generation_state: fence.generation_state,
    generation_profile_identity_sha256: fence.generation_profile_identity_sha256,
    expected_item_count: fence.expected_item_count,
  });
}

function validateAuthority(
  copy: ManagedRequiredProjectRevisionCopy,
  authority: ManagedTargetManifestSourceAuthority,
): void {
  const revision = authority.source_revision;
  if (
    revision.source_revision_ref !== copy.source_revision_ref ||
    revision.source_id !== copy.source_id ||
    revision.source_namespace_id !== copy.source_namespace_id ||
    revision.source_owner_system_id !== copy.source_owner_system_id ||
    revision.source_owner_generation !== copy.source_owner_generation ||
    revision.ownership_mode !== copy.source_ownership_mode ||
    revision.content_sha256 !== copy.source_revision_content_sha256 ||
    revision.object_residency_key_digest.length !== 64 ||
    revision.normalized_artifact_ref !== copy.normalized_artifact_ref ||
    revision.purge_state !== "LIVE" ||
    typeof authority.source_title !== "string" || authority.source_title.length === 0 ||
    authority.source_class !== copy.source_class ||
    !["CLEARED", "DATA_ONLY", "UNTRUSTED", "COMMAND_LIKE"].includes(authority.instruction_taint)
  ) {
    fail("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "Core source authority differs from its required-set copy");
  }
  assertProjectionSha256(revision.content_sha256, "source revision content digest");
  assertProjectionSha256(revision.object_residency_key_digest, "source residency digest");
  assertProjectionIdentifier(authority.source_class, "source class");
}

async function sourceAuthorityFingerprint(
  target: ManagedTargetIdentity,
  profile: ManagedTargetManifestProfile,
  copy: ManagedRequiredProjectRevisionCopy,
  authority: ManagedTargetManifestSourceAuthority,
): Promise<string> {
  validateAuthority(copy, authority);
  const authorityFields: ManagedTargetManifestSourceAuthority = {
    source_revision: authority.source_revision,
    source_title: authority.source_title,
    source_class: authority.source_class,
    instruction_taint: authority.instruction_taint,
  };
  return projectionDigest({
    protocol: "eliotr.managed-target-source-projection-authority.v1",
    target,
    copy_layout: profile.copy_layout,
    projection_profile: {
      projector_profile: profile.projection_profile.projector_profile,
      target_item_utf8_bytes: profile.projection_profile.target_item_utf8_bytes,
      maximum_item_utf8_bytes: profile.projection_profile.maximum_item_utf8_bytes,
      maximum_markdown_bytes: profile.projection_profile.maximum_markdown_bytes,
    },
    project_membership_id: copy.project_membership_id,
    authority: authorityFields,
  });
}

interface ManifestObjectRef {
  readonly kind: "COPY" | "INDEX";
  readonly key: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly first_copy_ordinal: number;
  readonly last_copy_ordinal: number;
  readonly copy_count: number;
  readonly item_count: number;
}

async function putCanonicalObject(
  store: EvidenceObjectStore,
  key: string,
  value: unknown,
  metadata: Readonly<Record<string, string>>,
): Promise<{ readonly key: string; readonly sha256: string; readonly size_bytes: number }> {
  const json = canonicalProjectionJson(value);
  const bytes = utf8ProjectionBytes(json);
  const sha256 = await projectionSha256Utf8(json);
  const receipt = await store.putImmutable({
    key,
    body: projectionByteStream(bytes),
    expected_sha256: sha256,
    expected_size_bytes: bytes.byteLength,
    content_type: "application/json; charset=utf-8",
    custom_metadata: { ...metadata, manifest_sha256: sha256 },
  });
  if (receipt.key !== key || receipt.readback_sha256 !== sha256 || receipt.size_bytes !== bytes.byteLength) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "immutable R2 manifest readback differs from the staged bytes");
  }
  return Object.freeze({ key, sha256, size_bytes: bytes.byteLength });
}

class ManifestTreeWriter {
  private readonly levels: ManifestObjectRef[][] = [];

  public constructor(
    private readonly store: EvidenceObjectStore,
    private readonly prefix: string,
  ) {}

  public async add(copy: ManifestObjectRef): Promise<void> {
    await this.push(0, copy);
  }

  public async finish(): Promise<ManifestObjectRef | null> {
    while (true) {
      const occupied = this.levels.flatMap((items, level) => items.length === 0 ? [] : [level]);
      if (occupied.length === 0) return null;
      const lowest = occupied[0];
      const highest = occupied.at(-1);
      if (lowest === undefined || highest === undefined) return null;
      const current = this.levels[lowest];
      if (current === undefined) return null;
      if (lowest === highest && current.length === 1) return current[0] ?? null;
      this.levels[lowest] = [];
      const node = await this.writeNode(lowest, current);
      await this.push(lowest + 1, node);
    }
  }

  private async push(level: number, child: ManifestObjectRef): Promise<void> {
    const current = this.levels[level] ?? [];
    current.push(child);
    this.levels[level] = current;
    if (current.length === MAX_TREE_FANOUT) {
      this.levels[level] = [];
      await this.push(level + 1, await this.writeNode(level, current));
    }
  }

  private async writeNode(level: number, children: readonly ManifestObjectRef[]): Promise<ManifestObjectRef> {
    if (children.length === 0 || children.length > MAX_TREE_FANOUT) {
      fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "manifest tree node has an invalid fanout");
    }
    for (let index = 1; index < children.length; index += 1) {
      const previous = children[index - 1];
      const current = children[index];
      if (previous === undefined || current === undefined || previous.last_copy_ordinal + 1 !== current.first_copy_ordinal) {
        fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "manifest tree children are not in contiguous canonical order");
      }
    }
    const first = children[0];
    const last = children.at(-1);
    if (first === undefined || last === undefined) {
      fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "manifest tree node has no range");
    }
    const copyCount = children.reduce((sum, child) => sum + child.copy_count, 0);
    const itemCount = children.reduce((sum, child) => sum + child.item_count, 0);
    const payload = {
      protocol: "eliotr.managed-target-manifest-index.v1",
      level,
      first_copy_ordinal: first.first_copy_ordinal,
      last_copy_ordinal: last.last_copy_ordinal,
      copy_count: copyCount,
      item_count: itemCount,
      children,
    } as const;
    const json = canonicalProjectionJson(payload);
    const digest = await projectionSha256Utf8(json);
    const stored = await putCanonicalObject(
      this.store,
      `${this.prefix}/tree/${level}/${digest}.json`,
      payload,
      { manifest_kind: "managed-target-manifest-index", tree_level: String(level) },
    );
    return Object.freeze({
      kind: "INDEX",
      ...stored,
      first_copy_ordinal: first.first_copy_ordinal,
      last_copy_ordinal: last.last_copy_ordinal,
      copy_count: copyCount,
      item_count: itemCount,
    });
  }
}

function copyIdentity(copy: ManagedRequiredProjectRevisionCopy) {
  return {
    project_id: copy.project_id,
    project_membership_id: copy.project_membership_id,
    membership_generation: copy.membership_generation,
    source_id: copy.source_id,
    source_revision_ref: copy.source_revision_ref,
  } as const;
}

/**
 * Builds the shared target-wide desired-item denominator. It streams the
 * canonical Core required set in order, projects one exact normalized R2
 * document at a time, and stages bounded immutable copy/index objects in R2
 * Work. No job/effect/snapshot count participates in membership or item count.
 */
export async function buildManagedTargetManifest(
  input: ManagedTargetManifestInput,
): Promise<ManagedTargetManifestReceipt> {
  validateTarget(input.target);
  validateProfile(input.target, input.profile);
  if (!Number.isFinite(Date.parse(input.as_of)) || new Date(input.as_of).toISOString() !== input.as_of) {
    fail("MANAGED_TARGET_MANIFEST_INPUT_INVALID", "as_of must be a canonical UTC timestamp");
  }
  const normalizedTargetProfile = canonicalAiSearchProfile(input.profile.target_profile);
  const observedProfileDigest = await projectionDigest(normalizedTargetProfile);
  if (observedProfileDigest !== input.target.target_profile_identity_sha256) {
    fail("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "Core target identity does not bind the supplied immutable AI Search profile");
  }

  const shadowBefore = await input.shadow_authority.read(input.target, normalizedTargetProfile);
  validateShadowFence(shadowBefore, input.target);
  const shadowBeforeDigest = await shadowFingerprint(shadowBefore);
  const targetToken = await projectionDigest({
    protocol: "eliotr.managed-target-manifest-storage-scope.v1",
    target: input.target,
  });
  const prefix = `managed-target-manifests/${targetToken}`;
  const tree = new ManifestTreeWriter(input.work_store, prefix);

  let sourceFenceDigest = await projectionSha256Utf8(canonicalProjectionJson({
    protocol: "eliotr.managed-target-source-fence.v1",
    target: input.target,
    copy_layout: input.profile.copy_layout,
    projection_profile: input.profile.projection_profile,
  }));
  let itemSetDigest = await projectionSha256Utf8(canonicalProjectionJson({
    protocol: "eliotr.managed-target-item-set.v1",
    target: input.target,
    target_profile: normalizedTargetProfile,
    copy_layout: input.profile.copy_layout,
    projection_profile: input.profile.projection_profile,
  }));
  let itemCount = 0;
  let copyOrdinal = 0;

  const requiredSetReceipt = await enumerateManagedRequiredSet(input.required_set, {
    target: input.target,
    as_of: input.as_of,
    on_copy: async (copy) => {
      const document = await input.documents.readDocument({
        target: input.target,
        profile: input.profile,
        copy,
        as_of: input.as_of,
      });
      const sourceDigest = await sourceAuthorityFingerprint(input.target, input.profile, copy, document);
      sourceFenceDigest = await projectionSha256Utf8(`${sourceFenceDigest}\n${sourceDigest}`);
      if (
        document.markdown.length === 0 ||
        utf8ProjectionBytes(document.markdown).byteLength > input.profile.projection_profile.maximum_markdown_bytes
      ) {
        fail("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "normalized source exceeds the supplied immutable projection profile bound");
      }
      const projection = await projectManagedRequiredItemCopy({
        markdown_projection_input: {
          source_revision: document.source_revision,
          title: document.source_title,
          source_class: document.source_class,
          markdown: document.markdown,
          instruction_taint: document.instruction_taint,
          project_membership_ids: [copy.project_membership_id],
          project_copy_layout: MANAGED_REQUIRED_ITEM_COPY_LAYOUT,
          project_copy_membership_id: copy.project_membership_id,
          projection_generation: input.target.managed_generation,
          target_item_utf8_bytes: input.profile.projection_profile.target_item_utf8_bytes,
          max_item_utf8_bytes: input.profile.projection_profile.maximum_item_utf8_bytes,
        },
        required_copy: copy,
        profile: input.profile.projection_profile,
        copy_layout: MANAGED_REQUIRED_ITEM_COPY_LAYOUT,
      });
      const projectionGeneration = input.target.managed_generation;
      const manifestItems = projection.items.map((item, index) => {
        const span = projection.spans[index];
        if (span === undefined) {
          fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "trusted projector result has no span for an item");
        }
        return Object.freeze({ item, span });
      });
      for (const { item, span } of manifestItems) {
        itemSetDigest = await projectionSha256Utf8(`${itemSetDigest}\n${canonicalProjectionJson({
          copy: copyIdentity(copy),
          item,
          span,
        })}`);
      }
      const copyPayload = {
        protocol: "eliotr.managed-target-manifest-copy.v1",
        target: input.target,
        target_profile: normalizedTargetProfile,
        copy_layout: input.profile.copy_layout,
        projection_profile: input.profile.projection_profile,
        copy_ordinal: copyOrdinal,
        required_copy: copy,
        source_authority_sha256: sourceDigest,
        projection_generation: projectionGeneration,
        markdown_sha256: projection.markdown_sha256,
        item_set_digest: projection.item_set_digest,
        item_count: projection.items.length,
        items: manifestItems,
      } as const;
      const json = canonicalProjectionJson(copyPayload);
      const copyDigest = await projectionSha256Utf8(json);
      const stored = await putCanonicalObject(
        input.work_store,
        `${prefix}/copies/${copyDigest}.json`,
        copyPayload,
        { manifest_kind: "managed-target-manifest-copy", target_profile_sha256: input.target.target_profile_identity_sha256 },
      );
      await tree.add(Object.freeze({
        kind: "COPY",
        ...stored,
        first_copy_ordinal: copyOrdinal,
        last_copy_ordinal: copyOrdinal,
        copy_count: 1,
        item_count: projection.items.length,
      }));
      copyOrdinal += 1;
      itemCount += projection.items.length;
    },
  });

  if (copyOrdinal === 0 || itemCount === 0) {
    fail("MANAGED_TARGET_MANIFEST_EMPTY", "the assigned target has no canonical desired items; zero cannot qualify a generation");
  }

  let postSourceFenceDigest = await projectionSha256Utf8(canonicalProjectionJson({
    protocol: "eliotr.managed-target-source-fence.v1",
    target: input.target,
    copy_layout: input.profile.copy_layout,
    projection_profile: input.profile.projection_profile,
  }));
  const postRequiredSetReceipt = await enumerateManagedRequiredSet(input.required_set, {
    target: input.target,
    as_of: input.as_of,
    on_copy: async (copy) => {
      const authority = await input.documents.readAuthority({
        target: input.target,
        profile: input.profile,
        copy,
        as_of: input.as_of,
      });
      const sourceDigest = await sourceAuthorityFingerprint(input.target, input.profile, copy, authority);
      postSourceFenceDigest = await projectionSha256Utf8(`${postSourceFenceDigest}\n${sourceDigest}`);
    },
  });
  if (
    postRequiredSetReceipt.required_set_digest !== requiredSetReceipt.required_set_digest ||
    postRequiredSetReceipt.project_revision_copy_count !== requiredSetReceipt.project_revision_copy_count ||
    postRequiredSetReceipt.target_fence.digest !== requiredSetReceipt.target_fence.digest ||
    postSourceFenceDigest !== sourceFenceDigest
  ) {
    fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "Core membership, source, owner, purge, admission, or projection inputs changed during manifest assembly");
  }

  const shadowAfter = await input.shadow_authority.read(input.target, normalizedTargetProfile);
  validateShadowFence(shadowAfter, input.target);
  const shadowAfterDigest = await shadowFingerprint(shadowAfter);
  if (shadowBeforeDigest !== shadowAfterDigest) {
    fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "SEARCH_DB shadow profile or active-head authority changed during manifest assembly");
  }
  if (shadowAfter.expected_item_count !== null && shadowAfter.expected_item_count !== itemCount) {
    fail("MANAGED_TARGET_MANIFEST_EXPECTED_COUNT_MISMATCH", "SEARCH_DB declared item count differs from the canonical desired-item denominator");
  }

  const treeRef = await tree.finish();
  if (treeRef === null || treeRef.copy_count !== copyOrdinal || treeRef.item_count !== itemCount) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "immutable manifest tree does not cover every staged project copy and item");
  }
  const eligibilityDigest = await projectionDigest({
    protocol: "eliotr.managed-target-eligibility.v2",
    target: input.target,
    as_of: input.as_of,
    target_fence: postRequiredSetReceipt.target_fence,
    assigned_project_count: requiredSetReceipt.assigned_project_count,
    project_revision_copy_count: copyOrdinal,
    required_set_digest: requiredSetReceipt.required_set_digest,
    source_authority_digest: sourceFenceDigest,
    shadow_authority_digest: shadowAfterDigest,
  });
  const rootPayload = {
    protocol: MANAGED_TARGET_MANIFEST_PROTOCOL,
    target: input.target,
    target_profile: normalizedTargetProfile,
    projection_profile: input.profile.projection_profile,
    copy_layout: input.profile.copy_layout,
    as_of: input.as_of,
    target_fence: postRequiredSetReceipt.target_fence,
    registry_revision_before: shadowBefore.registry_revision,
    registry_revision_after: shadowAfter.registry_revision,
    assigned_project_count: requiredSetReceipt.assigned_project_count,
    project_revision_copy_count: copyOrdinal,
    desired_item_count: itemCount,
    desired_item_set_digest: itemSetDigest,
    eligibility_digest: eligibilityDigest,
    required_set_digest: requiredSetReceipt.required_set_digest,
    source_authority_digest: sourceFenceDigest,
    shadow_authority_digest: shadowAfterDigest,
    tree: treeRef,
  } as const;
  const rootJson = canonicalProjectionJson(rootPayload);
  const rootDigest = await projectionSha256Utf8(rootJson);
  const root = await putCanonicalObject(
    input.work_store,
    `${prefix}/roots/${rootDigest}.json`,
    rootPayload,
    { manifest_kind: "managed-target-manifest-root", target_profile_sha256: input.target.target_profile_identity_sha256 },
  );

  return Object.freeze({
    protocol: MANAGED_TARGET_MANIFEST_PROTOCOL,
    target: input.target,
    copy_layout: input.profile.copy_layout,
    as_of: input.as_of,
    target_fence: postRequiredSetReceipt.target_fence,
    registry_revision_before: shadowBefore.registry_revision,
    registry_revision_after: shadowAfter.registry_revision,
    assigned_project_count: requiredSetReceipt.assigned_project_count,
    project_revision_copy_count: copyOrdinal,
    desired_item_count: itemCount,
    desired_item_set_digest: itemSetDigest,
    eligibility_digest: eligibilityDigest,
    manifest_ref: root.key,
    manifest_sha256: root.sha256,
    manifest_size_bytes: root.size_bytes,
    manifest_tree_ref: treeRef.key,
    manifest_tree_sha256: treeRef.sha256,
  });
}
