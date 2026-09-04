import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDirectory = resolve(root, "infra/d1/core/migrations");
const database = new DatabaseSync(":memory:");

for (const name of (await readdir(migrationsDirectory))
  .filter((entry) => entry.endsWith(".sql"))
  .sort()) {
  database.exec(await readFile(resolve(migrationsDirectory, name), "utf8"));
}

assert.equal(
  database.prepare(
    "SELECT value FROM schema_state WHERE key='schema_generation'",
  ).get()?.value,
  "core-v10-federation-reference-authority",
);
const strictTables = new Map(
  database.prepare("PRAGMA table_list").all().map((row) => [row.name, row.strict]),
);
assert.equal(strictTables.get("federation_scope_snapshot_authority"), 1);
assert.equal(strictTables.get("federation_allowed_reference_manifest_authority"), 1);

const now = "2026-09-04T13:30:00.000Z";
const expires = "2026-09-05T13:30:00.000Z";
const digest = "a".repeat(64);
const manifestDigest = "b".repeat(64);
const snapshot = {
  snapshot_id: "scope-snapshot-1",
  revision: 1,
  resolved_scope_expression: { kind: "PROJECT", project_id: "project-1" },
  participant_generations: {
    "client-principal": "client-credential-generation-1",
    "server-principal": "server-credential-generation-1",
  },
  member_source_revision_refs: ["source-revision-1@1"],
  source_owner_generations: {
    "source-revision-1@1": "source-owner-generation-1",
  },
  policy_authority_ref: "privacy-policy-1",
  disclosure_closure_digest: "c".repeat(64),
  purge_ledger_revision: 7,
  client_fence_ref: "client-fence-1",
  digest,
  created_at: now,
  expires_at: expires,
};
const manifest = {
  manifest_ref: { id: "allowed-reference-manifest-1", revision: 1 },
  scope_snapshot_ref: { id: snapshot.snapshot_id, revision: snapshot.revision },
  allowed_source_revision_refs: [{ id: "source-revision-1", revision: 1 }],
  allowed_evidence_handle_refs: [{ id: "evidence-handle-1", revision: 1 }],
  allowed_tool_definition_refs: [],
  allowed_verifier_refs: [],
  permitted_anchor_and_precision_ceilings: [],
  provider_and_policy_generations: {
    "client-principal": "client-credential-generation-1",
    "server-principal": "server-credential-generation-1",
    "privacy-policy-1": "privacy-generation-1",
  },
  stale_or_revoked_entries: [],
  permitted_acquisition_or_expansion_routes: [],
  disclosure_ceiling: "private",
  allowed_use: ["federation.submit"],
  expires_at: expires,
  client_fence_ref: snapshot.client_fence_ref,
  manifest_digest: manifestDigest,
};

const insertSnapshot = database.prepare(
  "INSERT INTO federation_scope_snapshot_authority(" +
    "snapshot_id,revision,digest,client_fence_ref,policy_authority_ref," +
    "purge_ledger_revision,created_at,expires_at,snapshot_json,stored_at" +
    ") VALUES (?,?,?,?,?,?,?,?,?,?)",
);
const insertManifest = database.prepare(
  "INSERT INTO federation_allowed_reference_manifest_authority(" +
    "manifest_id,revision,manifest_digest,scope_snapshot_id," +
    "scope_snapshot_revision,client_fence_ref,expires_at,manifest_json,stored_at" +
    ") VALUES (?,?,?,?,?,?,?,?,?)",
);

insertSnapshot.run(
  snapshot.snapshot_id,
  snapshot.revision,
  snapshot.digest,
  snapshot.client_fence_ref,
  snapshot.policy_authority_ref,
  snapshot.purge_ledger_revision,
  snapshot.created_at,
  snapshot.expires_at,
  JSON.stringify(snapshot),
  now,
);
insertManifest.run(
  manifest.manifest_ref.id,
  manifest.manifest_ref.revision,
  manifest.manifest_digest,
  manifest.scope_snapshot_ref.id,
  manifest.scope_snapshot_ref.revision,
  manifest.client_fence_ref,
  manifest.expires_at,
  JSON.stringify(manifest),
  now,
);

const readback = database.prepare(
  "SELECT manifest_digest,scope_snapshot_id,scope_snapshot_revision," +
    "client_fence_ref FROM federation_allowed_reference_manifest_authority " +
    "WHERE manifest_id=? AND revision=?",
).get(manifest.manifest_ref.id, manifest.manifest_ref.revision);
assert.equal(readback?.manifest_digest, manifestDigest);
assert.equal(readback?.scope_snapshot_id, snapshot.snapshot_id);
assert.equal(readback?.scope_snapshot_revision, snapshot.revision);
assert.equal(readback?.client_fence_ref, snapshot.client_fence_ref);

