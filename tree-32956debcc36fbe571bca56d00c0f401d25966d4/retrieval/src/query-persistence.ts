// IMPLEMENTED_NOT_LIVE: ER-04 D1-backed retrieval query persistence over migration 0021 with frozen-scope binding, idempotent result replay and exact trace linkage; lane/R2 composition and Worker wiring remain separate.
import {
  RetrievalTraceSchema,
  ScopeSnapshotSchema,
  type RetrievalTrace,
  type ScopeSnapshot,
  type VersionedRef,
} from "@eliotr/contracts";
import type { RetrievalRequest } from "./ports.js";
import {
  RetrievalQueryError,
  type RetrievalQueryErrorCode,
  type StoredRetrievalResult,
} from "./service.js";
import { canonicalRetrievalJson as canonicalJson, decodeCanonicalRetrievalJson, decodeRetrievalResult } from "./query-codec.js";

export function canonicalRetrievalJson(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    failQuery("RETRIEVAL_INPUT_INVALID", "stored query result is not canonical");
  }
}

export interface RetrievalQueryAccess {
  readonly principal_ref: string;
  readonly client_class: "owner_pwa" | "named_api_client" | "trusted_agent" | "federation_client";
  readonly credential_generation: string;
}

interface QueryD1Statement {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ readonly results: readonly T[] }>;
  run(): Promise<unknown>;
}

interface QueryD1Prepared {
  bind(...values: unknown[]): QueryD1Statement;
}

export interface RetrievalQueryD1 {
  prepare(sql: string): QueryD1Prepared;
}

function failQuery(code: RetrievalQueryErrorCode, message: string, retryable = false): never {
  throw new RetrievalQueryError(code, message, retryable);
}

function mapStoreError(error: unknown): never {
  if (error instanceof RetrievalQueryError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("RETRIEVAL_AUTHORITY_STALE")) {
    failQuery("RETRIEVAL_AUTHORITY_STALE", "scope authorization is denied, purged or expired");
  }
  if (message.includes("RETRIEVAL_TRACE_CORRUPT")) {
    failQuery("RETRIEVAL_TRACE_CORRUPT", "persisted trace binding does not match the frozen query");
  }
  if (message.includes("RETRIEVAL_CONFLICT") || message.includes("RETRIEVAL_IDEMPOTENCY_CONFLICT")) {
    failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "idempotency identity is bound to different inputs");
  }
  failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "query result settlement is uncertain", true);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checkAccess(access: RetrievalQueryAccess): void {
  if (
    typeof access.principal_ref !== "string" || access.principal_ref.length === 0 ||
    (access.client_class !== "owner_pwa" && access.client_class !== "named_api_client" &&
      access.client_class !== "trusted_agent" && access.client_class !== "federation_client") ||
    typeof access.credential_generation !== "string" || access.credential_generation.length === 0
  ) {
    failQuery("RETRIEVAL_INPUT_INVALID", "query access identity is invalid");
  }
}

interface ScopeAuthorityRow {
  readonly snapshot_digest: unknown;
  readonly invalidated_at: unknown;
  readonly expires_at: unknown;
  readonly purge_ledger_revision: unknown;
  readonly policy_authority_ref: unknown;
  readonly grant_state: unknown;
  readonly grant_expires_at: unknown;
  readonly grant_policy_ref: unknown;
  readonly purge_frontier: unknown;
  readonly stale_members: unknown;
}

