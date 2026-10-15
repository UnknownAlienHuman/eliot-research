import type { ProjectionItem } from "@eliotr/contracts";
import type { ExecutionFence } from "@eliotr/platform-cloudflare";
import type {
  ManagedProjectCopyMapItem,
  ManagedProjectCopyMapReceiptV2,
  ManagedProjectCopyMapReceiptV1,
  ManagedProjectCopyPlan,
  ManagedProjectionPort,
  ManagedProjectionReceipt,
  ManagedTargetSelectionV2,
  ProjectionExecutionProfile,
  ProjectionSourceContext,
  ProjectionAuthorityPort,
  ProjectionManagedItemAuthorityPort,
} from "@eliotr/cloudflare-projection";
import {
  canonicalProjectionJson,
  projectionDigest,
  projectionSha256Utf8,
} from "@eliotr/cloudflare-projection";
import {
  createManagedProjectionPort,
  type ProjectionAiSearchNamespace,
  type ManagedProjectionDependencies,
} from "./managed-index.js";
import type { ManagedItemReceipt } from "./managed-index-readback.js";

type ManagedItemIntent = Parameters<
  NonNullable<ProjectionAuthorityPort["prepareManagedItems"]>
>[3][number];
type ManagedItemEffect = Awaited<
  ReturnType<NonNullable<ProjectionAuthorityPort["prepareManagedItems"]>>
>[number];

interface MemoryManagedItemEffect {
  readonly intent: ManagedItemIntent;
  readonly job_id: string;
  readonly intent_id: string;
  readonly intent_revision: number;
  readonly attempt_id: string;
  state: ManagedItemEffect["state"];
  provider_item_id: string | null;
  receipt: ManagedItemReceipt | null;
}

export interface MemoryManagedItemAuthority extends ProjectionManagedItemAuthorityPort {
  readManagedProjectCopyPlan(
    context: ProjectionSourceContext,
    generation: string,
  ): ManagedProjectCopyPlan | null;
  readManagedItemEffect(
    context: ProjectionSourceContext,
    generation: string,
    itemKey: string,
  ): Readonly<MemoryManagedItemEffect> | null;
}

