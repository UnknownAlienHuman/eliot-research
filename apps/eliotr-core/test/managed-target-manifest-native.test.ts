import { beforeEach, describe, expect, it } from "vitest";
import { reset } from "cloudflare:test";
import { canonicalNormalizedBundleKey } from "@eliotr/platform-cloudflare";
import {
  createD1ManagedTargetAssignmentPort,
  AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  type ManagedTargetIdentity,
} from "@eliotr/cloudflare-projection";
import { PROJECTION_EXECUTION_PROFILE } from "@eliotr/cloudflare-ai";
import { createProjectOwnerService } from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createManagedTargetManifestComposer } from "../src/managed-target-manifest-composition.js";
import { readConfiguredManagedTargetIdentity } from "../src/managed-target-assignment.js";
import {
  db,
  insert,
  principal,
  runtime,
  seedSource,
  setupOrientationDatabase,
} from "./orientation-fixture.js";

const CORE_NOW = "2026-10-14T16:00:00.000Z";

beforeEach(async () => {
  await reset();
  await setupOrientationDatabase();
});

function ownerContext(): AuthenticatedRequestContext {
  return {
    request: new Request("https://research.example/api/v1/research/projects", { method: "POST" }),
    principal_ref: principal,
    credential_generation: "credential-v1",
    client_class: "owner_pwa",
    trace_id: "managed-target-manifest-native",
  };
}

async function seedRequiredCopy(sourceId: string): Promise<{ readonly projectId: string; readonly target: ManagedTargetIdentity; readonly bytes: Uint8Array }> {
  await seedSource(sourceId);
  const markdown = `# ${sourceId}\n\nCanonical normalized content.\n`;
  const bytes = new TextEncoder().encode(markdown);
  const contentSha = await crypto.subtle.digest("SHA-256", bytes).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
  await db.prepare("UPDATE source_revision SET content_sha256=?1 WHERE source_revision_ref=?2")
    .bind(contentSha, `rev-${sourceId}`).run();
  await insert("source_admission_policy", {
    source_namespace_id: `ns-${sourceId}`,
    revision: 1,
    authorized_principal_refs_json: JSON.stringify([principal]),
    allowed_ownership_modes_json: JSON.stringify(["immutable_import"]),
    source_class: "document",
    assurance_ceiling: "QUALIFIED",
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    allowed_use_json: JSON.stringify(["research"]),
    disclosure_ceiling: "private",
    license_policy_ref: "license-1",
    default_storage_policy: "NORMALIZED_CLOUD_ONLY",
    default_residency_profile_id: "residency-1",
    default_retention_policy_id: "retention-1",
    minimum_quality_state: "standard",
    created_at: CORE_NOW,
  });

  const projects = createProjectOwnerService({
    database: db,
    deployment_generation: runtime.DEPLOYMENT_GENERATION,
  });
  const created = await projects.create(ownerContext(), {
    idempotency_key: `target-manifest-project-${sourceId}`,
    title: `Target manifest ${sourceId}`,
    source_ids: [],
  });
  const projectId = created.project_ref.id;
  await insert("project_source_membership", {
    project_id: projectId,
    source_id: sourceId,
    role: "reference",
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
    membership_generation: 1,
  });

  const target = await readConfiguredManagedTargetIdentity();
  const assignments = createD1ManagedTargetAssignmentPort(db, async () => {});
  await assignments.append({
    event_kind: "ASSIGN",
    project_id: projectId,
    project_generation: 1,
    project_owner_principal_ref: principal,
    expected_event_revision: 0,
    actor: {
      kind: "OWNER",
      principal_ref: principal,
      authorization_receipt_ref: `fixture-authority-${sourceId}`,
    },
    created_at: CORE_NOW,
    target,
  });
  return { projectId, target, bytes };
}

function composer() {
  return createManagedTargetManifestComposer(runtime, {
    target_profile: AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
    projection_profile: PROJECTION_EXECUTION_PROFILE,
    copy_layout: "PROJECT_COPY_V1",
    now: () => Date.parse(CORE_NOW),
  });
}

async function putNormalizedBytes(sourceId: string, bytes: Uint8Array): Promise<void> {
  const key = await canonicalNormalizedBundleKey(
    "b".repeat(64),
    {
      owner_system_id: "eliotr",
      source_namespace_id: `ns-${sourceId}`,
      source_owner_generation: "owner-gen-1",
      source_logical_id: sourceId,
      source_revision_ref: `rev-${sourceId}`,
    },
    "content.md",
  );
  await runtime.EVIDENCE_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });
}

describe("managed target manifest Core/R2 composition", () => {
  it("enumerates the current assigned project through Core and stages exact normalized bytes in Work R2", async () => {
    const fixture = await seedRequiredCopy("manifest-native");
    await putNormalizedBytes("manifest-native", fixture.bytes);

    const receipt = await composer().assemble(fixture.target);
    expect(receipt).toMatchObject({
      protocol: "eliotr.managed-target-desired-items.v2",
      project_revision_copy_count: 1,
      desired_item_count: 1,
      copy_layout: "PROJECT_COPY_V1",
    });
    const root = await runtime.WORK_BUCKET.get(receipt.manifest_ref);
    expect(root).not.toBeNull();
    const payload = await root?.json<{ readonly desired_item_count: number; readonly project_revision_copy_count: number }>();
    expect(payload).toMatchObject({ desired_item_count: 1, project_revision_copy_count: 1 });
  });

  it("fails complete-or-raise when the eligible source has no exact normalized R2 object", async () => {
    const fixture = await seedRequiredCopy("manifest-bytes-missing");
    await expect(composer().assemble(fixture.target)).rejects.toMatchObject({
      code: "MANAGED_TARGET_MANIFEST_SOURCE_INVALID",
    });
  });
});
