import type { MarkdownConversionAdapter, MarkdownConversionOptions } from "./markdown-conversion-contract.js";

export const RAW_MARKDOWN_CONVERSION_PROTOCOL = "eliotr.raw-markdown-conversion.v1" as const;
export type RawMarkdownConversionState = "STARTED" | "COMPLETE" | "FAILED" | "UNKNOWN";
export type RawMarkdownConversionFailureCode = "SOURCE_UNAVAILABLE" | "SOURCE_INTEGRITY_MISMATCH" | "AUTHORITY_STALE" | "IDEMPOTENCY_CONFLICT" | "PROVIDER_UNCERTAIN" | "PROVIDER_FAILED" | "OUTPUT_UNAVAILABLE" | "INVALID_REQUEST" | "CANCELED";
export interface RawMarkdownConversionRequest { readonly idempotency_key: string; readonly max_output_bytes: number; readonly max_tokens: number; readonly timeout_ms: number; readonly conversion_options?: MarkdownConversionOptions; }
export interface RawMarkdownConversionContext { readonly principal_ref: string; readonly credential_generation: string; readonly deployment_generation: string; readonly profile_generation: string; readonly signal?: AbortSignal; }
export interface RawMarkdownCaptureReceipt { readonly capture_id: string; readonly principal_ref: string; readonly owner_system_id: string; readonly source_namespace_id: string; readonly source_revision_ref: string; readonly source_logical_id: string; readonly source_owner_generation: string; readonly original_file_name: string; readonly object_key: string; readonly content_sha256: string; readonly size_bytes: number; readonly content_type: string; }
export interface RawMarkdownResult { readonly protocol: typeof RAW_MARKDOWN_CONVERSION_PROTOCOL; readonly state: RawMarkdownConversionState; readonly operation_id: string; readonly capture_id: string; readonly content_sha256: string; readonly output_sha256?: string; readonly output_bytes?: number; readonly detected_mime?: string; readonly format?: "markdown" | "text"; readonly tokens?: number; readonly failure_code?: RawMarkdownConversionFailureCode; }
export interface RawMarkdownSource { read(context: RawMarkdownConversionContext, capture_id: string): Promise<RawMarkdownCaptureReceipt | null>; open(receipt: RawMarkdownCaptureReceipt): Promise<ReadableStream<Uint8Array> | null>; assertCurrent(context: RawMarkdownConversionContext, receipt: RawMarkdownCaptureReceipt): Promise<void>; }
export interface RawMarkdownOutputStore { putImmutable(input: { readonly key: string; readonly body: ReadableStream<Uint8Array>; readonly expected_sha256: string; readonly expected_size_bytes: number; readonly content_type: string; readonly custom_metadata: Readonly<Record<string, string>> }): Promise<{ readonly key: string; readonly readback_sha256: string; readonly size_bytes: number }>; open(key: string): Promise<R2ObjectBody | null>; }
/** A STARTED row may have no result digest after a lost D1 acknowledgement; reconciliation trusts only an immutable receipt whose operation/capture/content identity and output readback all match that row. */
export interface RawMarkdownConversionDependencies { readonly database: D1Database; readonly source: RawMarkdownSource; readonly output: RawMarkdownOutputStore; readonly adapter: MarkdownConversionAdapter; readonly now?: () => number; readonly profile_generation: string; }
export interface RawMarkdownConversionService { convert(context: RawMarkdownConversionContext, capture_id: string, request: RawMarkdownConversionRequest): Promise<RawMarkdownResult>; }

export function parseRawMarkdownConversionRequest(value: unknown): RawMarkdownConversionRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>; const keys = new Set(["idempotency_key", "max_output_bytes", "max_tokens", "timeout_ms", "conversion_options"]);
  if (Object.keys(item).some((key) => !keys.has(key)) || typeof item.idempotency_key !== "string" || item.idempotency_key.length === 0 || item.idempotency_key.length > 256 ||
      !Number.isSafeInteger(item.max_output_bytes) || (item.max_output_bytes as number) < 1 || !Number.isSafeInteger(item.max_tokens) || (item.max_tokens as number) < 1 ||
      !Number.isSafeInteger(item.timeout_ms) || (item.timeout_ms as number) < 1 || (item.timeout_ms as number) > 300000 ||
      (item.conversion_options !== undefined && (typeof item.conversion_options !== "object" || item.conversion_options === null || Array.isArray(item.conversion_options)))) return null;
  return item as unknown as RawMarkdownConversionRequest;
}
export async function readRawMarkdownConversionRequest(request: Request): Promise<RawMarkdownConversionRequest | null> {
  try { return parseRawMarkdownConversionRequest(await request.json()); } catch { return null; }
}
