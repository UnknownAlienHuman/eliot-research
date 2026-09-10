import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  projectionDigest,
  stableProjectionId,
  createD1SearchIdentPort,
  createD1SearchLexPort,
} from "@eliotr/cloudflare-projection";
import {
  importAndProject,
  laneRequest,
  prepareQ1Namespace,
  scopeFor,
  type Q1Namespace,
  type Q1Runtime,
} from "./retrieval-q1-fixture.js";

/**
 * Q1 read-fence vectors: deterministic current-generation selection across
 * an A->B switch, mixed-generation ambiguity, owner authority, semantic
 * item-set digest verification, and mid-read authority races.
 *
 * The B generation below is a controlled SEARCH_DB selection fixture laid
 * over a genuinely projected generation A (real import -> dispatcher ->
 * consumer -> projector -> activation). It exercises the lane read path
 * only; it never replaces the pipeline.
 */

const runtime = env as unknown as Q1Runtime;
const db = runtime.CORE_DB;
const searchDb = runtime.SEARCH_DB;

let world: Q1Namespace;

beforeEach(async () => {
  const owner = "q1-generation-fences-owner";
  world = { db, searchDb, runtime, owner, ...(await prepareQ1Namespace(runtime, db, searchDb, owner)) };
});

interface GenerationVectors {
  readonly generationA: string;
  readonly generationB: string;
  readonly itemKeyA: string;
  readonly itemKeyB: string;
  readonly itemCount: number;
  readonly digestB: string;
}

function flipHex(digest: string): string {
  const head = digest.slice(0, 1) === "a" ? "b" : "a";
  return `${head}${digest.slice(1)}`;
}

