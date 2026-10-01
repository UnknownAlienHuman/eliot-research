import type { ErasureRequest, PurgeTarget } from "@eliotr/contracts";
import {
  assertErasureIdentifier,
  assertErasureSha256,
  assertErasureText,
  erasureDigest,
  erasureFail,
  validateErasureRequest,
  stableErasureId,
} from "./canonical.js";
import {
  assertEmptyProofSubjectRootBinding,
  parseEmptyLocationProof,
  type EmptyLocationProofBody,
} from "./empty-location-proof.js";

interface RootRow {
  readonly source_revision_ref: unknown;
  readonly source_id: unknown;
  readonly source_namespace_id: unknown;
  readonly source_owner_system_id: unknown;
  readonly revision_owner_generation: unknown;
  readonly current_owner_generation: unknown;
  readonly owner_incarnation_ref: unknown;
  readonly ownership_record_revision: unknown;
  readonly content_sha256: unknown;
  readonly object_residency_key_digest: unknown;
}

interface ProjectionAuthorityRow {
  readonly projection_generation: unknown;
  readonly work_manifest_ref: unknown;
  readonly semantic_instance_id: unknown;
  readonly semantic_generation: unknown;
  readonly state: unknown;
}

interface ProjectionProducerRow {
  readonly projection_generation: unknown;
  readonly source_owner_generation: unknown;
  readonly projection_state: unknown;
  readonly job_state: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly terminal_guard: unknown;
}

function complete<T>(result: D1Result<T>, label: string): readonly T[] {
  const runtime = result as unknown as { readonly success?: unknown; readonly results?: unknown };
  if (runtime.success !== true || !Array.isArray(runtime.results)) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", `${label} inventory is incomplete`, true);
  }
  return runtime.results as readonly T[];
}

export async function readErasureRootIdentity(
  core: D1Database,
  sourceRevisionRef: string,
  requireQuarantined = true,
): Promise<EmptyLocationProofBody["root_identity"]> {
  const row = await core.prepare(
    "SELECT r.source_revision_ref,r.source_id,s.source_namespace_id,s.source_owner_system_id, " +
    "r.source_owner_generation AS revision_owner_generation,o.source_owner_generation AS current_owner_generation, " +
    "o.owner_incarnation_ref,o.ownership_record_revision,r.content_sha256,r.object_residency_key_digest " +
    "FROM source_revision r JOIN source s ON s.source_id=r.source_id " +
    "JOIN source_namespace_ownership o ON o.source_namespace_id=s.source_namespace_id " +
    "AND o.status='ACTIVE' AND o.owner_system_id=s.source_owner_system_id " +
    "AND o.source_owner_generation=s.source_owner_generation " +
    `WHERE r.source_revision_ref=?1 ${requireQuarantined ? "AND r.purge_state IN ('PURGE_REQUESTED','REDACTED') " : ""}LIMIT 1`,
  ).bind(sourceRevisionRef).first<RootRow>();
  if (row === null) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "empty proof source root is absent or not quarantined");
  const revisionOwner = assertErasureIdentifier(row.revision_owner_generation, "source revision owner generation");
  const currentOwner = assertErasureIdentifier(row.current_owner_generation, "current source owner generation");
  if (revisionOwner !== currentOwner) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "source owner generation changed before empty proof");
  return {
    source_revision_ref: assertErasureIdentifier(row.source_revision_ref, "source revision ref"),
    source_id: assertErasureIdentifier(row.source_id, "source ID"),
    source_namespace_id: assertErasureIdentifier(row.source_namespace_id, "source namespace ID"),
    source_owner_system_id: assertErasureIdentifier(row.source_owner_system_id, "source owner system ID"),
    source_owner_generation: currentOwner,
    owner_incarnation_ref: assertErasureIdentifier(row.owner_incarnation_ref, "owner incarnation ref"),
    ownership_record_revision: assertErasureIdentifier(String(row.ownership_record_revision), "ownership record revision"),
    content_sha256: assertErasureSha256(row.content_sha256, "source content digest"),
    object_residency_key_digest: assertErasureSha256(row.object_residency_key_digest, "source residency digest"),
  };
}

