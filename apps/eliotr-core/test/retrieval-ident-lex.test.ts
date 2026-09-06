import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createD1OutboxStore,
  type OutboxLease,
  type OutboxStore,
  type QueueSendReceipt,
} from "@eliotr/platform-cloudflare";
import {
  createD1SearchIdentPort,
  createD1SearchLexPort,
} from "@eliotr/cloudflare-projection";
import {
  compileQueryPlan,
  createIdentLaneExecutor,
  createLexLaneExecutor,
  executePlannedLanes,
} from "@eliotr/retrieval";
import {
  createQ1Consumer,
  createQ1Dispatcher,
  importAndProject,
  importQ1Bundle,
  laneRequest,
  prepareQ1Namespace,
  scopeFor,
  type Q1Namespace,
  type Q1Runtime,
} from "./retrieval-q1-fixture.js";

/**
 * Q1 narrow proof: real HTTP import -> production outbox dispatcher ->
 * production Queue consumer (inbox fence) -> production projection
 * delivery + projector + D1 Search activation -> IDENT/LEX lane.
 *
 * Miniflare emulation notes: the production R2 conditional write (put with
 * `onlyIf` + `sha256`) is rejected by the local R2 emulation, so the
 * fixture injects a narrow work-store adapter that performs the same
 * immutable bytes against the real Miniflare WORK_BUCKET with plain put +
 * exact digest/size readback. Likewise the Queue transport hop is captured
 * and redelivered explicitly (local cron/Queue delivery is absent). The
 * dispatcher, consumer, inbox fence, handlers, and projector are production
 * code; no claim/send/settle step is reimplemented.
 */

const runtime = env as unknown as Q1Runtime;
const db = runtime.CORE_DB;
const searchDb = runtime.SEARCH_DB;

let world: Q1Namespace;

beforeEach(async () => {
  const owner = "q1-ident-lex-owner";
  world = { db, searchDb, runtime, owner, ...(await prepareQ1Namespace(runtime, db, searchDb, owner)) };
});

