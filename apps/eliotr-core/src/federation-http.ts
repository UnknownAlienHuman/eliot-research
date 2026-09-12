import {
  FederationRequestSchema,
  IdentifierSchema,
  VersionedRefSchema,
  type FederationRequest,
  type VersionedRef,
} from "@eliotr/contracts";
import type {
  AuthenticatedRequestContext,
  FederationApiV1,
  FederationAuthenticatedContext,
  FederationBundleRange,
} from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";

const MAX_HEADER_BYTES = 2_048;
const MAX_REASON_BYTES = 4_096;
const MAX_RANGE_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

export class FederationHttpError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "FederationHttpError";
  }
}

export type FederationHttpResult =
  | {
      readonly kind: "json";
      readonly body: unknown;
      readonly status: number;
    }
  | {
      readonly kind: "response";
      readonly response: Response;
    };

interface FederationHttpMatch {
  readonly operation: string;
  readonly maximum_request_bytes: number;
  readonly params: Readonly<Record<string, string>>;
}

function fail(
  code: string,
  status: number,
  message: string,
  retryable = false,
): never {
  throw new FederationHttpError(code, status, message, retryable);
}

function boundedText(
  value: string | null,
  label: string,
  required = true,
): string | undefined {
  if (value === null || value === "") {
    if (required) fail("FEDERATION_HTTP_INPUT_INVALID", 400, `${label} is required`);
    return undefined;
  }
  if (
    value !== value.trim() ||
    encoder.encode(value).byteLength > MAX_HEADER_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("FEDERATION_HTTP_INPUT_INVALID", 400, `${label} is invalid`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) {
    fail("FEDERATION_HTTP_INPUT_INVALID", 400, `${label} is invalid`);
  }
  return parsed.data;
}

function positiveRevision(value: unknown, label: string): number {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1) {
    fail("FEDERATION_HTTP_INPUT_INVALID", 400, `${label} is invalid`);
  }
  return parsed as number;
}

