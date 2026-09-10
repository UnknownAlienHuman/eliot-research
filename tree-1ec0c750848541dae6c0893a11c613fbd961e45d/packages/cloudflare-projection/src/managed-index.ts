import type { ProjectionItem } from "@eliotr/contracts";
import { projectionMetadata } from "@eliotr/platform-cloudflare";
import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  canonicalProjectionJson,
  projectionDigest,
  projectionSha256Utf8,
  stableProjectionId,
  utf8ProjectionLength,
} from "./canonical.js";
import type {
  ManagedProjectionPort,
  ManagedProjectionReceipt,
  ProjectionExecutionProfile,
  ProjectionSourceContext,
} from "./types.js";

export interface ProjectionAiSearchItemInfo {
  readonly id: string;
  readonly key: string;
  readonly status: "queued" | "running" | "completed" | "error" | "skipped" | "outdated";
  readonly chunks_count: number;
  readonly file_size: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly source_id?: string;
  readonly created_at?: string;
  readonly last_seen_at?: string;
}

export interface ProjectionAiSearchItemHandle {
  info(): Promise<unknown>;
}

export interface ProjectionAiSearchInstance {
  readonly items: {
    uploadAndPoll(
      key: string,
      content: string | ArrayBuffer | ReadableStream<Uint8Array>,
      options?: {
        readonly metadata?: Readonly<Record<string, string>>;
        readonly pollIntervalMs?: number;
        readonly timeoutMs?: number;
      },
    ): Promise<unknown>;
    get(itemId: string): ProjectionAiSearchItemHandle;
  };
}

export interface ProjectionAiSearchNamespace {
  get(instanceId: string): ProjectionAiSearchInstance;
}

interface ManagedItemReceipt {
  readonly item_key: string;
  readonly provider_item_id: string;
  readonly provider_key: string;
  readonly file_size: number;
  readonly chunks_count: number;
  readonly readback_sha256: string;
}

function assertExpectedMetadata(
  value: unknown,
  expected: Readonly<Record<string, string>>,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}.metadata is missing`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  const expectedKeys = Object.keys(expected).sort();
  const observedKeys = Object.keys(record).sort();
  if (
    observedKeys.length !== expectedKeys.length ||
    observedKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`${label}.metadata fields differ from the uploaded generation`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (record[key] !== expectedValue) {
      throw new Error(`${label}.metadata.${key} differs from the uploaded generation`);
    }
  }
  return record;
}

function decodeItem(
  raw: unknown,
  expectedKey: string,
  expectedSize: number,
  expectedMetadata: Readonly<Record<string, string>>,
  label: string,
): ProjectionAiSearchItemInfo {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} is not an object`);
  }
  const record = raw as Record<string, unknown>;
  const id = assertProjectionIdentifier(record.id, `${label}.id`);
  if (record.key !== expectedKey) throw new Error(`${label}.key differs from the uploaded key`);
  if (record.status !== "completed") throw new Error(`${label}.status is not completed`);
  const fileSize = assertProjectionInteger(
    record.file_size,
    `${label}.file_size`,
    1,
    4 * 1024 * 1024,
  );
  if (fileSize !== expectedSize) throw new Error(`${label}.file_size differs from uploaded bytes`);
  const chunks = assertProjectionInteger(
    record.chunks_count,
    `${label}.chunks_count`,
    1,
    1_000_000,
  );
  const metadata = assertExpectedMetadata(record.metadata, expectedMetadata, label);
  return {
    id,
    key: expectedKey,
    status: "completed",
    chunks_count: chunks,
    file_size: fileSize,
    metadata,
    ...(typeof record.source_id === "string" ? { source_id: record.source_id } : {}),
    ...(typeof record.created_at === "string" ? { created_at: record.created_at } : {}),
    ...(typeof record.last_seen_at === "string" ? { last_seen_at: record.last_seen_at } : {}),
  };
}

function managedDocument(item: ProjectionItem): string {
  const header = item.document_context_header.trim();
  return header.length === 0 ? item.section_text : `${header}\n\n${item.section_text}`;
}

function managedItemFilename(itemKey: string): string {
  const key = assertProjectionIdentifier(itemKey, "projection item key");
  if (key.includes("/") || key.length > 253) {
    throw new Error("projection item key cannot form a bounded canonical AI Search filename");
  }
  return `${key}.md`;
}

async function indexItem(
  instance: ProjectionAiSearchInstance,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  profile: ProjectionExecutionProfile,
  item: ProjectionItem,
): Promise<ManagedItemReceipt> {
  if (item.source_revision_ref !== context.source_revision.source_revision_ref) {
    throw new Error("projection item source revision differs from the execution context");
  }
  if (item.projection_generation !== projectionGeneration) {
    throw new Error("projection item generation differs from the requested managed generation");
  }
  const key = managedItemFilename(item.item_key);
  const document = managedDocument(item);
  const size = utf8ProjectionLength(document);
  if (size < 1 || size > 4 * 1024 * 1024) {
    throw new Error("managed projection item exceeds the AI Search Items API file envelope");
  }
  const metadata = projectionMetadata(item);
  const uploaded = decodeItem(
    await instance.items.uploadAndPoll(key, document, {
      metadata,
      pollIntervalMs: profile.managed_poll_interval_ms,
      timeoutMs: profile.managed_timeout_ms,
    }),
    key,
    size,
    metadata,
    "AI Search upload result",
  );
  const readback = decodeItem(
    await instance.items.get(uploaded.id).info(),
    key,
    size,
    metadata,
    "AI Search item readback",
  );
  if (
    readback.id !== uploaded.id ||
    readback.chunks_count !== uploaded.chunks_count
  ) {
    throw new Error("AI Search item readback differs from upload completion");
  }
  return {
    item_key: item.item_key,
    provider_item_id: readback.id,
    provider_key: readback.key,
    file_size: readback.file_size,
    chunks_count: readback.chunks_count,
    readback_sha256: await projectionSha256Utf8(canonicalProjectionJson({
      id: readback.id,
      key: readback.key,
      status: readback.status,
      file_size: readback.file_size,
      chunks_count: readback.chunks_count,
      metadata: readback.metadata,
    })),
  };
}

export interface ManagedProjectionDependencies {
  readonly namespace: ProjectionAiSearchNamespace;
  readonly profile: ProjectionExecutionProfile;
}

export function createManagedProjectionPort(
  dependencies: ManagedProjectionDependencies,
): ManagedProjectionPort {
  return {
    async index(context, projectionGeneration, items): Promise<ManagedProjectionReceipt> {
      try {
        const instance = dependencies.namespace.get(dependencies.profile.managed_instance_id);
        const receipts: ManagedItemReceipt[] = [];
        for (const item of items) {
          receipts.push(await indexItem(
            instance,
            context,
            projectionGeneration,
            dependencies.profile,
            item,
          ));
        }
        const readbackDigest = await projectionDigest(receipts);
        const receiptRef = await stableProjectionId(
          "managed-search-receipt",
          context.source_revision.source_revision_ref,
          projectionGeneration,
          dependencies.profile.managed_generation,
          readbackDigest,
        );
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
        return {
          state: "DEGRADED",
          item_count: items.length,
          instance_id: dependencies.profile.managed_instance_id,
          managed_generation: dependencies.profile.managed_generation,
          reason_codes: [
            error instanceof Error && error.message.includes("status")
              ? "MANAGED_INDEX_NOT_COMPLETED"
              : "MANAGED_INDEX_READBACK_FAILED",
          ],
        };
      }
    },
  };
}