export function createMemoryManagedItemAuthority(): MemoryManagedItemAuthority {
  const effects = new Map<string, MemoryManagedItemEffect>();
  const copyPlans = new Map<string, ManagedProjectCopyPlan>();
  const id = (context: ProjectionSourceContext, generation: string, itemKey: string) =>
    [context.source_revision.source_revision_ref, generation, itemKey].join("\u0000");
  const planId = (context: ProjectionSourceContext, generation: string) =>
    [context.source_revision.source_revision_ref, generation, "copy-plan"].join("\u0000");
  const assertLineage = (effect: MemoryManagedItemEffect, context: ProjectionSourceContext) => {
    if (
      effect.job_id !== context.job_id ||
      effect.intent_id !== context.intent_ref.id ||
      effect.intent_revision !== context.intent_ref.revision ||
      effect.attempt_id !== context.acceptance_attempt_id
    ) {
      throw new Error("test managed item attempt lineage changed");
    }
  };
  const authority: MemoryManagedItemAuthority = {
    readManagedProjectCopyPlan(context, generation) {
      const copyPlan = copyPlans.get(planId(context, generation));
      return copyPlan === undefined ? null : copyPlan;
    },
    readManagedItemEffect(context, generation, itemKey) {
      const effect = effects.get(id(context, generation, itemKey));
      return effect === undefined ? null : Object.freeze({ ...effect });
    },
    async load() { throw new Error("test authority load is unused"); },
    async readTerminal() { return null; },
    async begin() {},
    async recordMaterialized() {},
    async settle() { throw new Error("test authority settle is unused"); },
    async prepareManagedItems(context, generation, _profile, intents, _fence, copyPlan) {
      const keyForPlan = planId(context, generation);
      const existingPlan = copyPlans.get(keyForPlan);
      if (copyPlan !== undefined) {
        if (
          existingPlan !== undefined &&
          canonicalProjectionJson(existingPlan) !== canonicalProjectionJson(copyPlan)
        ) {
          throw new Error("test managed copy plan changed across replay");
        }
        copyPlans.set(keyForPlan, copyPlan);
      } else if (
        intents.some((intent) => intent.copy_layout === "PROJECT_COPY_V1") &&
        existingPlan === undefined
      ) {
        throw new Error("test PROJECT_COPY_V1 intents require the full durable copy plan");
      }
      return intents.map((intent) => {
        const key = id(context, generation, intent.item_key);
        let effect = effects.get(key);
        if (effect === undefined) {
          effect = {
            intent,
            job_id: context.job_id,
            intent_id: context.intent_ref.id,
            intent_revision: context.intent_ref.revision,
            attempt_id: context.acceptance_attempt_id,
            state: "INTENT",
            provider_item_id: null,
            receipt: null,
          };
          effects.set(key, effect);
        } else if (
          canonicalProjectionJson(effect.intent) !== canonicalProjectionJson(intent)
        ) {
          throw new Error("test managed intent changed across replay");
        } else {
          assertLineage(effect, context);
        }
        return {
          item_key: effect.intent.item_key,
          state: effect.state,
          provider_item_id: effect.provider_item_id,
          receipt: effect.receipt,
        };
      });
    },
    async beginManagedItemDispatch(context, generation, itemKey) {
      const effect = effects.get(id(context, generation, itemKey));
      if (effect === undefined) throw new Error("test managed intent is missing");
      assertLineage(effect, context);
      if (effect.state !== "INTENT") return false;
      effect.state = "DISPATCHED";
      return true;
    },
    async recordManagedItemProviderId(context, generation, itemKey, providerItemId) {
      const effect = effects.get(id(context, generation, itemKey));
      if (effect === undefined || effect.state === "INTENT") {
        throw new Error("test provider ID preceded its durable intent");
      }
      assertLineage(effect, context);
      if (effect.provider_item_id !== null && effect.provider_item_id !== providerItemId) {
        throw new Error("test provider item ID changed");
      }
      effect.provider_item_id = providerItemId;
    },
    async recordManagedItemReceipt(context, generation, receipt) {
      const effect = effects.get(id(context, generation, receipt.item_key));
      const receiptKeys = Object.keys(receipt).sort();
      const expectedReceiptKeys = [
        "chunks_count",
        "content_sha256",
        "file_size",
        "item_key",
        "provider_item_id",
        "provider_key",
        "readback_sha256",
      ];
      if (
        effect === undefined ||
        receipt.item_key !== effect.intent.item_key ||
        receiptKeys.length !== expectedReceiptKeys.length ||
        receiptKeys.some((key, index) => key !== expectedReceiptKeys[index]) ||
        receipt.provider_key !== effect.intent.provider_key ||
        receipt.file_size !== effect.intent.document_size_bytes ||
        receipt.content_sha256 !== effect.intent.document_sha256 ||
        !Number.isSafeInteger(receipt.chunks_count) ||
        receipt.chunks_count < 1 ||
        !/^[0-9a-f]{64}$/.test(receipt.readback_sha256) ||
        (effect.state !== "DISPATCHED" && effect.state !== "UNKNOWN" &&
          effect.state !== "READBACK_VERIFIED") ||
        (effect.provider_item_id !== null && effect.provider_item_id !== receipt.provider_item_id)
      ) {
        throw new Error("test receipt does not match its dispatched intent");
      }
      assertLineage(effect, context);
      if (
        effect.receipt !== null &&
        canonicalProjectionJson(effect.receipt) !== canonicalProjectionJson(receipt)
      ) {
        throw new Error("test managed item receipt changed");
      }
      effect.provider_item_id = receipt.provider_item_id;
      effect.receipt = receipt;
      effect.state = "READBACK_VERIFIED";
    },
    async markManagedItemUnknown(context, generation, itemKey) {
      const effect = effects.get(id(context, generation, itemKey));
      if (effect === undefined) throw new Error("test managed intent is missing");
      assertLineage(effect, context);
      if (effect.state === "DISPATCHED") effect.state = "UNKNOWN";
    },
    async readManagedItemGenerationProof() {
      throw new Error("test managed generation proof is unused by item transport tests");
    },
  };
  return authority;
}

