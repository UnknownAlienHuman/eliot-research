// ER-24/Q8 composes the Q7 job loop behind research.query. The default runtime
// derives inventory from admitted normalized manifests and persisted navigation
// artifacts, and reads only LIVE user-loop handles through the pinned R2 port.
import {
  executeExhaustiveShard,
  exhaustiveRequestDigest,
  createD1ExhaustiveJobStore,
  planExhaustiveScan,
  reconcileExhaustiveJob,
  type ExhaustiveSectionDescriptor,
  type ExactScanPlan,
  type ExhaustiveSectionReader,
  type ExhaustiveJobStore,
  type RetrievalQueryAccess,
  type ExhaustiveReconcileStatus,
  type VerifyPinnedExactInput,
  createD1ScopePorts,
} from "@eliotr/retrieval";
import type { ScopeExpression, ScopeSnapshot } from "@eliotr/contracts";
import { ScopeExpressionSchema } from "@eliotr/contracts";
import { inspectScopeExpression } from "@eliotr/domain";
import {
  D1SearchLaneError,
  pinReadyGenerations,
  requirePinnedCoverage,
  type PinnedGeneration,
} from "@eliotr/cloudflare-projection";
import {
  createD1EvidenceAuthorityPort,
  createCloudflareEvidenceResolver,
  createR2EvidenceContentPort,
  readAdmittedNormalizedManifest,
  EvidenceRuntimeError,
} from "@eliotr/cloudflare-evidence";
import { createD1ScopeService } from "./d1-scope-service.js";
import { ScopeServiceError } from "./scope-service.js";
import { createOwnerScopeAuthority } from "./orientation-authority.js";
import type {
  AuthenticatedRequestContext,
  ExhaustiveQueryResult,
  QueryRequest,
} from "@eliotr/interfaces";
export interface ExhaustiveQueryEnvironment {
  readonly CORE_DB: D1Database;
  readonly SEARCH_DB?: D1Database;
  readonly EVIDENCE_BUCKET?: R2Bucket;
}

export const EXHAUSTIVE_QUERY_PROTOCOL = "eliotr.exhaustive-query.v1" as const;
export const EXHAUSTIVE_QUERY_BUDGET = "exhaustive-job-v1" as const;
export const EXHAUSTIVE_QUERY_MAX_SOURCES = 4096;
export const EXHAUSTIVE_QUERY_MAX_RESULTS = 16;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_SCOPE_DEPTH = 32;
const MAX_SCOPE_ATOMS = 256;

export class ExhaustiveQueryError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ExhaustiveQueryError";
  }
}

function fail(code: string, message: string, status = 400, retryable = false): never {
  throw new ExhaustiveQueryError(code, message, status, retryable);
}

function checkQuery(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 ||
      new TextEncoder().encode(value).byteLength > MAX_QUERY_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("RESEARCH_INPUT_INVALID", "query is invalid");
  }
  return value;
}

function checkScope(value: unknown): ScopeExpression {
  const parsed = ScopeExpressionSchema.safeParse(value);
  if (!parsed.success) fail("RESEARCH_INPUT_INVALID", "scope_expression is invalid");
  const metrics = inspectScopeExpression(parsed.data);
  if (metrics.depth > MAX_SCOPE_DEPTH || metrics.atom_count > MAX_SCOPE_ATOMS ||
      metrics.selected_source_count > EXHAUSTIVE_QUERY_MAX_SOURCES) {
    fail("RESEARCH_INPUT_LIMIT", "scope_expression exceeds its exhaustive bounds", 413);
  }
  return parsed.data;
}

function exactKeys(record: Record<string, unknown>): void {
  const expected = ["query", "product", "scope_expression", "literals", "evidence_grade", "budget_ref", "max_results"];
  if (Object.keys(record).length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) {
    fail("RESEARCH_INPUT_INVALID", "request has unknown or missing fields");
  }
}

function parseLiterals(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length !== 0) {
    fail("RESEARCH_INPUT_INVALID", "literals must be empty for the exhaustive query profile");
  }
  return [];
}

function parseMaxResults(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > EXHAUSTIVE_QUERY_MAX_RESULTS) {
    fail("RESEARCH_INPUT_INVALID", "max_results is invalid");
  }
  return value as number;
}

