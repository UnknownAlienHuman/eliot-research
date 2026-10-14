import { createD1ExecutionLeaseStore } from "../../../packages/platform-cloudflare/src/execution-lease.js";
import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import type { SourceAdmissionDecision } from "@eliotr/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  projectionDigest,
  projectionExecutionOperationId,
} from "../../../packages/cloudflare-projection/src/canonical.js";
import { createD1ProjectionAuthority } from "../../../packages/cloudflare-projection/src/core-authority.js";
import type {
  ProjectionExecutionProfile,
  ProjectionManagedItemAuthorityPort,
} from "../../../packages/cloudflare-projection/src/types.js";
import {
  db,
  insert,
  principal,
  seedSource,
  setupOrientationDatabase,
} from "./orientation-fixture.js";

const projectionHash = "c".repeat(64);
const documentHash = "d".repeat(64);
const sourceHash = "a".repeat(64);
const residencyHash = "b".repeat(64);

interface ManagedDispatchFixture {
  readonly source_id: string;
  readonly source_revision_ref: string;
  readonly projection_generation: string;
  readonly item_key: string;
  readonly authority: ProjectionManagedItemAuthorityPort;
  readonly context: Awaited<ReturnType<ProjectionManagedItemAuthorityPort["load"]>>;
  readonly fence: {
    readonly operation_id: string;
    readonly lease_owner: string;
    readonly lease_generation: number;
  };
}

