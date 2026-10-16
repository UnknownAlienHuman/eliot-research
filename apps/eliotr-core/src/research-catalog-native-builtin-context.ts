import { canonicalModelGatewayJson, modelGatewaySha256, type ModelCallInput } from "@eliotr/cloudflare-ai";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { decodeStoredDynamicRouteCandidate } from "@eliotr/cloudflare-research";
import type { DynamicRouteControlPlanePort, DynamicRouteProviderSnapshot } from "@eliotr/cloudflare-ai";
import { createResearchQueryService } from "./research-run-service.js";

export interface NativeBuiltinQualificationContext {
  readonly evidence_pack: ModelCallInput["evidence_pack"];
  readonly scope_snapshot_id: string;
  readonly expires_at: string;
}

/** Use held evidence or prepare it through the ordinary authorized query service, without a prior chat. */
export async function readNativeBuiltinQualificationContext(env: Env, context: AuthenticatedRequestContext,
  projectId: string, operationId?: string): Promise<NativeBuiltinQualificationContext> {
  const read = () => env.CORE_DB.prepare(
    "SELECT q.result_json,q.result_digest,q.scope_snapshot_id,q.scope_snapshot_revision,s.expires_at " +
    "FROM retrieval_query_result q JOIN scope_snapshot s ON s.snapshot_id=q.scope_snapshot_id AND s.revision=q.scope_snapshot_revision " +
    "WHERE q.principal_ref=?1 AND q.client_class='owner_pwa' AND q.credential_generation=?2 AND q.state='COMPLETE' " +
    "AND q.result_json IS NOT NULL AND s.invalidated_at IS NULL AND julianday(s.expires_at)>julianday('now') " +
    "AND ((json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT' " +
    "AND json_extract(s.resolved_scope_expression_json,'$.project_id')=?3) OR " +
    "(json_extract(s.resolved_scope_expression_json,'$.kind')='INTERSECT' " +
    "AND json_extract(s.resolved_scope_expression_json,'$.left.kind')='PROJECT' " +
    "AND json_extract(s.resolved_scope_expression_json,'$.left.project_id')=?3 " +
    "AND json_extract(s.resolved_scope_expression_json,'$.right.kind')='SELECTED_SOURCES')) " +
    "ORDER BY q.created_at DESC LIMIT 1",
  ).bind(context.principal_ref, context.credential_generation, projectId).first<{
    result_json: string; result_digest: string; scope_snapshot_id: string; scope_snapshot_revision: number; expires_at: string;
  }>();
  let row = await read();
  if (row === null && operationId !== undefined) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId) ||
        context.request.signal.aborted || context.client_class !== "owner_pwa") throw new Error("Invalid native context preparation");
    const source = await env.CORE_DB.prepare(
      "SELECT s.source_id,s.title FROM project_source_membership m JOIN project_owner o ON o.project_id=m.project_id " +
      "JOIN source s ON s.source_id=m.source_id JOIN source_revision r ON r.source_revision_ref=s.head_rev AND r.source_id=s.source_id " +
      "WHERE m.project_id=?1 AND o.principal_ref=?2 " +
      "AND julianday(m.valid_from)<=julianday('now') AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday('now')) " +
      "AND r.purge_state='LIVE' AND r.source_owner_generation=s.source_owner_generation ORDER BY s.source_id LIMIT 1",
    ).bind(projectId, context.principal_ref).first<{ source_id: string; title: string }>();
    if (source === null) throw new Error("Native qualification needs an admitted project source");
    const headers = new Headers(context.request.headers);
    headers.set("idempotency-key", `${operationId}:native-context`);
    const queryContext = { ...context, request: new Request(context.request.url,
      { method: "POST", headers, signal: context.request.signal }) };
    // This service checks current source permissions before retrieval. The
    // operation-derived key preserves its one exact bounded request on replay.
    await createResearchQueryService(env).query(queryContext, {
      product: "FAST_SEARCH", query: (source.title.trim() || source.source_id).slice(0, 512), literals: [], evidence_grade: "E0",
      budget_ref: "retrieval-fast-v1", max_results: 1, scope_expression: { kind: "INTERSECT",
        left: { kind: "PROJECT", project_id: projectId }, right: { kind: "SELECTED_SOURCES", source_ids: [source.source_id] } },
    });
    row = await read();
  }
  if (row === null || await modelGatewaySha256(row.result_json) !== row.result_digest) {
    throw new Error("Native model qualification requires an intact held project evidence context");
  }
  const stored = JSON.parse(row.result_json) as { evidence_pack?: ModelCallInput["evidence_pack"] };
  if (canonicalModelGatewayJson(stored) !== row.result_json) throw new Error("Native qualification context is not canonical");
  const pack = stored.evidence_pack;
  const evidence = pack?.resolved_evidence[0];
  if (pack === undefined || evidence === undefined || pack.scope_snapshot_ref.id !== row.scope_snapshot_id ||
      pack.scope_snapshot_ref.revision !== row.scope_snapshot_revision) throw new Error("Native qualification needs exact held evidence");
  const identity = await modelGatewaySha256(canonicalModelGatewayJson({ pack_ref: pack.pack_ref,
    handle_ref: evidence.handle.handle_ref, excerpt_sha256: evidence.handle.excerpt_sha256 }));
  return { scope_snapshot_id: row.scope_snapshot_id, expires_at: row.expires_at,
    evidence_pack: { ...pack, pack_ref: { id: `native-qualification-pack-${identity}`, revision: 1 },
      resolved_evidence: [evidence], total_utf8_bytes: new TextEncoder().encode(evidence.exact_excerpt).byteLength } };
}

