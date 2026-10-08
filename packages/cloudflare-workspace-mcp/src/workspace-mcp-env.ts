import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";

/** Static MCP read set plus required Worker Env bindings used by full-Env Core callbacks. */
export interface WorkspaceMcpEnvironmentSource<
  AiBinding,
> {
  readonly CORE_DB: D1Database;
  readonly SEARCH_DB: D1Database;
  readonly EVIDENCE_BUCKET: R2Bucket;
  readonly WORK_BUCKET: R2Bucket;
  readonly JOB_QUEUE: Queue<unknown>;
  readonly RESEARCH_SESSION: DurableObjectNamespace;
  readonly RESEARCH_WORKFLOW: Workflow;
  readonly AI_SEARCH: AiSearchNamespaceLike;
  readonly AI?: AiBinding | undefined;
  readonly METRICS: AnalyticsEngineDataset;
  readonly ASSETS: Fetcher;
  readonly ENVIRONMENT: "development" | "staging" | "production";
  readonly DEPLOYMENT_GENERATION: string;
  readonly AI_GATEWAY_REASONING_URL: string;
  readonly AI_GATEWAY_RETRIEVAL_URL: string;
  readonly ELIOTR_MODEL_GATEWAY_TOKEN?: string | undefined;
  readonly ELIOTR_MODEL_PROFILE_DEFINITION_JSON?: string | undefined;
  readonly ELIOTR_MODEL_PROFILE_PROVENANCE_REF?: string | undefined;
  readonly ELIOTR_MODEL_SPEND_POLICY_JSON?: string | undefined;
  readonly ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF?: string | undefined;
  readonly ELIOTR_RESEARCH_REPORT_CONFIG_JSON?: string | undefined;
  readonly ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF?: string | undefined;
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF?: string | undefined;
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256?: string | undefined;
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON?: string | undefined;
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0?: string | undefined;
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1?: string | undefined;
  readonly ACCESS_AUDIENCE?: string | undefined;
  readonly GOOGLE_EXTERNAL_TRANSPORT?: "disabled" | "gemini-mcp" | "drive-exchange" | undefined;
  readonly MCP_HOSTNAME?: string | undefined;
  readonly MCP_ACCESS_AUTH_PROFILE?: "service-token" | "managed-oauth" | undefined;
  readonly MCP_ACCESS_TEAM_DOMAIN?: string | undefined;
  readonly MCP_ACCESS_AUDIENCE?: string | undefined;
  readonly MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID?: string | undefined;
  readonly MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS?: readonly string[] | string | undefined;
}

/** A detached top-level value copy; binding objects intentionally retain their identity. */
export interface WorkspaceMcpEnvironmentProjection<
  AiBinding,
> {
  readonly CORE_DB: D1Database;
  readonly SEARCH_DB: D1Database;
  readonly EVIDENCE_BUCKET: R2Bucket;
  readonly WORK_BUCKET: R2Bucket;
  readonly JOB_QUEUE: Queue<unknown>;
  readonly RESEARCH_SESSION: DurableObjectNamespace;
  readonly RESEARCH_WORKFLOW: Workflow;
  readonly AI_SEARCH: AiSearchNamespaceLike;
  readonly AI: AiBinding | undefined;
  readonly METRICS: AnalyticsEngineDataset;
  readonly ASSETS: Fetcher;
  readonly ENVIRONMENT: "development" | "staging" | "production";
  readonly DEPLOYMENT_GENERATION: string;
  readonly AI_GATEWAY_REASONING_URL: string;
  readonly AI_GATEWAY_RETRIEVAL_URL: string;
  readonly ELIOTR_MODEL_GATEWAY_TOKEN: string | undefined;
  readonly ELIOTR_MODEL_PROFILE_DEFINITION_JSON: string | undefined;
  readonly ELIOTR_MODEL_PROFILE_PROVENANCE_REF: string | undefined;
  readonly ELIOTR_MODEL_SPEND_POLICY_JSON: string | undefined;
  readonly ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: string | undefined;
  readonly ELIOTR_RESEARCH_REPORT_CONFIG_JSON: string | undefined;
  readonly ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: string | undefined;
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: string | undefined;
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: string | undefined;
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: string | undefined;
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0: string | undefined;
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1: string | undefined;
  readonly ACCESS_AUDIENCE: string | undefined;
  readonly GOOGLE_EXTERNAL_TRANSPORT: "disabled" | "gemini-mcp" | "drive-exchange" | undefined;
  readonly MCP_HOSTNAME: string | undefined;
  readonly MCP_ACCESS_AUTH_PROFILE: "service-token" | "managed-oauth" | undefined;
  readonly MCP_ACCESS_TEAM_DOMAIN: string | undefined;
  readonly MCP_ACCESS_AUDIENCE: string | undefined;
  readonly MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: string | undefined;
  readonly MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: readonly string[] | string | undefined;
}

/** Copy the explicit MCP view and required Env compatibility bindings; omit unrelated optionals. */
export function projectWorkspaceMcpEnvironment<
  AiBinding,
>(source: WorkspaceMcpEnvironmentSource<AiBinding>):
  WorkspaceMcpEnvironmentProjection<AiBinding> {
  return {
    CORE_DB: source.CORE_DB,
    SEARCH_DB: source.SEARCH_DB,
    EVIDENCE_BUCKET: source.EVIDENCE_BUCKET,
    WORK_BUCKET: source.WORK_BUCKET,
    JOB_QUEUE: source.JOB_QUEUE,
    RESEARCH_SESSION: source.RESEARCH_SESSION,
    RESEARCH_WORKFLOW: source.RESEARCH_WORKFLOW,
    AI_SEARCH: source.AI_SEARCH,
    AI: source.AI,
    METRICS: source.METRICS,
    ASSETS: source.ASSETS,
    ENVIRONMENT: source.ENVIRONMENT,
    DEPLOYMENT_GENERATION: source.DEPLOYMENT_GENERATION,
    AI_GATEWAY_REASONING_URL: source.AI_GATEWAY_REASONING_URL,
    AI_GATEWAY_RETRIEVAL_URL: source.AI_GATEWAY_RETRIEVAL_URL,
    ELIOTR_MODEL_GATEWAY_TOKEN: source.ELIOTR_MODEL_GATEWAY_TOKEN,
    ELIOTR_MODEL_PROFILE_DEFINITION_JSON: source.ELIOTR_MODEL_PROFILE_DEFINITION_JSON,
    ELIOTR_MODEL_PROFILE_PROVENANCE_REF: source.ELIOTR_MODEL_PROFILE_PROVENANCE_REF,
    ELIOTR_MODEL_SPEND_POLICY_JSON: source.ELIOTR_MODEL_SPEND_POLICY_JSON,
    ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: source.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF,
    ELIOTR_RESEARCH_REPORT_CONFIG_JSON: source.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
    ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: source.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: source.ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: source.ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: source.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0: source.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1: source.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1,
    ACCESS_AUDIENCE: source.ACCESS_AUDIENCE,
    GOOGLE_EXTERNAL_TRANSPORT: source.GOOGLE_EXTERNAL_TRANSPORT,
    MCP_HOSTNAME: source.MCP_HOSTNAME,
    MCP_ACCESS_AUTH_PROFILE: source.MCP_ACCESS_AUTH_PROFILE,
    MCP_ACCESS_TEAM_DOMAIN: source.MCP_ACCESS_TEAM_DOMAIN,
    MCP_ACCESS_AUDIENCE: source.MCP_ACCESS_AUDIENCE,
    MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: source.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID,
    MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: source.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS,
  };
}
