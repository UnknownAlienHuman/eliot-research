import { DatabaseSync } from "node:sqlite";
import type { LocatorCandidate } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import { resolveCandidateAuthority } from "./authority-load.js";

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

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            all<T>() {
              return Promise.resolve({
                success: true,
                results: database.prepare(sql).all(...values as any[]) as T[],
              });
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
