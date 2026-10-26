/**
 * K1 static-capture URL guard (IMPLEMENTATION §4): static fetch only, never Browser Run;
 * captured bytes are untrusted data, never rendered.
 * DNS limitation: hostname checks run before fetch and cannot cover rebinding at fetch time.
 */

export type UrlGuardErrorCode = "invalid" | "unavailable";

export type UrlGuardReason = "invalid_url" | "blocked" | "redirect" | "too_large" | "bad_status" | "timeout" | "fetch_failed";

/** Root integration: `code`/`status` fit the API error shape; `reason` keeps guard detail. */
export class UrlGuardError extends Error {
  readonly code: UrlGuardErrorCode;
  readonly status: 400 | 503;
  readonly reason: UrlGuardReason;

  constructor(reason: UrlGuardReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UrlGuardError";
    this.reason = reason;
    this.code = reason === "timeout" || reason === "fetch_failed" || reason === "bad_status" ? "unavailable" : "invalid";
    this.status = this.code === "unavailable" ? 503 : 400;
  }
}

export interface CapturedUrl {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly filename: string;
  readonly url: string;
}

const MAX_URL_CHARS = 8_192;
const MAX_REDIRECTS = 3;
const TOTAL_TIMEOUT_MS = 15_000;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILENAME_CHARS = 128;

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet", ".invalid", ".example", ".test", ".home.arpa"];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** `new URL` normalizes every IPv4 spelling to dotted decimal and keeps IPv6 colons. */
const IPV4_DOTTED = /^\d+\.\d+\.\d+\.\d+$/;

/** Returns the parsed URL when it may be captured, else throws `UrlGuardError`. */
export function validateSourceUrl(input: string): URL {
  if (typeof input !== "string") throw new UrlGuardError("invalid_url", "A source URL must be text.");
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new UrlGuardError("invalid_url", "A source URL must not be empty.");
  if (trimmed.length > MAX_URL_CHARS) throw new UrlGuardError("invalid_url", `A source URL must be at most ${MAX_URL_CHARS} characters.`);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new UrlGuardError("invalid_url", "That URL could not be parsed. Use an absolute https:// URL.");
  }
  if (url.protocol !== "https:") throw new UrlGuardError("blocked", `Only https:// URLs can be captured (got "${url.protocol}").`);
  if (url.username !== "" || url.password !== "") throw new UrlGuardError("blocked", "URLs with credentials cannot be captured.");
  if (url.port !== "" && url.port !== "443") throw new UrlGuardError("blocked", "Only the default https port (443) can be captured.");
  const host = url.hostname.replace(/\.$/, "");
  if (host.includes(":") || IPV4_DOTTED.test(host)) throw new UrlGuardError("blocked", "IP addresses cannot be captured. Use a public DNS hostname.");
  if (host === "localhost") throw new UrlGuardError("blocked", `"${host}" cannot be captured.`);
  for (const suffix of BLOCKED_SUFFIXES) {
    if (host.endsWith(suffix)) throw new UrlGuardError("blocked", `Names under "${suffix}" cannot be captured.`);
  }
  if (!host.includes(".")) throw new UrlGuardError("blocked", "Single-label hostnames cannot be captured. Use a public DNS hostname.");
  return url;
}

function timeoutError(): UrlGuardError {
  return new UrlGuardError("timeout", `Capture timed out after ${TOTAL_TIMEOUT_MS / 1000} seconds.`);
}

/** Best-effort release of an unwanted body: redirect hops and rejected responses. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The unwanted body is intentionally discarded.
  }
}

function sanitizeFilename(value: string): string {
  let name = value;
  try {
    if (name.includes("%")) name = decodeURIComponent(name);
  } catch {
    // Keep the raw token when it is not valid percent-encoding.
  }
  let clean = "";
  for (const char of name) {
    if (char === "/" || char === "\\") continue;
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) continue;
    clean += char;
  }
  clean = clean.trim().replace(/^\.+/, "").trim();
  if (clean.length > MAX_FILENAME_CHARS) clean = clean.slice(0, MAX_FILENAME_CHARS);
  return clean;
}

function filenameFrom(finalUrl: URL, headers: Headers): string {
  const candidates: string[] = [];
  const disposition = headers.get("content-disposition");
  if (disposition !== null) {
    const extended = /filename\*\s*=\s*(?:utf-8''|UTF-8'')?([^;]+)/.exec(disposition)?.[1]?.trim().replace(/^"|"$/g, "") ?? "";
    const quoted = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;,\s]+)/i.exec(disposition);
    candidates.push(extended, (quoted?.[1] ?? quoted?.[2] ?? "").trim());
  }
  candidates.push(finalUrl.pathname.split("/").pop() ?? "");
  for (const candidate of candidates) {
    const clean = sanitizeFilename(candidate);
    if (clean !== "") return clean;
  }
  return "download";
}

/** Static fetch, manual redirects revalidated (max 3), 15 s budget, 25 MiB streamed cap. */
export async function captureUrl(input: string): Promise<CapturedUrl> {
  const startedAt = Date.now();
  const remainingMs = (): number => {
    const left = TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
    if (left <= 0) throw timeoutError();
    return left;
  };

  let current = validateSourceUrl(input);
  let redirects = 0;
  let response: Response;
  for (;;) {
    let res: Response;
    try {
      res = await globalThis.fetch(current.href, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(remainingMs()),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw timeoutError();
      throw new UrlGuardError("fetch_failed", `Could not fetch "${current.host}". The site may be down or blocking automated reads.`, { cause: error });
    }
    if (!REDIRECT_STATUSES.has(res.status)) { response = res; break; }
    const location = res.headers.get("location");
    await discardBody(res);
    if (location === null || location.trim() === "") throw new UrlGuardError("redirect", `A redirect from "${current.host}" has no Location to follow.`);
    if (redirects >= MAX_REDIRECTS) throw new UrlGuardError("redirect", `Too many redirects (more than ${MAX_REDIRECTS}).`);
    let next: URL;
    try {
      next = new URL(location, current.href);
    } catch {
      throw new UrlGuardError("redirect", `A redirect from "${current.host}" points to an invalid URL.`);
    }
    redirects += 1;
    current = validateSourceUrl(next.href);
  }

  if (!response.ok) {
    await discardBody(response);
    throw new UrlGuardError("bad_status", `Capture failed with status ${response.status} for "${current.host}".`);
  }

  const declared = Number((response.headers.get("content-length") ?? "").trim());
  if (declared > MAX_BYTES) {
    await discardBody(response);
    throw new UrlGuardError("too_large", "That file is larger than 25 MiB and cannot be captured.");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) {
          await reader.cancel().catch(() => undefined);
          throw timeoutError();
        }
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new UrlGuardError("too_large", "That download exceeded 25 MiB and was stopped before buffering.");
        }
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (error instanceof UrlGuardError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw timeoutError();
      throw new UrlGuardError("fetch_failed", `The download from "${current.host}" was interrupted.`, { cause: error });
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return {
    bytes,
    mimeType: mime.includes("/") ? mime : "application/octet-stream",
    filename: filenameFrom(current, response.headers),
    url: current.href,
  };
}
