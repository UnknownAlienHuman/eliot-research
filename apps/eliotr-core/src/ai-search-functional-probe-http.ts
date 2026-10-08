import { createAiSearchGenerationRegistryService, createD1AiSearchGenerationRegistryStore } from "@eliotr/cloudflare-ai";
import {
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  type EvidenceAccessContext,
} from "@eliotr/cloudflare-evidence";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import { IdentifierSchema, type ScopeExpression } from "@eliotr/contracts";
import { createR2EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import { createD1ScopePorts } from "@eliotr/retrieval";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import type { Env } from "./env.js";
import {
  AiSearchFunctionalProbeError,
  createAiSearchFunctionalProbe,
  type AiSearchFunctionalProbeErrorCode,
} from "@eliotr/cloudflare-search-probe";
import { readReadiness } from "./readiness.js";

const MAX_QUERY_BYTES = 4096;
const MAX_IDEMPOTENCY_KEY_BYTES = 256;
const SERVER_QUERY_DEADLINE_MS = 10_000;
const REQUEST_KEYS = new Set(["project_id", "source_id", "source_revision_ref", "query"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

interface FunctionalProbeRequest {
  readonly project_id: string;
  readonly source_id: string;
  readonly source_revision_ref: string;
  readonly query: string;
}

const PROBE_ERROR_HTTP: Readonly<Record<AiSearchFunctionalProbeErrorCode, {
  readonly status: number;
  readonly retryable: boolean;
}>> = Object.freeze({
  AI_SEARCH_FUNCTIONAL_PROBE_INPUT_INVALID: { status: 400, retryable: false },
  AI_SEARCH_FUNCTIONAL_PROBE_OWNER_REQUIRED: { status: 403, retryable: false },
  AI_SEARCH_FUNCTIONAL_PROBE_SCOPE_MISMATCH: { status: 409, retryable: false },
  AI_SEARCH_FUNCTIONAL_PROBE_REGISTRY_NOT_SHADOW: { status: 409, retryable: false },
  AI_SEARCH_FUNCTIONAL_PROBE_PREBILLING_CLOSED: { status: 409, retryable: false },
  AI_SEARCH_FUNCTIONAL_PROBE_AUTHORITY_UNAVAILABLE: { status: 503, retryable: true },
});

function inputInvalid(message: string): never {
  throw new HttpRequestError("AI_SEARCH_FUNCTIONAL_PROBE_INPUT_INVALID", 400, message);
}

function boundedIdentifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success || !IDENTIFIER.test(parsed.data)) {
    inputInvalid(`${label} is invalid`);
  }
  return parsed.data;
}

function parseRequest(value: unknown): FunctionalProbeRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputInvalid("request body must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== REQUEST_KEYS.size || keys.some((key) => !REQUEST_KEYS.has(key))) {
    inputInvalid("request body has unknown or missing fields");
  }
  const query = record.query;
  if (typeof query !== "string" || query.trim().length === 0 ||
      new TextEncoder().encode(query).byteLength > MAX_QUERY_BYTES) {
    inputInvalid("query must contain 1 to 4096 UTF-8 bytes");
  }
  return Object.freeze({
    project_id: boundedIdentifier(record.project_id, "project_id"),
    source_id: boundedIdentifier(record.source_id, "source_id"),
    source_revision_ref: boundedIdentifier(record.source_revision_ref, "source_revision_ref"),
    query,
  });
}

function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (value === null || value.length === 0 ||
      new TextEncoder().encode(value).byteLength > MAX_IDEMPOTENCY_KEY_BYTES ||
      /[\u0000-\u0020\u007f]/u.test(value)) {
    inputInvalid("a valid Idempotency-Key header is required");
  }
  return value;
}

function sameAccess(left: EvidenceAccessContext, right: EvidenceAccessContext): boolean {
  return left.principal_ref === right.principal_ref && left.client_class === right.client_class &&
    left.credential_generation === right.credential_generation;
}