/** Lay a controlled READY generation B over the projected generation A. */
async function fabricateGenerationB(itemKeyA: string): Promise<GenerationVectors> {
  const watermarkA = await searchDb
    .prepare(
      "SELECT projection_generation FROM projection_watermark " +
        "WHERE channel = 'exact' AND source_revision_ref = ?1 LIMIT 1",
    )
    .bind(world.revision)
    .first<{ readonly projection_generation: string }>();
  const generationA = watermarkA?.projection_generation;
  if (typeof generationA !== "string") throw new Error("Missing projected generation A");
  const generationB = `projection-${"g".repeat(48)}`;
  const rowsB = (
    await searchDb
      .prepare(
        "SELECT p.item_key || '-b' AS item_key, p.canonical_section_id, p.content_sha256, " +
          "s.normalized_start_byte, s.normalized_end_byte " +
          "FROM projection_item p JOIN projection_span s ON s.item_key = p.item_key " +
          "WHERE p.source_revision_ref = ?1 AND p.projection_generation = ?2 AND p.active = 1 " +
          "ORDER BY s.normalized_start_byte, p.item_key",
      )
      .bind(world.revision, generationA)
      .all<{
        readonly item_key: string;
        readonly canonical_section_id: string;
        readonly content_sha256: string;
        readonly normalized_start_byte: number;
        readonly normalized_end_byte: number;
      }>()
  ).results;
  if (rowsB === undefined || rowsB.length === 0) throw new Error("Missing projected rows A");
  await searchDb
    .prepare(
      "INSERT INTO projection_item(item_key, source_revision_ref, canonical_section_id, " +
        "project_membership_ids_json, source_class, title, heading_path, document_context_header, " +
        "section_text, normalized_offset_map_ref, content_sha256, instruction_taint, " +
        "projection_generation, active, updated_at) " +
        "SELECT item_key || '-b', source_revision_ref, canonical_section_id, project_membership_ids_json, " +
        "source_class, title, heading_path, document_context_header, section_text, " +
        "normalized_offset_map_ref, content_sha256, instruction_taint, ?1, 1, ?2 " +
        "FROM projection_item WHERE source_revision_ref = ?3 AND projection_generation = ?4 AND active = 1",
    )
    .bind(generationB, new Date().toISOString(), world.revision, generationA)
    .run();
  await searchDb
    .prepare(
      "INSERT INTO projection_span(item_key, source_revision_ref, normalized_start_byte, " +
        "normalized_end_byte, precision_kind, projection_generation) " +
        "SELECT p.item_key || '-b', p.source_revision_ref, s.normalized_start_byte, " +
        "s.normalized_end_byte, s.precision_kind, ?1 FROM projection_span s " +
        "JOIN projection_item p ON p.item_key = s.item_key " +
        "WHERE p.source_revision_ref = ?2 AND p.projection_generation = ?3 AND p.active = 1",
    )
    .bind(generationB, world.revision, generationA)
    .run();
  await searchDb
    .prepare(
      "INSERT INTO section_fts(item_key, title, heading_path, document_context_header, section_text) " +
        "SELECT p.item_key || '-b', f.title, f.heading_path, f.document_context_header, f.section_text " +
        "FROM section_fts f JOIN projection_item p ON p.item_key = f.item_key " +
        "WHERE p.source_revision_ref = ?1 AND p.projection_generation = ?2 AND p.active = 1",
    )
    .bind(world.revision, generationA)
    .run();
  const digestB = await projectionDigest(
    rowsB.map((row) => ({
      item_key: row.item_key,
      canonical_section_id: row.canonical_section_id,
      content_sha256: row.content_sha256,
      start: row.normalized_start_byte,
      end: row.normalized_end_byte,
    })),
  );
  const receiptB = await stableProjectionId("d1-search-receipt", world.revision, generationB, digestB);
  const stamp = new Date(Date.now() + 60_000).toISOString();
  await searchDb
    .prepare(
      "INSERT INTO projection_generation_receipt(source_revision_ref, projection_generation, state, " +
        "item_count, item_set_digest, readback_digest, receipt_ref, created_at, updated_at) " +
        "VALUES (?1,?2,'READY',?3,?4,?4,?5,?6,?6)",
    )
    .bind(world.revision, generationB, rowsB.length, digestB, receiptB, stamp)
    .run();
  for (const channel of ["exact", "lexical"]) {
    await searchDb
      .prepare(
        "INSERT INTO projection_watermark(channel, projection_generation, source_revision_ref, " +
          "projected_item_count, state, readback_receipt_ref, updated_at) " +
          "VALUES (?1,?2,?3,?4,'READY',?5,?6)",
      )
      .bind(channel, generationB, world.revision, rowsB.length, receiptB, stamp)
      .run();
  }
  await searchDb
    .prepare(
      "INSERT INTO projection_activation_guard(source_revision_ref, projection_generation, receipt_ref, " +
        "readback_digest, item_count, verified, created_at) VALUES (?1,?2,?3,?4,?5,1,?6)",
    )
    .bind(world.revision, generationB, receiptB, digestB, rowsB.length, stamp)
    .run();
  const firstB = rowsB[0];
  if (firstB === undefined) throw new Error("Missing fabricated row B");
  return {
    generationA,
    generationB,
    itemKeyA,
    itemKeyB: firstB.item_key,
    itemCount: rowsB.length,
    digestB,
  };
}

async function deactivateGeneration(generation: string): Promise<void> {
  await searchDb
    .prepare(
      "UPDATE projection_item SET active = 0, updated_at = ?1 " +
        "WHERE source_revision_ref = ?2 AND projection_generation = ?3",
    )
    .bind(new Date().toISOString(), world.revision, generation)
    .run();
}

/**
 * Wrap a D1 database so the next terminal read of a statement prepared from
 * matching SQL first applies a race mutation. Proves the lane rechecks
 * authority after its row reads instead of trusting the first fence.
 */
