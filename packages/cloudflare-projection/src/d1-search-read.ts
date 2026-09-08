import type { LocatorCandidate } from "@eliotr/contracts";
import type {
  DirectLookupPort,
  LexicalSearchPort,
  RetrievalRequest,
} from "@eliotr/retrieval";
import {
  IDENTIFIER, SHA256, D1SearchLaneError, laneFail, assertIdentifier, assertSha256,
  validateSearchInput, assertSearchCurrent,
} from "./d1-search-input.js";
import {
  pinReadyGenerations, requirePinnedCoverage, captureSourceFences, checkCandidateFence, settleSearchRead,
} from "./d1-search-authority.js";

// Preserve the public module path and error constructor for existing callers.
export { D1_SEARCH_LANE_MAX_LIMIT, D1SearchLaneError } from "./d1-search-input.js";
export type { D1SearchLaneCode } from "./d1-search-input.js";

export interface D1SearchReadDependencies {
  readonly search_database: D1Database;
  readonly core_database: D1Database;
  readonly now?: () => number;
}

interface ItemRow {
  readonly item_key: unknown;
  readonly canonical_section_id: unknown;
  readonly content_sha256: unknown;
  readonly projection_generation: unknown;
}

/**
 * FTS5 syntax is never interpreted from user input. The trimmed query becomes
 * one quoted phrase with embedded quotes doubled, bound as a single parameter
 * to `section_fts MATCH ?`. Query authority (pinned generation, frozen scope,
 * bounds) is unchanged by special characters.
 */
export function sanitizeFts5Phrase(trimmedQuery: string): string {
  return `"${trimmedQuery.replace(/"/gu, '""')}"`;
}

function decodeItemRow(row: ItemRow): {
  readonly item_key: string;
  readonly canonical_section_id: string;
  readonly content_sha256: string;
  readonly projection_generation: string;
} {
  return {
    item_key: assertIdentifier(row.item_key, "stored item_key"),
    canonical_section_id: assertIdentifier(row.canonical_section_id, "stored canonical_section_id"),
    content_sha256: assertSha256(row.content_sha256, "stored content_sha256"),
    projection_generation: assertIdentifier(row.projection_generation, "stored projection_generation"),
  };
}

function toCandidate(
  lane: "IDENT" | "LEX",
  item: {
    readonly item_key: string;
    readonly canonical_section_id: string;
    readonly content_sha256: string;
    readonly projection_generation: string;
  },
  sourceRevisionRef: string,
  rank: number,
): LocatorCandidate {
  return {
    candidate_id: item.item_key,
    lane,
    source_revision_ref: sourceRevisionRef,
    canonical_section_id: item.canonical_section_id,
    // Never return FTS/index text as proof. Resolution (Q2) reopens pinned bytes.
    preview: "",
    raw_score: lane === "IDENT" ? 1 : 0.5,
    rank,
    index_generation: item.projection_generation,
    metadata: {
      source_revision_ref: sourceRevisionRef,
      canonical_section_id: item.canonical_section_id,
      projection_generation: item.projection_generation,
      content_sha256: item.content_sha256,
    },
  };
}

