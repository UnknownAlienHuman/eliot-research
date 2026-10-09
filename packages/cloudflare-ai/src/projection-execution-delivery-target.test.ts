import { canonicalProjectionJson } from "@eliotr/cloudflare-projection";
import {
  AI_SEARCH_PRIMARY_GENERATION,
  AI_SEARCH_PRIMARY_NAMESPACE,
  AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
  type AiSearchGenerationRecord,
  type AiSearchGenerationRegistry,
  type AiSearchGenerationState,
} from "@eliotr/cloudflare-projection/ai-search";
import {
  DELIVERY_MESSAGE_PROTOCOL,
  type AiSearchNamespaceLike,
  type DeliveryHandlerContext,
  type DeliveryMessage,
} from "@eliotr/platform-cloudflare";
import { describe, expect, it, vi } from "vitest";
import { createProjectionExecutionDeliveryHandler } from "./projection-execution-delivery-handler.js";

interface StoredRegistryRow {
  readonly namespace: string;
  readonly revision: number;
  readonly artifact_sha256: string;
  readonly artifact_json: string;
}

const MESSAGE: DeliveryMessage = {
  protocol: DELIVERY_MESSAGE_PROTOCOL,
  message_id: "projection-target-message-1",
  topic: "projection.execute",
  payload_ref: "payload:projection-target-1",
  payload_sha256: "a".repeat(64),
  idempotency_key: "projection-target-idempotency-1",
  outbox_id: "projection-target-outbox-1",
  outbox_attempt: 1,
  created_at_ms: 1,
};
const HANDLER_CONTEXT: DeliveryHandlerContext = {
  message_id: MESSAGE.message_id,
  idempotency_key: MESSAGE.idempotency_key,
  topic: MESSAGE.topic,
  attempt: 1,
};

function generationRecord(
  state: AiSearchGenerationState = "SHADOW_BUILDING",
  overrides: Partial<AiSearchGenerationRecord> = {},
): AiSearchGenerationRecord {
  return {
    namespace: AI_SEARCH_PRIMARY_NAMESPACE,
    generation: AI_SEARCH_PRIMARY_GENERATION,
    profile: AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
    state,
    expected_item_count: 1,
    indexed_item_count: 0,
    readback_item_count: 0,
    failed_item_count: 0,
    mismatch_count: 0,
    declared_at: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

async function storedRegistryRow(
  generations: readonly AiSearchGenerationRecord[],
  activeHead: string | null = null,
): Promise<StoredRegistryRow> {
  const registry: AiSearchGenerationRegistry = {
    active_head_generation: activeHead,
    generations,
  };
  const artifact = buildAiSearchGenerationRegistryArtifact(
    AI_SEARCH_PRIMARY_NAMESPACE,
    1,
    registry,
  );
  return {
    namespace: AI_SEARCH_PRIMARY_NAMESPACE,
    revision: artifact.revision,
    artifact_sha256: await aiSearchGenerationRegistryArtifactDigest(artifact),
    artifact_json: canonicalProjectionJson(artifact),
  };
}

function deliveryFixture(row: StoredRegistryRow | null) {
  const searchFirst = vi.fn(async () => row);
  const searchBind = vi.fn(() => ({ first: searchFirst }));
  const searchPrepare = vi.fn(() => ({ bind: searchBind }));
  const corePrepare = vi.fn(() => {
    throw new Error("projection executor reached Core fixture");
  });
  const providerGet = vi.fn(() => {
    throw new Error("AI Search provider must not be opened by target preflight");
  });
  const handler = createProjectionExecutionDeliveryHandler({
    core_database: { prepare: corePrepare } as unknown as D1Database,
    search_database: { prepare: searchPrepare } as unknown as D1Database,
    evidence_bucket: {} as R2Bucket,
    work_bucket: {} as R2Bucket,
    ai_search: { get: providerGet } as unknown as AiSearchNamespaceLike,
  });
  return { handler, corePrepare, providerGet, searchPrepare };
}

async function expectRejectedBeforeExecutor(row: StoredRegistryRow | null): Promise<void> {
  const fixture = deliveryFixture(row);
  await expect(fixture.handler(MESSAGE, HANDLER_CONTEXT)).rejects.toThrow(
    "AI Search generation registry lacks the exact eligible configured target",
  );
  expect(fixture.corePrepare).not.toHaveBeenCalled();
  expect(fixture.providerGet).not.toHaveBeenCalled();
}

describe("projection delivery configured generation target", () => {
  it("rejects a missing registry before executor or provider access", async () => {
    await expectRejectedBeforeExecutor(null);
  });

  it("rejects a registry without the configured generation before dispatch", async () => {
    const otherProfile = {
      ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
      id: "private-prose-other",
      generation: "g-other",
    };
    const row = await storedRegistryRow([
      generationRecord("SHADOW_BUILDING", {
        generation: "g-other",
        profile: otherProfile,
      }),
    ]);
    await expectRejectedBeforeExecutor(row);
  });

  it("rejects a configured generation with a different immutable profile", async () => {
    const row = await storedRegistryRow([
      generationRecord("SHADOW_BUILDING", {
        profile: {
          ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
          embedding_model: "@cf/other/embedding-model",
        },
      }),
    ]);
    await expectRejectedBeforeExecutor(row);
  });

  it("rejects a BLOCKED configured generation before dispatch", async () => {
    const row = await storedRegistryRow([
      generationRecord("BLOCKED", { failed_item_count: 1 }),
    ]);
    await expectRejectedBeforeExecutor(row);
  });

  it("rejects a RETIRED configured generation before dispatch", async () => {
    const row = await storedRegistryRow([
      generationRecord("RETIRED", {
        indexed_item_count: 1,
        readback_item_count: 1,
        golden_set_result_ref: "golden-set-result-1",
        activated_at: "2026-09-04T00:00:00.000Z",
        retired_at: "2026-09-05T00:00:00.000Z",
      }),
    ]);
    await expectRejectedBeforeExecutor(row);
  });

  it("accepts the exact shadow target when a different generation is active", async () => {
    const activeGeneration = "g-active";
    const activeProfile = {
      ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
      id: "private-prose-active",
      generation: activeGeneration,
    };
    const row = await storedRegistryRow(
      [
        generationRecord("SHADOW_BUILDING"),
        generationRecord("ACTIVE", {
          generation: activeGeneration,
          profile: activeProfile,
          indexed_item_count: 1,
          readback_item_count: 1,
          golden_set_result_ref: "golden-set-active-1",
          observed_at: "2026-09-04T00:00:00.000Z",
          activated_at: "2026-09-04T00:01:00.000Z",
        }),
      ],
      activeGeneration,
    );
    const fixture = deliveryFixture(row);
    await expect(fixture.handler(MESSAGE, HANDLER_CONTEXT)).rejects.toThrow();
    expect(fixture.corePrepare).toHaveBeenCalled();
    expect(fixture.providerGet).not.toHaveBeenCalled();
  });
});
