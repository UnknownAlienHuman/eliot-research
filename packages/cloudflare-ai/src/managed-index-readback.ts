import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  canonicalProjectionJson,
  projectionSha256Bytes,
  projectionSha256Utf8,
} from "@eliotr/cloudflare-projection";

import type { ProjectionAuthorityPort } from "@eliotr/cloudflare-projection";

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
  download(): Promise<unknown>;
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
    list?(options: {
      readonly key: string;
      readonly source: "builtin";
      readonly page: number;
      readonly per_page: number;
    }): Promise<unknown>;
    get(itemId: string): ProjectionAiSearchItemHandle;
  };
}

export interface PreparedManagedItem {
  readonly item_key: string;
  readonly key: string;
  readonly document: string;
  readonly size: number;
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
  readonly document_sha256: string;
  readonly metadata: Readonly<Record<string, string>>;
}

type ManagedItemEffect = Awaited<
  ReturnType<NonNullable<ProjectionAuthorityPort["prepareManagedItems"]>>
>[number];
export type ManagedItemReceipt = NonNullable<ManagedItemEffect["receipt"]>;

export class ManagedProjectionAdapterError extends Error {
  public readonly reason_code = "MANAGED_INDEX_NOT_COMPLETED" as const;

  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ManagedProjectionAdapterError";
  }
}

export class ManagedItemRecoveryBlockedError extends Error {
  public readonly reason_code = "MANAGED_ITEM_RECOVERY_BLOCKED" as const;
  public readonly retryable = true;

  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ManagedItemRecoveryBlockedError";
  }
}

const BUILTIN_METADATA_FIELDS = new Set(["filename", "folder", "timestamp"]);

