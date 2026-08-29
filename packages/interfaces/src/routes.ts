export interface RouteDefinition {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly operation: string;
  readonly auth: "public" | "owner" | "service" | "owner_or_service";
  readonly maximum_request_bytes: number;
  readonly response_mode: "json" | "stream" | "handle";
}

export const ROUTES: readonly RouteDefinition[] = [
  { method: "GET", path: "/healthz", operation: "system.health.public", auth: "public", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/system/health", operation: "system.health", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/system/capabilities", operation: "system.capabilities", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/research/catalog", operation: "research.catalog", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "POST", path: "/api/v1/ingest/bundles/prepare", operation: "ingest.bundle.prepare", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "POST", path: "/api/v1/ingest/bundles/commit", operation: "ingest.bundle.commit", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "POST", path: "/api/v1/research/query", operation: "research.query", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "POST", path: "/api/v1/research/run", operation: "research.run", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "handle" },
  { method: "GET", path: "/api/v1/research/open/:ref", operation: "research.open", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "stream" },
  { method: "POST", path: "/api/v1/research/verify", operation: "research.verify", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "POST", path: "/federation/v1/jobs", operation: "federation.submit", auth: "service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "GET", path: "/federation/v1/jobs/:exchange_id", operation: "federation.status", auth: "service", maximum_request_bytes: 0, response_mode: "json" },
] as const;
