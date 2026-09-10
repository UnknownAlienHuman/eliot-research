import { applyD1Migrations } from "cloudflare:test";
import { expect } from "vitest";
import {
  createD1ExecutionLeaseStore,
  createD1InboxStore,
  createD1OutboxStore,
  createOutboxDispatcher,
  createQueueConsumerRuntime,
  type DeliveryHandler,
  type DeliveryHandlerContext,
  type DeliveryMessage,
  type OutboxDispatchSummary,
  type OutboxStore,
  type QueueConsumptionResult,
  type QueueDelivery,
} from "@eliotr/platform-cloudflare";
import {
  createD1ProjectionAuthority,
  createD1ProjectionSearchPort,
  createProjectionDeliveryHandler,
  createProjectionExecutionHandler,
  createR2ProjectionContentPort,
  createR2ProjectionWorkPort,
} from "@eliotr/cloudflare-projection";
import type { ScopeSnapshot } from "@eliotr/contracts";
import type { RetrievalRequest } from "@eliotr/retrieval";
import { bundleFixture } from "../../../packages/platform-cloudflare/src/ingest-test-fixture.js";
import { prepareBrowserBundle } from "../../eliotr-pwa/src/bundle-input.js";
import { importBrowserBundle } from "../../eliotr-pwa/src/bundle-import.js";
import type { ImportTransport } from "../../eliotr-pwa/src/bundle-import-api.js";
import { decodeApiProblem } from "../../eliotr-pwa/src/api.js";
import { handleHttp } from "../src/http.js";
import { PROJECTION_EXECUTION_PROFILE } from "../src/projection-execution-handler.js";
import type { Env } from "../src/env.js";

export interface Q1Migration {
  readonly name: string;
  readonly queries: string[];
}

export type Q1Runtime = Env & {
  readonly CORE_MIGRATIONS: Q1Migration[];
  readonly SEARCH_MIGRATIONS: Q1Migration[];
};

export interface Q1Namespace {
  readonly db: D1Database;
  readonly searchDb: D1Database;
  readonly runtime: Q1Runtime;
  readonly owner: string;
  readonly namespace: string;
  readonly revision: string;
}

export interface Q1ProjectedItem {
  readonly item_key: string;
  readonly canonical_section_id: string;
  readonly content_sha256: string;
}

const FIXTURE_DIGEST = "a".repeat(64);

function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer)));
}

