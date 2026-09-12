import type { LocatorCandidate } from "@eliotr/contracts";
import type {
  ExactSearchPort,
  RetrievalRequest,
} from "@eliotr/retrieval";
import {
  assertIdentifier,
  assertSearchCurrent,
  assertSha256,
  D1_SEARCH_LANE_MAX_LIMIT,
  laneFail,
  validateSearchInput,
  type ValidatedSearchInput,
} from "./d1-search-input.js";
import {
  captureSourceFences,
  checkCandidateFence,
  pinReadyGenerations,
  requirePinnedCoverage,
  settleSearchRead,
  type PinnedGeneration,
} from "./d1-search-authority.js";
import type { D1SearchReadDependencies } from "./d1-search-read.js";

/**
 * The exact phrase check is deliberately injected. The projection adapter
 * only supplies a pinned locator; Worker composition later supplies the
 * canonical evidence authority plus bounded R2 readback.
 */
export type ExactPhraseVerifier = (
  candidate: LocatorCandidate,
  request: Readonly<RetrievalRequest>,
  probe: string,
) => Promise<boolean>;

export interface D1ExactSearchDependencies extends D1SearchReadDependencies {
  readonly verifyExactPhrase: ExactPhraseVerifier;
}

interface ExactSectionRow {
  readonly item_key: unknown;
  readonly source_revision_ref: unknown;
  readonly canonical_section_id: unknown;
  readonly content_sha256: unknown;
  readonly projection_generation: unknown;
  readonly normalized_start_byte: unknown;
  readonly normalized_end_byte: unknown;
}

interface ExactSection {
  readonly item_key: string;
  readonly source_revision_ref: string;
  readonly canonical_section_id: string;
  readonly content_sha256: string;
  readonly projection_generation: string;
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
}

function decodeExactSection(row: ExactSectionRow): ExactSection {
  const start = row.normalized_start_byte;
  const end = row.normalized_end_byte;
  if (
    typeof start !== "number" || typeof end !== "number" ||
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    start < 0 || end <= start
  ) {
    laneFail("SEARCH_INCOMPLETE", "stored exact projection span is malformed");
  }
  return {
    item_key: assertIdentifier(row.item_key, "stored exact item_key"),
    source_revision_ref: assertIdentifier(row.source_revision_ref, "stored exact source_revision_ref"),
    canonical_section_id: assertIdentifier(row.canonical_section_id, "stored exact canonical_section_id"),
    content_sha256: assertSha256(row.content_sha256, "stored exact content_sha256"),
    projection_generation: assertIdentifier(row.projection_generation, "stored exact projection_generation"),
    normalized_start_byte: start,
    normalized_end_byte: end,
  };
}

function toCandidate(section: ExactSection, rank: number): LocatorCandidate {
  return {
    candidate_id: section.item_key,
    lane: "EXACT",
    source_revision_ref: section.source_revision_ref,
    canonical_section_id: section.canonical_section_id,
    preview: "",
    raw_score: 1,
    rank,
    index_generation: section.projection_generation,
    metadata: {
      item_key: section.item_key,
      source_revision_ref: section.source_revision_ref,
      canonical_section_id: section.canonical_section_id,
      projection_generation: section.projection_generation,
      content_sha256: section.content_sha256,
      normalized_start_byte: section.normalized_start_byte,
      normalized_end_byte: section.normalized_end_byte,
    },
  };
}

async function readSections(
  search: D1Database,
  pin: PinnedGeneration,
): Promise<readonly ExactSection[]> {
  const result = await search
    .prepare(
      "SELECT p.item_key, p.source_revision_ref, p.canonical_section_id, p.content_sha256, " +
        "p.projection_generation, s.normalized_start_byte, s.normalized_end_byte " +
        "FROM projection_item p JOIN projection_span s ON s.item_key = p.item_key " +
        "AND s.source_revision_ref = p.source_revision_ref " +
        "AND s.projection_generation = p.projection_generation " +
        "WHERE p.source_revision_ref = ?1 AND p.projection_generation = ?2 AND p.active = 1 " +
        "ORDER BY s.normalized_start_byte, p.item_key LIMIT ?3",
    )
    .bind(
      pin.source_revision_ref,
      pin.projection_generation,
      D1_SEARCH_LANE_MAX_LIMIT + 1,
    )
    .all<ExactSectionRow>();
  const rows = result.results ?? [];
  if (rows.length > D1_SEARCH_LANE_MAX_LIMIT) {
    laneFail("SEARCH_INCOMPLETE", "exact section scan exceeds its bounded window");
  }
  return rows.map(decodeExactSection);
}

function assertPinnedSection(section: ExactSection, pin: PinnedGeneration): void {
  if (
    section.source_revision_ref !== pin.source_revision_ref ||
    section.projection_generation !== pin.projection_generation
  ) {
    laneFail("SEARCH_INCOMPLETE", "exact section is outside its pinned generation");
  }
}

/**
 * Q3 FAST_SEARCH EXACT bounded candidate read over the pinned D1 Search projection.
 *
 * D1 enumerates active section locators only. It does not use FTS and does
 * not expose projection text as proof; exact string/byte verification is the
 * injected read-only callback and later Worker composition responsibility.
 */
export function createD1SearchExactPort(
  dependencies: D1ExactSearchDependencies,
): Pick<ExactSearchPort, "exactPhraseCandidates"> {
  const search = dependencies.search_database;
  const core = dependencies.core_database;
  const now = dependencies.now ?? Date.now;
  return {
    async exactPhraseCandidates(
      request: RetrievalRequest,
    ): Promise<readonly LocatorCandidate[]> {
      const input: ValidatedSearchInput = validateSearchInput(request);
      // Preserve the public raw query, including leading/trailing whitespace,
      // across the awaited authority reads below. The shared input helper's
      // trimmed value remains appropriate for IDENT/LEX, but EXACT probes are
      // literal and must not rewrite the request identity.
      const probe = request.raw_query;
      assertSearchCurrent(input, now, true);
      if (input.members.length === 0) return [];

      const { pinned, missing, stale } = await pinReadyGenerations(
        search,
        "exact",
        input.members,
        input.owner_generations,
      );
      requirePinnedCoverage(pinned, missing, stale);
      const fences = await captureSourceFences(core, pinned, input);
      assertSearchCurrent(input, now);

      const candidates: LocatorCandidate[] = [];
      let scannedCandidates = 0;
      for (const pin of pinned) {
        const remaining = input.limit - candidates.length;
        if (remaining <= 0) break;
        const sections = await readSections(search, pin);
        for (const rawSection of sections) {
          if (fences.get(pin.source_revision_ref) === "purged") break;
          const fence = await checkCandidateFence(core, input.owner_generations, pin.source_revision_ref);
          if (fence === "purged") break;
          assertPinnedSection(rawSection, pin);
          assertSearchCurrent(input, now);
          if (scannedCandidates >= D1_SEARCH_LANE_MAX_LIMIT) {
            laneFail("SEARCH_INCOMPLETE", "exact candidate scan exceeds its bounded window");
          }
          scannedCandidates += 1;
          const candidate = toCandidate(rawSection, candidates.length + 1);
          if (await dependencies.verifyExactPhrase(candidate, request, probe)) {
            candidates.push(candidate);
            if (candidates.length >= input.limit) break;
          }
        }
      }
      await settleSearchRead(search, core, "exact", pinned, input, fences, now);
      return candidates;
    },
  };
}
