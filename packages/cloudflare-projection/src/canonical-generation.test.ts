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
  canonicalProjectionJson,
} from "./canonical.js";
import { managedProjectFolderPrefix, managedProjectGenerationMetadataValue, createManagedProjectProviderKey } from "./managed-project-path.js";
import { canonicalSourceProjectionIdentity } from "./core-managed-item-intent.js";
import type {
  ProjectionExecutionProfile,
  ProjectionSourceContext,
  ProjectCopyScopeV2,
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

async function v2Context(projectId = "project-1"): Promise<ProjectionSourceContext> {
  const membershipId = `project:${projectId}:generation:1`;
  const target = { namespace: "eliotr", managed_instance_id: profile.managed_instance_id,
    managed_generation: profile.managed_generation, target_profile_identity_sha256: "d".repeat(64) };
  const scope: ProjectCopyScopeV2 = {
    layout: "PROJECT_COPY_V2", scope_snapshot_id: "persisted-project-snapshot", scope_snapshot_revision: 1,
    scope_snapshot_digest: "e".repeat(64), target,
    generation_metadata_value: await managedProjectGenerationMetadataValue(profile.managed_generation),
    representative_policy: "ONE_CANONICAL_COPY_PER_SOURCE_REVISION",
    target_selection: { protocol: "eliotr.managed-target-selection.v2", domain: "MANAGED_SEARCH_PRODUCT", decision_version: 2,
      selection_mode: "STABLE_PHYSICAL_PROFILE_V2", product_alias: "primary", purpose: "SHADOW", target,
      registry_revision: 1, registry_artifact_sha256: "f".repeat(64), v1_exact_profile_identity_sha256: "a".repeat(64) },
    copies: [{ source_revision_ref: sourceRevision.source_revision_ref, source_owner_generation: sourceRevision.source_owner_generation,
      project_id: projectId, project_membership_id: membershipId, membership_generation: 1, project_membership_generation: 7,
      membership_identity_version: 1, legacy_project_membership_id: membershipId,
      folder_prefix: await managedProjectFolderPrefix({ instance_id: profile.managed_instance_id,
        projection_generation: profile.managed_generation, source_revision_ref: sourceRevision.source_revision_ref,
        project_id: projectId, project_membership_id: membershipId, membership_generation: 1 }) }],
  };
  return { ...context, project_copy_scopes_v2: [scope] };
}

describe("projection generation identity", () => {
  it("binds new target and item inputs while retaining the legacy lookup key", async () => {
    const generation = await projectionGeneration(context, profile);
    expect(generation).toBe(await stableProjectionId("projection", "managed-items.v3", profile.projector_profile,
      profile.managed_instance_id, profile.managed_generation, sourceRevision.source_revision_ref,
      sourceRevision.content_sha256, sourceRevision.object_residency_key_digest,
      canonicalProjectionJson({ source_title: context.source_title, source_class: context.source_class,
        instruction_taint: context.instruction_taint, project_membership_ids: [...context.project_membership_ids].sort(),
        target_item_utf8_bytes: profile.target_item_utf8_bytes, maximum_item_utf8_bytes: profile.maximum_item_utf8_bytes })));

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

  it("shares canonical source identity across project memberships and provider targets", async () => {
    const sourceIdentity = await canonicalSourceProjectionIdentity(context, profile);
    const membershipB: ProjectionSourceContext = {
      ...context,
      project_membership_ids: ["project:project-b:generation:2"],
    };
    const targetB: ProjectionExecutionProfile = {
      ...profile,
      managed_instance_id: "managed-instance-b",
      managed_generation: "generation-b",
    };
    const sourceIdentityB = await canonicalSourceProjectionIdentity(membershipB, targetB);

    expect(sourceIdentityB).toEqual(sourceIdentity);
    expect(sourceIdentity.generation).not.toBe(await projectionGeneration(context, profile));
    expect(sourceIdentity.profile_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("separates V2 owner operations and project copies without changing the canonical source or provider key", async () => {
    const a = await v2Context(), b = await v2Context("project-b");
    const generation = await projectionGeneration(a, profile);
    const nextIntent = { ...a, intent_ref: { id: "intent-2", revision: 1 }, job_id: "job-2" };
    expect(await projectionGeneration(nextIntent, profile)).not.toBe(generation);
    expect(await projectionGeneration(b, profile)).not.toBe(generation);
    const scope = a.project_copy_scopes_v2?.[0];
    if (scope === undefined) throw new Error("missing target scope fixture");
    const otherNamespace = { ...scope.target, namespace: "other-namespace" };
    expect(await projectionGeneration({ ...a, project_copy_scopes_v2: [{ ...scope,
      target: otherNamespace, target_selection: { ...scope.target_selection, target: otherNamespace } }] }, profile)).not.toBe(generation);
    expect(await canonicalSourceProjectionIdentity(nextIntent, profile)).toEqual(await canonicalSourceProjectionIdentity(a, profile));
    expect(await canonicalSourceProjectionIdentity(b, profile)).toEqual(await canonicalSourceProjectionIdentity(a, profile));
    const copy = a.project_copy_scopes_v2?.[0]?.copies[0];
    if (copy === undefined) throw new Error("missing project copy fixture");
    const providerInput = { instance_id: profile.managed_instance_id, projection_generation: profile.managed_generation,
      source_revision_ref: sourceRevision.source_revision_ref, project_id: copy.project_id,
      project_membership_id: copy.project_membership_id, membership_generation: copy.membership_generation, item_key: `projection-${"1".repeat(48)}` };
    const key = await createManagedProjectProviderKey(providerInput);
    expect(key.folder_prefix).toBe(copy.folder_prefix);
    expect(key.provider_key).toBe(`${copy.folder_prefix}${providerInput.item_key}.md`);
  });

  it("does not remint a V2 execution on aggregate churn, unrelated legacy membership, or registry/snapshot renewal", async () => {
    const a = await v2Context();
    const scope = a.project_copy_scopes_v2?.[0];
    if (scope === undefined) throw new Error("missing scope fixture");
    const changed: ProjectionSourceContext = { ...a, project_membership_ids: ["project:unrelated:generation:99"],
      project_copy_scopes_v2: [{ ...scope, scope_snapshot_id: "renewed-snapshot", scope_snapshot_revision: 2,
        scope_snapshot_digest: "b".repeat(64),
        target_selection: { ...scope.target_selection, registry_revision: 2, registry_artifact_sha256: "c".repeat(64) },
        copies: scope.copies.map(copy => ({ ...copy, project_membership_generation: 8 })) }] };
    expect(await projectionGeneration(changed, profile)).toBe(await projectionGeneration(a, profile));
  });
});
