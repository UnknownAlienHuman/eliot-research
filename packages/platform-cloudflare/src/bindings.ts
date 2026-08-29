export interface AiSearchItemHandleLike {
  readonly key: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface AiSearchInstanceLike {
  search(input: unknown): Promise<unknown>;
  readonly items: {
    createOrUpdate(key: string, body: unknown): Promise<unknown>;
    uploadAndPoll(key: string, body: Blob): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    get(key: string): Promise<unknown>;
  };
}

export interface AiSearchNamespaceLike {
  get(id: string): AiSearchInstanceLike;
  list(input?: unknown): Promise<unknown>;
  create(input: unknown): Promise<AiSearchInstanceLike>;
  update(id: string, input: unknown): Promise<AiSearchInstanceLike>;
  search(input: unknown): Promise<unknown>;
}

export interface CloudflareBindings {
  readonly CORE_DB: D1Database;
  readonly SEARCH_DB: D1Database;
  readonly EVIDENCE_BUCKET: R2Bucket;
  readonly WORK_BUCKET: R2Bucket;
  readonly JOB_QUEUE: Queue<unknown>;
  readonly RESEARCH_SESSION: DurableObjectNamespace;
  readonly RESEARCH_WORKFLOW: Workflow;
  readonly AI_SEARCH: AiSearchNamespaceLike;
  readonly METRICS: AnalyticsEngineDataset;
  readonly ASSETS: Fetcher;
  readonly ENVIRONMENT: "development" | "staging" | "production";
  readonly DEPLOYMENT_GENERATION: string;
  readonly AI_GATEWAY_REASONING_URL: string;
  readonly AI_GATEWAY_RETRIEVAL_URL: string;
}