/** Test-only Miniflare R2 work adapter: immutable bytes + exact readback. */
export function miniflareWorkStore(bucket: R2Bucket) {
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
        customMetadata: {
          ...write.custom_metadata,
          eliotr_sha256: write.expected_sha256,
          eliotr_size_bytes: String(write.expected_size_bytes),
          eliotr_immutable: "true",
        },
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

export function q1Transport(runtime: Q1Runtime, owner: string): ImportTransport {
  return async (path, init) => {
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
}

export async function prepareQ1Namespace(
  runtime: Q1Runtime,
  db: D1Database,
  searchDb: D1Database,
  owner: string,
): Promise<{ readonly namespace: string; readonly revision: string }> {
  await applyD1Migrations(db, runtime.CORE_MIGRATIONS);
  await applyD1Migrations(searchDb, runtime.SEARCH_MIGRATIONS);
  const id = crypto.randomUUID();
  const namespace = `q1-${id}`;
  const revision = `rev-${id}`;
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
  return { namespace, revision };
}

export interface Q1ImportOptions {
  readonly native_coordinate_map?: boolean;
}

export async function importQ1Bundle(
  world: Q1Namespace,
  options: Q1ImportOptions = {},
): Promise<void> {
  const { namespace, revision, runtime, owner } = world;
  const fixture = await bundleFixture();
  const native = options.native_coordinate_map === true;
  const nativeMarkdown = "# Evidence\n\n| Key | Value |\n| --- | --- |\n| A | B |\n";
  const nativeContent = new TextEncoder().encode(nativeMarkdown);
  const manifest = {
    ...fixture.manifest,
    origin: {
      ...fixture.manifest.origin,
      source_namespace_id: namespace,
      source_revision_ref: revision,
    },
    source: { ...fixture.manifest.source, logical_id: `source-${namespace}` },
    capabilities: { ...fixture.manifest.capabilities, tables: native },
  };
  const { sha256Utf8 } = await import("@eliotr/platform-cloudflare");
  const content = native ? nativeContent : fixture.files["content.md"];
  if (content === undefined) throw new Error("Missing fixture content");
  const contentDigest = await sha256Hex(content);
  const normalizedManifest = {
    ...manifest,
    source: { ...manifest.source, original_sha256: contentDigest },
    content: { ...manifest.content, markdown_sha256: contentDigest },
  };
  const marker = new TextEncoder().encode("| B |");
  const markerOffset = content.findIndex((_, index) => marker.every((value, markerIndex) => content[index + markerIndex] === value));
  if (native && markerOffset < 0) throw new Error("native table fixture marker is missing");
  const cellStart = markerOffset + 2;
  const cellEnd = cellStart + 1;
  const cellBytes = content.slice(cellStart, cellEnd);
  const map = native ? {
    protocol: "eliotr.coordinate-map.v1",
    source_owner_system_id: normalizedManifest.origin.owner_system_id,
    source_namespace_id: normalizedManifest.origin.source_namespace_id,
    source_owner_generation: normalizedManifest.origin.source_owner_generation,
    source_logical_id: normalizedManifest.source.logical_id,
    source_revision_ref: normalizedManifest.origin.source_revision_ref,
    source_content_sha256: contentDigest,
    normalized_content_path: "content.md",
    precision_ceiling: "table_cell",
    generator_generation: "coordinate-map-q1-v1",
    created_at: normalizedManifest.normalization.created_at,
    entries: [{ anchor: { kind: "table_cell", table_id: "q1-table", row: 0, column: 1 },
      normalized_start_byte: cellStart, normalized_end_byte: cellEnd,
      excerpt_sha256: await sha256Hex(cellBytes) }],
  } : undefined;
  const mapBytes = map === undefined ? undefined : new TextEncoder().encode(JSON.stringify(map));
  const mapDigest = mapBytes === undefined ? undefined : await sha256Hex(mapBytes);
  const tablesBytes = native ? new TextEncoder().encode("[{\"table_id\":\"q1-table\",\"rows\":1,\"columns\":2}]") : undefined;
  const tablesDigest = tablesBytes === undefined ? undefined : await sha256Hex(tablesBytes);
  const manifestWithMap = mapDigest === undefined || tablesDigest === undefined
    ? normalizedManifest
    : { ...normalizedManifest, content: { ...normalizedManifest.content,
      mappings: "coordinate-map.json", tables: "tables.json", coordinate_map_digest: mapDigest } };
  const bytes = JSON.stringify(manifestWithMap);
  const manifestDigest = await sha256Utf8(bytes);
  const bundle = await prepareBrowserBundle([
    { path: "content.md", blob: new Blob([content.buffer as ArrayBuffer]) },
    { path: "manifest.json", blob: new Blob([new TextEncoder().encode(bytes).buffer as ArrayBuffer]) },
    ...(mapBytes === undefined ? [] : [{ path: "coordinate-map.json", blob: new Blob([mapBytes.buffer as ArrayBuffer]) }]),
    ...(tablesBytes === undefined ? [] : [{ path: "tables.json", blob: new Blob([tablesBytes.buffer as ArrayBuffer]) }]),
    {
      path: "hashes.sha256",
      blob: new Blob([
        `${contentDigest}  content.md\n${mapDigest === undefined ? "" : `${mapDigest}  coordinate-map.json\n`}${tablesDigest === undefined ? "" : `${tablesDigest}  tables.json\n`}${manifestDigest}  manifest.json\n`,
      ]),
    },
  ]);
  const receipt = await importBrowserBundle(bundle, `q1-${namespace}`, {
    transport: q1Transport(runtime, owner),
  });
  expect(receipt?.decision).toBe("ADMITTED");
}

export function scopeFor(namespace: string, revisions: readonly string[]): ScopeSnapshot {
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
    disclosure_closure_digest: FIXTURE_DIGEST,
    purge_ledger_revision: 0,
    digest: FIXTURE_DIGEST,
    created_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 3_600_000).toISOString(),
  };
}

export function laneRequest(
  rawQuery: string,
  scope: ScopeSnapshot,
  requestedLimit: number,
): RetrievalRequest {
  return {
    raw_query: rawQuery,
    product: "FAST_SEARCH",
    scope_snapshot: scope,
    literals: [],
    requested_limit: requestedLimit,
    deadline_ms: 5_000,
  };
}

export interface Q1Dispatcher {
  readonly sent: DeliveryMessage[];
  readonly dispatch: () => Promise<OutboxDispatchSummary>;
  readonly advanceMs: (deltaMs: number) => void;
}

/**
 * Production outbox dispatcher. The send step mirrors
 * apps/eliotr-core/src/scheduled.ts (env.JOB_QUEUE.send); Miniflare offers
 * no local Queue delivery, so the exact stable envelope is captured for
 * explicit delivery to the production consumer runtime below. No
 * claim/send/settle step is reimplemented.
 */
export function createQ1Dispatcher(
  db: D1Database,
  store: OutboxStore = createD1OutboxStore(db),
  startMs: number = Date.now(),
): Q1Dispatcher {
  const sent: DeliveryMessage[] = [];
  let nowMs = startMs;
  const dispatcher = createOutboxDispatcher(
    store,
    {
      async send(message: DeliveryMessage) {
        sent.push(message);
        return { queue_message_ref: message.message_id, accepted_at_ms: nowMs };
      },
    },
    {
      worker_id: "q1-outbox-dispatcher",
      lease_ms: 5_000,
      batch_limit: 10,
      maximum_attempts: 10,
      retry_base_ms: 5_000,
      retry_maximum_ms: 15 * 60_000,
      now: () => nowMs,
    },
  );
  return {
    sent,
    dispatch: () => dispatcher.dispatch(),
    advanceMs: (deltaMs: number) => {
      nowMs += deltaMs;
    },
  };
}