export function createManagedProjectionTestPort(input: {
  readonly profile: ProjectionExecutionProfile;
  readonly namespace: ProjectionAiSearchNamespace;
  readonly authority: ProjectionManagedItemAuthorityPort;
}) {
  const writer = createManagedProjectionTestWriter(input);
  return createLegacyFlatManagedProjectionTestAdapter(writer, input.profile);
}

export function createManagedProjectionTestWriter(input: {
  readonly profile: ProjectionExecutionProfile;
  readonly namespace: ProjectionAiSearchNamespace;
  readonly authority: ProjectionManagedItemAuthorityPort;
}): ManagedProjectionPort {
  const observedUploads = new Map<string, unknown>();
  const namespace: ProjectionAiSearchNamespace = {
    get(instanceId) {
      const instance = input.namespace.get(instanceId);
      return {
        ...instance,
        items: {
          ...instance.items,
          async uploadAndPoll(key, content, options) {
            const result = await instance.items.uploadAndPoll(key, content, options);
            observedUploads.set(key, result);
            return result;
          },
          async list(options) {
            if (instance.items.list !== undefined) return instance.items.list(options);
            const result = observedUploads.get(options.key);
            return {
              result: result === undefined ? [] : [result],
              result_info: {
                count: result === undefined ? 0 : 1,
                page: options.page,
                per_page: options.per_page,
                total_count: result === undefined ? 0 : 1,
              },
            };
          },
        },
      };
    },
  };
  return createManagedProjectionPort({
    profile: input.profile,
    namespace,
    authority: input.authority,
    // Trusted test fixture only; production must supply the current-target authority reader.
    isCurrentTarget: async () => true,
  });
}

export function createLegacyFlatManagedProjectionTestAdapter(
  writer: ManagedProjectionPort,
  profile: ProjectionExecutionProfile,
): {
  index(
    context: ProjectionSourceContext,
    executionGeneration: string,
    items: readonly ProjectionItem[],
    fence: ExecutionFence,
  ): Promise<ManagedProjectionReceipt>;
} {
  return {
    async index(context, executionGeneration, items, fence) {
      const emptySetDigest = await projectionDigest([]);
      const metadataGenerationDigest = await projectionSha256Utf8(
        `eliotr.project-copy-generation.v1\u0000${profile.managed_generation}`,
      );
      const plannedItems = items.map((item, index) => {
        const match = /^normalized-bytes:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/u.exec(
          item.normalized_offset_map_ref,
        );
        const normalizedStart = match?.[1] === undefined ? Number.NaN : Number(match[1]);
        const normalizedEnd = match?.[2] === undefined ? Number.NaN : Number(match[2]);
        if (
          !Number.isSafeInteger(normalizedStart) ||
          !Number.isSafeInteger(normalizedEnd) ||
          normalizedStart < 0 ||
          normalizedEnd <= normalizedStart
        ) {
          throw new Error(`legacy test item ${index} has an invalid normalized byte span`);
        }
        return Object.freeze({
          ...item,
          normalized_start_byte: normalizedStart,
          normalized_end_byte: normalizedEnd,
          copy_layout: null,
          canonical_projection_generation: executionGeneration,
          canonical_item_key: null,
          project_id: null,
          project_membership_id: null,
          membership_generation: null,
          membership_identity_version: null,
          legacy_project_membership_id: null,
          stable_project_membership_id: null,
          membership_revision: null,
          project_membership_generation: null,
          provider_key: `${item.item_key}.md`,
          metadata_generation_digest: null,
          canonical_body_ref: null,
          canonical_body_sha256: null,
        });
      });
      const copyPlan: ManagedProjectCopyPlan = Object.freeze({
        target: Object.freeze({
          managed_instance_id: profile.managed_instance_id,
          managed_generation: profile.managed_generation,
          metadata_generation_digest: metadataGenerationDigest,
        }),
        items: Object.freeze(plannedItems),
        copies: Object.freeze([]),
        provider_copy_count: 0,
        provider_copy_set_sha256: emptySetDigest,
        provider_item_count: 0,
        provider_item_set_sha256: emptySetDigest,
      });
      return writer.index(context, executionGeneration, executionGeneration, copyPlan, fence);
    },
  };
}

