import {
  SourceRevisionSchema,
  type SourceRevision,
} from "@eliotr/contracts";
import {
  projectNormalizedMarkdown,
  StructuralProjectionError,
  type MarkdownProjectionInput,
  type MarkdownProjectionResult,
} from "@eliotr/retrieval";
import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  assertProjectionSha256,
  profileIsValid,
  projectionFail,
  utf8ProjectionLength,
} from "../canonical.js";
import type { ManagedRequiredProjectRevisionCopy } from "../managed-required-set.js";
import type { ProjectionExecutionProfile } from "../types.js";

export const MANAGED_REQUIRED_ITEM_COPY_LAYOUT = "PROJECT_COPY_V1" as const;

export type ManagedRequiredItemMarkdownProjectionInput = Omit<
  MarkdownProjectionInput,
  "project_copy_layout" | "project_copy_membership_id"
> & {
  readonly project_copy_layout: typeof MANAGED_REQUIRED_ITEM_COPY_LAYOUT;
  readonly project_copy_membership_id: string;
};

/**
 * One immutable source revision and one row emitted by the canonical target
 * required-set enumerator. The caller consumes copies serially; this port
 * never expands or retains a target-wide membership corpus.
 */
export interface ManagedRequiredItemCopyInput {
  readonly markdown_projection_input: ManagedRequiredItemMarkdownProjectionInput;
  readonly required_copy: ManagedRequiredProjectRevisionCopy;
  readonly profile: ProjectionExecutionProfile;
  /** Must be explicitly selected by the target's fresh shadow profile. */
  readonly copy_layout: typeof MANAGED_REQUIRED_ITEM_COPY_LAYOUT;
}

interface CapturedInput {
  readonly projection: MarkdownProjectionInput;
  readonly copy: ManagedRequiredProjectRevisionCopy;
  readonly profile: ProjectionExecutionProfile;
  readonly copyLayout: typeof MANAGED_REQUIRED_ITEM_COPY_LAYOUT;
}

function invalid(message: string): never {
  return projectionFail("PROJECTION_INPUT_INVALID", message);
}

function authorityConflict(message: string): never {
  return projectionFail("PROJECTION_AUTHORITY_CONFLICT", message);
}

/** Copies every actual mutable input before hashing or invoking the async projector. */
function captureInput(input: ManagedRequiredItemCopyInput): CapturedInput {
  const raw = input.markdown_projection_input;
  if (!Array.isArray(raw.project_membership_ids)) {
    invalid("project membership identities must be an array");
  }

  let sourceRevision: SourceRevision;
  try {
    sourceRevision = SourceRevisionSchema.parse(raw.source_revision);
  } catch (cause) {
    invalid(`source revision failed strict validation: ${String(cause)}`);
  }

  const projection: MarkdownProjectionInput = Object.freeze({
    source_revision: Object.freeze({ ...sourceRevision }),
    title: raw.title,
    source_class: raw.source_class,
    markdown: raw.markdown,
    instruction_taint: raw.instruction_taint,
    project_membership_ids: Object.freeze([...raw.project_membership_ids]),
    project_copy_layout: raw.project_copy_layout,
    project_copy_membership_id: raw.project_copy_membership_id,
    projection_generation: raw.projection_generation,
    ...(raw.target_item_utf8_bytes === undefined
      ? {}
      : { target_item_utf8_bytes: raw.target_item_utf8_bytes }),
    ...(raw.max_item_utf8_bytes === undefined
      ? {}
      : { max_item_utf8_bytes: raw.max_item_utf8_bytes }),
  });
  const copy = Object.freeze({ ...input.required_copy });
  const profile = Object.freeze({ ...input.profile });
  return Object.freeze({ projection, copy, profile, copyLayout: input.copy_layout });
}

