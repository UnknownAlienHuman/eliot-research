import { bufferBounded, canonicalDigest, RUNTIME_LIMITS, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { createWorkersAiMarkdownConversionAdapter, isValidMarkdownConversionOptions } from "./markdown-conversion.js";
import { MARKDOWN_CONVERSION_MAX_BUFFERED_FILE_BYTES } from "./markdown-conversion-contract.js";
import type {
  RawMarkdownCaptureReceipt,
  RawMarkdownConversionContext,
  RawMarkdownConversionDependencies,
  RawMarkdownConversionRequest,
  RawMarkdownConversionService,
  RawMarkdownResult,
} from "./raw-markdown-conversion-contract.js";

// IMPLEMENTED_NOT_LIVE: ER-16 durable raw markdown conversion records one server-owned provider attempt; live Workers AI qualification remains separate.

const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_SERVER_R2_BYTES = Math.min(RUNTIME_LIMITS.buffered_r2_bytes, MARKDOWN_CONVERSION_MAX_BUFFERED_FILE_BYTES);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();
const canonical = (value: unknown): string => JSON.stringify(value) ?? "null";

function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const response = new Response(bytes.buffer as ArrayBuffer);
  if (response.body === null) throw new Error("unable to create bounded output body");
  return response.body as ReadableStream<Uint8Array>;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function validRequest(value: unknown): value is RawMarkdownConversionRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return validId(candidate.idempotency_key) && Number.isSafeInteger(candidate.max_output_bytes) &&
    (candidate.max_output_bytes as number) > 0 && (candidate.max_output_bytes as number) <= MAX_SERVER_R2_BYTES &&
    Number.isSafeInteger(candidate.max_tokens) && (candidate.max_tokens as number) > 0 &&
    Number.isSafeInteger(candidate.timeout_ms) && (candidate.timeout_ms as number) > 0 && (candidate.timeout_ms as number) <= 300_000 &&
    isValidMarkdownConversionOptions(candidate.conversion_options);
}

function base(operationId: string, captureId: string, contentSha: string, state: RawMarkdownResult["state"]): RawMarkdownResult {
  return { protocol: "eliotr.raw-markdown-conversion.v1", state, operation_id: operationId, capture_id: captureId, content_sha256: contentSha };
}

function decode(row: Record<string, unknown>): RawMarkdownResult | null {
  if (typeof row.result_json !== "string") return null;
  try {
    const result = JSON.parse(row.result_json) as Record<string, unknown>;
    const allowed = new Set(["protocol", "state", "operation_id", "capture_id", "content_sha256", "output_sha256", "output_bytes", "detected_mime", "format", "tokens", "failure_code"]);
    if (typeof result !== "object" || result === null || Object.keys(result).some((key) => !allowed.has(key)) ||
        result.protocol !== "eliotr.raw-markdown-conversion.v1" || !validId(result.operation_id) || !validId(result.capture_id) ||
        typeof result.content_sha256 !== "string" || !SHA256.test(result.content_sha256) ||
        !["COMPLETE", "FAILED", "UNKNOWN"].includes(String(result.state))) return null;
    if (result.state === "COMPLETE" && (typeof result.output_sha256 !== "string" || !SHA256.test(result.output_sha256) ||
        !Number.isSafeInteger(result.output_bytes) || (result.output_bytes as number) < 1 ||
        typeof result.detected_mime !== "string" || !["markdown", "text"].includes(String(result.format)) ||
        !Number.isSafeInteger(result.tokens) || (result.tokens as number) < 0)) return null;
    if ((result.state === "FAILED" || result.state === "UNKNOWN") &&
        !["SOURCE_UNAVAILABLE", "SOURCE_INTEGRITY_MISMATCH", "AUTHORITY_STALE", "IDEMPOTENCY_CONFLICT", "PROVIDER_UNCERTAIN", "PROVIDER_FAILED", "OUTPUT_UNAVAILABLE", "INVALID_REQUEST", "CANCELED"].includes(String(result.failure_code))) return null;
    return result as unknown as RawMarkdownResult;
  } catch {
    return null;
  }
}

function snapshotContext(context: RawMarkdownConversionContext): RawMarkdownConversionContext {
  return {
    principal_ref: context.principal_ref,
    credential_generation: context.credential_generation,
    deployment_generation: context.deployment_generation,
    profile_generation: context.profile_generation,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  };
}

