import type { VersionedRef } from "@eliotr/contracts";
import type {
  AuthenticatedRequestContext,
  ResearchChangeItem,
  ResearchChangeKind,
  ResearchChangesRequest,
  ResearchChangesResult,
  SemanticApi,
} from "@eliotr/interfaces";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";
import {
  createResearchChangesCursorCodec,
  normalizeResearchChangeKinds,
  RESEARCH_CHANGE_KINDS,
  validResearchChangesIdentity,
} from "./research-changes-cursor.js";

export { RESEARCH_CHANGE_KINDS } from "./research-changes-cursor.js";
export const RESEARCH_CHANGES_PROTOCOL = "eliotr.research-changes.v1";
const MAX_CURSOR_BYTES = 4_096;
const MAX_METADATA_BYTES = 65_536;
const MAX_LIMIT = 100;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/@%+-]{0,511}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const KIND_SET = new Set<string>(RESEARCH_CHANGE_KINDS);

type Metadata = Readonly<Record<string, string | number | boolean | null>>;

export interface ResearchChangeWrite {
  readonly change_ref: string;
  readonly kind: ResearchChangeKind;
  readonly subject_ref: string;
  readonly subject_revision: number;
  readonly payload_ref: string;
  readonly payload_sha256: string;
  readonly visibility_principal_ref?: string;
  readonly visibility_scope_ref?: VersionedRef;
  readonly occurred_at: string;
  readonly metadata?: Metadata;
}

export interface ResearchChangesServiceOptions {
  readonly now?: () => number;
  readonly cursor_ttl_ms?: number;
}

interface ChangeRow {
  readonly sequence: number;
  readonly change_ref: string;
  readonly kind: string;
  readonly subject_ref: string;
  readonly subject_revision: number;
  readonly payload_ref: string;
  readonly payload_sha256: string;
  readonly visibility_principal_ref: string | null;
  readonly visibility_snapshot_id: string | null;
  readonly visibility_snapshot_revision: number | null;
  readonly occurred_at: string;
  readonly metadata_json: string;
}

function fail(code: string, message: string, status = 400, retryable = false): never {
  throw new CatalogInputError(code, message, status, retryable);
}

function exactRecord(raw: unknown, fields: readonly string[], code: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(code, "value must be an object");
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) {
    fail(code, "value has unknown or missing fields");
  }
  return record;
}

function validRef(value: unknown, label: string, code = "RESEARCH_CHANGES_INPUT_INVALID", status = 400): string {
  if (typeof value !== "string" || !SAFE_REF.test(value) || value.includes("..") || value.includes("\\")) {
    fail(code, `${label} is invalid`, status);
  }
  return value;
}

export function parseResearchChangesRequest(raw: unknown): ResearchChangesRequest {
  const record = exactRecord(raw, ["after_cursor", "limit", "kinds"], "RESEARCH_CHANGES_INPUT_INVALID");
  if (record.after_cursor !== null && (typeof record.after_cursor !== "string" ||
      new TextEncoder().encode(record.after_cursor).byteLength > MAX_CURSOR_BYTES)) {
    fail("RESEARCH_CHANGES_CURSOR_INVALID", "changes cursor is invalid");
  }
  if (!Number.isSafeInteger(record.limit) || (record.limit as number) < 1 || (record.limit as number) > MAX_LIMIT) {
    fail("RESEARCH_CHANGES_INPUT_INVALID", "changes limit must be an integer in [1, 100]");
  }
  return {
    after_cursor: record.after_cursor as string | null,
    limit: record.limit as number,
    kinds: normalizeResearchChangeKinds(record.kinds),
  };
}

