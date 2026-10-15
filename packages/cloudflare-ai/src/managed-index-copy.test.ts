import { describe, expect, it } from "vitest";
import {
  projectionDigest,
  projectionSha256Utf8,
  type ManagedProjectCopyMapReceipt,
  type ManagedProjectCopyPlan,
  type ManagedProjectCopyTargetReceipt,
  type ProjectionSourceContext,
} from "@eliotr/cloudflare-projection";
import {
  context,
  createManagedProjectionTestWriter,
  createMemoryManagedItemAuthority,
  downloaded,
  item,
  profile,
  SECTION_SHA256,
} from "./managed-index.test-support.js";
import type { ProjectionAiSearchNamespace } from "./managed-index.js";
import type { ProjectionAiSearchInstance } from "./managed-index-readback.js";

const CANONICAL_GENERATION = "canonical-generation-1";
const EXECUTION_GENERATION = "projection-execution-g1";
const CANONICAL_SOURCE_REF = "canonical-source-1";
const CANONICAL_SOURCE_SHA256 = "c".repeat(64);

async function projectCopyPlan(): Promise<{
  readonly context: ProjectionSourceContext;
  readonly plan: ManagedProjectCopyPlan;
}> {
  const copyContext: ProjectionSourceContext = {
    ...context,
    project_membership_ids: [
      "project:project-a:generation:1",
      "project:project-b:generation:1",
    ],
  };
  const metadataGenerationDigest = await projectionSha256Utf8(
    `eliotr.project-copy-generation.v1\u0000${profile.managed_generation}`,
  );
  const target: ManagedProjectCopyTargetReceipt = {
    managed_instance_id: profile.managed_instance_id,
    managed_generation: profile.managed_generation,
    metadata_generation_digest: metadataGenerationDigest,
  };
  const copies: ManagedProjectCopyMapReceipt[] = [];
  const items: ManagedProjectCopyPlan["items"][number][] = [];

  for (const [index, projectId] of ["project-a", "project-b"].entries()) {
    const membershipId = `project:${projectId}:generation:1`;
    const itemKey = `projection-${String(index + 1).repeat(48)}`;
    const providerKey = `projection/${String.fromCharCode(97 + index).repeat(43)}/${itemKey}.md`;
    const canonicalBodyRef = `projection/source-token/${CANONICAL_GENERATION}/sections/${item.item_key}.md`;
    const mappedItem: ManagedProjectCopyMapReceipt["items"][number] = {
      item_key: itemKey,
      canonical_item_key: item.item_key,
      canonical_section_id: item.canonical_section_id,
      content_sha256: SECTION_SHA256,
      normalized_start_byte: 0,
      normalized_end_byte: 19,
      provider_key: providerKey,
      canonical_body_ref: canonicalBodyRef,
      canonical_body_sha256: SECTION_SHA256,
    };
    const providerItemSetSha256 = await projectionDigest([{
      item_key: mappedItem.item_key,
      canonical_section_id: mappedItem.canonical_section_id,
      content_sha256: mappedItem.content_sha256,
      start: mappedItem.normalized_start_byte,
      end: mappedItem.normalized_end_byte,
    }]);
    const payload = {
      protocol: "eliotr.managed-project-copy-map.v1" as const,
      source_revision_ref: copyContext.source_revision.source_revision_ref,
      complete_residency_key_sha256: copyContext.source_revision.object_residency_key_digest,
      canonical_projection_generation: CANONICAL_GENERATION,
      target,
      project_id: projectId,
      project_membership_id: membershipId,
      membership_generation: 1,
      canonical_source_ref: CANONICAL_SOURCE_REF,
      canonical_source_sha256: CANONICAL_SOURCE_SHA256,
      provider_copy_count: 1 as const,
      provider_item_count: 1,
      provider_item_set_sha256: providerItemSetSha256,
      items: [mappedItem],
    };
    const providerCopySetSha256 = await projectionDigest(payload);
    copies.push({ ...payload, provider_copy_set_sha256: providerCopySetSha256 });
    const plannedItem: ManagedProjectCopyPlan["items"][number] = {
      ...item,
      item_key: itemKey,
      project_membership_ids: [membershipId],
      projection_generation: metadataGenerationDigest,
      normalized_start_byte: 0,
      normalized_end_byte: 19,
      copy_layout: "PROJECT_COPY_V1",
      canonical_projection_generation: CANONICAL_GENERATION,
      canonical_item_key: item.item_key,
      project_id: projectId,
      project_membership_id: membershipId,
      membership_generation: 1,
      provider_key: providerKey,
      metadata_generation_digest: metadataGenerationDigest,
      canonical_body_ref: canonicalBodyRef,
      canonical_body_sha256: SECTION_SHA256,
    };
    items.push(plannedItem);
  }

  const providerCopySetSha256 = await projectionDigest(copies.map((copy) => ({
    project_id: copy.project_id,
    project_membership_id: copy.project_membership_id,
    membership_generation: copy.membership_generation,
    provider_copy_set_sha256: copy.provider_copy_set_sha256,
  })));
  const providerItemSetSha256 = await projectionDigest(items.map((planned) => ({
    item_key: planned.item_key,
    canonical_section_id: planned.canonical_section_id,
    content_sha256: planned.content_sha256,
    start: planned.normalized_start_byte,
    end: planned.normalized_end_byte,
  })));
  return {
    context: copyContext,
    plan: {
      target,
      items,
      copies,
      provider_copy_count: copies.length,
      provider_copy_set_sha256: providerCopySetSha256,
      provider_item_count: items.length,
      provider_item_set_sha256: providerItemSetSha256,
    },
  };
}

