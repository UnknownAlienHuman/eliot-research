export interface RouteDefinition {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly operation: string;
  readonly auth: "public" | "owner" | "service" | "owner_or_service";
  readonly maximum_request_bytes: number;
  readonly response_mode: "json" | "stream" | "handle";
}

export const ROUTES: readonly RouteDefinition[] = [
  { method: "GET", path: "/api/v1/system/session", operation: "system.session", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/healthz", operation: "system.health.public", auth: "public", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/system/health", operation: "system.health", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/system/capabilities", operation: "system.capabilities", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/research/catalog", operation: "research.catalog", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "POST", path: "/api/v1/ingest/bundles/discover", operation: "ingest.bundle.discover", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "POST", path: "/api/v1/ingest/bundles/prepare", operation: "ingest.bundle.prepare", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "PUT", path: "/api/v1/ingest/bundles/:operation_id/parts/:part_number", operation: "ingest.bundle.part.upload", auth: "owner_or_service", maximum_request_bytes: 8388608, response_mode: "json" },
  { method: "POST", path: "/api/v1/ingest/bundles/:operation_id/files/complete", operation: "ingest.bundle.file.complete", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "POST", path: "/api/v1/ingest/bundles/commit", operation: "ingest.bundle.commit", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "GET", path: "/api/v1/ingest/bundles/:operation_id/recovery", operation: "ingest.bundle.recovery", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/ingest/bundles/:operation_id", operation: "ingest.bundle.status", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "json" },
  { method: "POST", path: "/api/v1/research/orient", operation: "research.orient", auth: "owner", maximum_request_bytes: 16384, response_mode: "json" },
  { method: "GET", path: "/api/v1/research/trace/:ref", operation: "research.trace", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "POST", path: "/api/v1/research/query", operation: "research.query", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "POST", path: "/api/v1/research/run", operation: "research.run", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "handle" },
  { method: "GET", path: "/api/v1/research/open/:ref", operation: "research.open", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "stream" },
  { method: "POST", path: "/api/v1/research/verify", operation: "research.verify", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "POST", path: "/federation/v1/jobs", operation: "federation.submit", auth: "service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "GET", path: "/federation/v1/jobs/:exchange_id", operation: "federation.status", auth: "service", maximum_request_bytes: 0, response_mode: "json" },
] as const;
