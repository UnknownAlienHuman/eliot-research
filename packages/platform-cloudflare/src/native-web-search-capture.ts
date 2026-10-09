import type { NativeWebSearchDiscovered, NativeWebSearchProfile } from "./native-web-search.js";
import { sha256Utf8 } from "./r2.js";
import {
  createNativeWebSearchCaptureValidation,
  isSha256Digest,
  onlyFields,
  record,
  type NativeWebSearchCaptureAttempt,
  type NativeWebSearchCaptureSelection,
  type NativeWebSearchMarkdownCaptureInput,
  type ValidAttempt,
} from "./native-web-search-capture-validation.js";
import {
  RUNTIME_LIMITS,
  RuntimeLimitError,
  readResponseBodyWithinBytes,
} from "./runtime-limits.js";
import {
  cancelQuietly,
  createRuntimeDeadline,
  waitForRuntimeDeadline,
  type RuntimeDeadline as Deadline,
  type RuntimeDeadlineFailureCode as DeadlineFailureCode,
} from "./runtime-async.js";

export type {
  NativeWebSearchCaptureAttempt,
  NativeWebSearchCaptureSelection,
  NativeWebSearchMarkdownCaptureInput,
} from "./native-web-search-capture-validation.js";

export const NATIVE_WEB_SEARCH_CAPTURE_PROTOCOL = "eliotr.native-web-search-capture.v1" as const;
export const NATIVE_WEB_SEARCH_CAPTURE_CONTENT_TYPE = "text/markdown; charset=utf-8" as const;

const RESPONSE_MAX_BYTES = RUNTIME_LIMITS.buffered_r2_bytes;
const CAPTURE_ID = /^raw-capture-[a-f0-9]{48}$/u;
const CAPTURE_IDEMPOTENCY_KEY = /^native-web-search-capture-[a-f0-9]{64}$/u;
const FILENAME = /^web-candidate-[0-9]{1,2}\.md$/u;

/** Sanitized result returned by the existing raw-capture owner API. */
export interface NativeWebSearchRawCaptureReceipt {
  readonly protocol: "eliotr.raw-file-capture.v1";
  readonly disposition: "CAPTURED";
  readonly capture_id: string;
  readonly idempotency_key: string;
  readonly original_file_name: string;
  readonly content_sha256: string;
  readonly size_bytes: number;
  readonly content_type: string;
  readonly captured_at: string;
}

export interface NativeWebSearchRawCaptureRequest {
  readonly idempotency_key: string;
  readonly original_file_name: string;
  readonly content_sha256: string;
  readonly size_bytes: number;
  readonly content_type: typeof NATIVE_WEB_SEARCH_CAPTURE_CONTENT_TYPE;
  readonly body: ReadableStream<Uint8Array>;
}

/**
 * Capability supplied by the application owner. Its closures must call the existing
 * createRawCaptureService with a genuine, current owner authority; this adapter never
 * manufactures AuthenticatedRequestContext or source/residency identities.
 */
export interface NativeWebSearchRawCaptureOwnerPort {
  captureRawFile(request: NativeWebSearchRawCaptureRequest): Promise<NativeWebSearchRawCaptureReceipt>;
  readRawFileByIdempotency(idempotencyKey: string): Promise<NativeWebSearchRawCaptureReceipt | null>;
}

export type NativeWebSearchCaptureFailureCode =
  | "INPUT_INVALID"
  | "UNSUPPORTED_RUNTIME"
  | "CAPTURE_OWNER_UNAVAILABLE"
  | "OWNER_READBACK_UNAVAILABLE"
  | "CAPTURE_IDEMPOTENCY_CONFLICT"
  | "ABORTED"
  | "TIMEOUT"
  | "DISPATCH_OUTCOME_UNKNOWN"
  | "HTTP_FAILURE"
  | "PAGE_STATUS_FAILURE"
  | "RESPONSE_INVALID"
  | "RESPONSE_TOO_LARGE"
  | "REDIRECT_NOT_ALLOWED"
  | "EMPTY_MARKDOWN"
  | "MARKDOWN_TOO_LARGE"
  | "CAPTURE_UNCERTAIN"
  | "CAPTURE_READBACK_UNAVAILABLE"
  | "CAPTURE_READBACK_MISMATCH";