async function readScopeAuthority(
  database: RetrievalQueryD1,
  snapshotId: string,
  revision: number,
  access: RetrievalQueryAccess,
): Promise<ScopeAuthorityRow | null> {
  const row = await database.prepare(
    "SELECT s.snapshot_digest, s.invalidated_at, s.expires_at, s.purge_ledger_revision, " +
    "s.policy_authority_ref, g.state AS grant_state, g.expires_at AS grant_expires_at, " +
    "g.policy_authority_ref AS grant_policy_ref, " +
    "COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger), 0) AS purge_frontier, " +
    "EXISTS (SELECT 1 FROM json_each(s.member_source_revision_refs_json) member WHERE NOT EXISTS (" +
    "SELECT 1 FROM source_revision sr JOIN source src ON src.source_id = sr.source_id " +
    "JOIN source_namespace_ownership o ON o.source_namespace_id = src.source_namespace_id " +
    "AND o.status = 'ACTIVE' " +
    "JOIN json_each(s.source_owner_generations_json) gen ON gen.key = member.value " +
    "WHERE sr.source_revision_ref = member.value AND sr.purge_state = 'LIVE' " +
    "AND sr.source_owner_generation = o.source_owner_generation " +
    "AND gen.value = sr.source_owner_generation)) AS stale_members " +
    "FROM scope_snapshot s LEFT JOIN scope_access_grant g " +
    "ON g.snapshot_id = s.snapshot_id AND g.snapshot_revision = s.revision " +
    "AND g.principal_ref = ?3 AND g.client_class = ?4 AND g.credential_generation = ?5 " +
    "WHERE s.snapshot_id = ?1 AND s.revision = ?2 LIMIT 1",
  ).bind(snapshotId, revision, access.principal_ref, access.client_class, access.credential_generation)
    .first<ScopeAuthorityRow>().catch(() => {
      failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "scope authority read is unavailable", true);
    });
  return row;
}

function requireLiveScope(row: ScopeAuthorityRow, scope: ScopeSnapshot, nowIso: string): void {
  if (row.snapshot_digest !== scope.digest || row.invalidated_at !== null) {
    failQuery("RETRIEVAL_SCOPE_STALE", "ScopeSnapshot is invalidated or displaced");
  }
  if (typeof row.expires_at !== "string" || Date.parse(row.expires_at) <= Date.parse(nowIso)) {
    failQuery("RETRIEVAL_SCOPE_STALE", "ScopeSnapshot expired");
  }
  if (row.purge_ledger_revision !== row.purge_frontier || row.stale_members !== 0) {
    failQuery("RETRIEVAL_SCOPE_STALE", "scope members are purged or rotated");
  }
  if (
    row.grant_state !== "ACTIVE" || row.grant_policy_ref !== row.policy_authority_ref ||
    typeof row.grant_expires_at !== "string" || Date.parse(row.grant_expires_at) <= Date.parse(nowIso)
  ) {
    failQuery("RETRIEVAL_AUTHORITY_STALE", "no active exact ScopeSnapshot authorization exists");
  }
}

export function createD1ScopePorts(
  database: RetrievalQueryD1,
  access: RetrievalQueryAccess,
  now: () => string = () => new Date().toISOString(),
): {
  freezeScope(request: RetrievalRequest): Promise<ScopeSnapshot>;
  requireCurrentScope(snapshot: ScopeSnapshot): Promise<void>;
} {
  checkAccess(access);
  return {
    async freezeScope(request: RetrievalRequest): Promise<ScopeSnapshot> {
      const parsed = ScopeSnapshotSchema.safeParse(request.scope_snapshot);
      if (!parsed.success) failQuery("RETRIEVAL_INPUT_INVALID", "scope snapshot fails strict validation");
      const scope = parsed.data;
      const row = await readScopeAuthority(database, scope.snapshot_id, scope.revision, access);
      if (row === null) failQuery("RETRIEVAL_SCOPE_STALE", "ScopeSnapshot does not exist");
      requireLiveScope(row, scope, now());
      return scope;
    },
    async requireCurrentScope(snapshot: ScopeSnapshot): Promise<void> {
      const parsed = ScopeSnapshotSchema.safeParse(snapshot);
      if (!parsed.success) failQuery("RETRIEVAL_INPUT_INVALID", "scope snapshot fails strict validation");
      const row = await readScopeAuthority(database, parsed.data.snapshot_id, parsed.data.revision, access);
      if (row === null) failQuery("RETRIEVAL_SCOPE_STALE", "ScopeSnapshot does not exist");
      requireLiveScope(row, parsed.data, now());
    },
  };
}

