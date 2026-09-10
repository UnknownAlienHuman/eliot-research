import {
  ChannelReadinessSchema,
  LibraryReadinessSchema,
  SourceCurrentnessSchema,
  type ChannelReadiness,
  type LibraryReadiness,
} from "@eliotr/contracts";
import {
  readD1ManagedSemanticReadback,
  readD1SearchChannelReadback,
} from "@eliotr/cloudflare-projection";
import {
  AI_SEARCH_PRIMARY_NAMESPACE,
  createAiSearchGenerationRegistryService,
  createD1AiSearchGenerationRegistryStore,
  resolveAiSearchManagedSearchAuthority,
} from "@eliotr/cloudflare-ai";
import type {
  AuthenticatedRequestContext,
  LibraryReadinessRequest,
} from "@eliotr/interfaces";
import { CatalogInputError, beginCatalogRead, validateRequestIdentifier } from "./catalog-service.js";
import { catalogEligibility } from "./catalog-queries.js";

interface HeadRow {
  readonly source_id: unknown;
  readonly head_rev: unknown;
}

interface CurrentnessRow {
  readonly source_revision_ref: unknown;
  readonly currentness_state: unknown;
  readonly source_view_ref: unknown;
  readonly workspace_view_revision_ref: unknown;
}

function invalid(message: string): never {
  throw new CatalogInputError("LIBRARY_READINESS_AUTHORITY_INVALID", message, 503, true);
}

function id(value: unknown, label: string): string {
  try { return validateRequestIdentifier(value, label); }
  catch { return invalid(`stored ${label} is invalid`); }
}

function currentness(
  row: CurrentnessRow,
  sourceRevisionRef: string,
  ownerSystemId: string,
  ownerGeneration: string,
  observedAt: string,
): LibraryReadiness["currentness"] {
  const sourceView = id(row.source_view_ref, "source view");
  if (row.source_revision_ref !== sourceRevisionRef) invalid("currentness revision differs from the admitted head");
  const parsed = SourceCurrentnessSchema.safeParse({
    source_revision_ref: sourceRevisionRef,
    owner_system_id: ownerSystemId,
    source_owner_generation: ownerGeneration,
    source_view_ref: sourceView,
    ...(row.workspace_view_revision_ref === null || row.workspace_view_revision_ref === undefined ? {} : {
      workspace_view_revision_ref: id(row.workspace_view_revision_ref, "workspace view revision"),
    }),
    observation_freshness: row.currentness_state,
    observed_at: observedAt,
    gap_refs: [],
  });
  if (!parsed.success) invalid("stored source currentness is invalid");
  return parsed.data;
}

function projectionReadiness(
  readback: Awaited<ReturnType<typeof readD1SearchChannelReadback>>,
  sourceRevisionRef: string,
  channel: "exact_ready" | "lexical_ready",
  observedAt: string,
): ChannelReadiness {
  if (readback.pinned.length === 1 && readback.missing.length === 0 && readback.stale.length === 0) {
    const pin = readback.pinned[0];
    if (pin === undefined || pin.source_revision_ref !== sourceRevisionRef) invalid("projection pin is not bound to the current head");
    return ChannelReadinessSchema.parse({
      source_revision_ref: sourceRevisionRef,
      channel,
      state: "ready",
      generation: pin.projection_generation,
      receipt_ref: pin.receipt_ref,
      reason_codes: [],
      observed_at: observedAt,
    });
  }
  if (readback.stale.length > 0) {
    return ChannelReadinessSchema.parse({ source_revision_ref: sourceRevisionRef, channel, state: "stale",
      reason_codes: ["SEARCH_INCOMPLETE"], observed_at: observedAt });
  }
  return ChannelReadinessSchema.parse({ source_revision_ref: sourceRevisionRef, channel, state: "not_requested",
    reason_codes: ["SEARCH_UNAVAILABLE"], observed_at: observedAt });
}

async function activeProjection(
  search: D1Database,
  core: D1Database,
  channel: "exact" | "lexical",
  sourceRevisionRef: string,
  ownerGeneration: string,
): Promise<Awaited<ReturnType<typeof readD1SearchChannelReadback>>> {
  try {
    return await readD1SearchChannelReadback(search, core, channel, [sourceRevisionRef], {
      [sourceRevisionRef]: ownerGeneration,
    });
  } catch (error) {
    if (error instanceof CatalogInputError) throw error;
    const code = error instanceof Error && "code" in error
      ? (error as Error & { readonly code?: unknown }).code : undefined;
    return code === "SEARCH_INCOMPLETE"
      ? { channel, pinned: [], missing: [], stale: [sourceRevisionRef] }
      : { channel, pinned: [], missing: [sourceRevisionRef], stale: [] };
  }
}