export function parseExhaustiveQueryRequest(raw: unknown): ExhaustiveQueryRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("RESEARCH_INPUT_INVALID", "query request must be an object");
  }
  const record = raw as Record<string, unknown>;
  exactKeys(record);
  if (record.product !== "EXHAUSTIVE_JOB" || record.evidence_grade !== "E0" ||
      record.budget_ref !== EXHAUSTIVE_QUERY_BUDGET) {
    fail("RESEARCH_PROFILE_UNSUPPORTED", "request does not match the exhaustive job profile", 422);
  }
  return {
    query: checkQuery(record.query),
    product: "EXHAUSTIVE_JOB",
    scope_expression: checkScope(record.scope_expression),
    literals: parseLiterals(record.literals),
    evidence_grade: "E0",
    budget_ref: EXHAUSTIVE_QUERY_BUDGET,
    max_results: parseMaxResults(record.max_results),
  };
}

export type ExhaustiveQueryRequest = QueryRequest & {
  readonly product: "EXHAUSTIVE_JOB";
  readonly evidence_grade: "E0";
  readonly budget_ref: typeof EXHAUSTIVE_QUERY_BUDGET;
};

export function exhaustiveIdempotencyKey(context: AuthenticatedRequestContext): string {
  const value = context.request.headers.get("idempotency-key");
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u0020\u007f]/u.test(value)) {
    fail("RESEARCH_INPUT_INVALID", "idempotency-key header is required");
  }
  return value;
}

function requireOwner(context: AuthenticatedRequestContext): void {
  if (context.client_class !== "owner_pwa") fail("RESEARCH_OWNER_REQUIRED", "research query requires the owner profile", 403);
}

export interface ExhaustiveQueryRuntime {
  /** Resolve and persist the frozen scope from the authenticated request. */
  freezeScope(expression: ScopeExpression, credentialGeneration: string): Promise<ScopeSnapshot>;
  /** Load a previously frozen scope for a COMPLETE idempotent replay. */
  loadScope?(snapshotId: string, revision: number): Promise<ScopeSnapshot>;
  requireCurrentScope(scope: ScopeSnapshot): Promise<void>;
  /** Read-only final fence used before disclosing a cached COMPLETE result. */
  recheckCurrentScope?(scope: ScopeSnapshot): Promise<void>;
  /** Inventory is authoritative: it must come from the admitted normalized manifest. */
  inventorySections(scope: ScopeSnapshot): Promise<readonly ExhaustiveSectionDescriptor[]>;
  /** Return a pinned exact input; request supplied section identities are never trusted. */
  readSection(scope: ScopeSnapshot, sectionRef: string): Promise<VerifyPinnedExactInput>;
  checkBudget(signal: AbortSignal): void;
}

export interface ExhaustiveQueryOptions {
  readonly runtime?: (context: AuthenticatedRequestContext) => ExhaustiveQueryRuntime;
  readonly storeFactory?: (access: RetrievalQueryAccess) => ExhaustiveJobStore;
}

function unavailableRuntime(): ExhaustiveQueryRuntime {
  return {
    freezeScope: async () => fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted exhaustive section authority is not configured", 503, true),
    requireCurrentScope: async () => fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted exhaustive section authority is not configured", 503, true),
    inventorySections: async () => fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted exhaustive section authority is not configured", 503, true),
    readSection: async () => fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted exhaustive section authority is not configured", 503, true),
    checkBudget: () => undefined,
  };
}

function mapRetrievalError(error: unknown): never {
  if (error instanceof ExhaustiveQueryError) throw error;
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (code === "RETRIEVAL_INPUT_INVALID") {
    fail("RESEARCH_INPUT_INVALID", error instanceof Error ? error.message : "exhaustive request is invalid");
  }
  if (code === "RETRIEVAL_SCOPE_STALE") fail("RESEARCH_AUTHORITY_STALE", "exhaustive scope authority is stale", 409);
  if (code === "RETRIEVAL_AUTHORITY_STALE") fail("RESEARCH_AUTHORITY_STALE", "exhaustive scope authority is stale", 409);
  if (code === "RETRIEVAL_IDEMPOTENCY_CONFLICT") fail("RESEARCH_CONFLICT", "idempotency identity is bound to different inputs", 409);
  if (code === "RETRIEVAL_RESOLUTION_UNCERTAIN") fail("RESEARCH_SETTLEMENT_UNCERTAIN", "exhaustive settlement is uncertain", 503, true);
  if (code === "RETRIEVAL_BUDGET_STOP") fail("RESEARCH_BUDGET_STOP", "exhaustive budget was exhausted", 409);
  if (code === "RETRIEVAL_CANCELLED") fail("RESEARCH_CANCELLED", "exhaustive request was cancelled", 409);
  if (typeof code === "string" && code.startsWith("EXHAUSTIVE_")) {
    fail("RESEARCH_INPUT_INVALID", error instanceof Error ? error.message : "exhaustive plan is invalid");
  }
  throw error;
}

