import type {
  ApplicationLifecycle,
  CatalogRequest,
  CatalogResult,
  FederationApi,
  OwnerApi,
  SemanticApi,
} from "@eliotr/interfaces";
import { ROUTES } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { readReadiness } from "./readiness.js";

export interface CompositionRootInput {
  readonly env: Env;
  readonly executionContext: ExecutionContext;
}

export class CapabilityUnavailableError extends Error {
  public readonly code = "IMPLEMENTATION_SLICE_PENDING";
  public readonly operation: string;
  public readonly retryable = false;

  public constructor(operation: string) {
    super(`Capability ${operation} is unavailable in the active Worker generation`);
    this.name = "CapabilityUnavailableError";
    this.operation = operation;
  }
}

export class CatalogInputError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "CatalogInputError";
    this.code = code;
  }
}

const MAX_CATALOG_LIMIT = 100;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_TITLE_BYTES = 4 * 1024;
const MAX_CURSOR_BYTES = 2 * 1024;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

interface CatalogCursorV1 {
  readonly version: 1;
  readonly project_id: string | null;
  readonly project_after: string;
  readonly source_after: string;
}

interface ProjectRow {
  readonly id: unknown;
  readonly title: unknown;
  readonly generation: unknown;
}

interface SourceRow {
  readonly id: unknown;
  readonly title: unknown;
  readonly head_rev: unknown;
}

function unavailable(operation: string): Promise<never> {
  return Promise.reject(new CapabilityUnavailableError(operation));
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateAuthorityString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    utf8Length(value) > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`catalog authority returned invalid ${label}`);
  }
  return value;
}

function validateAuthorityIdentifier(value: unknown, label: string): string {
  const identifier = validateAuthorityString(value, label, MAX_IDENTIFIER_BYTES);
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new Error(`catalog authority returned invalid ${label}`);
  }
  return identifier;
}

function validateRequestIdentifier(value: unknown, label: string): string {
  try {
    return validateAuthorityIdentifier(value, label);
  } catch {
    throw new CatalogInputError("CATALOG_IDENTIFIER_INVALID", `${label} is invalid`);
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || utf8Length(value) > MAX_CURSOR_BYTES) {
    throw new CatalogInputError("CATALOG_CURSOR_INVALID", "catalog cursor is invalid");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new CatalogInputError("CATALOG_CURSOR_INVALID", "catalog cursor is not decodable");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) {
    throw new CatalogInputError("CATALOG_CURSOR_INVALID", "catalog cursor is not canonical base64url");
  }
  return bytes;
}

function encodeCursor(cursor: CatalogCursorV1): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

function decodeCursor(raw: string | undefined, projectId: string | undefined): CatalogCursorV1 {
  if (raw === undefined) {
    return {
      version: 1,
      project_id: projectId ?? null,
      project_after: "",
      source_after: "",
    };
  }

  let decoded: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(raw));
    decoded = JSON.parse(text);
  } catch (error) {
    if (error instanceof CatalogInputError) throw error;
    throw new CatalogInputError("CATALOG_CURSOR_INVALID", "catalog cursor is not UTF-8 JSON");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new CatalogInputError("CATALOG_CURSOR_INVALID", "catalog cursor must be an object");
  }
  const record = decoded as Record<string, unknown>;
  const allowed = new Set(["version", "project_id", "project_after", "source_after"]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || record.version !== 1) {
    throw new CatalogInputError("CATALOG_CURSOR_INVALID", "catalog cursor has unsupported fields");
  }
  const cursorProject = record.project_id === null
    ? null
    : validateRequestIdentifier(record.project_id, "cursor project_id");
  if (cursorProject !== (projectId ?? null)) {
    throw new CatalogInputError("CATALOG_CURSOR_SCOPE_MISMATCH", "catalog cursor belongs to another project scope");
  }
  const projectAfter = record.project_after === ""
    ? ""
    : validateRequestIdentifier(record.project_after, "cursor project_after");
  const sourceAfter = record.source_after === ""
    ? ""
    : validateRequestIdentifier(record.source_after, "cursor source_after");
  return {
    version: 1,
    project_id: cursorProject,
    project_after: projectAfter,
    source_after: sourceAfter,
  };
}

