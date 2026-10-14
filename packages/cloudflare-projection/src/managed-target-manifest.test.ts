import type { SourceRevision } from "@eliotr/contracts";
import type { AiSearchInstanceProfile, EvidenceObjectStore, ImmutableObjectReceipt } from "@eliotr/platform-cloudflare";
import { projectNormalizedMarkdown } from "@eliotr/retrieval";
import { describe, expect, it } from "vitest";
import {
  projectionDigest,
  projectionSha256Utf8,
} from "./canonical.js";
import type { ManagedRequiredProjectRevisionCopy, ManagedRequiredSetPort } from "./managed-required-set.js";
import { AI_SEARCH_PRIMARY_PROJECTION_PROFILE } from "./ai-search-primary-profile.js";
import {
  buildManagedTargetManifest,
  MANAGED_TARGET_MANIFEST_COPY_LAYOUT,
  type ManagedTargetManifestDocument,
  type ManagedTargetManifestDocumentPort,
  type ManagedTargetManifestDocumentProjector,
  type ManagedTargetManifestInput,
  type ManagedTargetManifestProfile,
  type ManagedTargetManifestShadowAuthorityPort,
  type ManagedTargetManifestSourceAuthority,
} from "./managed-target-manifest.js";

const AS_OF = "2026-10-14T16:00:00.000Z";
const OWNER_EXPIRY = "2027-01-01T00:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const DOCUMENT_MARKDOWN = "# Canonical source\n\nRequired target copy.\n";
const DOCUMENT_DIGEST = projectionSha256Utf8(DOCUMENT_MARKDOWN);

function sourceRevision(sourceId: string, contentSha: string): SourceRevision {
  return {
    source_revision_ref: `revision-${sourceId}`,
    source_id: sourceId,
    source_namespace_id: `namespace-${sourceId}`,
    source_owner_system_id: "owner-system",
    source_owner_generation: "owner-generation-1",
    ownership_mode: "immutable_import",
    content_sha256: contentSha,
    object_residency_key_digest: SHA_B,
    normalized_artifact_ref: `normalized-${sourceId}`,
    captured_at: "2026-10-01T00:00:00.000Z",
    quality_state: "standard",
    purge_state: "LIVE",
  };
}

function copy(projectId: string, sourceId = "source-a"): ManagedRequiredProjectRevisionCopy {
  return {
    assignment_revision: 1,
    project_id: projectId,
    project_generation: 1,
    project_owner_principal_ref: `owner-${projectId}`,
    namespace: "eliot",
    managed_instance_id: AI_SEARCH_PRIMARY_PROJECTION_PROFILE.id,
    managed_generation: AI_SEARCH_PRIMARY_PROJECTION_PROFILE.generation,
    target_profile_identity_sha256: "0".repeat(64),
    project_membership_id: `project:${projectId}:generation:1`,
    source_id: sourceId,
    source_revision_ref: `revision-${sourceId}`,
    source_head_revision_ref: `revision-${sourceId}`,
    source_namespace_id: `namespace-${sourceId}`,
    source_owner_system_id: "owner-system",
    source_ownership_mode: "immutable_import",
    source_owner_generation: "owner-generation-1",
    source_ownership_record_revision: 1,
    source_owner_status: "ACTIVE",
    source_admission_policy_revision: 1,
    source_admission_policy_source_class: "document",
    source_admission_decision_source_class: "document",
    source_class: "document",
    source_revision_content_sha256: SHA_A,
    normalized_artifact_ref: `normalized-${sourceId}`,
    purge_state: "LIVE",
    admission_decision: "ADMITTED",
    admission_decision_receipt_ref: `decision-${sourceId}`,
    admission_decision_sha256: SHA_B,
    admission_decision_expires_at: null,
    admission_disclosure_ceiling: "private",
    project_owner_read_policy_ref: `read-${projectId}`,
    project_owner_read_policy_generation: 1,
    project_owner_read_policy_state: "ACTIVE",
    project_owner_read_policy_disclosure_ceiling: "private",
    project_owner_read_policy_expires_at: OWNER_EXPIRY,
    membership_generation: 1,
    membership_valid_from: "2026-01-01T00:00:00.000Z",
    membership_valid_to: null,
  };
}

