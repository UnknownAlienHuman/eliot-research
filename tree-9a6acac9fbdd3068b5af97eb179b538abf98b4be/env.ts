import { AccessVerificationError, type AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import type { WorkersAiMarkdownBinding } from "@eliotr/cloudflare-markdown";

export interface Env {
  readonly CORE_DB: D1Database;
  readonly SEARCH_DB: D1Database;
  readonly EVIDENCE_BUCKET: R2Bucket;
  readonly WORK_BUCKET: R2Bucket;
  readonly JOB_QUEUE: Queue<unknown>;
  readonly RESEARCH_SESSION: DurableObjectNamespace;
  readonly RESEARCH_WORKFLOW: Workflow;
  readonly AI_SEARCH: AiSearchNamespaceLike;
  readonly AI?: WorkersAiMarkdownBinding;
  readonly METRICS: AnalyticsEngineDataset;
  readonly ASSETS: Fetcher;
  readonly ENVIRONMENT: "development" | "staging" | "production";
  readonly DEPLOYMENT_GENERATION: string;
  readonly AI_GATEWAY_REASONING_URL: string;
  readonly AI_GATEWAY_RETRIEVAL_URL: string;
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUDIENCE?: string;
  readonly ACCESS_SERVICE_PRINCIPALS?: string;
  /** Development-only loopback JWKS endpoint for the real signed local harness. */
  readonly ACCESS_TEST_JWKS_URL?: string;
  readonly MCP_HOSTNAME?: string;
  readonly MCP_ACCESS_TEAM_DOMAIN?: string;
  readonly MCP_ACCESS_AUDIENCE?: string;
  readonly MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID?: string;
  readonly GOOGLE_EXTERNAL_TRANSPORT?: "disabled" | "gemini-mcp" | "drive-exchange";
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
  readonly GOOGLE_TOKEN_ENCRYPTION_KEY?: string;
  /** Active AES-GCM key version for Google OAuth intent/grant ciphertext. Defaults to 1. */
  readonly GOOGLE_TOKEN_KEY_VERSION?: string;
  /** Server-owned G1 OAuth admission configuration; never accepted from request bodies. */
  readonly GOOGLE_OAUTH_CONNECTION_ID?: string;
  readonly GOOGLE_OAUTH_REDIRECT_URI?: string;
  readonly GOOGLE_OAUTH_GOOGLE_SUBJECT?: string;
  readonly GOOGLE_OAUTH_GOOGLE_EMAIL?: string;
  /** Explicit operator attestation that the OAuth client is published (Production). */
  readonly GOOGLE_OAUTH_PRODUCTION_EVIDENCE_REF?: string;
  readonly OWNER_NOTIFICATION_WEBHOOK?: string;
}

export const OWNER_E2E_ISSUER = ["https://owner-e2e", ".cloudflareaccess.com"].join("");
export const OWNER_E2E_AUDIENCE = "owner-e2e-audience";
export const OWNER_E2E_CERTS_PATH = "/cdn-cgi/access/certs";

export function parseServicePrincipals(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length > 64 || new Set(values).size !== values.length) {
    throw new AccessVerificationError("ACCESS_CONFIG_INVALID",
      "ACCESS_SERVICE_PRINCIPALS must contain at most 64 unique values", true);
  }
  return values;
}

function failConfig(message: string): never {
  throw new AccessVerificationError("ACCESS_CONFIG_INVALID", message, true);
}

function validatedLoopbackJwksUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { failConfig("Access test JWKS URL is malformed"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username !== "" ||
      url.password !== "" || url.pathname !== OWNER_E2E_CERTS_PATH || url.search !== "" ||
      url.hash !== "") {
    failConfig("Access test JWKS URL must be loopback http://127.0.0.1:<port>/cdn-cgi/access/certs");
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    failConfig("Access test JWKS port is outside its allowed range");
  }
  return url;
}

export function resolveOwnerE2ETestFetch(env: Env, certsUrl: string): typeof fetch | undefined {
  const override = env.ACCESS_TEST_JWKS_URL;
  if (override === undefined || override === "") return undefined;
  if (env.ENVIRONMENT !== "development") {
    failConfig("Access test JWKS override is development-only; staging/production must use the real network verifier");
  }
  if (env.ACCESS_TEAM_DOMAIN !== OWNER_E2E_ISSUER || env.ACCESS_AUDIENCE !== OWNER_E2E_AUDIENCE) {
    failConfig("Access test JWKS override outside the exact owner-e2e profile is denied");
  }
  if (certsUrl !== `${OWNER_E2E_ISSUER}${OWNER_E2E_CERTS_PATH}`) {
    failConfig("Access test profile expects the exact controlled certs URL");
  }
  const target = validatedLoopbackJwksUrl(override);
  const destination = target.toString();
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requested = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (requested !== certsUrl) {
      throw new AccessVerificationError("ACCESS_JWKS_UNAVAILABLE",
        "Access test fetch denies non-certs requests", true);
    }
    void init;
    const response = await globalThis.fetch(destination);
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new AccessVerificationError("ACCESS_JWKS_UNAVAILABLE",
        "Access test JWKS redirect denied", true);
    }
    return response;
  };
}