function racingDb(
  database: D1Database,
  marker: string,
  afterCalls: number,
  raceSql: string,
  raceParams: readonly unknown[],
): D1Database {
  let matchingPrepares = 0;
  let raced = false;
  const runRace = async (): Promise<void> => {
    if (!raced && matchingPrepares > afterCalls) {
      raced = true;
      await database.prepare(raceSql).bind(...raceParams).run();
    }
  };
  const wrapStatement = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(stmtTarget, prop) {
        if (prop === "bind") {
          return (...args: unknown[]) => wrapStatement(stmtTarget.bind(...args));
        }
        if (prop === "first") {
          return async () => {
            await runRace();
            return stmtTarget.first();
          };
        }
        if (prop === "all") {
          return async () => {
            await runRace();
            return stmtTarget.all();
          };
        }
        if (prop === "run") {
          return async () => {
            await runRace();
            return stmtTarget.run();
          };
        }
        return Reflect.get(stmtTarget, prop, stmtTarget);
      },
    });
  return new Proxy(database, {
    get(dbTarget, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = dbTarget.prepare(sql);
          if (sql.includes(marker)) {
            matchingPrepares += 1;
            return wrapStatement(stmt);
          }
          return stmt;
        };
      }
      return Reflect.get(dbTarget, prop, dbTarget);
    },
  });
}