interface StoredResultRow {
  readonly request_digest: unknown;
  readonly result_json: unknown;
  readonly result_digest: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly trace_id: unknown;
  readonly trace_revision: unknown;
  readonly coverage_claim: unknown;
  readonly state: unknown;
}

function decodeStoredResult(row: StoredResultRow, idempotencyKey: string): StoredRetrievalResult {
  if (row.state === "INVALIDATED") {
    failQuery("RETRIEVAL_SCOPE_STALE", "stored query scope is invalidated");
  }
  if (
    typeof row.request_digest !== "string" || !/^[a-f0-9]{64}$/u.test(row.request_digest) ||
    typeof row.result_json !== "string" ||
    typeof row.result_digest !== "string" || row.state !== "COMPLETE"
  ) {
    failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query result is unavailable", true);
  }
  const parsed = decodeCanonicalRetrievalJson(row.result_json);
  const result = parsed === undefined ? null : decodeRetrievalResult(parsed);
  if (result === null) {
    failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query result is malformed or not a strict retrieval result", true);
  }
  return { request_digest: row.request_digest, idempotency_key: idempotencyKey, result };
}

export function createD1RetrievalResultStore(
  database: RetrievalQueryD1,
  access: RetrievalQueryAccess,
  now: () => string = () => new Date().toISOString(),
): {
  load(idempotencyKey: string): Promise<StoredRetrievalResult | null>;
  store(record: StoredRetrievalResult): Promise<void>;
} {
  checkAccess(access);
  return {
    async load(idempotencyKey: string): Promise<StoredRetrievalResult | null> {
      if (
        typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 256 ||
        /[\u0000-\u0020\u007f]/u.test(idempotencyKey)
      ) {
        failQuery("RETRIEVAL_INPUT_INVALID", "idempotency-key is required");
      }
      let row: StoredResultRow | null;
      try {
        row = await database.prepare(
          "SELECT request_digest, result_json, result_digest, scope_snapshot_id, scope_snapshot_revision, trace_id, trace_revision, coverage_claim, state FROM retrieval_query_result " +
          "WHERE principal_ref = ?1 AND client_class = ?2 AND credential_generation = ?3 " +
          "AND idempotency_key = ?4 LIMIT 1",
        ).bind(access.principal_ref, access.client_class, access.credential_generation, idempotencyKey)
          .first<StoredResultRow>();
      } catch {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query result is unavailable", true);
      }
      if (row === null) return null;
      const stored = decodeStoredResult(row, idempotencyKey);
      if (typeof row.result_json !== "string" || row.result_digest !== await sha256Hex(row.result_json) ||
          row.scope_snapshot_id !== stored.result.trace.scope_snapshot.snapshot_id ||
          row.scope_snapshot_revision !== stored.result.trace.scope_snapshot.revision ||
          row.scope_snapshot_id !== stored.result.evidence_pack.scope_snapshot_ref.id ||
          row.scope_snapshot_revision !== stored.result.evidence_pack.scope_snapshot_ref.revision ||
          row.trace_id !== stored.result.trace.trace_ref.id || row.trace_revision !== stored.result.trace.trace_ref.revision ||
          row.trace_id !== stored.result.evidence_pack.trace_ref.id || row.trace_revision !== stored.result.evidence_pack.trace_ref.revision ||
          row.coverage_claim !== stored.result.coverage_claim) {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query result metadata is not bound to its result", true);
      }
      let traceRow: { readonly trace_json: unknown; readonly trace_digest: unknown; readonly scope_snapshot_id: unknown; readonly scope_snapshot_revision: unknown } | null;
      try {
        traceRow = await database.prepare(
          "SELECT trace_json, trace_digest, scope_snapshot_id, scope_snapshot_revision FROM retrieval_query_trace WHERE trace_id = ?1 AND revision = ?2 LIMIT 1",
        ).bind(stored.result.trace.trace_ref.id, stored.result.trace.trace_ref.revision)
          .first<{ readonly trace_json: unknown; readonly trace_digest: unknown; readonly scope_snapshot_id: unknown; readonly scope_snapshot_revision: unknown }>();
      } catch {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query trace is unavailable", true);
      }
      const storedTraceValue = traceRow !== null && typeof traceRow.trace_json === "string"
        ? decodeCanonicalRetrievalJson(traceRow.trace_json)
        : undefined;
      if (traceRow === null || typeof traceRow.trace_json !== "string" || typeof traceRow.trace_digest !== "string" ||
          traceRow.trace_digest !== await sha256Hex(traceRow.trace_json) ||
          traceRow.scope_snapshot_id !== stored.result.trace.scope_snapshot.snapshot_id ||
          traceRow.scope_snapshot_revision !== stored.result.trace.scope_snapshot.revision ||
          traceRow.scope_snapshot_id !== stored.result.evidence_pack.scope_snapshot_ref.id ||
          traceRow.scope_snapshot_revision !== stored.result.evidence_pack.scope_snapshot_ref.revision ||
          storedTraceValue === undefined ||
          canonicalRetrievalJson(storedTraceValue) !== canonicalRetrievalJson(stored.result.trace)) {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query trace linkage is not bound to its result", true);
      }
      return stored;
    },
    async store(record: StoredRetrievalResult): Promise<void> {
      if (
        typeof record.idempotency_key !== "string" || typeof record.request_digest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record.request_digest)
      ) {
        failQuery("RETRIEVAL_INPUT_INVALID", "query result identity is invalid");
      }
      if (record.result.coverage_claim !== "NONE" && record.result.coverage_claim !== "SAMPLED") {
        failQuery("RETRIEVAL_INPUT_INVALID", "coverage stronger than SAMPLED is never stored");
      }
      const traceParsed = RetrievalTraceSchema.safeParse(record.result.trace);
      if (!traceParsed.success) failQuery("RETRIEVAL_INPUT_INVALID", "query trace fails strict validation");
      const trace = traceParsed.data;
      const resultJson = canonicalRetrievalJson(record.result);
      if (new TextEncoder().encode(resultJson).byteLength > 1000000) {
        failQuery("RETRIEVAL_INPUT_INVALID", "query result exceeds its bound");
      }
      const resultDigest = await sha256Hex(resultJson);
      const operationId = `q3-${(await sha256Hex(
        canonicalRetrievalJson({
          principal: access.principal_ref,
          client: access.client_class,
          credential: access.credential_generation,
          key: record.idempotency_key,
        }),
      )).slice(0, 48)}`;
      const createdAt = now();
      try {
        await database.prepare(
          "INSERT INTO retrieval_query_result (operation_id, principal_ref, client_class, " +
          "credential_generation, idempotency_key, request_digest, scope_snapshot_id, " +
          "scope_snapshot_revision, state, result_json, result_digest, trace_id, trace_revision, " +
          "coverage_claim, created_at, expires_at) VALUES " +
          "(?1,?2,?3,?4,?5,?6,?7,?8,'COMPLETE',?9,?10,?11,?12,?13,?14,?15) " +
          "ON CONFLICT DO NOTHING",
        ).bind(
          operationId, access.principal_ref, access.client_class, access.credential_generation,
          record.idempotency_key, record.request_digest, trace.scope_snapshot.snapshot_id,
          trace.scope_snapshot.revision, resultJson, resultDigest,
          trace.trace_ref.id, trace.trace_ref.revision, record.result.coverage_claim,
          createdAt, trace.scope_snapshot.expires_at,
        ).run();
      } catch (error) {
        mapStoreError(error);
      }
      let settled: StoredResultRow | null;
      try {
        settled = await database.prepare(
          "SELECT request_digest, result_json, result_digest, state FROM retrieval_query_result " +
          "WHERE operation_id = ?1 LIMIT 1",
        ).bind(operationId).first<StoredResultRow>();
      } catch {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "query result settlement is uncertain", true);
      }
      if (settled === null) {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "query result settlement is uncertain", true);
      }
      if (settled.request_digest !== record.request_digest || settled.result_digest !== resultDigest) {
        failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "idempotency identity is bound to different inputs");
      }
      if (settled.result_json !== resultJson) {
        failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "idempotency identity is bound to different inputs");
      }
      let traceRow: { readonly trace_json: unknown } | null;
      try {
        traceRow = await database.prepare(
          "SELECT trace_json FROM retrieval_query_trace WHERE trace_id = ?1 AND revision = ?2 LIMIT 1",
        ).bind(trace.trace_ref.id, trace.trace_ref.revision).first<{ readonly trace_json: unknown }>();
      } catch {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "query result settlement is uncertain", true);
      }
      if (traceRow === null || traceRow.trace_json !== canonicalRetrievalJson(trace)) {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "query trace linkage is uncertain", true);
      }
    },
  };
}

