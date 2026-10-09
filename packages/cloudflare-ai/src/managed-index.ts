import type { ProjectionItem } from "@eliotr/contracts";
import { projectionMetadata } from "@eliotr/platform-cloudflare";
import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  assertProjectionSha256,
  canonicalProjectionJson,
  projectionDigest,
  projectionSha256Utf8,
  ProjectionRuntimeError,
  projectionFail,
  stableProjectionId,
  type ManagedProjectionPort,
  type ManagedProjectionReceipt,
  type ProjectionAuthorityPort,
  type ProjectionExecutionProfile,
  type ProjectionManagedItemAuthorityPort,
  type ProjectionSourceContext,
} from "@eliotr/cloudflare-projection";
import {
  listExactManagedItem,
  ManagedItemRecoveryBlockedError,
  ManagedProjectionAdapterError,
  readManagedItem,
  type ManagedItemReceipt,
  type PreparedManagedItem,
  type ProjectionAiSearchInstance,
} from "./managed-index-readback.js";

export interface ProjectionAiSearchNamespace {
  get(instanceId: string): ProjectionAiSearchInstance;
}

type ManagedItemIntent = Parameters<
  NonNullable<ProjectionAuthorityPort["prepareManagedItems"]>
>[3][number];
type ManagedItemEffect = Awaited<
  ReturnType<NonNullable<ProjectionAuthorityPort["prepareManagedItems"]>>
>[number];

type ManagedItemAuthority = ProjectionManagedItemAuthorityPort;
type ManagedExecutionFence = Parameters<ManagedProjectionPort["index"]>[3];
type CurrentManagedTargetReader = (fence: ManagedExecutionFence) => Promise<boolean>;

class ManagedProjectionInputError extends Error {
  public readonly reason_code = "PROJECTION_INPUT_INVALID" as const;

  public constructor(cause: ProjectionRuntimeError) {
    super(cause.message, { cause });
    this.name = "ManagedProjectionInputError";
  }
}

class ManagedProjectionCurrentnessError extends Error {
  public readonly reason_code:
    | "MANAGED_GENERATION_STALE"
    | "MANAGED_GENERATION_CURRENTNESS_UNVERIFIED";

  public constructor(
    reasonCode: ManagedProjectionCurrentnessError["reason_code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ManagedProjectionCurrentnessError";
    this.reason_code = reasonCode;
  }
}

async function assertCurrentManagedTarget(
  readCurrentTarget: CurrentManagedTargetReader,
  fence: ManagedExecutionFence,
): Promise<void> {
  if (typeof readCurrentTarget !== "function") {
    throw new ManagedProjectionCurrentnessError(
      "MANAGED_GENERATION_CURRENTNESS_UNVERIFIED",
      "AI Search managed generation currentness reader is required",
    );
  }
  let current: boolean;
  try {
    current = await readCurrentTarget(fence);
  } catch (cause) {
    throw new ManagedProjectionCurrentnessError(
      "MANAGED_GENERATION_CURRENTNESS_UNVERIFIED",
      "AI Search managed generation currentness could not be verified",
      cause,
    );
  }
  if (!current) {
    throw new ManagedProjectionCurrentnessError(
      "MANAGED_GENERATION_STALE",
      "AI Search managed generation registry changed during projection execution",
    );
  }
}

const CUSTOM_METADATA_FIELDS = [
  "canonical_section_id",
  "content_sha256",
  "instruction_taint",
  "projection_generation",
  "source_revision_ref",
] as const;

function managedDocument(item: ProjectionItem): string {
  if (
    typeof item.document_context_header !== "string" ||
    typeof item.section_text !== "string"
  ) {
    projectionFail("PROJECTION_INPUT_INVALID", "projection item document is invalid");
  }
  const header = item.document_context_header.trim();
  return header.length === 0 ? item.section_text : `${header}\n\n${item.section_text}`;
}

function managedItemFilename(itemKey: string): string {
  const key = assertProjectionIdentifier(itemKey, "projection item key");
  const filename = `${key}.md`;
  if (key.includes("/") || filename.length > 128) {
    projectionFail(
      "PROJECTION_INPUT_INVALID",
      "projection item key cannot form a native AI Search filename of at most 128 characters",
    );
  }
  return filename;
}

function managedItemSpan(item: ProjectionItem): {
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
} {
  const match = /^normalized-bytes:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/u.exec(
    item.normalized_offset_map_ref,
  );
  const start = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  const end = match?.[2] === undefined ? Number.NaN : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    projectionFail("PROJECTION_INPUT_INVALID", "projection item normalized byte span is invalid");
  }
  return { normalized_start_byte: start, normalized_end_byte: end };
}