function mapRuntimeError(error: unknown): never {
  if (error instanceof ExhaustiveQueryError) throw error;
  if (error instanceof D1SearchLaneError) {
    if (error.code === "SEARCH_UNAVAILABLE") {
      fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted exhaustive projection is not ready", 503, true);
    }
    if (error.code === "SEARCH_INCOMPLETE") {
      fail("RESEARCH_AUTHORITY_STALE", "admitted exhaustive projection is incomplete or stale", 409);
    }
    fail("RESEARCH_SETTLEMENT_UNCERTAIN", "admitted exhaustive projection settlement is uncertain", 503, true);
  }
  const code = (error as { readonly code?: unknown } | null)?.code;
  const status = (error as { readonly status?: unknown } | null)?.status;
  if (error instanceof ScopeServiceError && error.code === "SCOPE_SNAPSHOT_STALE") {
    fail("RESEARCH_AUTHORITY_STALE", "exhaustive scope authority is stale", 409);
  }
  if (typeof code === "string" && code.startsWith("ORIENTATION_")) {
    if (status === 413) fail("RESEARCH_INPUT_LIMIT", "exhaustive scope exceeds its bound", 413);
    if (status === 503) fail("RESEARCH_SETTLEMENT_UNCERTAIN", "exhaustive scope authority is unavailable", 503, true);
    if (status === 403) fail("RESEARCH_OWNER_REQUIRED", "exhaustive scope is not authorized", 403);
    fail("RESEARCH_AUTHORITY_STALE", "exhaustive scope authority is stale", 409);
  }
  if (typeof code === "string" && code.startsWith("NAVIGATION_")) {
    if (code === "NAVIGATION_SCOPE_NOT_CURRENT" || code === "NAVIGATION_SCOPE_MISMATCH") {
      fail("RESEARCH_AUTHORITY_STALE", "exhaustive navigation authority is stale", 409);
    }
    fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted exhaustive navigation is unavailable", 503, true);
  }
  if (error instanceof EvidenceRuntimeError) {
    if (error.code === "EVIDENCE_AUTHORIZATION_DENIED" || error.code === "EVIDENCE_OWNER_GENERATION_MISMATCH" || error.code === "EVIDENCE_SCOPE_MISMATCH" || error.code === "EVIDENCE_SOURCE_NOT_LIVE" || error.code === "EVIDENCE_LOCATOR_NOT_RESOLVABLE") {
      fail("RESEARCH_AUTHORITY_STALE", "exhaustive evidence authority is stale", 409);
    }
    if (error.code === "EVIDENCE_OBJECT_NOT_FOUND" || error.code === "EVIDENCE_INPUT_INVALID") {
      fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted exhaustive evidence is unavailable", 503, true);
    }
    fail("RESEARCH_SETTLEMENT_UNCERTAIN", "exhaustive evidence settlement is uncertain", 503, true);
  }
  throw error;
}

interface ExhaustiveProjectionRow {
  readonly item_key: unknown;
  readonly canonical_section_id: unknown;
  readonly content_sha256: unknown;
  readonly projection_generation: unknown;
  readonly normalized_start_byte: unknown;
  readonly normalized_end_byte: unknown;
}

