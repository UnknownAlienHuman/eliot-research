import type { AuthenticatedRequestContext, CreateProjectRequest, ProjectOwnerListRequest, ProjectOwnerListResult, ProjectOwnerResult as PublicProjectOwnerResult, UpdateProjectRequest } from "@eliotr/interfaces";

export const CLIENT_CLASS = "owner_pwa" as const;
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
export const SHA256 = /^[a-f0-9]{64}$/u;
export const MAX_TITLE_LENGTH = 512;
export const MAX_TITLE_BYTES = 4 * 1024;
export const MAX_SOURCE_IDS = 256;
export const MAX_PROJECTS = 256;
export const MAX_IDEMPOTENCY_BYTES = 256;
export const MAX_RESPONSE_BYTES = 262_144;
export const PROJECT_PROTOCOL = "eliotr.project-owner.v1" as const;
export const PROJECT_LIST_PROTOCOL = "eliotr.project-owner-list.v1" as const;

export type ProjectOwnerErrorCode =
  | "PROJECT_OWNER_REQUIRED"
  | "PROJECT_INPUT_INVALID"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_SOURCE_DENIED"
  | "PROJECT_REVISION_CONFLICT"
  | "PROJECT_IDEMPOTENCY_CONFLICT"
  | "PROJECT_STORAGE_UNAVAILABLE"
  | "PROJECT_SETTLEMENT_UNCERTAIN";

export class ProjectOwnerError extends Error {
  public readonly code: ProjectOwnerErrorCode;
  public readonly status: number;
  public readonly retryable: boolean;

  public constructor(code: ProjectOwnerErrorCode, status: number, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProjectOwnerError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export type ProjectOwnerCreateInput = Omit<CreateProjectRequest, "idempotency_key">;
export type ProjectOwnerUpdateInput = Omit<UpdateProjectRequest, "idempotency_key">;

/** Durable result; the public API carries the same strict versioned shape. */
export type ProjectOwnerResult = PublicProjectOwnerResult;

export interface ProjectOwnerService {
  create(context: AuthenticatedRequestContext, request: CreateProjectRequest): Promise<ProjectOwnerResult>;
  read(context: AuthenticatedRequestContext, projectId: string): Promise<ProjectOwnerResult>;
  list(context: AuthenticatedRequestContext, request?: ProjectOwnerListRequest): Promise<ProjectOwnerListResult>;
  update(context: AuthenticatedRequestContext, projectId: string, request: UpdateProjectRequest): Promise<ProjectOwnerResult>;
}

export interface OwnerContext {
  readonly principal_ref: string;
  readonly credential_generation: string;
}

export interface ProjectBaseRow {
  readonly project_id: unknown;
  readonly title: unknown;
  readonly generation: unknown;
  readonly created_at: unknown;
  readonly principal_ref: unknown;
  readonly deployment_generation: unknown;
}

export interface ProjectBase {
  readonly project_id: string;
  readonly title: string;
  readonly revision: number;
  readonly created_at: string;
  readonly principal_ref: string;
  readonly deployment_generation: string;
}

export interface MembershipRow {
  readonly project_id?: unknown;
  readonly source_id: unknown;
}

export interface MutationReceiptRow {
  readonly principal_ref: unknown;
  readonly idempotency_key: unknown;
  readonly operation: unknown;
  readonly project_id: unknown;
  readonly request_sha256: unknown;
  readonly response_json: unknown;
  readonly response_sha256: unknown;
  readonly project_revision: unknown;
  readonly deployment_generation: unknown;
  readonly created_at: unknown;
}

export interface StoredMutation {
  readonly principal_ref: string;
  readonly idempotency_key: string;
  readonly operation: "CREATE" | "UPDATE";
  readonly project_id: string;
  readonly request_sha256: string;
  readonly response_sha256: string;
  readonly project_revision: number;
  readonly deployment_generation: string;
  readonly created_at: string;
  readonly result: ProjectOwnerResult;
}

export function fail(code: ProjectOwnerErrorCode, status: number, message: string, retryable = false, cause?: unknown): never {
  throw new ProjectOwnerError(code, status, message, retryable, cause);
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validIdentifier(value: unknown, maxBytes = 256): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() &&
    utf8Length(value) <= maxBytes && !/[\u0000-\u001f\u007f]/u.test(value) && IDENTIFIER.test(value);
}

export function inputIdentifier(value: unknown, label: string): string {
  if (!validIdentifier(value)) fail("PROJECT_INPUT_INVALID", 400, `${label} is invalid`);
  return value;
}

export function storedIdentifier(value: unknown, label: string): string {
  if (!validIdentifier(value)) fail("PROJECT_STORAGE_UNAVAILABLE", 503, `stored ${label} is invalid`, true);
  return value;
}

export function storedSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, `stored ${label} is invalid`, true);
  }
  return value;
}

