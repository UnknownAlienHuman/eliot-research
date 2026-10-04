import { IdentifierSchema } from "@eliotr/contracts";
import type {
  AuthenticatedRequestContext,
  FederationApiV1,
  FederationAuthenticatedContext,
} from "@eliotr/interfaces";
import {
  dispatchFederationHttp as dispatchFederationHttpInLibrary,
  FederationHttpError,
  type FederationHttpMatch,
  type FederationHttpResult,
} from "@eliotr/cloudflare-federation";
import type { Env } from "./env.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";

const MAX_HEADER_BYTES = 2_048;
const encoder = new TextEncoder();

export { FederationHttpError };
export type { FederationHttpMatch, FederationHttpResult };

function fail(code: string, status: number, message: string, retryable = false): never {
  throw new FederationHttpError(code, status, message, retryable);
}

function boundedText(value: string | null, label: string, required = true): string | undefined {
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
  if (!parsed.success) fail("FEDERATION_HTTP_INPUT_INVALID", 400, `${label} is invalid`);
  return parsed.data;
}

function positiveRevision(value: string | undefined, label: string): number {
  const parsed = value !== undefined && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1) {
    fail("FEDERATION_HTTP_INPUT_INVALID", 400, `${label} is invalid`);
  }
  return parsed as number;
}

/** Core owns authenticated request and Worker configuration adaptation. */
function federationContext(
  context: AuthenticatedRequestContext,
  env: Pick<Env, "DEPLOYMENT_GENERATION" | "FEDERATION_SERVER_PRINCIPAL_REF">,
): FederationAuthenticatedContext {
  if (context.client_class !== "federation_client") {
    fail("FEDERATION_HTTP_AUTH_REQUIRED", 403, "federation route requires a service principal");
  }
  if (env.FEDERATION_SERVER_PRINCIPAL_REF === undefined) {
    fail("FEDERATION_HTTP_CONFIG_INVALID", 503, "federation server identity is not configured", true);
  }
  const serverPrincipal = identifier(env.FEDERATION_SERVER_PRINCIPAL_REF, "federation server principal");
  const generation = identifier(env.DEPLOYMENT_GENERATION, "federation server generation");
  const clientFence = identifier(
    boundedText(context.request.headers.get("x-eliotr-client-fence-ref"), "x-eliotr-client-fence-ref"),
    "client fence",
  );
  const manifestId = identifier(
    boundedText(context.request.headers.get("x-eliotr-reference-manifest-id"), "x-eliotr-reference-manifest-id"),
    "reference manifest id",
  );
  const manifestRevision = positiveRevision(
    boundedText(context.request.headers.get("x-eliotr-reference-manifest-revision"), "x-eliotr-reference-manifest-revision"),
    "reference manifest revision",
  );
  return {
    request: context.request,
    principal_ref: identifier(context.principal_ref, "requester principal"),
    client_class: "federation_client",
    credential_generation: identifier(context.credential_generation, "requester credential generation"),
    client_fence_ref: clientFence,
    allowed_reference_manifest_ref: { id: manifestId, revision: manifestRevision },
    server_principal_ref: serverPrincipal,
    server_credential_generation: generation,
    trace_id: identifier(context.trace_id, "trace id"),
  };
}

export function dispatchFederationHttp(
  request: Request,
  env: Pick<Env, "DEPLOYMENT_GENERATION" | "FEDERATION_SERVER_PRINCIPAL_REF">,
  context: AuthenticatedRequestContext,
  match: FederationHttpMatch,
  url: URL,
  service: FederationApiV1,
): Promise<FederationHttpResult | null> {
  if (!match.operation.startsWith("federation.")) return Promise.resolve(null);
  return dispatchFederationHttpInLibrary(
    request,
    federationContext(context, env),
    match,
    url,
    service,
    readJsonBodyWithinBytes,
  );
}