async function authority(sourceId: string): Promise<ManagedTargetManifestDocument> {
  return {
    source_revision: sourceRevision(sourceId, await DOCUMENT_DIGEST),
    source_title: `Title ${sourceId}`,
    source_class: "document",
    instruction_taint: "DATA_ONLY",
    markdown: DOCUMENT_MARKDOWN,
  };
}

const projection: ManagedTargetManifestDocumentProjector["project"] = async ({ copy: projectCopy, document, profile, target }) => {
  const projectionGeneration = `projection-${(await projectionDigest({
    source_revision_ref: projectCopy.source_revision_ref,
    project_membership_id: projectCopy.project_membership_id,
    target_generation: target.managed_generation,
  })).slice(0, 48)}`;
  return projectNormalizedMarkdown({
    source_revision: document.source_revision,
    title: document.source_title,
    source_class: document.source_class,
    markdown: document.markdown,
    instruction_taint: document.instruction_taint,
    project_membership_ids: [projectCopy.project_membership_id],
    projection_generation: projectionGeneration,
    target_item_utf8_bytes: profile.projection_profile.target_item_utf8_bytes,
    max_item_utf8_bytes: profile.projection_profile.maximum_item_utf8_bytes,
  });
};

class MemoryImmutableStore {
  public readonly objects = new Map<string, string>();
  public readonly store: EvidenceObjectStore;

  public constructor() {
    const objects = this.objects;
    this.store = {
      async putImmutable(write): Promise<ImmutableObjectReceipt> {
        const bytes = new Uint8Array(await new Response(write.body).arrayBuffer());
        const body = new TextDecoder().decode(bytes);
        const digest = await projectionSha256Utf8(body);
        if (digest !== write.expected_sha256 || bytes.byteLength !== write.expected_size_bytes) {
          throw new Error("memory store received bytes outside the immutable write receipt");
        }
        const previous = objects.get(write.key);
        if (previous !== undefined && previous !== body) throw new Error("immutable key collision");
        objects.set(write.key, body);
        return {
          key: write.key,
          expected_sha256: write.expected_sha256,
          readback_sha256: digest,
          size_bytes: bytes.byteLength,
          etag: `etag-${digest.slice(0, 12)}`,
          existed_identically: previous !== undefined,
        };
      },
      async putResidencyObject() { throw new Error("manifest assembly must not write Evidence residency objects"); },
      async open() { return null; },
      async deleteForErasure() { throw new Error("manifest assembly must not delete R2 objects"); },
    } as EvidenceObjectStore;
  }
}