export interface NativeWebSearchRawCaptureSuccess {
  readonly protocol: typeof NATIVE_WEB_SEARCH_CAPTURE_PROTOCOL;
  readonly disposition: "CAPTURED";
  readonly operation_id: string;
  readonly stage: "ACQUIRE_AND_CAPTURE";
  readonly attempt_ref: string;
  readonly input_sha256: string;
  readonly selected_gateway_id: string;
  readonly selected_provider: NativeWebSearchProfile["provider"];
  readonly locator_index: number;
  readonly requested_url: string;
  readonly final_url: string;
  readonly browser_dispatch_state: "OUTCOME_UNKNOWN" | "RESPONSE_RECEIVED";
  /** Browser Run billing is not exposed as a settled amount. */
  readonly paid_effect: "UNKNOWN";
  readonly capture: NativeWebSearchRawCaptureReceipt;
}

export interface NativeWebSearchRawCaptureFailure {
  readonly protocol: typeof NATIVE_WEB_SEARCH_CAPTURE_PROTOCOL;
  readonly disposition: "FAILED" | "UNKNOWN";
  readonly code: NativeWebSearchCaptureFailureCode;
  readonly operation_id?: string;
  readonly stage?: "ACQUIRE_AND_CAPTURE";
  readonly attempt_ref?: string;
  readonly input_sha256?: string;
  readonly selected_gateway_id: string;
  readonly selected_provider: NativeWebSearchProfile["provider"];
  readonly locator_index?: number;
  readonly browser_dispatch_state: "NOT_STARTED" | "OUTCOME_UNKNOWN" | "RESPONSE_RECEIVED";
  readonly paid_effect: "NONE" | "UNKNOWN";
}

export type NativeWebSearchRawCaptureOutcome =
  | NativeWebSearchRawCaptureSuccess
  | NativeWebSearchRawCaptureFailure;

interface CaptureReceiptExpectation {
  readonly idempotency_key: string;
  readonly original_file_name: string;
  readonly content_sha256?: string;
  readonly size_bytes?: number;
}

class DeadlineFailure extends Error {
  public constructor(public readonly code: DeadlineFailureCode) {
    super(code);
    this.name = "DeadlineFailure";
  }
}

function waitForDeadline<T>(promise: Promise<T>, deadline: Deadline): Promise<T> {
  return waitForRuntimeDeadline(promise, deadline, (code) => new DeadlineFailure(code));
}

function safeFailure(
  selection: NativeWebSearchCaptureSelection,
  code: NativeWebSearchCaptureFailureCode,
  dispatchState: NativeWebSearchRawCaptureFailure["browser_dispatch_state"],
  disposition: NativeWebSearchRawCaptureFailure["disposition"] = "FAILED",
  attempt?: NativeWebSearchCaptureAttempt,
  locatorIndex?: number,
): NativeWebSearchRawCaptureFailure {
  return {
    protocol: NATIVE_WEB_SEARCH_CAPTURE_PROTOCOL,
    disposition,
    code,
    selected_gateway_id: selection.search.gateway_id,
    selected_provider: selection.search.provider,
    browser_dispatch_state: dispatchState,
    paid_effect: dispatchState === "NOT_STARTED" ? "NONE" : "UNKNOWN",
    ...(attempt === undefined ? {} : {
      operation_id: attempt.operation_id,
      stage: attempt.stage,
      attempt_ref: attempt.attempt_ref,
      input_sha256: attempt.input_sha256,
    }),
    ...(locatorIndex === undefined ? {} : { locator_index: locatorIndex }),
  };
}

async function captureIdempotencyKey(
  selection: NativeWebSearchCaptureSelection,
  attempt: ValidAttempt,
  discovery: NativeWebSearchDiscovered,
): Promise<string> {
  const canonicalIdentity = JSON.stringify([
    NATIVE_WEB_SEARCH_CAPTURE_PROTOCOL,
    attempt.operation_id,
    attempt.stage,
    attempt.attempt_ref,
    attempt.input_sha256,
    selection.search.gateway_id,
    selection.search.provider,
    selection.search.byok_alias ?? null,
    discovery.requested_query,
    discovery.requested_limit,
    attempt.locator_index,
    attempt.requested_url,
  ]);
  return `native-web-search-capture-${await sha256Utf8(canonicalIdentity)}`;
}

