import type {
  DeliveryMessage,
  ExecutionFence,
} from "@eliotr/platform-cloudflare";
import { D1_EXECUTION_LEASE_NOW_SQL } from "@eliotr/platform-cloudflare";
import {
  assertProjectionIdentifier,
  assertProjectionSha256,
  assertProjectionText,
  projectionFail,
} from "./canonical.js";
import { managedProjectGenerationMetadataValue } from "./managed-project-path.js";
import { loadProjectionSourceContext } from "./core-load.js";
import type { ProjectionProjectCopyScopesV2Resolver } from "./core-load.js";
import {
  settleProjection,
  validateProjectionWorkReceipt,
} from "./core-settlement.js";
import {
  beginManagedItemDispatch,
  markManagedItemUnknown,
  prepareManagedItemEffects,
  recordManagedItemProviderId,
  recordManagedItemReceipt,
} from "./core-managed-items.js";
import {
  MANAGED_ITEM_PROTOCOL_VERSION,
  readManagedItemGenerationProof,
} from "./core-managed-item-receipts.js";
import {
  assertCurrentProjectionExecutionFence,
  assertManagedItemGenerationProtocol,
  generationRow,
  nowIso,
  validateGenerationIdentity,
} from "./core-generation-state.js";
import {
  readTerminalForProfile,
  readTerminalReceipt,
} from "./core-terminal-receipt.js";
import type { ProjectionManagedItemAuthorityPort } from "./types.js";

export interface D1ProjectionAuthorityDependencies {
  readonly database: D1Database;
  readonly now?: () => number;
  readonly resolve_project_copy_scopes_v2?: ProjectionProjectCopyScopesV2Resolver;
}