async function setup(rows: readonly ManagedRequiredProjectRevisionCopy[], options: {
  readonly currentRows?: () => readonly ManagedRequiredProjectRevisionCopy[];
  readonly readAuthority?: (copy: ManagedRequiredProjectRevisionCopy) => ManagedTargetManifestSourceAuthority;
  readonly shadow?: ManagedTargetManifestShadowAuthorityPort;
  readonly as_of?: string;
} = {}) {
  const targetProfile = {
    ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
    index_method: { ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE.index_method },
    metadata_fields: [...AI_SEARCH_PRIMARY_PROJECTION_PROFILE.metadata_fields].sort(),
  } as AiSearchInstanceProfile;
  const profileIdentity = await projectionDigest(targetProfile);
  const target = {
    namespace: "eliot",
    managed_instance_id: targetProfile.id,
    managed_generation: targetProfile.generation,
    target_profile_identity_sha256: profileIdentity,
  };
  const profile: ManagedTargetManifestProfile = {
    target_profile: targetProfile,
    projection_profile: {
      projector_profile: "structural-markdown-v1",
      managed_instance_id: targetProfile.id,
      managed_generation: targetProfile.generation,
      managed_generation_active: false,
      maximum_markdown_bytes: 4096,
      maximum_synchronous_items: 64,
      target_item_utf8_bytes: 1024,
      maximum_item_utf8_bytes: 4096,
      managed_poll_interval_ms: 1000,
      managed_timeout_ms: 30000,
    },
    copy_layout: MANAGED_TARGET_MANIFEST_COPY_LAYOUT,
  };
  const store = new MemoryImmutableStore();
  const documentDigest = await DOCUMENT_DIGEST;
  const normalizeRows = (input: readonly ManagedRequiredProjectRevisionCopy[]) => input.map((row) => ({
    ...row,
    source_revision_content_sha256: documentDigest,
    namespace: target.namespace,
    managed_instance_id: target.managed_instance_id,
    managed_generation: target.managed_generation,
    target_profile_identity_sha256: profileIdentity,
  }));
  let currentRows = normalizeRows(options.currentRows?.() ?? rows);
  const setPort: ManagedRequiredSetPort = {
    async readFence() { return {
      authority_revision: 9,
      assigned_project_count: new Set(currentRows.map((row) => row.project_id)).size,
      stale_assignment_count: 0,
      profile_mismatch_count: 0,
    }; },
    async readPage() {
      return { authority_revision: 9, rows: normalizeRows(currentRows), next_cursor: null };
    },
  };
  const documentPort: ManagedTargetManifestDocumentPort = {
    async readDocument({ copy: projectCopy }) { return authority(projectCopy.source_id); },
    async readAuthority({ copy: projectCopy }) { return options.readAuthority?.(projectCopy) ?? authority(projectCopy.source_id); },
  };
  const shadow: ManagedTargetManifestShadowAuthorityPort = options.shadow ?? {
    async read() {
      return {
        registry_revision: null,
        registry_sha256: null,
        active_head_generation: null,
        generation_state: "UNDECLARED",
        generation_profile_identity_sha256: null,
        expected_item_count: null,
      };
    },
  };
  const input: ManagedTargetManifestInput = {
    target,
    profile,
    as_of: options.as_of ?? AS_OF,
    required_set: setPort,
    shadow_authority: shadow,
    documents: documentPort,
    projector: { project: projection },
    work_store: store.store,
  };
  return {
    input,
    store,
    setCurrentRows(value: readonly ManagedRequiredProjectRevisionCopy[]) { currentRows = normalizeRows(value); },
  };
}

