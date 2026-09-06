import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createD1ExecutionLeaseStore,
  createD1OutboxStore,
  messageFromLease,
} from "@eliotr/platform-cloudflare";
import {
  createD1ProjectionAuthority,
  createD1ProjectionSearchPort,
  createD1SearchIdentPort,
  createD1SearchLexPort,
  createProjectionExecutionHandler,
  createR2ProjectionContentPort,
  createR2ProjectionWorkPort,
} from "@eliotr/cloudflare-projection";
import {
  compileQueryPlan,
  createIdentLaneExecutor,
  createLexLaneExecutor,
  executePlannedLanes,
} from "@eliotr/retrieval";
import type { ScopeSnapshot } from "@eliotr/contracts";
import type { RetrievalRequest } from "@eliotr/retrieval";
import { bundleFixture } from "../../../packages/platform-cloudflare/src/ingest-test-fixture.js";
import { prepareBrowserBundle } from "../../eliotr-pwa/src/bundle-input.js";
import { importBrowserBundle } from "../../eliotr-pwa/src/bundle-import.js";
import type { ImportTransport } from "../../eliotr-pwa/src/bundle-import-api.js";
import { decodeApiProblem } from "../../eliotr-pwa/src/api.js";
import { handleHttp } from "../src/http.js";
import { createProjectionDeliveryHandler } from "../src/projection-delivery-handler.js";
import { PROJECTION_EXECUTION_PROFILE } from "../src/projection-execution-handler.js";
import type { Env } from "../src/env.js";

/**
 * Q1 narrow proof: real HTTP import -> existing outbox dispatcher -> existing
 * projection delivery + projector + D1 Search activation -> new IDENT/LEX lane.
 *
 * Miniflare emulation note: the production R2 conditional write (put with
 * `onlyIf` + `sha256`) is rejected by the local R2 emulation, so this test
 * injects a narrow work-store adapter that performs the same immutable bytes
 * against the real Miniflare WORK_BUCKET with plain put + exact digest/size
 * readback. Production code is untouched; D1 Search activation, projector
 * output, and terminal settlement remain the existing implementation.
 */

function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer)));
}

/** Test-only Miniflare R2 work adapter: immutable bytes + exact readback. */
function miniflareWorkStore(bucket: R2Bucket) {
  return {
    async putImmutable(write: {
      readonly key: string;
      readonly body: ReadableStream<Uint8Array>;
      readonly expected_sha256: string;
      readonly expected_size_bytes: number;
      readonly content_type: string;
      readonly custom_metadata: Readonly<Record<string, string>>;
    }) {
      const bytes = new Uint8Array(await new Response(write.body).arrayBuffer());
      if (bytes.byteLength !== write.expected_size_bytes) {
        throw new Error(`work byte size mismatch for ${write.key}`);
      }
      const digest = await sha256Hex(bytes);
      if (digest !== write.expected_sha256) {
        throw new Error(`work digest mismatch for ${write.key}`);
      }
      const metadata = {
        ...write.custom_metadata,
        eliotr_sha256: write.expected_sha256,
        eliotr_size_bytes: String(write.expected_size_bytes),
        eliotr_immutable: "true",
      };
      const existing = await bucket.get(write.key);
      if (existing !== null) {
        const existingBytes = new Uint8Array(await existing.arrayBuffer());
        if ((await sha256Hex(existingBytes)) !== write.expected_sha256) {
          throw new Error(`immutable work conflict for ${write.key}`);
        }
        return {
          key: write.key,
          expected_sha256: write.expected_sha256,
          readback_sha256: write.expected_sha256,
          size_bytes: existingBytes.byteLength,
          etag: existing.etag,
          existed_identically: true,
        };
      }
      const created = await bucket.put(write.key, bytes, {
        httpMetadata: { contentType: write.content_type },
        customMetadata: metadata,
      });
      if (created === null || created === undefined) throw new Error(`work put failed for ${write.key}`);
      const back = await bucket.get(write.key);
      if (back === null) throw new Error(`work readback missing for ${write.key}`);
      const backBytes = new Uint8Array(await back.arrayBuffer());
      if ((await sha256Hex(backBytes)) !== write.expected_sha256) {
        throw new Error(`work readback digest mismatch for ${write.key}`);
      }
      return {
        key: write.key,
        expected_sha256: write.expected_sha256,
        readback_sha256: write.expected_sha256,
        size_bytes: backBytes.byteLength,
        etag: back.etag,
        existed_identically: false,
      };
    },
  };
}