function validateCatalogRequest(request: CatalogRequest): {
  readonly limit: number;
  readonly projectId?: string;
  readonly cursor: CatalogCursorV1;
} {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > MAX_CATALOG_LIMIT) {
    throw new CatalogInputError(
      "CATALOG_LIMIT_INVALID",
      `catalog limit must be an integer in [1, ${MAX_CATALOG_LIMIT}]`,
    );
  }
  const projectId = request.project_id === undefined
    ? undefined
    : validateRequestIdentifier(request.project_id, "project_id");
  const cursor = decodeCursor(request.cursor, projectId);
  return projectId === undefined
    ? { limit: request.limit, cursor }
    : { limit: request.limit, projectId, cursor };
}

function decodeProjects(rows: readonly ProjectRow[]): CatalogResult["projects"] {
  return rows.map((row) => {
    const generation = typeof row.generation === "number" || typeof row.generation === "string"
      ? String(row.generation)
      : "";
    return {
      id: validateAuthorityIdentifier(row.id, "project id"),
      title: validateAuthorityString(row.title, "project title", MAX_TITLE_BYTES),
      generation: validateAuthorityIdentifier(generation, "project generation"),
    };
  });
}

function decodeSources(rows: readonly SourceRow[]): CatalogResult["sources"] {
  return rows.map((row) => {
    const id = validateAuthorityIdentifier(row.id, "source id");
    const headRevision = validateAuthorityIdentifier(row.head_rev, "source head revision");
    return {
      id,
      title: validateAuthorityString(row.title, "source title", MAX_TITLE_BYTES),
      readiness_ref: `readiness:${id}:${headRevision}`,
    };
  });
}

async function readCatalog(database: D1Database, request: CatalogRequest): Promise<CatalogResult> {
  const validated = validateCatalogRequest(request);
  const queryLimit = validated.limit + 1;
  const projectStatement = validated.projectId === undefined
    ? database.prepare(
      "SELECT project_id AS id, title, generation " +
      "FROM project WHERE project_id > ?1 ORDER BY project_id LIMIT ?2",
    ).bind(validated.cursor.project_after, queryLimit)
    : database.prepare(
      "SELECT project_id AS id, title, generation " +
      "FROM project WHERE project_id = ?1 AND project_id > ?2 ORDER BY project_id LIMIT ?3",
    ).bind(validated.projectId, validated.cursor.project_after, queryLimit);

  const sourceStatement = validated.projectId === undefined
    ? database.prepare(
      "SELECT s.source_id AS id, s.title, s.head_rev " +
      "FROM source s JOIN source_revision r " +
      "ON r.source_revision_ref = s.head_rev AND r.source_id = s.source_id " +
      "WHERE r.purge_state = 'LIVE' AND s.source_id > ?1 " +
      "ORDER BY s.source_id LIMIT ?2",
    ).bind(validated.cursor.source_after, queryLimit)
    : database.prepare(
      "SELECT DISTINCT s.source_id AS id, s.title, s.head_rev " +
      "FROM source s JOIN source_revision r " +
      "ON r.source_revision_ref = s.head_rev AND r.source_id = s.source_id " +
      "JOIN project_source_membership m ON m.source_id = s.source_id " +
      "WHERE m.project_id = ?1 AND m.valid_to IS NULL " +
      "AND r.purge_state = 'LIVE' AND s.source_id > ?2 " +
      "ORDER BY s.source_id LIMIT ?3",
    ).bind(validated.projectId, validated.cursor.source_after, queryLimit);

  const [projectResult, sourceResult] = await Promise.all([
    projectStatement.all<ProjectRow>(),
    sourceStatement.all<SourceRow>(),
  ]);
  if (projectResult.success === false || sourceResult.success === false) {
    throw new Error("catalog D1 query returned an unsuccessful result");
  }
  const allProjects = decodeProjects(projectResult.results ?? []);
  const allSources = decodeSources(sourceResult.results ?? []);
  const hasMoreProjects = allProjects.length > validated.limit;
  const hasMoreSources = allSources.length > validated.limit;
  const projects = allProjects.slice(0, validated.limit);
  const sources = allSources.slice(0, validated.limit);
  if (!hasMoreProjects && !hasMoreSources) return { projects, sources };
  return {
    projects,
    sources,
    next_cursor: encodeCursor({
      version: 1,
      project_id: validated.projectId ?? null,
      project_after: projects.at(-1)?.id ?? validated.cursor.project_after,
      source_after: sources.at(-1)?.id ?? validated.cursor.source_after,
    }),
  };
}

