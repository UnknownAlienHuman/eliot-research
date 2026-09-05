import { NormalizedBundleManifestSchema } from "@eliotr/contracts";
import type {
  AuthenticatedRequestContext,
  CommitBundleUploadRequest,
  CompleteBundleFileRequest,
  OwnerApi,
  PrepareBundleUploadRequest,
  UploadBundlePartRequest,
} from "@eliotr/interfaces";
import { readRequestBodyWithinBytes } from "@eliotr/platform-cloudflare";

export class IngestHttpInputError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly retryable = false;

  public constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "IngestHttpInputError";
    this.code = code;
    this.status = status;
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_JSON_CHUNKS = 4096;
const MAX_FILE_COUNT = 1024;
const MAX_PART_COUNT = 10_000;

function fail(code: string, status: number, message: string): never {
  throw new IngestHttpInputError(code, status, message);
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allow.has(key));
  if (unknown.length > 0) fail("INGEST_UNKNOWN_FIELD", 400, `${label} contains unknown fields`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("INGEST_BODY_INVALID", 400, `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("INGEST_IDENTIFIER_INVALID", 400, `${label} is invalid`);
  }
  return value;
}

function opaqueToken(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      new TextEncoder().encode(value).byteLength > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INGEST_IDENTIFIER_INVALID", 400, `${label} is invalid`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("INGEST_DIGEST_INVALID", 400, `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("INGEST_INTEGER_INVALID", 400, `${label} is outside its allowed integer range`);
  }
  return value;
}

