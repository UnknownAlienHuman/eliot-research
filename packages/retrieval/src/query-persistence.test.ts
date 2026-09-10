import { describe, expect, it } from "vitest";
// @ts-expect-error - node:sqlite runtime types ship with Node 22.13+, not @types/node
import { DatabaseSync } from "node:sqlite";
import type {
  LocatorCandidate,
  ResolvedEvidence,
  RetrievalLane,
  ScopeSnapshot,
} from "@eliotr/contracts";
import type { RetrievalRequest } from "./ports.js";
import {
  canonicalRetrievalJson,
  createD1RetrievalResultStore,
  createD1RetrievalTracePort,
  createD1ScopePorts,
  type RetrievalQueryAccess,
  type RetrievalQueryD1,
} from "./query-persistence.js";
import {
  createRetrievalQueryService,
  RetrievalQueryError,
  type RetrievalQueryPorts,
} from "./service.js";
import { verifyPinnedExactEvidence } from "./evidence-resolver.js";

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true; query: string; import: string }): Record<string, string>;
  }
}

// Committed Core migration stream is the only schema authority; no in-test DDL.
const CORE_MIGRATIONS = import.meta.glob("../../../infra/d1/core/migrations/*.sql", {
  eager: true, query: "?raw", import: "default",
});

interface RawStatement {
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  run(...args: unknown[]): { changes?: unknown };
}
interface RawDatabase {
  prepare(sql: string): RawStatement;
  exec(sql: string): void;
}
function spread(params: readonly unknown[]): never[] {
  return params as never[];
}
function makeD1(database: RawDatabase): RetrievalQueryD1 {
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        async first<T>() {
          const statement = database.prepare(sql);
          const row = (params.length === 0 ? statement.get() : statement.get(...spread(params))) as T | undefined;
          return (row ?? null) as T | null;
        },
        async all<T>() {
          const statement = database.prepare(sql);
          const rows = (params.length === 0 ? statement.all() : statement.all(...spread(params))) as unknown as T[];
          return { results: rows };
        },
        async run() {
          const statement = database.prepare(sql);
          if (params.length === 0) statement.run();
          else statement.run(...spread(params));
          return { meta: { changes: 0 } };
        },
      }),
    }),
  };
}

async function shaHex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const ACCESS: RetrievalQueryAccess = {
  principal_ref: "q3-owner",
  client_class: "owner_pwa",
  credential_generation: "cred-1",
};
const CREATED = "2026-09-08T00:00:00.000Z";
const EXPIRY = "2026-09-09T00:00:00.000Z";

function scopeFixture(overrides: Partial<ScopeSnapshot> = {}): ScopeSnapshot {
  return {
    snapshot_id: "snap-1",
    revision: 1,
    resolved_scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] },
    participant_generations: { "member-policy-closure": "policy-1" },
    member_source_revision_refs: ["rev-1"],
    source_owner_generations: { "rev-1": "owner-gen-1" },
    policy_authority_ref: "policy-1",
    disclosure_closure_digest: "a".repeat(64),
    purge_ledger_revision: 0,
    digest: "b".repeat(64),
    created_at: CREATED,
    expires_at: EXPIRY,
    ...overrides,
  };
}

function openDatabase(): { raw: RawDatabase; d1: RetrievalQueryD1 } {
  const raw = new DatabaseSync(":memory:") as unknown as RawDatabase;
  for (const name of Object.keys(CORE_MIGRATIONS).sort()) {
    raw.exec(CORE_MIGRATIONS[name] as string);
  }
  return { raw, d1: makeD1(raw) };
}

