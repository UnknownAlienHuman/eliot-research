import type { AuthenticatedRequestContext, CatalogRequest, CatalogResult } from "@eliotr/interfaces";
import { createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import { evidenceSha256 } from "@eliotr/cloudflare-evidence";
import { catalogStatements, catalogTimeFrontier } from "./catalog-queries.js";

export class CatalogInputError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, public readonly status = 400,
    public readonly retryable = false) {
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

interface CatalogCursorV2 {
  readonly version: 2;
  readonly context_sha256: string;
  readonly authority_generation: number;
  readonly expires_at: number;
  readonly project_id: string | null;
  readonly project_after: string;
  readonly source_after: string;
}

interface ProjectRow {
  readonly witness_revision: string;
  readonly id: unknown;
  readonly title: unknown;
  readonly generation: unknown;
}

interface SourceRow {
  readonly id: unknown;
  readonly title: unknown;
  readonly head_rev: unknown;
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

export function validateRequestIdentifier(value: unknown, label: string): string {
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

export function encodeCatalogCursor(cursor: object): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

export function decodeCatalogCursor(raw: string): unknown {
  let decoded: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(raw));
    decoded = JSON.parse(text);
  } catch (error) {
    if (error instanceof CatalogInputError) throw error;
    throw new CatalogInputError("CATALOG_CURSOR_INVALID", "catalog cursor is not UTF-8 JSON");
  }
  return decoded;
}

function decodeCursor(raw: string | undefined, projectId: string | undefined): CatalogCursorV2 | null {
  if (raw === undefined) return null;

  const decoded = decodeCatalogCursor(raw);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new CatalogInputError("CATALOG_CURSOR_INVALID", "catalog cursor must be an object");
  }
  const record = decoded as Record<string, unknown>;
  const allowed = new Set(["version", "context_sha256", "authority_generation", "expires_at",
    "project_id", "project_after", "source_after"]);
  if (Object.keys(record).length !== allowed.size || Object.keys(record).some((key) => !allowed.has(key)) ||
      record.version !== 2 || typeof record.context_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.context_sha256) ||
      !Number.isSafeInteger(record.authority_generation) || Number(record.authority_generation) < 1 ||
      !Number.isSafeInteger(record.expires_at) || Number(record.expires_at) < 1) {
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
    version: 2,
    context_sha256: record.context_sha256,
    authority_generation: Number(record.authority_generation),
    expires_at: Number(record.expires_at),
    project_id: cursorProject,
    project_after: projectAfter,
    source_after: sourceAfter,
  };
}

