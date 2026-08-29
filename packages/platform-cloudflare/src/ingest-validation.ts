import type { NormalizedBundleManifest, ObjectResidencyKey } from "@eliotr/contracts";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const SESSION_PROTOCOL = "eliotr.staged-bundle.v1" as const;
export const COMPLETION_PROTOCOL = "eliotr.staged-file-completion.v1" as const;
export const PROMOTION_PROTOCOL = "eliotr.bundle-promotion.v1" as const;
export const TOMBSTONE_PROTOCOL = "eliotr.staging-tombstone.v1" as const;

export type IngestStorageErrorCode =
  | "BUNDLE_INPUT_INVALID"
  | "BUNDLE_RESIDENCY_MISMATCH"
  | "BUNDLE_FILE_SET_INVALID"
  | "BUNDLE_HASH_MANIFEST_INVALID"
  | "BUNDLE_TOTAL_SIZE_MISMATCH"
  | "STAGING_SESSION_CONFLICT"
  | "STAGING_SESSION_NOT_FOUND"
  | "STAGING_SESSION_EXPIRED"
  | "STAGING_SESSION_CORRUPT"
  | "STAGING_SESSION_ABORTED"
  | "STAGING_FILE_UNKNOWN"
  | "STAGING_PART_INVALID"
  | "STAGING_FILE_INTEGRITY_FAILURE"
  | "STAGING_STATE_CONFLICT"
  | "STAGING_CLEANUP_FAILED"
  | "PROMOTION_NOT_AUTHORIZED"
  | "PROMOTION_INTEGRITY_FAILURE";

export class IngestStorageError extends Error {
  public readonly code: IngestStorageErrorCode;
  public readonly retryable: boolean;

  public constructor(code: IngestStorageErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IngestStorageError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface FileHashEntry { readonly path: string; readonly sha256: string; }

export function fail(code: IngestStorageErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new IngestStorageError(code, message, retryable, cause);
}

export function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
export function iso(now: number): string { return new Date(now).toISOString(); }

export function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) fail("BUNDLE_INPUT_INVALID", `${label} is invalid`);
}

export function assertOpaqueToken(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    utf8Bytes(value) > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("STAGING_SESSION_CORRUPT", `${label} is invalid`);
  }
}

export function assertPath(path: unknown, label = "bundle path"): asserts path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("//") ||
    utf8Bytes(path) > 512
  ) {
    fail("BUNDLE_FILE_SET_INVALID", `${label} is not a bounded relative path`);
  }
  for (const segment of path.split("/")) {
    if (segment === "." || segment === ".." || !SAFE_PATH_SEGMENT.test(segment)) {
      fail("BUNDLE_FILE_SET_INVALID", `${label} contains an unsafe segment`);
    }
  }
}

export function assertStorageKey(path: unknown, label = "storage key"): asserts path is string {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.startsWith("/")
    || path.endsWith("/")
    || path.includes("//")
    || utf8Bytes(path) > 1024
  ) {
    fail("STAGING_SESSION_CORRUPT", `${label} is not a bounded relative storage key`);
  }
  for (const segment of path.split("/")) {
    if (segment === "." || segment === ".." || !SAFE_PATH_SEGMENT.test(segment)) {
      fail("STAGING_SESSION_CORRUPT", `${label} contains an unsafe segment`);
    }
  }
}

export function assertSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("BUNDLE_INPUT_INVALID", `${label} is outside its allowed integer range`);
  }
}


export function exactSizeStream(
  body: ReadableStream<Uint8Array>,
  expectedBytes: number,
): ReadableStream<Uint8Array> {
  let observed = 0;
  let chunks = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array)) {
        fail("STAGING_PART_INVALID", "multipart upload yielded a non-byte chunk");
      }
      chunks += 1;
      if (chunks > 262_144) {
        fail("STAGING_PART_INVALID", "multipart upload exceeds its chunk-count ceiling");
      }
      observed += chunk.byteLength;
      if (!Number.isSafeInteger(observed) || observed > expectedBytes) {
        fail("STAGING_PART_INVALID", "multipart upload exceeds its declared byte length");
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (observed !== expectedBytes) {
        fail("STAGING_PART_INVALID", "multipart upload does not match its declared byte length");
      }
    },
  }));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("BUNDLE_INPUT_INVALID", "canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  fail("BUNDLE_INPUT_INVALID", "canonical JSON contains a non-JSON value");
}

