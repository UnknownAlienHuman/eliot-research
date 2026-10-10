import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED_COMMIT = "b1a5848d458b0066a16bba47e3e67b0bc5b5f8d9";
const SERVICE_PATH = "packages/cloudflare-navigation/src/scope-service.ts";
const SERVICE_BLOB = "0c76b72be1a89ac87e910841b5f60e377c220bde";
const FIXTURE_PATH = "crates/eliotr-test-vectors/fixtures/scope-snapshot-identity.v1.txt";
const FIXTURE_BLOB = "dfaeebf22476317dce18ea4f6b10858667c42388";
const FIXTURE_SHA256 = "d42585b14486af972a62759840a8f64f88ae3d086dcf5fd3eea9a14474c79183";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitText(args) {
  return execFileSync("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
}

function gitBytes(args) {
  return execFileSync("git", args, { cwd: REPOSITORY_ROOT });
}

function literalCase(rows, caseId) {
  const matches = rows.filter((line) => line.startsWith(`${caseId}|`));
  assert.equal(matches.length, 1, `expected one literal K2a row for ${caseId}`);
  const [actualId, operation, inputHex, outcome, outputHex, errorCode] = matches[0].split("|");
  assert.equal(actualId, caseId);
  assert.ok(operation && inputHex && outcome && outputHex !== undefined && errorCode !== undefined);
  return { caseId, operation, inputHex, outcome, outputHex, errorCode };
}

function decodeSnapshot(hex, label) {
  assert.match(hex, /^(?:[0-9a-f]{2})+$/u, `${label} must be complete lowercase hex`);
  const bytes = Buffer.from(hex, "hex");
  return { bytes, snapshot: JSON.parse(bytes.toString("utf8")) };
}

function repositoryFor(snapshot, stored = new Map()) {
  if (snapshot !== null) {
    const key = `${snapshot.snapshot_id}@${snapshot.revision}`;
    stored.set(key, structuredClone(snapshot));
  }
  return {
    async resolveAtom() {
      return {
        atom_generation_ref: "g1",
        members: [{ source_revision_ref: "sr1", source_owner_generation: "og1", policy_closure_ref: "pc1" }],
      };
    },
    async resolveAuthorityClosure() {
      return {
        policy_authority_ref: "pa1",
        disclosure_closure_digest: "0".repeat(64),
        purge_ledger_revision: 0,
        client_fence_valid: true,
        denied_source_revision_refs: [],
      };
    },
    async persistSnapshot(value) {
      const valueKey = `${value.snapshot_id}@${value.revision}`;
      const prior = stored.get(valueKey);
      if (prior !== undefined) return JSON.stringify(prior) === JSON.stringify(value) ? "REPLAY" : "CONFLICT";
      stored.set(valueKey, structuredClone(value));
      return "CREATED";
    },
    async readSnapshot(snapshotId, revision) {
      const value = stored.get(`${snapshotId}@${revision}`);
      return value === undefined ? null : structuredClone(value);
    },
  };
}

async function currentnessFor(createScopeService, snapshot, stored = new Map()) {
  const repository = repositoryFor(snapshot, stored);
  const service = createScopeService(repository, { now: () => Date.parse(snapshot.created_at) });
  return service.validateCurrent(snapshot);
}

const actualServiceBlob = gitText(["hash-object", SERVICE_PATH]);
assert.equal(actualServiceBlob, SERVICE_BLOB, "scope-service.ts must be the inspected published b1a source");
assert.equal(gitText(["rev-parse", `${PUBLISHED_COMMIT}:${SERVICE_PATH}`]), SERVICE_BLOB);
assert.equal(gitText(["rev-parse", `${PUBLISHED_COMMIT}:${FIXTURE_PATH}`]), FIXTURE_BLOB);

const fixtureBytes = gitBytes(["show", `${PUBLISHED_COMMIT}:${FIXTURE_PATH}`]);
assert.equal(sha256(fixtureBytes), FIXTURE_SHA256, "the published K2a literal corpus changed");
const fixtureText = fixtureBytes.toString("utf8");
const fixtureLines = fixtureText.split(/\r?\n/u);
assert.equal(fixtureLines[0], "# protocol=eliotr.test-vectors.scope-snapshot-identity.v1");
const rows = fixtureLines.filter((line) => line.length > 0 && !line.startsWith("#"));

const server = await createServer({
  configFile: false,
  root: REPOSITORY_ROOT,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true, hmr: false, watch: null },
  ssr: { noExternal: [/^@eliotr\//u] },
});

try {
  const { createScopeService } = await server.ssrLoadModule(resolve(REPOSITORY_ROOT, SERVICE_PATH));
  assert.equal(typeof createScopeService, "function");

  const fixtureChecks = [];
  const expectedFixtureReasons = new Map([
    ["derive_minimal", ["SNAPSHOT_POLICY_CLOSURE_BINDING_MISSING"]],
    ["derive_shuffled_keys", ["SNAPSHOT_POLICY_CLOSURE_BINDING_MISSING"]],
    ["derive_escaped_equivalent", ["SNAPSHOT_POLICY_CLOSURE_BINDING_MISSING"]],
    ["derive_with_fence", ["SNAPSHOT_POLICY_CLOSURE_BINDING_MISSING"]],
    ["derive_project_expression", ["SNAPSHOT_POLICY_CLOSURE_BINDING_MISSING"]],
    ["derive_union_expression", ["SNAPSHOT_EXPRESSION_NON_CANONICAL", "SNAPSHOT_POLICY_CLOSURE_BINDING_MISSING"]],
    ["verify_id_mismatch", ["SNAPSHOT_ID_MISMATCH", "SNAPSHOT_POLICY_CLOSURE_BINDING_MISSING"]],
    ["verify_digest_mismatch", ["SNAPSHOT_DIGEST_MISMATCH", "SNAPSHOT_POLICY_CLOSURE_BINDING_MISSING"]],
    ["verify_foreign_policy", ["SNAPSHOT_DIGEST_MISMATCH", "SNAPSHOT_ID_MISMATCH", "SNAPSHOT_POLICY_CLOSURE_BINDING_MISSING"]],
    ["verify_foreign_scope", ["SNAPSHOT_DIGEST_MISMATCH", "SNAPSHOT_ID_MISMATCH", "SNAPSHOT_POLICY_CLOSURE_BINDING_MISSING"]],
    ["verify_foreign_generation", ["SNAPSHOT_DIGEST_MISMATCH", "SNAPSHOT_ID_MISMATCH", "SNAPSHOT_POLICY_CLOSURE_BINDING_MISSING"]],
  ]);

  for (const [caseId, expectedReasons] of expectedFixtureReasons) {
    const row = literalCase(rows, caseId);
    const derive = row.operation === "derive_snapshot_identity";
    assert.equal(row.outcome, derive ? "ok" : "error", `${caseId}: unexpected K2a literal outcome`);
    const sourceHex = derive ? row.outputHex : row.inputHex;
    const { snapshot } = decodeSnapshot(sourceHex, `${caseId} snapshot bytes`);
    const result = await currentnessFor(createScopeService, snapshot);
    assert.deepEqual(result.invalidation_reason_codes, expectedReasons, `${caseId}: scope-service identity result changed`);
    fixtureChecks.push({
      caseId,
      operation: row.operation,
      inputBytes: Buffer.from(row.inputHex, "hex").length,
      inputSha256: sha256(Buffer.from(row.inputHex, "hex")),
      literalOutputBytes: derive ? Buffer.from(row.outputHex, "hex").length : null,
      literalOutputSha256: derive ? sha256(Buffer.from(row.outputHex, "hex")) : null,
      snapshotId: snapshot.snapshot_id,
      digest: snapshot.digest,
      rustLiteralError: derive ? null : row.errorCode,
      observedServiceReasons: result.invalidation_reason_codes,
    });
  }

  const baselineRow = literalCase(rows, "derive_with_fence");
  const { snapshot: fencedSnapshot } = decodeSnapshot(baselineRow.outputHex, "derive_with_fence output");
  const reversedMembers = {
    ...fencedSnapshot,
    member_source_revision_refs: [...fencedSnapshot.member_source_revision_refs].reverse(),
  };
  const reversedResult = await currentnessFor(createScopeService, reversedMembers);
  assert.deepEqual(reversedResult.invalidation_reason_codes, [
    "SNAPSHOT_DIGEST_MISMATCH",
    "SNAPSHOT_ID_MISMATCH",
    "SNAPSHOT_MEMBERS_NON_CANONICAL",
    "SNAPSHOT_POLICY_CLOSURE_BINDING_MISSING",
  ]);

  const changedMemberSet = {
    ...fencedSnapshot,
    member_source_revision_refs: fencedSnapshot.member_source_revision_refs.slice(0, 1),
  };
  const memberSetResult = await currentnessFor(createScopeService, changedMemberSet);
  assert.deepEqual(memberSetResult.invalidation_reason_codes, [
    "SNAPSHOT_DIGEST_MISMATCH",
    "SNAPSHOT_ID_MISMATCH",
    "SNAPSHOT_OWNER_GENERATIONS_MISMATCH",
    "SNAPSHOT_POLICY_CLOSURE_BINDING_MISSING",
  ]);

  const stored = new Map();
  const repository = repositoryFor(null, stored);
  const service = createScopeService(repository, {
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    ttl_ms: 900_000,
  });
  const frozen = await service.freeze({ kind: "GLOBAL_LIBRARY" }, "fence1");
  assert.equal(frozen.snapshot_id, "scope-5c8e93a9e4d26c206e9e067ab7b26577165d294673f89e16");
  assert.equal(frozen.digest, "b5e287fe4be60649e00918688e728e535b47f8485dbf30a2e4e4abdae37493ff");
  assert.deepEqual(await service.validateCurrent(frozen), { current: true, invalidation_reason_codes: [] });

  console.log(JSON.stringify({
    status: "PASS",
    publishedCommit: PUBLISHED_COMMIT,
    serviceBlob: actualServiceBlob,
    fixtureBlob: FIXTURE_BLOB,
    fixtureBytes: fixtureBytes.length,
    fixtureSha256: sha256(fixtureBytes),
    fixtureCaseCount: rows.length,
    fixtureChecks,
    sourceOnlyNegatives: {
      reversedMemberOrder: reversedResult.invalidation_reason_codes,
      changedMemberSet: memberSetResult.invalidation_reason_codes,
    },
    actualFreeze: {
      expression: { kind: "GLOBAL_LIBRARY" },
      clientFenceRef: "fence1",
      now: "2026-01-01T00:00:00.000Z",
      ttlMs: 900_000,
      participantGenerations: frozen.participant_generations,
      memberSourceRevisionRefs: frozen.member_source_revision_refs,
      sourceOwnerGenerations: frozen.source_owner_generations,
      snapshotId: frozen.snapshot_id,
      digest: frozen.digest,
      currentness: "PASS",
    },
  }, null, 2));
} finally {
  await server.close();
}