/** Preserve the actual provider route grammar; change its single native model leaf only. */
export function nativeBuiltinRouteDefinition(raw: unknown, previousModel: string, requestedModel: string): unknown {
  let models = 0;
  function visit(value: unknown, depth: number): unknown {
    if (depth > 64) throw new Error("Native route definition exceeds its structural bound");
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    if (typeof value !== "object" || value === null) return value;
    const item = value as Record<string, unknown>;
    if (item.type === "model") {
      models += 1;
      if (item.provider !== undefined && item.provider !== "workers-ai") throw new Error("Native route must not inherit external fallback");
      if (item.model !== previousModel && item.model !== `workers-ai/${previousModel}`) throw new Error("Native route model differs from exact installed native binding");
      return { ...item, model: item.model === previousModel ? requestedModel : `workers-ai/${requestedModel}` };
    }
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, depth + 1)]));
  }
  const result = visit(raw, 0);
  if (models !== 1) throw new Error("Native selection requires a single exact provider route, without fallback");
  return result;
}

export async function readNativeBuiltinRouteDefinition(env: Env, control: Pick<DynamicRouteControlPlanePort, "get">,
  selection: { readonly candidate_ref: string; readonly candidate_sha256: string }, previousModel: string, requestedModel: string) {
  const row = await env.CORE_DB.prepare("SELECT candidate_ref,candidate_sha256,candidate_json,route_ref,route_version,staged_at " +
    "FROM dynamic_route_candidate WHERE candidate_ref=?1 AND candidate_sha256=?2 LIMIT 1")
    .bind(selection.candidate_ref, selection.candidate_sha256).first();
  if (row === null) throw new Error("Installed native route candidate is unavailable");
  const candidate = await decodeStoredDynamicRouteCandidate(row as Parameters<typeof decodeStoredDynamicRouteCandidate>[0],
    "native catalog source route", "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED");
  const snapshot = await control.get("eliotr-reasoning", candidate.candidate.provider_route_id) as DynamicRouteProviderSnapshot;
  return nativeBuiltinRouteDefinition(snapshot.route_definition, previousModel, requestedModel);
}