function mapProbeError(error: unknown): never {
  if (!(error instanceof AiSearchFunctionalProbeError)) throw error;
  const mapping = PROBE_ERROR_HTTP[error.code];
  throw new HttpRequestError(error.code, mapping.status, error.message, mapping.retryable);
}

function requireOwner(context: AuthenticatedRequestContext): asserts context is AuthenticatedRequestContext & {
  readonly client_class: "owner_pwa";
} {
  if (context.client_class !== "owner_pwa") {
    throw new HttpRequestError("AI_SEARCH_FUNCTIONAL_PROBE_OWNER_REQUIRED", 403,
      "the AI Search functional probe is owner-only");
  }
}

/** Run one bounded owner-authorized query against the exact non-active g2 shadow generation. */
export async function handleAiSearchFunctionalProbeHttp(input: {
  readonly request: Request;
  readonly env: Env;
  readonly url: URL;
  readonly context: AuthenticatedRequestContext;
  readonly maximum_request_bytes: number;
}): Promise<Response> {
  requireNoQuery(input.url);
  requireOwner(input.context);
  const readiness = await readReadiness(input.env);
  if (!readiness.ready) {
    throw new HttpRequestError("SCHEMA_NOT_READY", 503, "Required D1 migrations are not applied", true);
  }
  const body = parseRequest(await readJsonBodyWithinBytes(input.request, input.maximum_request_bytes));
  const key = idempotencyKey(input.request);
  const access: EvidenceAccessContext = Object.freeze({
    principal_ref: input.context.principal_ref,
    client_class: input.context.client_class,
    credential_generation: input.context.credential_generation,
  });
  const expression: ScopeExpression = Object.freeze({
    kind: "INTERSECT",
    left: Object.freeze({ kind: "PROJECT", project_id: body.project_id }),
    right: Object.freeze({ kind: "SELECTED_SOURCES", source_ids: [body.source_id] }),
  });
  const ownerScope = createOwnerScopeAuthority(input.env.CORE_DB, access);
  const scopes = createD1ScopeService(input.env.CORE_DB, ownerScope);
  const scopeSnapshot = await scopes.freeze(expression, access.credential_generation);
  const scopePorts = createD1ScopePorts(input.env.CORE_DB, access);
  const evidenceResolver = createCloudflareEvidenceResolver({
    authority: createD1EvidenceAuthorityPort({
      core_database: input.env.CORE_DB,
      search_database: input.env.SEARCH_DB,
    }),
    content: createR2EvidenceContentPort({ evidence_bucket: input.env.EVIDENCE_BUCKET }),
  });
  const probe = createAiSearchFunctionalProbe({
    ai_search: input.env.AI_SEARCH,
    registry: createAiSearchGenerationRegistryService(createD1AiSearchGenerationRegistryStore(input.env.SEARCH_DB)),
    work_object_store: createR2EvidenceObjectStore(input.env.WORK_BUCKET),
    require_current_scope: async (probeAccess, scope) => {
      if (!sameAccess(probeAccess, access)) throw new Error("functional probe owner context changed");
      await scopePorts.requireCurrentScope(scope);
    },
    resolve_candidate: async (probeAccess, scope, candidate) => {
      if (!sameAccess(probeAccess, access)) throw new Error("functional probe evidence context changed");
      return evidenceResolver.resolveCandidate({
        access: probeAccess,
        candidate,
        scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
      });
    },
  });
  try {
    const response = await probe.probe({
      access,
      project_id: body.project_id,
      source_id: body.source_id,
      source_revision_ref: body.source_revision_ref,
      scope_snapshot: scopeSnapshot,
      query: body.query,
      idempotency_key: key,
      deadline_ms: Date.now() + SERVER_QUERY_DEADLINE_MS,
      signal: input.request.signal,
    });
    return apiResult(input.request, input.env, response);
  } catch (error) {
    mapProbeError(error);
  }
}
