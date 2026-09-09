/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RetrievalRequest } from "@eliotr/retrieval";
import { projectionDigest, projectionSha256Utf8 } from "./canonical.js";
import { createD1SearchIdentPort, createD1SearchLexPort } from "./d1-search-read.js";

/** Real SQLite/FTS reads with controlled interleavings, not import or live D1 qualification. */
export interface ReadObservation {
  readonly database: "core" | "search";
  readonly sql: string;
  readonly args: readonly SQLInputValue[];
}
function readBinding(
  database: DatabaseSync,
  kind: ReadObservation["database"],
  observe: (read: ReadObservation) => void,
): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: SQLInputValue[]) {
          const bindings = Object.fromEntries(args.map((value, index) => [String(index + 1), value]));
          return {
            async all() {
              const results = database.prepare(sql).all(bindings);
              observe({ database: kind, sql, args });
              return { success: true, results };
            },
            async first() {
              const result = database.prepare(sql).get(bindings) ?? null;
              observe({ database: kind, sql, args });
              return result;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}
export function isCandidateRead(read: ReadObservation): boolean {
  return read.database === "search" &&
    (read.sql.includes("AND (item_key = ?3") || read.sql.includes("section_fts MATCH ?3"));
}
export function isWatermarkRead(read: ReadObservation): boolean {
  return read.database === "search" && read.sql.includes("FROM projection_watermark");
}
export async function searchWorld(revisions: readonly string[] = ["rev-a"]) {
  const core = new DatabaseSync(":memory:");
  const search = new DatabaseSync(":memory:");
  core.exec(`
    CREATE TABLE source (source_id TEXT PRIMARY KEY, source_namespace_id TEXT NOT NULL);
    CREATE TABLE source_revision (source_revision_ref TEXT PRIMARY KEY, source_id TEXT NOT NULL,
      source_owner_generation TEXT NOT NULL, purge_state TEXT NOT NULL);
    CREATE TABLE source_namespace_ownership (source_namespace_id TEXT PRIMARY KEY,
      source_owner_generation TEXT NOT NULL, status TEXT NOT NULL);
  `);
  // Read-schema only. Production migrations, admission, activation writes, Queue and R2
  // are deliberately outside this focused adapter regression fixture.
  search.exec(`
    CREATE TABLE projection_watermark (channel TEXT, source_revision_ref TEXT,
      projection_generation TEXT, state TEXT, readback_receipt_ref TEXT, updated_at TEXT);
    CREATE TABLE projection_generation_receipt (source_revision_ref TEXT, projection_generation TEXT,
      state TEXT, item_count INTEGER, item_set_digest TEXT, readback_digest TEXT, receipt_ref TEXT);
    CREATE TABLE projection_activation_guard (source_revision_ref TEXT, projection_generation TEXT,
      receipt_ref TEXT, readback_digest TEXT, item_count INTEGER, verified INTEGER);
    CREATE TABLE projection_item (item_key TEXT PRIMARY KEY, source_revision_ref TEXT,
      canonical_section_id TEXT, content_sha256 TEXT, projection_generation TEXT, active INTEGER);
    CREATE TABLE projection_span (item_key TEXT PRIMARY KEY, source_revision_ref TEXT,
      projection_generation TEXT, normalized_start_byte INTEGER, normalized_end_byte INTEGER);
    CREATE VIRTUAL TABLE section_fts USING fts5(item_key UNINDEXED, section_text);
  `);
  for (const revision of revisions) {
    const item = `item-${revision}`;
    const section = `section-${revision}`;
    const generation = `generation-${revision}`;
    const receipt = `receipt-${revision}`;
    const content = `Pinned source ${revision}`;
    const digest = await projectionSha256Utf8(content);
    const end = new TextEncoder().encode(content).length;
    const itemSet = await projectionDigest([
      { item_key: item, canonical_section_id: section, content_sha256: digest, start: 0, end },
    ]);
    const readback = await projectionSha256Utf8(`readback:${revision}`);
    core.prepare("INSERT INTO source VALUES (?, ?)").run(revision, revision);
    core.prepare("INSERT INTO source_revision VALUES (?, ?, 'owner-1', 'LIVE')").run(revision, revision);
    core.prepare("INSERT INTO source_namespace_ownership VALUES (?, 'owner-1', 'ACTIVE')").run(revision);
    search.prepare("INSERT INTO projection_item VALUES (?, ?, ?, ?, ?, 1)")
      .run(item, revision, section, digest, generation);
    search.prepare("INSERT INTO projection_span VALUES (?, ?, ?, 0, ?)").run(item, revision, generation, end);
    search.prepare("INSERT INTO section_fts VALUES (?, ?)").run(item, content);
    search.prepare("INSERT INTO projection_generation_receipt VALUES (?, ?, 'READY', 1, ?, ?, ?)")
      .run(revision, generation, itemSet, readback, receipt);
    search.prepare("INSERT INTO projection_activation_guard VALUES (?, ?, ?, ?, 1, 1)")
      .run(revision, generation, receipt, readback);
    for (const channel of ["exact", "lexical"]) {
      search.prepare("INSERT INTO projection_watermark VALUES (?, ?, ?, 'READY', ?, ?)")
        .run(channel, revision, generation, receipt, "2026-09-07T12:00:00.000Z");
    }
  }
  const clock = { now: Date.parse("2026-09-07T12:00:00.000Z") };
  const expiry = clock.now + 60_000;
  const observations: ReadObservation[] = [];
  const hooks: { afterRead?: (read: ReadObservation) => void } = {};
  const observe = (read: ReadObservation) => { observations.push(read); hooks.afterRead?.(read); };
  const dependencies = {
    core_database: readBinding(core, "core", observe),
    search_database: readBinding(search, "search", observe),
    now: () => clock.now,
  };
  const ident = createD1SearchIdentPort(dependencies);
  const lex = createD1SearchLexPort(dependencies);
  function request(query: string, limit = 10): RetrievalRequest {
    // Only fields consumed by these read ports; not an authentication/policy fixture.
    return {
      raw_query: query, requested_limit: limit,
      scope_snapshot: {
        member_source_revision_refs: [...revisions],
        source_owner_generations: Object.fromEntries(revisions.map((rev) => [rev, "owner-1"])),
        expires_at: new Date(expiry).toISOString(),
      },
    } as unknown as RetrievalRequest;
  }
  return {
    core, search, ident, lex, request, clock, expiry, hooks, observations,
    stale(revision = "rev-a") {
      search.prepare("UPDATE projection_watermark SET state = 'STALE' WHERE source_revision_ref = ?").run(revision);
    },
    purge(revision = "rev-a") {
      core.prepare("UPDATE source_revision SET purge_state = 'PURGED' WHERE source_revision_ref = ?").run(revision);
    },
    rotateOwner(revision = "rev-a") {
      core.prepare("UPDATE source_namespace_ownership SET source_owner_generation = 'owner-2' " +
        "WHERE source_namespace_id = ?").run(revision);
    },
    close() { search.close(); core.close(); },
  };
}
export type SearchWorld = Awaited<ReturnType<typeof searchWorld>>;
export async function withSearchWorld(
  run: (world: SearchWorld) => Promise<void>, revisions?: readonly string[],
): Promise<void> {
  const world = await searchWorld(revisions);
  try { await run(world); } finally { world.close(); }
}