function assertExpectedMetadata(
  value: unknown,
  expected: Readonly<Record<string, string>>,
  expectedFilename: string,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}.metadata is missing`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  const expectedKeys = Object.keys(expected).sort();
  const observedKeys = Object.keys(record).sort();
  const observedCustomKeys = observedKeys.filter((key) => !BUILTIN_METADATA_FIELDS.has(key));
  if (
    observedCustomKeys.length !== expectedKeys.length ||
    observedCustomKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`${label}.metadata fields differ from the uploaded generation`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (record[key] !== expectedValue) {
      throw new Error(`${label}.metadata.${key} differs from the uploaded generation`);
    }
  }
  if (Object.hasOwn(record, "filename") && record.filename !== expectedFilename) {
    throw new Error(`${label}.metadata.filename differs from the uploaded key`);
  }
  if (Object.hasOwn(record, "folder") && record.folder !== "") {
    throw new Error(`${label}.metadata.folder differs from the flat uploaded key`);
  }
  if (
    Object.hasOwn(record, "timestamp") &&
    (typeof record.timestamp !== "number" ||
      !Number.isSafeInteger(record.timestamp) ||
      record.timestamp < 0)
  ) {
    throw new Error(`${label}.metadata.timestamp is not a Unix millisecond timestamp`);
  }
  return record;
}

export function decodeManagedItemInfo(
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
  if (record.status !== "completed") {
    throw new ManagedProjectionAdapterError(`${label}.status is not completed`);
  }
  const fileSize = assertProjectionInteger(record.file_size, `${label}.file_size`, 1, 4 * 1024 * 1024);
  if (fileSize !== expectedSize) throw new Error(`${label}.file_size differs from uploaded bytes`);
  const chunks = assertProjectionInteger(record.chunks_count, `${label}.chunks_count`, 1, 1_000_000);
  const metadata = assertExpectedMetadata(record.metadata, expectedMetadata, expectedKey, label);
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

export async function listExactManagedItem(
  instance: ProjectionAiSearchInstance,
  item: PreparedManagedItem,
): Promise<ProjectionAiSearchItemInfo | null> {
  if (instance.items.list === undefined) {
    throw new ManagedItemRecoveryBlockedError("AI Search exact item listing is unavailable");
  }
  let raw: unknown;
  try {
    raw = await instance.items.list({
      key: item.key,
      source: "builtin",
      page: 1,
      per_page: 50,
    });
  } catch (cause) {
    throw new ManagedItemRecoveryBlockedError("AI Search exact item listing failed", cause);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ManagedItemRecoveryBlockedError("AI Search exact item listing is malformed");
  }
  const response = raw as Record<string, unknown>;
  if (!Array.isArray(response.result) || response.result.length > 1) {
    throw new ManagedItemRecoveryBlockedError("AI Search exact item listing is incomplete or duplicated");
  }
  const info = response.result_info;
  if (typeof info !== "object" || info === null || Array.isArray(info)) {
    throw new ManagedItemRecoveryBlockedError("AI Search exact item page metadata is missing or malformed");
  }
  const page = info as Record<string, unknown>;
  const pageKeys = Object.keys(page).sort();
  if (
    pageKeys.length !== 4 ||
    pageKeys[0] !== "count" ||
    pageKeys[1] !== "page" ||
    pageKeys[2] !== "per_page" ||
    pageKeys[3] !== "total_count" ||
    page.page !== 1 ||
    page.per_page !== 50 ||
    page.count !== response.result.length ||
    page.total_count !== response.result.length
  ) {
    throw new ManagedItemRecoveryBlockedError("AI Search exact item page metadata is inconsistent");
  }
  if (response.result.length === 0) return null;
  try {
    return decodeManagedItemInfo(
      response.result[0],
      item.key,
      item.size,
      item.metadata,
      "AI Search exact item listing result",
    );
  } catch (cause) {
    throw new ManagedItemRecoveryBlockedError("AI Search exact item listing did not match intent", cause);
  }
}

export async function readManagedItem(
  instance: ProjectionAiSearchInstance,
  item: PreparedManagedItem,
  providerItemId: string,
  listed?: ProjectionAiSearchItemInfo,
): Promise<ManagedItemReceipt> {
  const id = assertProjectionIdentifier(providerItemId, "provider item ID");
  const providerItem = instance.items.get(id);
  const readback = decodeManagedItemInfo(
    await providerItem.info(),
    item.key,
    item.size,
    item.metadata,
    "AI Search item readback",
  );
  if (readback.id !== id || (listed !== undefined &&
      (listed.id !== readback.id || listed.chunks_count !== readback.chunks_count))) {
    throw new Error("AI Search item readback differs from exact source listing");
  }
  const contentSha256 = await readDownloadedContent(
    await providerItem.download(),
    item.key,
    item.size,
    item.document_sha256,
  );
  return {
    item_key: item.item_key,
    provider_item_id: readback.id,
    provider_key: readback.key,
    file_size: readback.file_size,
    chunks_count: readback.chunks_count,
    content_sha256: contentSha256,
    readback_sha256: await projectionSha256Utf8(canonicalProjectionJson({
      id: readback.id,
      key: readback.key,
      status: readback.status,
      file_size: readback.file_size,
      chunks_count: readback.chunks_count,
      metadata: readback.metadata,
      content_sha256: contentSha256,
    })),
  };
}

async function readDownloadedContent(
  raw: unknown,
  expectedFilename: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("AI Search downloaded item is not an object");
  }
  const record = raw as Record<string, unknown>;
  if (
    record.filename !== expectedFilename ||
    record.size !== expectedSize ||
    typeof record.body !== "object" ||
    record.body === null ||
    typeof (record.body as ReadableStream<Uint8Array>).getReader !== "function"
  ) {
    throw new Error("AI Search downloaded item envelope differs from the desired item");
  }
  const reader = (record.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        throw new Error("AI Search downloaded item body is not a byte stream");
      }
      byteLength += next.value.byteLength;
      if (byteLength > expectedSize) {
        await reader.cancel();
        throw new Error("AI Search downloaded item exceeds the bounded desired size");
      }
      chunks.push(next.value);
    }
  } catch (cause) {
    try { await reader.cancel(); } catch { /* preserve the bounded-read failure */ }
    throw cause;
  } finally {
    reader.releaseLock();
  }
  if (byteLength !== expectedSize) {
    throw new Error("AI Search downloaded item byte length differs from the desired item");
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = await projectionSha256Bytes(bytes);
  if (digest !== expectedSha256) {
    throw new Error("AI Search downloaded item bytes differ from the desired document");
  }
  return digest;
}