describe("Q1 import-fed D1 IDENT/LEX lane", () => {
  it("projects through the production outbox/queue path without duplicate canonical work", async () => {
    const { message, receiptRef, dispatcher, pipeline } = await importAndProject(world);
    expect(message.payload_ref).toBe(world.revision);
    // Transport completion (ACCEPTED) and terminal completion stay separate:
    // the terminal receipt below is the projector settlement, and a second
    // Queue delivery of the same envelope deduplicates at the inbox fence.
    const duplicate = await pipeline.consume(message);
    expect(duplicate.result.disposition).toBe("DUPLICATE_ACKNOWLEDGED");
    expect(duplicate.result.receipt_ref).toBe(receiptRef);
    expect(duplicate.events).toEqual(["ack"]);
    expect(pipeline.invocations()).toBe(1);
    const settled = await dispatcher.dispatch();
    expect(settled.claimed).toBe(0);
  });

  it("replays a lost delivered ACK with the same idempotency and deduplicates at the consumer", async () => {
    await importQ1Bundle(world);
    const base = createD1OutboxStore(world.db);
    let lostAcks = 0;
    const flaky: OutboxStore = {
      ...base,
      async markDelivered(
        lease: OutboxLease,
        receipt: QueueSendReceipt,
        settledAtMs: number,
      ): Promise<void> {
        lostAcks += 1;
        // The Queue already holds the message; only the D1 delivery ACK is
        // lost. The dispatcher must report uncertainty without inventing a
        // replacement identity.
        if (lostAcks === 1) throw new Error("simulated lost delivered ACK");
        return base.markDelivered(lease, receipt, settledAtMs);
      },
    };
    const dispatcher = createQ1Dispatcher(world.db, flaky);
    const uncertain = await dispatcher.dispatch();
    expect(uncertain).toMatchObject({ claimed: 1, delivered: 0, uncertain_settlements: 1 });
    expect(dispatcher.sent).toHaveLength(1);
    dispatcher.advanceMs(6_000);
    const recovered = await dispatcher.dispatch();
    expect(recovered).toMatchObject({ claimed: 1, delivered: 1, uncertain_settlements: 0 });
    expect(dispatcher.sent).toHaveLength(2);
    const [firstSend, secondSend] = dispatcher.sent;
    if (firstSend === undefined || secondSend === undefined) throw new Error("Missing dispatched messages");
    expect(firstSend.payload_ref).toBe(world.revision);
    expect(secondSend.idempotency_key).toBe(firstSend.idempotency_key);
    expect(secondSend.message_id).not.toBe(firstSend.message_id);
    const pipeline = createQ1Consumer(world);
    const first = await pipeline.consume(firstSend);
    expect(first.result.disposition).toBe("COMPLETED");
    const firstReceipt = first.result.receipt_ref;
    if (firstReceipt === undefined) throw new Error("Missing terminal projection receipt");
    const second = await pipeline.consume(secondSend);
    expect(second.result.disposition).toBe("DUPLICATE_ACKNOWLEDGED");
    expect(second.result.receipt_ref).toBe(firstReceipt);
    expect(pipeline.invocations()).toBe(1);
    const revisionCount = await world.db
      .prepare("SELECT COUNT(*) AS n FROM source_revision WHERE source_revision_ref = ?1")
      .bind(world.revision)
      .first<{ readonly n: number }>();
    expect(revisionCount?.n).toBe(1);
  });

  it("returns the admitted candidate and keeps FTS injection literal", async () => {
    const { item } = await importAndProject(world);
    const scope = scopeFor(world.namespace, [world.revision]);
    const ident = createD1SearchIdentPort({ search_database: searchDb, core_database: db });
    const lex = createD1SearchLexPort({ search_database: searchDb, core_database: db });
    const identHits = await ident.lookupIdentifiers(laneRequest(item.item_key, scope, 10));
    expect(identHits).toHaveLength(1);
    expect(identHits[0]).toMatchObject({
      lane: "IDENT",
      source_revision_ref: world.revision,
      canonical_section_id: item.canonical_section_id,
      preview: "",
    });
    expect(identHits[0]?.index_generation).toMatch(/^projection-/u);
    const lexHits = await lex.search(laneRequest("Pinned", scope, 10), "LEX");
    expect(lexHits.length).toBeGreaterThanOrEqual(1);
    expect(lexHits[0]?.source_revision_ref).toBe(world.revision);
    expect(lexHits[0]?.preview).toBe("");
    const watermarkBefore = await searchDb
      .prepare(
        "SELECT state, projection_generation, readback_receipt_ref FROM projection_watermark " +
          "WHERE channel = ?1 AND source_revision_ref = ?2 LIMIT 1",
      )
      .bind("lexical", world.revision)
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
      .bind("lexical", world.revision)
      .first<{ readonly state: string; readonly projection_generation: string; readonly readback_receipt_ref: string }>();
    expect(watermarkAfter).toEqual(watermarkBefore);
  });

  it("distinguishes unavailable, incomplete, and valid-empty from a hit", async () => {
    const { item } = await importAndProject(world);
    const ident = createD1SearchIdentPort({ search_database: searchDb, core_database: db });
    const lex = createD1SearchLexPort({ search_database: searchDb, core_database: db });
    await expect(
      ident.lookupIdentifiers(laneRequest(item.item_key, scopeFor(world.namespace, ["foreign-revision-1"]), 10)),
    ).rejects.toMatchObject({ code: "SEARCH_UNAVAILABLE" });
    await expect(
      ident.lookupIdentifiers(laneRequest(item.item_key, scopeFor(world.namespace, [world.revision, "foreign-revision-1"]), 10)),
    ).rejects.toMatchObject({ code: "SEARCH_INCOMPLETE" });
    await searchDb
      .prepare(
        "UPDATE projection_watermark SET state = 'STALE' WHERE channel = ?1 AND source_revision_ref = ?2",
      )
      .bind("exact", world.revision)
      .run();
    await expect(
      ident.lookupIdentifiers(laneRequest(item.item_key, scopeFor(world.namespace, [world.revision]), 10)),
    ).rejects.toMatchObject({ code: "SEARCH_INCOMPLETE" });
    await searchDb
      .prepare(
        "UPDATE projection_watermark SET state = 'READY' WHERE channel = ?1 AND source_revision_ref = ?2",
      )
      .bind("exact", world.revision)
      .run();
    const empty = await lex.search(laneRequest("missing-term-xyz-absent", scopeFor(world.namespace, [world.revision]), 10), "LEX");
    expect(empty).toEqual([]);
    const hit = await lex.search(laneRequest("Pinned", scopeFor(world.namespace, [world.revision]), 10), "LEX");
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
      laneRequest("Pinned", scopeFor(world.namespace, [world.revision]), 10),
    );
    const receipts = await executePlannedLanes(plan, laneRequest("Pinned", scopeFor(world.namespace, [world.revision]), 10), registry as never);
    const byLane = new Map(receipts.map((receipt) => [receipt.lane, receipt]));
    expect(byLane.get("IDENT")?.disposition).toBe("EXECUTED");
    expect(byLane.get("LEX")?.disposition).toBe("EXECUTED");
    expect(byLane.get("EXACT")?.disposition).toBe("SKIPPED_UNAVAILABLE");
    const missingPlan = compileQueryPlan(
      laneRequest("Pinned", scopeFor(world.namespace, ["foreign-revision-1"]), 10),
    );
    const missingReceipts = await executePlannedLanes(
      missingPlan,
      laneRequest("Pinned", scopeFor(world.namespace, ["foreign-revision-1"]), 10),
      registry as never,
    );
    expect(
      missingReceipts.find((receipt) => receipt.lane === "IDENT")?.disposition,
    ).toBe("SKIPPED_UNAVAILABLE");
  });

  it("checks scope authority before any valid-empty read", async () => {
    const { item } = await importAndProject(world);
    const ident = createD1SearchIdentPort({ search_database: searchDb, core_database: db });
    const lex = createD1SearchLexPort({ search_database: searchDb, core_database: db });
    const live = scopeFor(world.namespace, [world.revision]);
    const expired = { ...live, expires_at: new Date(Date.now() - 1_000).toISOString() };
    const emptyMembers = { ...live, member_source_revision_refs: [], source_owner_generations: {} };
    const expiredEmpty = { ...expired, member_source_revision_refs: [], source_owner_generations: {} };
    // Expired scope is never masked by non-matching input or empty membership.
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, expired, 10))).rejects.toMatchObject({
      code: "SEARCH_UNAVAILABLE",
    });
    await expect(ident.lookupIdentifiers(laneRequest("!!!not-an-identifier!!!", expired, 10))).rejects.toMatchObject({
      code: "SEARCH_UNAVAILABLE",
    });
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, expiredEmpty, 10))).rejects.toMatchObject({
      code: "SEARCH_UNAVAILABLE",
    });
    await expect(lex.search(laneRequest("Pinned", expired, 10), "LEX")).rejects.toMatchObject({
      code: "SEARCH_UNAVAILABLE",
    });
    await expect(lex.search(laneRequest("Pinned", expiredEmpty, 10), "LEX")).rejects.toMatchObject({
      code: "SEARCH_UNAVAILABLE",
    });
    // A foreign scope is not masked by non-matching IDENT input either.
    await expect(
      ident.lookupIdentifiers(laneRequest("!!!not-an-identifier!!!", scopeFor(world.namespace, ["foreign-revision-1"]), 10)),
    ).rejects.toMatchObject({ code: "SEARCH_UNAVAILABLE" });
    // With authority proven, non-matching input and empty membership stay valid-empty.
    await expect(ident.lookupIdentifiers(laneRequest("!!!not-an-identifier!!!", live, 10))).resolves.toEqual([]);
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, emptyMembers, 10))).resolves.toEqual([]);
    await expect(lex.search(laneRequest("Pinned", emptyMembers, 10), "LEX")).resolves.toEqual([]);
  });

  it("excludes purged revisions and enforces bounds with readback", async () => {
    const { item } = await importAndProject(world);
    const ident = createD1SearchIdentPort({ search_database: searchDb, core_database: db });
    const lex = createD1SearchLexPort({ search_database: searchDb, core_database: db });
    const scope = scopeFor(world.namespace, [world.revision]);
    await db
      .prepare("UPDATE source_revision SET purge_state = 'QUARANTINED' WHERE source_revision_ref = ?1")
      .bind(world.revision)
      .run();
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, scope, 10))).resolves.toEqual([]);
    await expect(lex.search(laneRequest("Pinned", scope, 10), "LEX")).resolves.toEqual([]);
    await db
      .prepare("UPDATE source_revision SET purge_state = 'LIVE' WHERE source_revision_ref = ?1")
      .bind(world.revision)
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
      .bind("exact", world.revision)
      .first<{ readonly state: string }>();
    expect(watermark?.state).toBe("READY");
  });
});
