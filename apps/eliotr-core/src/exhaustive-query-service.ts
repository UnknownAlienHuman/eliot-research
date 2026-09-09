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
import { NormalizedBundleManifestSchema, ScopeExpressionSchema } from "@eliotr/contracts";
import { inspectScopeExpression } from "@eliotr/domain";
import {
  createD1EvidenceAuthorityPort,
  createD1NavigationStore,
  createR2EvidenceContentPort,
  EvidenceRuntimeError,
  type EvidenceSourceAuthority,
} from "@eliotr/cloudflare-evidence";
import { canonicalNormalizedBundleKey } from "@eliotr/platform-cloudflare";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import { extractNavigationSections } from "@eliotr/retrieval";
import type {
  AuthenticatedRequestContext,
  ExhaustiveQueryResult,
  QueryRequest,
} from "@eliotr/interfaces";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";

export const EXHAUSTIVE_QUERY_PROTOCOL = "eliotr.exhaustive-query.v1" as const;
export const EXHAUSTIVE_QUERY_BUDGET = "exhaustive-job-v1" as const;
export const EXHAUSTIVE_QUERY_MAX_SOURCES = 4096;
export const EXHAUSTIVE_QUERY_MAX_RESULTS = 16;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_SCOPE_DEPTH = 32;
const MAX_SCOPE_ATOMS = 256;

export class ExhaustiveQueryError extends CatalogInputError {}

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

export function parseExhaustiveQueryRequest(raw: unknown): QueryRequest {
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

function idempotencyKey(context: AuthenticatedRequestContext): string {
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
  const code = (error as { readonly code?: unknown } | null)?.code;
  const status = (error as { readonly status?: unknown } | null)?.status;
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
    if (error.code === "EVIDENCE_OWNER_GENERATION_MISMATCH" || error.code === "EVIDENCE_SCOPE_MISMATCH" || error.code === "EVIDENCE_SOURCE_NOT_LIVE") {
      fail("RESEARCH_AUTHORITY_STALE", "exhaustive evidence authority is stale", 409);
    }
    fail("RESEARCH_SETTLEMENT_UNCERTAIN", "exhaustive evidence settlement is uncertain", 503, true);
  }
  throw error;
}