function snapshotRequest(request: RawMarkdownConversionRequest | undefined): RawMarkdownConversionRequest | undefined {
  if (request === undefined) return undefined;
  try {
    return JSON.parse(canonical(request)) as RawMarkdownConversionRequest;
  } catch {
    return undefined;
  }
}

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function signalAborted(context: RawMarkdownConversionContext): boolean {
  return context.signal?.aborted === true;
}

function withoutSignal(context: RawMarkdownConversionContext): RawMarkdownConversionContext {
  return {
    principal_ref: context.principal_ref,
    credential_generation: context.credential_generation,
    deployment_generation: context.deployment_generation,
    profile_generation: context.profile_generation,
  };
}

/** Durable conversion attempt. The unique STARTED row fences the provider call. */
export function createRawMarkdownConversionService(dependencies: RawMarkdownConversionDependencies): RawMarkdownConversionService {
  const now = dependencies.now ?? Date.now;

  async function readRow(operationId: string): Promise<Record<string, unknown> | null> {
    return dependencies.database.prepare("SELECT * FROM raw_markdown_conversion WHERE operation_id=?1").bind(operationId).first<Record<string, unknown>>();
  }

  async function verifyComplete(
    row: Record<string, unknown>,
    result: RawMarkdownResult,
    context: RawMarkdownConversionContext,
    capture: RawMarkdownCaptureReceipt,
  ): Promise<RawMarkdownResult | null> {
    if (!["STARTED", "COMPLETE"].includes(String(row.state)) || row.operation_id !== result.operation_id || row.capture_id !== capture.capture_id ||
        row.principal_ref !== context.principal_ref || row.content_sha256 !== capture.content_sha256 ||
        (row.state === "COMPLETE" && (typeof row.result_sha256 !== "string" || row.result_sha256 !== await sha256Utf8(canonical(result)))) ||
        typeof row.output_object_key !== "string" || result.output_sha256 === undefined || result.output_bytes === undefined) return null;
    if (signalAborted(context)) return null;
    await dependencies.source.assertCurrent(context, capture);
    if (signalAborted(context)) return null;
    const output = await dependencies.output.open(row.output_object_key);
    if (output === null) return null;
    if (signalAborted(context)) return null;
    const outputBytes = await bufferBounded(output.body, MAX_SERVER_R2_BYTES);
    if (signalAborted(context)) return null;
    if (outputBytes.byteLength !== result.output_bytes || await digest(outputBytes) !== result.output_sha256) return null;
    if (signalAborted(context)) return null;
    await dependencies.source.assertCurrent(context, capture);
    if (signalAborted(context)) return null;
    return result;
  }

  async function verifyStoredResult(
    row: Record<string, unknown>,
    result: RawMarkdownResult,
    context: RawMarkdownConversionContext,
    capture: RawMarkdownCaptureReceipt,
  ): Promise<boolean> {
    return !signalAborted(context) && row.state === result.state && row.operation_id === result.operation_id &&
      row.capture_id === result.capture_id && row.capture_id === capture.capture_id &&
      row.principal_ref === context.principal_ref && row.content_sha256 === result.content_sha256 &&
      row.content_sha256 === capture.content_sha256 &&
      typeof row.result_sha256 === "string" && row.result_sha256 === await sha256Utf8(canonical(result));
  }

  async function replay(
    row: Record<string, unknown>,
    context: RawMarkdownConversionContext,
    capture: RawMarkdownCaptureReceipt,
  ): Promise<RawMarkdownResult | null> {
    const result = decode(row);
    if (result === null || !(await verifyStoredResult(row, result, context, capture))) return null;
    try {
      if (signalAborted(context)) return null;
      await dependencies.source.assertCurrent(context, capture);
      if (signalAborted(context)) return null;
    } catch {
      return null;
    }
    if (result.state !== "COMPLETE") return result;
    try {
      return await verifyComplete(row, result, context, capture);
    } catch {
      return null;
    }
  }

  async function reconcile(
    row: Record<string, unknown>,
    context: RawMarkdownConversionContext,
    capture: RawMarkdownCaptureReceipt,
  ): Promise<RawMarkdownResult | null> {
    if (row.state !== "STARTED" || !validId(row.operation_id) || typeof row.receipt_object_key !== "string") return null;
    if (signalAborted(context)) return null;
    const receipt = await dependencies.output.open(row.receipt_object_key);
    if (receipt === null) return null;
    if (signalAborted(context)) return null;
    const receiptBytes = await bufferBounded(receipt.body, MAX_RECEIPT_BYTES);
    if (signalAborted(context)) return null;
    const result = decode({ result_json: new TextDecoder().decode(receiptBytes) });
    if (result === null || result.state !== "COMPLETE" || result.operation_id !== row.operation_id ||
        result.capture_id !== capture.capture_id || result.content_sha256 !== capture.content_sha256 ||
        await digest(receiptBytes) !== await sha256Utf8(canonical(result))) return null;
    const verified = await verifyComplete(row, result, context, capture);
    if (verified === null) return null;
    const resultJson = canonical(result);
    const resultSha = await sha256Utf8(resultJson);
    if (row.result_sha256 !== null && row.result_sha256 !== undefined && row.result_sha256 !== resultSha) return null;
    const update = await dependencies.database.prepare("UPDATE raw_markdown_conversion SET state='COMPLETE',result_json=?2,result_sha256=?3,updated_at=?4 WHERE operation_id=?1 AND state='STARTED' AND attempt_id=?5")
      .bind(row.operation_id, resultJson, resultSha, new Date(now()).toISOString(), row.attempt_id).run();
    if ((update.meta?.changes ?? 0) === 1) return result;
    const replayRow = await readRow(row.operation_id);
    return replayRow === null ? null : replay(replayRow, context, capture);
  }

  async function settleFailure(
    operationId: string,
    attemptId: string,
    result: RawMarkdownResult,
    context: RawMarkdownConversionContext,
    capture: RawMarkdownCaptureReceipt,
  ): Promise<RawMarkdownResult> {
    const resultJson = canonical(result);
    const resultSha = await sha256Utf8(resultJson);
    try {
      await dependencies.database.prepare("UPDATE raw_markdown_conversion SET state=?2,result_json=?3,result_sha256=?4,updated_at=?5 WHERE operation_id=?1 AND state='STARTED' AND attempt_id=?6")
        .bind(operationId, result.state, resultJson, resultSha, new Date(now()).toISOString(), attemptId).run();
    } catch {
      // The provider effect is already classified; only a strict durable readback can settle this attempt.
    }
    let row: Record<string, unknown> | null;
    try {
      row = await readRow(operationId);
    } catch {
      return { ...base(operationId, capture.capture_id, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" };
    }
    const replayResult = row === null ? null : await replay(row, withoutSignal(context), capture);
    if (replayResult !== null) return replayResult;
    return { ...base(operationId, capture.capture_id, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" };
  }

  async function settle(
    operationId: string,
    attemptId: string,
    result: RawMarkdownResult,
    receiptKey: string,
    context: RawMarkdownConversionContext,
    capture: RawMarkdownCaptureReceipt,
  ): Promise<RawMarkdownResult> {
    const resultJson = canonical(result);
    const receiptBytes = encoder.encode(resultJson);
    if (receiptBytes.byteLength > MAX_RECEIPT_BYTES) throw new Error("conversion receipt exceeds bound");
    const resultSha = await sha256Utf8(resultJson);
    if (signalAborted(context)) return { ...base(operationId, capture.capture_id, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" };
    await dependencies.output.putImmutable({ key: receiptKey, body: body(receiptBytes), expected_sha256: resultSha, expected_size_bytes: receiptBytes.byteLength, content_type: "application/json", custom_metadata: { operation_id: operationId, attempt_id: attemptId } });
    if (signalAborted(context)) return { ...base(operationId, capture.capture_id, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" };
    const update = await dependencies.database.prepare("UPDATE raw_markdown_conversion SET state='COMPLETE',result_json=?2,result_sha256=?3,updated_at=?4 WHERE operation_id=?1 AND state='STARTED' AND attempt_id=?5")
      .bind(operationId, resultJson, resultSha, new Date(now()).toISOString(), attemptId).run();
    if ((update.meta?.changes ?? 0) !== 1 || signalAborted(context)) {
      if (signalAborted(context)) return { ...base(operationId, capture.capture_id, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" };
      const row = await readRow(operationId);
      const replayResult = row === null ? null : await replay(row, context, capture);
      if (replayResult !== null) return replayResult;
      throw new Error("conversion completion is uncertain");
    }
    const row = await readRow(operationId);
    const replayResult = row === null ? null : await replay(row, context, capture);
    if (replayResult === null) {
      if (signalAborted(context)) return { ...base(operationId, capture.capture_id, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" };
      throw new Error("conversion completion readback is missing");
    }
    return replayResult;
  }

  return {
    async convert(context, captureId, request): Promise<RawMarkdownResult> {
      const contextSnapshot = snapshotContext(context);
      const requestSnapshot = snapshotRequest(request);
      const operationId = await sha256Utf8(canonical(["eliotr.raw-markdown-conversion.v1", contextSnapshot.principal_ref, captureId, requestSnapshot?.idempotency_key]));
      if (!validId(contextSnapshot.principal_ref) || !validId(contextSnapshot.credential_generation) || !validId(contextSnapshot.deployment_generation) ||
          !validId(contextSnapshot.profile_generation) || !validId(captureId) || !validRequest(requestSnapshot)) return { ...base(operationId, captureId, "0".repeat(64), "FAILED"), failure_code: "INVALID_REQUEST" };
      const capture = await dependencies.source.read(contextSnapshot, captureId);
      if (capture === null || capture.principal_ref !== contextSnapshot.principal_ref) return { ...base(operationId, captureId, "0".repeat(64), "FAILED"), failure_code: "SOURCE_UNAVAILABLE" };
      if (!Number.isSafeInteger(capture.size_bytes) || capture.size_bytes < 1 || capture.size_bytes > MAX_SERVER_R2_BYTES) return { ...base(operationId, captureId, capture.content_sha256, "FAILED"), failure_code: "INVALID_REQUEST" };
      const requestJson = canonical(requestSnapshot);
      const requestSha = await canonicalDigest(requestSnapshot);
      const authoritySha = await sha256Utf8(canonical([contextSnapshot.credential_generation, contextSnapshot.deployment_generation, contextSnapshot.profile_generation, capture.capture_id, capture.content_sha256, capture.source_owner_generation]));
      const existing = await readRow(operationId);
      if (existing !== null) {
        if (existing.request_sha256 !== requestSha || existing.authority_sha256 !== authoritySha) return { ...base(operationId, captureId, capture.content_sha256, "FAILED"), failure_code: "IDEMPOTENCY_CONFLICT" };
        const replayResult = await replay(existing, contextSnapshot, capture);
        if (replayResult !== null) return replayResult;
        const recovered = await reconcile(existing, contextSnapshot, capture);
        if (recovered !== null) return recovered;
        return { ...base(operationId, captureId, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" };
      }
      if (signalAborted(contextSnapshot)) return { ...base(operationId, captureId, capture.content_sha256, "FAILED"), failure_code: "CANCELED" };
      await dependencies.source.assertCurrent(contextSnapshot, capture);
      if (signalAborted(contextSnapshot)) return { ...base(operationId, captureId, capture.content_sha256, "FAILED"), failure_code: "CANCELED" };
      const attemptId = crypto.randomUUID();
      const receiptKey = `raw-markdown/${operationId}/receipt.json`;
      const outputKey = `raw-markdown/${operationId}/output.md`;
      const timestamp = new Date(now()).toISOString();
      try {
        const inserted = await dependencies.database.prepare("INSERT INTO raw_markdown_conversion(operation_id,principal_ref,capture_id,content_sha256,size_bytes,request_sha256,request_json,authority_sha256,attempt_id,state,receipt_object_key,output_object_key,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'STARTED',?10,?11,?12,?12)")
          .bind(operationId, contextSnapshot.principal_ref, capture.capture_id, capture.content_sha256, capture.size_bytes, requestSha, requestJson, authoritySha, attemptId, receiptKey, outputKey, timestamp).run();
        if ((inserted.meta?.changes ?? 0) !== 1) throw new Error("conversion reservation was not committed");
      } catch {
        const row = await readRow(operationId);
        const replayResult = row === null ? null : await replay(row, contextSnapshot, capture);
        if (replayResult !== null) return replayResult;
        return { ...base(operationId, captureId, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" };
      }
      const sourceBody = await dependencies.source.open(capture);
      if (sourceBody === null) {
        const result = { ...base(operationId, captureId, capture.content_sha256, "FAILED"), failure_code: "SOURCE_UNAVAILABLE" } as RawMarkdownResult;
        return settleFailure(operationId, attemptId, result, contextSnapshot, capture);
      }
      const sourceBytes = await bufferBounded(sourceBody, MAX_SERVER_R2_BYTES);
      if (sourceBytes.byteLength !== capture.size_bytes || !SHA256.test(capture.content_sha256) || await digest(sourceBytes) !== capture.content_sha256) {
        const result = { ...base(operationId, captureId, capture.content_sha256, "FAILED"), failure_code: "SOURCE_INTEGRITY_MISMATCH" } as RawMarkdownResult;
        return settleFailure(operationId, attemptId, result, contextSnapshot, capture);
      }
      if (signalAborted(contextSnapshot)) return settleFailure(operationId, attemptId, { ...base(operationId, captureId, capture.content_sha256, "FAILED"), failure_code: "CANCELED" }, contextSnapshot, capture);
      await dependencies.source.assertCurrent(contextSnapshot, capture);
      if (signalAborted(contextSnapshot)) return settleFailure(operationId, attemptId, { ...base(operationId, captureId, capture.content_sha256, "FAILED"), failure_code: "CANCELED" }, contextSnapshot, capture);
      const sourceCopy = new Uint8Array(sourceBytes.byteLength);
      sourceCopy.set(sourceBytes);
      const converted = await dependencies.adapter.convert({
        name: capture.original_file_name,
        blob: new Blob([sourceCopy.buffer], { type: capture.content_type }),
        context: { operation_id: operationId, attempt_id: attemptId, input_sha256: capture.content_sha256, profile_generation: dependencies.profile_generation },
        bounds: { max_input_bytes: MARKDOWN_CONVERSION_MAX_BUFFERED_FILE_BYTES, max_output_bytes: requestSnapshot.max_output_bytes, max_tokens: requestSnapshot.max_tokens, timeout_ms: requestSnapshot.timeout_ms },
        ...(contextSnapshot.signal === undefined ? {} : { signal: contextSnapshot.signal }),
        ...(requestSnapshot.conversion_options === undefined ? {} : { conversion_options: requestSnapshot.conversion_options }),
      });
      if (converted.disposition !== "CONVERTED") {
        const state = converted.dispatch_state === "OUTCOME_UNKNOWN" ? "UNKNOWN" : "FAILED";
        const result = { ...base(operationId, captureId, capture.content_sha256, state), failure_code: state === "UNKNOWN" ? "PROVIDER_UNCERTAIN" : converted.code === "ABORTED" ? "CANCELED" : "PROVIDER_FAILED" } as RawMarkdownResult;
        return settleFailure(operationId, attemptId, result, contextSnapshot, capture);
      }
      if (signalAborted(contextSnapshot)) return { ...base(operationId, captureId, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" };
      await dependencies.source.assertCurrent(contextSnapshot, capture);
      if (signalAborted(contextSnapshot)) return { ...base(operationId, captureId, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" };
      const outputBytes = encoder.encode(converted.data);
      const output = await dependencies.output.putImmutable({ key: outputKey, body: body(outputBytes), expected_sha256: converted.data_sha256, expected_size_bytes: outputBytes.byteLength, content_type: "text/markdown; charset=utf-8", custom_metadata: { operation_id: operationId, capture_id: capture.capture_id } });
      if (output.readback_sha256 !== converted.data_sha256 || output.size_bytes !== outputBytes.byteLength) return { ...base(operationId, captureId, capture.content_sha256, "UNKNOWN"), failure_code: "OUTPUT_UNAVAILABLE" };
      if (signalAborted(contextSnapshot)) return { ...base(operationId, captureId, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" };
      await dependencies.source.assertCurrent(contextSnapshot, capture);
      if (signalAborted(contextSnapshot)) return { ...base(operationId, captureId, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" };
      const settled = await settle(operationId, attemptId, { ...base(operationId, captureId, capture.content_sha256, "COMPLETE"), output_sha256: converted.data_sha256, output_bytes: outputBytes.byteLength, detected_mime: converted.detected_mime, format: converted.format, tokens: converted.tokens }, receiptKey, contextSnapshot, capture);
      await dependencies.source.assertCurrent(contextSnapshot, capture);
      if (signalAborted(contextSnapshot)) return { ...base(operationId, captureId, capture.content_sha256, "UNKNOWN"), failure_code: "PROVIDER_UNCERTAIN" };
      return settled;
    },
  };
}

export { createWorkersAiMarkdownConversionAdapter };
