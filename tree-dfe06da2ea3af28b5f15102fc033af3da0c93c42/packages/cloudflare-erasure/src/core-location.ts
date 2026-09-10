import type {
  AbsenceVerificationReceipt,
  ErasureRequest,
  PurgeAttemptReceipt,
  PurgeTarget,
} from "@eliotr/contracts";
import {
  erasureFail,
  isoFromMs,
  stableErasureId,
} from "./canonical.js";
import type { ErasureLocationPort } from "./types.js";

function suffix(value: string, prefix: string): string | null {
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

async function receipt(
  prefix: string,
  request: ErasureRequest,
  target: PurgeTarget,
  disposition: string,
): Promise<string> {
  return stableErasureId(
    prefix,
    request.erasure_ref.id,
    String(request.erasure_ref.revision),
    target.target_id,
    disposition,
  );
}

function splitVersioned(value: string, prefix: string): { readonly id: string; readonly revision: number } | null {
  const body = suffix(value, prefix);
  if (body === null) return null;
  const separator = body.lastIndexOf(":");
  if (separator < 1 || !/^[1-9][0-9]*$/u.test(body.slice(separator + 1))) {
    erasureFail("ERASURE_INPUT_INVALID", `invalid versioned erasure target ${value}`);
  }
  const revision = Number(body.slice(separator + 1));
  if (!Number.isSafeInteger(revision) || revision < 1) {
    erasureFail("ERASURE_INPUT_INVALID", `invalid versioned erasure target ${value}`);
  }
  return { id: body.slice(0, separator), revision };
}

async function count(database: D1Database, sql: string, values: readonly unknown[]): Promise<number> {
  const row = await database.prepare(sql).bind(...values).first<{ count: number }>();
  if (row === null || !Number.isSafeInteger(row.count) || row.count < 0) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "D1 erasure absence count is malformed", true);
  }
  return row.count;
}

export interface D1CoreErasureLocationDependencies {
  readonly database: D1Database;
  readonly now?: () => number;
}