function metadataJson(raw: unknown, code = "RESEARCH_CHANGES_INPUT_INVALID", status = 400): string {
  const metadata = raw ?? {};
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail(code, "change metadata is invalid", status);
  }
  const canonical: Record<string, string | number | boolean | null> = Object.create(null) as Metadata;
  for (const key of Object.keys(metadata).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(key)) fail(code, "change metadata key is invalid", status);
    const value = (metadata as Record<string, unknown>)[key];
    if (value !== null && typeof value !== "string" && typeof value !== "boolean" &&
        (typeof value !== "number" || !Number.isFinite(value))) {
      fail(code, "change metadata value is invalid", status);
    }
    canonical[key] = value;
  }
  const encoded = JSON.stringify(canonical);
  if (new TextEncoder().encode(encoded).byteLength > MAX_METADATA_BYTES) {
    fail(code, "change metadata exceeds its byte limit", status === 409 ? 409 : 413);
  }
  return encoded;
}

function canonicalTime(raw: unknown): string {
  if (typeof raw !== "string" || !ISO_MILLISECONDS.test(raw) || Number.isNaN(Date.parse(raw))) {
    fail("RESEARCH_CHANGES_INPUT_INVALID", "change timestamp is invalid");
  }
  return raw;
}

function decodeRow(row: ChangeRow): ResearchChangeItem {
  const scopePairValid = (row.visibility_snapshot_id === null) === (row.visibility_snapshot_revision === null);
  if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || !KIND_SET.has(row.kind) ||
      !Number.isSafeInteger(row.subject_revision) || row.subject_revision < 1 || !SHA256.test(row.payload_sha256) ||
      !ISO_MILLISECONDS.test(row.occurred_at) || !scopePairValid ||
      (row.visibility_snapshot_revision !== null &&
       (!Number.isSafeInteger(row.visibility_snapshot_revision) || row.visibility_snapshot_revision < 1))) {
    fail("RESEARCH_CHANGES_READBACK_CORRUPT", "change row is malformed", 409);
  }
  validRef(row.change_ref, "change reference", "RESEARCH_CHANGES_READBACK_CORRUPT", 409);
  validRef(row.subject_ref, "change subject reference", "RESEARCH_CHANGES_READBACK_CORRUPT", 409);
  validRef(row.payload_ref, "change payload reference", "RESEARCH_CHANGES_READBACK_CORRUPT", 409);
  if (row.visibility_principal_ref !== null) {
    validResearchChangesIdentity(
      row.visibility_principal_ref,
      "visibility principal",
      "RESEARCH_CHANGES_READBACK_CORRUPT",
      409,
    );
  }
  if (row.visibility_snapshot_id !== null) {
    validRef(row.visibility_snapshot_id, "visibility scope", "RESEARCH_CHANGES_READBACK_CORRUPT", 409);
  }
  let metadata: unknown;
  try { metadata = JSON.parse(row.metadata_json); }
  catch { fail("RESEARCH_CHANGES_READBACK_CORRUPT", "change metadata is malformed", 409); }
  if (metadataJson(metadata, "RESEARCH_CHANGES_READBACK_CORRUPT", 409) !== row.metadata_json) {
    fail("RESEARCH_CHANGES_READBACK_CORRUPT", "change metadata is noncanonical", 409);
  }
  return {
    sequence: row.sequence,
    change_ref: row.change_ref,
    kind: row.kind as ResearchChangeKind,
    subject_ref: row.subject_ref,
    subject_revision: row.subject_revision,
    payload_ref: row.payload_ref,
    payload_sha256: row.payload_sha256,
    ...(row.visibility_principal_ref === null ? {} : { visibility_principal_ref: row.visibility_principal_ref }),
    ...(row.visibility_snapshot_id === null ? {} : {
      visibility_scope_ref: { id: row.visibility_snapshot_id, revision: row.visibility_snapshot_revision as number },
    }),
    occurred_at: row.occurred_at,
    metadata: metadata as Metadata,
  };
}