export async function readProjectionAuthorityDigest(core: D1Database, revisionRef: string): Promise<string> {
  const result = await core.prepare(
    "SELECT projection_generation,work_manifest_ref,semantic_instance_id,semantic_generation,state " +
    "FROM projection_generation WHERE source_revision_ref=?1 ORDER BY projection_generation " +
    "LIMIT 10001",
  ).bind(revisionRef).all<ProjectionAuthorityRow>();
  const rows = complete(result, "core projection-generation");
  if (rows.length > 10_000) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "projection-generation catalog exceeds its bound");
  return await erasureDigest(rows.map((row) => ({
    projection_generation: assertErasureIdentifier(row.projection_generation, "projection generation"),
    work_manifest_ref: row.work_manifest_ref === null ? null : assertErasureIdentifier(row.work_manifest_ref, "work manifest ref"),
    semantic_instance_id: row.semantic_instance_id === null ? null : assertErasureIdentifier(row.semantic_instance_id, "semantic instance"),
    semantic_generation: row.semantic_generation === null ? null : assertErasureIdentifier(row.semantic_generation, "semantic generation"),
    state: assertErasureIdentifier(row.state, "projection state"),
  })));
}

export async function readEmptyProofAuthorityDigest(
  core: D1Database,
  revisionRef: string,
  subjectRef: string,
  location: "Index" | "Projection",
): Promise<string> {
  const root = await readErasureRootIdentity(core, revisionRef);
  const producerRows = complete(await core.prepare(
    "SELECT g.projection_generation,g.source_owner_generation,g.state AS projection_state," +
    "j.state AS job_state,j.intent_id,j.intent_revision,COALESCE(t.verified,0) AS terminal_guard " +
    "FROM projection_generation g JOIN job j ON j.job_id=g.job_id " +
    "LEFT JOIN projection_terminal_guard t ON t.source_revision_ref=g.source_revision_ref " +
    "AND t.projection_generation=g.projection_generation " +
    "WHERE g.source_revision_ref=?1 ORDER BY g.projection_generation LIMIT 10001",
  ).bind(revisionRef).all<ProjectionProducerRow>(), "projection producer authority");
  if (producerRows.length > 10_000) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "projection producer inventory exceeds its bound");
  const producers = [];
  for (const row of producerRows) {
    const generation = assertErasureIdentifier(row.projection_generation, "projection producer generation");
    const ownerGeneration = assertErasureIdentifier(row.source_owner_generation, "projection producer owner generation");
    const projectionState = assertErasureIdentifier(row.projection_state, "projection producer state");
    const jobState = assertErasureIdentifier(row.job_state, "projection producer job state");
    const intentId = assertErasureIdentifier(row.intent_id, "projection producer intent ID");
    const intentRevision = row.intent_revision;
    if (typeof intentRevision !== "number" || !Number.isSafeInteger(intentRevision) || intentRevision < 1) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "projection producer intent revision is malformed");
    }
    if (
      ownerGeneration !== root.source_owner_generation ||
      !["COMPLETED", "PARTIAL", "RETIRED"].includes(projectionState) ||
      !["COMPLETED", "PARTIAL", "CANCELLED", "FAILED"].includes(jobState) ||
      row.terminal_guard !== 1
    ) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "projection writer is not proven terminal under the current owner generation");

    const operationId = await stableErasureId("projection-execute", intentId, String(intentRevision), generation);
    const lease = await core.prepare(
      "SELECT state FROM operation_execution_lease WHERE operation_id=?1 LIMIT 1",
    ).bind(operationId).first<{ readonly state: unknown }>();
    if (lease !== null && lease.state !== "COMPLETED" && lease.state !== "FAILED" && lease.state !== "CANCELLED") {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "projection writer execution lease is still active or unknown");
    }
    const attempts = complete(await core.prepare(
      "SELECT 1 AS present FROM operation_attempt WHERE intent_id=?1 AND intent_revision=?2 " +
      "AND state IN ('STARTED','CHECKPOINTED') LIMIT 1",
    ).bind(intentId, intentRevision).all<{ readonly present: unknown }>(), "projection producer attempt");
    if (attempts.length > 0) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "projection writer still has an active attempt");
    producers.push({ generation, owner_generation: ownerGeneration, projection_state: projectionState, job_state: jobState, intent_id: intentId, intent_revision: intentRevision, terminal_guard: 1 });
  }
  const outstandingIntent = complete(await core.prepare(
    "SELECT 1 AS present FROM operation_intent i LEFT JOIN job j ON j.intent_id=i.intent_id " +
    "AND j.intent_revision=i.revision LEFT JOIN outbox o ON o.intent_id=i.intent_id " +
    "AND o.intent_revision=i.revision WHERE i.operation_kind='PROJECTION' AND i.payload_ref=?1 " +
    "AND (j.job_id IS NULL OR j.state IN ('ACCEPTED','RUNNING','PARTIAL','BLOCKED') " +
    "OR o.state IN ('PENDING','LEASED','FAILED')) LIMIT 1",
  ).bind(revisionRef).all<{ readonly present: unknown }>(), "queued projection producer");
  if (outstandingIntent.length > 0) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "a queued or active projection producer can still write this source");
  const anyActiveProjectionLease = complete(await core.prepare(
    "SELECT 1 AS present FROM operation_execution_lease WHERE operation_kind='PROJECTION_EXECUTE' " +
    "AND state='LEASED' LIMIT 1",
  ).all<{ readonly present: unknown }>(), "active projection lease");
  if (anyActiveProjectionLease.length > 0) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "an in-flight projection writer prevents empty proof");

  const result = await core.prepare(
    "SELECT dependency_id,exact_subject_ref,location,canonical_ref,provider_ref,object_identity_digest,shared_reference_key," +
    "retention_or_hold_ref,next_review_at FROM erasure_dependency_registry " +
    "WHERE exact_subject_ref IN (?1,?2) AND location=?3 AND state='ACTIVE' " +
    "ORDER BY dependency_id LIMIT 10001",
  ).bind(subjectRef, revisionRef, location).all<Record<string, unknown>>();
  const rows = complete(result, "registered empty-proof dependency");
  if (rows.length > 10_000) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "registered empty-proof dependencies exceed their bound");
  const dependencies = rows.map((row) => ({
    dependency_id: assertErasureIdentifier(row.dependency_id, "registered dependency ID"),
    exact_subject_ref: assertErasureIdentifier(row.exact_subject_ref, "registered exact subject"),
    location: assertErasureIdentifier(row.location, "registered location"),
    canonical_ref: assertErasureText(row.canonical_ref, "registered canonical ref", 2048),
    provider_ref: row.provider_ref === null ? null : assertErasureText(row.provider_ref, "registered provider ref", 2048),
    object_identity_digest: assertErasureSha256(row.object_identity_digest, "registered object identity digest"),
    shared_reference_key: row.shared_reference_key === null ? null : assertErasureText(row.shared_reference_key, "shared reference key", 2048),
    retention_or_hold_ref: row.retention_or_hold_ref === null ? null : assertErasureText(row.retention_or_hold_ref, "retention or hold ref", 2048),
    next_review_at: row.next_review_at === null ? null : assertErasureText(row.next_review_at, "next review time", 2048),
  }));
  return erasureDigest({
    projection_catalog_digest: await readProjectionAuthorityDigest(core, revisionRef),
    terminal_projection_producers: producers,
    registered_dependencies: dependencies,
  });
}

