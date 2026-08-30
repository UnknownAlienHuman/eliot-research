import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";

export interface Env {
  readonly CORE_DB: D1Database;
  readonly SEARCH_DB: D1Database;
  readonly EVIDENCE_BUCKET: R2Bucket;
  readonly WORK_BUCKET: R2Bucket;
  readonly JOB_QUEUE: Queue<unknown>;
  readonly RESEARCH_SESSION: DurableObjectNamespace<ResearchSession>;
  readonly RESEARCH_WORKFLOW: Workflow;
  readonly AI_SEARCH: AiSearchNamespaceLike;
  readonly METRICS: AnalyticsEngineDataset;
  readonly ASSETS: Fetcher;
  readonly ENVIRONMENT: "development" | "staging" | "production";
  readonly DEPLOYMENT_GENERATION: string;
  readonly AI_GATEWAY_REASONING_URL: string;
  readonly AI_GATEWAY_RETRIEVAL_URL: string;
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUDIENCE?: string;
  readonly ACCESS_SERVICE_PRINCIPALS?: string;
  readonly GOOGLE_EXTERNAL_TRANSPORT?: "disabled" | "gemini-mcp" | "drive-exchange";
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
  readonly GOOGLE_TOKEN_ENCRYPTION_KEY?: string;
  readonly OWNER_NOTIFICATION_WEBHOOK?: string;
}

export interface ResearchSession {
  fetch(request: Request): Promise<Response>;
}