function insert(database: RawDatabase, table: string, fields: Record<string, string | number | null>): void {
  const keys = Object.keys(fields);
  const statement = database.prepare(
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => `?${i + 1}`).join(",")})`,
  );
  statement.run(...(Object.values(fields) as never[]));
}

function seedAuthority(database: RawDatabase, scope: ScopeSnapshot, withGrant: boolean): void {
  insert(database, "source_namespace_ownership", {
    source_namespace_id: "ns-1", ownership_record_revision: 1, owner_system_id: "eliotr",
    owner_incarnation_ref: "incarnation-1", source_owner_generation: "owner-gen-1",
    source_admission_policy_revision: 1, status: "ACTIVE", cutover_receipt_ref: null, created_at: CREATED,
  });
  insert(database, "source", {
    source_id: "source-1", source_namespace_id: "ns-1", source_owner_system_id: "eliotr",
    source_owner_generation: "owner-gen-1", ownership_mode: "immutable_import", kind: "document",
    origin_uri: null, title: "Source 1", default_storage_policy: "NORMALIZED_CLOUD_ONLY",
    default_residency_profile_id: "residency-1", source_class: "document", license_policy_ref: "license-1",
    default_retention_policy_id: "retention-1", head_rev: "rev-1", created_at: CREATED,
  });
  insert(database, "source_revision", {
    source_revision_ref: "rev-1", source_id: "source-1", source_owner_generation: "owner-gen-1",
    content_sha256: "e".repeat(64), object_residency_key_digest: "d".repeat(64),
    original_r2_key: null, normalized_artifact_ref: "normalized/1", captured_at: CREATED,
    parser_profile_generation: null, quality_state: "standard", purge_state: "LIVE",
    currentness_state: "unknown", source_view_ref: "view-1", workspace_view_revision_ref: null, admitted_at: CREATED,
  });
  insert(database, "scope_snapshot", {
    snapshot_id: scope.snapshot_id, revision: scope.revision,
    resolved_scope_expression_json: JSON.stringify(scope.resolved_scope_expression),
    participant_generations_json: JSON.stringify(scope.participant_generations),
    member_source_revision_refs_json: JSON.stringify(scope.member_source_revision_refs),
    source_owner_generations_json: JSON.stringify(scope.source_owner_generations),
    policy_authority_ref: scope.policy_authority_ref,
    disclosure_closure_digest: scope.disclosure_closure_digest,
    purge_ledger_revision: scope.purge_ledger_revision, client_fence_ref: null,
    snapshot_digest: scope.digest, created_at: scope.created_at, expires_at: scope.expires_at,
    invalidated_at: null, invalidation_reason: null,
  });
  if (withGrant) {
    insert(database, "scope_access_grant", {
      snapshot_id: scope.snapshot_id, snapshot_revision: scope.revision,
      principal_ref: ACCESS.principal_ref, client_class: ACCESS.client_class,
      credential_generation: ACCESS.credential_generation,
      policy_authority_ref: scope.policy_authority_ref, allowed_use_json: '["research"]',
      disclosure_ceiling: "private", authorization_receipt_ref: "auth-1",
      state: "ACTIVE", expires_at: EXPIRY, created_at: CREATED,
    });
  }
}

function count(database: RawDatabase, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

const EXCERPT = "hello";
const FULL_TEXT = "hello world";

function candidateFixture(): LocatorCandidate {
  return {
    candidate_id: "c-1", lane: "LEX", source_revision_ref: "rev-1",
    canonical_section_id: "sec-1", preview: "", raw_score: 1, rank: 1,
    index_generation: "gen-1", metadata: {},
  };
}

async function resolveExact(candidate: LocatorCandidate, scope: ScopeSnapshot): Promise<ResolvedEvidence | null> {
  const excerptSha = await shaHex(EXCERPT);
  try {
    await verifyPinnedExactEvidence({
      handle: {
        handle_ref: { id: "evidence-1", revision: 1 },
        source_namespace_id: "ns-1",
        source_owner_generation: "owner-gen-1",
        source_revision_ref: candidate.source_revision_ref,
        scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
        anchor: { kind: "normalized_byte_range", start: 0, end: 5 },
        excerpt_sha256: excerptSha,
        excerpt_byte_length: 5,
        object_residency_key_digest: "d".repeat(64),
        source_assurance_ceiling: "QUALIFIED",
        materializer_assurance_ceiling: "EXACT",
        terminal_state: "LIVE",
        created_at: CREATED,
      },
      scope,
      source: {
        source_revision_ref: "rev-1", source_namespace_id: "ns-1",
        source_owner_generation: "owner-gen-1", content_sha256: "e".repeat(64),
        object_residency_key_digest: "d".repeat(64), purge_state: "LIVE",
      },
      materialized: {
        exact_excerpt: EXCERPT, excerpt_sha256: excerptSha, excerpt_byte_length: 5,
        source_object_size: new TextEncoder().encode(FULL_TEXT).byteLength,
        source_object_sha256: "e".repeat(64),
      },
      exact_probes: ["hello"],
    });
  } catch {
    return null;
  }
  return {
    handle: {
      handle_ref: { id: "evidence-1", revision: 1 },
      source_namespace_id: "ns-1",
      source_owner_generation: "owner-gen-1",
      source_revision_ref: candidate.source_revision_ref,
      scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
      anchor: { kind: "normalized_byte_range", start: 0, end: 5 },
      excerpt_sha256: excerptSha,
      excerpt_byte_length: 5,
      object_residency_key_digest: "d".repeat(64),
      source_assurance_ceiling: "QUALIFIED",
      materializer_assurance_ceiling: "EXACT",
      terminal_state: "LIVE",
      created_at: CREATED,
    },
    exact_excerpt: EXCERPT,
    verification_receipt_ref: "vr-1",
    authorization_receipt_ref: "auth-1",
    credential_generation: ACCESS.credential_generation,
    source_revision_content_sha256: "e".repeat(64),
    scope_snapshot_digest: scope.digest,
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    resolved_at: CREATED,
  };
}

function portsFor(d1: RetrievalQueryD1, scope: ScopeSnapshot, overrides: Partial<RetrievalQueryPorts> = {}): RetrievalQueryPorts {
  const frozen = createD1ScopePorts(d1, ACCESS, () => CREATED);
  return {
    freezeScope: frozen.freezeScope,
    requireCurrentScope: frozen.requireCurrentScope,
    lanes: {
      executorFor: (lane: RetrievalLane) =>
        lane === "LEX"
          ? { async execute() { return [candidateFixture()]; } }
          : null,
    },
    fusion: { reciprocal_rank_constant: 60, lane_weights: {}, maxPerSourceRevision: 5 },
    resolveEvidence: (candidate, frozenScope) => resolveExact(candidate, frozenScope),
    persistTrace: createD1RetrievalTracePort(d1, ACCESS, () => CREATED).persistTrace,
    results: createD1RetrievalResultStore(d1, ACCESS, () => CREATED),
    checkBudget: () => {},
    ...overrides,
  };
}

function requestFor(scope: ScopeSnapshot, rawQuery = "needle"): RetrievalRequest {
  return {
    raw_query: rawQuery, product: "RESEARCH", scope_snapshot: scope,
    literals: ["needle"], requested_limit: 10, deadline_ms: 1000,
  };
}

async function queryError(promise: Promise<unknown>): Promise<RetrievalQueryError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RetrievalQueryError) return error;
    throw new Error(`expected RetrievalQueryError, got ${String(error)}`, { cause: error });
  }
  throw new Error("expected query to fail");
}

describe("Q3 D1 query persistence over migration 0021", () => {
  it("applies the migration stream on a fresh database with the new tables", () => {
    const { raw } = openDatabase();
    const tables = (raw.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'retrieval_query%' ORDER BY name",
    ).all() as { name: string }[]).map((row) => row.name);
    expect(tables).toEqual(["retrieval_query_result", "retrieval_query_trace"]);
  });

  it("persists result, evidence pack and trace rows for a query", async () => {
    const { raw, d1 } = openDatabase();
    const scope = scopeFixture();
    seedAuthority(raw, scope, true);
    const service = createRetrievalQueryService(portsFor(d1, scope));
    const result = await service.query({ request: requestFor(scope), idempotency_key: "persist-1" });
    expect(result.coverage_claim).toBe("SAMPLED");
    expect(result.evidence_pack.resolved_evidence).toHaveLength(1);
    expect(count(raw, "retrieval_query_result")).toBe(1);
    expect(count(raw, "retrieval_query_trace")).toBe(1);
    const stored = raw.prepare(
      "SELECT request_digest, result_digest, trace_id, trace_revision, coverage_claim, state FROM retrieval_query_result",
    ).get() as {
      request_digest: string; result_digest: string; trace_id: string;
      trace_revision: number; coverage_claim: string; state: string;
    };
    expect(stored.state).toBe("COMPLETE");
    expect(stored.coverage_claim).toBe("SAMPLED");
    expect(stored.trace_id).toBe(result.trace.trace_ref.id);
    expect(stored.trace_revision).toBe(result.trace.trace_ref.revision);
    expect(stored.result_digest).toBe(await shaHex(canonicalRetrievalJson(result)));
    const trace = raw.prepare(
      "SELECT trace_json, trace_digest FROM retrieval_query_trace",
    ).get() as { trace_json: string; trace_digest: string };
    expect(trace.trace_json).toBe(canonicalRetrievalJson(result.trace));
    expect(trace.trace_digest).toBe(await shaHex(trace.trace_json));
  });

  it("rejects a replay whose result digest no longer matches its stored bytes", async () => {
    const { raw, d1 } = openDatabase();
    const scope = scopeFixture();
    seedAuthority(raw, scope, true);
    await createRetrievalQueryService(portsFor(d1, scope)).query({
      request: requestFor(scope), idempotency_key: "digest-drift-1",
    });
    const tampered: RetrievalQueryD1 = {
      prepare(sql) {
        const original = d1.prepare(sql);
        return {
          bind(...values: unknown[]) {
            const bound = original.bind(...values);
            return {
              async first<T>() {
                const row = await bound.first<T>();
                if (row !== null && sql.startsWith("SELECT request_digest, result_json, result_digest")) {
                  return { ...(row as T & { readonly result_digest: string }), result_digest: "0".repeat(64) } as T;
                }
                return row;
              },
              all: <T>() => bound.all<T>(),
              run: () => bound.run(),
            };
          },
        };
      },
    };
    const error = await queryError(createD1RetrievalResultStore(tampered, ACCESS).load("digest-drift-1"));
    expect(error.code).toBe("RETRIEVAL_RESOLUTION_UNCERTAIN");
    expect(error.retryable).toBe(true);
  });

  it("replays the same retry without duplicate rows and conflicts on changed input", async () => {
    const { raw, d1 } = openDatabase();
    const scope = scopeFixture();
    seedAuthority(raw, scope, true);
    const service = createRetrievalQueryService(portsFor(d1, scope));
    const first = await service.query({ request: requestFor(scope), idempotency_key: "replay-1" });
    const second = await service.query({ request: requestFor(scope), idempotency_key: "replay-1" });
    expect(second.evidence_pack.pack_ref).toEqual(first.evidence_pack.pack_ref);
    expect(count(raw, "retrieval_query_result")).toBe(1);
    expect(count(raw, "retrieval_query_trace")).toBe(1);
    const conflict = await queryError(service.query({
      request: requestFor(scope, "changed"), idempotency_key: "replay-1",
    }));
    expect(conflict.code).toBe("RETRIEVAL_IDEMPOTENCY_CONFLICT");
    expect(count(raw, "retrieval_query_result")).toBe(1);
  });

  it("persists nothing when the scope is expired or the grant is denied", async () => {
    const expired = openDatabase();
    seedAuthority(expired.raw, scopeFixture({ expires_at: "2026-01-01T00:00:00.000Z" }), true);
    const expiredError = await queryError(createRetrievalQueryService(
      portsFor(expired.d1, scopeFixture()),
    ).query({ request: requestFor(scopeFixture()), idempotency_key: "expired-1" }));
    expect(expiredError.code).toBe("RETRIEVAL_SCOPE_STALE");
    expect(count(expired.raw, "retrieval_query_result")).toBe(0);
    expect(count(expired.raw, "retrieval_query_trace")).toBe(0);
    const denied = openDatabase();
    seedAuthority(denied.raw, scopeFixture(), false);
    const deniedError = await queryError(createRetrievalQueryService(
      portsFor(denied.d1, scopeFixture()),
    ).query({ request: requestFor(scopeFixture()), idempotency_key: "denied-1" }));
    expect(deniedError.code).toBe("RETRIEVAL_AUTHORITY_STALE");
    expect(count(denied.raw, "retrieval_query_result")).toBe(0);
    expect(count(denied.raw, "retrieval_query_trace")).toBe(0);
  });

  it("refuses a substituted trace cursor with no stored rows", async () => {
    const { raw, d1 } = openDatabase();
    const scope = scopeFixture();
    seedAuthority(raw, scope, true);
    const trace = createD1RetrievalTracePort(d1, ACCESS, () => CREATED);
    const service = createRetrievalQueryService(portsFor(d1, scope));
    const result = await service.query({ request: requestFor(scope), idempotency_key: "sub-1" });
    const bodyJson = canonicalRetrievalJson(result.trace);
    let failed = false;
    try {
      raw.prepare(
        "INSERT INTO retrieval_query_trace (trace_id, revision, scope_snapshot_id, " +
        "scope_snapshot_revision, trace_json, trace_digest, created_at) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7)",
      ).run(
        "query-substituted", 1, scope.snapshot_id, scope.revision,
        bodyJson, await shaHex(bodyJson), CREATED,
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(count(raw, "retrieval_query_trace")).toBe(1);
    expect(trace).toBeDefined();
    const substituted = await queryError(createRetrievalQueryService(portsFor(d1, scope, {
      persistTrace: () => Promise.resolve({ id: "query-substituted", revision: 1 }),
    })).query({ request: requestFor(scope), idempotency_key: "sub-2" }));
    expect(substituted.code).toBe("RETRIEVAL_TRACE_CORRUPT");
    expect(count(raw, "retrieval_query_result")).toBe(1);
  });

  it("invalidates the cached result when the grant is revoked while keeping trace history", async () => {
    const { raw, d1 } = openDatabase();
    const scope = scopeFixture();
    seedAuthority(raw, scope, true);
    const service = createRetrievalQueryService(portsFor(d1, scope));
    await service.query({ request: requestFor(scope), idempotency_key: "revoke-1" });
    raw.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE authorization_receipt_ref='auth-1'").run();
    const row = raw.prepare(
      "SELECT state, result_json FROM retrieval_query_result",
    ).get() as { state: string; result_json: string | null };
    expect(row).toEqual({ state: "INVALIDATED", result_json: null });
    expect(count(raw, "retrieval_query_trace")).toBe(1);
  });
});