async function prepareDispatchFixture(): Promise<ManagedDispatchFixture> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const sourceId = `managed-dispatch-source-${suffix}`;
  const sourceRevisionRef = `rev-${sourceId}`;
  const intentId = `managed-dispatch-intent-${suffix}`;
  const jobId = `managed-dispatch-job-${suffix}`;
  const attemptId = `managed-dispatch-attempt-${suffix}`;
  const outboxId = `managed-dispatch-outbox-${suffix}`;
  const idempotencyKey = `managed-dispatch-${suffix}`;
  const projectionGeneration = `managed-dispatch-generation-${suffix}`;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  await seedSource(sourceId);
  await insert("operation_intent", {
    intent_id: intentId,
    revision: 1,
    operation_kind: "PROJECTION",
    principal_ref: principal,
    idempotency_key: idempotencyKey,
    payload_ref: sourceRevisionRef,
    policy_decision_ref: `decision-${sourceId}`,
    created_at: now,
  });
  await insert("operation_attempt", {
    attempt_id: attemptId,
    intent_id: intentId,
    intent_revision: 1,
    attempt_number: 1,
    state: "SUCCEEDED",
    started_at: now,
    ended_at: now,
  });
  await insert("job", {
    job_id: jobId,
    intent_id: intentId,
    intent_revision: 1,
    state: "ACCEPTED",
    created_at: now,
    updated_at: now,
  });
  await insert("operation_receipt", {
    receipt_id: `managed-dispatch-acceptance-${suffix}`,
    revision: 1,
    intent_id: intentId,
    intent_revision: 1,
    attempt_id: attemptId,
    outcome: "ACCEPTED",
    output_refs_json: JSON.stringify([jobId]),
    readback_receipt_refs_json: "[]",
    reconciliation_required: 0,
    reason_codes_json: "[]",
    created_at: now,
  });
  await insert("outbox", {
    outbox_id: outboxId,
    intent_id: intentId,
    intent_revision: 1,
    topic: "source.revision.admitted",
    payload_ref: sourceRevisionRef,
    payload_sha256: sourceHash,
    state: "PENDING",
    attempts: 1,
    next_attempt_at: nowMs,
    created_at: now,
    updated_at: now,
  });

  const message = {
    protocol: "eliotr.delivery.message.v1" as const,
    message_id: `managed-dispatch-message-${suffix}`,
    topic: "source.revision.admitted" as const,
    payload_ref: sourceRevisionRef,
    payload_sha256: sourceHash,
    idempotency_key: idempotencyKey,
    outbox_id: outboxId,
    outbox_attempt: 1,
    created_at_ms: nowMs,
  };
  const authority = createD1ProjectionAuthority({ database: db });
  const context = await authority.load(message);
  const profile = {
    projector_profile: "structural-markdown-v1",
    managed_instance_id: `managed-dispatch-instance-${suffix}`,
    managed_generation: `managed-dispatch-managed-generation-${suffix}`,
    managed_generation_active: false,
    maximum_markdown_bytes: 4096,
    maximum_synchronous_items: 64,
    target_item_utf8_bytes: 1024,
    maximum_item_utf8_bytes: 4096,
    managed_poll_interval_ms: 100,
    managed_timeout_ms: 1000,
  } satisfies ProjectionExecutionProfile;
  const operationId = await projectionExecutionOperationId(context, projectionGeneration);
  const leaseOwner = `managed-dispatch-worker-${suffix}`;
  const lease = await createD1ExecutionLeaseStore(db).acquire({
    operation_id: operationId,
    operation_kind: "PROJECTION_EXECUTE",
    lease_owner: leaseOwner,
    now_ms: nowMs,
    lease_ms: 120_000,
  });
  if (lease === null) throw new Error("native dispatch fixture could not acquire its D1 execution lease");
  const fence = {
    operation_id: lease.operation_id,
    lease_owner: lease.lease_owner,
    lease_generation: lease.lease_generation,
  };

  await authority.begin(context, projectionGeneration, profile, fence);
  const itemKey = `managed-dispatch-item-${suffix}`;
  const itemIntent = {
    desired_index: 0,
    item_key: itemKey,
    provider_key: `${itemKey}.md`,
    provider_source: "builtin" as const,
    managed_instance_id: profile.managed_instance_id,
    managed_generation: profile.managed_generation,
    section_content_sha256: projectionHash,
    normalized_start_byte: 0,
    normalized_end_byte: 1,
    document_sha256: documentHash,
    document_size_bytes: 1,
    metadata: {
      canonical_section_id: `section-${suffix}`,
      content_sha256: projectionHash,
      instruction_taint: context.instruction_taint,
      projection_generation: profile.managed_generation,
      source_revision_ref: context.source_revision.source_revision_ref,
    },
  };
  const itemSetDigest = await projectionDigest([{
    item_key: itemIntent.item_key,
    canonical_section_id: itemIntent.metadata.canonical_section_id,
    content_sha256: itemIntent.section_content_sha256,
    start: itemIntent.normalized_start_byte,
    end: itemIntent.normalized_end_byte,
  }]);
  await authority.recordMaterialized(context, projectionGeneration, {
    manifest_ref: `managed-dispatch-manifest-${suffix}`,
    manifest_sha256: "e".repeat(64),
    item_set_digest: itemSetDigest,
    item_count: 1,
    item_receipts: [{
      item_key: itemKey,
      object_ref: `managed-dispatch-work-item-${suffix}`,
      readback_sha256: documentHash,
      size_bytes: 1,
      etag: `managed-dispatch-etag-${suffix}`,
    }],
  }, fence);
  await authority.prepareManagedItems(
    context,
    projectionGeneration,
    profile,
    [itemIntent],
    fence,
  );

  return {
    source_id: sourceId,
    source_revision_ref: sourceRevisionRef,
    projection_generation: projectionGeneration,
    item_key: itemKey,
    authority,
    context,
    fence,
  };
}

async function effectState(fixture: ManagedDispatchFixture) {
  return db.prepare(
    "SELECT state, provider_key, provider_item_id FROM projection_managed_item_effect " +
      "WHERE source_revision_ref = ?1 AND projection_generation = ?2 AND item_key = ?3",
  ).bind(
    fixture.source_revision_ref,
    fixture.projection_generation,
    fixture.item_key,
  ).first<{ readonly state: string; readonly provider_key: string; readonly provider_item_id: string | null }>();
}