interface Migration {
  readonly name: string;
  readonly queries: string[];
}

const runtime = env as unknown as Env & {
  readonly CORE_MIGRATIONS: Migration[];
  readonly SEARCH_MIGRATIONS: Migration[];
};
const db = runtime.CORE_DB;
const searchDb = runtime.SEARCH_DB;
const owner = "q1-ident-lex-owner";
const A = "a".repeat(64);

let namespace = "";
let revision = "";

const transport: ImportTransport = async (path, init) => {
  const request = new Request(`https://research.example${path}`, init);
  const response = await handleHttp(
    request,
    runtime,
    {} as ExecutionContext,
    {
      accessVerifier: {
        async verify() {
          return {
            principal_ref: owner,
            credential_generation: "credential-1",
            authentication_method: "cloudflare_access",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          };
        },
      },
    },
  );
  const value: unknown = await response.json();
  if (!response.ok) throw decodeApiProblem(value, response.status);
  return value;
};

async function setupPolicy(): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision," +
        "owner_system_id,owner_incarnation_ref,source_owner_generation," +
        "source_admission_policy_revision,status,created_at) VALUES (?1,1,?2,?3,?4,1,'ACTIVE',?5)",
    )
    .bind(namespace, "fixture-owner", "incarnation-1", "owner-generation-1", now)
    .run();
  await db
    .prepare(
      "INSERT INTO source_admission_policy VALUES (?1,1,?2,?3,'document','QUALIFIED'," +
        "'DATA_ONLY','READ_ONLY',?4,?5,?6,?7,?8,?9,'standard',?10)",
    )
    .bind(
      namespace,
      JSON.stringify([owner]),
      '["immutable_import"]',
      '["research"]',
      "owner-only",
      "license-1",
      "NORMALIZED_CLOUD_ONLY",
      "residency-1",
      "retention-1",
      now,
    )
    .run();
}

async function importBundle() {
  const fixture = await bundleFixture();
  const manifest = {
    ...fixture.manifest,
    origin: {
      ...fixture.manifest.origin,
      source_namespace_id: namespace,
      source_revision_ref: revision,
    },
    source: { ...fixture.manifest.source, logical_id: `source-${namespace}` },
  };
  const { sha256Utf8 } = await import("@eliotr/platform-cloudflare");
  const bytes = JSON.stringify(manifest);
  const content = fixture.files["content.md"];
  if (content === undefined) throw new Error("Missing fixture content");
  const bundle = await prepareBrowserBundle([
    { path: "content.md", blob: new Blob([new Uint8Array(content)]) },
    { path: "manifest.json", blob: new Blob([new TextEncoder().encode(bytes)]) },
    {
      path: "hashes.sha256",
      blob: new Blob([
        `${manifest.content.markdown_sha256}  content.md\n${await sha256Utf8(bytes)}  manifest.json\n`,
      ]),
    },
  ]);
  return importBrowserBundle(bundle, `q1-${namespace}`, { transport });
}

function scopeFor(revisions: readonly string[]): ScopeSnapshot {
  const now = Date.now();
  const ownerGenerations: Record<string, string> = {};
  for (const ref of revisions) ownerGenerations[ref] = "owner-generation-1";
  return {
    snapshot_id: `snapshot-${namespace}`,
    revision: 1,
    resolved_scope_expression: { kind: "GLOBAL_LIBRARY" },
    participant_generations: {},
    member_source_revision_refs: [...revisions],
    source_owner_generations: ownerGenerations,
    policy_authority_ref: "policy-authority-1",
    disclosure_closure_digest: A,
    purge_ledger_revision: 0,
    digest: A,
    created_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 3_600_000).toISOString(),
  };
}

