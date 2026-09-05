import {
  canonicalEvidenceJson, createD1EvidenceAuthorityPort, createD1NavigationStore,
} from "@eliotr/cloudflare-evidence";
import { RetrievalLaneSchema, RetrievalTraceSchema, type RetrievalTrace, type ScopeSnapshot, type VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, QueryRequest, QueryResult } from "@eliotr/interfaces";
import { nextOrientationBoundary, orientationCurrentness } from "./orientation-currentness.js";
import { createOwnerScopeAuthority } from "./orientation-authority.js";
import { ORIENTATION_MAX_SOURCES, ORIENTATION_PROFILE, orientationFail, parseOrientationRequest } from "./orientation-input.js";
import { materializeMetadataNavigation } from "./orientation-materialization.js";
import { createNavigationService } from "./navigation-service.js";
import { orientationStorage } from "./orientation-storage.js";
import { createD1ScopeService } from "./scope-service.js";

interface OrientationEnvironment { readonly CORE_DB: D1Database; readonly SEARCH_DB: D1Database; }
// IMPLEMENTED_NOT_LIVE: ER-24 owner metadata orientation requires retained deployed D1/Access receipts.
export function createOrientationApi(env: OrientationEnvironment, now: () => number = Date.now) {
  function services(context: AuthenticatedRequestContext) {
    if (context.client_class !== "owner_pwa") orientationFail("ORIENTATION_OWNER_REQUIRED", 403);
    const authority = createOwnerScopeAuthority(env.CORE_DB, context, now);
    const scopes = createD1ScopeService(env.CORE_DB, authority, { now, max_snapshot_members: ORIENTATION_MAX_SOURCES });
    const requireCurrent = orientationCurrentness(env.CORE_DB, scopes, context.principal_ref, now);
    const evidence = createD1EvidenceAuthorityPort({ core_database: env.CORE_DB, search_database: env.SEARCH_DB, now });
    const storage = orientationStorage(env.CORE_DB, context, now);
    const current = async (ref: VersionedRef): Promise<ScopeSnapshot> => {
      const stored = await evidence.loadScope(ref);
      if (!stored || stored.invalidated_at !== null) orientationFail("ORIENTATION_SCOPE_UNAVAILABLE", 409);
      await requireCurrent(stored.snapshot);
      return stored.snapshot;
    };
    return { authority, scopes, evidence, storage, current, requireCurrent };
  }
  async function orient(context: AuthenticatedRequestContext, raw: QueryRequest): Promise<QueryResult> {
    const request = parseOrientationRequest(raw);
    const { authority, evidence, storage, current, requireCurrent } = services(context);
    const checkpoint = () => {
      if (context.request.signal.aborted) orientationFail("ORIENTATION_REQUEST_ABORTED", 409);
    };
    checkpoint();
    // Read authorization before reserving work. No body or existing admission policy can grant access.
    await authority.requireReadPolicy();
    let operation = await storage.reserve(request);
    let snapshot: ScopeSnapshot;
    if (operation.snapshot_id === null) {
      const createdAt = Date.parse(operation.created_at);
      const expiresAt = await nextOrientationBoundary(env.CORE_DB, context.principal_ref, {
        resolved_scope_expression: request.scope_expression, member_source_revision_refs: [], expires_at: operation.expires_at,
      }, createdAt);
      if (expiresAt <= now()) orientationFail("ORIENTATION_OPERATION_EXPIRED", 409);
      const freezer = createD1ScopeService(env.CORE_DB, authority, {
        now: () => createdAt, ttl_ms: expiresAt - createdAt, max_snapshot_members: ORIENTATION_MAX_SOURCES,
      });
      snapshot = await freezer.freeze(request.scope_expression, context.credential_generation);
      checkpoint();
      await requireCurrent(snapshot);
      operation = await storage.bindScope(operation, snapshot);
    } else {
      if (operation.snapshot_revision === null) orientationFail("ORIENTATION_OPERATION_CORRUPT", 409);
      snapshot = await current({ id: operation.snapshot_id, revision: operation.snapshot_revision });
    }
    checkpoint();
    await requireCurrent(snapshot);
    await authority.grant(snapshot);
    await requireCurrent(snapshot);
    const store = createD1NavigationStore({ database: env.CORE_DB, scope_snapshot: snapshot, access: context,
      require_current: requireCurrent, now });
    if (operation.state !== "COMPLETE") {
      const sources = await authority.sources(snapshot.member_source_revision_refs);
      checkpoint();
      await materializeMetadataNavigation(store, snapshot, sources);
    }
    checkpoint();
    const navigation = await createNavigationService(store).orient({ scope_snapshot: snapshot,
      focus_terms: request.query.trim() ? [request.query.trim()] : [], maximum_sources: request.max_results });
    const traceRef = { id: operation.operation_id, revision: 1 };
    const packRef = { id: `${operation.operation_id}:pack`, revision: 1 };
    const scopeRef = { id: snapshot.snapshot_id, revision: snapshot.revision };
    const budgetRef = `${operation.operation_id}:budget`;
    const trace = RetrievalTraceSchema.parse({ trace_ref: traceRef, raw_query: request.query,
      scope_snapshot: snapshot, query_product: "ORIENT", lanes_used: ["SOURCECARD"],
      lanes_skipped: [{ lane: "STRUCTURE", reason: "STRUCTURE_NOT_MATERIALIZED" }, { lane: "ATLAS", reason: "PROJECT_ATLAS_NOT_MATERIALIZED" },
        { lane: "SEM", reason: "METADATA_PROFILE_NO_PROVIDER_CALLS" }, { lane: "VERIFY", reason: "NAVIGATION_ONLY" }],
      exact_probes: [], index_generations: [ORIENTATION_PROFILE], context_expansion: 0,
      candidates_by_lane: Object.fromEntries(RetrievalLaneSchema.options.map((lane) => [lane,
        lane === "SOURCECARD" ? snapshot.member_source_revision_refs.length : 0])),
      expansion_refs: [], represented_source_refs: navigation.represented_source_revision_refs,
      omitted_sources: navigation.omissions.map((item) => ({ source_ref: item.source_revision_ref, reason: item.reason })),
      stale_or_degraded_channels: ["METADATA_ONLY", "STRUCTURE_NOT_MATERIALIZED"],
      budget_receipt_ref: budgetRef, evidence_pack_ref: packRef.id });
    const result: QueryResult = { evidence_pack: { pack_ref: packRef, scope_snapshot_ref: scopeRef,
      resolved_evidence: [], omitted_candidates: [], trace_ref: traceRef, total_utf8_bytes: 0 }, trace_ref: traceRef, navigation };
    checkpoint();
    await current(scopeRef);
    await evidence.authorizeScope({ snapshot, invalidated_at: null, invalidation_reason: null }, context);
    await storage.complete(operation, snapshot, { result, trace, budget: { receipt_ref: budgetRef, profile: ORIENTATION_PROFILE,
      maximum_sources: ORIENTATION_MAX_SOURCES, represented_sources: navigation.represented_source_revision_refs.length,
      provider_calls: 0, cost_measurement: "NOT_MEASURED" } });
    await current(scopeRef);
    await evidence.authorizeScope({ snapshot, invalidated_at: null, invalidation_reason: null }, context);
    return result;
  }
  async function trace(context: AuthenticatedRequestContext, ref: VersionedRef): Promise<RetrievalTrace> {
    if (ref.revision !== 1 || !/^orient-[0-9a-f]{64}$/u.test(ref.id)) orientationFail("ORIENTATION_TRACE_INVALID", 400);
    const { storage, current, evidence } = services(context);
    const operation = await storage.read(ref.id);
    if (!operation || operation.state !== "COMPLETE" || !operation.result_json || !operation.snapshot_id || !operation.snapshot_revision) {
      orientationFail("ORIENTATION_TRACE_NOT_FOUND", 404);
    }
    const snapshot = await current({ id: operation.snapshot_id, revision: operation.snapshot_revision });
    await evidence.authorizeScope({ snapshot, invalidated_at: null, invalidation_reason: null }, context);
    const payload = JSON.parse(operation.result_json) as { trace?: unknown };
    const parsed = RetrievalTraceSchema.parse(payload.trace);
    if (canonicalEvidenceJson(parsed.scope_snapshot) !== canonicalEvidenceJson(snapshot) ||
        parsed.trace_ref.id !== ref.id || parsed.trace_ref.revision !== ref.revision) orientationFail("ORIENTATION_TRACE_CORRUPT", 409);
    await current(refOf(snapshot));
    await evidence.authorizeScope({ snapshot, invalidated_at: null, invalidation_reason: null }, context);
    return parsed;
  }
  return { orient, trace };
}
function refOf(snapshot: ScopeSnapshot): VersionedRef { return { id: snapshot.snapshot_id, revision: snapshot.revision }; }
