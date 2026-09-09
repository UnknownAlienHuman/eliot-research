import {
  MARKDOWN_CONVERSION_MAX_CONTEXT_BYTES,
  MARKDOWN_CONVERSION_MAX_ERROR_BYTES,
  MARKDOWN_CONVERSION_MAX_BUFFERED_FILE_BYTES,
  MARKDOWN_CONVERSION_MAX_MIME_BYTES,
  MARKDOWN_CONVERSION_MAX_NAME_BYTES,
  MARKDOWN_CONVERSION_MAX_RESULT_ID_BYTES,
  MARKDOWN_CONVERSION_MAX_TIMEOUT_MS,
  type MarkdownConversionAdapter,
  type MarkdownConversionBounds,
  type MarkdownConversionContext,
  type MarkdownConversionDispatchState,
  type MarkdownConversionFailure,
  type MarkdownConversionInput,
  type MarkdownConversionOptions,
  type MarkdownConversionObservation,
  type MarkdownConversionOutcome,
  type WorkersAiMarkdownBinding,
} from "./markdown-conversion-contract.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SAFE_BOUND = Number.MAX_SAFE_INTEGER;

interface ProviderSuccess {
  readonly id: string;
  readonly name: string;
  readonly format: "markdown" | "text";
  readonly mimetype: string;
  readonly tokens: number;
  readonly data: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!record(value)) return null;
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key)) ? value : null;
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= maxBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeBound(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

export function isValidMarkdownConversionOptions(value: unknown): value is MarkdownConversionOptions {
  if (value === undefined) return true;
  if (!record(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !["output", "image", "html", "pdf"].includes(key))) return false;
  const output = value.output;
  if (output !== undefined && (!record(output) || Object.keys(output).some((key) => key !== "format") ||
      (output.format !== undefined && output.format !== "markdown" && output.format !== "text"))) return false;
  const image = value.image;
  if (image !== undefined && (!record(image) || Object.keys(image).some((key) => key !== "descriptionLanguage") ||
      (image.descriptionLanguage !== undefined && !["en", "it", "de", "es", "fr", "pt"].includes(image.descriptionLanguage as string)))) return false;
  const html = value.html;
  if (html !== undefined && (!record(html) || Object.keys(html).some((key) => key !== "hostname" && key !== "cssSelector") ||
      (html.hostname !== undefined && !boundedText(html.hostname, 2_048)) ||
      (html.cssSelector !== undefined && !boundedText(html.cssSelector, 2_048)))) return false;
  const pdf = value.pdf;
  return pdf === undefined || (record(pdf) && Object.keys(pdf).every((key) => key === "metadata") &&
    (pdf.metadata === undefined || typeof pdf.metadata === "boolean"));
}

function validContext(context: unknown): context is MarkdownConversionContext {
  return record(context) && boundedText(context.operation_id, MARKDOWN_CONVERSION_MAX_CONTEXT_BYTES) &&
    boundedText(context.attempt_id, MARKDOWN_CONVERSION_MAX_CONTEXT_BYTES) &&
    typeof context.input_sha256 === "string" && SHA256.test(context.input_sha256) &&
    boundedText(context.profile_generation, MARKDOWN_CONVERSION_MAX_CONTEXT_BYTES);
}

function validBounds(value: unknown): value is MarkdownConversionBounds {
  return record(value) && safeBound(value.max_input_bytes, MARKDOWN_CONVERSION_MAX_BUFFERED_FILE_BYTES) &&
    safeBound(value.max_output_bytes, MAX_SAFE_BOUND) &&
    safeBound(value.max_tokens, MAX_SAFE_BOUND) &&
    safeBound(value.timeout_ms, MARKDOWN_CONVERSION_MAX_TIMEOUT_MS);
}

function snapshotContext(value: MarkdownConversionContext): MarkdownConversionContext {
  return Object.freeze({
    operation_id: value.operation_id,
    attempt_id: value.attempt_id,
    input_sha256: value.input_sha256,
    profile_generation: value.profile_generation,
  });
}

function snapshotBounds(value: MarkdownConversionBounds): MarkdownConversionBounds {
  return Object.freeze({
    max_input_bytes: value.max_input_bytes,
    max_output_bytes: value.max_output_bytes,
    max_tokens: value.max_tokens,
    timeout_ms: value.timeout_ms,
  });
}

function snapshotOptions(value: MarkdownConversionOptions | undefined): MarkdownConversionOptions | undefined {
  if (value === undefined) return undefined;
  const output = value.output === undefined ? undefined : Object.freeze({
    ...(value.output.format === undefined ? {} : { format: value.output.format }),
  });
  const image = value.image === undefined ? undefined : Object.freeze({
    ...(value.image.descriptionLanguage === undefined ? {} : { descriptionLanguage: value.image.descriptionLanguage }),
  });
  const html = value.html === undefined ? undefined : Object.freeze({
    ...(value.html.hostname === undefined ? {} : { hostname: value.html.hostname }),
    ...(value.html.cssSelector === undefined ? {} : { cssSelector: value.html.cssSelector }),
  });
  const pdf = value.pdf === undefined ? undefined : Object.freeze({
    ...(value.pdf.metadata === undefined ? {} : { metadata: value.pdf.metadata }),
  });
  return Object.freeze({
    ...(output === undefined ? {} : { output }),
    ...(image === undefined ? {} : { image }),
    ...(html === undefined ? {} : { html }),
    ...(pdf === undefined ? {} : { pdf }),
  });
}

function failure(
  code: MarkdownConversionFailureCode,
  context?: MarkdownConversionContext,
  dispatch_state: MarkdownConversionDispatchState = "NOT_STARTED",
): MarkdownConversionFailure {
  return context === undefined
    ? { disposition: "FAILED", code, dispatch_state }
    : { disposition: "FAILED", code, dispatch_state, context };
}

type MarkdownConversionFailureCode = MarkdownConversionFailure["code"];

function decodeProviderResult(raw: unknown, input: MarkdownConversionInput):
  | { readonly kind: "success"; readonly result: ProviderSuccess }
  | { readonly kind: "provider-error" }
  | { readonly kind: "invalid" }
  | { readonly kind: "empty" }
  | { readonly kind: "output-limit" }
  | { readonly kind: "token-limit" } {
  const result = exactRecord(raw, ["id", "name", "format", "mimetype", "tokens", "data"]);
  const errorResult = exactRecord(raw, ["id", "name", "format", "mimetype", "error"]);
  if (errorResult !== null && errorResult.format === "error") {
    if (!boundedText(errorResult.id, MARKDOWN_CONVERSION_MAX_RESULT_ID_BYTES) ||
        errorResult.name !== input.name || !boundedText(errorResult.mimetype, MARKDOWN_CONVERSION_MAX_MIME_BYTES) ||
        !boundedText(errorResult.error, MARKDOWN_CONVERSION_MAX_ERROR_BYTES)) return { kind: "invalid" };
    return { kind: "provider-error" };
  }
  if (result === null || (result.format !== "markdown" && result.format !== "text") ||
      !boundedText(result.id, MARKDOWN_CONVERSION_MAX_RESULT_ID_BYTES) || result.name !== input.name ||
      !boundedText(result.mimetype, MARKDOWN_CONVERSION_MAX_MIME_BYTES) ||
      typeof result.tokens !== "number" || !Number.isSafeInteger(result.tokens) || result.tokens < 0 ||
      typeof result.data !== "string") {
    return { kind: "invalid" };
  }
  if (result.tokens > input.bounds.max_tokens) return { kind: "token-limit" };
  const dataBytes = new TextEncoder().encode(result.data).byteLength;
  if (dataBytes === 0 || result.data.trim().length === 0) return { kind: "empty" };
  if (dataBytes > input.bounds.max_output_bytes) return { kind: "output-limit" };
  return {
    kind: "success",
    result: {
      id: result.id,
      name: result.name,
      format: result.format,
      mimetype: result.mimetype,
      tokens: result.tokens,
      data: result.data,
    },
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class TimeoutSignal extends Error {}
class AbortedSignal extends Error {}

async function awaitProvider(
  call: Promise<unknown>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutSignal()), timeoutMs);
  });
  const canceled = signal === undefined ? undefined : new Promise<never>((_, reject) => {
    abort = () => reject(new AbortedSignal());
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race(canceled === undefined ? [call, deadline] : [call, deadline, canceled]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined && signal !== undefined) signal.removeEventListener("abort", abort);
  }
}