function laneRequest(
  rawQuery: string,
  scope: ScopeSnapshot,
  requestedLimit: number,
): RetrievalRequest {
  return {
    raw_query: rawQuery,
    product: "FAST_SEARCH",
    scope_snapshot: scope,
    policy: {} as never,
    literals: [],
    requested_limit: requestedLimit,
    deadline_ms: 5_000,
  };
}

async function importAndProject() {
  const receipt = await importBundle();
  expect(receipt?.decision).toBe("ADMITTED");
  const store = createD1OutboxStore(db);
  const leases = await store.claimBatch({
    worker_id: "q1-dispatcher",
    now_ms: Date.now(),
    lease_ms: 45_000,
    limit: 10,
  });
  expect(leases).toHaveLength(1);
  const lease = leases[0];
  if (lease === undefined) throw new Error("Missing outbox lease");
  const message = messageFromLease(lease);
  expect(message.payload_ref).toBe(revision);
  await store.markDelivered(
    lease,
    { queue_message_ref: message.message_id, accepted_at_ms: Date.now() },
    Date.now(),
  );
  const context = {
    message_id: message.message_id,
    idempotency_key: message.idempotency_key,
    topic: message.topic,
    attempt: 1,
  };
  const accept = createProjectionDeliveryHandler(db);
  const accepted = await accept(message, context);
  const executor = createProjectionExecutionHandler({
    authority: createD1ProjectionAuthority({ database: db }),
    content: createR2ProjectionContentPort({ evidence_bucket: runtime.EVIDENCE_BUCKET }),
    work: createR2ProjectionWorkPort({
      work_bucket: runtime.WORK_BUCKET,
      object_store: miniflareWorkStore(runtime.WORK_BUCKET) as never,
    }),
    search: createD1ProjectionSearchPort(searchDb),
    managed: {
      index: async () => ({
        state: "DEGRADED" as const,
        item_count: 1,
        instance_id: PROJECTION_EXECUTION_PROFILE.managed_instance_id,
        managed_generation: PROJECTION_EXECUTION_PROFILE.managed_generation,
        reason_codes: ["MANAGED_INDEX_READBACK_FAILED"],
      }),
    },
    leases: createD1ExecutionLeaseStore(db),
    profile: PROJECTION_EXECUTION_PROFILE,
  });
  const first = await executor.execute(message);
  // Transport completion (ACCEPTED) and terminal completion are separate.
  expect(first.receipt_ref).toMatch(/^receipt:/u);
  expect(first.receipt_ref).not.toBe(accepted.receipt_ref);
  const second = await executor.execute(message);
  expect(second).toEqual(first);
  const duplicateAccept = await accept(message, context);
  // After terminal settlement the acceptor reconciles to the acknowledging
  // terminal receipt instead of the earlier ACCEPTED receipt.
  expect(duplicateAccept).toEqual({ receipt_ref: first.receipt_ref });
  const revisionCount = await db
    .prepare("SELECT COUNT(*) AS n FROM source_revision WHERE source_revision_ref = ?1")
    .bind(revision)
    .first<{ readonly n: number }>();
  expect(revisionCount?.n).toBe(1);
  const item = await searchDb
    .prepare(
      "SELECT item_key, canonical_section_id, content_sha256 FROM projection_item " +
        "WHERE source_revision_ref = ?1 AND active = 1 LIMIT 1",
    )
    .bind(revision)
    .first<{ readonly item_key: string; readonly canonical_section_id: string; readonly content_sha256: string }>();
  if (item === null) throw new Error("Missing projected item");
  return { message, execReceipt: first, item };
}

beforeEach(async () => {
  await applyD1Migrations(db, runtime.CORE_MIGRATIONS);
  await applyD1Migrations(searchDb, runtime.SEARCH_MIGRATIONS);
  const id = crypto.randomUUID();
  namespace = `q1-${id}`;
  revision = `rev-${id}`;
  await setupPolicy();
});