assert.throws(
  () => insertManifest.run(
    "orphan-manifest",
    1,
    "d".repeat(64),
    "missing-snapshot",
    1,
    snapshot.client_fence_ref,
    expires,
    JSON.stringify({
      ...manifest,
      manifest_ref: { id: "orphan-manifest", revision: 1 },
      scope_snapshot_ref: { id: "missing-snapshot", revision: 1 },
      manifest_digest: "d".repeat(64),
    }),
    now,
  ),
  /FOREIGN KEY constraint failed/u,
  "manifest must reference an existing exact ScopeSnapshot revision",
);

assert.throws(
  () => insertManifest.run(
    "foreign-fence-manifest",
    1,
    "e".repeat(64),
    snapshot.snapshot_id,
    snapshot.revision,
    "other-client-fence",
    expires,
    JSON.stringify({
      ...manifest,
      manifest_ref: { id: "foreign-fence-manifest", revision: 1 },
      client_fence_ref: "other-client-fence",
      manifest_digest: "e".repeat(64),
    }),
    now,
  ),
  /FOREIGN KEY constraint failed/u,
  "manifest cannot cross the snapshot client fence",
);

assert.throws(
  () => insertSnapshot.run(
    "row-snapshot-2",
    1,
    "f".repeat(64),
    snapshot.client_fence_ref,
    snapshot.policy_authority_ref,
    snapshot.purge_ledger_revision,
    snapshot.created_at,
    snapshot.expires_at,
    JSON.stringify({
      ...snapshot,
      snapshot_id: "different-json-snapshot",
      digest: "f".repeat(64),
    }),
    now,
  ),
  /CHECK constraint failed/u,
  "snapshot row and JSON identity cannot diverge",
);

assert.throws(
  () => insertManifest.run(
    "row-manifest-2",
    1,
    "1".repeat(64),
    snapshot.snapshot_id,
    snapshot.revision,
    snapshot.client_fence_ref,
    expires,
    JSON.stringify({
      ...manifest,
      manifest_ref: { id: "different-json-manifest", revision: 1 },
      manifest_digest: "1".repeat(64),
    }),
    now,
  ),
  /CHECK constraint failed/u,
  "manifest row and JSON identity cannot diverge",
);

assert.throws(
  () => insertSnapshot.run(
    "uppercase-digest-snapshot",
    1,
    "A".repeat(64),
    snapshot.client_fence_ref,
    snapshot.policy_authority_ref,
    snapshot.purge_ledger_revision,
    snapshot.created_at,
    snapshot.expires_at,
    JSON.stringify({
      ...snapshot,
      snapshot_id: "uppercase-digest-snapshot",
      digest: "A".repeat(64),
    }),
    now,
  ),
  /CHECK constraint failed/u,
  "authority digest must be lowercase SHA-256",
);

const oversizedSnapshot = {
  ...snapshot,
  snapshot_id: "oversized-snapshot",
  digest: "2".repeat(64),
  padding: "x".repeat(1_048_576),
};
assert.throws(
  () => insertSnapshot.run(
    oversizedSnapshot.snapshot_id,
    1,
    oversizedSnapshot.digest,
    oversizedSnapshot.client_fence_ref,
    oversizedSnapshot.policy_authority_ref,
    oversizedSnapshot.purge_ledger_revision,
    oversizedSnapshot.created_at,
    oversizedSnapshot.expires_at,
    JSON.stringify(oversizedSnapshot),
    now,
  ),
  /CHECK constraint failed/u,
  "snapshot authority must fit the one-megabyte envelope",
);

assert.throws(
  () => database.prepare(
    "UPDATE federation_scope_snapshot_authority SET stored_at=? " +
      "WHERE snapshot_id=? AND revision=?",
  ).run(expires, snapshot.snapshot_id, snapshot.revision),
  /federation scope snapshot is immutable/u,
);
assert.throws(
  () => database.prepare(
    "UPDATE federation_allowed_reference_manifest_authority SET stored_at=? " +
      "WHERE manifest_id=? AND revision=?",
  ).run(expires, manifest.manifest_ref.id, manifest.manifest_ref.revision),
  /federation reference manifest is immutable/u,
);
assert.throws(
  () => database.prepare(
    "DELETE FROM federation_scope_snapshot_authority " +
      "WHERE snapshot_id=? AND revision=?",
  ).run(snapshot.snapshot_id, snapshot.revision),
  /FOREIGN KEY constraint failed/u,
  "referenced snapshot cannot disappear beneath an admitted manifest",
);

console.log(
  "Federation reference authority migration: PASS " +
    "(strict immutable revisions, exact JSON identity, fence-bound foreign key).",
);