function validateCatalogRequest(request: CatalogRequest): {
  readonly limit: number;
  readonly projectId?: string;
  readonly cursor: CatalogCursorV2 | null;
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

interface CatalogReadFence {
  readonly started: number;
  readonly generation: number;
  readonly identity: string;
  readonly frontier: number;
  readonly authority: ReturnType<typeof createOwnerScopeAuthority>;
  finish(): Promise<void>;
}

/** Shared primary mutation/time fence for owner-only Library metadata reads. */
export async function beginCatalogRead(database: D1Database, context: AuthenticatedRequestContext,
  deploymentGeneration: string, now: () => number): Promise<CatalogReadFence> {
  if (context.client_class !== "owner_pwa") throw new CatalogInputError("CATALOG_OWNER_REQUIRED", "Owner read policy required", 403);
  validateRequestIdentifier(context.principal_ref, "principal");
  validateRequestIdentifier(context.credential_generation, "credential generation");
  validateRequestIdentifier(deploymentGeneration, "deployment generation");
  const clock = () => {
    const instant = now();
    if (!Number.isSafeInteger(instant) || instant < 0 || instant > 8_640_000_000_000_000) {
      throw new CatalogInputError("CATALOG_AUTHORITY_UNAVAILABLE", "Catalog authority clock is unavailable", 503, true);
    }
    if (context.request.signal.aborted) throw new CatalogInputError("CATALOG_REQUEST_ABORTED", "Catalog request was cancelled", 409, true);
    return instant;
  };
  const epoch = async () => {
    const row = await database.prepare("SELECT generation FROM orientation_authority_epoch WHERE singleton=1").first<{ generation: number }>();
    if (!row || !Number.isSafeInteger(row.generation) || row.generation < 1) {
      throw new CatalogInputError("CATALOG_AUTHORITY_UNAVAILABLE", "Catalog authority is unavailable", 503, true);
    }
    return row.generation;
  };
  const started = clock();
  const generation = await epoch();
  const identity = await evidenceSha256({ principal: context.principal_ref, client_class: context.client_class,
    credential: context.credential_generation, deployment: deploymentGeneration });
  const frontier = await catalogTimeFrontier(database, context.principal_ref, started);
  const authority = createOwnerScopeAuthority(database, context, now);
  return { started, generation, identity, frontier, authority,
    async finish() {
      if (await epoch() !== generation || clock() < started || clock() >= frontier) {
        throw new CatalogInputError("CATALOG_AUTHORITY_CHANGED", "Catalog changed while reading; reload", 409, true);
      }
    },
  };
}

/** Metadata authorization uses the same admitted-source/read-policy authority as Corpus Lens.
 * The normal D1 binding is primary-only; do not substitute a first-unconstrained replica session.
 */
export async function readCatalog(database: D1Database, context: AuthenticatedRequestContext,
  request: CatalogRequest, deploymentGeneration: string, now: () => number = Date.now): Promise<CatalogResult> {
  const validated = validateCatalogRequest(request);
  const fence = await beginCatalogRead(database, context, deploymentGeneration, now);
  const { started, generation, identity, frontier, authority } = fence;
  const cursor = validated.cursor;
  if (cursor && cursor.context_sha256 !== identity) {
    throw new CatalogInputError("CATALOG_CURSOR_CONTEXT_MISMATCH", "Catalog cursor belongs to another session", 403);
  }
  if (cursor && (cursor.authority_generation !== generation || cursor.expires_at <= started || cursor.expires_at > started + 300_000)) {
    throw new CatalogInputError("CATALOG_CURSOR_STALE", "Catalog changed; reload the first page", 409, true);
  }
  await authority.requireReadPolicy();
  const [projectResult, sourceResult] = await database.batch<ProjectRow | SourceRow>(catalogStatements(database, {
    principal: context.principal_ref, observed: new Date(started).toISOString(), project: validated.projectId ?? null,
    projectAfter: cursor?.project_after ?? "", sourceAfter: cursor?.source_after ?? "", limit: validated.limit + 1,
  }));
  if (!projectResult?.success || !sourceResult?.success || !Array.isArray(projectResult.results) ||
      !Array.isArray(sourceResult.results) || projectResult.results.length > validated.limit + 1 ||
      sourceResult.results.length > validated.limit + 1) {
    throw new CatalogInputError("CATALOG_AUTHORITY_UNAVAILABLE", "Catalog query failed", 503, true);
  }
  const projectRows = projectResult.results as ProjectRow[];
  const sourceRows = sourceResult.results as SourceRow[];
  // Every emitted project has a currently readable source witness. Neither project existence nor
  // title is returned merely because the browser guessed its ID. Include the lookahead rows too.
  const refs = [...new Set([...projectRows.map((row) => validateAuthorityIdentifier(row.witness_revision, "project witness")),
    ...sourceRows.map((row) => validateAuthorityIdentifier(row.head_rev, "source revision"))])];
  for (let offset = 0; offset < refs.length; offset += 64) {
    await authority.sources(refs.slice(offset, offset + 64));
  }
  const allProjects = decodeProjects(projectRows); const allSources = decodeSources(sourceRows);
  if (new Set(allProjects.map((item) => item.id)).size !== allProjects.length ||
      new Set(allSources.map((item) => item.id)).size !== allSources.length) {
    throw new CatalogInputError("CATALOG_AUTHORITY_UNAVAILABLE", "Catalog returned duplicate identities", 503);
  }
  const projects = allProjects.slice(0, validated.limit); const sources = allSources.slice(0, validated.limit);
  const hasMore = allProjects.length > validated.limit || allSources.length > validated.limit;
  const result: CatalogResult = { projects, sources, ...(hasMore ? { next_cursor: encodeCatalogCursor({
    version: 2, context_sha256: identity, authority_generation: generation,
    expires_at: Math.min(frontier, started + 300_000, cursor?.expires_at ?? Infinity),
    project_id: validated.projectId ?? null, project_after: projects.at(-1)?.id ?? cursor?.project_after ?? "",
    source_after: sources.at(-1)?.id ?? cursor?.source_after ?? "",
  }) } : {}) };
  await fence.finish();
  return result;
}