export function createLegacyFlatManagedProjectionPort(
  dependencies: ManagedProjectionDependencies,
): ReturnType<typeof createLegacyFlatManagedProjectionTestAdapter> {
  return createLegacyFlatManagedProjectionTestAdapter(
    createManagedProjectionPort(dependencies),
    dependencies.profile,
  );
}

export const A = "a".repeat(64);
export const B = "b".repeat(64);
export const SECTION_SHA256 = "b26231f8f6015cb929f1afe7994696789d2b3fb0aa66e08598a6559d126ea92a";
export const context = {
  intent_ref: { id: "intent-1", revision: 1 },
  job_id: "job-1",
  job_state: "ACCEPTED",
  acceptance_attempt_id: "attempt-1",
  source_revision: {
    source_revision_ref: "revision-1",
    source_id: "source-1",
    source_namespace_id: "namespace-1",
    source_owner_system_id: "owner-1",
    source_owner_generation: "generation-1",
    ownership_mode: "immutable_import",
    content_sha256: A,
    object_residency_key_digest: B,
    captured_at: "2026-08-31T12:00:00.000Z",
    quality_state: "standard",
    purge_state: "LIVE",
  },
  source_title: "Document",
  source_class: "document",
  instruction_taint: "DATA_ONLY",
  project_membership_ids: [],
  message: {
    protocol: "eliotr.delivery.message.v1",
    message_id: "outbox-1:1",
    topic: "source.revision.admitted",
    payload_ref: "revision-1",
    payload_sha256: A,
    idempotency_key: "projection-1",
    outbox_id: "outbox-1",
    outbox_attempt: 1,
    created_at_ms: 1,
  },
} satisfies ProjectionSourceContext;
// Matches stableProjectionId("projection-execute", intent-1, "1", "projection-g1").
export const TEST_EXECUTION_FENCE = {
  operation_id: "projection-execute-42042a4e121737ca1532dda83a87ba09849f7743da15e1d6",
  lease_owner: "eliotr-projection-executor",
  lease_generation: 1,
} satisfies ExecutionFence;
export const item: ProjectionItem = {
  item_key: "projection-item-1",
  canonical_section_id: "section-1",
  source_revision_ref: "revision-1",
  project_membership_ids: [],
  heading_path: ["Heading"],
  document_context_header: "Document › Heading",
  section_text: "Exact section text.",
  normalized_offset_map_ref: "normalized-bytes:0:19",
  content_sha256: SECTION_SHA256,
  instruction_taint: "DATA_ONLY",
  projection_generation: "projection-g1",
};
export const managedDocument = "Document › Heading\n\nExact section text.";

