import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
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
import { prepareOwnerScopeHistoricalReadAuthorization } from "./wiki-proposal-reauthorization.js";
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
const RESEARCH_CHANGES_SCAN_BATCH = 100;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/@%+-]{0,511}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const KIND_SET = new Set<string>(RESEARCH_CHANGE_KINDS);
const EXPECTED_SCOPE_DENIAL_CODES = new Set([
  "ORIENTATION_READ_POLICY_REQUIRED",
  "ORIENTATION_SOURCE_DENIED",
  "ORIENTATION_PROJECT_UNAVAILABLE",
  "ORIENTATION_POLICY_CHANGED",
  "ORIENTATION_MIXED_DISCLOSURE",
  "WIKI_POLICY_DENIED",
  "SCOPE_SNAPSHOT_STALE",
  "NAVIGATION_SCOPE_NOT_CURRENT",
  "NAVIGATION_SCOPE_MISMATCH",
  "EVIDENCE_SCOPE_NOT_FOUND",
  "EVIDENCE_SCOPE_INVALIDATED",
  "EVIDENCE_SCOPE_EXPIRED",
  "EVIDENCE_AUTHORIZATION_DENIED",
  "EVIDENCE_SOURCE_NOT_LIVE",
  "EVIDENCE_OWNER_GENERATION_MISMATCH",
  "EVIDENCE_SCOPE_MISMATCH",
]);

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

type ScopeReadAuthorization = Awaited<ReturnType<typeof prepareOwnerScopeHistoricalReadAuthorization>>;

