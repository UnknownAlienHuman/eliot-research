import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import type { LocatorCandidate } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import { canonicalEvidenceJson } from "./canonical.js";
import {
  resolveCandidateAuthority,
  resolveManagedCopyCandidateAuthority,
} from "./authority-load.js";
import type { EvidenceSourceAuthority, ScopeAuthority } from "./types.js";

const DIGEST = "a".repeat(64);

const candidate: LocatorCandidate = {
  candidate_id: "candidate-1",
  lane: "LEX",
  source_revision_ref: "revision-1",
  canonical_section_id: "section-1",
  preview: "untrusted preview",
  raw_score: 1,
  rank: 1,
  index_generation: "projection-1",
  metadata: { item_key: "item-1" },
};

function d1(database: DatabaseSync, afterAll?: () => void): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            all<T>() {
              const results = database.prepare(sql).all(...values as SQLInputValue[]) as T[];
              afterAll?.();
              return Promise.resolve({ success: true, results });
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function searchWorld(spanSource: string, spanGeneration: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE projection_item (
      item_key TEXT, source_revision_ref TEXT, canonical_section_id TEXT,
      content_sha256 TEXT, normalized_offset_map_ref TEXT,
      projection_generation TEXT, active INTEGER
    );
    CREATE TABLE projection_span (
      item_key TEXT, source_revision_ref TEXT, normalized_start_byte INTEGER,
      normalized_end_byte INTEGER, precision_kind TEXT, projection_generation TEXT
    );
    CREATE TABLE projection_generation_receipt (
      source_revision_ref TEXT, projection_generation TEXT, state TEXT
    );
    CREATE TABLE projection_activation_guard (
      source_revision_ref TEXT, projection_generation TEXT, verified INTEGER
    );
  `);
  database.prepare("INSERT INTO projection_item VALUES (?, ?, ?, ?, ?, ?, 1)")
    .run("item-1", "revision-1", "section-1", DIGEST, "offset-map-1", "projection-1");
  database.prepare("INSERT INTO projection_span VALUES (?, ?, 0, 5, 'normalized_bytes', ?)")
    .run("item-1", spanSource, spanGeneration);
  database.prepare("INSERT INTO projection_generation_receipt VALUES (?, ?, 'READY')")
    .run("revision-1", "projection-1");
  database.prepare("INSERT INTO projection_activation_guard VALUES (?, ?, 1)")
    .run("revision-1", "projection-1");
  return database;
}

const MANAGED_GENERATION = "managed-generation-1";
const MANAGED_INSTANCE = "search-instance-1";
const MANAGED_NAMESPACE = "search-namespace-1";
const MANAGED_METADATA_DIGEST = createHash("sha256")
  .update("eliotr.project-copy-generation.v1\u0000" + MANAGED_GENERATION)
  .digest("hex");
const CANONICAL_GENERATION = "projection-" + "9".repeat(48);
const CANONICAL_ITEM_KEY = "projection-" + "c".repeat(48);
const CONTENT_DIGEST = "a".repeat(64);
const RESIDENCY_DIGEST = "b".repeat(64);
const DOCUMENT_DIGEST = "d".repeat(64);
const READBACK_DIGEST = "e".repeat(64);
const SET_DIGEST = "f".repeat(64);
const PROFILE_DIGEST = "1".repeat(64);
const NOW = Date.parse("2026-10-14T17:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

interface ProjectCopyFixtureRow {
  readonly project_id: string;
  readonly membership_id: string;
  readonly physical_item_key: string;
  readonly provider_key: string;
  readonly provider_folder: string;
  readonly provider_item_id: string;
}

interface ManagedCopyWorld {
  readonly core: DatabaseSync;
  readonly search: DatabaseSync;
  readonly source: EvidenceSourceAuthority;
  readonly scope: ScopeAuthority;
  readonly copies: readonly [ProjectCopyFixtureRow, ProjectCopyFixtureRow];
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function insertRow(
  database: DatabaseSync,
  table: string,
  row: Readonly<Record<string, string | number | null>>,
): void {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(",");
  database.prepare(
    "INSERT INTO " + table + " (" + columns.join(",") + ") VALUES (" + placeholders + ")",
  ).run(...columns.map((column) => row[column] as SQLInputValue));
}

function managedCopyWorld(): ManagedCopyWorld {
  const core = new DatabaseSync(":memory:");
  core.exec(
    "CREATE TABLE source_revision (source_revision_ref TEXT PRIMARY KEY, source_id TEXT NOT NULL, " +
      "source_owner_generation TEXT NOT NULL, content_sha256 TEXT NOT NULL, " +
      "object_residency_key_digest TEXT NOT NULL, purge_state TEXT NOT NULL);" +
    "CREATE TABLE source (source_id TEXT PRIMARY KEY, source_namespace_id TEXT NOT NULL, " +
      "source_owner_system_id TEXT NOT NULL);" +
    "CREATE TABLE source_namespace_ownership (source_namespace_id TEXT NOT NULL, " +
      "owner_system_id TEXT NOT NULL, source_owner_generation TEXT NOT NULL, status TEXT NOT NULL, " +
      "PRIMARY KEY(source_namespace_id,owner_system_id,source_owner_generation));" +
    "CREATE TABLE source_admission_decision (decision_receipt_ref TEXT PRIMARY KEY, " +
      "source_revision_ref TEXT NOT NULL, source_owner_generation TEXT NOT NULL, decision TEXT NOT NULL, " +
      "object_residency_key_digest TEXT NOT NULL, instruction_taint TEXT NOT NULL, " +
      "expires_at TEXT, created_at TEXT NOT NULL);" +
    "CREATE TABLE project (project_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, " +
      "membership_generation INTEGER NOT NULL);" +
    "CREATE TABLE project_owner (project_id TEXT PRIMARY KEY, principal_ref TEXT NOT NULL);" +
    "CREATE TABLE project_source_membership (project_id TEXT NOT NULL, source_id TEXT NOT NULL, " +
      "membership_generation INTEGER NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT, " +
      "PRIMARY KEY(project_id,source_id,membership_generation));" +
    "CREATE TABLE managed_target_assignment_event (project_id TEXT NOT NULL, event_revision INTEGER NOT NULL, " +
      "event_kind TEXT NOT NULL, project_generation INTEGER NOT NULL, project_owner_principal_ref TEXT NOT NULL, " +
      "PRIMARY KEY(project_id,event_revision));" +
    "CREATE TABLE managed_target_assignment_current (project_id TEXT PRIMARY KEY, event_revision INTEGER NOT NULL, " +
      "event_kind TEXT NOT NULL, target_namespace TEXT, managed_instance_id TEXT, managed_generation TEXT, " +
      "target_profile_identity_sha256 TEXT);" +
    "CREATE TABLE scope_snapshot (snapshot_id TEXT NOT NULL, revision INTEGER NOT NULL, " +
      "snapshot_digest TEXT NOT NULL, invalidated_at TEXT, expires_at TEXT NOT NULL, " +
      "PRIMARY KEY(snapshot_id,revision));" +
    "CREATE TABLE job (job_id TEXT PRIMARY KEY, state TEXT NOT NULL, terminal_receipt_ref TEXT);" +
    "CREATE TABLE operation_receipt (receipt_id TEXT NOT NULL, revision INTEGER NOT NULL, outcome TEXT NOT NULL, " +
      "PRIMARY KEY(receipt_id,revision));" +
    "CREATE TABLE projection_generation (source_revision_ref TEXT NOT NULL, projection_generation TEXT NOT NULL, " +
      "job_id TEXT NOT NULL, state TEXT NOT NULL, item_count INTEGER NOT NULL, item_set_digest TEXT NOT NULL, " +
      "canonical_projection_generation TEXT NOT NULL, canonical_item_count INTEGER NOT NULL, " +
      "canonical_item_set_digest TEXT NOT NULL, provider_copy_count INTEGER NOT NULL, " +
      "provider_copy_set_digest TEXT NOT NULL, managed_item_protocol TEXT NOT NULL, " +
      "managed_target_instance_id TEXT NOT NULL, managed_target_generation TEXT NOT NULL, " +
      "managed_target_metadata_generation_digest TEXT NOT NULL, semantic_instance_id TEXT NOT NULL, " +
      "semantic_generation TEXT NOT NULL, semantic_receipt_ref TEXT NOT NULL, " +
      "semantic_readback_digest TEXT NOT NULL, updated_at TEXT NOT NULL, " +
      "PRIMARY KEY(source_revision_ref,projection_generation));" +
    "CREATE TABLE projection_terminal_guard (source_revision_ref TEXT NOT NULL, " +
      "projection_generation TEXT NOT NULL, job_id TEXT NOT NULL, terminal_receipt_id TEXT NOT NULL, " +
      "terminal_receipt_revision INTEGER NOT NULL, outcome TEXT NOT NULL, verified INTEGER NOT NULL, " +
      "PRIMARY KEY(source_revision_ref,projection_generation));" +
    "CREATE TABLE source_readiness (source_revision_ref TEXT NOT NULL, channel TEXT NOT NULL, " +
      "state TEXT NOT NULL, generation TEXT, receipt_ref TEXT, PRIMARY KEY(source_revision_ref,channel));" +
    "CREATE TABLE projection_managed_item_effect (source_revision_ref TEXT NOT NULL, " +
      "projection_generation TEXT NOT NULL, job_id TEXT NOT NULL, item_key TEXT NOT NULL, " +
      "canonical_projection_generation TEXT NOT NULL, canonical_item_key TEXT NOT NULL, " +
      "project_id TEXT NOT NULL, project_membership_id TEXT NOT NULL, membership_generation INTEGER NOT NULL, " +
      "copy_layout TEXT NOT NULL, metadata_generation_digest TEXT NOT NULL, canonical_body_ref TEXT NOT NULL, " +
      "canonical_body_sha256 TEXT NOT NULL, desired_index INTEGER NOT NULL, " +
      "normalized_start_byte INTEGER NOT NULL, normalized_end_byte INTEGER NOT NULL, " +
      "intent_id TEXT NOT NULL, intent_revision INTEGER NOT NULL, attempt_id TEXT NOT NULL, " +
      "execution_operation_id TEXT NOT NULL, dispatch_lease_generation INTEGER NOT NULL, " +
      "managed_instance_id TEXT NOT NULL, managed_generation TEXT NOT NULL, provider_source TEXT NOT NULL, " +
      "provider_key TEXT NOT NULL, section_content_sha256 TEXT NOT NULL, document_sha256 TEXT NOT NULL, " +
      "document_size_bytes INTEGER NOT NULL, metadata_json TEXT NOT NULL, state TEXT NOT NULL, " +
      "provider_item_id TEXT NOT NULL, readback_receipt_json TEXT NOT NULL, readback_sha256 TEXT NOT NULL, " +
      "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, " +
      "PRIMARY KEY(source_revision_ref,projection_generation,item_key), " +
      "UNIQUE(job_id,projection_generation,item_key), " +
      "UNIQUE(source_revision_ref,projection_generation,desired_index));",
  );

  const source: EvidenceSourceAuthority = {
    source_id: "source-1",
    owner_system_id: "owner-system-1",
    source_namespace_id: "namespace-1",
    source_owner_generation: "owner-generation-1",
    source_revision_ref: "revision-1",
    source_title: "Source One",
    source_class: "document",
    content_sha256: CONTENT_DIGEST,
    object_residency_key_digest: RESIDENCY_DIGEST,
    normalized_artifact_ref: "normalized-1",
    purge_state: "LIVE",
    admission_receipt_ref: "admission-1",
    source_assurance_ceiling: "QUALIFIED",
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    allowed_use: ["research"],
    disclosure_ceiling: "private",
  };
  const scope: ScopeAuthority = {
    snapshot: {
      snapshot_id: "scope-1",
      revision: 1,
      resolved_scope_expression: {
        kind: "UNION",
        left: { kind: "PROJECT", project_id: "project-a" },
        right: { kind: "PROJECT", project_id: "project-b" },
      },
      participant_generations: { library: "library-1" },
      member_source_revision_refs: [source.source_revision_ref],
      source_owner_generations: {
        [source.source_revision_ref]: source.source_owner_generation,
      },
      policy_authority_ref: "policy-1",
      disclosure_closure_digest: SET_DIGEST,
      purge_ledger_revision: 1,
      digest: "2".repeat(64),
      created_at: "2026-10-14T16:00:00.000Z",
      expires_at: "2026-10-15T16:00:00.000Z",
    },
    invalidated_at: null,
    invalidation_reason: null,
  };
  insertRow(core, "source_revision", {
    source_revision_ref: source.source_revision_ref,
    source_id: source.source_id,
    source_owner_generation: source.source_owner_generation,
    content_sha256: source.content_sha256,
    object_residency_key_digest: source.object_residency_key_digest,
    purge_state: "LIVE",
  });
  insertRow(core, "source", {
    source_id: source.source_id,
    source_namespace_id: source.source_namespace_id,
    source_owner_system_id: source.owner_system_id,
  });
  insertRow(core, "source_namespace_ownership", {
    source_namespace_id: source.source_namespace_id,
    owner_system_id: source.owner_system_id,
    source_owner_generation: source.source_owner_generation,
    status: "ACTIVE",
  });
  insertRow(core, "source_admission_decision", {
    decision_receipt_ref: source.admission_receipt_ref,
    source_revision_ref: source.source_revision_ref,
    source_owner_generation: source.source_owner_generation,
    decision: "ADMITTED",
    object_residency_key_digest: source.object_residency_key_digest,
    instruction_taint: source.instruction_taint,
    expires_at: null,
    created_at: "2026-10-14T15:00:00.000Z",
  });
  insertRow(core, "scope_snapshot", {
    snapshot_id: scope.snapshot.snapshot_id,
    revision: scope.snapshot.revision,
    snapshot_digest: scope.snapshot.digest,
    invalidated_at: null,
    expires_at: scope.snapshot.expires_at,
  });

  const projectCopies: [ProjectCopyFixtureRow, ProjectCopyFixtureRow] = [
    {
      project_id: "project-a",
      membership_id: "project:project-a:generation:1",
      physical_item_key: "projection-" + "a".repeat(48),
      provider_folder: "projection/" + "A".repeat(43) + "/",
      provider_key: "projection/" + "A".repeat(43) + "/projection-" + "a".repeat(48) + ".md",
      provider_item_id: "provider-item-a",
    },
    {
      project_id: "project-b",
      membership_id: "project:project-b:generation:1",
      physical_item_key: "projection-" + "b".repeat(48),
      provider_folder: "projection/" + "B".repeat(43) + "/",
      provider_key: "projection/" + "B".repeat(43) + "/projection-" + "b".repeat(48) + ".md",
      provider_item_id: "provider-item-b",
    },
  ];
  for (const [index, copy] of projectCopies.entries()) {
    insertRow(core, "project", {
      project_id: copy.project_id,
      generation: 1,
      membership_generation: 1,
    });
    insertRow(core, "project_owner", {
      project_id: copy.project_id,
      principal_ref: "principal-" + copy.project_id,
    });
    insertRow(core, "project_source_membership", {
      project_id: copy.project_id,
      source_id: source.source_id,
      membership_generation: 1,
      valid_from: "2026-10-01T00:00:00.000Z",
      valid_to: null,
    });
    insertRow(core, "managed_target_assignment_event", {
      project_id: copy.project_id,
      event_revision: 1,
      event_kind: "ASSIGN",
      project_generation: 1,
      project_owner_principal_ref: "principal-" + copy.project_id,
    });
    insertRow(core, "managed_target_assignment_current", {
      project_id: copy.project_id,
      event_revision: 1,
      event_kind: "ASSIGN",
      target_namespace: MANAGED_NAMESPACE,
      managed_instance_id: MANAGED_INSTANCE,
      managed_generation: MANAGED_GENERATION,
      target_profile_identity_sha256: PROFILE_DIGEST,
    });
    insertRow(core, "projection_managed_item_effect", {
      source_revision_ref: source.source_revision_ref,
      projection_generation: "job-generation-1",
      job_id: "job-1",
      item_key: copy.physical_item_key,
      canonical_projection_generation: CANONICAL_GENERATION,
      canonical_item_key: CANONICAL_ITEM_KEY,
      project_id: copy.project_id,
      project_membership_id: copy.membership_id,
      membership_generation: 1,
      copy_layout: "PROJECT_COPY_V1",
      metadata_generation_digest: MANAGED_METADATA_DIGEST,
      canonical_body_ref: "projection/canonical-source/items/body.md",
      canonical_body_sha256: CONTENT_DIGEST,
      desired_index: index,
      normalized_start_byte: 0,
      normalized_end_byte: 5,
      intent_id: "intent-1",
      intent_revision: 1,
      attempt_id: "attempt-1",
      execution_operation_id: "operation-1",
      dispatch_lease_generation: 1,
      managed_instance_id: MANAGED_INSTANCE,
      managed_generation: MANAGED_GENERATION,
      provider_source: "builtin",
      provider_key: copy.provider_key,
      section_content_sha256: CONTENT_DIGEST,
      document_sha256: DOCUMENT_DIGEST,
      document_size_bytes: 120,
      metadata_json: canonicalEvidenceJson({
        canonical_section_id: "section-1",
        content_sha256: CONTENT_DIGEST,
        instruction_taint: "DATA_ONLY",
        projection_generation: MANAGED_METADATA_DIGEST,
        source_revision_ref: source.source_revision_ref,
      }),
      state: "READBACK_VERIFIED",
      provider_item_id: copy.provider_item_id,
      readback_receipt_json: canonicalEvidenceJson({
        chunks_count: 1,
        content_sha256: DOCUMENT_DIGEST,
        file_size: 120,
        item_key: copy.physical_item_key,
        provider_item_id: copy.provider_item_id,
        provider_key: copy.provider_key,
        readback_sha256: READBACK_DIGEST,
      }),
      readback_sha256: READBACK_DIGEST,
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    });
  }
  insertRow(core, "job", {
    job_id: "job-1",
    state: "COMPLETED",
    terminal_receipt_ref: "terminal-1",
  });
  insertRow(core, "operation_receipt", {
    receipt_id: "terminal-1",
    revision: 1,
    outcome: "SUCCEEDED",
  });
  insertRow(core, "projection_generation", {
    source_revision_ref: source.source_revision_ref,
    projection_generation: "job-generation-1",
    job_id: "job-1",
    state: "COMPLETED",
    item_count: 1,
    item_set_digest: SET_DIGEST,
    canonical_projection_generation: CANONICAL_GENERATION,
    canonical_item_count: 1,
    canonical_item_set_digest: SET_DIGEST,
    provider_copy_count: 2,
    provider_copy_set_digest: sha("provider-copy-set-a-b"),
    managed_item_protocol: "eliotr.managed-item-effects.v1",
    managed_target_instance_id: MANAGED_INSTANCE,
    managed_target_generation: MANAGED_GENERATION,
    managed_target_metadata_generation_digest: MANAGED_METADATA_DIGEST,
    semantic_instance_id: MANAGED_INSTANCE,
    semantic_generation: MANAGED_GENERATION,
    semantic_receipt_ref: "managed-receipt-1",
    semantic_readback_digest: sha("two-provider-readbacks"),
    updated_at: NOW_ISO,
  });
  insertRow(core, "projection_terminal_guard", {
    source_revision_ref: source.source_revision_ref,
    projection_generation: "job-generation-1",
    job_id: "job-1",
    terminal_receipt_id: "terminal-1",
    terminal_receipt_revision: 1,
    outcome: "SUCCEEDED",
    verified: 1,
  });
  insertRow(core, "source_readiness", {
    source_revision_ref: source.source_revision_ref,
    channel: "semantic_ready",
    state: "ready",
    generation: MANAGED_GENERATION,
    receipt_ref: "managed-receipt-1",
  });

  const search = new DatabaseSync(":memory:");
  search.exec(
    "CREATE TABLE projection_item (item_key TEXT, source_revision_ref TEXT, " +
      "canonical_section_id TEXT, content_sha256 TEXT, normalized_offset_map_ref TEXT, " +
      "projection_generation TEXT, active INTEGER);" +
    "CREATE TABLE projection_span (item_key TEXT, source_revision_ref TEXT, " +
      "normalized_start_byte INTEGER, normalized_end_byte INTEGER, precision_kind TEXT, " +
      "projection_generation TEXT);" +
    "CREATE TABLE projection_generation_receipt (source_revision_ref TEXT, " +
      "projection_generation TEXT, state TEXT);" +
    "CREATE TABLE projection_activation_guard (source_revision_ref TEXT, " +
      "projection_generation TEXT, verified INTEGER);",
  );
  insertRow(search, "projection_item", {
    item_key: CANONICAL_ITEM_KEY,
    source_revision_ref: source.source_revision_ref,
    canonical_section_id: "section-1",
    content_sha256: CONTENT_DIGEST,
    normalized_offset_map_ref: "normalized-bytes:0:5",
    projection_generation: CANONICAL_GENERATION,
    active: 1,
  });
  insertRow(search, "projection_span", {
    item_key: CANONICAL_ITEM_KEY,
    source_revision_ref: source.source_revision_ref,
    normalized_start_byte: 0,
    normalized_end_byte: 5,
    precision_kind: "normalized_bytes",
    projection_generation: CANONICAL_GENERATION,
  });
  insertRow(search, "projection_generation_receipt", {
    source_revision_ref: source.source_revision_ref,
    projection_generation: CANONICAL_GENERATION,
    state: "READY",
  });
  insertRow(search, "projection_activation_guard", {
    source_revision_ref: source.source_revision_ref,
    projection_generation: CANONICAL_GENERATION,
    verified: 1,
  });

  return {
    core,
    search,
    source,
    scope,
    copies: projectCopies,
  };
}

function providerCandidate(copy: ProjectCopyFixtureRow): LocatorCandidate {
  return {
    candidate_id: "result-" + copy.project_id,
    lane: "SEM",
    source_revision_ref: "revision-1",
    canonical_section_id: "section-1",
    preview: "provider preview is not evidence",
    raw_score: 0.8,
    rank: 1,
    index_generation: MANAGED_GENERATION,
    metadata: {
      item_key: copy.physical_item_key,
      canonical_section_id: "section-1",
      content_sha256: CONTENT_DIGEST,
      instruction_taint: "DATA_ONLY",
      projection_generation: MANAGED_GENERATION,
      source_revision_ref: "revision-1",
      provider_item_key: copy.provider_key,
      provider_project_folder: copy.provider_folder,
      provider_project_id: copy.project_id,
      provider_project_membership_id: copy.membership_id,
      provider_namespace: MANAGED_NAMESPACE,
    },
  };
}

describe("projection authority tuple binding", () => {
  it.each([
    ["foreign source revision", "revision-foreign", "projection-1"],
    ["foreign projection generation", "revision-1", "projection-foreign"],
  ])("rejects a span with a %s", async (_label, spanSource, spanGeneration) => {
    const database = searchWorld(spanSource, spanGeneration);
    await expect(resolveCandidateAuthority(d1(database), candidate))
      .rejects.toMatchObject({ code: "EVIDENCE_LOCATOR_NOT_RESOLVABLE" });
    database.close();
  });

  it("returns the exact span tuple when item, source and generation agree", async () => {
    const database = searchWorld("revision-1", "projection-1");
    await expect(resolveCandidateAuthority(d1(database), candidate)).resolves.toMatchObject({
      item_key: "item-1",
      projection_generation: "projection-1",
      content_sha256: DIGEST,
      anchor: { kind: "normalized_byte_range", start: 0, end: 5 },
    });
    database.close();
  });
});

describe("PROJECT_COPY_V1 canonical evidence translation", () => {
  it("maps two project physical items to one active canonical D1 row through Core effect authority", async () => {
    const world = managedCopyWorld();
    const candidates = world.copies.map(providerCandidate);
    try {
      const resolved = await Promise.all(candidates.map((candidate) =>
        resolveManagedCopyCandidateAuthority(
          d1(world.core),
          d1(world.search),
          candidate,
          world.source,
          world.scope,
          () => NOW,
        )
      ));
      expect(new Set(resolved.map((entry) => entry.item_key))).toEqual(new Set([CANONICAL_ITEM_KEY]));
      expect(new Set(resolved.map((entry) => entry.projection_generation)))
        .toEqual(new Set([CANONICAL_GENERATION]));
      expect(candidates.map((candidate) => candidate.metadata.provider_item_key))
        .toEqual(world.copies.map((copy) => copy.provider_key));
      expect(resolved.map((entry) => entry.anchor)).toEqual([
        { kind: "normalized_byte_range", start: 0, end: 5 },
        { kind: "normalized_byte_range", start: 0, end: 5 },
      ]);
      expect(world.search.prepare(
        "SELECT COUNT(*) AS count FROM projection_item WHERE source_revision_ref=?1 AND active=1",
      ).get("revision-1")).toEqual({ count: 1 });
    } finally {
      world.core.close();
      world.search.close();
    }
  });

  it("rejects a ScopeSnapshot invalidated between Core mapping and canonical D1 lookup", async () => {
    const world = managedCopyWorld();
    let invalidated = false;
    const search = d1(world.search, () => {
      if (invalidated) return;
      invalidated = true;
      world.core.prepare(
        "UPDATE scope_snapshot SET invalidated_at=?1 WHERE snapshot_id=?2 AND revision=?3",
      ).run(NOW_ISO, world.scope.snapshot.snapshot_id, world.scope.snapshot.revision);
    });
    try {
      await expect(resolveManagedCopyCandidateAuthority(
        d1(world.core),
        search,
        providerCandidate(world.copies[0]),
        world.source,
        world.scope,
        () => NOW,
      )).rejects.toMatchObject({ code: "EVIDENCE_LOCATOR_NOT_RESOLVABLE" });
      expect(invalidated).toBe(true);
    } finally {
      world.core.close();
      world.search.close();
    }
  });

  it("rejects a provider key whose project provenance names the other Core copy", async () => {
    const world = managedCopyWorld();
    const candidate = providerCandidate(world.copies[1]);
    try {
      await expect(resolveManagedCopyCandidateAuthority(
        d1(world.core),
        d1(world.search),
        {
          ...candidate,
          metadata: {
            ...candidate.metadata,
            provider_project_id: world.copies[0].project_id,
            provider_project_membership_id: world.copies[0].membership_id,
          },
        },
        world.source,
        world.scope,
        () => NOW,
      )).rejects.toMatchObject({ code: "EVIDENCE_LOCATOR_NOT_RESOLVABLE" });
    } finally {
      world.core.close();
      world.search.close();
    }
  });

  it("rejects a provider locator with a different managed target generation", async () => {
    const world = managedCopyWorld();
    const candidate = providerCandidate(world.copies[0]);
    try {
      await expect(resolveManagedCopyCandidateAuthority(
        d1(world.core),
        d1(world.search),
        {
          ...candidate,
          index_generation: "managed-generation-wrong",
          metadata: { ...candidate.metadata, projection_generation: "managed-generation-wrong" },
        },
        world.source,
        world.scope,
        () => NOW,
      )).rejects.toMatchObject({ code: "EVIDENCE_LOCATOR_NOT_RESOLVABLE" });
    } finally {
      world.core.close();
      world.search.close();
    }
  });

  it.each([
    ["purged source", "UPDATE source_revision SET purge_state='PURGE_REQUESTED' WHERE source_revision_ref='revision-1'"],
    ["inactive owner", "UPDATE source_namespace_ownership SET status='RETIRED' WHERE source_namespace_id='namespace-1'"],
  ])("rejects a project copy after %s", async (_label, sql) => {
    const world = managedCopyWorld();
    world.core.exec(sql);
    try {
      await expect(resolveManagedCopyCandidateAuthority(
        d1(world.core),
        d1(world.search),
        providerCandidate(world.copies[0]),
        world.source,
        world.scope,
        () => NOW,
      )).rejects.toMatchObject({ code: "EVIDENCE_LOCATOR_NOT_RESOLVABLE" });
    } finally {
      world.core.close();
      world.search.close();
    }
  });

  it("rejects a stale effect map that has not reached readback verified", async () => {
    const world = managedCopyWorld();
    world.core.prepare(
      "UPDATE projection_managed_item_effect SET state='UNKNOWN' WHERE item_key=?1",
    ).run(world.copies[0].physical_item_key);
    try {
      await expect(resolveManagedCopyCandidateAuthority(
        d1(world.core),
        d1(world.search),
        providerCandidate(world.copies[0]),
        world.source,
        world.scope,
        () => NOW,
      )).rejects.toMatchObject({ code: "EVIDENCE_LOCATOR_NOT_RESOLVABLE" });
    } finally {
      world.core.close();
      world.search.close();
    }
  });
});