export function createD1RetrievalTracePort(
  database: RetrievalQueryD1,
  access: RetrievalQueryAccess,
  now: () => string = () => new Date().toISOString(),
): { persistTrace(trace: RetrievalTrace): Promise<VersionedRef> } {
  checkAccess(access);
  return {
    async persistTrace(trace: RetrievalTrace): Promise<VersionedRef> {
      const parsed = RetrievalTraceSchema.safeParse(trace);
      if (!parsed.success) failQuery("RETRIEVAL_INPUT_INVALID", "query trace fails strict validation");
      const body = parsed.data;
      const traceJson = canonicalRetrievalJson(body);
      if (new TextEncoder().encode(traceJson).byteLength > 262144) {
        failQuery("RETRIEVAL_INPUT_INVALID", "query trace exceeds its bound");
      }
      const traceDigest = await sha256Hex(traceJson);
      try {
        await database.prepare(
          "INSERT INTO retrieval_query_trace (trace_id, revision, scope_snapshot_id, " +
          "scope_snapshot_revision, trace_json, trace_digest, created_at) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT DO NOTHING",
        ).bind(
          body.trace_ref.id, body.trace_ref.revision, body.scope_snapshot.snapshot_id,
          body.scope_snapshot.revision, traceJson, traceDigest, now(),
        ).run();
      } catch (error) {
        mapStoreError(error);
      }
      let settled: { readonly trace_json: unknown; readonly trace_digest: unknown } | null;
      try {
        settled = await database.prepare(
          "SELECT trace_json, trace_digest FROM retrieval_query_trace " +
          "WHERE trace_id = ?1 AND revision = ?2 LIMIT 1",
        ).bind(body.trace_ref.id, body.trace_ref.revision)
          .first<{ readonly trace_json: unknown; readonly trace_digest: unknown }>();
      } catch {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "trace persistence is unavailable", true);
      }
      if (settled === null || settled.trace_json !== traceJson || settled.trace_digest !== traceDigest) {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "trace persistence is unavailable", true);
      }
      return body.trace_ref;
    },
  };
}

