import { IsoDateTimeSchema } from "@eliotr/contracts";

/** Bounded one-attempt Google REST transport. No token vault, retry loop or canonical authority. */
export interface GoogleAccessLease {
  readonly connection_id: string;
  readonly exchange_generation_id: string;
  readonly access_token: string;
  readonly expires_at_epoch_ms: number;
  /** Trusted, read-only connection/generation check; must reject revoked or superseded leases. */
  assertCurrent(signal: AbortSignal): Promise<void>;
}

export interface GoogleRestOptions {
  readonly connectionId: string;
  readonly generationId: string;
  readonly operationRef: string;
  readonly deadlineEpochMs: number;
  readonly maxRequests: number;
  readonly signal?: AbortSignal;
  /** Only an admitted dedicated-account OAuth provider may supply this trusted port. */
  authorize(signal: AbortSignal): Promise<GoogleAccessLease>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export class GoogleRestError extends Error {
  public readonly code: string;
  /** NO_WRITE includes reads and rejection before dispatch; UNKNOWN forbids blind mutation retry. */
  public readonly writeOutcome: "NO_WRITE" | "REJECTED" | "UNKNOWN";
  public readonly httpStatus: number | undefined;
  public constructor(code: string, writeOutcome: GoogleRestError["writeOutcome"] = "NO_WRITE", httpStatus?: number) {
    super(code); this.name = "GoogleRestError"; this.code = code;
    this.writeOutcome = writeOutcome; this.httpStatus = httpStatus;
  }
}

export function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("GOOGLE_RESPONSE_INVALID");
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("GOOGLE_RESPONSE_INVALID");
  }
  return record;
}

export function boundedString(value: unknown, maximum = 1024): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !value.isWellFormed()
      || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("GOOGLE_RESPONSE_INVALID");
  return value;
}

export function googleFileId(value: unknown): string {
  const id = boundedString(value, 256);
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) throw new Error("GOOGLE_RESOURCE_ID_INVALID");
  return id;
}

export function googleTimestamp(value: unknown): string {
  const text = boundedString(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)
      || !Number.isFinite(Date.parse(text)) || !IsoDateTimeSchema.safeParse(text).success) throw new Error("GOOGLE_RESPONSE_INVALID");
  return text;
}

const MAX_BYTES = 1024 * 1024;
const REQUEST_MS = 15000;
const encoder = new TextEncoder();