async function presence(database: D1Database, sql: string, values: readonly unknown[], label: string): Promise<number> {
  const rows = complete(await database.prepare(sql).bind(...values).all<{ present: unknown }>(), label);
  if (rows.length > 1) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", `${label} exceeded its one-row probe bound`, true);
  if (rows.some((row) => row.present !== 1)) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", `${label} probe is malformed`, true);
  return rows.length;
}

const SOURCE_SEARCH_COUNTS: readonly [string, string][] = [
  ["projection_item", "SELECT 1 AS present FROM projection_item WHERE source_revision_ref=?1 LIMIT 1"],
  ["projection_span", "SELECT 1 AS present FROM projection_span WHERE source_revision_ref=?1 LIMIT 1"],
  ["projection_watermark", "SELECT 1 AS present FROM projection_watermark WHERE source_revision_ref=?1 LIMIT 1"],
  ["exact_scan_checkpoint", "SELECT 1 AS present FROM exact_scan_checkpoint WHERE source_revision_ref=?1 LIMIT 1"],
  ["projection_generation_receipt", "SELECT 1 AS present FROM projection_generation_receipt WHERE source_revision_ref=?1 LIMIT 1"],
  ["projection_activation_guard", "SELECT 1 AS present FROM projection_activation_guard WHERE source_revision_ref=?1 LIMIT 1"],
];

const ORPHAN_SEARCH_COUNTS: readonly [string, string][] = [
  ["section_fts", "SELECT 1 AS present FROM section_fts f WHERE NOT EXISTS (SELECT 1 FROM projection_item i WHERE i.item_key=f.item_key) LIMIT 1"],
  ["literal_gram", "SELECT 1 AS present FROM literal_gram g WHERE NOT EXISTS (SELECT 1 FROM projection_item i WHERE i.item_key=g.item_key) LIMIT 1"],
  ["exact_identifier", "SELECT 1 AS present FROM exact_identifier x WHERE NOT EXISTS (SELECT 1 FROM projection_item i WHERE i.item_key=x.item_key) LIMIT 1"],
  ["projection_span_orphan", "SELECT 1 AS present FROM projection_span p WHERE NOT EXISTS (SELECT 1 FROM projection_item i WHERE i.item_key=p.item_key) LIMIT 1"],
];