export function createD1SearchIdentPort(
  dependencies: D1SearchReadDependencies,
): DirectLookupPort {
  const search = dependencies.search_database;
  const core = dependencies.core_database;
  const now = dependencies.now ?? Date.now;
  return {
    async lookupIdentifiers(request: RetrievalRequest): Promise<readonly LocatorCandidate[]> {
      const input = validateSearchInput(request);
      const { limit, query: identifier, members, owner_generations: ownerGenerations } = input;
      assertSearchCurrent(input, now, true);
      if (members.length === 0) return [];
      const { pinned, missing, stale } = await pinReadyGenerations(search, "exact", members, ownerGenerations);
      requirePinnedCoverage(pinned, missing, stale);
      const fences = await captureSourceFences(core, pinned, input);
      assertSearchCurrent(input, now);
      if (!IDENTIFIER.test(identifier) && !SHA256.test(identifier)) {
        // Syntactically nonmatching input still crossed awaited authority reads.
        await settleSearchRead(search, core, "exact", pinned, input, fences, now);
        return [];
      }
      const candidates: LocatorCandidate[] = [];
      for (const pin of pinned) {
        if (fences.get(pin.source_revision_ref) === "purged") continue;
        const remaining = limit - candidates.length;
        if (remaining <= 0) break;
        const result = await search
          .prepare(
            "SELECT item_key, canonical_section_id, content_sha256, projection_generation " +
              "FROM projection_item WHERE source_revision_ref = ?1 AND projection_generation = ?2 " +
              "AND active = 1 AND (item_key = ?3 OR canonical_section_id = ?3 OR content_sha256 = ?3) " +
              "ORDER BY item_key LIMIT ?4",
          )
          .bind(
            pin.source_revision_ref,
            pin.projection_generation,
            identifier,
            remaining,
          )
          .all<ItemRow>();
        for (const row of result.results ?? []) {
          const item = decodeItemRow(row);
          if (item.projection_generation !== pin.projection_generation) {
            laneFail("SEARCH_INCOMPLETE", "projection generation drifted during IDENT read");
          }
          if ((await checkCandidateFence(core, ownerGenerations, pin.source_revision_ref)) === "purged") continue;
          candidates.push(
            toCandidate("IDENT", item, pin.source_revision_ref, candidates.length + 1),
          );
          if (candidates.length >= limit) break;
        }
      }
      await settleSearchRead(search, core, "exact", pinned, input, fences, now);
      return candidates;
    },
  };
}

export function createD1SearchLexPort(
  dependencies: D1SearchReadDependencies,
): LexicalSearchPort {
  const search = dependencies.search_database;
  const core = dependencies.core_database;
  const now = dependencies.now ?? Date.now;
  return {
    async search(
      request: RetrievalRequest,
      lane: "LEX" | "LITERAL",
    ): Promise<readonly LocatorCandidate[]> {
      if (lane !== "LEX") {
        throw new D1SearchLaneError(
          "SEARCH_INPUT_INVALID",
          "D1 Search LEX port does not serve LITERAL lanes",
        );
      }
      const input = validateSearchInput(request);
      const { limit, query: trimmed, members, owner_generations: ownerGenerations } = input;
      assertSearchCurrent(input, now, true);
      if (members.length === 0) return [];
      const { pinned, missing, stale } = await pinReadyGenerations(search, "lexical", members, ownerGenerations);
      requirePinnedCoverage(pinned, missing, stale);
      const fences = await captureSourceFences(core, pinned, input);
      assertSearchCurrent(input, now);
      const phrase = sanitizeFts5Phrase(trimmed);
      const candidates: LocatorCandidate[] = [];
      for (const pin of pinned) {
        if (fences.get(pin.source_revision_ref) === "purged") continue;
        const remaining = limit - candidates.length;
        if (remaining <= 0) break;
        const result = await search
          .prepare(
            "SELECT p.item_key, p.canonical_section_id, p.content_sha256, p.projection_generation " +
              "FROM section_fts JOIN projection_item p ON p.item_key = section_fts.item_key " +
              "WHERE p.source_revision_ref = ?1 AND p.projection_generation = ?2 AND p.active = 1 " +
              "AND section_fts MATCH ?3 ORDER BY p.item_key LIMIT ?4",
          )
          .bind(pin.source_revision_ref, pin.projection_generation, phrase, remaining)
          .all<ItemRow>();
        for (const row of result.results ?? []) {
          const item = decodeItemRow(row);
          if (item.projection_generation !== pin.projection_generation) {
            laneFail("SEARCH_INCOMPLETE", "projection generation drifted during LEX read");
          }
          if ((await checkCandidateFence(core, ownerGenerations, pin.source_revision_ref)) === "purged") continue;
          candidates.push(
            toCandidate("LEX", item, pin.source_revision_ref, candidates.length + 1),
          );
          if (candidates.length >= limit) break;
        }
      }
      await settleSearchRead(search, core, "lexical", pinned, input, fences, now);
      return candidates;
    },
  };
}