async function prepareManagedItems(
  context: ProjectionSourceContext,
  projectionGeneration: string,
  profile: ProjectionExecutionProfile,
  items: readonly ProjectionItem[],
): Promise<readonly PreparedManagedItem[]> {
  if (!Array.isArray(items)) {
    projectionFail("PROJECTION_INPUT_INVALID", "managed projection desired set is invalid");
  }
  assertProjectionInteger(
    items.length,
    "managed projection item count",
    1,
    profile.maximum_synchronous_items,
  );
  const seenKeys = new Set<string>();
  const prepared: PreparedManagedItem[] = [];
  for (const [index, item] of items.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      projectionFail("PROJECTION_INPUT_INVALID", `managed projection item ${index} is invalid`);
    }
    const itemKey = assertProjectionIdentifier(item.item_key, `projection item ${index}.item_key`);
    const key = managedItemFilename(itemKey);
    const span = managedItemSpan(item);
    if (seenKeys.has(itemKey)) {
      projectionFail("PROJECTION_INPUT_INVALID", "managed projection desired set has duplicate item keys");
    }
    seenKeys.add(itemKey);
    if (item.source_revision_ref !== context.source_revision.source_revision_ref) {
      projectionFail(
        "PROJECTION_INPUT_INVALID",
        "projection item source revision differs from the execution context",
      );
    }
    if (item.projection_generation !== projectionGeneration) {
      projectionFail(
        "PROJECTION_INPUT_INVALID",
        "projection item generation differs from the requested managed generation",
      );
    }
    assertProjectionIdentifier(item.canonical_section_id, "projection item canonical_section_id");
    assertProjectionIdentifier(item.source_revision_ref, "projection item source_revision_ref");
    assertProjectionSha256(item.content_sha256, "projection item content_sha256");
    const document = managedDocument(item);
    const size = new TextEncoder().encode(document).byteLength;
    if (
      size < 1 ||
      size > profile.maximum_item_utf8_bytes ||
      size > 4 * 1024 * 1024
    ) {
      projectionFail(
        "PROJECTION_INPUT_INVALID",
        "managed projection item exceeds the AI Search Items API file envelope",
      );
    }
    if (await projectionSha256Utf8(item.section_text) !== item.content_sha256) {
      projectionFail(
        "PROJECTION_INPUT_INVALID",
        "projection item content digest differs from its section bytes",
      );
    }
    // AI Search's projection_generation is the managed profile generation; the
    // source-specific generation remains in the durable Eliot intent lineage.
    const metadata = Object.freeze({
      ...projectionMetadata(item),
      projection_generation: profile.managed_generation,
    });
    if (
      Object.keys(metadata).sort().join("\u0000") !== CUSTOM_METADATA_FIELDS.join("\u0000") ||
      Object.values(metadata).some((value) => typeof value !== "string")
    ) {
      projectionFail("PROJECTION_INPUT_INVALID", "managed projection custom metadata is invalid");
    }
    prepared.push(Object.freeze({
      item_key: itemKey,
      key,
      document,
      size,
      ...span,
      document_sha256: await projectionSha256Utf8(document),
      metadata,
    }));
  }
  return Object.freeze(prepared);
}

function assertManagedItemAuthority(
  authority: ProjectionAuthorityPort,
): asserts authority is ManagedItemAuthority {
  if (
    typeof authority.prepareManagedItems !== "function" ||
    typeof authority.beginManagedItemDispatch !== "function" ||
    typeof authority.recordManagedItemProviderId !== "function" ||
    typeof authority.recordManagedItemReceipt !== "function" ||
    typeof authority.markManagedItemUnknown !== "function" ||
    typeof authority.readManagedItemGenerationProof !== "function"
  ) {
    projectionFail(
      "PROJECTION_AUTHORITY_CONFLICT",
      "durable managed item authority is unavailable",
    );
  }
}

function managedItemIntents(
  prepared: readonly PreparedManagedItem[],
  profile: ProjectionExecutionProfile,
): readonly ManagedItemIntent[] {
  return Object.freeze(prepared.map((item, desiredIndex) => ({
    desired_index: desiredIndex,
    item_key: item.item_key,
    provider_key: item.key,
    provider_source: "builtin" as const,
    managed_instance_id: profile.managed_instance_id,
    managed_generation: profile.managed_generation,
    section_content_sha256: assertProjectionSha256(
      item.metadata.content_sha256,
      "managed section content digest",
    ),
    normalized_start_byte: item.normalized_start_byte,
    normalized_end_byte: item.normalized_end_byte,
    document_sha256: item.document_sha256,
    document_size_bytes: item.size,
    metadata: item.metadata,
  })));
}