function productionRuntime(env: ExhaustiveQueryEnvironment & {
  readonly SEARCH_DB: D1Database;
  readonly EVIDENCE_BUCKET: R2Bucket;
}, context: AuthenticatedRequestContext): ExhaustiveQueryRuntime {
  const access = { principal_ref: context.principal_ref, client_class: context.client_class, credential_generation: context.credential_generation } as const;
  const owner = createOwnerScopeAuthority(env.CORE_DB, access);
  const freezer = createD1ScopeService(env.CORE_DB, owner, {
    max_snapshot_members: EXHAUSTIVE_QUERY_MAX_SOURCES,
    resolveAtom: owner.exhaustiveResolveAtom,
    resolveAuthorityClosure: owner.exhaustiveResolveAuthorityClosure,
    preserve_resolution_errors: true,
  });
  const scopePorts = createD1ScopePorts(env.CORE_DB, access);
  const evidence = createD1EvidenceAuthorityPort({ core_database: env.CORE_DB, search_database: env.SEARCH_DB });
  const content = createR2EvidenceContentPort({ evidence_bucket: env.EVIDENCE_BUCKET });
  const resolver = createCloudflareEvidenceResolver({ authority: evidence, content });
  let scopeForRequest: ScopeSnapshot | undefined;
  let pinnedInventory: readonly PinnedGeneration[] | undefined;
  const sections = new Map<string, { readonly source_revision_ref: string; readonly section_ref: string; readonly item_key: string; readonly content_sha256: string; readonly projection_generation: string; readonly start: number; readonly end: number }>();
  async function readPinned(scope: ScopeSnapshot): Promise<readonly PinnedGeneration[]> {
    const coverage = await pinReadyGenerations(
      env.SEARCH_DB,
      "exact",
      scope.member_source_revision_refs,
      scope.source_owner_generations,
    );
    requirePinnedCoverage(coverage.pinned, coverage.missing, coverage.stale);
    if (coverage.pinned.length !== scope.member_source_revision_refs.length) {
      throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive projection coverage does not match the frozen scope", 409);
    }
    if (new Set(coverage.pinned.map((pin) => pin.source_revision_ref)).size !== coverage.pinned.length) {
      throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive projection coverage contains duplicate sources", 409);
    }
    return coverage.pinned;
  }
  function assertSamePins(before: readonly PinnedGeneration[], after: readonly PinnedGeneration[]): void {
    if (before.length !== after.length) {
      throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive projection coverage changed during readback", 409);
    }
    const currentBySource = new Map(after.map((candidate) => [candidate.source_revision_ref, candidate]));
    for (const prior of before) {
      const current = currentBySource.get(prior.source_revision_ref);
      if (current === undefined || current.projection_generation !== prior.projection_generation ||
          current.receipt_ref !== prior.receipt_ref || current.readback_digest !== prior.readback_digest ||
          current.item_set_digest !== prior.item_set_digest || current.item_count !== prior.item_count) {
        throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive projection generation changed during readback", 409);
      }
    }
  }
  async function authorize(scope: ScopeSnapshot): Promise<void> {
    await freezer.requireCurrent(scope);
    await owner.exhaustiveGrant(scope);
    await scopePorts.requireCurrentScope(scope);
  }
  async function recheckCurrentScope(scope: ScopeSnapshot): Promise<void> {
    await freezer.requireCurrent(scope);
    await scopePorts.requireCurrentScope(scope);
    const sources = await owner.exhaustiveSources(scope.member_source_revision_refs);
    const current = await readPinned(scope);
    if (sources.length !== current.length) {
      throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive source authority changed during readback", 409);
    }
    if (pinnedInventory !== undefined) assertSamePins(pinnedInventory, current);
    await freezer.requireCurrent(scope);
    await scopePorts.requireCurrentScope(scope);
    const finalSources = await owner.exhaustiveSources(scope.member_source_revision_refs);
    if (finalSources.length !== current.length) {
      throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive source authority changed after projection readback", 409);
    }
  }
  return {
    async freezeScope(expression, credentialGeneration) {
      await owner.exhaustiveRequireReadPolicy();
      const snapshot = await freezer.freeze(expression, credentialGeneration);
      await authorize(snapshot);
      scopeForRequest = snapshot;
      return snapshot;
    },
    async loadScope(snapshotId, revision) {
      const authority = await evidence.loadScope({ id: snapshotId, revision });
      if (authority === null) throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive scope authority is unavailable", 409);
      await evidence.authorizeScope(authority, access);
      await authorize(authority.snapshot);
      scopeForRequest = authority.snapshot;
      return authority.snapshot;
    },
    requireCurrentScope: async (scope) => { await authorize(scope); },
    recheckCurrentScope,
    async inventorySections(scope) {
      if (scopeForRequest === undefined || scopeForRequest.snapshot_id !== scope.snapshot_id) {
        throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive scope runtime is not bound", 409);
      }
      const sources = await owner.exhaustiveSources(scope.member_source_revision_refs);
      const pins = await readPinned(scope);
      if (sources.length !== pins.length) {
        throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive source authority does not match pinned coverage", 409);
      }
      pinnedInventory = pins;
      const pinsBySource = new Map(pins.map((pin) => [pin.source_revision_ref, pin]));
      sections.clear();
      const descriptors: ExhaustiveSectionDescriptor[] = [];
      const contentSizes = new Map<string, number>();
      for (const source of sources) {
        const manifest = await readAdmittedNormalizedManifest(env.EVIDENCE_BUCKET, source.authority);
        contentSizes.set(source.revision.source_revision_ref, manifest.content_size);
      }
      for (const source of sources) {
        const sourceRef = source.revision.source_revision_ref;
        const pin = pinsBySource.get(sourceRef);
        if (pin === undefined) throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive projection omitted a frozen source", 409);
        const result = await env.SEARCH_DB.prepare(
          "SELECT p.item_key, p.canonical_section_id, p.content_sha256, p.projection_generation, " +
            "s.normalized_start_byte, s.normalized_end_byte FROM projection_item p JOIN projection_span s " +
            "ON s.item_key=p.item_key AND s.source_revision_ref=p.source_revision_ref " +
            "AND s.projection_generation=p.projection_generation WHERE p.source_revision_ref=?1 AND p.projection_generation=?2 AND p.active=1 " +
            "ORDER BY p.canonical_section_id LIMIT 4097",
        ).bind(sourceRef, pin.projection_generation).all<ExhaustiveProjectionRow>();
        if (!result.success || !Array.isArray(result.results)) throw new ExhaustiveQueryError("RESEARCH_SETTLEMENT_UNCERTAIN", "admitted projection inventory is unavailable", 503, true);
        if (result.results.length === 0 || result.results.length !== pin.item_count) fail("RESEARCH_AUTHORITY_STALE", "admitted projection inventory does not match its pinned item set", 409);
        if (result.results.length > 4096 || descriptors.length + result.results.length > EXHAUSTIVE_QUERY_MAX_SOURCES) {
          fail("RESEARCH_INPUT_LIMIT", "exhaustive section inventory exceeds its bound", 413);
        }
        for (const row of result.results) {
          if (typeof row.item_key !== "string" || typeof row.canonical_section_id !== "string" ||
              typeof row.content_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.content_sha256) ||
              row.projection_generation !== pin.projection_generation || typeof row.normalized_start_byte !== "number" ||
              typeof row.normalized_end_byte !== "number" || !Number.isSafeInteger(row.normalized_start_byte) ||
              !Number.isSafeInteger(row.normalized_end_byte) || row.normalized_start_byte < 0 ||
              row.normalized_end_byte <= row.normalized_start_byte ||
              row.normalized_end_byte > (contentSizes.get(sourceRef) ?? 0)) {
            fail("RESEARCH_AUTHORITY_STALE", "admitted projection inventory conflicts with source authority", 409);
          }
          const itemKey = row.item_key as string;
          const sectionRef = row.canonical_section_id as string;
          const contentSha256 = row.content_sha256 as string;
          const projectionGeneration = row.projection_generation as string;
          const start = row.normalized_start_byte as number;
          const end = row.normalized_end_byte as number;
          const key = `${sourceRef}:${sectionRef}`;
          if (sections.has(key)) fail("RESEARCH_AUTHORITY_STALE", "admitted projection inventory repeats a section", 409);
          sections.set(key, { source_revision_ref: sourceRef, section_ref: sectionRef, item_key: itemKey, content_sha256: contentSha256, projection_generation: projectionGeneration, start, end });
          descriptors.push({
            section_ref: key,
            source_revision_ref: sourceRef,
            item_key: itemKey,
            content_sha256: contentSha256,
            projection_generation: projectionGeneration,
            normalized_start_byte: start,
            normalized_end_byte: end,
            uncompressed_bytes: end - start,
          });
        }
      }
      await recheckCurrentScope(scope);
      return descriptors;
    },
    async readSection(scope, sectionRef) {
      const selected = sections.get(sectionRef);
      if (selected === undefined) throw new Error("RETRIEVAL_RESOLUTION_UNCERTAIN");
      const resolved = await resolver.resolveCandidate({
        candidate: {
          candidate_id: selected.item_key,
          lane: "EXHAUSTIVE",
          source_revision_ref: selected.source_revision_ref,
          canonical_section_id: selected.section_ref,
          preview: "",
          raw_score: 0,
          rank: 1,
          index_generation: selected.projection_generation,
          metadata: { item_key: selected.item_key, content_sha256: selected.content_sha256 },
        },
        scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
        access,
      });
      const handle = resolved.handle;
      const source = await evidence.loadSource(selected.source_revision_ref);
      if (source === null) throw new EvidenceRuntimeError("EVIDENCE_SOURCE_NOT_FOUND", "admitted source authority is unavailable");
      const materialized = await content.materialize(source, { kind: "normalized_byte_range", start: selected.start, end: selected.end });
      return { handle, scope, source, materialized };
    },
    checkBudget: () => { if (context.request.signal.aborted) throw new ExhaustiveQueryError("RESEARCH_CANCELLED", "exhaustive request was cancelled", 409); },
  };
}