interface ScopeGrantStateRow {
  readonly state: unknown;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isExpectedScopeDenial(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && EXPECTED_SCOPE_DENIAL_CODES.has(code);
}

function rowScopeRef(row: ChangeRow): VersionedRef | null {
  if (row.visibility_snapshot_id === null && row.visibility_snapshot_revision === null) return null;
  const parsed = VersionedRefSchema.safeParse({
    id: row.visibility_snapshot_id,
    revision: row.visibility_snapshot_revision,
  });
  if (!parsed.success) fail("RESEARCH_CHANGES_READBACK_CORRUPT", "change scope is malformed", 409);
  return parsed.data;
}

function scopeKey(scopeRef: VersionedRef): string {
  return `${scopeRef.id}\u0000${scopeRef.revision}`;
}

async function readOriginalScopeGrantState(
  database: D1Database,
  context: AuthenticatedRequestContext,
  scopeRef: VersionedRef,
): Promise<string | null> {
  let row: ScopeGrantStateRow | null;
  try {
    row = await database.prepare(
      "SELECT state FROM scope_access_grant WHERE snapshot_id=?1 AND snapshot_revision=?2 " +
      "AND principal_ref=?3 AND client_class=?4 AND credential_generation=?5 LIMIT 1",
    ).bind(
      scopeRef.id,
      scopeRef.revision,
      context.principal_ref,
      context.client_class,
      context.credential_generation,
    ).first<ScopeGrantStateRow>();
  } catch {
    fail("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "changes scope authorization is unavailable", 503, true);
  }
  if (row === null) return null;
  if (typeof row.state !== "string" || !["ACTIVE", "REVOKED", "EXPIRED"].includes(row.state)) {
    fail("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "changes scope authorization readback is malformed", 503, true);
  }
  return row.state;
}

function fail(code: string, message: string, status = 400, retryable = false): never {
  throw new CatalogInputError(code, message, status, retryable);
}

function exactRecord(
  raw: unknown,
  fields: readonly string[],
  code: string,
  optionalFields: readonly string[] = [],
): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(code, "value must be an object");
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowedFields = new Set([...fields, ...optionalFields]);
  if (keys.some((key) => !allowedFields.has(key)) || fields.some((field) => !Object.hasOwn(record, field))) {
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
  const record = exactRecord(
    raw,
    ["after_cursor", "limit", "kinds"],
    "RESEARCH_CHANGES_INPUT_INVALID",
    ["start_at"],
  );
  const hasLatestStart = Object.hasOwn(record, "start_at");
  if (hasLatestStart && record.start_at !== "latest") {
    fail("RESEARCH_CHANGES_INPUT_INVALID", "changes start_at must be 'latest'");
  }
  if (hasLatestStart && record.after_cursor !== null) {
    fail("RESEARCH_CHANGES_INPUT_INVALID", "changes start_at='latest' requires a null cursor");
  }
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
    ...(hasLatestStart ? { start_at: "latest" as const } : {}),
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
      : ` AND c.kind IN (${request.kinds.map((_, index) => `?${index + 4}`).join(",")})`;
    const latestStart = request.start_at === "latest";
    const readBatch = async (boundary: number, batchLimit: number): Promise<readonly ChangeRow[]> => {
      const sequenceClause = latestStart ? "c.sequence<?1" : "c.sequence>?1";
      const order = latestStart ? "DESC" : "ASC";
      try {
        const result = await env.CORE_DB.prepare(
          "SELECT c.sequence,c.change_ref,c.kind,c.subject_ref,c.subject_revision,c.payload_ref,c.payload_sha256," +
          "CASE WHEN c.kind='WIKI_PUBLISHED' THEN p.principal_ref ELSE c.visibility_principal_ref END AS visibility_principal_ref," +
          "CASE WHEN c.kind='WIKI_PUBLISHED' THEN json_extract(r.page_json,'$.scope_snapshot_ref.id') ELSE c.visibility_snapshot_id END AS visibility_snapshot_id," +
          "CASE WHEN c.kind='WIKI_PUBLISHED' THEN json_extract(r.page_json,'$.scope_snapshot_ref.revision') ELSE c.visibility_snapshot_revision END AS visibility_snapshot_revision," +
          "c.occurred_at,c.metadata_json " +
          "FROM research_change_feed c " +
          "LEFT JOIN wiki_publication_outbox o ON c.kind='WIKI_PUBLISHED' " +
          "AND c.change_ref='wiki:' || o.outbox_ref " +
          "LEFT JOIN wiki_publication_revision r ON c.kind='WIKI_PUBLISHED' " +
          "AND r.page_id=o.page_id AND r.revision=o.revision AND r.manifest_ref=o.manifest_ref " +
          "AND r.page_sha256=o.payload_sha256 AND json_valid(r.page_json) " +
          "LEFT JOIN wiki_publication_proposal p ON c.kind='WIKI_PUBLISHED' " +
          "AND p.proposal_id=r.proposal_id AND p.proposal_revision=r.proposal_revision " +
          "AND p.page_id=r.page_id AND p.page_revision=r.revision " +
          "WHERE " + sequenceClause +
          " AND ((c.kind='WIKI_PUBLISHED' AND p.principal_ref=?2) OR " +
          "(c.kind<>'WIKI_PUBLISHED' AND (c.visibility_principal_ref IS NULL OR c.visibility_principal_ref=?2)))" +
          " AND (c.kind<>'WIKI_PUBLISHED' OR (" +
          "o.outbox_ref IS NOT NULL AND r.page_id IS NOT NULL AND p.proposal_id IS NOT NULL " +
          "AND c.change_ref='wiki:' || o.outbox_ref " +
          "AND c.subject_ref IS ('wiki-page:' || r.page_id) " +
          "AND c.subject_revision IS r.revision " +
          "AND c.payload_ref IS r.manifest_ref " +
          "AND c.payload_sha256 IS r.page_sha256 " +
          "AND json_type(r.page_json,'$.scope_snapshot_ref.id')='text' " +
          "AND json_type(r.page_json,'$.scope_snapshot_ref.revision')='integer' " +
          "AND (c.visibility_principal_ref IS NULL OR c.visibility_principal_ref IS p.principal_ref) " +
          "AND ((c.visibility_snapshot_id IS NULL AND c.visibility_snapshot_revision IS NULL) OR " +
          "(c.visibility_snapshot_id IS json_extract(r.page_json,'$.scope_snapshot_ref.id') " +
          "AND c.visibility_snapshot_revision IS json_extract(r.page_json,'$.scope_snapshot_ref.revision')))" +
          "))" + kindClause + ` ORDER BY c.sequence ${order} LIMIT ?3`,
        ).bind(boundary, principalRef, batchLimit, ...request.kinds).all<ChangeRow>();
        if (result.success !== true || !Array.isArray(result.results)) {
          fail("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "changes query did not settle", 503, true);
        }
        return result.results;
      } catch (error) {
        if (error instanceof CatalogInputError) throw error;
        fail("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "changes query is unavailable", 503, true);
      }
    };
    const visibleRows: ChangeRow[] = [];
    const authorizations = new Map<string, ScopeReadAuthorization | null>();
    const deniedScopes = new Set<string>();
    const dropScope = (key: string): void => {
      for (let index = visibleRows.length - 1; index >= 0; index -= 1) {
        const row = visibleRows[index];
        if (row === undefined) continue;
        const scopeRef = rowScopeRef(row);
        if (scopeRef !== null && scopeKey(scopeRef) === key) visibleRows.splice(index, 1);
      }
    };
    const denyScope = (key: string): void => {
      deniedScopes.add(key);
      authorizations.set(key, null);
      dropScope(key);
    };
    const loadAuthorization = async (scopeRef: VersionedRef): Promise<ScopeReadAuthorization | null> => {
      const key = scopeKey(scopeRef);
      if (deniedScopes.has(key)) return null;
      if (authorizations.has(key)) return authorizations.get(key) ?? null;
      const originalGrantState = await readOriginalScopeGrantState(env.CORE_DB, context, scopeRef);
      if (originalGrantState === "REVOKED") {
        denyScope(key);
        return null;
      }
      try {
        const authorization = await prepareOwnerScopeHistoricalReadAuthorization(env, context, scopeRef);
        authorizations.set(key, authorization);
        return authorization;
      } catch (error) {
        if (isExpectedScopeDenial(error)) {
          denyScope(key);
          return null;
        }
        fail("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "changes scope authorization is unavailable", 503, true);
      }
    };
    const requireScopeCurrent = async (key: string, authorization: ScopeReadAuthorization): Promise<boolean> => {
      const originalGrantState = await readOriginalScopeGrantState(
        env.CORE_DB,
        context,
        authorization.original_scope_snapshot_ref,
      );
      if (originalGrantState === "REVOKED") {
        denyScope(key);
        return false;
      }
      try {
        await authorization.requireCurrent();
        return true;
      } catch (error) {
        if (isExpectedScopeDenial(error)) {
          denyScope(key);
          return false;
        }
        fail("RESEARCH_CHANGES_SETTLEMENT_UNCERTAIN", "changes scope authorization is unavailable", 503, true);
      }
    };
    const authorizeBatch = async (batch: readonly ChangeRow[]): Promise<readonly ChangeRow[]> => {
      const accepted: ChangeRow[] = [];
      const scopeKeys = new Set<string>();
      for (const row of batch) {
        const scopeRef = rowScopeRef(row);
        if (scopeRef === null) {
          accepted.push(row);
          continue;
        }
        const key = scopeKey(scopeRef);
        const authorization = await loadAuthorization(scopeRef);
        if (authorization !== null) {
          accepted.push(row);
          scopeKeys.add(key);
        }
      }
      for (const key of scopeKeys) {
        const authorization = authorizations.get(key);
        if (authorization !== undefined && authorization !== null) await requireScopeCurrent(key, authorization);
      }
      return accepted.filter((row) => {
        const scopeRef = rowScopeRef(row);
        return scopeRef === null || !deniedScopes.has(scopeKey(scopeRef));
      });
    };
    const recheckVisibleScopes = async (): Promise<boolean> => {
      const scopeKeys = new Set<string>();
      for (const row of visibleRows) {
        const scopeRef = rowScopeRef(row);
        if (scopeRef !== null) scopeKeys.add(scopeKey(scopeRef));
      }
      const before = visibleRows.length;
      for (const key of scopeKeys) {
        if (deniedScopes.has(key)) {
          dropScope(key);
          continue;
        }
        const authorization = authorizations.get(key);
        if (authorization === undefined || authorization === null) {
          fail("RESEARCH_CHANGES_READBACK_CORRUPT", "change scope authorization is missing", 409);
        }
        await requireScopeCurrent(key, authorization);
      }
      return visibleRows.length !== before;
    };
    const targetCount = latestStart ? request.limit : request.limit + 1;
    let scanBoundary = latestStart ? Number.MAX_SAFE_INTEGER : after;
    let exhausted = false;
    const fetchUntilTarget = async (): Promise<void> => {
      while (!exhausted && visibleRows.length < targetCount) {
        const batchLimit = Math.min(RESEARCH_CHANGES_SCAN_BATCH, targetCount - visibleRows.length);
        const batch = await readBatch(scanBoundary, batchLimit);
        if (batch.length === 0) {
          exhausted = true;
          return;
        }
        const boundaryRow = batch.at(-1);
        if (boundaryRow === undefined || !Number.isSafeInteger(boundaryRow.sequence) ||
            (latestStart ? boundaryRow.sequence >= scanBoundary : boundaryRow.sequence <= scanBoundary)) {
          fail("RESEARCH_CHANGES_READBACK_CORRUPT", "changes sequence ordering is invalid", 409);
        }
        scanBoundary = boundaryRow.sequence;
        visibleRows.push(...await authorizeBatch(batch));
      }
    };
    await fetchUntilTarget();
    while (true) {
      const removed = await recheckVisibleScopes();
      if (!removed || visibleRows.length >= targetCount || exhausted) break;
      await fetchUntilTarget();
    }
    const orderedRows = latestStart ? [...visibleRows].reverse() : visibleRows;
    const hasMore = latestStart ? false : orderedRows.length > request.limit;
    const items = orderedRows.slice(0, request.limit).map(decodeRow);
    const last = items.at(-1);
    if (last !== undefined) {
      nextCursor = await codec.sign({ sequence: last.sequence, change_ref: last.change_ref });
    }
    return { protocol: RESEARCH_CHANGES_PROTOCOL, items, next_cursor: nextCursor, has_more: hasMore };
  };
}