export async function recordResearchChange(database: D1Database, input: ResearchChangeWrite): Promise<ResearchChangeItem> {
  const changeRef = validRef(input.change_ref, "change reference");
  if (!KIND_SET.has(input.kind)) fail("RESEARCH_CHANGES_INPUT_INVALID", "change kind is invalid");
  const subjectRef = validRef(input.subject_ref, "change subject reference");
  if (!Number.isSafeInteger(input.subject_revision) || input.subject_revision < 1) {
    fail("RESEARCH_CHANGES_INPUT_INVALID", "change subject revision is invalid");
  }
  const payloadRef = validRef(input.payload_ref, "change payload reference");
  if (!SHA256.test(input.payload_sha256)) fail("RESEARCH_CHANGES_INPUT_INVALID", "change payload digest is invalid");
  const visibilityPrincipal = input.visibility_principal_ref === undefined
    ? null
    : validResearchChangesIdentity(input.visibility_principal_ref, "visibility principal");
  const visibilityScope = input.visibility_scope_ref;
  if (visibilityScope !== undefined) {
    validRef(visibilityScope.id, "visibility scope");
    if (!Number.isSafeInteger(visibilityScope.revision) || visibilityScope.revision < 1) {
      fail("RESEARCH_CHANGES_INPUT_INVALID", "visibility scope is invalid");
    }
  }
  const occurredAt = canonicalTime(input.occurred_at);
  const encodedMetadata = metadataJson(input.metadata);
  try {
    await database.prepare(
      "INSERT OR IGNORE INTO research_change_feed " +
      "(change_ref,kind,subject_ref,subject_revision,payload_ref,payload_sha256," +
      "visibility_principal_ref,visibility_snapshot_id,visibility_snapshot_revision,occurred_at,metadata_json) " +
      "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
    ).bind(
      changeRef, input.kind, subjectRef, input.subject_revision, payloadRef, input.payload_sha256,
      visibilityPrincipal, visibilityScope?.id ?? null, visibilityScope?.revision ?? null,
      occurredAt, encodedMetadata,
    ).run();
  } catch {
    fail("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "change mutation is uncertain", 503, true);
  }
  let row: ChangeRow | null;
  try {
    row = await database.prepare(
      "SELECT sequence,change_ref,kind,subject_ref,subject_revision,payload_ref,payload_sha256," +
      "visibility_principal_ref,visibility_snapshot_id,visibility_snapshot_revision,occurred_at,metadata_json " +
      "FROM research_change_feed WHERE change_ref=?1 LIMIT 1",
    ).bind(changeRef).first<ChangeRow>();
  } catch {
    fail("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "change readback is unavailable", 503, true);
  }
  if (row === null) fail("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "change readback is absent", 503, true);
  const decoded = decodeRow(row);
  if (decoded.kind !== input.kind || decoded.subject_ref !== subjectRef ||
      decoded.subject_revision !== input.subject_revision || decoded.payload_ref !== payloadRef ||
      decoded.payload_sha256 !== input.payload_sha256 ||
      (decoded.visibility_principal_ref ?? null) !== visibilityPrincipal ||
      (decoded.visibility_scope_ref?.id ?? null) !== (visibilityScope?.id ?? null) ||
      (decoded.visibility_scope_ref?.revision ?? null) !== (visibilityScope?.revision ?? null) ||
      decoded.occurred_at !== occurredAt || JSON.stringify(decoded.metadata) !== encodedMetadata) {
    fail("RESEARCH_CHANGES_CONFLICT", "change reference is occupied by different bytes", 409);
  }
  return decoded;
}

export function createResearchChangesService(
  env: Pick<Env, "CORE_DB" | "DEPLOYMENT_GENERATION" | "RESEARCH_CHANGES_CURSOR_KEY">,
  options: ResearchChangesServiceOptions = {},
): SemanticApi["changes"] {
  const clock = options.now ?? Date.now;
  return async (context: AuthenticatedRequestContext, raw: ResearchChangesRequest): Promise<ResearchChangesResult> => {
    if (context.client_class !== "owner_pwa") {
      fail("RESEARCH_CHANGES_OWNER_REQUIRED", "changes feed requires the owner profile", 403);
    }
    const request = parseResearchChangesRequest(raw);
    const observedMs = clock();
    const principalRef = validResearchChangesIdentity(context.principal_ref, "principal reference");
    const credentialGeneration = validResearchChangesIdentity(
      context.credential_generation,
      "credential generation",
    );
    const deploymentGeneration = validResearchChangesIdentity(
      env.DEPLOYMENT_GENERATION,
      "deployment generation",
      "RESEARCH_CHANGES_CONFIG_INVALID",
      503,
    );
    const observedDate = new Date(observedMs);
    if (Number.isNaN(observedDate.getTime())) {
      fail("RESEARCH_CHANGES_CONFIG_INVALID", "research changes clock is invalid", 503, true);
    }
    const codec = createResearchChangesCursorCodec({
      key: env.RESEARCH_CHANGES_CURSOR_KEY,
      authority: {
        principal_ref: principalRef,
        client_class: "owner_pwa",
        credential_generation: credentialGeneration,
        deployment_generation: deploymentGeneration,
        kinds: request.kinds,
      },
      now: observedMs,
      ...(options.cursor_ttl_ms === undefined ? {} : { ttl_ms: options.cursor_ttl_ms }),
    });
    await codec.ready();
    let after = 0;
    let nextCursor = request.after_cursor;
    if (request.after_cursor !== null) {
      const position = await codec.verify(request.after_cursor);
      after = position.sequence;
      let anchor: { sequence: number; change_ref: string } | null;
      try {
        anchor = await env.CORE_DB.prepare(
          "SELECT sequence,change_ref FROM research_change_feed WHERE sequence=?1 LIMIT 1",
        ).bind(after).first<{ sequence: number; change_ref: string }>();
      } catch {
        fail("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "changes cursor readback is unavailable", 503, true);
      }
      if (anchor === null || anchor.sequence !== after || anchor.change_ref !== position.change_ref) {
        fail("RESEARCH_CHANGES_CURSOR_STALE", "changes cursor anchor no longer exists", 409);
      }
    }
    const kindClause = request.kinds.length === 0
      ? ""
      : ` AND c.kind IN (${request.kinds.map((_, index) => `?${index + 7}`).join(",")})`;
    const observedAt = observedDate.toISOString();
    let rows: readonly ChangeRow[];
    try {
      const result = await env.CORE_DB.prepare(
        "SELECT c.sequence,c.change_ref,c.kind,c.subject_ref,c.subject_revision,c.payload_ref,c.payload_sha256," +
        "c.visibility_principal_ref,c.visibility_snapshot_id,c.visibility_snapshot_revision,c.occurred_at,c.metadata_json " +
        "FROM research_change_feed c WHERE c.sequence>?1 " +
        "AND (c.visibility_principal_ref IS NULL OR c.visibility_principal_ref=?2) " +
        "AND (c.visibility_snapshot_id IS NULL OR EXISTS (" +
        "SELECT 1 FROM scope_access_grant g JOIN scope_snapshot s " +
        "ON s.snapshot_id=g.snapshot_id AND s.revision=g.snapshot_revision " +
        "WHERE g.snapshot_id=c.visibility_snapshot_id AND g.snapshot_revision=c.visibility_snapshot_revision " +
        "AND g.principal_ref=?2 AND g.client_class=?3 AND g.credential_generation=?4 " +
        "AND g.state='ACTIVE' AND g.expires_at>?5 AND s.invalidated_at IS NULL AND s.expires_at>?5 " +
        "AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE u.value='research')))" +
        kindClause + " ORDER BY c.sequence ASC LIMIT ?6",
      ).bind(
        after, principalRef, "owner_pwa", credentialGeneration, observedAt,
        request.limit + 1, ...request.kinds,
      ).all<ChangeRow>();
      if (result.success !== true || !Array.isArray(result.results)) {
        fail("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "changes query did not settle", 503, true);
      }
      rows = result.results;
    } catch (error) {
      if (error instanceof CatalogInputError) throw error;
      fail("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "changes query is unavailable", 503, true);
    }
    const hasMore = rows.length > request.limit;
    const items = rows.slice(0, request.limit).map(decodeRow);
    const last = items.at(-1);
    if (last !== undefined) {
      nextCursor = await codec.sign({ sequence: last.sequence, change_ref: last.change_ref });
    }
    return { protocol: RESEARCH_CHANGES_PROTOCOL, items, next_cursor: nextCursor, has_more: hasMore };
  };
}