function capabilities(env: Env): Record<string, unknown> {
  return {
    protocol: "eliotr.capabilities.v1",
    deployment_generation: env.DEPLOYMENT_GENERATION,
    enabled_slices: ["HEALTH", "ACCESS", "CATALOG"],
    disabled_slices: ["INGEST", "RETRIEVAL", "RESEARCH", "WIKI", "DRIVE_EXCHANGE", "ERASURE"],
    routes: ROUTES,
    exact_evidence_resolution_required: true,
    transport_completion_is_research_completion: false,
  };
}

function semanticApi(env: Env): SemanticApi {
  return {
    catalog: (_context, request) => readCatalog(env.CORE_DB, request),
    orient: () => unavailable("research.orient"),
    query: () => unavailable("research.query"),
    open: () => unavailable("research.open"),
    verify: () => unavailable("research.verify"),
    run: () => unavailable("research.run"),
    artifact: () => unavailable("research.artifact"),
    proposeWiki: () => unavailable("research.wiki.propose"),
    trace: () => unavailable("research.trace"),
    changes: () => unavailable("research.changes"),
  };
}

function federationApi(): FederationApi {
  return {
    submit: () => unavailable("federation.submit"),
    status: () => unavailable("federation.status"),
    result: () => unavailable("federation.result"),
    cancel: () => unavailable("federation.cancel"),
  };
}

function ownerApi(env: Env): OwnerApi {
  return {
    prepareBundle: () => unavailable("ingest.bundle.prepare"),
    commitBundle: () => unavailable("ingest.bundle.commit"),
    async systemHealth(): Promise<Record<string, unknown>> {
      return { ...await readReadiness(env) };
    },
    async systemCapabilities(): Promise<Record<string, unknown>> {
      return capabilities(env);
    },
  };
}

async function countPendingOutbox(database: D1Database): Promise<number> {
  const row = await database.prepare(
    "SELECT COUNT(*) AS pending_count FROM outbox " +
    "WHERE state IN ('PENDING','LEASED','FAILED')",
  ).first<{ pending_count: number }>();
  const count = row?.pending_count ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("D1 returned an invalid pending outbox count");
  }
  return count;
}

// IMPLEMENTED_NOT_LIVE: ER-24 Worker composition requires live Access and remote D1 receipts.
export function createApplication(input: CompositionRootInput): ApplicationLifecycle {
  const services = {
    semantic: semanticApi(input.env),
    federation: federationApi(),
    owner: ownerApi(input.env),
  };
  return {
    services,
    async readiness() {
      const report = await readReadiness(input.env);
      return { ready: report.ready, blocking_reason_codes: report.blocking_reason_codes };
    },
    async reconcile(limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new RangeError("reconcile limit must be an integer in [1, 1000]");
      }
      return { repaired: 0, still_pending: await countPendingOutbox(input.env.CORE_DB) };
    },
  };
}
