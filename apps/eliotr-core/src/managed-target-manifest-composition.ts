import { SourceRevisionSchema, type SourceRevision } from "@eliotr/contracts";
import {
  createR2EvidenceObjectStore,
  type AiSearchInstanceProfile,
} from "@eliotr/platform-cloudflare";
import {
  assertCloudflareAiSearchInstanceProfile,
  assertImmutableAiSearchProfile,
  aiSearchPhysicalProfileDigest,
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
  ManagedTargetManifestError,
  MANAGED_TARGET_MANIFEST_COPY_LAYOUT,
  type ManagedTargetManifestInput,
  type ManagedTargetManifestProfile,
  type ManagedTargetManifestShadowAuthorityPort,
  type ManagedTargetManifestShadowFence,
  type ManagedTargetManifestSourceAuthority,
} from "@eliotr/cloudflare-projection";
import type { Env } from "./env.js";

type ManagedTargetManifestEnvironment = Pick<
  Env,
  "CORE_DB" | "SEARCH_DB" | "WORK_BUCKET"
>;

export interface ManagedTargetManifestCompositionDependencies {
  readonly target_profile: AiSearchInstanceProfile;
  readonly projection_profile: ProjectionExecutionProfile;
  /** Required opt-in; no legacy/default item-key layout is accepted here. */
  readonly copy_layout: typeof MANAGED_TARGET_MANIFEST_COPY_LAYOUT;
  /** Must be backed by current trusted account-tier/profile capacity authority. */
  readonly provider_capacity_authority: ManagedTargetManifestInput["capacity_authority"];
  /** Existing canonical source and project-copy writer; no duplicate projector is created here. */
  readonly canonical_projection: ManagedTargetManifestInput["canonical_projection"];
  readonly now?: () => number;
}

