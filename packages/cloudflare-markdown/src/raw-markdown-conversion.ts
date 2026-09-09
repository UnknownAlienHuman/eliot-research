import { bufferBounded, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { createWorkersAiMarkdownConversionAdapter } from "./markdown-conversion.js";
import { MARKDOWN_CONVERSION_MAX_BUFFERED_FILE_BYTES } from "./markdown-conversion-contract.js";
import type { RawMarkdownConversionDependencies, RawMarkdownConversionRequest, RawMarkdownConversionService, RawMarkdownResult } from "./raw-markdown-conversion-contract.js";

// IMPLEMENTED_NOT_LIVE: ER-16 durable raw markdown conversion records one server-owned provider attempt; live Workers AI qualification remains separate.

const MAX_RECEIPT_BYTES = 64 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();
const body = (bytes: Uint8Array): ReadableStream<Uint8Array> => {
  const response = new Response(bytes.buffer as ArrayBuffer);
  if (response.body === null) throw new Error("unable to create bounded output body");
  return response.body as ReadableStream<Uint8Array>;
};
const canonical = (value: unknown) => JSON.stringify(value);
function validId(value: unknown): value is string { return typeof value === "string" && IDENTIFIER.test(value); }
function validRequest(value: unknown): value is RawMarkdownConversionRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return validId(v.idempotency_key) && Number.isSafeInteger(v.max_output_bytes) && (v.max_output_bytes as number) > 0 && (v.max_output_bytes as number) <= MARKDOWN_CONVERSION_MAX_BUFFERED_FILE_BYTES && Number.isSafeInteger(v.max_tokens) && (v.max_tokens as number) > 0 && Number.isSafeInteger(v.timeout_ms) && (v.timeout_ms as number) > 0 && (v.timeout_ms as number) <= 300_000;
}
function base(operation_id: string, capture_id: string, content_sha256: string, state: RawMarkdownResult["state"]): RawMarkdownResult { return { protocol: "eliotr.raw-markdown-conversion.v1", state, operation_id, capture_id, content_sha256 }; }
function decode(row: Record<string, unknown>): RawMarkdownResult | null {
  if (typeof row.result_json !== "string") return null;
  try {
    const result = JSON.parse(row.result_json) as RawMarkdownResult;
    if (result.protocol !== "eliotr.raw-markdown-conversion.v1" || typeof result.operation_id !== "string" ||
        typeof result.capture_id !== "string" || !SHA256.test(result.content_sha256) ||
        !["STARTED", "COMPLETE", "FAILED", "UNKNOWN"].includes(result.state)) return null;
    if (result.state === "COMPLETE" && (!SHA256.test(result.output_sha256 ?? "") ||
        !Number.isSafeInteger(result.output_bytes) || (result.output_bytes as number) < 1 ||
        typeof result.detected_mime !== "string" || !["markdown", "text"].includes(result.format ?? "") ||
        !Number.isSafeInteger(result.tokens))) return null;
    return result;
  } catch { return null; }
}
async function replay(row: Record<string, unknown>): Promise<RawMarkdownResult | null> {
  const result = decode(row);
  if (result === null) return null;
  if (result.state === "COMPLETE" && (typeof row.result_sha256 !== "string" || row.result_sha256 !== await sha256Utf8(canonical(result)))) return null;
  return result;
}
async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** Durable conversion attempt. The unique STARTED row fences the provider call. */
export function createRawMarkdownConversionService(dependencies: RawMarkdownConversionDependencies): RawMarkdownConversionService {
  const now = dependencies.now ?? Date.now;
  async function readRow(operationId: string): Promise<Record<string, unknown> | null> { return dependencies.database.prepare("SELECT * FROM raw_markdown_conversion WHERE operation_id=?1").bind(operationId).first<Record<string, unknown>>(); }
  async function reconcile(row: Record<string, unknown>): Promise<RawMarkdownResult | null> {
    const operationId = row.operation_id; const receiptKey = row.receipt_object_key;
    if (!validId(operationId) || typeof receiptKey !== "string") return null;
    const object = await dependencies.output.open(receiptKey); if (object === null) return null;
    const bytes = await bufferBounded(object.body, MAX_RECEIPT_BYTES); let result: RawMarkdownResult;
    try { result = JSON.parse(new TextDecoder().decode(bytes)) as RawMarkdownResult; } catch { return null; }
    if (result.protocol !== "eliotr.raw-markdown-conversion.v1" || result.operation_id !== operationId || result.state !== "COMPLETE" || decode({ result_json: JSON.stringify(result) }) === null) return null;
    const resultJson = canonical(result); const resultSha = await sha256Utf8(resultJson);
    if (row.result_sha256 !== resultSha || typeof row.output_object_key !== "string" || result.output_sha256 === undefined || result.output_bytes === undefined) return null;
    const output = await dependencies.output.open(row.output_object_key); if (output === null) return null;
    const outputBytes = await bufferBounded(output.body, MARKDOWN_CONVERSION_MAX_BUFFERED_FILE_BYTES);
    if (outputBytes.byteLength !== result.output_bytes || await digest(outputBytes) !== result.output_sha256) return null;
    const update = await dependencies.database.prepare("UPDATE raw_markdown_conversion SET state='COMPLETE',result_json=?2,result_sha256=?3,updated_at=?4 WHERE operation_id=?1 AND state='STARTED' AND attempt_id=?5").bind(operationId, resultJson, resultSha, new Date(now()).toISOString(), row.attempt_id).run();
    if ((update.meta?.changes ?? 0) === 1) return result;
    const replayRow = await readRow(operationId); return replayRow === null ? null : replay(replayRow);
  }
  async function settle(operationId: string, attemptId: string, result: RawMarkdownResult, receiptKey: string): Promise<RawMarkdownResult> {
    const resultJson = canonical(result); const bytes = encoder.encode(resultJson); if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new Error("conversion receipt exceeds bound");
    await dependencies.output.putImmutable({ key: receiptKey, body: body(bytes), expected_sha256: await sha256Utf8(resultJson), expected_size_bytes: bytes.byteLength, content_type: "application/json", custom_metadata: { operation_id: operationId, attempt_id: attemptId } });
    const update = await dependencies.database.prepare("UPDATE raw_markdown_conversion SET state='COMPLETE',result_json=?2,result_sha256=?3,updated_at=?4 WHERE operation_id=?1 AND state='STARTED' AND attempt_id=?5").bind(operationId, resultJson, await sha256Utf8(resultJson), new Date(now()).toISOString(), attemptId).run();
    if ((update.meta?.changes ?? 0) !== 1) { const row = await readRow(operationId); const replayResult = row === null ? null : await replay(row); if (replayResult !== null) return replayResult; throw new Error("conversion completion is uncertain"); }
    const row = await readRow(operationId); const replayResult = row === null ? null : await replay(row); if (replayResult === null) throw new Error("conversion completion readback is missing"); return replayResult;
  }
  return {
    async convert(context, captureId, request): Promise<RawMarkdownResult> {
      const operationId = await sha256Utf8(canonical(["eliotr.raw-markdown-conversion.v1", context.principal_ref, captureId, request?.idempotency_key]));
      if (!validId(context.principal_ref) || !validId(captureId) || !validRequest(request)) return { ...base(operationId, captureId, "0".repeat(64), "FAILED"), failure_code: "INVALID_REQUEST" };
      const capture = await dependencies.source.read(context, captureId);
      if (capture === null || capture.principal_ref !== context.principal_ref) return { ...base(operationId, captureId, "0".repeat(64), "FAILED"), failure_code: "SOURCE_UNAVAILABLE" };
      const requestJson = canonical(request); const requestSha = await sha256Utf8(requestJson); const authoritySha = await sha256Utf8(canonical([context.credential_generation, context.deployment_generation, context.profile_generation, capture.capture_id, capture.content_sha256, capture.source_owner_generation])); const existing = await readRow(operationId);
      if (existing !== null) {
        if (existing.request_sha256 !== requestSha || existing.authority_sha256 !== authoritySha) return { ...base(operationId, captureId, capture.content_sha256, "FAILED"), failure_code: "IDEMPOTENCY_CONFLICT" };
        const replayResult = await replay(existing); if (replayResult !== null) return replayResult;
        const recovered = await reconcile(existing); if (recovered !== null) return recovered;
        return { ...base(operationId, captureId, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" };
      }
      await dependencies.source.assertCurrent(context, capture);
      const attemptId = crypto.randomUUID(); const receiptKey = `raw-markdown/${operationId}/receipt.json`; const outputKey = `raw-markdown/${operationId}/output.md`; const timestamp = new Date(now()).toISOString();
      try { const inserted = await dependencies.database.prepare("INSERT INTO raw_markdown_conversion(operation_id,principal_ref,capture_id,content_sha256,size_bytes,request_sha256,request_json,authority_sha256,attempt_id,state,receipt_object_key,output_object_key,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'STARTED',?10,?11,?12,?12)").bind(operationId, context.principal_ref, capture.capture_id, capture.content_sha256, capture.size_bytes, requestSha, requestJson, authoritySha, attemptId, receiptKey, outputKey, timestamp).run(); if ((inserted.meta?.changes ?? 0) !== 1) throw new Error("conversion reservation was not committed"); } catch { const row = await readRow(operationId); const replayResult = row === null ? null : await replay(row); if (replayResult !== null) return replayResult; return { ...base(operationId, captureId, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" }; }
      const sourceBody = await dependencies.source.open(capture); if (sourceBody === null) { const result = { ...base(operationId, captureId, capture.content_sha256, "FAILED"), failure_code: "SOURCE_UNAVAILABLE" } as RawMarkdownResult; await dependencies.database.prepare("UPDATE raw_markdown_conversion SET state='FAILED',result_json=?2,updated_at=?3 WHERE operation_id=?1 AND state='STARTED' AND attempt_id=?4").bind(operationId, canonical(result), new Date(now()).toISOString(), attemptId).run(); return result; }
      const sourceBytes = await bufferBounded(sourceBody, MARKDOWN_CONVERSION_MAX_BUFFERED_FILE_BYTES);
      if (sourceBytes.byteLength !== capture.size_bytes || !SHA256.test(capture.content_sha256) || await digest(sourceBytes) !== capture.content_sha256) { const result = { ...base(operationId, captureId, capture.content_sha256, "FAILED"), failure_code: "SOURCE_INTEGRITY_MISMATCH" } as RawMarkdownResult; await dependencies.database.prepare("UPDATE raw_markdown_conversion SET state='FAILED',result_json=?2,updated_at=?3 WHERE operation_id=?1 AND state='STARTED' AND attempt_id=?4").bind(operationId, canonical(result), new Date(now()).toISOString(), attemptId).run(); return result; }
      await dependencies.source.assertCurrent(context, capture);
      const sourceCopy = new Uint8Array(sourceBytes.byteLength); sourceCopy.set(sourceBytes);
      const converted = await dependencies.adapter.convert({ name: capture.original_file_name, blob: new Blob([sourceCopy.buffer], { type: capture.content_type }), context: { operation_id: operationId, attempt_id: attemptId, input_sha256: capture.content_sha256, profile_generation: dependencies.profile_generation }, bounds: { max_input_bytes: MARKDOWN_CONVERSION_MAX_BUFFERED_FILE_BYTES, max_output_bytes: request.max_output_bytes, max_tokens: request.max_tokens, timeout_ms: request.timeout_ms }, ...(context.signal === undefined ? {} : { signal: context.signal }), ...(request.conversion_options === undefined ? {} : { conversion_options: request.conversion_options }) });
      if (converted.disposition !== "CONVERTED") { const state = converted.dispatch_state === "OUTCOME_UNKNOWN" ? "UNKNOWN" : "FAILED"; const result = { ...base(operationId, captureId, capture.content_sha256, state), failure_code: state === "UNKNOWN" ? "PROVIDER_UNCERTAIN" : "PROVIDER_FAILED" } as RawMarkdownResult; await dependencies.database.prepare("UPDATE raw_markdown_conversion SET state=?2,result_json=?3,updated_at=?4 WHERE operation_id=?1 AND state='STARTED' AND attempt_id=?5").bind(operationId, state, canonical(result), new Date(now()).toISOString(), attemptId).run(); return result; }
      await dependencies.source.assertCurrent(context, capture);
      const outputBytes = encoder.encode(converted.data); const output = await dependencies.output.putImmutable({ key: outputKey, body: body(outputBytes), expected_sha256: converted.data_sha256, expected_size_bytes: outputBytes.byteLength, content_type: "text/markdown; charset=utf-8", custom_metadata: { operation_id: operationId, capture_id: capture.capture_id } });
      if (output.readback_sha256 !== converted.data_sha256 || output.size_bytes !== outputBytes.byteLength) return { ...base(operationId, captureId, capture.content_sha256, "UNKNOWN"), failure_code: "OUTPUT_UNAVAILABLE" };
      await dependencies.source.assertCurrent(context, capture);
      const settled = await settle(operationId, attemptId, { ...base(operationId, captureId, capture.content_sha256, "COMPLETE"), output_sha256: converted.data_sha256, output_bytes: outputBytes.byteLength, detected_mime: converted.detected_mime, format: converted.format, tokens: converted.tokens }, receiptKey);
      await dependencies.source.assertCurrent(context, capture);
      return settled;
    },
  };
}
export { createWorkersAiMarkdownConversionAdapter };