function manifestText(raw: string): unknown {
  try { return JSON.parse(raw); } catch { fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted normalized manifest is malformed", 503, true); }
}

async function readManifest(bucket: R2Bucket, authority: EvidenceSourceAuthority): Promise<void> {
  const expectedKey = await canonicalNormalizedBundleKey(authority.object_residency_key_digest, {
    owner_system_id: authority.owner_system_id,
    source_namespace_id: authority.source_namespace_id,
    source_owner_generation: authority.source_owner_generation,
    source_logical_id: authority.source_id,
    source_revision_ref: authority.source_revision_ref,
  }, "manifest.json");
  if (expectedKey !== authority.normalized_artifact_ref) {
    fail("RESEARCH_AUTHORITY_STALE", "normalized manifest reference is not canonical", 409);
  }
  const object = await bucket.get(expectedKey).catch(() => null);
  if (object === null || object.size > 512 * 1024) {
    fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted normalized manifest is unavailable", 503, true);
  }
  let value: unknown;
  try { value = manifestText(await new TextDecoder("utf-8", { fatal: true }).decode(await object.arrayBuffer())); }
  catch { fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted normalized manifest is unreadable", 503, true); }
  const parsed = NormalizedBundleManifestSchema.safeParse(value);
  if (!parsed.success || parsed.data.origin.source_revision_ref !== authority.source_revision_ref ||
      parsed.data.origin.source_namespace_id !== authority.source_namespace_id ||
      parsed.data.origin.source_owner_generation !== authority.source_owner_generation ||
      parsed.data.content.markdown_sha256 !== authority.content_sha256 || !parsed.data.capabilities.text_ranges) {
    fail("RESEARCH_AUTHORITY_STALE", "normalized manifest does not match admitted source authority", 409);
  }
}

function productionRuntime(env: Pick<Env, "CORE_DB" | "SEARCH_DB" | "EVIDENCE_BUCKET">, context: AuthenticatedRequestContext): ExhaustiveQueryRuntime {
  const access = { principal_ref: context.principal_ref, client_class: context.client_class, credential_generation: context.credential_generation } as const;
  const owner = createOwnerScopeAuthority(env.CORE_DB, access);
  const freezer = createD1ScopeService(env.CORE_DB, owner, { max_snapshot_members: EXHAUSTIVE_QUERY_MAX_SOURCES });
  const scopePorts = createD1ScopePorts(env.CORE_DB, access);
  const evidence = createD1EvidenceAuthorityPort({ core_database: env.CORE_DB, search_database: env.SEARCH_DB });
  const content = createR2EvidenceContentPort({ evidence_bucket: env.EVIDENCE_BUCKET });
  let navigation: ReturnType<typeof createD1NavigationStore> | undefined;
  let scopeForRequest: ScopeSnapshot | undefined;
  const sections = new Map<string, { readonly source_revision_ref: string; readonly section_ref: string; readonly start: number; readonly end: number }>();
  async function authorize(scope: ScopeSnapshot): Promise<void> {
    await freezer.requireCurrent(scope);
    await owner.grant(scope);
    await scopePorts.requireCurrentScope(scope);
  }
  return {
    async freezeScope(expression, credentialGeneration) {
      await owner.requireReadPolicy();
      const snapshot = await freezer.freeze(expression, credentialGeneration);
      await authorize(snapshot);
      scopeForRequest = snapshot;
      navigation = createD1NavigationStore({ database: env.CORE_DB, scope_snapshot: snapshot, access, require_current: (current) => freezer.requireCurrent(current) });
      return snapshot;
    },
    async loadScope(snapshotId, revision) {
      const authority = await evidence.loadScope({ id: snapshotId, revision });
      if (authority === null) throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive scope authority is unavailable", 409);
      await evidence.authorizeScope(authority, access);
      await authorize(authority.snapshot);
      scopeForRequest = authority.snapshot;
      navigation = createD1NavigationStore({ database: env.CORE_DB, scope_snapshot: authority.snapshot, access, require_current: (current) => freezer.requireCurrent(current) });
      return authority.snapshot;
    },
    requireCurrentScope: async (scope) => { await authorize(scope); },
    async inventorySections(scope) {
      if (scopeForRequest === undefined || scopeForRequest.snapshot_id !== scope.snapshot_id || navigation === undefined) {
        throw new ExhaustiveQueryError("RESEARCH_AUTHORITY_STALE", "exhaustive scope runtime is not bound", 409);
      }
      const sources = await owner.sources(scope.member_source_revision_refs);
      const sourceByRef = new Map(sources.map((source) => [source.revision.source_revision_ref, source]));
      const maps = await navigation.getDocumentMaps(scope.member_source_revision_refs);
      const descriptors: ExhaustiveSectionDescriptor[] = [];
      for (const source of sources) await readManifest(env.EVIDENCE_BUCKET, source.authority);
      for (const map of maps) {
        const sourceRef = "source_revision_ref" in (map as object) ? String((map as { source_revision_ref: unknown }).source_revision_ref) : "";
        if (!sourceByRef.has(sourceRef)) fail("RESEARCH_AUTHORITY_STALE", "navigation map escaped the frozen scope", 409);
        for (const section of extractNavigationSections(map)) {
          if (section.normalized_start_byte === undefined || section.normalized_end_byte === undefined) {
            fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted normalized manifest has no structural section ranges", 503, true);
          }
          const key = `${sourceRef}:${section.section_ref}`;
          sections.set(key, { source_revision_ref: sourceRef, section_ref: section.section_ref, start: section.normalized_start_byte, end: section.normalized_end_byte });
          descriptors.push({ section_ref: key, source_revision_ref: sourceRef, uncompressed_bytes: section.normalized_end_byte - section.normalized_start_byte });
        }
      }
      return descriptors;
    },
    async readSection(scope, sectionRef) {
      const selected = sections.get(sectionRef);
      if (selected === undefined || navigation === undefined) throw new Error("RETRIEVAL_RESOLUTION_UNCERTAIN");
      const handle = await navigation.getEvidenceHandleForSection({ scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision }, source_revision_ref: selected.source_revision_ref, section_ref: selected.section_ref });
      if (handle === null) throw new Error("RETRIEVAL_RESOLUTION_UNCERTAIN");
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
  env: Pick<Env, "CORE_DB"> & Partial<Pick<Env, "SEARCH_DB" | "EVIDENCE_BUCKET">>,
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
      const key = idempotencyKey(context);
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
      try { runtime.checkBudget(context.request.signal); } catch (error) { mapRuntimeError(error); }
      const sections = await runtime.inventorySections(scope).catch(mapRuntimeError);
      let plan: ExactScanPlan;
      try { plan = planExhaustiveScan({ scope, probes: [request.query], sections }); } catch (error) { mapRetrievalError(error); }
      const requestDigest = await exhaustiveRequestDigest({
        plan_id: plan.plan_id,
        scope_digest: scope.digest,
        probes: plan.probes,
      });
      if (prior !== null && prior.request_digest !== requestDigest) {
        fail("RESEARCH_CONFLICT", "idempotency identity is bound to different inputs", 409);
      }
      if (prior !== null) return result({ status: "COMPLETE", receipt: prior });
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