function decimalInteger(value: string | undefined, label: string, maximum: number): number {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
    fail("INGEST_INTEGER_INVALID", 400, `${label} must be a positive decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    fail("INGEST_INTEGER_INVALID", 400, `${label} is outside its allowed integer range`);
  }
  return parsed;
}

function safePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    new TextEncoder().encode(value).byteLength > 512
  ) {
    fail("INGEST_PATH_INVALID", 400, "bundle path is invalid");
  }
  for (const segment of value.split("/")) {
    if (segment === "." || segment === ".." || !SAFE_PATH_SEGMENT.test(segment)) {
      fail("INGEST_PATH_INVALID", 400, "bundle path contains an unsafe segment");
    }
  }
  return value;
}

function queryValue(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) fail("INGEST_QUERY_DUPLICATED", 400, `${key} may appear only once`);
  const value = values[0];
  return value === undefined || value === "" ? undefined : value;
}

function exactQuery(url: URL, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allow.has(key)) fail("INGEST_QUERY_UNKNOWN", 400, "ingest query contains an unknown parameter");
  }
}

function requireJsonMediaType(request: Request): void {
  const contentType = request.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    fail("INGEST_CONTENT_TYPE_INVALID", 415, "request body must use application/json");
  }
}

async function jsonBody(request: Request, maximumBytes: number): Promise<Record<string, unknown>> {
  requireJsonMediaType(request);
  const bytes = await readRequestBodyWithinBytes(request, {
    label: "http.request.ingest-json",
    max_bytes: maximumBytes,
    max_chunks: MAX_JSON_CHUNKS,
  });
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (cause) { fail("INGEST_BODY_INVALID", 400, `request body is not UTF-8: ${String(cause)}`); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (cause) { fail("INGEST_BODY_INVALID", 400, `request body is not valid JSON: ${String(cause)}`); }
  return record(parsed, "request body");
}

function fileHashes(value: unknown): Readonly<Record<string, string>> {
  const input = record(value, "file_hashes");
  const entries = Object.entries(input);
  if (entries.length < 3 || entries.length > MAX_FILE_COUNT) {
    fail("INGEST_FILE_SET_INVALID", 400, "file_hashes count is outside its allowed range");
  }
  const output: Record<string, string> = {};
  for (const [path, digest] of entries) output[safePath(path)] = sha256(digest, `file_hashes[${path}]`);
  return output;
}

async function prepareRequest(request: Request, maximumBytes: number): Promise<PrepareBundleUploadRequest> {
  const input = await jsonBody(request, maximumBytes);
  exactKeys(input, ["manifest", "total_bytes", "file_hashes", "idempotency_key"], "prepare request");
  let manifest;
  try { manifest = NormalizedBundleManifestSchema.parse(input.manifest); }
  catch (cause) { fail("INGEST_MANIFEST_INVALID", 400, `manifest failed strict validation: ${String(cause)}`); }
  return {
    manifest,
    total_bytes: positiveInteger(input.total_bytes, "total_bytes", 50 * 1024 * 1024 * 1024),
    file_hashes: fileHashes(input.file_hashes),
    idempotency_key: identifier(input.idempotency_key, "idempotency_key"),
  };
}

async function completeRequest(
  request: Request,
  maximumBytes: number,
  operationId: string,
): Promise<CompleteBundleFileRequest> {
  const input = await jsonBody(request, maximumBytes);
  exactKeys(input, ["multipart_session_ref", "path", "parts"], "file completion request");
  if (!Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > MAX_PART_COUNT) {
    fail("INGEST_PART_SET_INVALID", 400, "parts must be a bounded non-empty array");
  }
  const parts = input.parts.map((raw, index) => {
    const part = record(raw, `parts[${index}]`);
    exactKeys(part, ["part_number", "size_bytes", "etag"], `parts[${index}]`);
    return {
      part_number: positiveInteger(part.part_number, `parts[${index}].part_number`, MAX_PART_COUNT),
      size_bytes: positiveInteger(part.size_bytes, `parts[${index}].size_bytes`, 256 * 1024 * 1024),
      etag: opaqueToken(part.etag, `parts[${index}].etag`),
    };
  });
  return {
    operation_id: operationId,
    multipart_session_ref: identifier(input.multipart_session_ref, "multipart_session_ref"),
    path: safePath(input.path),
    parts,
  };
}

async function commitRequest(request: Request, maximumBytes: number): Promise<CommitBundleUploadRequest> {
  const input = await jsonBody(request, maximumBytes);
  exactKeys(input, ["operation_id", "multipart_session_ref", "manifest_sha256"], "commit request");
  return {
    operation_id: identifier(input.operation_id, "operation_id"),
    multipart_session_ref: identifier(input.multipart_session_ref, "multipart_session_ref"),
    manifest_sha256: sha256(input.manifest_sha256, "manifest_sha256"),
  };
}

function uploadRequest(
  request: Request,
  url: URL,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
): UploadBundlePartRequest {
  exactQuery(url, ["multipart_session_ref", "path", "size_bytes", "final_part"]);
  if (request.body === null) fail("INGEST_BODY_INVALID", 400, "multipart part body is missing");
  const operationId = identifier(params.operation_id, "operation_id");
  const partNumber = decimalInteger(params.part_number, "part_number", MAX_PART_COUNT);
  const sizeBytes = decimalInteger(queryValue(url, "size_bytes"), "size_bytes", maximumBytes);
  const finalPart = queryValue(url, "final_part");
  if (finalPart !== "0" && finalPart !== "1") {
    fail("INGEST_BOOLEAN_INVALID", 400, "final_part must be 0 or 1");
  }
  return {
    operation_id: operationId,
    multipart_session_ref: identifier(
      queryValue(url, "multipart_session_ref"),
      "multipart_session_ref",
    ),
    path: safePath(queryValue(url, "path")),
    part_number: partNumber,
    size_bytes: sizeBytes,
    final_part: finalPart === "1",
    body: request.body,
  };
}

export async function dispatchIngestOperation(
  operation: string,
  request: Request,
  url: URL,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
  context: AuthenticatedRequestContext,
  owner: OwnerApi,
): Promise<unknown> {
  switch (operation) {
    case "ingest.bundle.prepare":
      exactQuery(url, []);
      return owner.prepareBundle(context, await prepareRequest(request, maximumBytes));
    case "ingest.bundle.part.upload":
      return owner.uploadBundlePart(context, uploadRequest(request, url, params, maximumBytes));
    case "ingest.bundle.file.complete":
      exactQuery(url, []);
      return owner.completeBundleFile(
        context,
        await completeRequest(
          request,
          maximumBytes,
          identifier(params.operation_id, "operation_id"),
        ),
      );
    case "ingest.bundle.commit":
      exactQuery(url, []);
      return owner.commitBundle(context, await commitRequest(request, maximumBytes));
    case "ingest.bundle.status":
      exactQuery(url, []);
      return owner.getBundleStatus(
        context,
        identifier(params.operation_id, "operation_id"),
      );
    default:
      throw new Error(`unsupported ingest operation ${operation}`);
  }
}
