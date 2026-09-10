export interface RouteDefinition {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly operation: string;
  readonly auth: "public" | "owner" | "service" | "owner_or_service";
  readonly maximum_request_bytes: number;
  readonly response_mode: "json" | "stream" | "handle" | "redirect";
}

export const ROUTES: readonly RouteDefinition[] = [
  { method: "GET", path: "/api/v1/system/session", operation: "system.session", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/healthz", operation: "system.health.public", auth: "public", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/system/health", operation: "system.health", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/system/capabilities", operation: "system.capabilities", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/library/revisions", operation: "library.source.revisions", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/library/readiness", operation: "library.active.readiness", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/research/catalog", operation: "research.catalog", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "POST", path: "/api/v1/ingest/bundles/discover", operation: "ingest.bundle.discover", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "POST", path: "/api/v1/ingest/raw", operation: "ingest.raw.capture", auth: "owner", maximum_request_bytes: 16 * 1024 * 1024, response_mode: "json" },
  { method: "GET", path: "/api/v1/ingest/raw", operation: "ingest.raw.read", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/ingest/raw/:capture_id", operation: "ingest.raw.read", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "POST", path: "/api/v1/ingest/raw/:capture_id/markdown", operation: "ingest.raw.markdown", auth: "owner", maximum_request_bytes: 16384, response_mode: "json" },
  { method: "POST", path: "/api/v1/ingest/raw/:capture_id/admission", operation: "ingest.raw.normalized.admit", auth: "owner", maximum_request_bytes: 16384, response_mode: "json" },
  { method: "GET", path: "/api/v1/ingest/raw/:capture_id/admission/:admission_operation_id", operation: "ingest.raw.normalized.status", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "POST", path: "/api/v1/ingest/bundles/prepare", operation: "ingest.bundle.prepare", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "PUT", path: "/api/v1/ingest/bundles/:operation_id/parts/:part_number", operation: "ingest.bundle.part.upload", auth: "owner_or_service", maximum_request_bytes: 8388608, response_mode: "json" },
  { method: "POST", path: "/api/v1/ingest/bundles/:operation_id/files/complete", operation: "ingest.bundle.file.complete", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "POST", path: "/api/v1/ingest/bundles/commit", operation: "ingest.bundle.commit", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "GET", path: "/api/v1/ingest/bundles/:operation_id/recovery", operation: "ingest.bundle.recovery", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/ingest/bundles/:operation_id", operation: "ingest.bundle.status", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "json" },
  { method: "POST", path: "/api/v1/research/orient", operation: "research.orient", auth: "owner", maximum_request_bytes: 16384, response_mode: "json" },
  { method: "GET", path: "/api/v1/research/trace/:ref", operation: "research.trace", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/research/artifact/:ref", operation: "research.artifact", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "POST", path: "/api/v1/research/query", operation: "research.query", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "GET", path: "/api/v1/research/query/jobs", operation: "research.query", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/research/query/:workflow_id", operation: "research.query", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "json" },
  { method: "DELETE", path: "/api/v1/research/query/:workflow_id", operation: "research.query", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "json" },
  { method: "POST", path: "/api/v1/research/run", operation: "research.run", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "handle" },
  { method: "GET", path: "/api/v1/research/run/:workflow_id", operation: "research.run", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/research/open/:ref", operation: "research.open", auth: "owner_or_service", maximum_request_bytes: 0, response_mode: "stream" },
  { method: "POST", path: "/api/v1/research/verify", operation: "research.verify", auth: "owner_or_service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "POST", path: "/api/v1/google/oauth/begin", operation: "google.oauth.begin", auth: "owner", maximum_request_bytes: 1024, response_mode: "json" },
  { method: "POST", path: "/api/v1/google/oauth/reconnect", operation: "google.oauth.reconnect", auth: "owner", maximum_request_bytes: 1536, response_mode: "json" },
  { method: "GET", path: "/api/v1/google/connection/status", operation: "google.connection.status", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "POST", path: "/api/v1/google/connection/disconnect", operation: "google.connection.disconnect", auth: "owner", maximum_request_bytes: 1536, response_mode: "json" },
  { method: "GET", path: "/oauth/google/callback", operation: "google.oauth.callback", auth: "owner", maximum_request_bytes: 0, response_mode: "redirect" },
  { method: "POST", path: "/federation/v1/jobs", operation: "federation.submit", auth: "service", maximum_request_bytes: 262144, response_mode: "json" },
  { method: "GET", path: "/federation/v1/jobs/:exchange_id", operation: "federation.status", auth: "service", maximum_request_bytes: 0, response_mode: "json" },
] as const;
