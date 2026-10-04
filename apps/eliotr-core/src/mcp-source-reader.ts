import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { CatalogInputError, decodeCatalogCursor, encodeCatalogCursor, validateRequestIdentifier } from "./catalog-service.js";
import { readProjectSourceContent } from "./source-content.js";
import type { Env } from "./env.js";

export const MCP_SOURCE_PAGE_DEFAULT_BYTES = 16 * 1024;
export const MCP_SOURCE_PAGE_MAX_BYTES = 24 * 1024;
const MAX_CURSOR_BYTES = 2048;

interface SourceCursor {
  readonly version: 1;
  readonly project_id: string;
  readonly source_revision_ref: string;
  readonly content_sha256: string;
  readonly context_sha256: string;
  readonly authority_generation: number;
  readonly expires_at: number;
  readonly page_bytes: number;
  readonly offset: number;
}

function invalidCursor(): never {
  throw new CatalogInputError("SOURCE_READ_CURSOR_INVALID", "Source cursor is invalid");
}

function parseCursor(raw: string | undefined): SourceCursor | null {
  if (raw === undefined) return null;
  if (raw.length === 0 || new TextEncoder().encode(raw).byteLength > MAX_CURSOR_BYTES) invalidCursor();
  let value: unknown;
  try { value = decodeCatalogCursor(raw); } catch { invalidCursor(); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidCursor();
  const record = value as Record<string, unknown>;
  const keys = ["version", "project_id", "source_revision_ref", "content_sha256", "context_sha256",
    "authority_generation", "expires_at", "page_bytes", "offset"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)) ||
      record.version !== 1 || typeof record.project_id !== "string" ||
      typeof record.source_revision_ref !== "string" ||
      typeof record.content_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.content_sha256) ||
      typeof record.context_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.context_sha256) ||
      !Number.isSafeInteger(record.authority_generation) || Number(record.authority_generation) < 1 ||
      !Number.isSafeInteger(record.expires_at) || Number(record.expires_at) < 1 ||
      !Number.isSafeInteger(record.page_bytes) || Number(record.page_bytes) < 1 || Number(record.page_bytes) > MCP_SOURCE_PAGE_MAX_BYTES ||
      !Number.isSafeInteger(record.offset) || Number(record.offset) < 1) invalidCursor();
  try {
    validateRequestIdentifier(record.project_id, "project_id");
    validateRequestIdentifier(record.source_revision_ref, "source revision");
  } catch { invalidCursor(); }
  return record as unknown as SourceCursor;
}

function pageEnd(bytes: Uint8Array, offset: number, requestedBytes: number): number {
  let end = Math.min(bytes.byteLength, offset + requestedBytes);
  while (end < bytes.byteLength && end > offset && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  // Even a one-byte requested page must make progress through a four-byte code point.
  if (end === offset) {
    end = Math.min(bytes.byteLength, offset + requestedBytes);
    while (end < bytes.byteLength && ((bytes[end] ?? 0) & 0xc0) === 0x80) end += 1;
  }
  return end;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Exact admitted source reader for MCP. Each continuation re-runs owner, membership,
 * admission and R2 integrity checks before returning any bytes.
 */
export async function readMcpSourcePage(
  env: Pick<Env, "CORE_DB" | "EVIDENCE_BUCKET" | "DEPLOYMENT_GENERATION">,
  context: AuthenticatedRequestContext,
  input: {
    readonly project_id: string;
    readonly source_revision_ref: string;
    readonly page_bytes?: number;
    readonly cursor?: string;
  },
  now: () => number = Date.now,
) {
  const project = validateRequestIdentifier(input.project_id, "project_id");
  const revision = validateRequestIdentifier(input.source_revision_ref, "source revision");
  const pageBytes = input.page_bytes ?? MCP_SOURCE_PAGE_DEFAULT_BYTES;
  if (!Number.isSafeInteger(pageBytes) || pageBytes < 1 || pageBytes > MCP_SOURCE_PAGE_MAX_BYTES) {
    throw new CatalogInputError("SOURCE_READ_PAGE_LIMIT_INVALID", "Source page limit is invalid");
  }
  const cursor = parseCursor(input.cursor);
  const document = await readProjectSourceContent(env, context, project, revision, now);
  if (cursor !== null && (cursor.project_id !== project || cursor.source_revision_ref !== revision ||
      cursor.content_sha256 !== document.content_sha256 || cursor.context_sha256 !== document.context_sha256 ||
      cursor.authority_generation !== document.authority_generation || cursor.page_bytes !== pageBytes ||
      cursor.expires_at <= document.observed_at || cursor.expires_at > document.expires_at ||
      cursor.offset >= document.size_bytes)) {
    throw new CatalogInputError("SOURCE_READ_CURSOR_STALE", "Source changed or cursor belongs to another read scope", 409, true);
  }
  const offset = cursor?.offset ?? 0;
  if (offset > 0 && offset < document.size_bytes && (((document.bytes[offset] ?? 0) & 0xc0) === 0x80)) invalidCursor();
  const end = pageEnd(document.bytes, offset, pageBytes);
  if (end <= offset) invalidCursor();
  const page = document.bytes.slice(offset, end);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(page); }
  catch { throw new CatalogInputError("SOURCE_READ_UTF8_INVALID", "Admitted source page is not valid UTF-8", 409); }
  const nextCursor = end < document.size_bytes ? encodeCatalogCursor({
    version: 1,
    project_id: project,
    source_revision_ref: revision,
    content_sha256: document.content_sha256,
    context_sha256: document.context_sha256,
    authority_generation: document.authority_generation,
    expires_at: document.expires_at,
    page_bytes: pageBytes,
    offset: end,
  } satisfies SourceCursor) : undefined;
  if (nextCursor !== undefined && new TextEncoder().encode(nextCursor).byteLength > MAX_CURSOR_BYTES) invalidCursor();
  const response = {
    protocol: "eliotr.mcp.source-page.v1" as const,
    project_id: project,
    source_id: document.source_id,
    source_revision_ref: revision,
    content_sha256: document.content_sha256,
    size_bytes: document.size_bytes,
    byte_range: { start: offset, end },
    page_sha256: await sha256(page),
    text,
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
  };
  return response;
}