export function createWorkersAiMarkdownConversionAdapter(ai: WorkersAiMarkdownBinding): MarkdownConversionAdapter {
  return {
    async convert(input): Promise<MarkdownConversionOutcome> {
      if (!record(input)) return failure("INPUT_INVALID");
      const candidate = input;
      if (!boundedText(candidate.name, MARKDOWN_CONVERSION_MAX_NAME_BYTES) ||
          !(candidate.blob instanceof Blob) || candidate.blob.size < 1 ||
          !validContext(candidate.context) || !validBounds(candidate.bounds) ||
          candidate.blob.size > candidate.bounds.max_input_bytes ||
          !isValidMarkdownConversionOptions(candidate.conversion_options)) {
        return failure("INPUT_INVALID");
      }
      const name = candidate.name;
      const blob = candidate.blob;
      const context = snapshotContext(candidate.context);
      const bounds = snapshotBounds(candidate.bounds);
      const conversion_options = snapshotOptions(candidate.conversion_options);
      const signal = candidate.signal as AbortSignal | undefined;
      if (signal?.aborted) return failure("ABORTED", context);
      let raw: unknown;
      let dispatched = false;
      try {
        // The pinned workers-types package still spells this result field `mimeType`;
        // current binding documentation specifies the wire field `mimetype`. Decode
        // the current documented shape at the untrusted provider boundary.
        dispatched = true;
        const call = conversion_options === undefined
          ? ai.toMarkdown({ name, blob })
          : ai.toMarkdown({ name, blob }, {
            conversionOptions: conversion_options,
          });
        raw = await awaitProvider(call, bounds.timeout_ms, signal);
      } catch (error) {
        const state = dispatched ? "OUTCOME_UNKNOWN" : "NOT_STARTED";
        if (error instanceof AbortedSignal) return failure("ABORTED", context, state);
        if (error instanceof TimeoutSignal) return failure("TIMEOUT", context, state);
        return failure("PROVIDER_UNAVAILABLE", context, state);
      }
      if (signal?.aborted) return failure("ABORTED", context, "RESPONSE_RECEIVED");
      const request: MarkdownConversionInput = signal === undefined
        ? (conversion_options === undefined
          ? { name, blob, context, bounds }
          : { name, blob, context, bounds, conversion_options })
        : (conversion_options === undefined
          ? { name, blob, context, bounds, signal }
          : { name, blob, context, bounds, conversion_options, signal });
      const decoded = decodeProviderResult(raw, request);
      if (decoded.kind === "provider-error") return failure("PROVIDER_ERROR", context, "RESPONSE_RECEIVED");
      if (decoded.kind === "invalid") return failure("RESPONSE_INVALID", context, "RESPONSE_RECEIVED");
      if (decoded.kind === "empty") return failure("EMPTY_OUTPUT", context, "RESPONSE_RECEIVED");
      if (decoded.kind === "output-limit") return failure("OUTPUT_LIMIT_EXCEEDED", context, "RESPONSE_RECEIVED");
      if (decoded.kind === "token-limit") return failure("TOKEN_LIMIT_EXCEEDED", context, "RESPONSE_RECEIVED");
      const dataBytes = new TextEncoder().encode(decoded.result.data).byteLength;
      const observation: MarkdownConversionObservation = {
        disposition: "CONVERTED",
        context,
        provider_result_id: decoded.result.id,
        name: decoded.result.name,
        detected_mime: decoded.result.mimetype,
        format: decoded.result.format,
        tokens: decoded.result.tokens,
        data: decoded.result.data,
        data_sha256: await sha256(decoded.result.data),
        data_bytes: dataBytes,
      };
      if (signal?.aborted) return failure("ABORTED", context, "RESPONSE_RECEIVED");
      return observation;
    },
  };
}

export { decodeProviderResult as decodeWorkersAiMarkdownResult };
