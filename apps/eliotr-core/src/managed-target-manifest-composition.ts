import { SourceRevisionSchema, type SourceRevision } from "@eliotr/contracts";
import {
  bufferBounded,
  canonicalNormalizedBundleKey,
  createR2EvidenceObjectStore,
  type AiSearchInstanceProfile,
} from "@eliotr/platform-cloudflare";
import {
  assertCloudflareAiSearchInstanceProfile,
  assertImmutableAiSearchProfile,
  createAiSearchGenerationRegistryService,
  createD1AiSearchGenerationRegistryStore,
  createD1ManagedRequiredSetPort,
  projectionDigest,
  type AiSearchGenerationRegistrySnapshot,
  type ManagedRequiredProjectRevisionCopy,
  type ManagedTargetIdentity,
  type ProjectionExecutionProfile,
} from "@eliotr/cloudflare-projection";
import {
  buildManagedTargetManifest,
  MANAGED_TARGET_MANIFEST_COPY_LAYOUT,
  ManagedTargetManifestError,
  type ManagedTargetManifestDocument,
  type ManagedTargetManifestProfile,
  type ManagedTargetManifestReceipt,
  type ManagedTargetManifestShadowAuthorityPort,
  type ManagedTargetManifestShadowFence,
  type ManagedTargetManifestSourceAuthority,
} from "../../../packages/cloudflare-projection/src/managed-target-manifest.js";
import type { Env } from "./env.js";

type ManagedTargetManifestEnvironment = Pick<
  Env,
  "CORE_DB" | "SEARCH_DB" | "EVIDENCE_BUCKET" | "WORK_BUCKET"
>;

export interface ManagedTargetManifestCompositionDependencies {
  readonly target_profile: AiSearchInstanceProfile;
  readonly projection_profile: ProjectionExecutionProfile;
  /** Required opt-in; no legacy/default item-key layout is accepted here. */
  readonly copy_layout: typeof MANAGED_TARGET_MANIFEST_COPY_LAYOUT;
  readonly now?: () => number;
}

export interface ManagedTargetManifestComposer {
  /** Uses the current Core assignment set and creates no assignment or generation state. */
  assemble(target: ManagedTargetIdentity): Promise<ManagedTargetManifestReceipt>;
}

interface SourceAuthorityRow {
  readonly source_revision_ref: unknown;
  readonly source_id: unknown;
  readonly source_namespace_id: unknown;
  readonly source_owner_system_id: unknown;
  readonly source_owner_generation: unknown;
  readonly ownership_mode: unknown;
  readonly content_sha256: unknown;
  readonly object_residency_key_digest: unknown;
  readonly original_r2_key: unknown;
  readonly normalized_artifact_ref: unknown;
  readonly captured_at: unknown;
  readonly parser_profile_generation: unknown;
  readonly quality_state: unknown;
  readonly purge_state: unknown;
  readonly source_title: unknown;
  readonly source_class: unknown;
  readonly head_revision_ref: unknown;
  readonly ownership_record_revision: unknown;
  readonly owner_status: unknown;
  readonly owner_source_owner_generation: unknown;
  readonly owner_admission_policy_revision: unknown;
  readonly decision: unknown;
  readonly decision_receipt_ref: unknown;
  readonly decision_sha256: unknown;
  readonly decision_source_class: unknown;
  readonly decision_source_owner_generation: unknown;
  readonly instruction_taint: unknown;
  readonly decision_expires_at: unknown;
}

function manifestFailure(
  code: ConstructorParameters<typeof ManagedTargetManifestError>[0],
  message: string,
  cause?: unknown,
): never {
  throw new ManagedTargetManifestError(code, message, cause);
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      new TextEncoder().encode(value).byteLength > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    manifestFailure("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", `${label} is invalid`);
  }
  return value;
}

