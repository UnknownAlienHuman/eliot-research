import {
  OWNER_E2E_AUDIENCE,
  OWNER_E2E_CERTS_PATH,
  OWNER_E2E_ISSUER,
  resolveOwnerE2ETestFetch as resolveAccessOwnerE2ETestFetch,
} from "@eliotr/cloudflare-access";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import type { WorkersAiMarkdownBinding } from "@eliotr/cloudflare-markdown";
import type { InstalledSemanticConfigurationEnvironment } from "@eliotr/cloudflare-research-configuration";

export interface Env extends InstalledSemanticConfigurationEnvironment {
  readonly CORE_DB: D1Database;
  readonly SEARCH_DB: D1Database;
  readonly EVIDENCE_BUCKET: R2Bucket;
  readonly WORK_BUCKET: R2Bucket;
  /** Dedicated O2 backup-part bucket; never aliased from WORK_BUCKET. */
  readonly BACKUP_PARTS_BUCKET?: R2Bucket;
  /** Cloudflare-supplied active code version for privileged backup readback. */
  readonly VERSION_METADATA?: WorkerVersionMetadata;
  readonly JOB_QUEUE: Queue<unknown>;
  readonly RESEARCH_SESSION: DurableObjectNamespace;
  readonly RESEARCH_WORKFLOW: Workflow;
  readonly AI_SEARCH: AiSearchNamespaceLike;
  readonly AI?: (WorkersAiMarkdownBinding & Partial<Pick<Ai, "models">>) | undefined;
  readonly METRICS: AnalyticsEngineDataset;
  readonly ASSETS: Fetcher;
  readonly ENVIRONMENT: "development" | "staging" | "production";
  readonly DEPLOYMENT_GENERATION: string;
  readonly FEDERATION_SERVER_PRINCIPAL_REF?: string;
  readonly FEDERATION_CURSOR_HMAC_KEY?: string;
  readonly AI_GATEWAY_REASONING_URL: string;
  readonly AI_GATEWAY_RETRIEVAL_URL: string;
  /** Optional server-held Cloudflare AI Gateway credential; never exposed to callers. */
  readonly ELIOTR_MODEL_GATEWAY_TOKEN?: string | undefined;
  /** Dedicated read-only Dynamic Route control-plane credential; never used for model calls. */
  readonly ELIOTR_MODEL_GATEWAY_READ_TOKEN?: string;
  /** Dedicated server-only Cloudflare API credential for provider-key management; never caller supplied or used for model calls. */
  readonly ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN?: string;
  /** Installed server model definition and its provenance; no request may override either. */
  readonly ELIOTR_MODEL_PROFILE_DEFINITION_JSON?: string | undefined;
  readonly ELIOTR_MODEL_PROFILE_PROVENANCE_REF?: string | undefined;
  /** Operator-approved transport policies used before exact model qualification. */
  readonly ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON?: string;
  /** Explicit approved model spend policy; no browser field selects it. */
  readonly ELIOTR_MODEL_SPEND_POLICY_JSON?: string | undefined;
  readonly ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF?: string | undefined;
  readonly ELIOTR_RESEARCH_REPORT_CONFIG_JSON?: string | undefined;
  /** Explicit owner-bound policy authorizing private report materialization. */
  readonly ELIOTR_RESEARCH_REPORT_POLICY_JSON?: string;
  readonly ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF?: string | undefined;
  /** Installed owner-to-MCP import delegation, scoped to exact principals and namespace. */
  readonly ELIOTR_WORKSPACE_OWNER_BINDINGS_JSON?: string;
  readonly ELIOTR_NAMESPACE_BOOTSTRAP_PROFILES_JSON?: string;
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUDIENCE?: string | undefined;
  readonly ACCESS_SERVICE_PRINCIPALS?: string;
  /** Development-only loopback JWKS endpoint for the real signed local harness. */
  readonly ACCESS_TEST_JWKS_URL?: string;
  readonly MCP_HOSTNAME?: string | undefined;
  readonly MCP_ACCESS_TEAM_DOMAIN?: string | undefined;
  readonly MCP_ACCESS_AUDIENCE?: string | undefined;
  /** Dedicated MCP authentication profile; omitted means the legacy service-token profile. */
  readonly MCP_ACCESS_AUTH_PROFILE?: "service-token" | "managed-oauth" | undefined;
  readonly MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID?: string | undefined;
  /** Additional independent MCP clients; array binding or JSON-encoded array, no secrets. */
  readonly MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS?: readonly string[] | string | undefined;
  readonly GOOGLE_EXTERNAL_TRANSPORT?: "disabled" | "gemini-mcp" | "drive-exchange" | undefined;
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
  readonly GOOGLE_TOKEN_ENCRYPTION_KEY?: string;
  /** Unpadded base64url-encoded 32-byte HMAC key for authenticated research-change cursors. */
  readonly RESEARCH_CHANGES_CURSOR_KEY?: string;
  /** Active AES-GCM key version for Google OAuth intent/grant ciphertext. Defaults to 1. */
  readonly GOOGLE_TOKEN_KEY_VERSION?: string;
  /** Server-owned G1 OAuth admission configuration; never accepted from request bodies. */
  readonly GOOGLE_OAUTH_CONNECTION_ID?: string;
  readonly GOOGLE_OAUTH_REDIRECT_URI?: string;
  readonly GOOGLE_OAUTH_GOOGLE_SUBJECT?: string;
  readonly GOOGLE_OAUTH_GOOGLE_EMAIL?: string;
  /** Explicit operator attestation that the OAuth client is published (Production). */
  readonly GOOGLE_OAUTH_PRODUCTION_EVIDENCE_REF?: string;
  /** Optional installed R2 offsite transport; destination authority remains in D1. */
  readonly ELIOTR_BACKUP_OFFSITE_R2_CONFIG_JSON?: string;
  /** Server credentials for the installed offsite transport; never caller fields. */
  readonly ELIOTR_BACKUP_OFFSITE_R2_ACCESS_KEY_ID?: string;
  readonly ELIOTR_BACKUP_OFFSITE_R2_SECRET_ACCESS_KEY?: string;
  readonly OWNER_NOTIFICATION_WEBHOOK?: string;
}

export { readResearchSemanticConfiguration } from "@eliotr/cloudflare-research-configuration";

export { OWNER_E2E_AUDIENCE, OWNER_E2E_CERTS_PATH, OWNER_E2E_ISSUER };

export { parseServicePrincipals } from "@eliotr/cloudflare-access";

export function resolveOwnerE2ETestFetch(env: Env, certsUrl: string): typeof fetch | undefined {
  return resolveAccessOwnerE2ETestFetch(env, certsUrl);
}