export function createD1CoreErasureLocationPort(
  dependencies: D1CoreErasureLocationDependencies,
): ErasureLocationPort {
  const database = dependencies.database;
  const clock = dependencies.now ?? Date.now;

  return {
    async purge(request, _fence, target): Promise<PurgeAttemptReceipt> {
      if (target.target_kind === "LOCATION_EMPTY_PROOF") {
        return {
          target_id: target.target_id,
          disposition: "ALREADY_ABSENT",
          receipt_ref: await receipt("delete-empty", request, target, "absent"),
        };
      }
      const now = isoFromMs(clock());
      const sourceRevision = suffix(target.canonical_ref, "d1-core:source-revision:");
      const evidenceHandle = splitVersioned(target.canonical_ref, "d1-core:evidence-handle:");
      const scopeSnapshot = splitVersioned(target.canonical_ref, "d1-core:scope-snapshot:");
      const operational = suffix(target.canonical_ref, "d1-core:operational:");
      const routeRevision = suffix(target.canonical_ref, "d1-core:route:source-revision:");
      const routeHandle = splitVersioned(target.canonical_ref, "d1-core:route:evidence-handle:");
      const routeScope = splitVersioned(target.canonical_ref, "d1-core:route:scope-snapshot:");
      const deletionRef = await receipt("delete-core", request, target, "accepted");

      if (sourceRevision !== null) {
        const result = await database.prepare(
          "UPDATE source_revision SET original_r2_key=NULL,normalized_artifact_ref=NULL," +
          "purge_state='REDACTED',currentness_state='unknown',source_view_ref=?2 " +
          "WHERE source_revision_ref=?1 AND purge_state IN " +
          "('LIVE','QUARANTINED','PURGE_REQUESTED','REDACTED') RETURNING source_revision_ref",
        ).bind(sourceRevision, `redacted:${target.identity_digest}`).first<{ source_revision_ref: string }>();
        if (result === null) erasureFail("ERASURE_IDENTITY_CONFLICT", "source revision erasure target is absent or retained");
      } else if (evidenceHandle !== null) {
        await database.prepare(
          "UPDATE evidence_handle SET terminal_state='REDACTED',invalidation_ref=?3 " +
          "WHERE handle_id=?1 AND revision=?2 AND terminal_state<>'RETENTION_BLOCKED'",
        ).bind(evidenceHandle.id, evidenceHandle.revision, deletionRef).run();
      } else if (scopeSnapshot !== null) {
        await database.prepare(
          "UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,?3)," +
          "invalidation_reason='ERASURE_REQUESTED' WHERE snapshot_id=?1 AND revision=?2",
        ).bind(scopeSnapshot.id, scopeSnapshot.revision, now).run();
      } else if (operational !== null) {
        await database.batch([
          database.prepare(
            "UPDATE outbox SET state='DEAD_LETTERED',lease_owner=NULL,lease_until=NULL," +
            "last_error_code='ERASURE_REQUESTED',updated_at=?2 WHERE payload_ref=?1 " +
            "AND state IN ('PENDING','LEASED','FAILED')",
          ).bind(operational, now),
          database.prepare(
            "UPDATE delivery_inbox SET state='TERMINAL_FAILURE',lease_owner=NULL,lease_until=NULL," +
            "last_error_code='ERASURE_REQUESTED',updated_at=?2 WHERE payload_ref=?1 " +
            "AND state IN ('PROCESSING','RETRYABLE_FAILURE')",
          ).bind(operational, clock()),
          database.prepare(
            "UPDATE operation_execution_lease SET state='CANCELLED',lease_until=?2," +
            "terminal_receipt_ref=?3,last_error_code='ERASURE_REQUESTED',updated_at=?2 " +
            "WHERE operation_id IN (SELECT intent_id FROM operation_intent WHERE payload_ref=?1) " +
            "AND state='LEASED'",
          ).bind(operational, clock(), deletionRef),
          database.prepare(
            "UPDATE job SET state='CANCELLED',current_stage='ERASURE_REQUESTED'," +
            "terminal_receipt_ref=?2,updated_at=?3 WHERE intent_id IN " +
            "(SELECT intent_id FROM operation_intent WHERE payload_ref=?1) " +
            "AND state IN ('ACCEPTED','RUNNING','PARTIAL','BLOCKED','FAILED')",
          ).bind(operational, deletionRef, now),
          database.prepare(
            "UPDATE operation_attempt SET state='CANCELLED',error_code='ERASURE_REQUESTED'," +
            "ended_at=?2 WHERE intent_id IN " +
            "(SELECT intent_id FROM operation_intent WHERE payload_ref=?1) " +
            "AND state IN ('STARTED','CHECKPOINTED','FAILED')",
          ).bind(operational, now),
        ]);
      } else if (routeRevision !== null) {
        await database.batch([
          database.prepare(
            "UPDATE source_readiness SET state='redacted',reason_codes_json='[\"ERASURE_REQUESTED\"]'," +
            "receipt_ref=?2,updated_at=?3 WHERE source_revision_ref=?1",
          ).bind(routeRevision, deletionRef, now),
          database.prepare(
            "UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,?2)," +
            "invalidation_reason='ERASURE_REQUESTED' WHERE EXISTS " +
            "(SELECT 1 FROM json_each(member_source_revision_refs_json) WHERE value=?1)",
          ).bind(routeRevision, now),
          database.prepare(
            "UPDATE scope_access_grant SET state='REVOKED' WHERE state='ACTIVE' AND EXISTS " +
            "(SELECT 1 FROM scope_snapshot s WHERE s.snapshot_id=scope_access_grant.snapshot_id " +
            "AND s.revision=scope_access_grant.snapshot_revision AND s.invalidated_at IS NOT NULL)",
          ),
          database.prepare(
            "UPDATE evidence_handle SET terminal_state='REDACTED',invalidation_ref=?2 " +
            "WHERE source_revision_ref=?1 AND terminal_state<>'RETENTION_BLOCKED'",
          ).bind(routeRevision, deletionRef),
        ]);
      } else if (routeHandle !== null) {
        await database.prepare(
          "UPDATE evidence_handle SET terminal_state='REDACTED',invalidation_ref=?3 " +
          "WHERE handle_id=?1 AND revision=?2 AND terminal_state<>'RETENTION_BLOCKED'",
        ).bind(routeHandle.id, routeHandle.revision, deletionRef).run();
      } else if (routeScope !== null) {
        await database.batch([
          database.prepare(
            "UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,?3)," +
            "invalidation_reason='ERASURE_REQUESTED' WHERE snapshot_id=?1 AND revision=?2",
          ).bind(routeScope.id, routeScope.revision, now),
          database.prepare(
            "UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 " +
            "AND snapshot_revision=?2 AND state='ACTIVE'",
          ).bind(routeScope.id, routeScope.revision),
          database.prepare(
            "UPDATE evidence_handle SET terminal_state='REDACTED',invalidation_ref=?3 " +
            "WHERE scope_snapshot_id=?1 AND scope_snapshot_revision=?2 " +
            "AND terminal_state<>'RETENTION_BLOCKED'",
          ).bind(routeScope.id, routeScope.revision, deletionRef),
        ]);
      } else {
        erasureFail("ERASURE_INPUT_INVALID", `unsupported D1 Core erasure target ${target.canonical_ref}`);
      }
      return { target_id: target.target_id, disposition: "DELETE_ACCEPTED", receipt_ref: deletionRef };
    },

    async verifyAbsent(request, _fence, target): Promise<AbsenceVerificationReceipt> {
      const empty = target.target_kind === "LOCATION_EMPTY_PROOF";
      let absent = empty;
      if (!empty) {
        const sourceRevision = suffix(target.canonical_ref, "d1-core:source-revision:");
        const evidenceHandle = splitVersioned(target.canonical_ref, "d1-core:evidence-handle:");
        const scopeSnapshot = splitVersioned(target.canonical_ref, "d1-core:scope-snapshot:");
        const operational = suffix(target.canonical_ref, "d1-core:operational:");
        const routeRevision = suffix(target.canonical_ref, "d1-core:route:source-revision:");
        const routeHandle = splitVersioned(target.canonical_ref, "d1-core:route:evidence-handle:");
        const routeScope = splitVersioned(target.canonical_ref, "d1-core:route:scope-snapshot:");
        if (sourceRevision !== null) {
          absent = await count(database,
            "SELECT COUNT(*) AS count FROM source_revision WHERE source_revision_ref=?1 " +
            "AND (purge_state<>'REDACTED' OR original_r2_key IS NOT NULL OR normalized_artifact_ref IS NOT NULL)",
            [sourceRevision]) === 0;
        } else if (evidenceHandle !== null) {
          absent = await count(database,
            "SELECT COUNT(*) AS count FROM evidence_handle WHERE handle_id=?1 AND revision=?2 " +
            "AND terminal_state NOT IN ('REDACTED','RETENTION_BLOCKED')",
            [evidenceHandle.id, evidenceHandle.revision]) === 0;
        } else if (scopeSnapshot !== null) {
          absent = await count(database,
            "SELECT COUNT(*) AS count FROM scope_snapshot WHERE snapshot_id=?1 AND revision=?2 " +
            "AND invalidated_at IS NULL",
            [scopeSnapshot.id, scopeSnapshot.revision]) === 0;
        } else if (operational !== null) {
          const activeOutbox = await count(database,
            "SELECT COUNT(*) AS count FROM outbox WHERE payload_ref=?1 " +
            "AND state IN ('PENDING','LEASED','FAILED')", [operational]);
          const activeJobs = await count(database,
            "SELECT COUNT(*) AS count FROM job WHERE intent_id IN " +
            "(SELECT intent_id FROM operation_intent WHERE payload_ref=?1) " +
            "AND state IN ('ACCEPTED','RUNNING','PARTIAL','BLOCKED')", [operational]);
          const activeInbox = await count(database,
            "SELECT COUNT(*) AS count FROM delivery_inbox WHERE payload_ref=?1 " +
            "AND state IN ('PROCESSING','RETRYABLE_FAILURE')", [operational]);
          const activeAttempts = await count(database,
            "SELECT COUNT(*) AS count FROM operation_attempt WHERE intent_id IN " +
            "(SELECT intent_id FROM operation_intent WHERE payload_ref=?1) " +
            "AND state IN ('STARTED','CHECKPOINTED')", [operational]);
          absent = activeOutbox === 0 && activeJobs === 0 && activeInbox === 0 && activeAttempts === 0;
        } else if (routeRevision !== null) {
          const liveHandles = await count(database,
            "SELECT COUNT(*) AS count FROM evidence_handle WHERE source_revision_ref=?1 " +
            "AND terminal_state='LIVE'", [routeRevision]);
          const activeScopes = await count(database,
            "SELECT COUNT(*) AS count FROM scope_snapshot WHERE invalidated_at IS NULL AND EXISTS " +
            "(SELECT 1 FROM json_each(member_source_revision_refs_json) WHERE value=?1)", [routeRevision]);
          absent = liveHandles === 0 && activeScopes === 0;
        } else if (routeHandle !== null) {
          absent = await count(database,
            "SELECT COUNT(*) AS count FROM evidence_handle WHERE handle_id=?1 AND revision=?2 " +
            "AND terminal_state='LIVE'", [routeHandle.id, routeHandle.revision]) === 0;
        } else if (routeScope !== null) {
          const activeScope = await count(database,
            "SELECT COUNT(*) AS count FROM scope_snapshot WHERE snapshot_id=?1 AND revision=?2 " +
            "AND invalidated_at IS NULL", [routeScope.id, routeScope.revision]);
          const activeGrant = await count(database,
            "SELECT COUNT(*) AS count FROM scope_access_grant WHERE snapshot_id=?1 " +
            "AND snapshot_revision=?2 AND state='ACTIVE'", [routeScope.id, routeScope.revision]);
          absent = activeScope === 0 && activeGrant === 0;
        } else {
          erasureFail("ERASURE_INPUT_INVALID", `unsupported D1 Core absence target ${target.canonical_ref}`);
        }
      }
      return {
        target_id: target.target_id,
        absent,
        receipt_ref: await receipt("absence-core", request, target, absent ? "absent" : "present"),
        ...(absent ? {} : { reason_code: "CORE_AUTHORITY_REMAINS" }),
      };
    },
  };
}
