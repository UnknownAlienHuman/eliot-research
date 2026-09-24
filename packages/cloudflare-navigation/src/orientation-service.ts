import {
  canonicalEvidenceJson, createD1EvidenceAuthorityPort, createD1NavigationStore,
} from "@eliotr/cloudflare-evidence";
import { RetrievalLaneSchema, RetrievalTraceSchema, type RetrievalTrace, type ScopeSnapshot, type VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, QueryRequest, QueryResult } from "@eliotr/interfaces";
import { nextOrientationBoundary, orientationCurrentness } from "./orientation-currentness.js";
import { createOwnerScopeAuthority, type createProjectClientScopeAuthority } from "./orientation-authority.js";
import { ORIENTATION_MAX_SOURCES, ORIENTATION_PROFILE, orientationFail, parseOrientationRequest } from "./orientation-input.js";
import { materializeMetadataNavigation } from "./orientation-materialization.js";
import { createNavigationService } from "./navigation-service.js";
import type { ResearchExecutionScopeBinding } from "./orientation-storage.js";
import { orientationStorage } from "./orientation-storage.js";
import { createD1ScopeService } from "./d1-scope-service.js";
import { OWNER_RESEARCH_SCOPE_PROFILE, OWNER_RESEARCH_MAX_SELECTED_SOURCES,
  readOwnerScopeProfile, bindOwnerResearchScopeProfile, createProfiledOwnerScopeService } from "./owner-scope-profile.js";