function validateCapturedInput(captured: CapturedInput): string {
  const { projection, copy, profile, copyLayout } = captured;
  if (
    copyLayout !== MANAGED_REQUIRED_ITEM_COPY_LAYOUT ||
    projection.project_copy_layout !== MANAGED_REQUIRED_ITEM_COPY_LAYOUT
  ) {
    invalid("managed required-item copies require an explicit PROJECT_COPY_V1 layout");
  }

  profileIsValid(profile);
  if (profile.managed_generation_active) {
    invalid("PROJECT_COPY_V1 requires the assigned non-active shadow profile");
  }
  if (
    profile.managed_instance_id !== copy.managed_instance_id ||
    profile.managed_generation !== copy.managed_generation
  ) {
    authorityConflict("required-set copy differs from the supplied immutable shadow profile");
  }

  const membershipId = copy.project_membership_id;
  assertProjectionIdentifier(copy.project_id, "required-set project id");
  assertProjectionInteger(copy.membership_generation, "required-set membership generation", 1, Number.MAX_SAFE_INTEGER);
  assertProjectionIdentifier(membershipId, "required-set membership id");
  if (membershipId !== `project:${copy.project_id}:generation:${copy.membership_generation}`) {
    authorityConflict("required-set membership id differs from its canonical project identity");
  }
  const membershipIds = projection.project_membership_ids;
  const uniqueMembershipIds = new Set(membershipIds);
  if (uniqueMembershipIds.size !== membershipIds.length) {
    invalid("Markdown projection input repeats a project membership identity");
  }
  if (membershipIds.length !== 1 || membershipIds[0] !== membershipId) {
    authorityConflict("Markdown projection membership does not exactly match the canonical required-set copy");
  }
  if (projection.project_copy_membership_id !== membershipId) {
    authorityConflict("explicit copy-key membership differs from the canonical required-set copy");
  }

  const revision = projection.source_revision;
  const normalizedArtifactRef = revision.normalized_artifact_ref ?? null;
  assertProjectionSha256(copy.source_revision_content_sha256, "required-set source content digest");
  if (
    revision.purge_state !== "LIVE" ||
    copy.purge_state !== "LIVE" ||
    copy.source_owner_status !== "ACTIVE" ||
    copy.admission_decision !== "ADMITTED" ||
    copy.source_head_revision_ref !== copy.source_revision_ref ||
    revision.source_revision_ref !== copy.source_revision_ref ||
    revision.source_id !== copy.source_id ||
    revision.source_namespace_id !== copy.source_namespace_id ||
    revision.source_owner_system_id !== copy.source_owner_system_id ||
    revision.source_owner_generation !== copy.source_owner_generation ||
    revision.ownership_mode !== copy.source_ownership_mode ||
    revision.content_sha256 !== copy.source_revision_content_sha256 ||
    normalizedArtifactRef !== copy.normalized_artifact_ref ||
    projection.source_class !== copy.source_class
  ) {
    authorityConflict("pinned SourceRevision differs from its canonical required-set copy");
  }

  if (
    (projection.target_item_utf8_bytes !== undefined &&
      projection.target_item_utf8_bytes !== profile.target_item_utf8_bytes) ||
    (projection.max_item_utf8_bytes !== undefined &&
      projection.max_item_utf8_bytes !== profile.maximum_item_utf8_bytes)
  ) {
    authorityConflict("Markdown projection byte limits differ from the immutable shadow profile");
  }
  if (typeof projection.markdown !== "string" || projection.markdown.length === 0) {
    throw new StructuralProjectionError(
      "PROJECTION_DOCUMENT_EMPTY",
      "verified normalized Markdown bytes are missing",
    );
  }
  if (utf8ProjectionLength(projection.markdown) > profile.maximum_markdown_bytes) {
    throw new StructuralProjectionError(
      "PROJECTION_ITEM_LIMIT_EXCEEDED",
      "normalized Markdown exceeds the immutable profile byte bound",
    );
  }
  assertProjectionIdentifier(projection.projection_generation, "projection generation");
  return membershipId;
}

/**
 * Projects one verified normalized document for exactly one current required-
 * set membership. The returned shape is the repository structural projector's
 * result and can be consumed directly by target-wide assembly.
 */
export async function projectManagedRequiredItemCopy(
  input: ManagedRequiredItemCopyInput,
): Promise<MarkdownProjectionResult> {
  const captured = captureInput(input);
  const membershipId = validateCapturedInput(captured);
  const { projection, copy, profile } = captured;

  // This is the first await. The structural projector owns section keys,
  // spans and digests; the wrapper checks its returned document digest once.
  const exactProjectionInput: MarkdownProjectionInput = Object.freeze({
    ...projection,
    project_copy_layout: MANAGED_REQUIRED_ITEM_COPY_LAYOUT,
    project_copy_membership_id: membershipId,
    target_item_utf8_bytes: profile.target_item_utf8_bytes,
    max_item_utf8_bytes: profile.maximum_item_utf8_bytes,
  });
  const result = await projectNormalizedMarkdown(exactProjectionInput);
  if (result.markdown_sha256 !== copy.source_revision_content_sha256) {
    authorityConflict("structural projector document digest differs from the admitted SourceRevision");
  }
  if (result.items.length > profile.maximum_synchronous_items) {
    throw new StructuralProjectionError(
      "PROJECTION_ITEM_LIMIT_EXCEEDED",
      "document projection exceeds the immutable synchronous-item profile bound",
    );
  }
  for (const item of result.items) {
    Object.freeze(item.project_membership_ids);
    Object.freeze(item.heading_path);
    Object.freeze(item);
  }
  for (const span of result.spans) Object.freeze(span);
  Object.freeze(result.items);
  Object.freeze(result.spans);
  return Object.freeze(result);
}