function effectFor(effects: readonly ManagedItemEffect[], itemKey: string): ManagedItemEffect {
  const effect = effects.find((candidate) => candidate.item_key === itemKey);
  if (effect === undefined) {
    projectionFail("PROJECTION_AUTHORITY_CONFLICT", "durable managed item intent readback is incomplete");
  }
  return effect;
}

function ackItemId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  if (typeof id !== "string") return null;
  try {
    return assertProjectionIdentifier(id, "AI Search upload acknowledgement ID");
  } catch {
    return null;
  }
}

async function recoverManagedItem(
  authority: ManagedItemAuthority,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  fence: ManagedExecutionFence,
  instance: ProjectionAiSearchInstance,
  item: PreparedManagedItem,
  effect: ManagedItemEffect,
  readCurrentTarget: CurrentManagedTargetReader,
): Promise<ManagedItemReceipt> {
  await assertCurrentManagedTarget(readCurrentTarget, fence);
  let listed;
  try {
    listed = await listExactManagedItem(instance, item);
  } catch (error) {
    await authority.markManagedItemUnknown(context, projectionGeneration, item.item_key, fence);
    throw error;
  }
  if (listed === null) {
    await authority.markManagedItemUnknown(context, projectionGeneration, item.item_key, fence);
    throw new ManagedItemRecoveryBlockedError(
      `AI Search item ${item.key} is absent from the exact built-in source listing`,
    );
  }
  if (effect.provider_item_id !== null && effect.provider_item_id !== listed.id) {
    throw new ManagedItemRecoveryBlockedError(
      `AI Search exact item ${item.key} has a foreign provider ID`,
    );
  }
  await authority.recordManagedItemProviderId(
    context,
    projectionGeneration,
    item.item_key,
    listed.id,
    fence,
  );
  await assertCurrentManagedTarget(readCurrentTarget, fence);
  const receipt = await readManagedItem(instance, item, listed.id, listed);
  await assertCurrentManagedTarget(readCurrentTarget, fence);
  if (
    effect.receipt !== null &&
    canonicalProjectionJson(effect.receipt) !== canonicalProjectionJson(receipt)
  ) {
    throw new ManagedItemRecoveryBlockedError(
      `AI Search exact item ${item.key} differs from its durable readback receipt`,
    );
  }
  await authority.recordManagedItemReceipt(context, projectionGeneration, receipt, fence);
  return receipt;
}

async function indexManagedItem(
  authority: ManagedItemAuthority,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  fence: ManagedExecutionFence,
  profile: ProjectionExecutionProfile,
  instance: ProjectionAiSearchInstance,
  item: PreparedManagedItem,
  effect: ManagedItemEffect,
  intents: readonly ManagedItemIntent[],
  readCurrentTarget: CurrentManagedTargetReader,
): Promise<ManagedItemReceipt> {
  if (effect.state !== "INTENT") {
    return recoverManagedItem(
      authority,
      context,
      projectionGeneration,
      fence,
      instance,
      item,
      effect,
      readCurrentTarget,
    );
  }
  await assertCurrentManagedTarget(readCurrentTarget, fence);
  if (profile.managed_generation_active) {
    throw new ManagedProjectionAdapterError(
      "new target-bound managed item keys must be built in a shadow generation before the active generation is changed",
    );
  }
  const dispatchAllowed = await authority.beginManagedItemDispatch(
    context,
    projectionGeneration,
    item.item_key,
    fence,
  );
  if (!dispatchAllowed) {
    const refreshed = await authority.prepareManagedItems(
      context,
      projectionGeneration,
      profile,
      intents,
      fence,
    );
    return recoverManagedItem(
      authority,
      context,
      projectionGeneration,
      fence,
      instance,
      item,
      effectFor(refreshed, item.item_key),
      readCurrentTarget,
    );
  }

  try {
    await assertCurrentManagedTarget(readCurrentTarget, fence);
    const acknowledgement = await instance.items.uploadAndPoll(item.key, item.document, {
      metadata: item.metadata,
      pollIntervalMs: profile.managed_poll_interval_ms,
      timeoutMs: profile.managed_timeout_ms,
    });
    const acknowledgedId = ackItemId(acknowledgement);
    if (acknowledgedId !== null) {
      await authority.recordManagedItemProviderId(
        context,
        projectionGeneration,
        item.item_key,
        acknowledgedId,
        fence,
      );
    }
  } catch (error) {
    await authority.markManagedItemUnknown(context, projectionGeneration, item.item_key, fence);
    if (
      error instanceof ManagedItemRecoveryBlockedError ||
      error instanceof ManagedProjectionCurrentnessError
    ) throw error;
    // The durable DISPATCHED state forbids a second upload; recovery is read-only.
  }
  const refreshed = await authority.prepareManagedItems(
    context,
    projectionGeneration,
    profile,
    intents,
    fence,
  );
  return recoverManagedItem(
    authority,
    context,
    projectionGeneration,
    fence,
    instance,
    item,
    effectFor(refreshed, item.item_key),
    readCurrentTarget,
  );
}

