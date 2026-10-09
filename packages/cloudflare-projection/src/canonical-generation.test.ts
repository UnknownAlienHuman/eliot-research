import type {
  SourceRevision,
} from "@eliotr/contracts";
import type {
  DeliveryMessage,
} from "@eliotr/platform-cloudflare";
import { describe, expect, it } from "vitest";
import {
  legacyProjectionGeneration,
  projectionGeneration,
  stableProjectionId,
} from "./canonical.js";
import type {
  ProjectionExecutionProfile,
  ProjectionSourceContext,
} from "./types.js";

const contentSha256 = "a".repeat(64);
const residencyDigest = "b".repeat(64);

const message: DeliveryMessage = {
  protocol: "eliotr.delivery.message.v1",
  message_id: "outbox-1:1",
  topic: "source.revision.admitted",
  payload_ref: "revision-1",
  payload_sha256: contentSha256,
  idempotency_key: "projection-1",
  outbox_id: "outbox-1",
  outbox_attempt: 1,
  created_at_ms: 1,
};

const sourceRevision: SourceRevision = {
  source_revision_ref: "revision-1",
  source_id: "source-1",
  source_namespace_id: "namespace-1",
  source_owner_system_id: "owner-1",
  source_owner_generation: "owner-generation-1",
  ownership_mode: "immutable_import",
  content_sha256: contentSha256,
  object_residency_key_digest: residencyDigest,
  normalized_artifact_ref: "normalized/manifest.json",
  captured_at: "2026-08-31T12:00:00.000Z",
  parser_profile_generation: "parser-1",
  quality_state: "standard",
  purge_state: "LIVE",
};

const context: ProjectionSourceContext = {
  message,
  intent_ref: { id: "intent-1", revision: 1 },
  job_id: "job-1",
  job_state: "ACCEPTED",
  acceptance_attempt_id: "attempt-1",
  source_revision: sourceRevision,
  source_title: "Research note",
  source_class: "document",
  instruction_taint: "DATA_ONLY",
  project_membership_ids: ["project:project-1:generation:1"],
};

const profile: ProjectionExecutionProfile = {
  projector_profile: "structural-markdown-v1",
  managed_instance_id: "managed-instance-1",
  managed_generation: "generation-1",
  managed_generation_active: false,
  maximum_markdown_bytes: 4 * 1024 * 1024,
  maximum_synchronous_items: 64,
  target_item_utf8_bytes: 1024,
  maximum_item_utf8_bytes: 4096,
  managed_poll_interval_ms: 100,
  managed_timeout_ms: 1_000,
};

describe("projection generation identity", () => {
  it("binds new target and item inputs while retaining the legacy lookup key", async () => {
    const generation = await projectionGeneration(context, profile);

    expect(generation).toBe(await projectionGeneration(context, profile));
    expect(generation).not.toBe(await projectionGeneration(context, {
      ...profile,
      managed_instance_id: "managed-instance-2",
    }));
    expect(generation).not.toBe(await projectionGeneration(context, {
      ...profile,
      managed_generation: "generation-2",
    }));
    expect(generation).not.toBe(await projectionGeneration(context, {
      ...profile,
      target_item_utf8_bytes: 2048,
    }));
    expect(generation).not.toBe(await projectionGeneration(context, {
      ...profile,
      maximum_item_utf8_bytes: 8192,
    }));
    expect(generation).not.toBe(await projectionGeneration({
      ...context,
      source_title: "Renamed research note",
    }, profile));
    expect(generation).not.toBe(await projectionGeneration({
      ...context,
      project_membership_ids: ["project:project-2:generation:1"],
    }, profile));

    const executionBudgetChange = await projectionGeneration(context, {
      ...profile,
      managed_generation_active: true,
      maximum_markdown_bytes: 8 * 1024 * 1024,
      maximum_synchronous_items: 32,
      managed_poll_interval_ms: 200,
      managed_timeout_ms: 2_000,
    });
    expect(executionBudgetChange).toBe(generation);

    const legacy = await legacyProjectionGeneration(context, profile);
    expect(legacy).toBe(await stableProjectionId(
      "projection",
      sourceRevision.source_revision_ref,
      sourceRevision.content_sha256,
      sourceRevision.object_residency_key_digest,
      profile.projector_profile,
    ));
    expect(legacy).not.toBe(generation);
    expect(await legacyProjectionGeneration(context, {
      ...profile,
      managed_instance_id: "managed-instance-2",
      managed_generation: "generation-2",
    })).toBe(legacy);
  });
});