function result(status: ExhaustiveReconcileStatus): ExhaustiveQueryResult {
  return { protocol: EXHAUSTIVE_QUERY_PROTOCOL, job: status };
}

export function createExhaustiveQueryService(
  env: ExhaustiveQueryEnvironment,
  options: ExhaustiveQueryOptions = {},
): { query(context: AuthenticatedRequestContext, raw: unknown): Promise<ExhaustiveQueryResult> } {
  const runtimeFor = options.runtime ?? ((context: AuthenticatedRequestContext) => {
    if (env.SEARCH_DB === undefined || env.EVIDENCE_BUCKET === undefined) return unavailableRuntime();
    return productionRuntime({ CORE_DB: env.CORE_DB, SEARCH_DB: env.SEARCH_DB, EVIDENCE_BUCKET: env.EVIDENCE_BUCKET }, context);
  });
  return {
    async query(context, raw) {
      requireOwner(context);
      const request = parseExhaustiveQueryRequest(raw);
      const key = exhaustiveIdempotencyKey(context);
      const access = {
        principal_ref: context.principal_ref,
        client_class: context.client_class,
        credential_generation: context.credential_generation,
      } as const;
      const store = options.storeFactory === undefined
        ? createD1ExhaustiveJobStore(env.CORE_DB, access)
        : options.storeFactory(access);
      const runtime = runtimeFor(context);
      const prior = await store.load(key).catch(mapRetrievalError);
      let scope: ScopeSnapshot;
      if (prior !== null && runtime.loadScope !== undefined) {
        scope = await runtime.loadScope(prior.scope_snapshot_id, prior.scope_snapshot_revision).catch(mapRuntimeError);
      } else {
        scope = await runtime.freezeScope(request.scope_expression, context.credential_generation).catch(mapRuntimeError);
      }
      await runtime.requireCurrentScope(scope).catch(mapRuntimeError);
      const sections = await runtime.inventorySections(scope).catch(mapRuntimeError);
      let plan: ExactScanPlan;
      try { plan = planExhaustiveScan({ scope, probes: [request.query], sections }); } catch (error) { mapRetrievalError(error); }
      const requestDigest = await exhaustiveRequestDigest({
        plan_id: plan.plan_id,
        scope_digest: scope.digest,
        probes: plan.probes,
        scope_expression: request.scope_expression,
        inventory: sections,
      });
      if (prior !== null && prior.request_digest !== requestDigest) {
        fail("RESEARCH_CONFLICT", "idempotency identity is bound to different inputs", 409);
      }
      if (prior !== null && "coverage_claim" in prior) {
        return result({ status: "COMPLETE", receipt: prior });
      }
      const reader: ExhaustiveSectionReader = {
        readSection: (sectionRef) => runtime.readSection(scope, sectionRef),
      };
      const status = await reconcileExhaustiveJob({
        store,
        idempotency_key: key,
        request_digest: requestDigest,
        scope,
        plan,
        ports: {
          requireCurrentScope: (current) => runtime.requireCurrentScope(current),
          checkBudget: () => runtime.checkBudget(context.request.signal),
          executeShard: (shard, currentPlan) => executeExhaustiveShard({
            shard,
            scope: currentPlan.scope_snapshot,
            probes: currentPlan.probes,
            reader,
            signal: context.request.signal,
          }),
        },
      }).catch(mapRetrievalError);
      return result(status);
    },
  };
}