function expectedCapture(
  idempotencyKey: string,
  locatorIndex: number,
  contentSha256?: string,
  sizeBytes?: number,
): CaptureReceiptExpectation {
  return {
    idempotency_key: idempotencyKey,
    original_file_name: `web-candidate-${locatorIndex}.md`,
    ...(contentSha256 === undefined ? {} : { content_sha256: contentSha256 }),
    ...(sizeBytes === undefined ? {} : { size_bytes: sizeBytes }),
  };
}

function validReceipt(value: unknown, expectation: CaptureReceiptExpectation): value is NativeWebSearchRawCaptureReceipt {
  if (!record(value) || !onlyFields(value, [
    "protocol", "disposition", "capture_id", "idempotency_key", "original_file_name",
    "content_sha256", "size_bytes", "content_type", "captured_at",
  ])) return false;
  return value.protocol === "eliotr.raw-file-capture.v1" && value.disposition === "CAPTURED" &&
    typeof value.capture_id === "string" && CAPTURE_ID.test(value.capture_id) &&
    typeof value.idempotency_key === "string" && CAPTURE_IDEMPOTENCY_KEY.test(value.idempotency_key) &&
    value.idempotency_key === expectation.idempotency_key &&
    typeof value.original_file_name === "string" && FILENAME.test(value.original_file_name) &&
    value.original_file_name === expectation.original_file_name &&
    typeof value.content_sha256 === "string" && isSha256Digest(value.content_sha256) &&
    (expectation.content_sha256 === undefined || value.content_sha256 === expectation.content_sha256) &&
    typeof value.size_bytes === "number" && Number.isSafeInteger(value.size_bytes) && value.size_bytes > 0 &&
    (expectation.size_bytes === undefined || value.size_bytes === expectation.size_bytes) &&
    value.content_type === NATIVE_WEB_SEARCH_CAPTURE_CONTENT_TYPE &&
    typeof value.captured_at === "string" && Number.isFinite(Date.parse(value.captured_at));
}

function sameReceipt(left: NativeWebSearchRawCaptureReceipt, right: NativeWebSearchRawCaptureReceipt): boolean {
  return left.protocol === right.protocol && left.disposition === right.disposition &&
    left.capture_id === right.capture_id && left.idempotency_key === right.idempotency_key &&
    left.original_file_name === right.original_file_name && left.content_sha256 === right.content_sha256 &&
    left.size_bytes === right.size_bytes && left.content_type === right.content_type &&
    left.captured_at === right.captured_at;
}

function exactRequestPattern(requestUrl: string): string {
  return `^${requestUrl.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`;
}

interface BrowserMarkdownObservation {
  readonly markdown: string;
  readonly final_url: string;
  readonly page_status: number;
}

function decodeBrowserMarkdown(value: unknown, requestUrl: string):
  | { readonly kind: "valid"; readonly observation: BrowserMarkdownObservation }
  | { readonly kind: "redirect" }
  | { readonly kind: "invalid" } {
  if (!record(value) || !onlyFields(value, ["success", "result", "meta"]) || value.success !== true ||
      typeof value.result !== "string" || !record(value.meta) ||
      !onlyFields(value.meta, ["status", "title", "headers", "finalUrl", "redirectChain"]) ||
      !Number.isSafeInteger(value.meta.status) || typeof value.meta.title !== "string") return { kind: "invalid" };
  if (value.meta.headers !== undefined && (!record(value.meta.headers) ||
      Object.entries(value.meta.headers).some(([key, header]) => key.length === 0 || typeof header !== "string"))) return { kind: "invalid" };
  if (value.meta.redirectChain !== undefined) {
    if (!Array.isArray(value.meta.redirectChain)) return { kind: "invalid" };
    // Browser Run documents an empty array as a redirect whose intermediate
    // responses could not be read; direct navigation omits the field.
    return { kind: "redirect" };
  }
  if (typeof value.meta.finalUrl !== "string") return { kind: "invalid" };
  let finalUrl: URL;
  try { finalUrl = new URL(value.meta.finalUrl); } catch { return { kind: "invalid" }; }
  if (finalUrl.username.length > 0 || finalUrl.password.length > 0 || finalUrl.protocol !== "https:") return { kind: "redirect" };
  finalUrl.hash = "";
  if (finalUrl.href !== requestUrl) return { kind: "redirect" };
  return {
    kind: "valid",
    observation: { markdown: value.result, final_url: finalUrl.href, page_status: value.meta.status as number },
  };
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new ReadableStream({ start(controller) { controller.enqueue(copy); controller.close(); } });
}