export function createQueryBudgetGuard(
  deadlineMs: number,
  isCancelled: () => boolean = () => false,
  nowMs: () => number = Date.now,
): { checkBudget(): void } {
  return {
    checkBudget(): void {
      if (isCancelled()) failQuery("RETRIEVAL_CANCELLED", "query is cancelled");
      if (!Number.isSafeInteger(deadlineMs) || nowMs() > deadlineMs) {
        failQuery("RETRIEVAL_BUDGET_STOP", "query budget is exhausted");
      }
    },
  };
}

export interface ScopeProfileBinding {
  readonly version: string;
  readonly max_sources: number;
  readonly max_results: number;
}

interface ScopeProfileRow {
  readonly profile_version: unknown;
  readonly max_sources: unknown;
  readonly max_results: unknown;
}

async function readScopeProfileBinding(
  database: RetrievalQueryD1,
  snapshotId: string,
  revision: number,
): Promise<ScopeProfileRow | null> {
  try {
    return await database.prepare(
      "SELECT profile_version, max_sources, max_results FROM retrieval_scope_profile " +
      "WHERE snapshot_id = ?1 AND revision = ?2 LIMIT 1",
    ).bind(snapshotId, revision).first<ScopeProfileRow>();
  } catch {
    failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "scope profile readback is unavailable", true);
  }
}