export interface ManagedTargetManifestComposer {
  /** Uses the current Core assignment set and creates no assignment or generation state. */
  advance(
    target: ManagedTargetIdentity,
    executionId: string,
    continuation?: { readonly ref: string; readonly sha256: string },
  ): Promise<Awaited<ReturnType<typeof buildManagedTargetManifest>>>;
  /** Lists once and deletes at most 15 exact objects under one immutable build-scoped Work prefix. */
  cleanupBuild(
    target: ManagedTargetIdentity,
    scanIdentitySha256: string,
    cursor?: string,
  ): Promise<{
    readonly protocol: "eliotr.managed-target-manifest-cleanup.v1";
    readonly deleted_count: number;
    readonly complete: boolean;
    readonly cursor: string | null;
    readonly budget: {
      readonly protocol: "eliotr.managed-target-manifest-cleanup-budget.v1";
      readonly subrequest_upper_bound: number;
      readonly cpu_upper_bound_ms: number;
      readonly list_calls: number;
      readonly exact_delete_calls: number;
    };
  }>;
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

interface CoreAssignmentFenceRow {
  readonly assignment_revision: unknown;
  readonly project_id: unknown;
  readonly project_membership_generation: unknown;
  readonly project_owner_principal_ref: unknown;
  readonly current_project_owner_principal_ref: unknown;
  readonly project_owner_deployment_generation: unknown;
  readonly namespace: unknown;
  readonly managed_instance_id: unknown;
  readonly managed_generation: unknown;
  readonly target_profile_identity_sha256: unknown;
  readonly project_exists: unknown;
}

const CURRENT_TARGET_ASSIGNMENT_FENCE_SQL =
  "WITH assignments AS (" +
  "SELECT e.* FROM managed_target_assignment_current h " +
  "JOIN managed_target_assignment_event e " +
  "ON e.project_id=h.project_id AND e.event_revision=h.event_revision " +
  "WHERE h.event_kind='ASSIGN' AND h.target_namespace=?1 " +
  "AND h.managed_instance_id=?2 AND h.managed_generation=?3) ";

interface CoreAuthorityPort {
  readAuthority(input: CoreSourceReadInput): ReturnType<ManagedTargetManifestInput["documents"]["readAuthority"]>;
}

function createCoreAuthorityPort(environment: ManagedTargetManifestEnvironment): CoreAuthorityPort {
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

  async function readAuthority(input: CoreSourceReadInput) {
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
    return Object.freeze({
      authority: assertCurrentSourceAuthority(row, input.copy, input.as_of),
      budget: Object.freeze({
        protocol: "eliotr.managed-target-operation-budget.v1" as const,
        subrequest_upper_bound: 1,
        cpu_upper_bound_ms: 5_000,
        input_bytes_upper_bound: 64 * 1024,
      }),
    });
  }

  return Object.freeze({
    readAuthority,
  });
}

function createBoundedAssignmentFencePort(
  database: D1Database,
): ManagedTargetManifestInput["assignment_fence"] {
  return Object.freeze({
    async readPage(input: Parameters<ManagedTargetManifestInput["assignment_fence"]["readPage"]>[0]) {
      if (input.limit !== 256) {
        manifestFailure("MANAGED_TARGET_MANIFEST_INPUT_INVALID", "assignment-fence page must use the fixed 256-row bound");
      }
      let result: D1Result<CoreAssignmentFenceRow>;
      try {
        result = await database.prepare(
          CURRENT_TARGET_ASSIGNMENT_FENCE_SQL +
          "SELECT a.event_revision AS assignment_revision,a.project_id," +
          "p.membership_generation AS project_membership_generation," +
          "a.project_owner_principal_ref,a.target_namespace AS namespace,a.managed_instance_id," +
          "a.managed_generation,a.target_profile_identity_sha256," +
          "(p.project_id IS NOT NULL) AS project_exists," +
          "po.principal_ref AS current_project_owner_principal_ref," +
          "po.deployment_generation AS project_owner_deployment_generation " +
          "FROM assignments a LEFT JOIN project p ON p.project_id=a.project_id " +
          "LEFT JOIN project_owner po ON po.project_id=a.project_id " +
          "WHERE (?4 IS NULL OR a.project_id>?4) ORDER BY a.project_id LIMIT ?5",
        ).bind(
          input.target.namespace,
          input.target.managed_instance_id,
          input.target.managed_generation,
          input.after_project_id,
          input.limit,
        ).all<CoreAssignmentFenceRow>();
      } catch (cause) {
        manifestFailure("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "Core assignment-fence page read failed", cause);
      }
      if (!result.success || !Array.isArray(result.results) || result.results.length > input.limit) {
        manifestFailure("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "Core assignment-fence page did not complete within its fixed bound");
      }
      const rows = result.results.map((row) => Object.freeze({
        assignment_revision: row.assignment_revision as number,
        project_id: row.project_id as string,
        project_membership_generation: row.project_membership_generation === null
          ? null
          : row.project_membership_generation as number,
        project_owner_principal_ref: row.project_owner_principal_ref as string,
        current_project_owner_principal_ref: row.current_project_owner_principal_ref === null
          ? null
          : row.current_project_owner_principal_ref as string,
        project_owner_deployment_generation: row.project_owner_deployment_generation === null
          ? null
          : row.project_owner_deployment_generation as string,
        namespace: row.namespace as string,
        managed_instance_id: row.managed_instance_id as string,
        managed_generation: row.managed_generation as string,
        target_profile_identity_sha256: row.target_profile_identity_sha256 as string,
        project_exists: row.project_exists === 1 || row.project_exists === true,
      }));
      const last = rows.at(-1);
      if (rows.length === input.limit && (last === undefined || typeof last.project_id !== "string")) {
        manifestFailure("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "Core assignment-fence page has no terminal cursor row");
      }
      return Object.freeze({
        rows: Object.freeze(rows),
        next_cursor: rows.length === input.limit ? last?.project_id ?? null : null,
        budget: Object.freeze({
          protocol: "eliotr.managed-target-operation-budget.v1" as const,
          subrequest_upper_bound: 1,
          cpu_upper_bound_ms: 5_000,
          input_bytes_upper_bound: rows.length * 4_096,
        }),
      });
    },
  });
}

async function registryFence(
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
    manifestFailure("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "SEARCH_DB logical generation differs from the assigned target");
  }
  let registryPhysicalProfileSha256: string;
  let targetPhysicalProfileSha256: string;
  try {
    [registryPhysicalProfileSha256, targetPhysicalProfileSha256] = await Promise.all([
      aiSearchPhysicalProfileDigest(record.profile),
      aiSearchPhysicalProfileDigest(targetProfile),
    ]);
  } catch (cause) {
    manifestFailure("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "SEARCH_DB physical profile could not be identified", cause);
  }
  if (registryPhysicalProfileSha256 !== targetPhysicalProfileSha256) {
    manifestFailure("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "SEARCH_DB physical index settings differ from the assigned immutable profile");
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
  const workStore = createR2EvidenceObjectStore(environment.WORK_BUCKET);
  const workIndex: ManagedTargetManifestInput["work_index"] = Object.freeze({
    async list(input: Parameters<ManagedTargetManifestInput["work_index"]["list"]>[0]) {
      const listed = await environment.WORK_BUCKET.list({
        prefix: input.prefix,
        limit: input.limit,
        ...(input.cursor === null ? {} : { cursor: input.cursor }),
      });
      return Object.freeze({
        objects: Object.freeze(listed.objects.map((object) => Object.freeze({ key: object.key }))),
        truncated: listed.truncated,
        cursor: listed.truncated ? listed.cursor ?? null : null,
      });
    },
    async deleteKeys(keys: Parameters<ManagedTargetManifestInput["work_index"]["deleteKeys"]>[0]) {
      for (const key of keys) await environment.WORK_BUCKET.delete(key);
    },
  });
  const coreAuthority = createCoreAuthorityPort(environment);
  const assignmentFence = createBoundedAssignmentFencePort(environment.CORE_DB);
  const requiredSetReader = createD1ManagedRequiredSetPort(environment.CORE_DB);
  const requiredSet: ManagedTargetManifestInput["required_set"] = Object.freeze({
    async readPage(input: Parameters<ManagedTargetManifestInput["required_set"]["readPage"]>[0]) {
      const page = await requiredSetReader.readPage(input);
      return Object.freeze({
        page,
        budget: Object.freeze({
          protocol: "eliotr.managed-target-operation-budget.v1",
          subrequest_upper_bound: 1,
          cpu_upper_bound_ms: 5_000,
          input_bytes_upper_bound: page.rows.length * 4_096,
        }),
      });
    },
  });
  const registry = createAiSearchGenerationRegistryService(
    createD1AiSearchGenerationRegistryStore(environment.SEARCH_DB),
  );
  const shadowAuthority: ManagedTargetManifestShadowAuthorityPort = Object.freeze({
    async read(target: ManagedTargetIdentity): Promise<{
      readonly fence: ManagedTargetManifestShadowFence;
      readonly budget: { readonly protocol: "eliotr.managed-target-operation-budget.v1"; readonly subrequest_upper_bound: number; readonly cpu_upper_bound_ms: number; readonly input_bytes_upper_bound: number };
    }> {
      const snapshot = await registry.read(target.namespace);
      return Object.freeze({
        fence: await registryFence(snapshot, target, targetProfile),
        budget: Object.freeze({
          protocol: "eliotr.managed-target-operation-budget.v1",
          subrequest_upper_bound: 1,
          cpu_upper_bound_ms: 1_000,
          input_bytes_upper_bound: 64 * 1024,
        }),
      });
    },
  });
  const profile: ManagedTargetManifestProfile = Object.freeze({
    target_profile: targetProfile,
    projection_profile: dependencies.projection_profile,
    copy_layout: dependencies.copy_layout,
  });

  const documents: ManagedTargetManifestInput["documents"] = coreAuthority;

  return Object.freeze({
    async advance(
      target: ManagedTargetIdentity,
      executionId: string,
      continuation?: { readonly ref: string; readonly sha256: string },
    ): Promise<Awaited<ReturnType<typeof buildManagedTargetManifest>>> {
      if (target.managed_instance_id !== targetProfile.id) {
        manifestFailure("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "selected Core target does not identify the supplied immutable profile");
      }
      const now = dependencies.now ?? Date.now;
      return buildManagedTargetManifest({
        target,
        execution_id: executionId,
        clock: now,
        ...(continuation === undefined ? {} : { continuation }),
        profile,
        assignment_fence: assignmentFence,
        required_set: requiredSet,
        shadow_authority: shadowAuthority,
        capacity_authority: dependencies.provider_capacity_authority,
        canonical_projection: dependencies.canonical_projection,
        documents,
        work_store: workStore,
        work_index: workIndex,
      });
    },
    async cleanupBuild(target: ManagedTargetIdentity, scanIdentitySha256: string, cursor?: string) {
      if (target.managed_instance_id !== targetProfile.id || !/^[a-f0-9]{64}$/u.test(scanIdentitySha256)) {
        manifestFailure("MANAGED_TARGET_MANIFEST_INPUT_INVALID", "cleanup identity is outside the exact managed build scope");
      }
      const scope = await projectionDigest({
        protocol: "eliotr.managed-target-manifest-storage-scope.v1",
        target,
      });
      const prefix = `managed-target-manifests/${scope}/builds/${scanIdentitySha256}/`;
      const listed = await environment.WORK_BUCKET.list({
        prefix,
        limit: 15,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (listed.objects.length > 15 || listed.objects.some((object) => !object.key.startsWith(prefix))) {
        manifestFailure("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "cleanup listing exceeded its exact 15-key build-scoped bound");
      }
      const listedKeys = listed.objects.map((object) => object.key);
      if (new Set(listedKeys).size !== listedKeys.length ||
          listedKeys.some((key, index) => index > 0 && key <= (listedKeys[index - 1] ?? ""))) {
        manifestFailure("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "cleanup listing is duplicated or not in strict key order");
      }
      for (const object of listed.objects) await environment.WORK_BUCKET.delete(object.key);
      const deleted = listed.objects.length;
      const next = listed.truncated ? listed.cursor ?? null : null;
      if (listed.truncated && (next === null || next === cursor)) {
        manifestFailure("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "cleanup cursor did not advance");
      }
      return Object.freeze({
        protocol: "eliotr.managed-target-manifest-cleanup.v1" as const,
        deleted_count: deleted,
        complete: !listed.truncated,
        cursor: next,
        budget: Object.freeze({
          protocol: "eliotr.managed-target-manifest-cleanup-budget.v1" as const,
          subrequest_upper_bound: 1 + deleted,
          cpu_upper_bound_ms: 1_000,
          list_calls: 1,
          exact_delete_calls: deleted,
        }),
      });
    },
  });
}
