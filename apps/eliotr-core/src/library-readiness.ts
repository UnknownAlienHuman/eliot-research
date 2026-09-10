import {
  ChannelReadinessSchema,
  LibraryReadinessSchema,
  SNAPSHOT_VIEW_REF_PREFIX,
  SnapshotViewWitnessSchema,
  SourceCurrentnessSchema,
  type ChannelReadiness,
  type LibraryCurrentnessObservation,
  type LibraryReadiness,
  type SourceCurrentness,
  type SourceRevision,
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
import {
  createD1IngestAdmissionAuthority,
  loadVerifiedSnapshotViewFence,
} from "@eliotr/platform-cloudflare";
import type { PreparedIngestOperation } from "@eliotr/platform-cloudflare";
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

interface SnapshotAdmissionRow {
  readonly ingest_operation_id: unknown;
}

type ProjectionReadback = Awaited<ReturnType<typeof readD1SearchChannelReadback>> & {
  readonly failure_code?: string;
};

interface RawCaptureRow {
  readonly capture_id: unknown;
  readonly principal_ref: unknown;
  readonly owner_system_id: unknown;
  readonly source_namespace_id: unknown;
  readonly source_revision_ref: unknown;
  readonly source_logical_id: unknown;
  readonly source_owner_generation: unknown;
  readonly residency_key_digest: unknown;
  readonly content_sha256: unknown;
  readonly size_bytes: unknown;
  readonly state: unknown;
}

function invalid(message: string): never {
  throw new CatalogInputError("LIBRARY_READINESS_AUTHORITY_INVALID", message, 503, true);
}

function id(value: unknown, label: string): string {
  try { return validateRequestIdentifier(value, label); }
  catch { return invalid(`stored ${label} is invalid`); }
}

function recordedFreshness(row: CurrentnessRow): SourceCurrentness["observation_freshness"] {
  const parsed = SourceCurrentnessSchema.shape.observation_freshness.safeParse(row.currentness_state);
  if (!parsed.success) invalid("stored source currentness freshness is invalid");
  return parsed.data;
}

function unverifiedCurrentness(row: CurrentnessRow, reason: string): LibraryCurrentnessObservation {
  return { verification: "NOT_VERIFIED", recorded_freshness: recordedFreshness(row), reason_codes: [reason] };
}

async function currentness(
  database: D1Database,
  context: AuthenticatedRequestContext,
  row: CurrentnessRow,
  sourceRevisionRef: string,
  authoritative: { readonly revision: SourceRevision },
): Promise<LibraryReadiness["currentness"]> {
  const sourceView = id(row.source_view_ref, "source view");
  if (row.source_revision_ref !== sourceRevisionRef) invalid("currentness revision differs from the admitted head");
  if (!sourceView.startsWith(SNAPSHOT_VIEW_REF_PREFIX)) {
    return unverifiedCurrentness(row, "CURRENTNESS_OBSERVATION_UNAVAILABLE");
  }
  if (row.workspace_view_revision_ref !== null && row.workspace_view_revision_ref !== undefined) {
    id(row.workspace_view_revision_ref, "workspace view revision");
    return unverifiedCurrentness(row, "CURRENTNESS_SNAPSHOT_WITNESS_INCOMPLETE");
  }
  let admission: SnapshotAdmissionRow | null;
  try {
    admission = await database.prepare(
      "SELECT ingest_operation_id FROM raw_normalized_admission " +
        "WHERE source_revision_ref=?1 AND source_view_ref=?2 AND principal_ref=?3 AND state='COMMITTED' " +
        "ORDER BY updated_at DESC LIMIT 1",
    ).bind(sourceRevisionRef, sourceView, context.principal_ref).first<SnapshotAdmissionRow>();
  } catch {
    return unverifiedCurrentness(row, "CURRENTNESS_SNAPSHOT_WITNESS_UNAVAILABLE");
  }
  if (admission === null || admission.ingest_operation_id === null || admission.ingest_operation_id === undefined) {
    return unverifiedCurrentness(row, "CURRENTNESS_SNAPSHOT_WITNESS_UNAVAILABLE");
  }
  let ingestOperationId: string;
  try { ingestOperationId = validateRequestIdentifier(admission.ingest_operation_id, "ingest operation"); }
  catch { return unverifiedCurrentness(row, "CURRENTNESS_SNAPSHOT_WITNESS_UNAVAILABLE"); }
  let operation: PreparedIngestOperation | null;
  try { operation = await createD1IngestAdmissionAuthority(database).load(ingestOperationId); }
  catch { return unverifiedCurrentness(row, "CURRENTNESS_SNAPSHOT_WITNESS_UNAVAILABLE"); }
  if (operation === null) return unverifiedCurrentness(row, "CURRENTNESS_SNAPSHOT_WITNESS_UNAVAILABLE");
  let snapshot: Awaited<ReturnType<typeof loadVerifiedSnapshotViewFence>>;
  try { snapshot = await loadVerifiedSnapshotViewFence(database, operation); }
  catch { return unverifiedCurrentness(row, "CURRENTNESS_SNAPSHOT_WITNESS_INVALID"); }
  let witness: ReturnType<typeof SnapshotViewWitnessSchema.parse>;
  try { witness = SnapshotViewWitnessSchema.parse(JSON.parse(snapshot.snapshot_view_json)); }
  catch { return unverifiedCurrentness(row, "CURRENTNESS_SNAPSHOT_WITNESS_INVALID"); }
  let capture: RawCaptureRow | null;
  try {
    capture = await database.prepare(
      "SELECT capture_id,principal_ref,owner_system_id,source_namespace_id,source_revision_ref," +
        "source_logical_id,source_owner_generation,residency_key_digest,content_sha256,size_bytes,state " +
      "FROM raw_file_capture WHERE capture_id=?1 LIMIT 1",
    ).bind(snapshot.capture_id).first<RawCaptureRow>();
  } catch {
    return unverifiedCurrentness(row, "CURRENTNESS_SNAPSHOT_WITNESS_UNAVAILABLE");
  }
  if (capture === null) return unverifiedCurrentness(row, "CURRENTNESS_SNAPSHOT_WITNESS_UNAVAILABLE");
  if (capture.state !== "CAPTURED") return unverifiedCurrentness(row, "CURRENTNESS_SNAPSHOT_WITNESS_UNAVAILABLE");
  const revision = authoritative.revision;
  const bound = witness.source_view_ref === sourceView &&
    witness.source_revision_ref === revision.source_revision_ref &&
    witness.source_logical_id === revision.source_id &&
    witness.verified_principal_ref === context.principal_ref &&
    witness.capture_id === capture.capture_id &&
    witness.verified_principal_ref === capture.principal_ref &&
    witness.owner_system_id === capture.owner_system_id &&
    witness.source_namespace_id === capture.source_namespace_id &&
    witness.source_revision_ref === capture.source_revision_ref &&
    witness.source_logical_id === capture.source_logical_id &&
    witness.source_owner_generation === capture.source_owner_generation &&
    witness.original_sha256 === capture.content_sha256 &&
    witness.original_size_bytes === capture.size_bytes &&
    witness.residency_key_digest === capture.residency_key_digest &&
    witness.owner_system_id === revision.source_owner_system_id &&
    witness.source_namespace_id === revision.source_namespace_id &&
    witness.source_owner_generation === revision.source_owner_generation &&
    witness.observation_freshness === recordedFreshness(row);
  if (!bound) return unverifiedCurrentness(row, "CURRENTNESS_SNAPSHOT_WITNESS_MISMATCH");
  const parsed = SourceCurrentnessSchema.safeParse({
    source_revision_ref: witness.source_revision_ref,
    owner_system_id: witness.owner_system_id,
    source_owner_generation: witness.source_owner_generation,
    source_view_ref: witness.source_view_ref,
    observation_freshness: witness.observation_freshness,
    observed_at: witness.observed_at,
    gap_refs: [],
  });
  if (!parsed.success) return unverifiedCurrentness(row, "CURRENTNESS_SNAPSHOT_WITNESS_INVALID");
  return { verification: "VERIFIED", value: parsed.data };
}

function projectionReadiness(
  readback: ProjectionReadback,
  sourceRevisionRef: string,
  channel: "exact_ready" | "lexical_ready",
  observedAt: string,
): ChannelReadiness {
  if (readback.failure_code !== undefined) {
    return ChannelReadinessSchema.parse({ source_revision_ref: sourceRevisionRef, channel, state: "degraded",
      reason_codes: [readback.failure_code], observed_at: observedAt });
  }
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
): Promise<ProjectionReadback> {
  try {
    return await readD1SearchChannelReadback(search, core, channel, [sourceRevisionRef], {
      [sourceRevisionRef]: ownerGeneration,
    });
  } catch (error) {
    if (error instanceof CatalogInputError) throw error;
    return { channel, pinned: [], missing: [], stale: [], failure_code: "SEARCH_READBACK_FAILED" };
  }
}

async function managedSemantic(
  search: D1Database,
  core: D1Database,
  sourceRevisionRef: string,
  observedAt: string,
): Promise<ChannelReadiness> {
  try {
    const registryService = createAiSearchGenerationRegistryService(
      createD1AiSearchGenerationRegistryStore(search),
    );
    const registry = await registryService.read(AI_SEARCH_PRIMARY_NAMESPACE);
    if (registry === null) {
      return ChannelReadinessSchema.parse({ source_revision_ref: sourceRevisionRef, channel: "semantic_ready",
        state: "not_requested", reason_codes: ["MANAGED_SEMANTIC_UNAVAILABLE"], observed_at: observedAt });
    }
    const authority = await resolveAiSearchManagedSearchAuthority(registry, {
      expected_namespace: AI_SEARCH_PRIMARY_NAMESPACE, max_preview_bytes: 0, match_threshold: 0,
    });
    const readback = await readD1ManagedSemanticReadback(
      core, sourceRevisionRef, authority.instance_id, authority.index_generation,
    );
    const finalRegistry = await registryService.read(AI_SEARCH_PRIMARY_NAMESPACE);
    if (finalRegistry === null || finalRegistry.artifact_sha256 !== authority.registry_artifact_sha256) {
      throw new Error("managed semantic registry changed during readiness read");
    }
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
  const currentnessObservation = await currentness(database, context, currentnessRow, head, authoritative);
  const semantic = await managedSemantic(searchDatabase, database, head, observedAt);
  const [finalExact, finalLexical] = await Promise.all([
    activeProjection(searchDatabase, database, "exact", head, authoritative.revision.source_owner_generation),
    activeProjection(searchDatabase, database, "lexical", head, authoritative.revision.source_owner_generation),
  ]);
  const finalExactChannel = projectionReadiness(finalExact, head, "exact_ready", observedAt);
  const lexicalChannel = projectionReadiness(finalLexical, head, "lexical_ready", observedAt);
  await fence.authority.sources([head]);
  const result = LibraryReadinessSchema.parse({
    protocol: "eliotr.library-readiness.v1",
    source_id: sourceId,
    source_revision_ref: head,
    deployment_generation: deploymentGeneration,
    catalog_generation: String(fence.generation),
    observed_at: observedAt,
    currentness: currentnessObservation,
    quality_state: authoritative.revision.quality_state,
    readiness_basis: "ACTIVE_VERIFIED",
    channels: [finalExactChannel, lexicalChannel, semantic],
  });
  await fence.finish();
  return result;
}