export function downloaded(filename: string, content = managedDocument) {
  const bytes = new TextEncoder().encode(content);
  return {
    filename,
    size: bytes.byteLength,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

export const profile: ProjectionExecutionProfile = {
  projector_profile: "structural-markdown-v1",
  managed_instance_id: "private-prose-g1",
  managed_generation: "g1",
  // New item writes run against a shadow generation; promotion is a separate authority.
  managed_generation_active: false,
  maximum_markdown_bytes: 4 * 1024 * 1024,
  maximum_synchronous_items: 64,
  target_item_utf8_bytes: 1024,
  maximum_item_utf8_bytes: 4096,
  managed_poll_interval_ms: 100,
  managed_timeout_ms: 1_000,
};

export async function managedProjectCopyPlanV2(
  purpose: "ACTIVE" | "SHADOW",
  targetProfile: ProjectionExecutionProfile = profile,
): Promise<ManagedProjectCopyPlan> {
  const canonicalProjectionGeneration = "canonical-projection-1";
  const metadataGenerationDigest = await projectionSha256Utf8(
    `eliotr.project-copy-generation.v1\u0000${targetProfile.managed_generation}`,
  );
  const target = Object.freeze({
    managed_instance_id: targetProfile.managed_instance_id,
    managed_generation: targetProfile.managed_generation,
    metadata_generation_digest: metadataGenerationDigest,
  });
  const selection: ManagedTargetSelectionV2 = Object.freeze({
    protocol: "eliotr.managed-target-selection.v2",
    domain: "MANAGED_SEARCH_PRODUCT",
    decision_version: 2,
    selection_mode: "STABLE_PHYSICAL_PROFILE_V2",
    product_alias: "primary",
    purpose,
    registry_revision: 1,
    registry_artifact_sha256: "c".repeat(64),
    v1_exact_profile_identity_sha256: "d".repeat(64),
    target: {
      namespace: "ai-search-primary",
      managed_instance_id: target.managed_instance_id,
      managed_generation: target.managed_generation,
      target_profile_identity_sha256: "e".repeat(64),
    },
  });
  const canonicalItemKey = item.item_key;
  const providerItemKey = `projection-${"f".repeat(48)}`;
  const folderPrefix = `projection/${"a".repeat(43)}/`;
  const providerKey = `${folderPrefix}${providerItemKey}.md`;
  const projectId = "project-test";
  const stableMembershipId = `project-membership-${"b".repeat(48)}`;
  const canonicalSourceRef = "canonical-source-1";
  const canonicalSourceSha256 = "9".repeat(64);
  const canonicalBodyRef = "canonical-body-1";
  const mappedItem: ManagedProjectCopyMapItem = Object.freeze({
    item_key: providerItemKey,
    canonical_item_key: canonicalItemKey,
    canonical_section_id: item.canonical_section_id,
    content_sha256: item.content_sha256,
    normalized_start_byte: 0,
    normalized_end_byte: 19,
    provider_key: providerKey,
    canonical_body_ref: canonicalBodyRef,
    canonical_body_sha256: item.content_sha256,
  });
  const providerItemSetSha256 = await projectionDigest([{
    item_key: mappedItem.item_key,
    canonical_section_id: mappedItem.canonical_section_id,
    content_sha256: mappedItem.content_sha256,
    start: mappedItem.normalized_start_byte,
    end: mappedItem.normalized_end_byte,
  }]);
  const copyPayload = {
    protocol: "eliotr.managed-project-copy-map.v2",
    layout: "PROJECT_COPY_V2",
    source_revision_ref: context.source_revision.source_revision_ref,
    source_owner_generation: context.source_revision.source_owner_generation,
    complete_residency_key_sha256: context.source_revision.object_residency_key_digest,
    canonical_projection_generation: canonicalProjectionGeneration,
    target,
    target_selection: selection,
    canonical_source_ref: canonicalSourceRef,
    canonical_source_sha256: canonicalSourceSha256,
    project_id: projectId,
    project_membership_id: stableMembershipId,
    membership_generation: 1,
    project_membership_generation: 1,
    folder_prefix: folderPrefix,
    membership_identity_version: 2,
    stable_project_membership_id: stableMembershipId,
    membership_revision: 1,
    provider_copy_count: 1,
    provider_item_count: 1,
    provider_item_set_sha256: providerItemSetSha256,
    items: [mappedItem],
  } satisfies Omit<ManagedProjectCopyMapReceiptV2, "provider_copy_set_sha256">;
  const copy = Object.freeze({
    ...copyPayload,
    provider_copy_set_sha256: await projectionDigest(copyPayload),
  }) satisfies ManagedProjectCopyMapReceiptV2;
  const plannedItem: ManagedProjectCopyPlan["items"][number] = Object.freeze({
    ...item,
    item_key: providerItemKey,
    projection_generation: metadataGenerationDigest,
    normalized_start_byte: 0,
    normalized_end_byte: 19,
    copy_layout: "PROJECT_COPY_V2",
    canonical_projection_generation: canonicalProjectionGeneration,
    canonical_item_key: canonicalItemKey,
    project_id: projectId,
    project_membership_id: stableMembershipId,
    membership_generation: 1,
    membership_identity_version: 2,
    legacy_project_membership_id: null,
    stable_project_membership_id: stableMembershipId,
    membership_revision: 1,
    project_membership_generation: 1,
    project_membership_ids: [stableMembershipId],
    provider_key: providerKey,
    metadata_generation_digest: metadataGenerationDigest,
    canonical_body_ref: canonicalBodyRef,
    canonical_body_sha256: item.content_sha256,
  });
  const providerCopySetSha256 = await projectionDigest([{
    project_id: projectId,
    project_membership_id: stableMembershipId,
    membership_identity_version: 2,
    legacy_project_membership_id: null,
    stable_project_membership_id: stableMembershipId,
    membership_revision: 1,
    membership_generation: 1,
    project_membership_generation: 1,
    folder_prefix: folderPrefix,
    provider_copy_set_sha256: copy.provider_copy_set_sha256,
  }]);
  return Object.freeze({
    target,
    layout: "PROJECT_COPY_V2",
    target_selection: selection,
    scope_snapshot_id: "scope-snapshot-1",
    scope_snapshot_revision: 1,
    scope_snapshot_digest: "8".repeat(64),
    project_copy_map_index_protocol: "eliotr.managed-project-copy-map-index.v2",
    project_copy_map_index_ref: "projection/revision-1/copy-maps/index/g1/scope-1.json",
    project_copy_map_index_sha256: "7".repeat(64),
    items: [plannedItem],
    copies: [copy],
    provider_copy_count: 1,
    provider_copy_set_sha256: providerCopySetSha256,
    provider_item_count: 1,
    provider_item_set_sha256: providerItemSetSha256,
  });
}

export async function managedProjectCopyPlanV1(
  targetProfile: ProjectionExecutionProfile = profile,
): Promise<ManagedProjectCopyPlan> {
  const v2Plan = await managedProjectCopyPlanV2("SHADOW", targetProfile);
  const v2Copy = v2Plan.copies[0];
  const v2Item = v2Plan.items[0];
  if (v2Copy?.protocol !== "eliotr.managed-project-copy-map.v2" || v2Item === undefined) {
    throw new Error("V2 fixture does not contain one provider copy");
  }
  const projectMembershipId = `project:${v2Copy.project_id}:generation:${v2Copy.membership_generation}`;
  const copyItems = v2Copy.items.map((copyItem) => Object.freeze({ ...copyItem }));
  const providerItemSetSha256 = await projectionDigest(copyItems.map((copyItem) => ({
    item_key: copyItem.item_key,
    canonical_section_id: copyItem.canonical_section_id,
    content_sha256: copyItem.content_sha256,
    start: copyItem.normalized_start_byte,
    end: copyItem.normalized_end_byte,
  })));
  const copyPayload = {
    protocol: "eliotr.managed-project-copy-map.v1",
    source_revision_ref: v2Copy.source_revision_ref,
    complete_residency_key_sha256: v2Copy.complete_residency_key_sha256,
    canonical_projection_generation: v2Copy.canonical_projection_generation,
    target: v2Copy.target,
    project_id: v2Copy.project_id,
    project_membership_id: projectMembershipId,
    membership_generation: v2Copy.membership_generation,
    canonical_source_ref: v2Copy.canonical_source_ref,
    canonical_source_sha256: v2Copy.canonical_source_sha256,
    provider_copy_count: 1 as const,
    provider_item_count: copyItems.length,
    provider_item_set_sha256: providerItemSetSha256,
    items: copyItems,
  } satisfies Omit<ManagedProjectCopyMapReceiptV1, "provider_copy_set_sha256">;
  const copy: ManagedProjectCopyMapReceiptV1 = Object.freeze({
    ...copyPayload,
    provider_copy_set_sha256: await projectionDigest(copyPayload),
  });
  const plannedItem: ManagedProjectCopyPlan["items"][number] = Object.freeze({
    ...v2Item,
    project_membership_ids: [projectMembershipId],
    copy_layout: "PROJECT_COPY_V1",
    project_membership_id: projectMembershipId,
    membership_identity_version: null,
    legacy_project_membership_id: null,
    stable_project_membership_id: null,
    membership_revision: null,
    project_membership_generation: null,
  });
  const providerCopySetSha256 = await projectionDigest([{
    project_id: copy.project_id,
    project_membership_id: copy.project_membership_id,
    membership_generation: copy.membership_generation,
    provider_copy_set_sha256: copy.provider_copy_set_sha256,
  }]);
  return Object.freeze({
    target: v2Plan.target,
    items: [plannedItem],
    copies: [copy],
    provider_copy_count: 1,
    provider_copy_set_sha256: providerCopySetSha256,
    provider_item_count: 1,
    provider_item_set_sha256: providerItemSetSha256,
  });
}