function sourceRevisionFromRow(row: SourceAuthorityRow): SourceRevision {
  try {
    return SourceRevisionSchema.parse({
      source_revision_ref: row.source_revision_ref,
      source_id: row.source_id,
      source_namespace_id: row.source_namespace_id,
      source_owner_system_id: row.source_owner_system_id,
      source_owner_generation: row.source_owner_generation,
      ownership_mode: row.ownership_mode,
      content_sha256: row.content_sha256,
      object_residency_key_digest: row.object_residency_key_digest,
      ...(row.original_r2_key === null ? {} : { original_object_ref: row.original_r2_key }),
      ...(row.normalized_artifact_ref === null ? {} : { normalized_artifact_ref: row.normalized_artifact_ref }),
      captured_at: row.captured_at,
      ...(row.parser_profile_generation === null ? {} : { parser_profile_generation: row.parser_profile_generation }),
      quality_state: row.quality_state,
      purge_state: row.purge_state,
    });
  } catch (cause) {
    manifestFailure("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "Core SourceRevision failed strict contract validation", cause);
  }
}

function assertCurrentSourceAuthority(
  row: SourceAuthorityRow,
  copy: ManagedRequiredProjectRevisionCopy,
  asOf: string,
): ManagedTargetManifestSourceAuthority {
  const revision = sourceRevisionFromRow(row);
  if (
    row.head_revision_ref !== copy.source_revision_ref ||
    row.ownership_record_revision !== copy.source_ownership_record_revision ||
    row.owner_status !== "ACTIVE" ||
    row.owner_source_owner_generation !== copy.source_owner_generation ||
    row.owner_admission_policy_revision !== copy.source_admission_policy_revision ||
    revision.source_revision_ref !== copy.source_revision_ref ||
    revision.source_id !== copy.source_id ||
    revision.source_namespace_id !== copy.source_namespace_id ||
    revision.source_owner_system_id !== copy.source_owner_system_id ||
    revision.source_owner_generation !== copy.source_owner_generation ||
    revision.ownership_mode !== copy.source_ownership_mode ||
    revision.content_sha256 !== copy.source_revision_content_sha256 ||
    revision.normalized_artifact_ref !== copy.normalized_artifact_ref ||
    revision.purge_state !== "LIVE" ||
    row.decision !== "ADMITTED" ||
    row.decision_receipt_ref !== copy.admission_decision_receipt_ref ||
    row.decision_sha256 !== copy.admission_decision_sha256 ||
    row.decision_source_class !== copy.source_admission_policy_source_class ||
    row.decision_source_owner_generation !== copy.source_owner_generation ||
    row.source_class !== copy.source_class ||
    !["CLEARED", "DATA_ONLY", "UNTRUSTED", "COMMAND_LIKE"].includes(String(row.instruction_taint)) ||
    (row.decision_expires_at !== null &&
      (typeof row.decision_expires_at !== "string" || Date.parse(row.decision_expires_at) <= Date.parse(asOf)))
  ) {
    manifestFailure("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "current source owner, revision, purge, or admission differs from the required-set copy");
  }
  return Object.freeze({
    source_revision: revision,
    source_title: boundedText(row.source_title, "source title"),
    source_class: boundedText(row.source_class, "source class"),
    instruction_taint: row.instruction_taint as ManagedTargetManifestSourceAuthority["instruction_taint"],
  });
}

interface CoreSourceReadInput {
  readonly target: ManagedTargetIdentity;
  readonly profile: ManagedTargetManifestProfile;
  readonly copy: ManagedRequiredProjectRevisionCopy;
  readonly as_of: string;
}

interface CoreR2DocumentPort {
  readDocument(input: CoreSourceReadInput): Promise<ManagedTargetManifestDocument>;
  readAuthority(input: CoreSourceReadInput): Promise<ManagedTargetManifestSourceAuthority>;
}

function createCoreR2DocumentPort(
  environment: ManagedTargetManifestEnvironment,
  evidenceStore: ReturnType<typeof createR2EvidenceObjectStore>,
): CoreR2DocumentPort {
  const sourceQuery =
    "SELECT sr.source_revision_ref,sr.source_id,s.source_namespace_id,s.source_owner_system_id," +
    "sr.source_owner_generation,s.ownership_mode,sr.content_sha256,sr.object_residency_key_digest," +
    "sr.original_r2_key,sr.normalized_artifact_ref,sr.captured_at,sr.parser_profile_generation," +
    "sr.quality_state,sr.purge_state,s.title AS source_title,s.source_class,s.head_rev AS head_revision_ref," +
    "own.ownership_record_revision,own.status AS owner_status," +
    "own.source_owner_generation AS owner_source_owner_generation," +
    "own.source_admission_policy_revision AS owner_admission_policy_revision," +
    "d.decision,d.decision_receipt_ref,d.decision_sha256,d.source_class AS decision_source_class," +
    "d.source_owner_generation AS decision_source_owner_generation,d.instruction_taint,d.expires_at AS decision_expires_at " +
    "FROM source_revision sr JOIN source s ON s.source_id=sr.source_id " +
    "JOIN source_namespace_ownership own ON own.source_namespace_id=s.source_namespace_id " +
    "AND own.owner_system_id=s.source_owner_system_id AND own.source_owner_generation=sr.source_owner_generation " +
    "JOIN source_admission_decision d ON d.source_revision_ref=sr.source_revision_ref " +
    "AND d.decision_receipt_ref=?3 " +
    "WHERE sr.source_revision_ref=?1 AND sr.source_id=?2 AND s.head_rev=sr.source_revision_ref " +
    "AND sr.purge_state='LIVE' AND own.status='ACTIVE' AND d.decision='ADMITTED' " +
    "AND d.decision_receipt_ref=(SELECT chosen.decision_receipt_ref FROM source_admission_decision chosen " +
    "WHERE chosen.source_revision_ref=sr.source_revision_ref AND chosen.decision='ADMITTED' " +
    "ORDER BY chosen.created_at DESC,chosen.decision_receipt_ref DESC LIMIT 1) " +
    "LIMIT 1";

  async function readAuthority(input: CoreSourceReadInput): Promise<ManagedTargetManifestSourceAuthority> {
    let row: SourceAuthorityRow | null;
    try {
      row = await environment.CORE_DB.prepare(sourceQuery)
        .bind(input.copy.source_revision_ref, input.copy.source_id, input.copy.admission_decision_receipt_ref)
        .first<SourceAuthorityRow>();
    } catch (cause) {
      manifestFailure("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "Core current source authority read failed", cause);
    }
    if (row === null) {
      manifestFailure("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "current Core source authority is absent");
    }
    return assertCurrentSourceAuthority(row, input.copy, input.as_of);
  }

  return Object.freeze({
    readAuthority,
    async readDocument(input: CoreSourceReadInput): Promise<ManagedTargetManifestDocument> {
      const authority = await readAuthority(input);
      const residencyKey = await canonicalNormalizedBundleKey(
        authority.source_revision.object_residency_key_digest,
        {
          owner_system_id: authority.source_revision.source_owner_system_id,
          source_namespace_id: authority.source_revision.source_namespace_id,
          source_owner_generation: authority.source_revision.source_owner_generation,
          source_logical_id: authority.source_revision.source_id,
          source_revision_ref: authority.source_revision.source_revision_ref,
        },
        "content.md",
      );
      let object: R2ObjectBody | null;
      try { object = await evidenceStore.open(residencyKey); }
      catch (cause) {
        manifestFailure("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "normalized R2 Evidence read failed", cause);
      }
      if (object === null) {
        manifestFailure("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "normalized R2 Evidence bytes are missing");
      }
      const maximumBytes = input.profile.projection_profile.maximum_markdown_bytes;
      if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > maximumBytes) {
        try { await object.body.cancel(); } catch { /* the stored size already fails closed */ }
        manifestFailure("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "normalized R2 Evidence size is outside the immutable projection profile bound");
      }
      let bytes: Uint8Array;
      try { bytes = await bufferBounded(object.body, maximumBytes); }
      catch (cause) {
        manifestFailure("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "normalized R2 Evidence stream is incomplete or unbounded", cause);
      }
      if (bytes.byteLength !== object.size) {
        manifestFailure("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "normalized R2 Evidence stream length differs from its stored size");
      }
      let markdown: string;
      try { markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch (cause) { manifestFailure("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "normalized R2 Evidence is not valid UTF-8", cause); }
      if (markdown.length === 0) {
        manifestFailure("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "normalized R2 Evidence is empty");
      }
      return Object.freeze({ ...authority, markdown });
    },
  });
}

async function registryFence(
  snapshot: AiSearchGenerationRegistrySnapshot | null,
  target: ManagedTargetIdentity,
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
  if (record.profile.id !== target.managed_instance_id || record.profile.generation !== target.managed_generation) {
    manifestFailure("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "SEARCH_DB generation record differs from the assigned instance and generation");
  }
  const recordProfileIdentity = await projectionDigest({
    ...record.profile,
    index_method: { ...record.profile.index_method },
    metadata_fields: [...record.profile.metadata_fields].sort(),
  });
  return Object.freeze({
    registry_revision: snapshot.artifact.revision,
    registry_sha256: snapshot.artifact_sha256,
    active_head_generation: registry.active_head_generation,
    generation_state: record.state,
    generation_profile_identity_sha256: recordProfileIdentity,
    expected_item_count: record.expected_item_count,
  });
}

/**
 * Core/R2 composition used by the future shared builder and promoter caller.
 * This entry point performs reads and immutable Work-R2 staging only. Search
 * registry CAS, item upload/readback, operator selection, and promotion remain
 * with their current owners.
 */
export function createManagedTargetManifestComposer(
  environment: ManagedTargetManifestEnvironment,
  dependencies: ManagedTargetManifestCompositionDependencies,
): ManagedTargetManifestComposer {
  try {
    assertCloudflareAiSearchInstanceProfile(dependencies.target_profile);
    assertImmutableAiSearchProfile(dependencies.target_profile, dependencies.target_profile);
  } catch (cause) {
    manifestFailure("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "supplied AI Search profile is not a valid immutable target profile", cause);
  }
  if (dependencies.copy_layout !== MANAGED_TARGET_MANIFEST_COPY_LAYOUT) {
    manifestFailure("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "PROJECT_COPY_V1 must be explicitly selected by the caller profile");
  }
  const targetProfile = Object.freeze({
    ...dependencies.target_profile,
    index_method: Object.freeze({ ...dependencies.target_profile.index_method }),
    metadata_fields: Object.freeze([...dependencies.target_profile.metadata_fields].sort()),
  });
  const evidenceStore = createR2EvidenceObjectStore(environment.EVIDENCE_BUCKET);
  const workStore = createR2EvidenceObjectStore(environment.WORK_BUCKET);
  const documents = createCoreR2DocumentPort(environment, evidenceStore);
  const requiredSet = createD1ManagedRequiredSetPort(environment.CORE_DB);
  const registry = createAiSearchGenerationRegistryService(
    createD1AiSearchGenerationRegistryStore(environment.SEARCH_DB),
  );
  const shadowAuthority: ManagedTargetManifestShadowAuthorityPort = Object.freeze({
    async read(target: ManagedTargetIdentity): Promise<ManagedTargetManifestShadowFence> {
      const snapshot = await registry.read(target.namespace);
      const configuredProfileIdentity = await projectionDigest(targetProfile);
      if (configuredProfileIdentity !== target.target_profile_identity_sha256) {
        manifestFailure("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "Core target assignment differs from the supplied immutable AI Search profile");
      }
      return registryFence(snapshot, target);
    },
  });
  const profile: ManagedTargetManifestProfile = Object.freeze({
    target_profile: targetProfile,
    projection_profile: dependencies.projection_profile,
    copy_layout: dependencies.copy_layout,
  });

  return Object.freeze({
    async assemble(target: ManagedTargetIdentity): Promise<ManagedTargetManifestReceipt> {
      if (target.managed_instance_id !== targetProfile.id || target.managed_generation !== targetProfile.generation) {
        manifestFailure("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "selected Core target does not identify the supplied immutable profile");
      }
      if (await projectionDigest(targetProfile) !== target.target_profile_identity_sha256) {
        manifestFailure("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "Core assignment profile digest differs from its exact configured profile");
      }
      const now = dependencies.now ?? Date.now;
      const asOf = new Date(now()).toISOString();
      return buildManagedTargetManifest({
        target,
        profile,
        as_of: asOf,
        required_set: requiredSet,
        shadow_authority: shadowAuthority,
        documents,
        work_store: workStore,
      });
    },
  });
}
