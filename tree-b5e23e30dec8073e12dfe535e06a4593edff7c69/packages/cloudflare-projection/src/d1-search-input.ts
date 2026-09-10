import type { RetrievalRequest } from "@eliotr/retrieval";

export const D1_SEARCH_LANE_MAX_LIMIT = 50;
const MAX_QUERY_UTF8_BYTES = 512;
const MAX_SCOPE_MEMBERS = 64;
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
export const SHA256 = /^[a-f0-9]{64}$/u;

export type D1SearchLaneCode =
  | "SEARCH_UNAVAILABLE"
  | "SEARCH_INCOMPLETE"
  | "SEARCH_INPUT_INVALID";

export class D1SearchLaneError extends Error {
  public readonly code: D1SearchLaneCode;

  public constructor(code: D1SearchLaneCode, message: string) {
    super(message);
    this.name = "D1SearchLaneError";
    this.code = code;
  }
}

export function laneFail(code: D1SearchLaneCode, message: string): never {
  throw new D1SearchLaneError(code, message);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    laneFail("SEARCH_INCOMPLETE", `${label} is malformed`);
  }
  return value;
}

export function assertSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    laneFail("SEARCH_INCOMPLETE", `${label} is malformed`);
  }
  return value;
}

function validatedLimit(request: RetrievalRequest): number {
  const limit = request.requested_limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > D1_SEARCH_LANE_MAX_LIMIT) {
    laneFail(
      "SEARCH_INPUT_INVALID",
      `requested_limit must be an integer in [1,${D1_SEARCH_LANE_MAX_LIMIT}]`,
    );
  }
  return limit;
}

function validatedQuery(request: RetrievalRequest): string {
  const raw = request.raw_query;
  if (typeof raw !== "string") laneFail("SEARCH_INPUT_INVALID", "raw_query must be text");
  // Reject before trimming or encoding: padding must not bypass the transport bound.
  if (raw.length > MAX_QUERY_UTF8_BYTES || utf8Length(raw) > MAX_QUERY_UTF8_BYTES) {
    laneFail("SEARCH_INPUT_INVALID", "raw_query exceeds its byte bound");
  }
  // In Unicode mode this range matches lone surrogates, not valid surrogate pairs.
  if (/[\ud800-\udfff]/u.test(raw)) {
    laneFail("SEARCH_INPUT_INVALID", "raw_query contains malformed Unicode");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)) {
    laneFail("SEARCH_INPUT_INVALID", "raw_query contains control characters");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) laneFail("SEARCH_INPUT_INVALID", "raw_query must not be empty");
  return trimmed;
}

function validatedMembers(request: RetrievalRequest): readonly string[] {
  const members = request.scope_snapshot.member_source_revision_refs;
  if (!Array.isArray(members)) {
    laneFail("SEARCH_INCOMPLETE", "scope members must be an array");
  }
  if (members.length > MAX_SCOPE_MEMBERS) {
    laneFail("SEARCH_INPUT_INVALID", "scope exceeds its member bound");
  }
  const seen = new Set<string>();
  for (const member of members) {
    if (typeof member !== "string" || !IDENTIFIER.test(member)) {
      laneFail("SEARCH_INCOMPLETE", "scope member is malformed");
    }
    if (seen.has(member)) laneFail("SEARCH_INCOMPLETE", "scope members are not unique");
    seen.add(member);
  }
  return [...seen].sort();
}

export interface ValidatedSearchInput {
  readonly query: string;
  readonly limit: number;
  readonly members: readonly string[];
  readonly owner_generations: Readonly<Record<string, string>>;
  readonly expires_ms: number;
}

/** Capture bounded scalar authority inputs once, before the first platform await. */
export function validateSearchInput(request: RetrievalRequest): ValidatedSearchInput {
  const limit = validatedLimit(request);
  const query = validatedQuery(request);
  const scope = request.scope_snapshot;
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
    laneFail("SEARCH_INCOMPLETE", "scope snapshot is malformed");
  }
  const members = validatedMembers(request);
  const suppliedOwners = scope.source_owner_generations;
  if (suppliedOwners === null || typeof suppliedOwners !== "object" || Array.isArray(suppliedOwners)) {
    laneFail("SEARCH_INCOMPLETE", "scope owner generations are malformed");
  }
  const owners: Record<string, string> = {};
  for (const member of members) {
    if (!Object.prototype.hasOwnProperty.call(suppliedOwners, member)) {
      laneFail("SEARCH_INCOMPLETE", "scope omits its member owner generation");
    }
    owners[member] = assertIdentifier(suppliedOwners[member], "scope member owner generation");
  }
  if (typeof scope.expires_at !== "string" || scope.expires_at.length > 64) {
    laneFail("SEARCH_INCOMPLETE", "scope expiry is malformed");
  }
  const expires = Date.parse(scope.expires_at);
  if (!Number.isFinite(expires)) laneFail("SEARCH_INCOMPLETE", "scope expiry is malformed");
  return Object.freeze({
    query, limit, members: Object.freeze(members),
    owner_generations: Object.freeze(owners), expires_ms: expires,
  });
}

export function assertSearchCurrent(
  input: ValidatedSearchInput, now: () => number, initial = false,
): void {
  const current = now();
  if (!Number.isFinite(current)) laneFail("SEARCH_INCOMPLETE", "scope clock is malformed");
  if (current >= input.expires_ms) {
    laneFail(initial ? "SEARCH_UNAVAILABLE" : "SEARCH_INCOMPLETE", "scope snapshot is expired");
  }
}
