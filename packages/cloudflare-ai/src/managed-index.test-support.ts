import type { ProjectionItem } from "@eliotr/contracts";
import type { ExecutionFence } from "@eliotr/platform-cloudflare";
import type {
  ProjectionExecutionProfile,
  ProjectionSourceContext,
  ProjectionAuthorityPort,
  ProjectionManagedItemAuthorityPort,
} from "@eliotr/cloudflare-projection";
import { canonicalProjectionJson } from "@eliotr/cloudflare-projection";
import {
  createManagedProjectionPort,
  type ProjectionAiSearchNamespace,
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
  readManagedItemEffect(
    context: ProjectionSourceContext,
    generation: string,
    itemKey: string,
  ): Readonly<MemoryManagedItemEffect> | null;
}

export function createMemoryManagedItemAuthority(): MemoryManagedItemAuthority {
  const effects = new Map<string, MemoryManagedItemEffect>();
  const id = (context: ProjectionSourceContext, generation: string, itemKey: string) =>
    [context.source_revision.source_revision_ref, generation, itemKey].join("\u0000");
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
    readManagedItemEffect(context, generation, itemKey) {
      const effect = effects.get(id(context, generation, itemKey));
      return effect === undefined ? null : Object.freeze({ ...effect });
    },
    async load() { throw new Error("test authority load is unused"); },
    async readTerminal() { return null; },
    async begin() {},
    async recordMaterialized() {},
    async settle() { throw new Error("test authority settle is unused"); },
    async prepareManagedItems(context, generation, _profile, intents) {
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
  managed_generation_active: true,
  maximum_markdown_bytes: 4 * 1024 * 1024,
  maximum_synchronous_items: 64,
  target_item_utf8_bytes: 1024,
  maximum_item_utf8_bytes: 4096,
  managed_poll_interval_ms: 100,
  managed_timeout_ms: 1_000,
};
