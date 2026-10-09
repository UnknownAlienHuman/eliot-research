import type {
  DeliveryMessage,
  ExecutionFence,
} from "@eliotr/platform-cloudflare";
import { D1_EXECUTION_LEASE_NOW_SQL } from "@eliotr/platform-cloudflare";
import {
  assertProjectionIdentifier,
  projectionFail,
} from "./canonical.js";
import { loadProjectionSourceContext } from "./core-load.js";
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
}

export function createD1ProjectionAuthority(
  dependencies: D1ProjectionAuthorityDependencies,
): ProjectionManagedItemAuthorityPort {
  const database = dependencies.database;
  const clock = dependencies.now ?? Date.now;
  const authority: ProjectionManagedItemAuthorityPort = {
    load(message: DeliveryMessage) {
      return loadProjectionSourceContext(database, message);
    },

    readTerminal(context, projectionGeneration, profile) {
      return readTerminalForProfile(database, context, projectionGeneration, profile);
    },

    async begin(context, projectionGeneration, profile, fence) {
      await assertCurrentProjectionExecutionFence(
        database,
        clock,
        context,
        projectionGeneration,
        fence,
      );
      const existing = await generationRow(database, context, projectionGeneration);
      if (existing !== null) {
        validateGenerationIdentity(existing, context, profile);
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
          "managed_target_generation, created_at, updated_at) " +
          "SELECT ?1,?2,?3,?4,?5,?6,?7,'PREPARING','[]',?8,?9,?10,?11,?11 " +
          "WHERE EXISTS (SELECT 1 FROM operation_execution_lease l " +
          "WHERE l.operation_id=?12 AND l.operation_kind='PROJECTION_EXECUTE' " +
          "AND l.lease_owner=?13 AND l.lease_generation=?14 AND l.state='LEASED' " +
          `AND l.lease_until>?15 AND l.lease_until>${D1_EXECUTION_LEASE_NOW_SQL}) ` +
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
      validateGenerationIdentity(readback, context, profile);
    },

    async recordMaterialized(context, projectionGeneration, receipt, fence) {
      validateProjectionWorkReceipt(receipt);
      await assertCurrentProjectionExecutionFence(
        database,
        clock,
        context,
        projectionGeneration,
        fence,
      );
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
        typeof existing.managed_target_generation !== "string"
      ) {
        projectionFail(
          "PROJECTION_AUTHORITY_CONFLICT",
          "materialized projection generation is missing its managed-item protocol target pin",
        );
      }
      const manifestEmpty = existing.item_count === null &&
        existing.item_set_digest === null &&
        existing.work_manifest_ref === null &&
        existing.work_manifest_sha256 === null;
      const manifestMatches = existing.item_count === receipt.item_count &&
        existing.item_set_digest === receipt.item_set_digest &&
        existing.work_manifest_ref === receipt.manifest_ref &&
        existing.work_manifest_sha256 === receipt.manifest_sha256;
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
        "updated_at = ?7 WHERE source_revision_ref = ?1 AND projection_generation = ?2 " +
        "AND state IN ('PREPARING','MATERIALIZED') AND job_id=?8 " +
        "AND source_owner_generation=?9 AND content_sha256=?10 " +
        "AND object_residency_key_digest=?11 AND projector_profile=?12 " +
        "AND managed_item_protocol=?13 AND managed_target_instance_id=?14 " +
        "AND managed_target_generation=?15 AND (" +
        "(item_count IS NULL AND item_set_digest IS NULL AND work_manifest_ref IS NULL " +
        "AND work_manifest_sha256 IS NULL) OR (item_count=?3 AND item_set_digest=?4 " +
        "AND work_manifest_ref=?5 AND work_manifest_sha256=?6)) " +
        "AND EXISTS (SELECT 1 FROM operation_execution_lease l " +
        "WHERE l.operation_id=?16 AND l.operation_kind='PROJECTION_EXECUTE' " +
        "AND l.lease_owner=?17 AND l.lease_generation=?18 AND l.state='LEASED' " +
        `AND l.lease_until>?19 AND l.lease_until>${D1_EXECUTION_LEASE_NOW_SQL})`,
      ).bind(
        context.source_revision.source_revision_ref,
        projectionGeneration,
        receipt.item_count,
        receipt.item_set_digest,
        receipt.manifest_ref,
        receipt.manifest_sha256,
        now,
        context.job_id,
        context.source_revision.source_owner_generation,
        context.source_revision.content_sha256,
        context.source_revision.object_residency_key_digest,
        projectorProfile,
        MANAGED_ITEM_PROTOCOL_VERSION,
        targetInstanceId,
        targetGeneration,
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
        readback.state !== "MATERIALIZED" ||
        readback.item_count !== receipt.item_count ||
        readback.item_set_digest !== receipt.item_set_digest ||
        readback.work_manifest_ref !== receipt.manifest_ref ||
        readback.work_manifest_sha256 !== receipt.manifest_sha256
      ) {
        projectionFail(
          "PROJECTION_SETTLEMENT_UNCERTAIN",
          "projection materialization authority did not settle exactly",
          true,
        );
      }
    },

    async prepareManagedItems(context, projectionGeneration, profile, items, fence) {
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