export function createGoogleJsonTransport(options: GoogleRestOptions) {
  const { connectionId, generationId, operationRef, deadlineEpochMs, maxRequests, signal: outerSignal,
    authorize, fetchImpl = fetch, now = Date.now } = options;
  boundedString(connectionId, 256); boundedString(generationId, 256); boundedString(operationRef, 256);
  if (!Number.isSafeInteger(deadlineEpochMs) || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 64) {
    throw new GoogleRestError("GOOGLE_CONTEXT_INVALID");
  }
  let attempts = 0;
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new GoogleRestError("GOOGLE_CLOCK_INVALID");
    return value;
  };
  return async function request<T>(url: URL, body: unknown | undefined, writes: boolean, decode: (value: unknown) => T): Promise<T> {
    // No caller-selected endpoint, redirect, ambient cookies or credential-bearing query parameters.
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
        !((url.hostname === "www.googleapis.com" && /^\/drive\/v3\/(?:changes(?:\/startPageToken)?|files(?:\/[A-Za-z0-9_-]+)?)$/u.test(url.pathname)) ||
          (url.hostname === "sheets.googleapis.com" && /^\/v4\/spreadsheets(?:\/[A-Za-z0-9_-]+(?::batchUpdate|\/values:batchGetByDataFilter)?)?$/u.test(url.pathname)))) {
      throw new GoogleRestError("GOOGLE_ENDPOINT_REJECTED");
    }
    const queryKeys = new Set(["fields", "pageToken", "pageSize", "spaces", "includeRemoved", "includeItemsFromAllDrives", "restrictToMyDrive", "q", "orderBy", "addParents", "removeParents"]);
    if ([...url.searchParams.keys()].some((key) => !queryKeys.has(key) || url.searchParams.getAll(key).length !== 1)) {
      throw new GoogleRestError("GOOGLE_ENDPOINT_REJECTED");
    }
    const isBatchUpdate = url.pathname.endsWith(":batchUpdate");
    const isBatchRead = url.pathname.endsWith("/values:batchGetByDataFilter");
    const isDriveFilesCollection = url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files";
    const isSheetsCollection = url.hostname === "sheets.googleapis.com" && url.pathname === "/v4/spreadsheets";
    const isCreate = isDriveFilesCollection || isSheetsCollection;
    const isFilePatch = url.hostname === "www.googleapis.com" && /^\/drive\/v3\/files\/[A-Za-z0-9_-]+$/u.test(url.pathname);
    const writeEndpoint = isBatchUpdate || (isCreate && body !== undefined) || (isFilePatch && writes);
    if (writes !== writeEndpoint || (writes && body === undefined) || (!writes && body !== undefined && !isBatchRead)) throw new GoogleRestError("GOOGLE_METHOD_REJECTED");
    if (writes && !isBatchUpdate && !isCreate && !isFilePatch) throw new GoogleRestError("GOOGLE_METHOD_REJECTED");
    const requestUrl = url.href; // Capture the validated target before authorization yields.
    let encoded: string | undefined;
    try {
      encoded = body === undefined ? undefined : JSON.stringify(body);
      if (encoded !== undefined && encoder.encode(encoded).byteLength > MAX_BYTES) throw new Error();
    } catch { throw new GoogleRestError("GOOGLE_REQUEST_TOO_LARGE"); }
    const remaining = deadlineEpochMs - clock();
    if (outerSignal?.aborted || remaining <= 0) throw new GoogleRestError("GOOGLE_OPERATION_CANCELLED");
    if (++attempts > maxRequests) throw new GoogleRestError("GOOGLE_REQUEST_BUDGET_EXHAUSTED");
    const controller = new AbortController();
    const abort = () => controller.abort();
    outerSignal?.addEventListener("abort", abort, { once: true });
    if (outerSignal?.aborted) abort();
    const timer = setTimeout(abort, Math.min(remaining, REQUEST_MS));
    let abortReject: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abortReject = () => reject(new Error("GOOGLE_OPERATION_CANCELLED"));
      controller.signal.addEventListener("abort", abortReject, { once: true });
      if (controller.signal.aborted) abortReject();
    });
    const bounded = <U>(promise: Promise<U>): Promise<U> => Promise.race([promise, cancelled]);
    let dispatched = false;
    let httpFailure: GoogleRestError | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const rawLease = await bounded(authorize(controller.signal));
      // Snapshot scalar identity/token fields before any subsequent await.
      const lease = { connection_id: rawLease.connection_id, exchange_generation_id: rawLease.exchange_generation_id,
        access_token: rawLease.access_token, expires_at_epoch_ms: rawLease.expires_at_epoch_ms,
        assertCurrent: rawLease.assertCurrent.bind(rawLease) };
      const validLease = () => {
        const time = clock();
        if (controller.signal.aborted || time >= deadlineEpochMs) throw new Error();
        if (lease.connection_id !== connectionId || lease.exchange_generation_id !== generationId
            || !Number.isSafeInteger(lease.expires_at_epoch_ms) || lease.expires_at_epoch_ms <= time
            || typeof lease.access_token !== "string" || !/^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/u.test(lease.access_token)) {
          throw new GoogleRestError("GOOGLE_AUTHORIZATION_REJECTED");
        }
      };
      validLease();
      await bounded(lease.assertCurrent(controller.signal)); validLease();
      dispatched = true;
      const method = isFilePatch && writes ? "PATCH" : encoded === undefined ? "GET" : "POST";
      const pending = fetchImpl(requestUrl, { method,
        headers: { Authorization: `Bearer ${lease.access_token}`, Accept: "application/json",
          ...(encoded === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(encoded === undefined ? {} : { body: encoded }), signal: controller.signal,
        redirect: "manual", cache: "no-store", credentials: "omit" }).then((response) => {
          if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error(); }
          return response;
        });
      const response = await bounded(pending);
      if (response.status !== 200 || response.redirected || response.type === "opaqueredirect") {
        void response.body?.cancel().catch(() => {});
        const rejection = [400, 401, 403, 404, 409, 412, 429].includes(response.status) && !response.redirected;
        const code = response.status === 401 ? "GOOGLE_REAUTH_REQUIRED" : "GOOGLE_HTTP_REJECTED";
        httpFailure = new GoogleRestError(code, writes ? (rejection ? "REJECTED" : "UNKNOWN") : "NO_WRITE", response.status);
        throw httpFailure;
      }
      if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !response.body) {
        void response.body?.cancel().catch(() => {}); throw new Error();
      }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES)) {
        void response.body.cancel().catch(() => {}); throw new Error();
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0; let count = 0;
      while (true) {
        const next = await bounded(reader.read()); if (next.done) break;
        size += next.value.byteLength;
        if (++count > 4096 || size > MAX_BYTES) throw new Error();
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const result = decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
      await bounded(lease.assertCurrent(controller.signal)); validLease();
      return result;
    } catch {
      // Never include upstream payloads, URLs, token supplier errors or raw fetch diagnostics.
      if (httpFailure) throw httpFailure;
      throw new GoogleRestError(dispatched ? (writes ? "GOOGLE_WRITE_OUTCOME_UNKNOWN" : "GOOGLE_READ_FAILED") : "GOOGLE_AUTHORIZATION_REJECTED",
        writes && dispatched ? "UNKNOWN" : "NO_WRITE");
    } finally {
      clearTimeout(timer); outerSignal?.removeEventListener("abort", abort);
      if (abortReject) controller.signal.removeEventListener("abort", abortReject);
      controller.abort(); if (reader) void reader.cancel().catch(() => {});
    }
  };
}