export function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("BUNDLE_INPUT_INVALID", `${label} must be a lowercase SHA-256 digest`);
  }
}

export function safeHashEntries(
  input: Readonly<Record<string, string>>,
  maxFiles: number,
): readonly FileHashEntry[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("BUNDLE_FILE_SET_INVALID", "file_hashes must be an object");
  }
  const entries = Object.entries(input);
  if (entries.length < 3 || entries.length > maxFiles) {
    fail("BUNDLE_FILE_SET_INVALID", "bundle file count is outside its allowed range");
  }
  const seen = new Set<string>();
  return entries.map(([path, digest]) => {
    assertPath(path);
    assertSha256(digest, `file_hashes[${path}]`);
    if (seen.has(path)) fail("BUNDLE_FILE_SET_INVALID", `duplicate bundle path ${path}`);
    seen.add(path);
    return { path, sha256: digest };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function validateFileSet(
  manifest: NormalizedBundleManifest,
  entries: readonly FileHashEntry[],
): void {
  const actual = new Map(entries.map((entry) => [entry.path, entry.sha256]));
  const required = new Set<string>(["content.md", "manifest.json", "hashes.sha256"]);
  for (const path of [manifest.content.structure, manifest.content.mappings, manifest.content.tables]) {
    if (path !== undefined) {
      assertPath(path, "manifest content path");
      required.add(path);
    }
  }
  for (const path of required) {
    if (!actual.has(path)) fail("BUNDLE_FILE_SET_INVALID", `required bundle file ${path} is missing`);
  }
  for (const path of actual.keys()) {
    if (!required.has(path) && !path.startsWith("assets/")) {
      fail("BUNDLE_FILE_SET_INVALID", `undeclared root bundle file ${path}`);
    }
  }
  if (actual.get("content.md") !== manifest.content.markdown_sha256) {
    fail("BUNDLE_HASH_MANIFEST_INVALID", "content.md digest disagrees with the normalized manifest");
  }
}

export function validateResidency(
  manifest: NormalizedBundleManifest,
  residency: ObjectResidencyKey,
): void {
  const source = manifest.residency_and_disclosure;
  const equal = residency.scope_domain_id === source.scope_domain_id
    && residency.access_domain_id === source.access_domain_id
    && residency.confidentiality_domain_id === source.confidentiality_domain_id
    && residency.encryption_key_domain_id === source.encryption_key_domain_id
    && residency.retention_domain_id === source.retention_domain_id
    && residency.erasure_domain_id === source.erasure_domain_id
    && residency.content_digest.algorithm === "sha256"
    && residency.content_digest.digest === manifest.content.markdown_sha256;
  if (!equal) {
    fail("BUNDLE_RESIDENCY_MISMATCH", "complete residency identity does not match the normalized manifest");
  }
}

export function parseHashesDocument(text: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    if (line === "") continue;
    const match = /^([a-f0-9]{64}) [ *](.+)$/u.exec(line);
    if (match === null) fail("BUNDLE_HASH_MANIFEST_INVALID", "hashes.sha256 contains a malformed line");
    const digest = match[1];
    const path = match[2];
    if (digest === undefined || path === undefined) {
      fail("BUNDLE_HASH_MANIFEST_INVALID", "hashes.sha256 contains a malformed entry");
    }
    assertPath(path, "hashes.sha256 path");
    if (path === "hashes.sha256" || result.has(path)) {
      fail("BUNDLE_HASH_MANIFEST_INVALID", "hashes.sha256 contains a self-reference or duplicate");
    }
    result.set(path, digest);
  }
  return result;
}

export function contentType(path: string): string {
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".sha256")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