describe("Q1 import-fed D1 IDENT/LEX lane", () => {
  it("replays duplicate delivery without a second canonical revision", async () => {
    const { execReceipt } = await importAndProject();
    expect(execReceipt.receipt_ref).toMatch(/^receipt:/u);
    const outboxCount = await db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE payload_ref = ?1")
      .bind(revision)
      .first<{ readonly n: number }>();
    expect(outboxCount?.n).toBe(1);
  });

  it("returns the admitted candidate and keeps FTS injection literal", async () => {
    const { item } = await importAndProject();
    const scope = scopeFor([revision]);
    const ident = createD1SearchIdentPort({ search_database: searchDb, core_database: db });
    const lex = createD1SearchLexPort({ search_database: searchDb, core_database: db });
    const identHits = await ident.lookupIdentifiers(laneRequest(item.item_key, scope, 10));
    expect(identHits).toHaveLength(1);
    expect(identHits[0]).toMatchObject({
      lane: "IDENT",
      source_revision_ref: revision,
      canonical_section_id: item.canonical_section_id,
      preview: "",
    });
    expect(identHits[0]?.index_generation).toMatch(/^projection-/u);
    const lexHits = await lex.search(laneRequest("Pinned", scope, 10), "LEX");
    expect(lexHits.length).toBeGreaterThanOrEqual(1);
    expect(lexHits[0]?.source_revision_ref).toBe(revision);
    expect(lexHits[0]?.preview).toBe("");
    const watermarkBefore = await searchDb
      .prepare(
        "SELECT state, projection_generation, readback_receipt_ref FROM projection_watermark " +
          "WHERE channel = ?1 AND source_revision_ref = ?2 LIMIT 1",
      )
      .bind("lexical", revision)
      .first<{ readonly state: string; readonly projection_generation: string; readonly readback_receipt_ref: string }>();
    const injected = await lex.search(
      laneRequest('Pinned" OR "1"="1', scope, 10),
      "LEX",
    );
    expect(injected).toEqual([]);
    const star = await lex.search(laneRequest("OR *", scope, 10), "LEX");
    expect(star).toEqual([]);
    const watermarkAfter = await searchDb
      .prepare(
        "SELECT state, projection_generation, readback_receipt_ref FROM projection_watermark " +
          "WHERE channel = ?1 AND source_revision_ref = ?2 LIMIT 1",
      )
      .bind("lexical", revision)
      .first<{ readonly state: string; readonly projection_generation: string; readonly readback_receipt_ref: string }>();
    expect(watermarkAfter).toEqual(watermarkBefore);
  });

  it("distinguishes unavailable, incomplete, and valid-empty from a hit", async () => {
    const { item } = await importAndProject();
    const ident = createD1SearchIdentPort({ search_database: searchDb, core_database: db });
    const lex = createD1SearchLexPort({ search_database: searchDb, core_database: db });
    await expect(
      ident.lookupIdentifiers(laneRequest(item.item_key, scopeFor(["foreign-revision-1"]), 10)),
    ).rejects.toMatchObject({ code: "SEARCH_UNAVAILABLE" });
    await expect(
      ident.lookupIdentifiers(laneRequest(item.item_key, scopeFor([revision, "foreign-revision-1"]), 10)),
    ).rejects.toMatchObject({ code: "SEARCH_INCOMPLETE" });
    await searchDb
      .prepare(
        "UPDATE projection_watermark SET state = 'STALE' WHERE channel = ?1 AND source_revision_ref = ?2",
      )
      .bind("exact", revision)
      .run();
    await expect(
      ident.lookupIdentifiers(laneRequest(item.item_key, scopeFor([revision]), 10)),
    ).rejects.toMatchObject({ code: "SEARCH_INCOMPLETE" });
    await searchDb
      .prepare(
        "UPDATE projection_watermark SET state = 'READY' WHERE channel = ?1 AND source_revision_ref = ?2",
      )
      .bind("exact", revision)
      .run();
    const empty = await lex.search(laneRequest("missing-term-xyz-absent", scopeFor([revision]), 10), "LEX");
    expect(empty).toEqual([]);
    const hit = await lex.search(laneRequest("Pinned", scopeFor([revision]), 10), "LEX");
    expect(hit.length).toBeGreaterThanOrEqual(1);
    const registry = {
      executorFor: (lane: string) =>
        lane === "IDENT"
          ? createIdentLaneExecutor(ident)
          : lane === "LEX"
            ? createLexLaneExecutor(lex)
            : null,
    };
    const plan = compileQueryPlan(
      laneRequest("Pinned", scopeFor([revision]), 10),
    );
    const receipts = await executePlannedLanes(plan, laneRequest("Pinned", scopeFor([revision]), 10), registry as never);
    const byLane = new Map(receipts.map((receipt) => [receipt.lane, receipt]));
    expect(byLane.get("IDENT")?.disposition).toBe("EXECUTED");
    expect(byLane.get("LEX")?.disposition).toBe("EXECUTED");
    expect(byLane.get("EXACT")?.disposition).toBe("SKIPPED_UNAVAILABLE");
    const missingPlan = compileQueryPlan(
      laneRequest("Pinned", scopeFor(["foreign-revision-1"]), 10),
    );
    const missingReceipts = await executePlannedLanes(
      missingPlan,
      laneRequest("Pinned", scopeFor(["foreign-revision-1"]), 10),
      registry as never,
    );
    expect(
      missingReceipts.find((receipt) => receipt.lane === "IDENT")?.disposition,
    ).toBe("SKIPPED_UNAVAILABLE");
  });

  it("excludes purged and foreign revisions and enforces bounds with readback", async () => {
    const { item } = await importAndProject();
    const ident = createD1SearchIdentPort({ search_database: searchDb, core_database: db });
    const lex = createD1SearchLexPort({ search_database: searchDb, core_database: db });
    const scope = scopeFor([revision]);
    await db
      .prepare("UPDATE source_revision SET purge_state = 'QUARANTINED' WHERE source_revision_ref = ?1")
      .bind(revision)
      .run();
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, scope, 10))).resolves.toEqual([]);
    await expect(lex.search(laneRequest("Pinned", scope, 10), "LEX")).resolves.toEqual([]);
    await db
      .prepare("UPDATE source_revision SET purge_state = 'LIVE' WHERE source_revision_ref = ?1")
      .bind(revision)
      .run();
    const restored = await ident.lookupIdentifiers(laneRequest(item.item_key, scope, 10));
    expect(restored).toHaveLength(1);
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, scope, 50))).resolves.toHaveLength(1);
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, scope, 51))).rejects.toMatchObject({
      code: "SEARCH_INPUT_INVALID",
    });
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, scope, 0))).rejects.toMatchObject({
      code: "SEARCH_INPUT_INVALID",
    });
    const original = await searchDb
      .prepare("SELECT content_sha256 FROM projection_item WHERE item_key = ?1 LIMIT 1")
      .bind(item.item_key)
      .first<{ readonly content_sha256: string }>();
    await searchDb
      .prepare("UPDATE projection_item SET content_sha256 = ?1 WHERE item_key = ?2")
      .bind("z".repeat(64), item.item_key)
      .run();
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, scope, 10))).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
    await searchDb
      .prepare("UPDATE projection_item SET content_sha256 = ?1 WHERE item_key = ?2")
      .bind(original?.content_sha256, item.item_key)
      .run();
    const readback = await ident.lookupIdentifiers(laneRequest(item.item_key, scope, 10));
    expect(readback).toHaveLength(1);
    const watermark = await searchDb
      .prepare(
        "SELECT state, projection_generation, readback_receipt_ref FROM projection_watermark " +
          "WHERE channel = ?1 AND source_revision_ref = ?2 LIMIT 1",
      )
      .bind("exact", revision)
      .first<{ readonly state: string }>();
    expect(watermark?.state).toBe("READY");
  });
});