/** Reuse the Q8 production authority stack before disclosing a cached receipt. */
export async function validateExhaustiveJobCurrent(
  env: ExhaustiveQueryEnvironment & { readonly SEARCH_DB: D1Database; readonly EVIDENCE_BUCKET: R2Bucket },
  context: AuthenticatedRequestContext,
  jobId: string,
): Promise<void> {
  const row = await env.CORE_DB.prepare(
    "SELECT scope_snapshot_id,scope_snapshot_revision,state FROM retrieval_exhaustive_job WHERE job_id=?1 LIMIT 1",
  ).bind(jobId).first<{
    readonly scope_snapshot_id: string;
    readonly scope_snapshot_revision: number;
    readonly state: string;
  }>().catch(() => { throw new ExhaustiveQueryError("RESEARCH_SETTLEMENT_UNCERTAIN", "exhaustive job authority read is unavailable", 503, true); });
  if (row === null || row.state !== "COMPLETE" || typeof row.scope_snapshot_id !== "string" ||
      !Number.isSafeInteger(row.scope_snapshot_revision)) {
    throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive job authority is no longer current", 409, false);
  }
  const runtime = productionRuntime(env, context);
  try {
    if (runtime.loadScope === undefined) throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive scope loader is unavailable", 409, false);
    const scope = await runtime.loadScope(row.scope_snapshot_id, row.scope_snapshot_revision);
    await runtime.requireCurrentScope(scope);
    await runtime.inventorySections(scope);
    if (runtime.recheckCurrentScope === undefined) {
      throw new ExhaustiveQueryError("RESEARCH_SETTLEMENT_UNCERTAIN", "exhaustive currentness fence is unavailable", 503, true);
    }
    await runtime.recheckCurrentScope(scope);
  } catch (error) {
    if (error instanceof ExhaustiveQueryError) throw error;
    throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive job authority is no longer current", 409, false);
  }
}