export interface D1SearchEmptySnapshot {
  readonly generation: string;
  readonly namespaceDigest: string;
  readonly objectCount: number;
}

export async function readD1SearchEmptySnapshot(
  core: D1Database,
  search: D1Database,
  revisionRef: string,
  subjectRef: string,
): Promise<D1SearchEmptySnapshot> {
  await readErasureRootIdentity(core, revisionRef);
  const authorityDigest = await readEmptyProofAuthorityDigest(core, revisionRef, subjectRef, "Index");
  const state = await search.prepare("SELECT value FROM schema_state WHERE key='schema_generation' LIMIT 1")
    .first<{ value: unknown }>();
  if (state === null || state.value !== "search-v4-ai-search-generation-registry") {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "D1 Search schema generation is unknown");
  }
  const counts: { readonly name: string; readonly count: number }[] = [];
  for (const [name, sql] of SOURCE_SEARCH_COUNTS) {
    counts.push({ name, count: await presence(search, sql, [revisionRef], name) });
  }
  for (const [name, sql] of ORPHAN_SEARCH_COUNTS) {
    counts.push({ name, count: await presence(search, sql, [], name) });
  }
  const objectCount = counts.reduce((sum, item) => sum + item.count, 0);
  const namespaceDigest = await erasureDigest({
    schema_generation: state.value,
    core_projection_authority_digest: authorityDigest,
    counts,
  });
  return { generation: state.value, namespaceDigest, objectCount };
}

export async function validateD1SearchEmptyProof(
  core: D1Database,
  search: D1Database,
  request: ErasureRequest,
  target: PurgeTarget,
): Promise<void> {
  const proof = await parseEmptyLocationProof(target);
  const normalized = validateErasureRequest(request);
  if (proof.location !== "Index" || proof.request_digest !== await erasureDigest(normalized)) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "D1 Search empty proof does not bind to this request and location");
  }
  if (!normalized.exact_subject_refs.includes(proof.exact_subject_ref)) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "D1 Search empty proof subject is not selected by the request");
  }
  assertEmptyProofSubjectRootBinding(proof);
  const root = await readErasureRootIdentity(core, proof.root_identity.source_revision_ref);
  if (await erasureDigest(root) !== await erasureDigest(proof.root_identity)) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "D1 Search empty proof root identity is stale");
  }
  const snapshot = await readD1SearchEmptySnapshot(core, search, root.source_revision_ref, proof.exact_subject_ref);
  if (snapshot.objectCount !== 0 || snapshot.generation !== proof.namespace_snapshot.namespace_generation ||
    snapshot.namespaceDigest !== proof.namespace_snapshot.namespace_digest ||
    proof.namespace_snapshot.namespace_ref !== root.source_revision_ref ||
    snapshot.generation !== proof.namespace_snapshot.namespace_generation ||
    await readEmptyProofAuthorityDigest(core, root.source_revision_ref, proof.exact_subject_ref, "Index") !== proof.namespace_snapshot.authority_digest) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "D1 Search empty proof is stale or the namespace is not empty");
  }
}

export async function makeD1SearchEmptyProofFields(
  core: D1Database,
  search: D1Database,
  requestDigest: string,
  subjectRef: string,
  revisionRef: string,
): Promise<EmptyLocationProofBody> {
  const [root, snapshot] = await Promise.all([
    readErasureRootIdentity(core, revisionRef),
    readD1SearchEmptySnapshot(core, search, revisionRef, subjectRef),
  ]);
  if (snapshot.objectCount !== 0) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "D1 Search has source or orphan rows; empty proof is refused");
  return {
    request_digest: requestDigest,
    exact_subject_ref: subjectRef,
    location: "Index",
    root_identity: root,
    namespace_snapshot: {
      authority_digest: await readEmptyProofAuthorityDigest(core, revisionRef, subjectRef, "Index"),
      namespace_digest: snapshot.namespaceDigest,
      namespace_generation: snapshot.generation,
      namespace_ref: root.source_revision_ref,
      object_count: 0,
    },
  };
}