export interface ManagedProjectionDependencies {
  readonly namespace: ProjectionAiSearchNamespace;
  readonly profile: ProjectionExecutionProfile;
  readonly authority: ManagedItemAuthority;
  readonly isCurrentTarget: CurrentManagedTargetReader;
}

export function createManagedProjectionPort(
  dependencies: ManagedProjectionDependencies,
): ManagedProjectionPort {
  return {
    async index(context, projectionGeneration, items, fence): Promise<ManagedProjectionReceipt> {
      try {
        await assertCurrentManagedTarget(dependencies.isCurrentTarget, fence);
        let prepared: readonly PreparedManagedItem[];
        try {
          prepared = await prepareManagedItems(
            context,
            projectionGeneration,
            dependencies.profile,
            items,
          );
        } catch (error) {
          if (error instanceof ProjectionRuntimeError) {
            throw new ManagedProjectionInputError(error);
          }
          throw error;
        }
        assertManagedItemAuthority(dependencies.authority);
        const intents = managedItemIntents(prepared, dependencies.profile);
        const effects = await dependencies.authority.prepareManagedItems(
          context,
          projectionGeneration,
          dependencies.profile,
          intents,
          fence,
        );
        if (
          effects.length !== prepared.length ||
          effects.some((effect, index) => effect.item_key !== prepared[index]?.item_key)
        ) {
          projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item intents are not the exact desired set");
        }
        const instance = dependencies.namespace.get(dependencies.profile.managed_instance_id);
        const receipts: ManagedItemReceipt[] = [];
        for (let index = 0; index < prepared.length; index += 1) {
          const item = prepared[index];
          const effect = effects[index];
          if (item === undefined || effect === undefined) {
            projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed item progress is incomplete");
          }
          receipts.push(await indexManagedItem(
            dependencies.authority,
            context,
            projectionGeneration,
            fence,
            dependencies.profile,
            instance,
            item,
            effect,
            intents,
            dependencies.isCurrentTarget,
          ));
        }
        if (receipts.length !== prepared.length) {
          throw new ManagedProjectionAdapterError(
            "AI Search settled item count differs from the prepared desired set",
          );
        }
        const readbackDigest = await projectionDigest(receipts);
        const receiptRef = await stableProjectionId(
          "managed-search-receipt",
          context.source_revision.source_revision_ref,
          projectionGeneration,
          dependencies.profile.managed_generation,
          readbackDigest,
        );
        await assertCurrentManagedTarget(dependencies.isCurrentTarget, fence);
        if (!dependencies.profile.managed_generation_active) {
          return {
            state: "DEGRADED",
            item_count: items.length,
            instance_id: dependencies.profile.managed_instance_id,
            managed_generation: dependencies.profile.managed_generation,
            shadow_receipt_ref: receiptRef,
            shadow_readback_digest: readbackDigest,
            reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
          };
        }
        return {
          state: "READY",
          receipt_ref: receiptRef,
          readback_digest: readbackDigest,
          item_count: items.length,
          instance_id: dependencies.profile.managed_instance_id,
          managed_generation: dependencies.profile.managed_generation,
          reason_codes: [],
        };
      } catch (error) {
        if (
          error instanceof ManagedItemRecoveryBlockedError ||
          (error instanceof ProjectionRuntimeError && error.retryable)
        ) {
          throw error;
        }
        return {
          state: "DEGRADED",
          item_count: items.length,
          instance_id: dependencies.profile.managed_instance_id,
          managed_generation: dependencies.profile.managed_generation,
          reason_codes: [
            error instanceof ManagedProjectionCurrentnessError
              ? error.reason_code
              : error instanceof ManagedProjectionInputError || error instanceof ManagedProjectionAdapterError
              ? error.reason_code
              : "MANAGED_INDEX_READBACK_FAILED",
          ],
        };
      }
    },
  };
}