export function createD1ProjectionAuthority(
  dependencies: D1ProjectionAuthorityDependencies,
): ProjectionManagedItemAuthorityPort {
  const database = dependencies.database;
  const clock = dependencies.now ?? Date.now;
  const authority: ProjectionManagedItemAuthorityPort = {
    load(message: DeliveryMessage) {
      return loadProjectionSourceContext(database, message, dependencies.resolve_project_copy_scopes_v2);
    },

    readTerminal(context, projectionGeneration, profile) {
      return readTerminalForProfile(database, context, projectionGeneration, profile);
    },

    async begin(context, projectionGeneration, profile, fence) {
      const metadataGenerationDigest = await managedProjectGenerationMetadataValue(
        profile.managed_generation,
      );
      await assertCurrentProjectionExecutionFence(
        database,
        clock,
        context,
        projectionGeneration,
        fence,
      );
      const existing = await generationRow(database, context, projectionGeneration);
      if (existing !== null) {
        await validateGenerationIdentity(existing, context, profile);
        if (existing.state === "COMPLETED" || existing.state === "PARTIAL") {
          await assertCurrentProjectionExecutionFence(
            database,
            clock,
            context,
            projectionGeneration,
            fence,
          );
          return;
        }
        if (existing.managed_item_protocol !== MANAGED_ITEM_PROTOCOL_VERSION) {
          projectionFail(
            "PROJECTION_AUTHORITY_CONFLICT",
            "legacy projection generation cannot be adopted by the managed-item protocol",
          );
        }
      }
      const mutationFence = await assertCurrentProjectionExecutionFence(
        database,
        clock,
        context,
        projectionGeneration,
        fence,
      );
      const now = nowIso(() => mutationFence.now_ms);
      const statements = [];
      if (existing === null) {
        statements.push(database.prepare(
          "INSERT INTO projection_generation(" +
          "source_revision_ref, projection_generation, job_id, source_owner_generation, " +
          "content_sha256, object_residency_key_digest, projector_profile, state, " +
          "reason_codes_json, managed_item_protocol, managed_target_instance_id, " +
          "managed_target_generation, managed_target_metadata_generation_digest, " +
          "created_at, updated_at) " +
          "SELECT ?1,?2,?3,?4,?5,?6,?7,'PREPARING','[]',?8,?9,?10,?11,?12,?12 " +
          "WHERE EXISTS (SELECT 1 FROM operation_execution_lease l " +
          "WHERE l.operation_id=?13 AND l.operation_kind='PROJECTION_EXECUTE' " +
          "AND l.lease_owner=?14 AND l.lease_generation=?15 AND l.state='LEASED' " +
          `AND l.lease_until>?16 AND l.lease_until>${D1_EXECUTION_LEASE_NOW_SQL}) ` +
          "AND EXISTS (SELECT 1 FROM job j WHERE j.job_id=?3 " +
          "AND j.state IN ('ACCEPTED','RUNNING'))",
        ).bind(
          context.source_revision.source_revision_ref,
          projectionGeneration,
          context.job_id,
          context.source_revision.source_owner_generation,
          context.source_revision.content_sha256,
          context.source_revision.object_residency_key_digest,
          profile.projector_profile,
          MANAGED_ITEM_PROTOCOL_VERSION,
          profile.managed_instance_id,
          profile.managed_generation,
          metadataGenerationDigest,
          now,
          mutationFence.operation_id,
          mutationFence.lease_owner,
          mutationFence.lease_generation,
          mutationFence.now_ms,
        ));
      }
      statements.push(database.prepare(
        "UPDATE job SET state = 'RUNNING', current_stage = 'PROJECTION_MATERIALIZING', " +
        "updated_at = ?2 WHERE job_id = ?1 AND state IN ('ACCEPTED','RUNNING') " +
        "AND EXISTS (SELECT 1 FROM operation_execution_lease l " +
        "WHERE l.operation_id=?3 AND l.operation_kind='PROJECTION_EXECUTE' " +
        "AND l.lease_owner=?4 AND l.lease_generation=?5 AND l.state='LEASED' " +
        `AND l.lease_until>?6 AND l.lease_until>${D1_EXECUTION_LEASE_NOW_SQL})`,
      ).bind(
        context.job_id,
        now,
        mutationFence.operation_id,
        mutationFence.lease_owner,
        mutationFence.lease_generation,
        mutationFence.now_ms,
      ));
      await database.batch(statements);
      const readback = await generationRow(database, context, projectionGeneration);
      await assertCurrentProjectionExecutionFence(
        database,
        clock,
        context,
        projectionGeneration,
        fence,
      );
      if (readback === null) {
        projectionFail(
          "PROJECTION_SETTLEMENT_UNCERTAIN",
          "projection generation begin readback is missing",
          true,
        );
      }
      await validateGenerationIdentity(readback, context, profile);
    },

    async recordMaterialized(context, projectionGeneration, receipt, fence) {
      await assertCurrentProjectionExecutionFence(
        database,
        clock,
        context,
        projectionGeneration,
        fence,
      );
      validateProjectionWorkReceipt(receipt);
      const existing = await generationRow(database, context, projectionGeneration);
      if (existing === null) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "projection generation is missing before materialization");
      }
      if (
        existing.job_id !== context.job_id ||
        existing.source_owner_generation !== context.source_revision.source_owner_generation ||
        existing.content_sha256 !== context.source_revision.content_sha256 ||
        existing.object_residency_key_digest !== context.source_revision.object_residency_key_digest
      ) {
        projectionFail(
          "PROJECTION_AUTHORITY_CONFLICT",
          "projection materialized manifest is not bound to the exact source generation",
        );
      }
      if (
        existing.managed_item_protocol !== MANAGED_ITEM_PROTOCOL_VERSION ||
        typeof existing.managed_target_instance_id !== "string" ||
        typeof existing.managed_target_generation !== "string" ||
        typeof existing.managed_target_metadata_generation_digest !== "string"
      ) {
        projectionFail(
          "PROJECTION_AUTHORITY_CONFLICT",
          "materialized projection generation is missing its managed-item protocol target pin",
        );
      }
      const canonical = receipt.canonical_source;
      const copyMapSet = receipt.project_copy_map_set;
      const canonicalGeneration = assertProjectionIdentifier(
        receipt.canonical_projection_generation,
        "materialized canonical projection generation",
      );
      const metadataGenerationDigest = assertProjectionSha256(
        receipt.metadata_generation_digest,
        "materialized target metadata generation digest",
      );
      const providerCopyCount = copyMapSet?.provider_copy_count;
      const providerCopySetDigest = copyMapSet?.provider_copy_set_sha256;
      const v2CopyMapSet = copyMapSet?.protocol === "eliotr.managed-project-copy-map-set.v2"
        ? copyMapSet
        : null;
      const copyMapIndexProtocol = v2CopyMapSet === null
        ? null
        : "eliotr.managed-project-copy-map-index.v2";
      const copyMapIndexRef = v2CopyMapSet?.copy_map_index_ref ?? null;
      const copyMapIndexSha256 = v2CopyMapSet?.copy_map_index_sha256 ?? null;
      const copyScopeSnapshotId = v2CopyMapSet?.scope_snapshot_id ?? null;
      const copyScopeSnapshotRevision = v2CopyMapSet?.scope_snapshot_revision ?? null;
      const copyScopeSnapshotDigest = v2CopyMapSet?.scope_snapshot_digest ?? null;
      if (
        canonical === undefined ||
        copyMapSet === undefined ||
        canonical.canonical_projection_generation !== canonicalGeneration ||
        canonical.source_revision_ref !== context.source_revision.source_revision_ref ||
        canonical.complete_residency_key_sha256 !== context.source_revision.object_residency_key_digest ||
        canonical.canonical_section_count !== receipt.item_count ||
        canonical.canonical_section_set_sha256 !== receipt.item_set_digest ||
        copyMapSet.source_revision_ref !== canonical.source_revision_ref ||
        copyMapSet.complete_residency_key_sha256 !== canonical.complete_residency_key_sha256 ||
        copyMapSet.canonical_projection_generation !== canonicalGeneration ||
        copyMapSet.canonical_source_ref !== canonical.canonical_source_ref ||
        copyMapSet.canonical_source_sha256 !== canonical.canonical_source_sha256 ||
        copyMapSet.target.managed_instance_id !== existing.managed_target_instance_id ||
        copyMapSet.target.managed_generation !== existing.managed_target_generation ||
        copyMapSet.target.metadata_generation_digest !== existing.managed_target_metadata_generation_digest ||
        (v2CopyMapSet !== null && (
          v2CopyMapSet.layout !== "PROJECT_COPY_V2" ||
          v2CopyMapSet.target_selection.target.managed_instance_id !== existing.managed_target_instance_id ||
          v2CopyMapSet.target_selection.target.managed_generation !== existing.managed_target_generation ||
          v2CopyMapSet.target_selection.target.target_profile_identity_sha256.length !== 64 ||
          v2CopyMapSet.copy_map_index_ref.length === 0 ||
          v2CopyMapSet.copy_map_index_sha256.length !== 64
        )) ||
        metadataGenerationDigest !== existing.managed_target_metadata_generation_digest ||
        typeof providerCopyCount !== "number" ||
        !Number.isSafeInteger(providerCopyCount) ||
        providerCopyCount < 0 || providerCopyCount > 256 ||
        typeof providerCopySetDigest !== "string"
      ) {
        projectionFail(
          "PROJECTION_AUTHORITY_CONFLICT",
          "canonical source or project-copy receipt differs from the immutable source and target pins",
        );
      }
      assertProjectionSha256(providerCopySetDigest, "project-copy set digest");
      if (v2CopyMapSet !== null) {
        assertProjectionText(copyMapIndexRef, "V2 copy-map index ref", 2048);
        assertProjectionSha256(copyMapIndexSha256, "V2 copy-map index digest");
        assertProjectionIdentifier(copyScopeSnapshotId, "V2 copy scope snapshot ID");
        assertProjectionSha256(copyScopeSnapshotDigest, "V2 copy scope snapshot digest");
        if (
          typeof copyScopeSnapshotRevision !== "number" ||
          !Number.isSafeInteger(copyScopeSnapshotRevision) ||
          copyScopeSnapshotRevision < 1
        ) {
          projectionFail("PROJECTION_INPUT_INVALID", "V2 copy scope snapshot revision is invalid");
        }
      }
      const manifestEmpty = existing.item_count === null &&
        existing.item_set_digest === null &&
        existing.work_manifest_ref === null &&
        existing.work_manifest_sha256 === null &&
        existing.canonical_projection_generation === null &&
        existing.canonical_item_count === null &&
        existing.canonical_item_set_digest === null &&
        existing.provider_copy_count === null &&
        existing.provider_copy_set_digest === null &&
        existing.project_copy_map_index_protocol === null &&
        existing.project_copy_map_index_ref === null &&
        existing.project_copy_map_index_sha256 === null &&
        existing.project_copy_scope_snapshot_id === null &&
        existing.project_copy_scope_snapshot_revision === null &&
        existing.project_copy_scope_snapshot_digest === null;
      const manifestMatches = existing.item_count === receipt.item_count &&
        existing.item_set_digest === receipt.item_set_digest &&
        existing.work_manifest_ref === receipt.manifest_ref &&
        existing.work_manifest_sha256 === receipt.manifest_sha256 &&
        existing.canonical_projection_generation === canonicalGeneration &&
        existing.canonical_item_count === receipt.item_count &&
        existing.canonical_item_set_digest === receipt.item_set_digest &&
        existing.provider_copy_count === providerCopyCount &&
        existing.provider_copy_set_digest === providerCopySetDigest &&
        existing.project_copy_map_index_protocol === copyMapIndexProtocol &&
        existing.project_copy_map_index_ref === copyMapIndexRef &&
        existing.project_copy_map_index_sha256 === copyMapIndexSha256 &&
        existing.project_copy_scope_snapshot_id === copyScopeSnapshotId &&
        existing.project_copy_scope_snapshot_revision === copyScopeSnapshotRevision &&
        existing.project_copy_scope_snapshot_digest === copyScopeSnapshotDigest;
      if (
        (existing.state !== "PREPARING" && existing.state !== "MATERIALIZED") ||
        (!manifestEmpty && !manifestMatches)
      ) {
        projectionFail(
          "PROJECTION_AUTHORITY_CONFLICT",
          "projection materialized manifest changed for the exact generation",
        );
      }
      const targetInstanceId = assertProjectionIdentifier(
        existing.managed_target_instance_id,
        "materialized projection target instance",
      );
      const targetGeneration = assertProjectionIdentifier(
        existing.managed_target_generation,
        "materialized projection target generation",
      );
      const projectorProfile = assertProjectionIdentifier(
        existing.projector_profile,
        "materialized projection profile",
      );
      const mutationFence = await assertCurrentProjectionExecutionFence(
        database,
        clock,
        context,
        projectionGeneration,
        fence,
      );
      const now = nowIso(() => mutationFence.now_ms);
      await database.prepare(
        "UPDATE projection_generation SET state = 'MATERIALIZED', item_count = ?3, " +
        "item_set_digest = ?4, work_manifest_ref = ?5, work_manifest_sha256 = ?6, " +
        "canonical_projection_generation=?7, canonical_item_count=?8, " +
        "canonical_item_set_digest=?9, provider_copy_count=?10, " +
        "provider_copy_set_digest=?11, project_copy_map_index_protocol=?12, " +
        "project_copy_map_index_ref=?13, project_copy_map_index_sha256=?14, " +
        "project_copy_scope_snapshot_id=?15, project_copy_scope_snapshot_revision=?16, " +
        "project_copy_scope_snapshot_digest=?17, updated_at=?18 " +
        "WHERE source_revision_ref = ?1 AND projection_generation = ?2 " +
        "AND state IN ('PREPARING','MATERIALIZED') AND job_id=?19 " +
        "AND source_owner_generation=?20 AND content_sha256=?21 " +
        "AND object_residency_key_digest=?22 AND projector_profile=?23 " +
        "AND managed_item_protocol=?24 AND managed_target_instance_id=?25 " +
        "AND managed_target_generation=?26 " +
        "AND managed_target_metadata_generation_digest=?27 AND (" +
        "(item_count IS NULL AND item_set_digest IS NULL AND work_manifest_ref IS NULL " +
        "AND work_manifest_sha256 IS NULL AND canonical_projection_generation IS NULL " +
        "AND canonical_item_count IS NULL AND canonical_item_set_digest IS NULL " +
        "AND provider_copy_count IS NULL AND provider_copy_set_digest IS NULL " +
        "AND project_copy_map_index_protocol IS NULL AND project_copy_map_index_ref IS NULL " +
        "AND project_copy_map_index_sha256 IS NULL AND project_copy_scope_snapshot_id IS NULL " +
        "AND project_copy_scope_snapshot_revision IS NULL AND project_copy_scope_snapshot_digest IS NULL) " +
        "OR (item_count=?3 AND item_set_digest=?4 " +
        "AND work_manifest_ref=?5 AND work_manifest_sha256=?6 " +
        "AND canonical_projection_generation=?7 AND canonical_item_count=?8 " +
        "AND canonical_item_set_digest=?9 AND provider_copy_count=?10 " +
        "AND provider_copy_set_digest=?11 AND project_copy_map_index_protocol IS ?12 " +
        "AND project_copy_map_index_ref IS ?13 AND project_copy_map_index_sha256 IS ?14 " +
        "AND project_copy_scope_snapshot_id IS ?15 AND project_copy_scope_snapshot_revision IS ?16 " +
        "AND project_copy_scope_snapshot_digest IS ?17)) " +
        "AND EXISTS (SELECT 1 FROM operation_execution_lease l " +
        "WHERE l.operation_id=?28 AND l.operation_kind='PROJECTION_EXECUTE' " +
        "AND l.lease_owner=?29 AND l.lease_generation=?30 AND l.state='LEASED' " +
        `AND l.lease_until>?31 AND l.lease_until>${D1_EXECUTION_LEASE_NOW_SQL})`,
      ).bind(
        context.source_revision.source_revision_ref,
        projectionGeneration,
        receipt.item_count,
        receipt.item_set_digest,
        receipt.manifest_ref,
        receipt.manifest_sha256,
        canonicalGeneration,
        receipt.item_count,
        receipt.item_set_digest,
        providerCopyCount,
        providerCopySetDigest,
        copyMapIndexProtocol,
        copyMapIndexRef,
        copyMapIndexSha256,
        copyScopeSnapshotId,
        copyScopeSnapshotRevision,
        copyScopeSnapshotDigest,
        now,
        context.job_id,
        context.source_revision.source_owner_generation,
        context.source_revision.content_sha256,
        context.source_revision.object_residency_key_digest,
        projectorProfile,
        MANAGED_ITEM_PROTOCOL_VERSION,
        targetInstanceId,
        targetGeneration,
        metadataGenerationDigest,
        mutationFence.operation_id,
        mutationFence.lease_owner,
        mutationFence.lease_generation,
        mutationFence.now_ms,
      ).run();
      const readback = await generationRow(database, context, projectionGeneration);
      await assertCurrentProjectionExecutionFence(
        database,
        clock,
        context,
        projectionGeneration,
        fence,
      );
      if (
        readback === null ||
        readback.job_id !== context.job_id ||
        readback.source_owner_generation !== context.source_revision.source_owner_generation ||
        readback.content_sha256 !== context.source_revision.content_sha256 ||
        readback.object_residency_key_digest !== context.source_revision.object_residency_key_digest ||
        readback.projector_profile !== projectorProfile ||
        readback.managed_item_protocol !== MANAGED_ITEM_PROTOCOL_VERSION ||
        readback.managed_target_instance_id !== targetInstanceId ||
        readback.managed_target_generation !== targetGeneration ||
        readback.managed_target_metadata_generation_digest !== metadataGenerationDigest ||
        readback.state !== "MATERIALIZED" ||
        readback.item_count !== receipt.item_count ||
        readback.item_set_digest !== receipt.item_set_digest ||
        readback.work_manifest_ref !== receipt.manifest_ref ||
        readback.work_manifest_sha256 !== receipt.manifest_sha256 ||
        readback.canonical_projection_generation !== canonicalGeneration ||
        readback.canonical_item_count !== receipt.item_count ||
        readback.canonical_item_set_digest !== receipt.item_set_digest ||
        readback.provider_copy_count !== providerCopyCount ||
        readback.provider_copy_set_digest !== providerCopySetDigest ||
        readback.project_copy_map_index_protocol !== copyMapIndexProtocol ||
        readback.project_copy_map_index_ref !== copyMapIndexRef ||
        readback.project_copy_map_index_sha256 !== copyMapIndexSha256 ||
        readback.project_copy_scope_snapshot_id !== copyScopeSnapshotId ||
        readback.project_copy_scope_snapshot_revision !== copyScopeSnapshotRevision ||
        readback.project_copy_scope_snapshot_digest !== copyScopeSnapshotDigest
      ) {
        projectionFail(
          "PROJECTION_SETTLEMENT_UNCERTAIN",
          "projection materialization authority did not settle exactly",
          true,
        );
      }
    },

    async prepareManagedItems(context, projectionGeneration, profile, items, fence, copyPlan) {
      await assertManagedItemGenerationProtocol(
        database,
        context,
        projectionGeneration,
        profile,
      );
      return prepareManagedItemEffects(
        database,
        clock,
        context,
        projectionGeneration,
        profile,
        items,
        fence,
        copyPlan,
      );
    },

    async beginManagedItemDispatch(context, projectionGeneration, itemKey, fence) {
      await assertManagedItemGenerationProtocol(database, context, projectionGeneration);
      return beginManagedItemDispatch(
        database,
        clock,
        context,
        projectionGeneration,
        itemKey,
        fence,
      );
    },

    async recordManagedItemProviderId(context, projectionGeneration, itemKey, providerItemId, fence) {
      await assertManagedItemGenerationProtocol(database, context, projectionGeneration);
      return recordManagedItemProviderId(
        database,
        clock,
        context,
        projectionGeneration,
        itemKey,
        providerItemId,
        fence,
      );
    },

    async recordManagedItemReceipt(context, projectionGeneration, receipt, fence) {
      await assertManagedItemGenerationProtocol(database, context, projectionGeneration);
      return recordManagedItemReceipt(
        database,
        clock,
        context,
        projectionGeneration,
        receipt,
        fence,
      );
    },

    async markManagedItemUnknown(context, projectionGeneration, itemKey, fence) {
      await assertManagedItemGenerationProtocol(database, context, projectionGeneration);
      return markManagedItemUnknown(
        database,
        clock,
        context,
        projectionGeneration,
        itemKey,
        fence,
      );
    },

    readManagedItemGenerationProof(context, projectionGeneration, target) {
      return readManagedItemGenerationProof(
        database,
        context,
        projectionGeneration,
        target,
      );
    },

    settle(context, projectionGeneration, profile, settlement, fence: ExecutionFence) {
      return settleProjection({
        database,
        context,
        projection_generation: projectionGeneration,
        profile,
        settlement,
        execution_fence: fence,
        now: nowIso(clock),
        clock,
        read_terminal: () => readTerminalReceipt(
          database,
          context,
          projectionGeneration,
          profile,
        ),
      });
    },
  };
  return authority;
}
