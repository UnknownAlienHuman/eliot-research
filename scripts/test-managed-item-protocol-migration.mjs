import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migrationsDirectory = new URL("../infra/d1/core/migrations/", import.meta.url);
const baselineMigration = "0127_research_workflow_native_stage_completion.sql";
const baselineFiles = (await readdir(migrationsDirectory))
  .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/iu.test(name))
  .filter((name) => Number(name.slice(0, 4)) <= 127)
  .sort();

assert.equal(
  baselineFiles.at(-1),
  baselineMigration,
  "the fixture must start from the actual Core migration 0127 baseline",
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

  const tableColumns = db.prepare("PRAGMA table_info(projection_generation)").all();
  for (const name of [
    "managed_item_protocol",
    "managed_target_instance_id",
    "managed_target_generation",
  ]) {
    const column = tableColumns.find((entry) => entry.name === name);
    assert.ok(column, `${name} is added by the production migration`);
    assert.equal(column.notnull, 0, `${name} remains nullable for historical generations`);
  }

  const legacyAfter = db.prepare(`
    SELECT ${generationColumns.join(", ")}, managed_item_protocol,
      managed_target_instance_id, managed_target_generation
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
    ],
    [null, null, null],
    "the migration does not fabricate protocol or target metadata for a historical generation",
  );

  const protocol = "eliotr.managed-item-effects.v1";
  const readPinnedFields = (generation) => {
    const row = db.prepare(`
      SELECT managed_item_protocol, managed_target_instance_id, managed_target_generation
      FROM projection_generation
      WHERE source_revision_ref = ? AND projection_generation = ?
    `).get(sourceRevisionRef, generation);
    assert.ok(row, `generation ${generation} remains present`);
    return [
      row.managed_item_protocol,
      row.managed_target_instance_id,
      row.managed_target_generation,
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
    [null, null, null],
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
    [null, null, null],
    "a no-op update of historical NULL fields remains allowed without backfill",
  );

  const insertManagedGeneration = db.prepare(`
    INSERT INTO projection_generation (
      ${generationColumns.join(", ")}, managed_item_protocol,
      managed_target_instance_id, managed_target_generation
    ) VALUES (${generationColumns.map(() => "?").join(", ")}, ?, ?, ?)
  `);
  const insertCandidate = (generation, {
    marker = protocol,
    instance = "items-instance-fixture",
    targetGeneration = "items-generation-fixture",
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
  );
  const rejectCandidate = (generation, values, reason) => {
    const before = db.prepare("SELECT COUNT(*) AS count FROM projection_generation").get().count;
    assert.throws(() => insertCandidate(generation, values), undefined, reason);
    const after = db.prepare("SELECT COUNT(*) AS count FROM projection_generation").get().count;
    assert.equal(after, before, `${reason}: rejected insert leaves no generation row`);
  };

  insertCandidate("versioned-generation-valid");
  const accepted = db.prepare(`
    SELECT managed_item_protocol, managed_target_instance_id, managed_target_generation
    FROM projection_generation
    WHERE source_revision_ref = ? AND projection_generation = ?
  `).get(sourceRevisionRef, "versioned-generation-valid");
  assert.deepEqual(
    [
      accepted.managed_item_protocol,
      accepted.managed_target_instance_id,
      accepted.managed_target_generation,
    ],
    [protocol, "items-instance-fixture", "items-generation-fixture"],
    "the exact v1 marker and complete target pair are accepted and preserved",
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
  "managed-item protocol native migration fixture: PASS (baseline through 0127, historical NULL retention, exact v1 target pin and SQL-declared target bounds)",
);
