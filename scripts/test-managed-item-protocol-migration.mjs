import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migrationsDirectory = new URL("../infra/d1/core/migrations/", import.meta.url);
const baselineMigration = "0127_research_workflow_native_stage_completion.sql";
const baselineFiles = (await readdir(migrationsDirectory))
  .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/iu.test(name))
  .filter((name) => Number(name.slice(0, 4)) <= 127)
  .sort();
const postProtocolMigrations = (await readdir(migrationsDirectory))
  .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/iu.test(name))
  .filter((name) => Number(name.slice(0, 4)) > 129 && Number(name.slice(0, 4)) <= 149)
  .sort();

assert.equal(
  baselineFiles.at(-1),
  baselineMigration,
  "the fixture must start from the actual Core migration 0127 baseline",
);
assert.equal(
  postProtocolMigrations.at(-1),
  "0149_managed_project_copy_v2.sql",
  "the migration fixture must apply the actual Core sequence through 0149",
);

const db = new DatabaseSync(":memory:");

try {
  db.exec("PRAGMA foreign_keys = ON;");
  for (const name of baselineFiles) {
    db.exec(await readFile(new URL(name, migrationsDirectory), "utf8"));
  }

  db.exec(await readFile(new URL("0128_managed_item_effects.sql", migrationsDirectory), "utf8"));

  const sourceId = "source-managed-item-protocol-fixture";
  const sourceRevisionRef = "source-revision-managed-item-protocol-fixture";
  const ownerGeneration = "owner-generation-fixture";
  const jobId = "job-managed-item-protocol-fixture";
  const intentId = "intent-managed-item-protocol-fixture";
  const contentSha256 = "a".repeat(64);
  const residencyDigest = "b".repeat(64);
  const now = "2026-10-09T00:00:00.000Z";

  db.prepare(`
    INSERT INTO source (
      source_id, source_namespace_id, source_owner_system_id, source_owner_generation,
      ownership_mode, kind, title, default_storage_policy, default_residency_profile_id,
      source_class, license_policy_ref, default_retention_policy_id, head_rev, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceId,
    "namespace-managed-item-protocol-fixture",
    "system-managed-item-protocol-fixture",
    ownerGeneration,
    "erc_owned",
    "document",
    "Managed item protocol migration fixture",
    "storage-policy-fixture",
    "residency-profile-fixture",
    "owner_document",
    "license-policy-fixture",
    "retention-policy-fixture",
    sourceRevisionRef,
    now,
  );
  db.prepare(`
    INSERT INTO source_revision (
      source_revision_ref, source_id, source_owner_generation, content_sha256,
      object_residency_key_digest, original_r2_key, normalized_artifact_ref, captured_at,
      parser_profile_generation, quality_state, purge_state, source_view_ref, admitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceRevisionRef,
    sourceId,
    ownerGeneration,
    contentSha256,
    residencyDigest,
    null,
    null,
    now,
    null,
    "high_fidelity",
    "LIVE",
    "source-view-managed-item-protocol-fixture",
    now,
  );
  db.prepare(`
    INSERT INTO operation_intent (
      intent_id, revision, operation_kind, principal_ref, idempotency_key,
      payload_ref, policy_decision_ref, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    intentId,
    "PROJECTION_EXECUTION",
    "principal-managed-item-protocol-fixture",
    "idempotency-managed-item-protocol-fixture",
    "payload-managed-item-protocol-fixture",
    "policy-decision-managed-item-protocol-fixture",
    now,
  );
  db.prepare(`
    INSERT INTO job (job_id, intent_id, intent_revision, state, created_at, updated_at)
    VALUES (?, ?, 1, 'ACCEPTED', ?, ?)
  `).run(jobId, intentId, now, now);

  const legacyGeneration = "legacy-generation-before-managed-item-protocol";
  const generationColumns = [
    "source_revision_ref", "projection_generation", "job_id", "source_owner_generation",
    "content_sha256", "object_residency_key_digest", "projector_profile", "state",
    "created_at", "updated_at",
  ];
  const legacyInsert = db.prepare(`
    INSERT INTO projection_generation (${generationColumns.join(", ")})
    VALUES (${generationColumns.map(() => "?").join(", ")})
  `);
  legacyInsert.run(
    sourceRevisionRef,
    legacyGeneration,
    jobId,
    ownerGeneration,
    contentSha256,
    residencyDigest,
    "projection-profile-fixture",
    "PREPARING",
    now,
    now,
  );
  const legacyBefore = db.prepare(`
    SELECT ${generationColumns.join(", ")}
    FROM projection_generation
    WHERE source_revision_ref = ? AND projection_generation = ?
  `).get(sourceRevisionRef, legacyGeneration);

  db.exec(await readFile(new URL("0129_managed_item_protocol.sql", migrationsDirectory), "utf8"));

  const historicalV1Generation = "versioned-generation-history-before-0144";
  const historicalTargetInstance = "items-instance-fixture";
  const historicalTargetGeneration = "items-generation-fixture";
  db.prepare(`
    INSERT INTO projection_generation (
      ${generationColumns.join(", ")}, managed_item_protocol,
      managed_target_instance_id, managed_target_generation
    ) VALUES (${generationColumns.map(() => "?").join(", ")}, ?, ?, ?)
  `).run(
    sourceRevisionRef,
    historicalV1Generation,
    jobId,
    ownerGeneration,
    contentSha256,
    residencyDigest,
    "projection-profile-fixture",
    "PREPARING",
    now,
    now,
    "eliotr.managed-item-effects.v1",
    historicalTargetInstance,
    historicalTargetGeneration,
  );
  const attemptId = "attempt-managed-item-protocol-fixture";
  const operationId = "operation-managed-item-protocol-fixture";
  db.prepare(`
    INSERT INTO operation_attempt (
      attempt_id, intent_id, intent_revision, attempt_number, state,
      checkpoint_ref, error_code, started_at, ended_at
    ) VALUES (?, ?, 1, 1, 'STARTED', NULL, NULL, ?, NULL)
  `).run(attemptId, intentId, now);
  db.prepare(`
    INSERT INTO operation_execution_lease (
      operation_id, operation_kind, lease_owner, lease_generation, lease_until,
      attempt, state, checkpoint_ref, terminal_receipt_ref, last_error_code,
      created_at, updated_at
    ) VALUES (?, 'PROJECTION_EXECUTE', ?, 1, 9999999999999, 1, 'LEASED', NULL, NULL, NULL, 1, 1)
  `).run(operationId, "fixture-worker");
  const historicalItemKey = "legacy-flat-item";
  const historicalMetadata = JSON.stringify({
    canonical_section_id: "legacy-section",
    content_sha256: contentSha256,
    instruction_taint: "DATA_ONLY",
    projection_generation: historicalTargetGeneration,
    source_revision_ref: sourceRevisionRef,
  });
  const legacyEffectColumns = [
    "source_revision_ref", "projection_generation", "job_id", "item_key", "desired_index",
    "normalized_start_byte", "normalized_end_byte", "intent_id", "intent_revision", "attempt_id",
    "execution_operation_id", "dispatch_lease_generation", "managed_instance_id", "managed_generation",
    "provider_source", "provider_key", "section_content_sha256", "document_sha256",
    "document_size_bytes", "metadata_json", "state", "provider_item_id", "readback_receipt_json",
    "readback_sha256", "created_at", "updated_at",
  ];
  const legacyEffectInsert = db.prepare(`
    INSERT INTO projection_managed_item_effect (${legacyEffectColumns.join(", ")})
    VALUES (${legacyEffectColumns.map(() => "?").join(", ")})
  `);
  const legacyEffectValues = [
    sourceRevisionRef,
    historicalV1Generation,
    jobId,
    historicalItemKey,
    0,
    0,
    1,
    intentId,
    1,
    attemptId,
    operationId,
    null,
    historicalTargetInstance,
    historicalTargetGeneration,
    "builtin",
    `${historicalItemKey}.md`,
    contentSha256,
    contentSha256,
    1,
    historicalMetadata,
    "INTENT",
    null,
    null,
    null,
    now,
    now,
  ];
  legacyEffectInsert.run(...legacyEffectValues);
  const historicalProviderItemId = "provider-item-historical-readback";
  const historicalReadbackSha256 = "d".repeat(64);
  db.prepare(`
    UPDATE projection_managed_item_effect
    SET state='DISPATCHED', dispatch_lease_generation=1, updated_at=?
    WHERE source_revision_ref=? AND projection_generation=? AND item_key=?
  `).run(now, sourceRevisionRef, historicalV1Generation, historicalItemKey);
  db.prepare(`
    UPDATE projection_managed_item_effect
    SET state='READBACK_VERIFIED', provider_item_id=?, readback_receipt_json=?,
      readback_sha256=?, updated_at=?
    WHERE source_revision_ref=? AND projection_generation=? AND item_key=?
  `).run(
    historicalProviderItemId,
    JSON.stringify({
      chunks_count: 1,
      content_sha256: contentSha256,
      file_size: 1,
      item_key: historicalItemKey,
      provider_item_id: historicalProviderItemId,
      provider_key: `${historicalItemKey}.md`,
      readback_sha256: historicalReadbackSha256,
    }),
    historicalReadbackSha256,
    now,
    sourceRevisionRef,
    historicalV1Generation,
    historicalItemKey,
  );
  const historicalEffectBefore = db.prepare(`
    SELECT ${legacyEffectColumns.join(", ")} FROM projection_managed_item_effect
    WHERE source_revision_ref=? AND projection_generation=? AND item_key=?
  `).get(sourceRevisionRef, historicalV1Generation, historicalItemKey);
  const uniqueEffectIndexes = () => db.prepare(
    "PRAGMA index_list('projection_managed_item_effect')",
  ).all()
    .filter((index) => index.unique === 1)
    .map((index) => db.prepare(`PRAGMA index_info('${index.name}')`).all()
      .map((column) => column.name).join(","))
    .sort();
  const uniqueEffectConstraintsBefore = uniqueEffectIndexes();

  for (const name of postProtocolMigrations) {
    db.exec(await readFile(new URL(name, migrationsDirectory), "utf8"));
  }

  const tableColumns = db.prepare("PRAGMA table_info(projection_generation)").all();
  for (const name of [
    "managed_item_protocol",
    "managed_target_instance_id",
    "managed_target_generation",
    "managed_target_metadata_generation_digest",
    "canonical_projection_generation",
    "canonical_item_count",
    "canonical_item_set_digest",
    "provider_copy_count",
    "provider_copy_set_digest",
    "project_copy_map_index_protocol",
    "project_copy_map_index_ref",
    "project_copy_map_index_sha256",
    "project_copy_scope_snapshot_id",
    "project_copy_scope_snapshot_revision",
    "project_copy_scope_snapshot_digest",
  ]) {
    const column = tableColumns.find((entry) => entry.name === name);
    assert.ok(column, `${name} is added by the production migration`);
    assert.equal(column.notnull, 0, `${name} remains nullable for historical generations`);
  }

  const legacyAfter = db.prepare(`
    SELECT ${generationColumns.join(", ")}, managed_item_protocol,
      managed_target_instance_id, managed_target_generation,
      managed_target_metadata_generation_digest, canonical_projection_generation,
      canonical_item_count, canonical_item_set_digest, provider_copy_count, provider_copy_set_digest,
      project_copy_map_index_protocol, project_copy_map_index_ref, project_copy_map_index_sha256,
      project_copy_scope_snapshot_id, project_copy_scope_snapshot_revision,
      project_copy_scope_snapshot_digest
    FROM projection_generation
    WHERE source_revision_ref = ? AND projection_generation = ?
  `).get(sourceRevisionRef, legacyGeneration);
  assert.deepEqual(
    generationColumns.map((name) => legacyAfter[name]),
    generationColumns.map((name) => legacyBefore[name]),
    "the historical generation retains its original fields",
  );
  assert.deepEqual(
    [
      legacyAfter.managed_item_protocol,
      legacyAfter.managed_target_instance_id,
      legacyAfter.managed_target_generation,
      legacyAfter.managed_target_metadata_generation_digest,
      legacyAfter.canonical_projection_generation,
      legacyAfter.canonical_item_count,
      legacyAfter.canonical_item_set_digest,
      legacyAfter.provider_copy_count,
      legacyAfter.provider_copy_set_digest,
      legacyAfter.project_copy_map_index_protocol,
      legacyAfter.project_copy_map_index_ref,
      legacyAfter.project_copy_map_index_sha256,
      legacyAfter.project_copy_scope_snapshot_id,
      legacyAfter.project_copy_scope_snapshot_revision,
      legacyAfter.project_copy_scope_snapshot_digest,
    ],
    Array(15).fill(null),
    "the migration does not fabricate protocol, target metadata, or canonical copy authority for a historical generation",
  );

  const historicalEffectAfter = db.prepare(`
    SELECT ${legacyEffectColumns.join(", ")}, canonical_projection_generation,
      canonical_item_key, project_id, project_membership_id, membership_generation,
      copy_layout, metadata_generation_digest, canonical_body_ref, canonical_body_sha256,
      membership_identity_version, legacy_project_membership_id, stable_project_membership_id,
      membership_revision, project_membership_generation
    FROM projection_managed_item_effect
    WHERE source_revision_ref=? AND projection_generation=? AND item_key=?
  `).get(sourceRevisionRef, historicalV1Generation, historicalItemKey);
  assert.deepEqual(
    legacyEffectColumns.map((name) => historicalEffectAfter[name]),
    legacyEffectColumns.map((name) => historicalEffectBefore[name]),
    "0144 preserves every historical flat provider intent/readback field byte-for-byte",
  );
  assert.deepEqual(
    [
      historicalEffectAfter.canonical_projection_generation,
      historicalEffectAfter.canonical_item_key,
      historicalEffectAfter.project_id,
      historicalEffectAfter.project_membership_id,
      historicalEffectAfter.membership_generation,
      historicalEffectAfter.copy_layout,
      historicalEffectAfter.metadata_generation_digest,
      historicalEffectAfter.canonical_body_ref,
      historicalEffectAfter.canonical_body_sha256,
      historicalEffectAfter.membership_identity_version,
      historicalEffectAfter.legacy_project_membership_id,
      historicalEffectAfter.stable_project_membership_id,
      historicalEffectAfter.membership_revision,
      historicalEffectAfter.project_membership_generation,
    ],
    Array(14).fill(null),
    "0144 leaves historical flat mapping fields NULL",
  );
  const historicalV1After = db.prepare(`
    SELECT managed_item_protocol, managed_target_instance_id, managed_target_generation,
      managed_target_metadata_generation_digest, canonical_projection_generation,
      canonical_item_count, canonical_item_set_digest, provider_copy_count, provider_copy_set_digest,
      project_copy_map_index_protocol, project_copy_map_index_ref, project_copy_map_index_sha256,
      project_copy_scope_snapshot_id, project_copy_scope_snapshot_revision,
      project_copy_scope_snapshot_digest
    FROM projection_generation WHERE source_revision_ref=? AND projection_generation=?
  `).get(sourceRevisionRef, historicalV1Generation);
  assert.deepEqual(
    [
      historicalV1After.managed_item_protocol,
      historicalV1After.managed_target_instance_id,
      historicalV1After.managed_target_generation,
      historicalV1After.managed_target_metadata_generation_digest,
      historicalV1After.canonical_projection_generation,
      historicalV1After.canonical_item_count,
      historicalV1After.canonical_item_set_digest,
      historicalV1After.provider_copy_count,
      historicalV1After.provider_copy_set_digest,
      historicalV1After.project_copy_map_index_protocol,
      historicalV1After.project_copy_map_index_ref,
      historicalV1After.project_copy_map_index_sha256,
      historicalV1After.project_copy_scope_snapshot_id,
      historicalV1After.project_copy_scope_snapshot_revision,
      historicalV1After.project_copy_scope_snapshot_digest,
    ],
    ["eliotr.managed-item-effects.v1", historicalTargetInstance, historicalTargetGeneration,
      null, null, null, null, null, null, null, null, null, null, null, null],
    "0144 preserves historical v1 raw target pins without fabricating metadata/copy digests",
  );
  assert.deepEqual(
    uniqueEffectIndexes(),
    uniqueEffectConstraintsBefore,
    "0144 preserves every historical PRIMARY KEY and UNIQUE item-effect constraint",
  );

  const protocol = "eliotr.managed-item-effects.v1";
  const metadataGenerationDigest = (generation) => typeof generation === "string"
    ? createHash("sha256")
      .update(`eliotr.project-copy-generation.v1\0${generation}`, "utf8")
      .digest("hex")
    : null;
  const readPinnedFields = (generation) => {
    const row = db.prepare(`
      SELECT managed_item_protocol, managed_target_instance_id, managed_target_generation,
        managed_target_metadata_generation_digest
      FROM projection_generation
      WHERE source_revision_ref = ? AND projection_generation = ?
    `).get(sourceRevisionRef, generation);
    assert.ok(row, `generation ${generation} remains present`);
    return [
      row.managed_item_protocol,
      row.managed_target_instance_id,
      row.managed_target_generation,
      row.managed_target_metadata_generation_digest,
    ];
  };

  assert.throws(() => db.prepare(`
    UPDATE projection_generation
    SET managed_item_protocol = ?, managed_target_instance_id = ?, managed_target_generation = ?
    WHERE source_revision_ref = ? AND projection_generation = ?
  `).run(protocol, "backfill-instance-fixture", "backfill-generation-fixture", sourceRevisionRef, legacyGeneration),
  undefined, "a historical NULL marker cannot be backfilled");
  assert.deepEqual(
    readPinnedFields(legacyGeneration),
    [null, null, null, null],
    "a rejected historical backfill leaves all three fields NULL",
  );
  db.prepare(`
    UPDATE projection_generation
    SET managed_item_protocol = managed_item_protocol,
      managed_target_instance_id = managed_target_instance_id,
      managed_target_generation = managed_target_generation
    WHERE source_revision_ref = ? AND projection_generation = ?
  `).run(sourceRevisionRef, legacyGeneration);
  assert.deepEqual(
    readPinnedFields(legacyGeneration),
    [null, null, null, null],
    "a no-op update of historical NULL fields remains allowed without backfill",
  );

  const insertManagedGeneration = db.prepare(`
    INSERT INTO projection_generation (
      ${generationColumns.join(", ")}, managed_item_protocol,
      managed_target_instance_id, managed_target_generation,
      managed_target_metadata_generation_digest
    ) VALUES (${generationColumns.map(() => "?").join(", ")}, ?, ?, ?, ?)
  `);
  const insertCandidate = (generation, {
    marker = protocol,
    instance = "items-instance-fixture",
    targetGeneration = "items-generation-fixture",
    metadataDigest = metadataGenerationDigest(targetGeneration),
  } = {}) => insertManagedGeneration.run(
    sourceRevisionRef,
    generation,
    jobId,
    ownerGeneration,
    contentSha256,
    residencyDigest,
    "projection-profile-fixture",
    "PREPARING",
    now,
    now,
    marker,
    instance,
    targetGeneration,
    metadataDigest,
  );
  const rejectCandidate = (generation, values, reason) => {
    const before = db.prepare("SELECT COUNT(*) AS count FROM projection_generation").get().count;
    assert.throws(() => insertCandidate(generation, values), undefined, reason);
    const after = db.prepare("SELECT COUNT(*) AS count FROM projection_generation").get().count;
    assert.equal(after, before, `${reason}: rejected insert leaves no generation row`);
  };

  const v2IndexInsertColumns = [
    ...generationColumns,
    "managed_item_protocol",
    "managed_target_instance_id",
    "managed_target_generation",
    "managed_target_metadata_generation_digest",
    "project_copy_map_index_protocol",
  ];
  const generationCountBeforeIndexInsert = db.prepare(
    "SELECT COUNT(*) AS count FROM projection_generation",
  ).get().count;
  assert.throws(() => db.prepare(`
    INSERT INTO projection_generation (${v2IndexInsertColumns.join(", ")})
    VALUES (${v2IndexInsertColumns.map(() => "?").join(", ")})
  `).run(
    sourceRevisionRef, "copy-index-insert-denied", jobId, ownerGeneration,
    contentSha256, residencyDigest, "projection-profile-fixture", "PREPARING", now, now,
    protocol, "items-instance-fixture", "items-generation-fixture",
    metadataGenerationDigest("items-generation-fixture"),
    "eliotr.managed-project-copy-map-index.v2",
  ), undefined, "a V2 map index cannot be supplied during generation INSERT");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM projection_generation").get().count,
    generationCountBeforeIndexInsert,
    "a rejected map-index INSERT leaves no generation row",
  );

  insertCandidate("versioned-generation-valid");
  const accepted = db.prepare(`
    SELECT managed_item_protocol, managed_target_instance_id, managed_target_generation,
      managed_target_metadata_generation_digest
    FROM projection_generation
    WHERE source_revision_ref = ? AND projection_generation = ?
  `).get(sourceRevisionRef, "versioned-generation-valid");
  assert.deepEqual(
    [
      accepted.managed_item_protocol,
      accepted.managed_target_instance_id,
      accepted.managed_target_generation,
      accepted.managed_target_metadata_generation_digest,
    ],
    [protocol, "items-instance-fixture", "items-generation-fixture", metadataGenerationDigest("items-generation-fixture")],
    "the exact v1 marker and immutable raw/digested target pin are accepted and preserved",
  );

  const rejectPinnedUpdate = (column, value, reason) => {
    const before = readPinnedFields("versioned-generation-valid");
    assert.throws(() => db.prepare(`
      UPDATE projection_generation SET ${column} = ?
      WHERE source_revision_ref = ? AND projection_generation = ?
    `).run(value, sourceRevisionRef, "versioned-generation-valid"), undefined, reason);
    assert.deepEqual(
      readPinnedFields("versioned-generation-valid"),
      before,
      `${reason}: the persisted protocol and target pair stay unchanged`,
    );
  };
  rejectPinnedUpdate(
    "managed_item_protocol",
    "eliotr.managed-item-effects.v0",
    "changing the versioned protocol marker is rejected",
  );
  rejectPinnedUpdate(
    "managed_item_protocol",
    null,
    "clearing the versioned protocol marker is rejected",
  );
  rejectPinnedUpdate(
    "managed_target_instance_id",
    "other-items-instance-fixture",
    "changing the pinned target instance is rejected",
  );
  rejectPinnedUpdate(
    "managed_target_instance_id",
    null,
    "clearing the pinned target instance is rejected",
  );
  rejectPinnedUpdate(
    "managed_target_generation",
    "other-items-generation-fixture",
    "changing the pinned target generation is rejected",
  );
  rejectPinnedUpdate(
    "managed_target_generation",
    null,
    "clearing the pinned target generation is rejected",
  );
  rejectPinnedUpdate(
    "managed_target_metadata_generation_digest",
    "f".repeat(64),
    "changing the target metadata digest is rejected",
  );
  rejectPinnedUpdate(
    "managed_target_metadata_generation_digest",
    null,
    "clearing the target metadata digest is rejected",
  );

  const acceptedBeforeDelete = readPinnedFields("versioned-generation-valid");
  assert.throws(() => db.prepare(`
    DELETE FROM projection_generation
    WHERE source_revision_ref = ? AND projection_generation = ?
  `).run(sourceRevisionRef, "versioned-generation-valid"), undefined, "a versioned generation cannot be deleted");
  assert.deepEqual(
    readPinnedFields("versioned-generation-valid"),
    acceptedBeforeDelete,
    "a rejected deletion leaves the versioned generation and pinned identity unchanged",
  );

  const insertCopyIdentityCandidate = db.prepare(`
    INSERT INTO projection_generation (
      ${generationColumns.join(", ")}, managed_item_protocol,
      managed_target_instance_id, managed_target_generation,
      managed_target_metadata_generation_digest, canonical_projection_generation
    ) VALUES (${generationColumns.map(() => "?").join(", ")}, ?, ?, ?, ?, ?)
  `);
  assert.throws(() => insertCopyIdentityCandidate.run(
    sourceRevisionRef,
    "copy-identity-insert-denied",
    jobId,
    ownerGeneration,
    contentSha256,
    residencyDigest,
    "projection-profile-fixture",
    "PREPARING",
    now,
    now,
    protocol,
    "items-instance-fixture",
    "items-generation-fixture",
    metadataGenerationDigest("items-generation-fixture"),
    "canonical-projection-fixture",
  ), undefined, "canonical copy identity cannot be supplied during INSERT");

  insertCandidate("copy-identity-phase-denied");
  const phaseDeniedFields = db.prepare(`
    SELECT state, item_count, item_set_digest, canonical_projection_generation,
      canonical_item_count, canonical_item_set_digest, provider_copy_count, provider_copy_set_digest
    FROM projection_generation WHERE source_revision_ref=? AND projection_generation=?
  `);
  const phaseDeniedBefore = phaseDeniedFields.get(sourceRevisionRef, "copy-identity-phase-denied");
  assert.throws(() => db.prepare(`
    UPDATE projection_generation SET state='D1_READY', item_count=1, item_set_digest=?,
      work_manifest_ref='work/denied.json', work_manifest_sha256=?,
      canonical_projection_generation='canonical-projection-denied', canonical_item_count=1,
      canonical_item_set_digest=?, provider_copy_count=1, provider_copy_set_digest=?
    WHERE source_revision_ref=? AND projection_generation=?
  `).run("a".repeat(64), "b".repeat(64), "a".repeat(64), "c".repeat(64),
    sourceRevisionRef, "copy-identity-phase-denied"), undefined,
  "copy identity cannot bind outside PREPARING -> MATERIALIZED");
  assert.deepEqual(
    phaseDeniedFields.get(sourceRevisionRef, "copy-identity-phase-denied"),
    phaseDeniedBefore,
    "a rejected non-materialization phase leaves Work and copy identity unchanged",
  );
  assert.throws(() => db.prepare(`
    UPDATE projection_generation SET state='MATERIALIZED', canonical_projection_generation='canonical-partial'
    WHERE source_revision_ref=? AND projection_generation=?
  `).run(sourceRevisionRef, "copy-identity-phase-denied"), undefined,
  "partial five-field binding is rejected");
  assert.deepEqual(
    phaseDeniedFields.get(sourceRevisionRef, "copy-identity-phase-denied"),
    phaseDeniedBefore,
    "a rejected partial binding leaves every field unchanged",
  );

  insertCandidate("copy-identity-phase-valid");
  const canonicalGeneration = "canonical-projection-fixture";
  const providerCopyDigest = "c".repeat(64);
  db.prepare(`
    UPDATE projection_generation SET state='MATERIALIZED', item_count=1, item_set_digest=?,
      work_manifest_ref='projection/work/manifest.json', work_manifest_sha256=?,
      canonical_projection_generation=?, canonical_item_count=1, canonical_item_set_digest=?,
      provider_copy_count=1, provider_copy_set_digest=?, updated_at=?
    WHERE source_revision_ref=? AND projection_generation=? AND state='PREPARING'
  `).run("a".repeat(64), "b".repeat(64), canonicalGeneration, "a".repeat(64),
    providerCopyDigest, now, sourceRevisionRef, "copy-identity-phase-valid");
  const phaseValid = phaseDeniedFields.get(sourceRevisionRef, "copy-identity-phase-valid");
  assert.deepEqual(
    [phaseValid.state, phaseValid.item_count, phaseValid.item_set_digest,
      phaseValid.canonical_projection_generation, phaseValid.canonical_item_count,
      phaseValid.canonical_item_set_digest, phaseValid.provider_copy_count,
      phaseValid.provider_copy_set_digest],
    ["MATERIALIZED", 1, "a".repeat(64), canonicalGeneration, 1, "a".repeat(64), 1, providerCopyDigest],
    "the exact five-field receipt binds atomically with the original Work receipt",
  );
  assert.throws(() => db.prepare(`
    UPDATE projection_generation SET provider_copy_count=2
    WHERE source_revision_ref=? AND projection_generation=?
  `).run(sourceRevisionRef, "copy-identity-phase-valid"), undefined,
  "a materialized copy receipt is immutable");
  assert.throws(() => db.prepare(`
    UPDATE projection_generation SET item_count=2, item_set_digest=?
    WHERE source_revision_ref=? AND projection_generation=?
  `).run("d".repeat(64), sourceRevisionRef, "copy-identity-phase-valid"), undefined,
  "canonical Work count/digest aliases cannot drift after copy identity materialization");
  assert.throws(() => db.prepare(`
    UPDATE projection_generation SET
      project_copy_map_index_protocol='eliotr.managed-project-copy-map-index.v2',
      project_copy_map_index_ref='projection/source/copy-maps/index/target/scope/copy.json',
      project_copy_map_index_sha256=?, project_copy_scope_snapshot_id='scope-snapshot-fixture',
      project_copy_scope_snapshot_revision=1, project_copy_scope_snapshot_digest=?
    WHERE source_revision_ref=? AND projection_generation=?
  `).run("d".repeat(64), "e".repeat(64), sourceRevisionRef, "copy-identity-phase-valid"), undefined,
  "the complete V2 map-index receipt cannot be added after materialization");

  const sourceProjectId = "project-managed-copy-fixture";
  db.prepare(`
    INSERT INTO project (
      project_id, title, default_disclosure, retention_policy_ref, default_source_policy_ref,
      default_model_profile_ref, default_depth_profile_ref, generation, created_at, membership_generation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 7)
  `).run(sourceProjectId, "copy fixture", "PRIVATE", "retention-fixture", "source-policy-fixture",
    "model-profile-fixture", "depth-profile-fixture", now);
  const insertMembershipSource = (membershipSourceId) => db.prepare(`
    INSERT INTO source (
      source_id, source_namespace_id, source_owner_system_id, source_owner_generation,
      ownership_mode, kind, title, default_storage_policy, default_residency_profile_id,
      source_class, license_policy_ref, default_retention_policy_id, head_rev, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    membershipSourceId,
    `namespace-${membershipSourceId}`,
    "system-managed-item-protocol-fixture",
    ownerGeneration,
    "erc_owned",
    "document",
    `Membership churn fixture ${membershipSourceId}`,
    "storage-policy-fixture",
    "residency-profile-fixture",
    "owner_document",
    "license-policy-fixture",
    "retention-policy-fixture",
    now,
  );
  const insertFixtureMembership = (projectId, membershipSourceId, openingGeneration) => db.prepare(`
    INSERT INTO project_source_membership (
      project_id, source_id, role, valid_from, valid_to, membership_generation,
      membership_id, membership_revision
    ) VALUES (?, ?, 'member', ?, NULL, ?, json_array(?, ?), 1)
  `).run(projectId, membershipSourceId, now, openingGeneration, projectId, membershipSourceId);
  const legacyProjectId = "project-managed-copy-legacy-fixture";
  db.prepare(`
    INSERT INTO project (
      project_id, title, default_disclosure, retention_policy_ref, default_source_policy_ref,
      default_model_profile_ref, default_depth_profile_ref, generation, created_at, membership_generation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 3)
  `).run(legacyProjectId, "legacy copy fixture", "PRIVATE", "retention-fixture", "source-policy-fixture",
    "model-profile-fixture", "depth-profile-fixture", now);
  db.prepare(`
    INSERT INTO project_source_membership (
      project_id, source_id, role, valid_from, valid_to, membership_generation,
      membership_id, membership_revision
    ) VALUES (?, ?, 'member', ?, NULL, 7, json_array(?, ?), 1)
  `).run(sourceProjectId, sourceId, now, sourceProjectId, sourceId);
  insertFixtureMembership(legacyProjectId, sourceId, 3);
  const copyGeneration = "versioned-generation-copy-ready";
  insertCandidate(copyGeneration);
  db.prepare(`
    UPDATE projection_generation SET state='MATERIALIZED', item_count=1, item_set_digest=?,
      work_manifest_ref='projection/copy/manifest.json', work_manifest_sha256=?,
      canonical_projection_generation=?, canonical_item_count=1, canonical_item_set_digest=?,
      provider_copy_count=1, provider_copy_set_digest=?, updated_at=?
    WHERE source_revision_ref=? AND projection_generation=? AND state='PREPARING'
  `).run("a".repeat(64), "b".repeat(64), canonicalGeneration, "a".repeat(64),
    providerCopyDigest, now, sourceRevisionRef, copyGeneration);
  const metadataDigest = metadataGenerationDigest("items-generation-fixture");
  const copyItemKey = `projection-${"c".repeat(48)}`;
  const canonicalItemKey = `projection-${"d".repeat(48)}`;
  const folderToken = "e".repeat(43);
  const copyProviderKey = `projection/${folderToken}/${copyItemKey}.md`;
  const copyMetadata = JSON.stringify({
    canonical_section_id: "section-copy-fixture",
    content_sha256: "a".repeat(64),
    instruction_taint: "DATA_ONLY",
    projection_generation: metadataDigest,
    source_revision_ref: sourceRevisionRef,
  });
  const copyEffectColumns = [
    "source_revision_ref", "projection_generation", "job_id", "item_key",
    "canonical_projection_generation", "canonical_item_key", "project_id", "project_membership_id",
    "membership_generation", "membership_identity_version", "legacy_project_membership_id",
    "stable_project_membership_id", "membership_revision", "project_membership_generation",
    "copy_layout", "metadata_generation_digest", "canonical_body_ref",
    "canonical_body_sha256", "desired_index", "normalized_start_byte", "normalized_end_byte",
    "intent_id", "intent_revision", "attempt_id", "execution_operation_id", "dispatch_lease_generation",
    "managed_instance_id", "managed_generation", "provider_source", "provider_key",
    "section_content_sha256", "document_sha256", "document_size_bytes", "metadata_json", "state",
    "provider_item_id", "readback_receipt_json", "readback_sha256", "created_at", "updated_at",
  ];
  const insertCopyEffect = db.prepare(`
    INSERT INTO projection_managed_item_effect (${copyEffectColumns.join(", ")})
    VALUES (${copyEffectColumns.map(() => "?").join(", ")})
  `);
  const copyEffectValues = [
    sourceRevisionRef, copyGeneration, jobId, copyItemKey, canonicalGeneration, canonicalItemKey,
    sourceProjectId, `project:${sourceProjectId}:generation:7`, 7, null, null, null, null, null,
    "PROJECT_COPY_V1", metadataDigest,
    "projection/canonical/items/body.md", "a".repeat(64), 0, 0, 1, intentId, 1, attemptId,
    operationId, null, "items-instance-fixture", "items-generation-fixture", "builtin", copyProviderKey,
    "a".repeat(64), "a".repeat(64), 1, copyMetadata, "INTENT", null, null, null, now, now,
  ];
  const copyEffectColumnIndex = Object.fromEntries(
    copyEffectColumns.map((name, index) => [name, index]),
  );
  insertCopyEffect.run(...copyEffectValues);
  const validCopyEffect = db.prepare(`
    SELECT copy_layout, project_membership_id, provider_key, metadata_json,
      canonical_projection_generation, canonical_body_ref
    FROM projection_managed_item_effect WHERE source_revision_ref=? AND projection_generation=? AND item_key=?
  `).get(sourceRevisionRef, copyGeneration, copyItemKey);
  assert.equal(validCopyEffect.copy_layout, "PROJECT_COPY_V1");
  assert.equal(validCopyEffect.project_membership_id, `project:${sourceProjectId}:generation:7`);
  assert.equal(validCopyEffect.provider_key, copyProviderKey);
  assert.equal(validCopyEffect.canonical_projection_generation, canonicalGeneration);

  const unsafeCopyValues = [...copyEffectValues];
  unsafeCopyValues[copyEffectColumnIndex.item_key] = `projection-${"f".repeat(48)}`;
  unsafeCopyValues[copyEffectColumnIndex.provider_key] =
    `projection/${folderToken}/${unsafeCopyValues[copyEffectColumnIndex.item_key]}.md`;
  unsafeCopyValues[copyEffectColumnIndex.metadata_json] = JSON.stringify({
    canonical_section_id: "section-copy-fixture",
    content_sha256: "a".repeat(64),
    instruction_taint: "DATA_ONLY",
    projection_generation: "items-generation-fixture",
    source_revision_ref: sourceRevisionRef,
  });
  assert.throws(() => insertCopyEffect.run(...unsafeCopyValues), undefined,
    "PROJECT_COPY_V1 cannot write raw managed_generation into projection_generation metadata");

  const targetMismatchCopyValues = [...copyEffectValues];
  targetMismatchCopyValues[copyEffectColumnIndex.item_key] = `projection-${"9".repeat(48)}`;
  targetMismatchCopyValues[copyEffectColumnIndex.provider_key] =
    `projection/${folderToken}/${targetMismatchCopyValues[copyEffectColumnIndex.item_key]}.md`;
  targetMismatchCopyValues[copyEffectColumnIndex.metadata_generation_digest] = "f".repeat(64);
  targetMismatchCopyValues[copyEffectColumnIndex.metadata_json] = JSON.stringify({
    canonical_section_id: "section-copy-fixture",
    content_sha256: "a".repeat(64),
    instruction_taint: "DATA_ONLY",
    projection_generation: "f".repeat(64),
    source_revision_ref: sourceRevisionRef,
  });
  assert.throws(() => insertCopyEffect.run(...targetMismatchCopyValues), undefined,
    "PROJECT_COPY_V1 metadata digest must match the immutable target receipt");

  const sourceIdB = `${sourceId}-membership-b`;
  insertMembershipSource(sourceIdB);
  const firstAggregateBump = db.prepare(`
    UPDATE project SET membership_generation=8
    WHERE project_id=? AND membership_generation=7
  `).run(sourceProjectId);
  assert.equal(firstAggregateBump.changes, 1, "adding project membership B advances the aggregate from 7 to 8");
  insertFixtureMembership(sourceProjectId, sourceIdB, 8);
  assert.deepEqual(
    db.prepare(`
      SELECT source_id, membership_generation FROM project_source_membership
      WHERE project_id=? AND valid_to IS NULL ORDER BY source_id
    `).all(sourceProjectId).map((row) => [row.source_id, row.membership_generation]),
    [
      [sourceId, 7],
      [sourceIdB, 8],
    ],
    "B churn retains A's opening generation while the project aggregate advances",
  );

  const v2CopyGeneration = "versioned-generation-copy-v2-ready";
  insertCandidate(v2CopyGeneration);
  const v2IndexRef = "projection/source-prefix/copy-maps/index/target/scope/" +
    `${"c".repeat(64)}.json`;
  const v2IndexSha256 = "d".repeat(64);
  const v2ScopeSnapshotId = "scope-snapshot-copy-v2-fixture";
  const v2ScopeSnapshotRevision = 3;
  const v2ScopeSnapshotDigest = "e".repeat(64);
  db.prepare(`
    UPDATE projection_generation SET state='MATERIALIZED', item_count=1, item_set_digest=?,
      work_manifest_ref='projection/v2/manifest.json', work_manifest_sha256=?,
      canonical_projection_generation=?, canonical_item_count=1, canonical_item_set_digest=?,
      provider_copy_count=2, provider_copy_set_digest=?,
      project_copy_map_index_protocol='eliotr.managed-project-copy-map-index.v2',
      project_copy_map_index_ref=?, project_copy_map_index_sha256=?,
      project_copy_scope_snapshot_id=?, project_copy_scope_snapshot_revision=?,
      project_copy_scope_snapshot_digest=?, updated_at=?
    WHERE source_revision_ref=? AND projection_generation=? AND state='PREPARING'
  `).run(
    "a".repeat(64), "b".repeat(64), canonicalGeneration, "a".repeat(64),
    "c".repeat(64), v2IndexRef, v2IndexSha256, v2ScopeSnapshotId,
    v2ScopeSnapshotRevision, v2ScopeSnapshotDigest, now, sourceRevisionRef, v2CopyGeneration,
  );
  const v2GenerationReceipt = db.prepare(`
    SELECT state, item_count, item_set_digest, canonical_item_count, canonical_item_set_digest,
      provider_copy_count, provider_copy_set_digest, project_copy_map_index_protocol,
      project_copy_map_index_ref, project_copy_map_index_sha256, project_copy_scope_snapshot_id,
      project_copy_scope_snapshot_revision, project_copy_scope_snapshot_digest
    FROM projection_generation WHERE source_revision_ref=? AND projection_generation=?
  `).get(sourceRevisionRef, v2CopyGeneration);
  assert.deepEqual(
    [v2GenerationReceipt.state, v2GenerationReceipt.item_count, v2GenerationReceipt.item_set_digest,
      v2GenerationReceipt.canonical_item_count, v2GenerationReceipt.canonical_item_set_digest,
      v2GenerationReceipt.provider_copy_count, v2GenerationReceipt.provider_copy_set_digest,
      v2GenerationReceipt.project_copy_map_index_protocol, v2GenerationReceipt.project_copy_map_index_ref,
      v2GenerationReceipt.project_copy_map_index_sha256, v2GenerationReceipt.project_copy_scope_snapshot_id,
      v2GenerationReceipt.project_copy_scope_snapshot_revision, v2GenerationReceipt.project_copy_scope_snapshot_digest],
    ["MATERIALIZED", 1, "a".repeat(64), 1, "a".repeat(64), 2, "c".repeat(64),
      "eliotr.managed-project-copy-map-index.v2", v2IndexRef, v2IndexSha256, v2ScopeSnapshotId,
      v2ScopeSnapshotRevision, v2ScopeSnapshotDigest],
    "the V2 map index and scope bind with the existing canonical and provider receipt fields",
  );
  assert.throws(() => db.prepare(`
    UPDATE projection_generation SET project_copy_map_index_sha256=?
    WHERE source_revision_ref=? AND projection_generation=?
  `).run("f".repeat(64), sourceRevisionRef, v2CopyGeneration), undefined,
  "a materialized V2 map index receipt is immutable");

  const v2StableMembershipId = `project-membership-${"9".repeat(48)}`;
  const v2FolderToken = "8".repeat(43);
  const v2LegacyFolderToken = "7".repeat(43);
  const makeV2CopyValues = ({
    identityVersion,
    desiredIndex,
    itemKey,
    projectId = sourceProjectId,
    openingGeneration = 7,
    aggregateGeneration = 8,
    generation = v2CopyGeneration,
  }) => {
    const values = [...copyEffectValues];
    values[copyEffectColumnIndex.projection_generation] = generation;
    values[copyEffectColumnIndex.item_key] = itemKey;
    values[copyEffectColumnIndex.project_membership_id] = identityVersion === 1
      ? `project:${projectId}:generation:${openingGeneration}`
      : v2StableMembershipId;
    values[copyEffectColumnIndex.project_id] = projectId;
    values[copyEffectColumnIndex.membership_generation] = openingGeneration;
    values[copyEffectColumnIndex.membership_identity_version] = identityVersion;
    values[copyEffectColumnIndex.legacy_project_membership_id] = identityVersion === 1
      ? `project:${projectId}:generation:${openingGeneration}`
      : null;
    values[copyEffectColumnIndex.stable_project_membership_id] = identityVersion === 2
      ? v2StableMembershipId
      : null;
    values[copyEffectColumnIndex.membership_revision] = identityVersion === 2 ? 1 : null;
    values[copyEffectColumnIndex.project_membership_generation] = aggregateGeneration;
    values[copyEffectColumnIndex.copy_layout] = "PROJECT_COPY_V2";
    values[copyEffectColumnIndex.desired_index] = desiredIndex;
    const folderToken = identityVersion === 1 ? v2LegacyFolderToken : v2FolderToken;
    values[copyEffectColumnIndex.provider_key] = `projection/${folderToken}/${itemKey}.md`;
    return values;
  };
  const v2StableCopyValues = makeV2CopyValues({
    identityVersion: 2,
    desiredIndex: 0,
    itemKey: `projection-${"7".repeat(48)}`,
  });
  const v2LegacyCopyValues = makeV2CopyValues({
    identityVersion: 1,
    desiredIndex: 1,
    projectId: legacyProjectId,
    openingGeneration: 3,
    aggregateGeneration: 3,
    itemKey: `projection-${"6".repeat(48)}`,
  });
  insertCopyEffect.run(...v2StableCopyValues);
  insertCopyEffect.run(...v2LegacyCopyValues);
  const v2Effects = db.prepare(`
    SELECT item_key, membership_generation, membership_identity_version,
      legacy_project_membership_id, stable_project_membership_id, membership_revision,
      project_membership_generation, project_membership_id, provider_key, metadata_json
    FROM projection_managed_item_effect
    WHERE source_revision_ref=? AND projection_generation=? ORDER BY desired_index
  `).all(sourceRevisionRef, v2CopyGeneration);
  assert.deepEqual(
    v2Effects.map((effect) => [effect.membership_generation, effect.membership_identity_version,
      effect.legacy_project_membership_id, effect.stable_project_membership_id, effect.membership_revision,
      effect.project_membership_generation, effect.project_membership_id]),
    [
      [7, 2, null, v2StableMembershipId, 1, 8, v2StableMembershipId],
      [3, 1, `project:${legacyProjectId}:generation:3`, null, null, 3,
        `project:${legacyProjectId}:generation:3`],
    ],
    "V2 stores opening-row generation separately from aggregate currentness for both identity versions",
  );
  assert.ok(v2Effects[0]?.provider_key.startsWith(`projection/${v2FolderToken}/`));
  assert.ok(v2Effects[1]?.provider_key.startsWith(`projection/${v2LegacyFolderToken}/`));
  assert.ok(v2Effects.every((effect) => JSON.parse(effect.metadata_json).projection_generation === metadataDigest));

  const rejectV2Effect = (mutate, reason) => {
    const values = makeV2CopyValues({
      identityVersion: 2,
      desiredIndex: 2,
      itemKey: `projection-${"5".repeat(48)}`,
    });
    mutate(values);
    assert.throws(() => insertCopyEffect.run(...values), undefined, reason);
  };
  rejectV2Effect(
    (values) => { values[copyEffectColumnIndex.membership_revision] = 2; },
    "a V2 effect cannot substitute another per-pair membership revision",
  );
  rejectV2Effect(
    (values) => { values[copyEffectColumnIndex.project_membership_generation] = 7; },
    "a V2 effect must bind the current aggregate membership generation separately",
  );
  rejectV2Effect(
    (values) => { values[copyEffectColumnIndex.membership_revision] = null; },
    "a V2 stable identity requires its per-pair membership revision",
  );
  rejectV2Effect(
    (values) => {
      values[copyEffectColumnIndex.metadata_json] = JSON.stringify({
        ...JSON.parse(values[copyEffectColumnIndex.metadata_json]),
        projection_generation: "items-generation-fixture",
      });
    },
    "PROJECT_COPY_V2 metadata cannot substitute the raw provider generation",
  );
  rejectV2Effect(
    (values) => {
      values[copyEffectColumnIndex.metadata_generation_digest] = "f".repeat(64);
      values[copyEffectColumnIndex.metadata_json] = JSON.stringify({
        ...JSON.parse(values[copyEffectColumnIndex.metadata_json]),
        projection_generation: "f".repeat(64),
      });
    },
    "PROJECT_COPY_V2 metadata digest must equal the immutable target receipt",
  );
  const v2EffectWithoutIndex = makeV2CopyValues({
    identityVersion: 2,
    desiredIndex: 0,
    itemKey: `projection-${"4".repeat(48)}`,
  });
  v2EffectWithoutIndex[copyEffectColumnIndex.projection_generation] = "copy-identity-phase-valid";
  assert.throws(() => insertCopyEffect.run(...v2EffectWithoutIndex), undefined,
    "a PROJECT_COPY_V2 effect requires its exact materialized source-scoped map index receipt");

  const sourceIdC = `${sourceId}-membership-c`;
  insertMembershipSource(sourceIdC);
  const secondAggregateBump = db.prepare(`
    UPDATE project SET membership_generation=9
    WHERE project_id=? AND membership_generation=8
  `).run(sourceProjectId);
  assert.equal(secondAggregateBump.changes, 1, "adding membership C advances the aggregate from 8 to 9");
  insertFixtureMembership(sourceProjectId, sourceIdC, 9);
  const staleV2CopyValues = makeV2CopyValues({
    identityVersion: 2,
    desiredIndex: 2,
    itemKey: `projection-${"3".repeat(48)}`,
    aggregateGeneration: 8,
  });
  assert.throws(() => insertCopyEffect.run(...staleV2CopyValues), undefined,
    "a V2 writer fenced at aggregate 8 is rejected after the current project head advances to 9");

  const staleExpectedCas = db.prepare(`
    UPDATE project SET membership_generation=9
    WHERE project_id=? AND membership_generation=8
  `).run(sourceProjectId);
  assert.equal(staleExpectedCas.changes, 0, "a stale expected-CAS 8-to-9 write changes no row");
  const retriedCas = db.prepare(`
    UPDATE project SET membership_generation=10
    WHERE project_id=? AND membership_generation=9
  `).run(sourceProjectId);
  assert.equal(retriedCas.changes, 1, "the CAS retry with the current expected head 9 succeeds");
  const sourceIdD = `${sourceId}-membership-d`;
  insertMembershipSource(sourceIdD);
  insertFixtureMembership(sourceProjectId, sourceIdD, 10);

  const v2RetryGeneration = "versioned-generation-copy-v2-retry";
  insertCandidate(v2RetryGeneration);
  const v2RetryIndexRef = "projection/source-prefix/copy-maps/index/target/scope/retry/" +
    `${"f".repeat(64)}.json`;
  db.prepare(`
    UPDATE projection_generation SET state='MATERIALIZED', item_count=1, item_set_digest=?,
      work_manifest_ref='projection/v2-retry/manifest.json', work_manifest_sha256=?,
      canonical_projection_generation=?, canonical_item_count=1, canonical_item_set_digest=?,
      provider_copy_count=2, provider_copy_set_digest=?,
      project_copy_map_index_protocol='eliotr.managed-project-copy-map-index.v2',
      project_copy_map_index_ref=?, project_copy_map_index_sha256=?,
      project_copy_scope_snapshot_id='scope-snapshot-copy-v2-retry',
      project_copy_scope_snapshot_revision=4, project_copy_scope_snapshot_digest=?, updated_at=?
    WHERE source_revision_ref=? AND projection_generation=? AND state='PREPARING'
  `).run(
    "a".repeat(64), "b".repeat(64), canonicalGeneration, "a".repeat(64),
    "f".repeat(64), v2RetryIndexRef, "9".repeat(64), "8".repeat(64), now,
    sourceRevisionRef, v2RetryGeneration,
  );
  const v2RetryStableValues = makeV2CopyValues({
    identityVersion: 2,
    desiredIndex: 0,
    itemKey: `projection-${"7".repeat(48)}`,
    aggregateGeneration: 10,
    generation: v2RetryGeneration,
  });
  const v2RetryLegacyValues = makeV2CopyValues({
    identityVersion: 1,
    desiredIndex: 1,
    itemKey: `projection-${"6".repeat(48)}`,
    projectId: legacyProjectId,
    openingGeneration: 3,
    aggregateGeneration: 3,
    generation: v2RetryGeneration,
  });
  insertCopyEffect.run(...v2RetryStableValues);
  insertCopyEffect.run(...v2RetryLegacyValues);
  const v2RetryStableReceipt = db.prepare(`
    SELECT membership_generation, project_membership_generation, provider_key
    FROM projection_managed_item_effect
    WHERE source_revision_ref=? AND projection_generation=? AND item_key=?
  `).get(sourceRevisionRef, v2RetryGeneration, `projection-${"7".repeat(48)}`);
  assert.deepEqual(
    [v2RetryStableReceipt.membership_generation, v2RetryStableReceipt.project_membership_generation],
    [7, 10],
    "retry rebinds the aggregate receipt while retaining A's opening generation",
  );
  assert.equal(
    v2RetryStableReceipt.provider_key,
    v2Effects[0]?.provider_key,
    "B/C/D aggregate churn does not change the stable provider key for unchanged A",
  );

  const targetPinGuards = db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type='trigger' AND name='projection_managed_item_effect_target_pin_insert_guard'
  `).get();
  assert.equal(targetPinGuards.count, 1, "0149 preserves the historical target pin guard exactly once");
  const preservedEffectIndexes = db.prepare("PRAGMA index_list('projection_managed_item_effect')")
    .all().map((index) => index.name);
  assert.ok(preservedEffectIndexes.includes("projection_managed_item_effect_state_idx"));
  assert.ok(preservedEffectIndexes.includes("projection_managed_item_effect_copy_lookup_idx"));
  assert.ok(preservedEffectIndexes.includes("projection_managed_item_effect_copy_v2_lookup_idx"));
  assert.deepEqual(
    db.prepare("PRAGMA foreign_key_check").all(),
    [],
    "the actual rebuilt tables and retained Core dependencies have no foreign-key violations",
  );

  insertCandidate("versioned-generation-max-targets", {
    instance: "i".repeat(256),
    targetGeneration: "g".repeat(256),
  });
  rejectCandidate("versioned-generation-missing-marker", { marker: null }, "a missing protocol marker is rejected");
  rejectCandidate(
    "versioned-generation-wrong-marker",
    { marker: "eliotr.managed-item-effects.v0" },
    "a different protocol version is rejected",
  );
  rejectCandidate(
    "versioned-generation-missing-instance",
    { instance: null },
    "a missing target instance is rejected",
  );
  rejectCandidate(
    "versioned-generation-missing-generation",
    { targetGeneration: null },
    "a missing target generation is rejected",
  );
  rejectCandidate(
    "versioned-generation-empty-instance",
    { instance: "" },
    "an empty target instance is rejected",
  );
  rejectCandidate(
    "versioned-generation-empty-generation",
    { targetGeneration: "" },
    "an empty target generation is rejected",
  );
  rejectCandidate(
    "versioned-generation-long-instance",
    { instance: "i".repeat(257) },
    "a target instance over 256 characters is rejected",
  );
  rejectCandidate(
    "versioned-generation-long-generation",
    { targetGeneration: "g".repeat(257) },
    "a target generation over 256 characters is rejected",
  );
} finally {
  db.close();
}

console.log(
  "managed-item protocol native migration fixture: PASS (Core migrations through 0149, flat/readback and UNIQUE preservation, V1 target pin, mixed-row V2 opening 7/current aggregate 8 after B churn, stale 8-to-9 CAS rejection and retry, stable-key preservation, and V2 insert/phase/metadata negatives)",
);