export interface Q1Consumer {
  readonly consume: (
    message: DeliveryMessage,
  ) => Promise<{ readonly result: QueueConsumptionResult; readonly events: string[] }>;
  readonly invocations: () => number;
}

/**
 * Production queue consumer plus the production handler composition from
 * apps/eliotr-core/src/queue.ts (delivery acceptance, then projection
 * execution). Only the R2 work port uses the documented Miniflare immutable
 * emulation; dispatcher, inbox fence, handlers, and projector are production.
 */
export function createQ1Consumer(world: Q1Namespace): Q1Consumer {
  const { db, runtime } = world;
  const consumer = createQueueConsumerRuntime(createD1InboxStore(db), {
    worker_id: "q1-queue-consumer",
    lease_ms: 60_000,
    maximum_attempts: 10_000,
    retry_base_ms: 5_000,
    retry_maximum_ms: 5 * 60_000,
  });
  const accept = createProjectionDeliveryHandler(db);
  const executor = createProjectionExecutionHandler({
    authority: createD1ProjectionAuthority({ database: db }),
    content: createR2ProjectionContentPort({ evidence_bucket: runtime.EVIDENCE_BUCKET }),
    work: createR2ProjectionWorkPort({
      work_bucket: runtime.WORK_BUCKET,
      object_store: miniflareWorkStore(runtime.WORK_BUCKET) as never,
    }),
    search: createD1ProjectionSearchPort(world.searchDb),
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
  let invocations = 0;
  const handler: DeliveryHandler = async (
    message: DeliveryMessage,
    context: DeliveryHandlerContext,
  ) => {
    invocations += 1;
    await accept(message, context);
    return executor.execute(message);
  };
  return {
    invocations: () => invocations,
    consume: async (message: DeliveryMessage) => {
      const events: string[] = [];
      const delivery: QueueDelivery = {
        body: message,
        ack() {
          events.push("ack");
        },
        retry(options) {
          events.push(`retry:${options?.delaySeconds ?? 0}`);
        },
      };
      const result = await consumer.consume(delivery, handler);
      return { result, events };
    },
  };
}

export async function readProjectedItem(
  world: Q1Namespace,
): Promise<Q1ProjectedItem> {
  const item = await world.searchDb
    .prepare(
      "SELECT item_key, canonical_section_id, content_sha256 FROM projection_item " +
        "WHERE source_revision_ref = ?1 AND active = 1 LIMIT 1",
    )
    .bind(world.revision)
    .first<Q1ProjectedItem>();
  if (item === null) throw new Error("Missing projected item");
  return item;
}

/**
 * Full production delivery path: HTTP import -> outbox dispatcher ->
 * Queue consumer (inbox fence) -> delivery acceptance -> projector.
 * Returns the consumed message, its terminal receipt, and one live item.
 */
export async function importAndProject(world: Q1Namespace, options: Q1ImportOptions = {}): Promise<{
  readonly message: DeliveryMessage;
  readonly receiptRef: string;
  readonly item: Q1ProjectedItem;
  readonly pipeline: Q1Consumer;
  readonly dispatcher: Q1Dispatcher;
}> {
  await importQ1Bundle(world, options);
  const dispatcher = createQ1Dispatcher(world.db);
  const summary = await dispatcher.dispatch();
  expect(summary).toMatchObject({ claimed: 1, delivered: 1, uncertain_settlements: 0 });
  expect(dispatcher.sent).toHaveLength(1);
  const message = dispatcher.sent[0];
  if (message === undefined) throw new Error("Missing dispatched message");
  expect(message.payload_ref).toBe(world.revision);
  const pipeline = createQ1Consumer(world);
  const first = await pipeline.consume(message);
  expect(first.result.disposition).toBe("COMPLETED");
  const receiptRef = first.result.receipt_ref;
  if (receiptRef === undefined || !/^receipt:/u.test(receiptRef)) {
    throw new Error(`Missing terminal projection receipt: ${receiptRef}`);
  }
  expect(first.events).toEqual(["ack"]);
  const revisionCount = await world.db
    .prepare("SELECT COUNT(*) AS n FROM source_revision WHERE source_revision_ref = ?1")
    .bind(world.revision)
    .first<{ readonly n: number }>();
  expect(revisionCount?.n).toBe(1);
  const outboxCount = await world.db
    .prepare("SELECT COUNT(*) AS n FROM outbox WHERE payload_ref = ?1")
    .bind(world.revision)
    .first<{ readonly n: number }>();
  expect(outboxCount?.n).toBe(1);
  return { message, receiptRef, item: await readProjectedItem(world), pipeline, dispatcher };
}
