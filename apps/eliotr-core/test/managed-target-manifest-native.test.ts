import { beforeEach, describe, expect, it } from "vitest";
import { reset } from "cloudflare:test";
import {
  createD1ManagedTargetAssignmentPort,
  AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  projectionDigest,
  projectionSha256Utf8,
  type ManagedTargetIdentity,
  type ManagedTargetManifestInput,
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

async function seedRequiredCopy(sourceId: string): Promise<{ readonly projectId: string; readonly target: ManagedTargetIdentity }> {
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
  return { projectId, target };
}

function operationBudget() {
  return {
    protocol: "eliotr.managed-target-operation-budget.v1" as const,
    subrequest_upper_bound: 1,
    cpu_upper_bound_ms: 500,
    input_bytes_upper_bound: 4_096,
  };
}

function canonicalProjectionPort(): ManagedTargetManifestInput["canonical_projection"] {
  return {
    async readCanonicalSource({ copy, source_authority, profile }) {
      const profileSha = await projectionDigest({
        projector_profile: profile.projection_profile.projector_profile,
        target_item_utf8_bytes: profile.projection_profile.target_item_utf8_bytes,
        maximum_item_utf8_bytes: profile.projection_profile.maximum_item_utf8_bytes,
      });
      const generation = `canonical-${copy.source_id}`;
      const sourceToken = (await projectionSha256Utf8(`source\u0000${copy.source_revision_ref}`)).slice(0, 48);
      const prefix = `projection/${sourceToken}/`;
      const sections = [{
        canonical_section_id: `section-${copy.source_id}`,
        content_sha256: copy.source_revision_content_sha256,
        normalized_start_byte: 0,
        normalized_end_byte: 1,
        canonical_body_ref: `${prefix}${generation}/items/${copy.source_id}.json`,
        canonical_body_sha256: "b".repeat(64),
      }];
      return {
        receipt: {
          protocol: "eliotr.canonical-source-projection.v1",
          source_revision_ref: copy.source_revision_ref,
          complete_residency_key_sha256: source_authority.source_revision.object_residency_key_digest,
          projector_profile_sha256: profileSha,
          canonical_projection_generation: generation,
          canonical_source_ref: `${prefix}${generation}/manifests/source.json`,
          canonical_source_sha256: "b".repeat(64),
          canonical_section_count: sections.length,
          canonical_section_set_sha256: await projectionDigest({ protocol: "eliotr.canonical-section-set.v1", sections }),
          sections,
        },
        budget: operationBudget(),
      };
    },
    async readProjectCopy({ target, copy, canonical_source: source }) {
      const items = source.sections.map((section) => ({
        item_key: `item-${copy.project_id}-${copy.source_id}`,
        canonical_section_id: section.canonical_section_id,
        content_sha256: section.content_sha256,
        canonical_body_ref: section.canonical_body_ref,
        canonical_body_sha256: section.canonical_body_sha256,
      }));
      const providerItemSetSha256 = await projectionDigest({
        protocol: "eliotr.managed-provider-item-set.v1",
        items: items.map((item) => ({
          item_key: item.item_key,
          canonical_section_id: item.canonical_section_id,
          content_sha256: item.content_sha256,
          canonical_body_ref: item.canonical_body_ref,
          canonical_body_sha256: item.canonical_body_sha256,
        })),
      });
      return {
        receipt: {
          protocol: "eliotr.managed-project-copy-map.v1",
          source_revision_ref: copy.source_revision_ref,
          complete_residency_key_sha256: source.complete_residency_key_sha256,
          target,
          project_id: copy.project_id,
          project_membership_id: copy.project_membership_id,
          membership_generation: copy.membership_generation,
          canonical_source_ref: source.canonical_source_ref,
          canonical_source_sha256: source.canonical_source_sha256,
          provider_copy_count: 1 as const,
          provider_copy_set_sha256: await projectionDigest({
            protocol: "eliotr.managed-provider-copy-set.v1",
            target,
            project_id: copy.project_id,
            project_membership_id: copy.project_membership_id,
            membership_generation: copy.membership_generation,
            provider_item_set_sha256: providerItemSetSha256,
            provider_item_count: items.length,
          }),
          provider_item_count: items.length,
          provider_item_set_sha256: providerItemSetSha256,
          items,
        },
        budget: operationBudget(),
      };
    },
  };
}

function composer(canonicalProjection = canonicalProjectionPort()) {
  return createManagedTargetManifestComposer(runtime, {
    target_profile: AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
    projection_profile: PROJECTION_EXECUTION_PROFILE,
    copy_layout: "PROJECT_COPY_V1",
    provider_capacity_authority: {
      async read() {
        return {
          receipt: {
            protocol: "eliotr.managed-target-provider-capacity.v1",
            account_tier: "PAID",
            account_authority_ref: "fixture:verified-cloudflare-paid-tier",
            account_authority_sha256: "a".repeat(64),
            checked_at: CORE_NOW,
            max_files_per_instance: 500_000,
            documentation_modified_on: "2026-10-01",
          },
          profile_readback: AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
          profile_authority_ref: "fixture:current-ai-search-profile-readback",
          profile_authority_sha256: "b".repeat(64),
          profile_readback_checked_at: CORE_NOW,
          budget: operationBudget(),
        };
      },
    },
    canonical_projection: canonicalProjection,
    now: () => Date.parse(CORE_NOW),
  });
}

async function advanceUntilReady(target: ManagedTargetIdentity, canonicalProjection?: ManagedTargetManifestInput["canonical_projection"]) {
  const selected = composer(canonicalProjection);
  let step = await selected.advance(target, "managed-target-manifest-native-execution");
  for (let count = 0; step.status === "CONTINUE" && count < 50; count += 1) {
    if (step.continuation === null) throw new Error("manifest step omitted its continuation");
    step = await selected.advance(target, "managed-target-manifest-native-execution", step.continuation);
    if (step.budget.operation_upper_bound > 16 || step.budget.cpu_upper_bound_ms >= 30_000) {
      throw new Error("native manifest step exceeded its source budget");
    }
  }
  return step;
}

describe("managed target manifest Core/R2 composition", () => {
  it("folds the current assigned project into a non-authoritative ready candidate", async () => {
    const fixture = await seedRequiredCopy("manifest-native");
    const step = await advanceUntilReady(fixture.target);
    expect(step).toMatchObject({
      protocol: "eliotr.managed-target-manifest-step.v1",
      status: "READY_FOR_FINALIZATION",
      candidate: {
        protocol: "eliotr.managed-target-desired-items.v2",
        desired_item_count: 1,
        finalization_state: "REQUIRES_HELD_WRITER_DRAIN_AND_EXPECTED_HEAD_CAS",
      },
    });
    const candidateRef = step.candidate?.candidate_ref;
    expect(candidateRef).toBeDefined();
    const candidateObject = candidateRef === undefined ? null : await runtime.WORK_BUCKET.get(candidateRef);
    expect(candidateObject).not.toBeNull();
    const payload = await candidateObject?.json<{ readonly desired_item_count: number; readonly required_set: { readonly project_revision_copy_count: number } }>();
    expect(payload).toMatchObject({ desired_item_count: 1, required_set: { project_revision_copy_count: 1 } });
    const targetCopies = await runtime.WORK_BUCKET.list({ prefix: "managed-target-manifests/", limit: 100 });
    for (const object of targetCopies.objects.filter((entry) => entry.key.includes("/copies/"))) {
      const copy = await runtime.WORK_BUCKET.get(object.key);
      const body = await copy?.text();
      expect(body).not.toContain("section_text");
      expect(body).not.toContain("document_context_header");
      expect(body).not.toContain("Canonical normalized content");
    }
  });

  it("fails closed when canonical source receipt authority is unavailable", async () => {
    const fixture = await seedRequiredCopy("manifest-bytes-missing");
    const canonicalProjection = canonicalProjectionPort();
    canonicalProjection.readCanonicalSource = async () => {
      throw new Error("canonical source writer authority is unavailable");
    };
    await expect(advanceUntilReady(fixture.target, canonicalProjection))
      .rejects.toThrow("canonical source writer authority is unavailable");
  });
});