export function canonicalTime(value: unknown, label: string, code: ProjectOwnerErrorCode, retryable = false): string {
  if (typeof value !== "string" || !Number.isSafeInteger(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value) {
    fail(code, code === "PROJECT_STORAGE_UNAVAILABLE" ? 503 : 400, `${label} is not canonical`, retryable);
  }
  return value;
}

export function nowValue(now: () => number): { readonly millis: number; readonly iso: string } {
  const millis = now();
  if (!Number.isSafeInteger(millis) || millis < 0 || millis > 8_640_000_000_000_000) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project owner clock is unavailable", true);
  }
  return { millis, iso: new Date(millis).toISOString() };
}

export function contextSnapshot(context: AuthenticatedRequestContext): OwnerContext {
  if (context.client_class !== CLIENT_CLASS || !validIdentifier(context.principal_ref) ||
      !validIdentifier(context.credential_generation)) {
    fail("PROJECT_OWNER_REQUIRED", 403, "an authenticated owner session is required");
  }
  return Object.freeze({ principal_ref: context.principal_ref, credential_generation: context.credential_generation });
}

export function idempotencyKey(context: AuthenticatedRequestContext, supplied: string | undefined): string {
  const value = supplied ?? context.request.headers.get("idempotency-key") ?? undefined;
  if (!validIdentifier(value, MAX_IDEMPOTENCY_BYTES)) {
    fail("PROJECT_INPUT_INVALID", 400, "Idempotency-Key is required and invalid");
  }
  return value;
}

export function normalizeTitle(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_TITLE_LENGTH ||
      value !== value.trim() || utf8Length(value) > MAX_TITLE_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("PROJECT_INPUT_INVALID", 400, "project title is invalid");
  }
  return value;
}

export function normalizeSourceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_IDS) {
    fail("PROJECT_INPUT_INVALID", 400, "source_ids must contain at most 256 entries");
  }
  const values = value.map((entry) => inputIdentifier(entry, "source_id"));
  if (new Set(values).size !== values.length) fail("PROJECT_INPUT_INVALID", 400, "source_ids must be unique");
  return Object.freeze([...values].sort());
}

export function normalizeCreate(input: unknown): ProjectOwnerCreateInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("PROJECT_INPUT_INVALID", 400, "project create input is invalid");
  }
  const record = input as { readonly title?: unknown; readonly source_ids?: unknown };
  return Object.freeze({ title: normalizeTitle(record.title), source_ids: normalizeSourceIds(record.source_ids) });
}

export function normalizeUpdate(input: unknown): ProjectOwnerUpdateInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("PROJECT_INPUT_INVALID", 400, "project update input is invalid");
  }
  const record = input as { readonly expected_revision?: unknown; readonly title?: unknown; readonly source_ids?: unknown };
  if (!Number.isSafeInteger(record.expected_revision) || Number(record.expected_revision) < 1) {
    fail("PROJECT_INPUT_INVALID", 400, "project update input is invalid");
  }
  return Object.freeze({
    expected_revision: Number(record.expected_revision),
    title: normalizeTitle(record.title),
    source_ids: normalizeSourceIds(record.source_ids),
  });
}