describe("managed target-wide desired-item manifest", () => {
  it("counts project copies directly from Core authority, including a source with no projection job", async () => {
    const projectCopies = [copy("project-a"), copy("project-b")];
    const state = await setup(projectCopies);
    const result = await buildManagedTargetManifest(state.input);
    expect(result.project_revision_copy_count).toBe(2);
    expect(result.desired_item_count).toBe(2);
    expect(result.manifest_ref).toContain("managed-target-manifests/");
    expect(state.store.objects.has(result.manifest_ref)).toBe(true);
  });

  it("raises when an enumerated required copy has no normalized bytes", async () => {
    const state = await setup([copy("project-a")]);
    state.input.documents.readDocument = async () => {
      throw new Error("normalized R2 bytes are absent");
    };
    await expect(buildManagedTargetManifest(state.input)).rejects.toThrow("normalized R2 bytes are absent");
    expect([...state.store.objects.keys()].some((key) => key.includes("/roots/"))).toBe(false);
  });

  it.each([
    ["membership", (rows: readonly ManagedRequiredProjectRevisionCopy[]) => rows.slice(1)],
    ["source", (rows: readonly ManagedRequiredProjectRevisionCopy[]) => rows.map((row) => ({ ...row, admission_decision_sha256: "c".repeat(64) }))],
    ["owner", (rows: readonly ManagedRequiredProjectRevisionCopy[]) => rows.map((row) => ({ ...row, project_owner_principal_ref: "changed-owner" }))],
    ["purge", (_rows: readonly ManagedRequiredProjectRevisionCopy[]) => []],
  ] as const)("raises if %s authority drifts during staging", async (_name, mutate) => {
    let current = [copy("project-a"), copy("project-b")];
    const state = await setup(current, { currentRows: () => current });
    const documentDigest = await DOCUMENT_DIGEST;
    const bindCurrentProfile = (rows: readonly ManagedRequiredProjectRevisionCopy[]) => rows.map((row) => ({
      ...row,
      source_revision_content_sha256: documentDigest,
      namespace: state.input.target.namespace,
      managed_instance_id: state.input.target.managed_instance_id,
      managed_generation: state.input.target.managed_generation,
      target_profile_identity_sha256: state.input.target.target_profile_identity_sha256,
    }));
    current = bindCurrentProfile(current);
    // The first scan projects both rows. The post-scan receives the changed Core view.
    let pages = 0;
    const driftPort: ManagedRequiredSetPort = {
      async readFence() { return {
        authority_revision: 9,
        assigned_project_count: 2,
        stale_assignment_count: 0,
        profile_mismatch_count: 0,
      }; },
      async readPage() {
        pages += 1;
        if (pages === 1) current = [...mutate(current)];
        return { authority_revision: 9, rows: pages === 1
          ? bindCurrentProfile([copy("project-a"), copy("project-b")])
          : current, next_cursor: null };
      },
    };
    await expect(buildManagedTargetManifest({ ...state.input, required_set: driftPort })).rejects.toMatchObject({
      code: "MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED",
    });
    expect([...state.store.objects.keys()].some((key) => key.includes("/roots/"))).toBe(false);
  });

  it("keeps the desired-item digest stable while the as-of eligibility digest changes", async () => {
    const rows = [copy("project-a")];
    const first = await setup(rows, { as_of: AS_OF });
    const second = await setup(rows, { as_of: "2026-10-14T16:01:00.000Z" });
    const firstReceipt = await buildManagedTargetManifest(first.input);
    const secondReceipt = await buildManagedTargetManifest(second.input);
    expect(secondReceipt.desired_item_set_digest).toBe(firstReceipt.desired_item_set_digest);
    expect(secondReceipt.eligibility_digest).not.toBe(firstReceipt.eligibility_digest);
  });

  it("projects and stages one required copy at a time in enumerator order", async () => {
    const rows = [copy("project-a", "source-a"), copy("project-b", "source-b")];
    const state = await setup(rows);
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const orderedInput: ManagedTargetManifestInput = {
      ...state.input,
      projector: {
      async project(input) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(input.copy.project_id);
        await Promise.resolve();
        inFlight -= 1;
        return projection(input);
      },
      },
    };
    const result = await buildManagedTargetManifest(orderedInput);
    expect(result.project_revision_copy_count).toBe(2);
    expect(order).toEqual(["project-a", "project-b"]);
    expect(maxInFlight).toBe(1);
  });

  it("rejects an active generation and a caller-provided expected-count mismatch", async () => {
    const rows = [copy("project-a")];
    const active = await setup(rows, {
      shadow: { async read() { return {
        registry_revision: 1,
        registry_sha256: SHA_A,
        active_head_generation: AI_SEARCH_PRIMARY_PROJECTION_PROFILE.generation,
        generation_state: "ACTIVE",
        generation_profile_identity_sha256: "0".repeat(64),
        expected_item_count: 1,
      }; } },
    });
    await expect(buildManagedTargetManifest(active.input)).rejects.toMatchObject({
      code: "MANAGED_TARGET_MANIFEST_SHADOW_REQUIRED",
    });

    const mismatch = await setup(rows, {
      shadow: { async read(_target, exactProfile) { return {
        registry_revision: 1,
        registry_sha256: SHA_A,
        active_head_generation: "previous-generation",
        generation_state: "SHADOW_BUILDING",
        generation_profile_identity_sha256: await projectionDigest(exactProfile),
        expected_item_count: 2,
      }; } },
    });
    await expect(buildManagedTargetManifest(mismatch.input)).rejects.toMatchObject({
      code: "MANAGED_TARGET_MANIFEST_EXPECTED_COUNT_MISMATCH",
    });
  });
});