function exactRecord(
  raw: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("FEDERATION_HTTP_INPUT_INVALID", 400, `${label} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  ) {
    fail(
      "FEDERATION_HTTP_INPUT_INVALID",
      400,
      `${label} has unknown or missing fields`,
    );
  }
  return record;
}

function singleQueryValue(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) {
    fail(
      "FEDERATION_HTTP_INPUT_INVALID",
      400,
      `${key} may appear only once`,
    );
  }
  return boundedText(values[0] ?? null, key, false);
}

function requireOnlyQuery(url: URL, fields: readonly string[]): void {
  const allowed = new Set(fields);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      fail(
        "FEDERATION_HTTP_INPUT_INVALID",
        400,
        "federation query has an unknown parameter",
      );
    }
  }
}

function federationContext(
  context: AuthenticatedRequestContext,
  env: Pick<Env, "DEPLOYMENT_GENERATION" | "FEDERATION_SERVER_PRINCIPAL_REF">,
): FederationAuthenticatedContext {
  if (context.client_class !== "federation_client") {
    fail(
      "FEDERATION_HTTP_AUTH_REQUIRED",
      403,
      "federation route requires a service principal",
    );
  }
  if (env.FEDERATION_SERVER_PRINCIPAL_REF === undefined) {
    fail(
      "FEDERATION_HTTP_CONFIG_INVALID",
      503,
      "federation server identity is not configured",
      true,
    );
  }
  const serverPrincipal = identifier(
    env.FEDERATION_SERVER_PRINCIPAL_REF,
    "federation server principal",
  );
  const generation = identifier(
    env.DEPLOYMENT_GENERATION,
    "federation server generation",
  );
  const clientFence = identifier(
    boundedText(
      context.request.headers.get("x-eliotr-client-fence-ref"),
      "x-eliotr-client-fence-ref",
    ),
    "client fence",
  );
  const manifestId = identifier(
    boundedText(
      context.request.headers.get("x-eliotr-reference-manifest-id"),
      "x-eliotr-reference-manifest-id",
    ),
    "reference manifest id",
  );
  const manifestRevision = positiveRevision(
    boundedText(
      context.request.headers.get("x-eliotr-reference-manifest-revision"),
      "x-eliotr-reference-manifest-revision",
    ),
    "reference manifest revision",
  );
  return {
    request: context.request,
    principal_ref: identifier(context.principal_ref, "requester principal"),
    client_class: "federation_client",
    credential_generation: identifier(
      context.credential_generation,
      "requester credential generation",
    ),
    client_fence_ref: clientFence,
    allowed_reference_manifest_ref: {
      id: manifestId,
      revision: manifestRevision,
    },
    server_principal_ref: serverPrincipal,
    server_credential_generation: generation,
    trace_id: identifier(context.trace_id, "trace id"),
  };
}

function exchangeAndKey(
  params: Readonly<Record<string, string>>,
  url: URL,
): { readonly exchangeId: string; readonly idempotencyKey: string } {
  requireOnlyQuery(url, ["idempotency_key"]);
  return {
    exchangeId: identifier(params.exchange_id, "exchange id"),
    idempotencyKey: identifier(
      singleQueryValue(url, "idempotency_key"),
      "idempotency key",
    ),
  };
}

function bundleRef(
  params: Readonly<Record<string, string>>,
): VersionedRef {
  const parsed = VersionedRefSchema.safeParse({
    id: params.bundle_id,
    revision: positiveRevision(params.revision, "bundle revision"),
  });
  if (!parsed.success) {
    fail("FEDERATION_HTTP_INPUT_INVALID", 400, "bundle reference is invalid");
  }
  return parsed.data;
}

function parseRange(request: Request): FederationBundleRange | undefined {
  const raw = request.headers.get("range");
  if (raw === null) return undefined;
  const match = /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/u.exec(raw);
  if (match === null) {
    fail("FEDERATION_HTTP_RANGE_INVALID", 416, "federation bundle range is invalid");
  }
  const start = Number(match[1]);
  const inclusiveEnd = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(inclusiveEnd) ||
    inclusiveEnd < start ||
    inclusiveEnd - start + 1 > MAX_RANGE_BYTES
  ) {
    fail("FEDERATION_HTTP_RANGE_INVALID", 416, "federation bundle range is invalid");
  }
  return { start, endExclusive: inclusiveEnd + 1 };
}

async function readCancelRequest(
  request: Request,
  maximumBytes: number,
): Promise<{ readonly idempotencyKey: string; readonly reason: string }> {
  const record = exactRecord(
    await readJsonBodyWithinBytes(request, maximumBytes),
    ["idempotency_key", "reason"],
    "federation cancellation request",
  );
  const reason = record.reason;
  if (
    typeof reason !== "string" ||
    reason.length < 1 ||
    reason !== reason.trim() ||
    encoder.encode(reason).byteLength > MAX_REASON_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(reason)
  ) {
    fail("FEDERATION_HTTP_INPUT_INVALID", 400, "cancellation reason is invalid");
  }
  return {
    idempotencyKey: identifier(record.idempotency_key, "idempotency key"),
    reason,
  };
}

async function readChangesRequest(
  request: Request,
  maximumBytes: number,
): Promise<{
  readonly afterCursor: string;
  readonly allowedScopeRefs: readonly VersionedRef[];
}> {
  const record = exactRecord(
    await readJsonBodyWithinBytes(request, maximumBytes),
    ["after_cursor", "allowed_scope_refs"],
    "federation changes request",
  );
  if (
    typeof record.after_cursor !== "string" ||
    encoder.encode(record.after_cursor).byteLength > 8_192
  ) {
    fail("FEDERATION_HTTP_INPUT_INVALID", 400, "changes cursor is invalid");
  }
  if (
    !Array.isArray(record.allowed_scope_refs) ||
    record.allowed_scope_refs.length !== 1
  ) {
    fail(
      "FEDERATION_HTTP_INPUT_INVALID",
      400,
      "exactly one manifest-authorized scope is required",
    );
  }
  const parsed = VersionedRefSchema.safeParse(record.allowed_scope_refs[0]);
  if (!parsed.success) {
    fail("FEDERATION_HTTP_INPUT_INVALID", 400, "allowed scope is invalid");
  }
  return {
    afterCursor: record.after_cursor,
    allowedScopeRefs: [parsed.data],
  };
}

export async function dispatchFederationHttp(
  request: Request,
  env: Pick<Env, "DEPLOYMENT_GENERATION" | "FEDERATION_SERVER_PRINCIPAL_REF">,
  context: AuthenticatedRequestContext,
  match: FederationHttpMatch,
  url: URL,
  service: FederationApiV1,
): Promise<FederationHttpResult | null> {
  if (!match.operation.startsWith("federation.")) return null;
  const authority = federationContext(context, env);

  switch (match.operation) {
    case "federation.submit": {
      requireOnlyQuery(url, []);
      const parsed = FederationRequestSchema.safeParse(
        await readJsonBodyWithinBytes(request, match.maximum_request_bytes),
      );
      if (!parsed.success) {
        fail(
          "FEDERATION_HTTP_INPUT_INVALID",
          400,
          "federation request failed strict validation",
        );
      }
      return {
        kind: "json",
        body: await service.submit(authority, parsed.data as FederationRequest),
        status: 202,
      };
    }
    case "federation.status": {
      const selector = exchangeAndKey(match.params, url);
      const value = await service.status(
        authority,
        selector.exchangeId,
        selector.idempotencyKey,
      );
      if (value === null) {
        fail("FEDERATION_HTTP_NOT_FOUND", 404, "federation job was not found");
      }
      return { kind: "json", body: value, status: 200 };
    }
    case "federation.result": {
      const selector = exchangeAndKey(match.params, url);
      const value = await service.result(
        authority,
        selector.exchangeId,
        selector.idempotencyKey,
      );
      if (value === null) {
        fail("FEDERATION_HTTP_NOT_FOUND", 404, "federation result was not found");
      }
      return { kind: "json", body: value, status: 200 };
    }
    case "federation.cancel": {
      requireOnlyQuery(url, []);
      const exchangeId = identifier(match.params.exchange_id, "exchange id");
      const input = await readCancelRequest(
        request,
        match.maximum_request_bytes,
      );
      return {
        kind: "json",
        body: await service.cancel(
          authority,
          exchangeId,
          input.idempotencyKey,
          input.reason,
        ),
        status: 200,
      };
    }
    case "federation.bundle.manifest": {
      requireOnlyQuery(url, []);
      return {
        kind: "json",
        body: await service.readBundleManifest(
          authority,
          bundleRef(match.params),
        ),
        status: 200,
      };
    }
    case "federation.bundle.read": {
      requireOnlyQuery(url, []);
      const range = parseRange(request);
      const stream = await service.readBundle(
        authority,
        bundleRef(match.params),
        range,
      );
      const headers = new Headers({
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      if (range !== undefined) {
        headers.set(
          "content-range",
          `bytes ${range.start}-${range.endExclusive - 1}/*`,
        );
      }
      return {
        kind: "response",
        response: new Response(stream, {
          status: range === undefined ? 200 : 206,
          headers,
        }),
      };
    }
    case "federation.changes": {
      requireOnlyQuery(url, []);
      const input = await readChangesRequest(
        request,
        match.maximum_request_bytes,
      );
      return {
        kind: "json",
        body: await service.changes(
          authority,
          input.afterCursor,
          input.allowedScopeRefs,
        ),
        status: 200,
      };
    }
    default:
      fail(
        "FEDERATION_HTTP_OPERATION_UNAVAILABLE",
        501,
        "federation operation is not available",
      );
  }
}