describe("Q1 generation selection and authority fences", () => {
  it("selects the current active generation across an A->B switch", async () => {
    const { item } = await importAndProject(world);
    const vectors = await fabricateGenerationB(item.item_key);
    await deactivateGeneration(vectors.generationA);
    const staleWatermark = await searchDb
      .prepare(
        "SELECT state FROM projection_watermark WHERE channel = 'exact' AND source_revision_ref = ?1 " +
          "AND projection_generation = ?2 LIMIT 1",
      )
      .bind(world.revision, vectors.generationA)
      .first<{ readonly state: string }>();
    // The superseded generation keeps an old READY watermark but holds no
    // live rows; the lane must still select the current generation B.
    expect(staleWatermark?.state).toBe("READY");
    const scope = scopeFor(world.namespace, [world.revision]);
    const ident = createD1SearchIdentPort({ search_database: searchDb, core_database: db });
    const lex = createD1SearchLexPort({ search_database: searchDb, core_database: db });
    const identB = await ident.lookupIdentifiers(laneRequest(vectors.itemKeyB, scope, 10));
    expect(identB).toHaveLength(1);
    expect(identB[0]).toMatchObject({
      lane: "IDENT",
      source_revision_ref: world.revision,
      index_generation: vectors.generationB,
    });
    const identA = await ident.lookupIdentifiers(laneRequest(vectors.itemKeyA, scope, 10));
    expect(identA).toEqual([]);
    const lexHits = await lex.search(laneRequest("Pinned", scope, 10), "LEX");
    expect(lexHits.length).toBeGreaterThanOrEqual(1);
    for (const hit of lexHits) expect(hit.index_generation).toBe(vectors.generationB);
  });

  it("fails closed on mixed-generation exposure", async () => {
    const { item } = await importAndProject(world);
    // Both generations keep live active rows: no deterministic current.
    await fabricateGenerationB(item.item_key);
    const scope = scopeFor(world.namespace, [world.revision]);
    const ident = createD1SearchIdentPort({ search_database: searchDb, core_database: db });
    const lex = createD1SearchLexPort({ search_database: searchDb, core_database: db });
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, scope, 10))).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
    await expect(lex.search(laneRequest("Pinned", scope, 10), "LEX")).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
  });

  it("fails closed on missing or mismatched owner authority", async () => {
    const { item } = await importAndProject(world);
    const ident = createD1SearchIdentPort({ search_database: searchDb, core_database: db });
    const lex = createD1SearchLexPort({ search_database: searchDb, core_database: db });
    const live = scopeFor(world.namespace, [world.revision]);
    const missingOwner = { ...live, source_owner_generations: {} };
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, missingOwner, 10))).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
    await expect(lex.search(laneRequest("Pinned", missingOwner, 10), "LEX")).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
    const mismatchedOwner = {
      ...live,
      source_owner_generations: { [world.revision]: "owner-generation-2" },
    };
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, mismatchedOwner, 10))).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
    await expect(lex.search(laneRequest("Pinned", mismatchedOwner, 10), "LEX")).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
    // A retired namespace ownership record is an authority change as well.
    await db
      .prepare("UPDATE source_namespace_ownership SET status = 'RETIRED' WHERE source_namespace_id = ?1")
      .bind(world.namespace)
      .run();
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, live, 10))).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
    await expect(lex.search(laneRequest("Pinned", live, 10), "LEX")).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
  });

  it("verifies the item-set digest semantically, not just as 64-hex", async () => {
    const { item } = await importAndProject(world);
    const scope = scopeFor(world.namespace, [world.revision]);
    const receipt = await searchDb
      .prepare(
        "SELECT item_set_digest FROM projection_generation_receipt " +
          "WHERE source_revision_ref = ?1 LIMIT 1",
      )
      .bind(world.revision)
      .first<{ readonly item_set_digest: string }>();
    const digest = receipt?.item_set_digest;
    if (typeof digest !== "string") throw new Error("Missing stored item-set digest");
    const ident = createD1SearchIdentPort({ search_database: searchDb, core_database: db });
    const lex = createD1SearchLexPort({ search_database: searchDb, core_database: db });
    // Valid hex but tampered receipt digest must not read as valid.
    await searchDb
      .prepare("UPDATE projection_generation_receipt SET item_set_digest = ?1 WHERE source_revision_ref = ?2")
      .bind(flipHex(digest), world.revision)
      .run();
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, scope, 10))).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
    await expect(lex.search(laneRequest("Pinned", scope, 10), "LEX")).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
    await searchDb
      .prepare("UPDATE projection_generation_receipt SET item_set_digest = ?1 WHERE source_revision_ref = ?2")
      .bind(digest, world.revision)
      .run();
    // Valid hex but tampered row content must not read as valid either.
    await searchDb
      .prepare("UPDATE projection_item SET content_sha256 = ?1 WHERE item_key = ?2")
      .bind(flipHex(item.content_sha256), item.item_key)
      .run();
    await expect(ident.lookupIdentifiers(laneRequest(item.item_key, scope, 10))).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
    await expect(lex.search(laneRequest("Pinned", scope, 10), "LEX")).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
  });

  it("fails closed on purge and authority races after the row reads", async () => {
    const { item } = await importAndProject(world);
    const scope = scopeFor(world.namespace, [world.revision]);
    const purgedCore = racingDb(
      db,
      "FROM source_revision sr",
      1,
      "UPDATE source_revision SET purge_state = 'QUARANTINED' WHERE source_revision_ref = ?1",
      [world.revision],
    );
    const purgedIdent = createD1SearchIdentPort({ search_database: searchDb, core_database: purgedCore });
    // The initial fence observes LIVE and reads a candidate; the purge lands
    // before the post-read recheck, which must reject the stale authority.
    await expect(purgedIdent.lookupIdentifiers(laneRequest(item.item_key, scope, 10))).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
    await db
      .prepare("UPDATE source_revision SET purge_state = 'LIVE' WHERE source_revision_ref = ?1")
      .bind(world.revision)
      .run();
    const changedCore = racingDb(
      db,
      "FROM source_revision sr",
      1,
      "UPDATE source_revision SET source_owner_generation = 'owner-generation-2' WHERE source_revision_ref = ?1",
      [world.revision],
    );
    const changedLex = createD1SearchLexPort({ search_database: searchDb, core_database: changedCore });
    await expect(changedLex.search(laneRequest("Pinned", scope, 10), "LEX")).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
  });

  it("fails closed on a watermark race after the row reads", async () => {
    const { item } = await importAndProject(world);
    const vectors = await fabricateGenerationB(item.item_key);
    await deactivateGeneration(vectors.generationA);
    const scope = scopeFor(world.namespace, [world.revision]);
    const racedSearch = racingDb(
      searchDb,
      "FROM projection_watermark",
      1,
      "UPDATE projection_watermark SET state = 'STALE' WHERE channel = 'exact' AND source_revision_ref = ?1 " +
        "AND projection_generation = ?2",
      [world.revision, vectors.generationB],
    );
    const racedIdent = createD1SearchIdentPort({ search_database: racedSearch, core_database: db });
    // Pin and row reads observe READY generation B; the watermark flips to
    // STALE before the post-read recheck, which must reject the read.
    await expect(racedIdent.lookupIdentifiers(laneRequest(vectors.itemKeyB, scope, 10))).rejects.toMatchObject({
      code: "SEARCH_INCOMPLETE",
    });
  });
});