/** Validate an active or completed job before exposing workflow metadata. */
export async function validateExhaustiveWorkflowJobCurrent(
  env: ExhaustiveQueryEnvironment & { readonly SEARCH_DB: D1Database; readonly EVIDENCE_BUCKET: R2Bucket },
  context: AuthenticatedRequestContext,
  jobId: string,
): Promise<void> {
  const row = await env.CORE_DB.prepare(
    "SELECT scope_snapshot_id,scope_snapshot_revision,state,expires_at FROM retrieval_exhaustive_job WHERE job_id=?1 LIMIT 1",
  ).bind(jobId).first<{
    readonly scope_snapshot_id: string;
    readonly scope_snapshot_revision: number;
    readonly state: string;
    readonly expires_at: string;
  }>().catch(() => { throw new ExhaustiveQueryError("RESEARCH_SETTLEMENT_UNCERTAIN", "exhaustive job authority read is unavailable", 503, true); });
  const expiresAt = typeof row?.expires_at === "string" ? Date.parse(row.expires_at) : Number.NaN;
  if (row === null || !["PENDING", "COMPLETE"].includes(row.state) || typeof row.scope_snapshot_id !== "string" ||
      !Number.isSafeInteger(row.scope_snapshot_revision) || typeof row.expires_at !== "string" ||
      !Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== row.expires_at || expiresAt <= Date.now()) {
    throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive job authority is no longer current", 409, false);
  }
  const runtime = productionRuntime(env, context);
  try {
    if (runtime.loadScope === undefined) throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive scope loader is unavailable", 409, false);
    const scope = await runtime.loadScope(row.scope_snapshot_id, row.scope_snapshot_revision);
    await runtime.requireCurrentScope(scope);
    if (runtime.recheckCurrentScope === undefined) {
      throw new ExhaustiveQueryError("RESEARCH_SETTLEMENT_UNCERTAIN", "exhaustive currentness fence is unavailable", 503, true);
    }
    await runtime.recheckCurrentScope(scope);
  } catch (error) {
    if (error instanceof ExhaustiveQueryError) throw error;
    throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive job authority is no longer current", 409, false);
  }
}
