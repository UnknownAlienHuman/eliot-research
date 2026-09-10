import { bufferBounded, RUNTIME_LIMITS } from "@eliotr/platform-cloudflare";
import { decodeStoredRawMarkdownResult } from "./raw-markdown-conversion.js";
import type { RawMarkdownCaptureReceipt, RawMarkdownResult } from "./raw-markdown-conversion-contract.js";

const MAX_OUTPUT_BYTES = Math.min(RUNTIME_LIMITS.buffered_r2_bytes, 8 * 1024 * 1024);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface RawMarkdownCandidateReadback {
  readonly conversion: RawMarkdownResult & {
    readonly state: "COMPLETE";
    readonly output_sha256: string;
    readonly output_bytes: number;
    readonly detected_mime: string;
    readonly format: "markdown" | "text";
    readonly tokens: number;
  };
  readonly output: {
    readonly object_key: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly size_bytes: number;
  };
}

/** Reads one server-owned conversion row and its immutable output exactly once. */
export async function readRawMarkdownCandidate(
  database: D1Database,
  bucket: R2Bucket,
  context: { readonly principal_ref: string },
  capture: RawMarkdownCaptureReceipt & { readonly residency_key_digest?: string },
  operationId: string,
  guards: { readonly assertCurrent?: () => Promise<void>; readonly signal?: AbortSignal } = {},
): Promise<RawMarkdownCandidateReadback | null> {
  if (!ID.test(operationId)) return null;
  if (guards.signal?.aborted) return null;
  await guards.assertCurrent?.();
  if (guards.signal?.aborted) return null;
  const row = await database.prepare("SELECT * FROM raw_markdown_conversion WHERE operation_id=?1 LIMIT 1")
    .bind(operationId).first<Record<string, unknown>>();
  if (row === null || row.principal_ref !== context.principal_ref || row.capture_id !== capture.capture_id ||
      row.content_sha256 !== capture.content_sha256 || row.state !== "COMPLETE" || typeof row.output_object_key !== "string" || !ID.test(row.output_object_key)) return null;
  const result = decodeStoredRawMarkdownResult(row);
  const outputSha = result?.output_sha256;
  const outputBytes = result?.output_bytes;
  if (result === null || result.state !== "COMPLETE" || result.operation_id !== operationId || result.capture_id !== capture.capture_id ||
      result.content_sha256 !== capture.content_sha256 || !SHA256.test(outputSha ?? "") ||
      typeof outputBytes !== "number" || !Number.isSafeInteger(outputBytes) || outputBytes < 1 || outputBytes > MAX_OUTPUT_BYTES ||
      typeof row.result_sha256 !== "string" || row.result_sha256 !== await sha256Utf8Canonical(result)) return null;
  const object = await bucket.get(row.output_object_key);
  if (object === null || object.body === null) return null;
  if (guards.signal?.aborted) return null;
  const bytes = await bufferBounded(object.body, MAX_OUTPUT_BYTES);
  if (guards.signal?.aborted) return null;
  if (bytes.byteLength !== outputBytes) return null;
  const hash = await digest(bytes);
  if (hash !== result.output_sha256) return null;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  await guards.assertCurrent?.();
  if (guards.signal?.aborted === true) return null;
  return {
    conversion: result as RawMarkdownCandidateReadback["conversion"],
    output: { object_key: row.output_object_key, bytes, sha256: hash, size_bytes: bytes.byteLength },
  };
}

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Utf8Canonical(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return digest(encoded);
}
