import { readRequestBodyWithinBytes } from "@eliotr/platform-cloudflare";
import {
  ArtifactHttpInputError,
  type CatalogRequest,
  type CreateProjectRequest,
  type ProjectOwnerListRequest,
  type SourceRevisionsRequest,
  type UpdateProjectRequest,
} from "@eliotr/interfaces";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { HttpRequestError } from "./http-request-error.js";

export const MAX_QUERY_VALUE_BYTES = 2 * 1024;
export async function requireEmptyRequestBody(request: Request, message: string): Promise<void> {
  if (request.body === null) return;
  const bytes = await readRequestBodyWithinBytes(request, {
    label: "http.request.empty",
    max_bytes: 1,
    max_chunks: 4096,
  });
  if (bytes.byteLength !== 0) throw new ArtifactHttpInputError(message);
}
export function singleQueryValue(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) {
    throw new HttpRequestError("QUERY_PARAMETER_DUPLICATED", 400, `${key} may appear only once`);
  }
  const value = values[0];
  if (value === undefined || value === "") return undefined;
  if (new TextEncoder().encode(value).byteLength > MAX_QUERY_VALUE_BYTES) {
    throw new HttpRequestError("QUERY_PARAMETER_TOO_LARGE", 400, `${key} exceeds its byte limit`);
  }
  return value;
}
export function parseCatalogRequest(url: URL): CatalogRequest {
  const allowed = new Set(["project_id", "cursor", "limit"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new HttpRequestError("UNKNOWN_QUERY_PARAMETER", 400, "catalog query contains an unknown parameter");
    }
  }
  const projectId = singleQueryValue(url, "project_id");
  const cursor = singleQueryValue(url, "cursor");
  const rawLimit = singleQueryValue(url, "limit");
  if (rawLimit !== undefined && !/^[1-9][0-9]{0,2}$/u.test(rawLimit)) {
    throw new HttpRequestError("CATALOG_LIMIT_INVALID", 400, "catalog limit must be an integer in [1, 100]");
  }
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpRequestError("CATALOG_LIMIT_INVALID", 400, "catalog limit must be an integer in [1, 100]");
  }
  return {
    limit,
    ...(projectId === undefined ? {} : { project_id: projectId }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

const SAFE_PROJECT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MAX_PROJECT_TITLE_BYTES = 4 * 1024;
const MAX_PROJECT_SOURCES = 256;
const SAFE_NAMESPACE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export function namespaceIdentifier(value: unknown): string {
  if (typeof value !== "string" || !SAFE_NAMESPACE_IDENTIFIER.test(value)) {
    throw new HttpRequestError("NAMESPACE_INPUT_INVALID", 400, "namespace id is invalid");
  }
  return value;
}

export function projectText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      new TextEncoder().encode(value).byteLength > maximumBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HttpRequestError("PROJECT_INPUT_INVALID", 400, `${label} is invalid`);
  }
  return value;
}

export function projectIdentifier(value: unknown, label: string): string {
  const identifier = projectText(value, label, 256);
  if (!SAFE_PROJECT_IDENTIFIER.test(identifier)) {
    throw new HttpRequestError("PROJECT_INPUT_INVALID", 400, `${label} is invalid`);
  }
  return identifier;
}

export function parseProjectListRequest(url: URL): ProjectOwnerListRequest {
  for (const key of url.searchParams.keys()) {
    if (key !== "after_project_id") {
      throw new HttpRequestError("UNKNOWN_QUERY_PARAMETER", 400, "project query contains an unknown parameter");
    }
  }
  const afterProjectId = singleQueryValue(url, "after_project_id");
  return afterProjectId === undefined ? {} : { after_project_id: projectIdentifier(afterProjectId, "after_project_id") };
}

export function projectSourceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_PROJECT_SOURCES) {
    throw new HttpRequestError("PROJECT_INPUT_INVALID", 400, "source_ids is invalid");
  }
  const sourceIds = value.map((source, index) => projectIdentifier(source, `source_ids[${index}]`));
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new HttpRequestError("PROJECT_INPUT_INVALID", 400, "source_ids contains duplicates");
  }
  return sourceIds;
}

export function projectIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (key === null) {
    throw new HttpRequestError("PROJECT_IDEMPOTENCY_REQUIRED", 400, "Idempotency-Key is required");
  }
  return projectIdentifier(key, "Idempotency-Key");
}

export async function readCreateProjectRequest(request: Request, maximumBytes: number): Promise<CreateProjectRequest> {
  const value = await readJsonBodyWithinBytes(request, maximumBytes);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpRequestError("PROJECT_INPUT_INVALID", 400, "project request must be an object");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["title", "source_ids"].includes(key)) ||
      !Object.hasOwn(body, "title") || !Object.hasOwn(body, "source_ids")) {
    throw new HttpRequestError("PROJECT_INPUT_INVALID", 400, "project request has missing or unknown fields");
  }
  return {
    title: projectText(body.title, "title", MAX_PROJECT_TITLE_BYTES),
    source_ids: projectSourceIds(body.source_ids),
    idempotency_key: projectIdempotencyKey(request),
  };
}

export async function readUpdateProjectRequest(request: Request, maximumBytes: number): Promise<UpdateProjectRequest> {
  const value = await readJsonBodyWithinBytes(request, maximumBytes);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpRequestError("PROJECT_INPUT_INVALID", 400, "project request must be an object");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["title", "source_ids", "expected_revision"].includes(key)) ||
      !Object.hasOwn(body, "title") || !Object.hasOwn(body, "source_ids") ||
      !Object.hasOwn(body, "expected_revision")) {
    throw new HttpRequestError("PROJECT_INPUT_INVALID", 400, "project update has missing or unknown fields");
  }
  if (typeof body.expected_revision !== "number" || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 1) {
    throw new HttpRequestError("PROJECT_INPUT_INVALID", 400, "expected_revision is invalid");
  }
  return {
    title: projectText(body.title, "title", MAX_PROJECT_TITLE_BYTES),
    source_ids: projectSourceIds(body.source_ids),
    expected_revision: body.expected_revision,
    idempotency_key: projectIdempotencyKey(request),
  };
}
export function parseSourceRevisionsRequest(url: URL): SourceRevisionsRequest {
  for (const key of url.searchParams.keys()) {
    if (!["source_id", "cursor", "limit"].includes(key)) {
      throw new HttpRequestError("UNKNOWN_QUERY_PARAMETER", 400, "Revision query contains an unknown parameter");
    }
  }
  const sourceId = singleQueryValue(url, "source_id");
  const cursor = singleQueryValue(url, "cursor");
  const rawLimit = singleQueryValue(url, "limit");
  if (sourceId === undefined || (rawLimit !== undefined && !/^(?:[1-9]|10)$/u.test(rawLimit))) {
    throw new HttpRequestError("SOURCE_REVISIONS_INPUT_INVALID", 400, "Source and a limit in [1, 10] are required");
  }
  return { source_id: sourceId, limit: rawLimit === undefined ? 10 : Number(rawLimit),
    ...(cursor === undefined ? {} : { cursor }) };
}