export function createNativeWebSearchMarkdownCaptureAdapter(dependencies: {
  readonly browser: Pick<BrowserRun, "quickAction"> | undefined;
  /** Bound by the application to the real owner capture/readback authority. */
  readonly owner: NativeWebSearchRawCaptureOwnerPort | undefined;
  readonly selection: NativeWebSearchCaptureSelection;
}) {
  const validation = createNativeWebSearchCaptureValidation(dependencies.selection);
  const selection = validation.selection;

  function success(
    attempt: ValidAttempt,
    discovery: NativeWebSearchDiscovered,
    receipt: NativeWebSearchRawCaptureReceipt,
    dispatchState: NativeWebSearchRawCaptureSuccess["browser_dispatch_state"],
  ): NativeWebSearchRawCaptureSuccess {
    return {
      protocol: NATIVE_WEB_SEARCH_CAPTURE_PROTOCOL,
      disposition: "CAPTURED",
      operation_id: attempt.operation_id,
      stage: attempt.stage,
      attempt_ref: attempt.attempt_ref,
      input_sha256: attempt.input_sha256,
      selected_gateway_id: discovery.selected_gateway_id,
      selected_provider: discovery.selected_provider,
      locator_index: attempt.locator_index,
      requested_url: attempt.requested_url,
      final_url: attempt.request_url,
      browser_dispatch_state: dispatchState,
      paid_effect: "UNKNOWN",
      capture: receipt,
    };
  }

  async function readExisting(
    attempt: ValidAttempt,
    discovery: NativeWebSearchDiscovered,
    key: string,
  ): Promise<NativeWebSearchRawCaptureOutcome | null> {
    const owner = dependencies.owner;
    if (owner === undefined) return safeFailure(selection, "CAPTURE_OWNER_UNAVAILABLE", "NOT_STARTED", "FAILED", attempt, attempt.locator_index);
    let value: NativeWebSearchRawCaptureReceipt | null;
    try { value = await owner.readRawFileByIdempotency(key); }
    catch {
      return safeFailure(selection, "OWNER_READBACK_UNAVAILABLE", "OUTCOME_UNKNOWN", "UNKNOWN", attempt, attempt.locator_index);
    }
    if (value === null) return null;
    const expectation = expectedCapture(key, attempt.locator_index);
    if (!validReceipt(value, expectation)) {
      return safeFailure(selection, "CAPTURE_IDEMPOTENCY_CONFLICT", "OUTCOME_UNKNOWN", "UNKNOWN", attempt, attempt.locator_index);
    }
    return success(attempt, discovery, value, "OUTCOME_UNKNOWN");
  }

  /**
   * Read-only recovery for a previously started Workflow attempt. The caller must
   * retain the exact discovery result and locator index; this path never repeats
   * Web Search or Browser Run and returns UNKNOWN when the capture is unreadable.
   */
  async function recoverStartedAttempt(
    input: NativeWebSearchMarkdownCaptureInput,
  ): Promise<NativeWebSearchRawCaptureOutcome> {
    const attempt = validation.validateInput(input);
    if (attempt === null) return safeFailure(selection, "INPUT_INVALID", "OUTCOME_UNKNOWN", "UNKNOWN");
    if (dependencies.owner === undefined) {
      return safeFailure(selection, "CAPTURE_OWNER_UNAVAILABLE", "OUTCOME_UNKNOWN", "UNKNOWN", attempt, attempt.locator_index);
    }
    const key = await captureIdempotencyKey(selection, attempt, input.discovery);
    const read = await readExisting(attempt, input.discovery, key);
    return read ?? safeFailure(selection, "CAPTURE_READBACK_UNAVAILABLE", "OUTCOME_UNKNOWN", "UNKNOWN", attempt, attempt.locator_index);
  }

  /**
   * Starts Browser Run for a freshly persisted attempt only. Once dispatch may
   * have begun, retries must use recoverStartedAttempt because Browser Run has
   * no idempotency key and its paid effect cannot be proven absent.
   */
  async function capture(input: NativeWebSearchMarkdownCaptureInput): Promise<NativeWebSearchRawCaptureOutcome> {
    const attempt = validation.validateInput(input);
    if (attempt === null) return safeFailure(selection, "INPUT_INVALID", "NOT_STARTED");
    if (input.signal?.aborted) return safeFailure(selection, "ABORTED", "NOT_STARTED", "FAILED", attempt, attempt.locator_index);
    const owner = dependencies.owner;
    if (owner === undefined) return safeFailure(selection, "CAPTURE_OWNER_UNAVAILABLE", "NOT_STARTED", "FAILED", attempt, attempt.locator_index);

    const key = await captureIdempotencyKey(selection, attempt, input.discovery);
    const prior = await readExisting(attempt, input.discovery, key);
    if (prior !== null) return prior;
    const browser = dependencies.browser;
    if (browser === undefined || typeof browser.quickAction !== "function") {
      return safeFailure(selection, "UNSUPPORTED_RUNTIME", "NOT_STARTED", "FAILED", attempt, attempt.locator_index);
    }

    const deadline = createRuntimeDeadline(input.signal, selection.browser_markdown.timeout_ms);
    if (deadline.signal.aborted) {
      const code = deadline.failureCode() ?? "ABORTED";
      deadline.dispose();
      return safeFailure(selection, code, "NOT_STARTED", "FAILED", attempt, attempt.locator_index);
    }
    let response: Response;
    try {
      const dispatch = Promise.resolve().then(() => browser.quickAction("markdown", {
        url: attempt.request_url,
        allowRequestPattern: [exactRequestPattern(attempt.request_url)],
        allowResourceTypes: ["document"],
        setJavaScriptEnabled: false,
        cacheTTL: 0,
        gotoOptions: { timeout: selection.browser_markdown.timeout_ms, waitUntil: "domcontentloaded" },
        actionTimeout: selection.browser_markdown.timeout_ms,
      }));
      const lateAware = dispatch.then((value) => {
        if (deadline.signal.aborted) cancelQuietly(value.body);
        return value;
      });
      response = await waitForDeadline(lateAware, deadline);
    } catch (error) {
      const code = error instanceof DeadlineFailure ? error.code : "DISPATCH_OUTCOME_UNKNOWN";
      deadline.dispose();
      const read = await readExisting(attempt, input.discovery, key);
      return read ?? safeFailure(selection, code, "OUTCOME_UNKNOWN", "UNKNOWN", attempt, attempt.locator_index);
    }

    if (!response.ok) {
      cancelQuietly(response.body);
      deadline.dispose();
      return safeFailure(selection, "HTTP_FAILURE", "RESPONSE_RECEIVED", "FAILED", attempt, attempt.locator_index);
    }
    const contentType = response.headers.get("content-type");
    if (contentType === null || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      cancelQuietly(response.body);
      deadline.dispose();
      return safeFailure(selection, "RESPONSE_INVALID", "RESPONSE_RECEIVED", "FAILED", attempt, attempt.locator_index);
    }

    let responseBytes: Uint8Array;
    try {
      responseBytes = await waitForDeadline(readResponseBodyWithinBytes(response, {
        label: "native Browser Run Markdown response",
        max_bytes: RESPONSE_MAX_BYTES,
      }), deadline);
    } catch (error) {
      cancelQuietly(response.body);
      const deadlineCode = deadline.failureCode();
      const code = deadlineCode ?? (error instanceof RuntimeLimitError &&
        (error.code === "LIMIT_EXCEEDED" || error.code === "STREAM_CHUNK_LIMIT_EXCEEDED")
        ? "RESPONSE_TOO_LARGE" : "RESPONSE_INVALID");
      return safeFailure(selection, code, "RESPONSE_RECEIVED", "FAILED", attempt, attempt.locator_index);
    } finally {
      deadline.dispose();
    }

    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes)) as unknown; }
    catch { return safeFailure(selection, "RESPONSE_INVALID", "RESPONSE_RECEIVED", "FAILED", attempt, attempt.locator_index); }
    const decoded = decodeBrowserMarkdown(body, attempt.request_url);
    if (decoded.kind === "redirect") {
      return safeFailure(selection, "REDIRECT_NOT_ALLOWED", "RESPONSE_RECEIVED", "FAILED", attempt, attempt.locator_index);
    }
    if (decoded.kind === "invalid") {
      return safeFailure(selection, "RESPONSE_INVALID", "RESPONSE_RECEIVED", "FAILED", attempt, attempt.locator_index);
    }
    if (decoded.observation.page_status !== 200) {
      return safeFailure(selection, "PAGE_STATUS_FAILURE", "RESPONSE_RECEIVED", "FAILED", attempt, attempt.locator_index);
    }
    if (decoded.observation.markdown.trim().length === 0) {
      return safeFailure(selection, "EMPTY_MARKDOWN", "RESPONSE_RECEIVED", "FAILED", attempt, attempt.locator_index);
    }
    const encoder = new TextEncoder();
    const markdownBytes = encoder.encode(decoded.observation.markdown);
    try {
      if (new TextDecoder("utf-8", { fatal: true }).decode(markdownBytes) !== decoded.observation.markdown) {
        return safeFailure(selection, "RESPONSE_INVALID", "RESPONSE_RECEIVED", "FAILED", attempt, attempt.locator_index);
      }
    } catch {
      return safeFailure(selection, "RESPONSE_INVALID", "RESPONSE_RECEIVED", "FAILED", attempt, attempt.locator_index);
    }
    if (markdownBytes.byteLength > selection.browser_markdown.max_markdown_bytes) {
      return safeFailure(selection, "MARKDOWN_TOO_LARGE", "RESPONSE_RECEIVED", "FAILED", attempt, attempt.locator_index);
    }
    const markdownSha256 = await sha256Utf8(decoded.observation.markdown);
    const expectation = expectedCapture(key, attempt.locator_index, markdownSha256, markdownBytes.byteLength);
    const request: NativeWebSearchRawCaptureRequest = {
      idempotency_key: key,
      original_file_name: expectation.original_file_name,
      content_sha256: markdownSha256,
      size_bytes: markdownBytes.byteLength,
      content_type: NATIVE_WEB_SEARCH_CAPTURE_CONTENT_TYPE,
      body: bytesStream(markdownBytes),
    };

    let written: NativeWebSearchRawCaptureReceipt | undefined;
    try { written = await owner.captureRawFile(request); } catch { /* Reconcile by exact key below. */ }
    let readback: NativeWebSearchRawCaptureReceipt | null;
    try { readback = await owner.readRawFileByIdempotency(key); }
    catch {
      return safeFailure(selection, "CAPTURE_READBACK_UNAVAILABLE", "RESPONSE_RECEIVED", "UNKNOWN", attempt, attempt.locator_index);
    }
    if (readback === null) {
      return safeFailure(selection, "CAPTURE_UNCERTAIN", "RESPONSE_RECEIVED", "UNKNOWN", attempt, attempt.locator_index);
    }
    if (!validReceipt(readback, expectation) ||
        (written !== undefined && (!validReceipt(written, expectation) || !sameReceipt(written, readback)))) {
      return safeFailure(selection, "CAPTURE_READBACK_MISMATCH", "RESPONSE_RECEIVED", "UNKNOWN", attempt, attempt.locator_index);
    }
    return success(attempt, input.discovery, readback, "RESPONSE_RECEIVED");
  }

  return Object.freeze({ capture, recoverStartedAttempt });
}