function decodeScopeProfileBinding(row: ScopeProfileRow | null): ScopeProfileBinding {
  if (
    row === null || typeof row.profile_version !== "string" ||
    row.profile_version.length < 1 || row.profile_version.length > 128 ||
    typeof row.max_sources !== "number" || !Number.isSafeInteger(row.max_sources) || row.max_sources < 1 ||
    typeof row.max_results !== "number" || !Number.isSafeInteger(row.max_results) || row.max_results < 1
  ) {
    failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "scope profile readback is malformed", true);
  }
  return {
    version: row.profile_version,
    max_sources: row.max_sources,
    max_results: row.max_results,
  };
}

async function loadScopeProfileBinding(
  database: RetrievalQueryD1,
  snapshot: ScopeSnapshot,
): Promise<ScopeProfileBinding> {
  const parsed = ScopeSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) failQuery("RETRIEVAL_INPUT_INVALID", "scope snapshot fails strict validation");
  return decodeScopeProfileBinding(
    await readScopeProfileBinding(database, parsed.data.snapshot_id, parsed.data.revision),
  );
}

function requireBindingMatch(row: ScopeProfileBinding | null, binding: ScopeProfileBinding): void {
  if (row === null) {
    failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "scope profile readback is unavailable", true);
  }
  if (
    row.version !== binding.version || row.max_sources !== binding.max_sources ||
    row.max_results !== binding.max_results
  ) {
    failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "scope frozen under another profile version does not replay here");
  }
}

export function createD1ScopeProfilePort(
  database: RetrievalQueryD1,
  now: () => string = () => new Date().toISOString(),
): {
  loadBinding(snapshot: ScopeSnapshot): Promise<ScopeProfileBinding>;
  recordBinding(snapshot: ScopeSnapshot, binding: ScopeProfileBinding): Promise<void>;
  requireBinding(snapshot: ScopeSnapshot, binding: ScopeProfileBinding): Promise<void>;
} {
  return {
    async loadBinding(snapshot: ScopeSnapshot): Promise<ScopeProfileBinding> {
      return loadScopeProfileBinding(database, snapshot);
    },
    async recordBinding(snapshot: ScopeSnapshot, binding: ScopeProfileBinding): Promise<void> {
      const parsed = ScopeSnapshotSchema.safeParse(snapshot);
      if (!parsed.success) failQuery("RETRIEVAL_INPUT_INVALID", "scope snapshot fails strict validation");
      try {
        await database.prepare(
          "INSERT INTO retrieval_scope_profile (snapshot_id, revision, profile_version, " +
          "max_sources, max_results, created_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT DO NOTHING",
        ).bind(
          parsed.data.snapshot_id, parsed.data.revision,
          binding.version, binding.max_sources, binding.max_results, now(),
        ).run();
      } catch (error) {
        mapStoreError(error);
      }
      requireBindingMatch(await loadScopeProfileBinding(database, parsed.data), binding);
    },
    async requireBinding(snapshot: ScopeSnapshot, binding: ScopeProfileBinding): Promise<void> {
      requireBindingMatch(await loadScopeProfileBinding(database, snapshot), binding);
    },
  };
}

export async function retrievalRequestDigest(input: {
  readonly raw_query: string;
  readonly product: string;
  readonly literals: readonly string[];
  readonly requested_limit: number;
  readonly scope_digest: string;
}): Promise<string> {
  return sha256Hex(canonicalRetrievalJson({
    raw_query: input.raw_query,
    product: input.product,
    literals: [...input.literals],
    requested_limit: input.requested_limit,
    scope_digest: input.scope_digest,
  }));
}
