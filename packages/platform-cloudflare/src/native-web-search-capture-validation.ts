import {
  NATIVE_WEB_SEARCH_MAX_QUERY_CHARACTERS,
  NATIVE_WEB_SEARCH_MAX_RESULTS,
  NATIVE_WEB_SEARCH_MAX_WAIT_MS,
  type NativeWebSearchDiscovered,
  type NativeWebSearchProfile,
} from "./native-web-search.js";
import { RUNTIME_LIMITS } from "./runtime-limits.js";

const MAX_MARKDOWN_BYTES = RUNTIME_LIMITS.buffered_r2_bytes;
const MAX_CAPTURE_WAIT_MS = 60_000;
const MAX_URL_BYTES = 4_096;
const SEARCH_PROVIDERS = ["ceramic", "exa", "linkup"] as const;
const GATEWAY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BYOK_ALIAS = /^[A-Za-z0-9_-]{1,64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"] as const;

export interface NativeWebSearchCaptureSelection {
  /** Resolved only from server-owned profile state; no gateway/provider fallback is implied. */
  readonly search: NativeWebSearchProfile;
  readonly browser_markdown: {
    readonly timeout_ms: number;
    readonly max_markdown_bytes: number;
    readonly redirect_policy: "exact_url_only";
  };
}

export interface NativeWebSearchCaptureAttempt {
  readonly operation_id: string;
  readonly stage: "ACQUIRE_AND_CAPTURE";
  readonly attempt_ref: string;
  /** Digest of this immutable Workflow stage input manifest. */
  readonly input_sha256: string;
}

export interface NativeWebSearchMarkdownCaptureInput {
  readonly attempt: NativeWebSearchCaptureAttempt;
  readonly discovery: NativeWebSearchDiscovered;
  readonly locator_index: number;
  readonly signal?: AbortSignal;
}

export interface ValidAttempt extends NativeWebSearchCaptureAttempt {
  readonly locator_index: number;
  readonly requested_url: string;
  readonly request_url: string;
}

export interface NativeWebSearchCaptureValidation {
  readonly selection: NativeWebSearchCaptureSelection;
  validateInput(input: NativeWebSearchMarkdownCaptureInput): ValidAttempt | null;
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function onlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function validSelection(selection: NativeWebSearchCaptureSelection): void {
  if (!record(selection) || !onlyFields(selection, ["search", "browser_markdown"]) ||
      !record(selection.search) || !onlyFields(selection.search, ["gateway_id", "provider", "byok_alias", "timeout_ms"]) ||
      !record(selection.browser_markdown) || !onlyFields(selection.browser_markdown, ["timeout_ms", "max_markdown_bytes", "redirect_policy"])) {
    throw new RangeError("native web capture selection contains an unknown or missing object");
  }
  const search = selection.search;
  const capture = selection.browser_markdown;
  if (typeof search.gateway_id !== "string" || !GATEWAY_ID.test(search.gateway_id) ||
      !(SEARCH_PROVIDERS as readonly string[]).includes(search.provider) ||
      (search.byok_alias !== undefined && (typeof search.byok_alias !== "string" || !BYOK_ALIAS.test(search.byok_alias))) ||
      !Number.isSafeInteger(search.timeout_ms) || search.timeout_ms < 1 || search.timeout_ms > NATIVE_WEB_SEARCH_MAX_WAIT_MS) {
    throw new RangeError("native web search profile is incomplete or invalid");
  }
  if (!Number.isSafeInteger(capture.timeout_ms) || capture.timeout_ms < 1 || capture.timeout_ms > MAX_CAPTURE_WAIT_MS ||
      !Number.isSafeInteger(capture.max_markdown_bytes) || capture.max_markdown_bytes < 1 || capture.max_markdown_bytes > MAX_MARKDOWN_BYTES ||
      capture.redirect_policy !== "exact_url_only") {
    throw new RangeError("native Browser Run Markdown profile is incomplete or invalid");
  }
}

function validAttempt(input: NativeWebSearchMarkdownCaptureInput): ValidAttempt | null {
  const attempt = input.attempt;
  if (!record(attempt) || !OPERATION_ID.test(attempt.operation_id) ||
      attempt.stage !== "ACQUIRE_AND_CAPTURE" || typeof attempt.attempt_ref !== "string" ||
      attempt.attempt_ref.length < 1 || attempt.attempt_ref.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(attempt.attempt_ref) || !isSha256Digest(attempt.input_sha256) ||
      !Number.isSafeInteger(input.locator_index) || input.locator_index < 0 || input.locator_index >= NATIVE_WEB_SEARCH_MAX_RESULTS) return null;
  const discovery = input.discovery;
  if (!record(discovery) || !onlyFields(discovery, [
    "protocol", "disposition", "selected_gateway_id", "selected_provider", "requested_query",
    "requested_limit", "dispatch_state", "paid_effect", "locators", "omissions", "provider_metadata",
  ]) || discovery.protocol !== "eliotr.native-web-search.v1" || discovery.disposition !== "DISCOVERED" ||
      discovery.dispatch_state !== "RESPONSE_RECEIVED" || discovery.paid_effect !== "UNKNOWN" ||
      !Array.isArray(discovery.locators) || input.locator_index >= discovery.locators.length ||
      !Array.isArray(discovery.omissions) ||
      discovery.locators.length > discovery.requested_limit ||
      typeof discovery.requested_query !== "string" || discovery.requested_query.trim().length === 0 ||
      [...discovery.requested_query].length > NATIVE_WEB_SEARCH_MAX_QUERY_CHARACTERS ||
      !Number.isSafeInteger(discovery.requested_limit) || discovery.requested_limit < 1 ||
      discovery.requested_limit > NATIVE_WEB_SEARCH_MAX_RESULTS) return null;
  const locator = discovery.locators[input.locator_index];
  if (!record(locator) || !onlyFields(locator, ["url", "title", "description", "last_modified_date", "image_url", "favicon_url"]) ||
      typeof locator.url !== "string" || locator.url.length === 0 ||
      new TextEncoder().encode(locator.url).byteLength > MAX_URL_BYTES || locator.url !== locator.url.trim()) return null;
  let url: URL;
  try { url = new URL(locator.url); } catch { return null; }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0 ||
      url.port.length > 0 || hostname.length === 0 || !hostname.includes(".") || hostname.endsWith(".") ||
      hostname.includes(":") || /^\d+(?:\.\d+){0,3}$/u.test(hostname) ||
      !/^[a-z0-9.-]+$/u.test(hostname) || hostname.startsWith(".") || hostname.includes("..") ||
      LOCAL_HOST_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix)) ||
      ["localhost", "invalid", "test", "example"].includes(hostname.split(".").at(-1) ?? "")) return null;
  const requestUrl = new URL(url.href);
  requestUrl.hash = "";
  return {
    ...attempt,
    locator_index: input.locator_index,
    requested_url: locator.url,
    request_url: requestUrl.href,
  };
}

export function isSha256Digest(value: string): boolean {
  return SHA256.test(value);
}

/**
 * Validates and freezes the server-owned selection once, then provides the single
 * pure validator used by both fresh capture and exact-attempt recovery.
 */
export function createNativeWebSearchCaptureValidation(
  selectionInput: NativeWebSearchCaptureSelection,
): NativeWebSearchCaptureValidation {
  validSelection(selectionInput);
  const selection = Object.freeze({
    search: Object.freeze({ ...selectionInput.search }),
    browser_markdown: Object.freeze({ ...selectionInput.browser_markdown }),
  });

  function validateInput(input: NativeWebSearchMarkdownCaptureInput): ValidAttempt | null {
    if (!record(input) || !record(input.discovery) ||
        input.discovery.selected_gateway_id !== selection.search.gateway_id ||
        input.discovery.selected_provider !== selection.search.provider) return null;
    return validAttempt(input);
  }

  return Object.freeze({ selection, validateInput });
}