async function advanceSourceHead(fixture: ManagedDispatchFixture): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const nextRevisionRef = `rev-managed-dispatch-head-${suffix}`;
  const operationId = `managed-dispatch-head-operation-${suffix}`;
  const contentSha256 = "f".repeat(64);
  const now = new Date().toISOString();
  await insert("source_revision", {
    source_revision_ref: nextRevisionRef,
    source_id: fixture.source_id,
    source_owner_generation: fixture.context.source_revision.source_owner_generation,
    content_sha256: contentSha256,
    object_residency_key_digest: residencyHash,
    normalized_artifact_ref: `normalized/${suffix}`,
    captured_at: now,
    quality_state: "standard",
    purge_state: "LIVE",
    source_view_ref: `view-managed-dispatch-head-${suffix}`,
    admitted_at: now,
  });
  await insert("bundle_ingest_operation", {
    operation_id: operationId,
    principal_ref: principal,
    origin_authentication_receipt_ref: "auth-1",
    idempotency_key: `managed-dispatch-head-ingest-${suffix}`,
    input_fingerprint: contentSha256,
    manifest_sha256: contentSha256,
    manifest_json: "{}",
    file_hashes_json: "{}",
    total_bytes: 1,
    source_namespace_id: fixture.context.source_revision.source_namespace_id,
    owner_system_id: fixture.context.source_revision.source_owner_system_id,
    source_owner_generation: fixture.context.source_revision.source_owner_generation,
    source_revision_ref: nextRevisionRef,
    source_id: fixture.source_id,
    residency_key_json: "{}",
    residency_key_digest: residencyHash,
    policy_revision: 1,
    policy_snapshot_json: "{}",
    policy_snapshot_sha256: contentSha256,
    candidate_id: `managed-dispatch-head-candidate-${suffix}`,
    state: "COMMITTED",
    created_at: now,
    updated_at: now,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const decision: SourceAdmissionDecision = {
    source_namespace_id: fixture.context.source_revision.source_namespace_id,
    owner_system_id: fixture.context.source_revision.source_owner_system_id,
    source_owner_generation: fixture.context.source_revision.source_owner_generation,
    source_revision_ref: nextRevisionRef,
    origin_authentication_receipt_ref: "auth-1",
    source_class: "document",
    assurance_ceiling: "QUALIFIED",
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    object_residency_key_digest: residencyHash,
    allowed_use: ["research"],
    disclosure_ceiling: "private",
    license_policy_ref: "license-1",
    decision: "ADMITTED",
    reason_codes: [],
    decision_receipt_ref: `managed-dispatch-head-decision-${suffix}`,
  };
  const { allowed_use: _allowed, reason_codes: _reasons, expires_at: _expires, ...scalars } = decision;
  await insert("source_admission_decision", {
    ...scalars,
    operation_id: operationId,
    allowed_use_json: '["research"]',
    reason_codes_json: "[]",
    decision_json: canonicalEvidenceJson(decision),
    decision_sha256: await evidenceSha256(decision),
    created_at: now,
  });
  await db.prepare("UPDATE source SET head_rev = ?2 WHERE source_id = ?1")
    .bind(fixture.source_id, nextRevisionRef).run();
  return nextRevisionRef;
}

describe("native managed item dispatch authority", () => {
  beforeAll(async () => setupOrientationDatabase());

  it.each(["owner", "purge"] as const)(
    "denies a new D1 dispatch when current %s authority changes after source load",
    async (changedAuthority) => {
      const fixture = await prepareDispatchFixture();
      if (changedAuthority === "owner") {
        await db.prepare(
          "UPDATE source_namespace_ownership SET status = 'FENCED' WHERE source_namespace_id = ?1",
        ).bind(fixture.context.source_revision.source_namespace_id).run();
      } else {
        await db.prepare(
          "UPDATE source_revision SET purge_state = 'PURGE_REQUESTED' WHERE source_revision_ref = ?1",
        ).bind(fixture.source_revision_ref).run();
      }

      await expect(fixture.authority.beginManagedItemDispatch(
        fixture.context,
        fixture.projection_generation,
        fixture.item_key,
        fixture.fence,
      )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
      await expect(effectState(fixture)).resolves.toMatchObject({
        state: "INTENT",
        provider_key: `${fixture.item_key}.md`,
        provider_item_id: null,
      });
    },
  );

  it("allows the accepted pinned revision to dispatch after a newer source head is admitted", async () => {
    const fixture = await prepareDispatchFixture();
    const nextRevisionRef = await advanceSourceHead(fixture);
    expect(nextRevisionRef).not.toBe(fixture.source_revision_ref);
    expect(fixture.context.source_revision.source_revision_ref).toBe(fixture.source_revision_ref);

    await expect(fixture.authority.beginManagedItemDispatch(
      fixture.context,
      fixture.projection_generation,
      fixture.item_key,
      fixture.fence,
    )).resolves.toBe(true);
    await expect(effectState(fixture)).resolves.toMatchObject({
      state: "DISPATCHED",
      provider_key: `${fixture.item_key}.md`,
      provider_item_id: null,
    });
  });
});