interface OrientationEnvironment { readonly CORE_DB: D1Database; readonly SEARCH_DB: D1Database; }
// IMPLEMENTED_NOT_LIVE: ER-24 owner metadata orientation requires retained deployed D1/Access receipts.
export function createOrientationApi(env: OrientationEnvironment, now: () => number = Date.now,
  execution?: ResearchExecutionScopeBinding,
  delegated?: Awaited<ReturnType<typeof createProjectClientScopeAuthority>>) {
  const executionBinding = execution === undefined ? undefined : Object.freeze({ ...execution });
  function services(context: AuthenticatedRequestContext) {
    if (context.client_class !== "owner_pwa" && (!executionBinding || !delegated)) orientationFail("ORIENTATION_OWNER_REQUIRED", 403);
    const authority = delegated?.authority ?? createOwnerScopeAuthority(env.CORE_DB, context, now);
    const scopes = executionBinding === undefined
      ? createD1ScopeService(env.CORE_DB, authority, { now, max_snapshot_members: ORIENTATION_MAX_SOURCES })
      : createProfiledOwnerScopeService(env.CORE_DB, authority, OWNER_RESEARCH_SCOPE_PROFILE, now);
    const policyPrincipal = delegated?.policy_principal_ref ?? context.principal_ref;
    const requireCurrent = orientationCurrentness(env.CORE_DB, scopes, policyPrincipal, now);
    const evidence = createD1EvidenceAuthorityPort({ core_database: env.CORE_DB, search_database: env.SEARCH_DB, now });
    const storage = orientationStorage(env.CORE_DB, context, now, executionBinding, delegated === undefined ? undefined : {
      grant_id: delegated.lease.grant.grant_id, revision: delegated.lease.grant.revision,
    });
    const current = async (ref: VersionedRef): Promise<ScopeSnapshot> => {
      const stored = await evidence.loadScope(ref);
      if (!stored || stored.invalidated_at !== null) orientationFail("ORIENTATION_SCOPE_UNAVAILABLE", 409);
      await requireCurrent(stored.snapshot);
      return stored.snapshot;
    };
    return { authority, scopes, evidence, storage, current, requireCurrent };
  }
  async function orient(context: AuthenticatedRequestContext, raw: QueryRequest): Promise<QueryResult> {
    const request = parseOrientationRequest(raw, executionBinding === undefined
      ? ORIENTATION_MAX_SOURCES : OWNER_RESEARCH_MAX_SELECTED_SOURCES);
    const { authority, evidence, storage, current, requireCurrent } = services(context);
    const checkpoint = () => {
      if (context.request.signal.aborted) orientationFail("ORIENTATION_REQUEST_ABORTED", 409);
      if (executionBinding !== undefined) {
        const access = context.access;
        // Fresh execution authority must be issued by a still-authenticated caller.
        // Only this admission checks JWT expiry; background stages use the durable grant.
        if (access === undefined || access.principal_ref !== context.principal_ref ||
            access.credential_generation !== context.credential_generation ||
            !Number.isFinite(Date.parse(access.expires_at)) || Date.parse(access.expires_at) <= now()) {
          orientationFail("ORIENTATION_OWNER_REQUIRED", 403);
        }
      }
    };
    checkpoint();
    // Read authorization before reserving work. No body or existing admission policy can grant access.
    if (executionBinding === undefined) await authority.requireReadPolicy();
    else await authority.exhaustiveRequireReadPolicy();
    await delegated?.lease.requireGrantCurrent();
    let operation = await storage.reserve(request);
    let snapshot: ScopeSnapshot;
    if (operation.snapshot_id === null) {
      const createdAt = Date.parse(operation.created_at);
      const expiresAt = await nextOrientationBoundary(env.CORE_DB, delegated?.policy_principal_ref ?? context.principal_ref, {
        resolved_scope_expression: request.scope_expression, member_source_revision_refs: [], expires_at: operation.expires_at,
      }, createdAt);
      if (expiresAt <= now()) orientationFail("ORIENTATION_OPERATION_EXPIRED", 409);
      const freezer = createD1ScopeService(env.CORE_DB, authority, {
        now: () => createdAt, ttl_ms: expiresAt - createdAt,
        max_snapshot_members: executionBinding === undefined ? ORIENTATION_MAX_SOURCES : OWNER_RESEARCH_SCOPE_PROFILE.max_sources,
        ...(executionBinding === undefined ? {} : {
          preserve_resolution_errors: true,
          resolveAtom: authority.exhaustiveResolveAtom,
          resolveAuthorityClosure: authority.exhaustiveResolveAuthorityClosure,
        }),
      });
      snapshot = await freezer.freeze(request.scope_expression, context.credential_generation);
      checkpoint();
      await requireCurrent(snapshot);
      if (executionBinding !== undefined) {
        await bindOwnerResearchScopeProfile(env.CORE_DB, snapshot, request.max_results);
      }
      operation = await storage.bindScope(operation, snapshot);
    } else {
      if (operation.snapshot_revision === null) orientationFail("ORIENTATION_OPERATION_CORRUPT", 409);
      snapshot = await current({ id: operation.snapshot_id, revision: operation.snapshot_revision });
      if (executionBinding !== undefined && operation.state === "PREPARED") {
        await bindOwnerResearchScopeProfile(env.CORE_DB, snapshot, request.max_results);
      }
    }
    checkpoint();
    await requireCurrent(snapshot);
    // Execution keeps its admission-time deadline, never a sliding browser lease.
    // Include the actual frozen members here so source-admission expiry and future
    // membership boundaries also cap the grant used by every W1/W2/paid stage.
    const profile = executionBinding === undefined ? undefined : await readOwnerScopeProfile(env.CORE_DB, snapshot);
    const executionGrantCeiling = executionBinding === undefined ? undefined : await nextOrientationBoundary(
      env.CORE_DB, delegated?.policy_principal_ref ?? context.principal_ref, snapshot, Date.parse(snapshot.created_at),
    );
    if (profile?.version !== OWNER_RESEARCH_SCOPE_PROFILE.version) await authority.grant(snapshot, executionGrantCeiling);
    else await authority.exhaustiveGrant(snapshot, executionGrantCeiling);
    await requireCurrent(snapshot);
    await delegated?.requireScopeCurrent(snapshot);
    if (executionBinding !== undefined && operation.state === "COMPLETE") {
      await evidence.authorizeScope({ snapshot, invalidated_at: null, invalidation_reason: null }, context);
      if (operation.result_json === null) orientationFail("ORIENTATION_OPERATION_CORRUPT", 409);
      const saved = JSON.parse(operation.result_json) as { result: QueryResult };
      const ref = saved.result?.evidence_pack?.scope_snapshot_ref;
      if (ref?.id !== snapshot.snapshot_id || ref.revision !== snapshot.revision) {
        orientationFail("ORIENTATION_OPERATION_CORRUPT", 409);
      }
      await requireCurrent(snapshot);
      checkpoint();
      return saved.result;
    }
    const store = createD1NavigationStore({ database: env.CORE_DB, scope_snapshot: snapshot, access: context,
      require_current: requireCurrent, now });
    if (operation.state !== "COMPLETE") {
      // Preview work is bounded independently. The snapshot/denominator is never sliced.
      const previewRefs = executionBinding === undefined ? snapshot.member_source_revision_refs
        : snapshot.member_source_revision_refs.slice(0, ORIENTATION_MAX_SOURCES);
      const sources = executionBinding === undefined ? await authority.sources(previewRefs)
        : await authority.exhaustiveSources(previewRefs);
      checkpoint();
      await materializeMetadataNavigation(store, snapshot, sources);
    }
    checkpoint();
    const navigation = await createNavigationService(store).orient({ scope_snapshot: snapshot,
      focus_terms: [], question: request.query, maximum_sources: request.max_results });
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
      provider_calls: 0, cost_measurement: "NOT_MEASURED" },
      ...(executionBinding === undefined ? {} : {
        execution: { ...executionBinding, deadline: operation.expires_at },
      }) });
    await current(scopeRef);
    await evidence.authorizeScope({ snapshot, invalidated_at: null, invalidation_reason: null }, context);
    await delegated?.requireScopeCurrent(snapshot);
    return result;
  }
  async function trace(context: AuthenticatedRequestContext, ref: VersionedRef): Promise<RetrievalTrace> {
    if (ref.revision !== 1 || !/^orient-[0-9a-f]{64}$/u.test(ref.id)) orientationFail("ORIENTATION_TRACE_INVALID", 400);
    const { storage, authority, evidence } = services(context);
    const operation = await storage.read(ref.id);
    if (!operation || operation.state !== "COMPLETE" || !operation.result_json || !operation.snapshot_id || !operation.snapshot_revision) {
      orientationFail("ORIENTATION_TRACE_NOT_FOUND", 404);
    }
    const stored = await evidence.loadScope({ id: operation.snapshot_id, revision: operation.snapshot_revision });
    if (stored === null || stored.invalidated_at !== null) orientationFail("ORIENTATION_SCOPE_UNAVAILABLE", 409);
    const snapshot = stored.snapshot;
    const profile = await readOwnerScopeProfile(env.CORE_DB, snapshot);
    const scopes = createProfiledOwnerScopeService(env.CORE_DB, authority, profile, now);
    const policyPrincipal = delegated?.policy_principal_ref ?? context.principal_ref;
    const requireCurrent = orientationCurrentness(env.CORE_DB, scopes, policyPrincipal, now);
    await requireCurrent(snapshot);
    await evidence.authorizeScope({ snapshot, invalidated_at: null, invalidation_reason: null }, context);
    const payload = JSON.parse(operation.result_json) as { trace?: unknown };
    const parsed = RetrievalTraceSchema.parse(payload.trace);
    if (canonicalEvidenceJson(parsed.scope_snapshot) !== canonicalEvidenceJson(snapshot) ||
        parsed.trace_ref.id !== ref.id || parsed.trace_ref.revision !== ref.revision) orientationFail("ORIENTATION_TRACE_CORRUPT", 409);
    await requireCurrent(snapshot);
    await evidence.authorizeScope({ snapshot, invalidated_at: null, invalidation_reason: null }, context);
    return parsed;
  }
  return { orient, trace };
}