describe("managed project-copy AI Search writer", () => {
  it("uses full provider keys and canonical mapping proofs for two projects, then reconciles lost ACKs by readback", async () => {
    const { context: copyContext, plan } = await projectCopyPlan();
    const authority = createMemoryManagedItemAuthority();
    const rowsByKey = new Map<string, {
      readonly id: string;
      readonly key: string;
      readonly file_size: number;
      readonly metadata: Readonly<Record<string, string | number>>;
      readonly content: string;
    }>();
    const uploadedKeys: string[] = [];
    let providerId = 0;

    const namespace: ProjectionAiSearchNamespace = {
      get(instanceId): ProjectionAiSearchInstance {
        expect(instanceId).toBe(plan.target.managed_instance_id);
        return {
          items: {
            async uploadAndPoll(key, content, options) {
              uploadedKeys.push(key);
              const text = typeof content === "string" ? content : "";
              const fileName = key.slice(key.lastIndexOf("/") + 1);
              const slash = key.lastIndexOf("/");
              const row = {
                id: `provider-item-${++providerId}`,
                key,
                status: "completed" as const,
                chunks_count: 1,
                file_size: new TextEncoder().encode(text).byteLength,
                metadata: {
                  ...(options?.metadata ?? {}),
                  filename: fileName,
                  folder: key.slice(0, slash + 1),
                  timestamp: 1,
                },
                content: text,
              };
              rowsByKey.set(key, row);
              throw new Error("provider upload acknowledgement was lost");
            },
            async list(options) {
              const row = rowsByKey.get(options.key);
              return {
                result: row === undefined ? [] : [row],
                result_info: {
                  count: row === undefined ? 0 : 1,
                  page: options.page,
                  per_page: options.per_page,
                  total_count: row === undefined ? 0 : 1,
                },
              };
            },
            get(id) {
              const row = [...rowsByKey.values()].find((candidate) => candidate.id === id);
              if (row === undefined) throw new Error("provider item ID is absent");
              const info = {
                id: row.id,
                key: row.key,
                status: "completed" as const,
                chunks_count: 1,
                file_size: row.file_size,
                metadata: row.metadata,
              };
              return {
                async info() { return info; },
                async download() {
                  return downloaded(row.key.slice(row.key.lastIndexOf("/") + 1), row.content);
                },
              };
            },
          },
        };
      },
    };

    const port = createManagedProjectionTestWriter({
      profile,
      namespace,
      authority,
    });
    const fence = {
      operation_id: "projection-execute-test-copy-set",
      lease_owner: "projection-copy-test-worker",
      lease_generation: 1,
    };
    const result = await port.index(
      copyContext,
      EXECUTION_GENERATION,
      CANONICAL_GENERATION,
      plan,
      fence,
    );

    expect(result).toMatchObject({
      state: "DEGRADED",
      item_count: 2,
      instance_id: plan.target.managed_instance_id,
      managed_generation: plan.target.managed_generation,
      reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
    });
    expect(uploadedKeys).toEqual(plan.items.map((planned) => planned.provider_key));
    expect(new Set(uploadedKeys).size).toBe(2);
    expect(authority.readManagedProjectCopyPlan(copyContext, EXECUTION_GENERATION)).toEqual(plan);
    for (const planned of plan.items) {
      const effect = authority.readManagedItemEffect(copyContext, EXECUTION_GENERATION, planned.item_key);
      expect(effect?.state).toBe("READBACK_VERIFIED");
      expect(effect?.intent).toMatchObject({
        provider_key: planned.provider_key,
        copy_layout: "PROJECT_COPY_V1",
        canonical_projection_generation: CANONICAL_GENERATION,
        canonical_item_key: planned.canonical_item_key,
        project_id: planned.project_id,
        project_membership_id: planned.project_membership_id,
        membership_generation: planned.membership_generation,
        metadata_generation_digest: plan.target.metadata_generation_digest,
        canonical_body_ref: planned.canonical_body_ref,
        canonical_body_sha256: planned.canonical_body_sha256,
        metadata: { projection_generation: plan.target.metadata_generation_digest },
      });
    }
  });
});
