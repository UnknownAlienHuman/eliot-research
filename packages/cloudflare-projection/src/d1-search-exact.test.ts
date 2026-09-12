/// <reference types="node" />
import assert from "node:assert/strict";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { test } from "vitest";
import type { LocatorCandidate } from "@eliotr/contracts";
import type { RetrievalRequest } from "@eliotr/retrieval";
import { projectionDigest } from "./canonical.js";
import {
  createD1SearchExactPort,
  type ExactPhraseVerifier,
} from "./d1-search-exact.js";
import {
  withSearchWorld,
  type SearchWorld,
} from "./d1-search-sqlite-fixture.js";

const incomplete = { code: "SEARCH_INCOMPLETE" };

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: SQLInputValue[]) {
          const bindings = Object.fromEntries(args.map((value, index) => [String(index + 1), value])) as Record<string, SQLInputValue>;
          return {
            async all<T>() {
              return { success: true, results: database.prepare(sql).all(bindings) as T[] };
            },
            async first<T>() {
              return (database.prepare(sql).get(bindings) ?? null) as T | null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function readOnlyVerifier(
  sections: ReadonlyMap<string, string>,
  seen: LocatorCandidate[] = [],
): ExactPhraseVerifier {
  return async (candidate, _request, probe) => {
    seen.push(candidate);
    const itemKey = candidate.metadata.item_key;
    return typeof itemKey === "string" && sections.get(itemKey)?.includes(probe) === true;
  };
}

function request(world: SearchWorld, query: string, limit = 10): RetrievalRequest {
  return world.request(query, limit) as RetrievalRequest;
}

function exactPort(
  world: SearchWorld,
  verifyExactPhrase: ExactPhraseVerifier,
) {
  return createD1SearchExactPort({
    core_database: d1(world.core),
    search_database: d1(world.search),
    now: () => world.clock.now,
    verifyExactPhrase,
  });
}

async function addActiveSections(
  world: SearchWorld,
  sourceRevisionRef: string,
  total: number,
): Promise<void> {
  const base = world.search
    .prepare(
      "SELECT p.item_key, p.canonical_section_id, p.content_sha256, p.projection_generation, " +
        "s.normalized_end_byte FROM projection_item p JOIN projection_span s ON s.item_key = p.item_key " +
        "AND s.source_revision_ref = p.source_revision_ref AND s.projection_generation = p.projection_generation " +
        "WHERE p.source_revision_ref = ? AND p.active = 1 ORDER BY s.normalized_start_byte, p.item_key LIMIT 1",
    )
    .get(sourceRevisionRef) as {
      readonly item_key: string;
      readonly canonical_section_id: string;
      readonly content_sha256: string;
      readonly projection_generation: string;
      readonly normalized_end_byte: number;
    };
  const additions = Array.from({ length: total - 1 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    const start = base.normalized_end_byte + index * 2 + 1;
    return {
      item_key: `item-${sourceRevisionRef}-extra-${suffix}`,
      canonical_section_id: `section-${sourceRevisionRef}-extra-${suffix}`,
      content_sha256: base.content_sha256,
      projection_generation: base.projection_generation,
      start,
      end: start + 1,
    };
  });
  for (const addition of additions) {
    world.search.prepare(
      "INSERT INTO projection_item VALUES (?, ?, ?, ?, ?, 1)",
    ).run(
      addition.item_key,
      sourceRevisionRef,
      addition.canonical_section_id,
      addition.content_sha256,
      addition.projection_generation,
    );
    world.search.prepare(
      "INSERT INTO projection_span VALUES (?, ?, ?, ?, ?)",
    ).run(
      addition.item_key,
      sourceRevisionRef,
      addition.projection_generation,
      addition.start,
      addition.end,
    );
  }
  const itemSetDigest = await projectionDigest([
    {
      item_key: base.item_key,
      canonical_section_id: base.canonical_section_id,
      content_sha256: base.content_sha256,
      start: 0,
      end: base.normalized_end_byte,
    },
    ...additions.map((addition) => ({
      item_key: addition.item_key,
      canonical_section_id: addition.canonical_section_id,
      content_sha256: addition.content_sha256,
      start: addition.start,
      end: addition.end,
    })),
  ]);
  world.search.prepare(
    "UPDATE projection_generation_receipt SET item_count = ?, item_set_digest = ? " +
      "WHERE source_revision_ref = ? AND projection_generation = ?",
  ).run(total, itemSetDigest, sourceRevisionRef, base.projection_generation);
  world.search.prepare(
    "UPDATE projection_activation_guard SET item_count = ? WHERE source_revision_ref = ? " +
      "AND projection_generation = ?",
  ).run(total, sourceRevisionRef, base.projection_generation);
}

test("EXACT: preserves the raw FAST_SEARCH probe including whitespace and punctuation", async () => {
  await withSearchWorld(async (world) => {
    const query = '  Pinned "source"?!  ';
    const probes: string[] = [];
    const exact = exactPort(world, async (_candidate, _request, probe) => {
      probes.push(probe);
      return false;
    });
    assert.deepEqual(await exact.exactPhraseCandidates(request(world, query)), []);
    assert.deepEqual(probes, [query]);
  });
});

test("EXACT: enumerates pinned active sections and verifies exact string matches", async () => {
  await withSearchWorld(async (world) => {
    const seen: LocatorCandidate[] = [];
    const exact = exactPort(
      world,
      readOnlyVerifier(new Map([["item-rev-a", "Pinned source rev-a"]]), seen),
    );
    const hits = await exact.exactPhraseCandidates(request(world, "Pinned"));
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.lane, "EXACT");
    assert.equal(hits[0]?.preview, "");
    assert.equal(hits[0]?.source_revision_ref, "rev-a");
    assert.deepEqual(seen.map((candidate) => candidate.candidate_id), ["item-rev-a"]);
    assert.deepEqual(
      await exact.exactPhraseCandidates(request(world, "Pinned source rev-b")),
      [],
    );
  });
});

test("EXACT: stale and purged revisions cannot become exact no-hits", async () => {
  await withSearchWorld(async (world) => {
    const exact = exactPort(world, readOnlyVerifier(new Map([["item-rev-a", "Pinned source rev-a"]])));
    world.stale();
    await assert.rejects(exact.exactPhraseCandidates(request(world, "Pinned")), incomplete);
  });
  await withSearchWorld(async (world) => {
    const seen: LocatorCandidate[] = [];
    const exact = exactPort(
      world,
      readOnlyVerifier(new Map([["item-rev-a", "Pinned source rev-a"]]), seen),
    );
    world.purge();
    assert.deepEqual(await exact.exactPhraseCandidates(request(world, "Pinned")), []);
    assert.equal(seen.length, 0);
  });
});

test("EXACT: a section scan at the existing bound plus one fails closed", async () => {
  await withSearchWorld(async (world) => {
    await addActiveSections(world, "rev-a", 51);

    const exact = exactPort(world, async () => false);
    await assert.rejects(exact.exactPhraseCandidates(request(world, "Pinned")), incomplete);
  });
});

test("EXACT: exactly 50 scanned candidates remains bounded and valid", async () => {
  await withSearchWorld(async (world) => {
    await addActiveSections(world, "rev-a", 50);
    const seen: LocatorCandidate[] = [];
    const exact = exactPort(world, async (candidate) => {
      seen.push(candidate);
      return false;
    });
    assert.deepEqual(await exact.exactPhraseCandidates(request(world, "absent", 50)), []);
    assert.equal(seen.length, 50);
  });
});

test("EXACT: the 50-candidate bound is global across pinned sources", async () => {
  await withSearchWorld(async (world) => {
    await addActiveSections(world, "rev-a", 30);
    await addActiveSections(world, "rev-b", 30);
    const seen: LocatorCandidate[] = [];
    const exact = exactPort(world, async (candidate) => {
      seen.push(candidate);
      return false;
    });
    await assert.rejects(
      exact.exactPhraseCandidates(request(world, "absent", 50)),
      incomplete,
    );
    assert.equal(seen.length, 50);
  }, ["rev-a", "rev-b"]);
});