async function managedSemantic(
  search: D1Database,
  core: D1Database,
  sourceRevisionRef: string,
  projectionGeneration: string,
  observedAt: string,
): Promise<ChannelReadiness> {
  try {
    const registry = await createAiSearchGenerationRegistryService(
      createD1AiSearchGenerationRegistryStore(search),
    ).read(AI_SEARCH_PRIMARY_NAMESPACE);
    if (registry === null) {
      return ChannelReadinessSchema.parse({ source_revision_ref: sourceRevisionRef, channel: "semantic_ready",
        state: "not_requested", reason_codes: ["MANAGED_SEMANTIC_UNAVAILABLE"], observed_at: observedAt });
    }
    const authority = await resolveAiSearchManagedSearchAuthority(registry, {
      expected_namespace: AI_SEARCH_PRIMARY_NAMESPACE, max_preview_bytes: 0, match_threshold: 0,
    });
    const readback = await readD1ManagedSemanticReadback(
      core, sourceRevisionRef, projectionGeneration, authority.instance_id, authority.index_generation,
    );
    return ChannelReadinessSchema.parse({ source_revision_ref: sourceRevisionRef, channel: "semantic_ready",
      state: readback.state, ...(readback.generation === undefined ? {} : { generation: readback.generation }),
      ...(readback.receipt_ref === undefined ? {} : { receipt_ref: readback.receipt_ref }),
      reason_codes: readback.reason_codes, observed_at: observedAt });
  } catch {
    return ChannelReadinessSchema.parse({ source_revision_ref: sourceRevisionRef, channel: "semantic_ready",
      state: "degraded", reason_codes: ["MANAGED_INDEX_READBACK_FAILED"], observed_at: observedAt });
  }
}

/** IMPLEMENTED_NOT_LIVE: ER-24 owner readiness composes active D1 projection and currentness readback; deployment qualification remains separate. */
export async function readLibraryReadiness(
  database: D1Database,
  searchDatabase: D1Database,
  context: AuthenticatedRequestContext,
  request: LibraryReadinessRequest,
  deploymentGeneration: string,
  now: () => number = Date.now,
): Promise<LibraryReadiness> {
  const sourceId = validateRequestIdentifier(request.source_id, "source_id");
  const fence = await beginCatalogRead(database, context, deploymentGeneration, now);
  await fence.authority.requireReadPolicy();
  const observedAt = new Date(fence.started).toISOString();
  const headRow = await database.prepare(`${catalogEligibility()} SELECT source_id, head_rev FROM eligible WHERE source_id=?3 LIMIT 1`)
    .bind(context.principal_ref, observedAt, sourceId).first<HeadRow>();
  if (headRow === null) throw new CatalogInputError("LIBRARY_SOURCE_NOT_FOUND", "Readable source not found", 404);
  const head = id(headRow.head_rev, "source head revision");
  const sources = await fence.authority.sources([head]);
  const authoritative = sources[0];
  if (authoritative === undefined || authoritative.revision.source_id !== sourceId) invalid("source head authority is inconsistent");
  const currentnessRow = await database.prepare(
    "SELECT source_revision_ref, currentness_state, source_view_ref, workspace_view_revision_ref " +
    "FROM source_revision WHERE source_revision_ref=?1 LIMIT 1",
  ).bind(head).first<CurrentnessRow>();
  if (currentnessRow === null) invalid("source currentness row is missing");
  const exact = await activeProjection(searchDatabase, database, "exact", head, authoritative.revision.source_owner_generation);
  const lexical = await activeProjection(searchDatabase, database, "lexical", head, authoritative.revision.source_owner_generation);
  const semantic = await managedSemantic(searchDatabase, database, head,
    exact.pinned[0]?.projection_generation ?? lexical.pinned[0]?.projection_generation ?? "unknown", observedAt);
  const lexicalChannel = projectionReadiness(lexical, head, "lexical_ready", observedAt);
  // Re-pin exact after lexical and managed-registry reads; the final response never
  // advertises the first pin after later awaited authority reads.
  const finalExact = await activeProjection(searchDatabase, database, "exact", head, authoritative.revision.source_owner_generation);
  const finalExactChannel = projectionReadiness(finalExact, head, "exact_ready", observedAt);
  await fence.authority.sources([head]);
  const result = LibraryReadinessSchema.parse({
    protocol: "eliotr.library-readiness.v1",
    source_id: sourceId,
    source_revision_ref: head,
    deployment_generation: deploymentGeneration,
    catalog_generation: String(fence.generation),
    observed_at: observedAt,
    currentness: currentness(currentnessRow, head, authoritative.revision.source_owner_system_id,
      authoritative.revision.source_owner_generation, observedAt),
    quality_state: authoritative.revision.quality_state,
    readiness_basis: "ACTIVE_VERIFIED",
    channels: [finalExactChannel, lexicalChannel, semantic],
  });
  await fence.finish();
  return result;
}
