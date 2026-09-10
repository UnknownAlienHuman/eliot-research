import type { LocatorCandidate } from "@eliotr/contracts";
import type {
  DirectLookupPort,
  LexicalSearchPort,
  RetrievalRequest,
} from "@eliotr/retrieval";
import { projectionDigest } from "./canonical.js";

export const D1_SEARCH_LANE_MAX_LIMIT = 50;
const MAX_QUERY_UTF8_BYTES = 512;
const MAX_SCOPE_MEMBERS = 64;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type D1SearchLaneCode =
  | "SEARCH_UNAVAILABLE"
  | "SEARCH_INCOMPLETE"
  | "SEARCH_INPUT_INVALID";

export class D1SearchLaneError extends Error {
  public readonly code: D1SearchLaneCode;

  public constructor(code: D1SearchLaneCode, message: string) {
    super(message);
    this.name = "D1SearchLaneError";
    this.code = code;
  }
}

function laneFail(code: D1SearchLaneCode, message: string): never {
  throw new D1SearchLaneError(code, message);
}

export interface D1SearchReadDependencies {
  readonly search_database: D1Database;
  readonly core_database: D1Database;
  readonly now?: () => number;
}

interface WatermarkRow {
  readonly state: unknown;
  readonly projection_generation: unknown;
  readonly readback_receipt_ref: unknown;
  readonly updated_at: unknown;
}

interface GenerationRow {
  readonly state: unknown;
  readonly item_count: unknown;
  readonly item_set_digest: unknown;
  readonly readback_digest: unknown;
  readonly receipt_ref: unknown;
}

interface GuardRow {
  readonly receipt_ref: unknown;
  readonly readback_digest: unknown;
  readonly item_count: unknown;
  readonly verified: unknown;
}

interface ItemRow {
  readonly item_key: unknown;
  readonly canonical_section_id: unknown;
  readonly content_sha256: unknown;
  readonly projection_generation: unknown;
}

interface SourceRow {
  readonly purge_state: unknown;
  readonly source_owner_generation: unknown;
  readonly owner_status: unknown;
  readonly current_owner_generation: unknown;
}

interface ActiveItemRow {
  readonly item_key: unknown;
  readonly canonical_section_id: unknown;
  readonly content_sha256: unknown;
  readonly normalized_start_byte: unknown;
  readonly normalized_end_byte: unknown;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    laneFail("SEARCH_INCOMPLETE", `${label} is malformed`);
  }
  return value;
}

function assertSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    laneFail("SEARCH_INCOMPLETE", `${label} is malformed`);
  }
  return value;
}

function validatedLimit(request: RetrievalRequest): number {
  const limit = request.requested_limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > D1_SEARCH_LANE_MAX_LIMIT) {
    laneFail(
      "SEARCH_INPUT_INVALID",
      `requested_limit must be an integer in [1,${D1_SEARCH_LANE_MAX_LIMIT}]`,
    );
  }
  return limit;
}

function validatedQuery(request: RetrievalRequest): string {
  const raw = request.raw_query;
  if (typeof raw !== "string") laneFail("SEARCH_INPUT_INVALID", "raw_query must be text");
  const trimmed = raw.trim();
  if (trimmed.length === 0) laneFail("SEARCH_INPUT_INVALID", "raw_query must not be empty");
  if (utf8Length(trimmed) > MAX_QUERY_UTF8_BYTES) {
    laneFail("SEARCH_INPUT_INVALID", "raw_query exceeds its byte bound");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(trimmed)) {
    laneFail("SEARCH_INPUT_INVALID", "raw_query contains control characters");
  }
  return trimmed;
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

function validatedMembers(request: RetrievalRequest): readonly string[] {
  const members = request.scope_snapshot.member_source_revision_refs;
  if (!Array.isArray(members) || members.length === 0) return [];
  if (members.length > MAX_SCOPE_MEMBERS) {
    laneFail("SEARCH_INPUT_INVALID", "scope exceeds its member bound");
  }
  const seen = new Set<string>();
  for (const member of members) {
    if (typeof member !== "string" || !IDENTIFIER.test(member)) {
      laneFail("SEARCH_INCOMPLETE", "scope member is malformed");
    }
    if (seen.has(member)) laneFail("SEARCH_INCOMPLETE", "scope members are not unique");
    seen.add(member);
  }
  return [...seen].sort();
}

function scopeIsExpired(request: RetrievalRequest, nowMs: number): boolean {
  const expires = Date.parse(request.scope_snapshot.expires_at);
  if (!Number.isFinite(expires)) laneFail("SEARCH_INCOMPLETE", "scope expiry is malformed");
  return nowMs >= expires;
}

async function readWatermarks(
  search: D1Database, channel: string, sourceRevisionRef: string,
): Promise<readonly WatermarkRow[]> {
  // One (channel, revision) may carry several generations; the current one is
  // selected by live active items below, never by an unordered LIMIT 1.
  const result = await search
    .prepare(
      "SELECT state, projection_generation, readback_receipt_ref, updated_at FROM projection_watermark " +
        "WHERE channel = ?1 AND source_revision_ref = ?2 " +
        "ORDER BY updated_at DESC, projection_generation DESC LIMIT 65",
    )
    .bind(channel, sourceRevisionRef)
    .all<WatermarkRow>();
  const rows = result.results ?? [];
  if (rows.length > 64) {
    laneFail("SEARCH_INCOMPLETE", "D1 Search watermark history exceeds its bound");
  }
  return rows;
}

async function readGeneration(
  search: D1Database,
  sourceRevisionRef: string,
  projectionGeneration: string,
): Promise<GenerationRow | null> {
  return search
    .prepare(
      "SELECT state, item_count, item_set_digest, readback_digest, receipt_ref " +
        "FROM projection_generation_receipt WHERE source_revision_ref = ?1 " +
        "AND projection_generation = ?2 LIMIT 1",
    )
    .bind(sourceRevisionRef, projectionGeneration)
    .first<GenerationRow>();
}

async function readGuard(
  search: D1Database,
  sourceRevisionRef: string,
  projectionGeneration: string,
): Promise<GuardRow | null> {
  return search
    .prepare(
      "SELECT receipt_ref, readback_digest, item_count, verified FROM projection_activation_guard " +
        "WHERE source_revision_ref = ?1 AND projection_generation = ?2 LIMIT 1",
    )
    .bind(sourceRevisionRef, projectionGeneration)
    .first<GuardRow>();
}

async function readActiveItemSet(
  search: D1Database, sourceRevisionRef: string, projectionGeneration: string,
): Promise<{ readonly count: number; readonly digest: string }> {
  // Semantic verification: recompute the canonical item-set digest over the
  // exact active rows (projector shape/order), not the stored 64-hex string.
  const result = await search
    .prepare(
      "SELECT p.item_key, p.canonical_section_id, p.content_sha256, " +
        "s.normalized_start_byte, s.normalized_end_byte " +
        "FROM projection_item p JOIN projection_span s ON s.item_key = p.item_key " +
        "WHERE p.source_revision_ref = ?1 AND p.projection_generation = ?2 AND p.active = 1 " +
        "ORDER BY s.normalized_start_byte, p.item_key LIMIT 1025",
    )
    .bind(sourceRevisionRef, projectionGeneration)
    .all<ActiveItemRow>();
  const rows = result.results ?? [];
  if (rows.length > 1024) {
    laneFail("SEARCH_INCOMPLETE", "active projection item set exceeds its bound");
  }
  const decoded = rows.map((row) => {
    const start = row.normalized_start_byte;
    const end = row.normalized_end_byte;
    if (
      typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) || start < 0 || end <= start
    ) {
      laneFail("SEARCH_INCOMPLETE", "stored projection span is empty, reversed, or malformed");
    }
    return {
      item_key: assertIdentifier(row.item_key, "stored item_key"),
      canonical_section_id: assertIdentifier(row.canonical_section_id, "stored canonical_section_id"),
      content_sha256: assertSha256(row.content_sha256, "stored content_sha256"),
      start,
      end,
    };
  });
  const digest = await projectionDigest(decoded);
  return { count: decoded.length, digest };
}

interface PinnedGeneration {
  readonly source_revision_ref: string;
  readonly projection_generation: string;
  readonly receipt_ref: string;
  readonly readback_digest: string;
}

/** Pin every in-scope revision to its current READY generation: receipt, guard, and live active rows. */
async function pinReadyGenerations(
  search: D1Database, channel: "exact" | "lexical", members: readonly string[],
  ownerGenerations: Readonly<Record<string, string>>,
): Promise<{ readonly pinned: readonly PinnedGeneration[]; readonly missing: readonly string[]; readonly stale: readonly string[] }> {
  const pinned: PinnedGeneration[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const member of members) {
    const expectedOwner: unknown = ownerGenerations[member];
    if (typeof expectedOwner !== "string" || !IDENTIFIER.test(expectedOwner)) {
      laneFail("SEARCH_INCOMPLETE", "scope snapshot omits a valid owner generation for its member");
    }
    const watermarks = await readWatermarks(search, channel, member);
    if (watermarks.length === 0) {
      missing.push(member);
      continue;
    }
    let current: PinnedGeneration | null = null;
    for (const watermark of watermarks) {
      if (watermark.state !== "READY") continue;
      const generation = assertIdentifier(watermark.projection_generation, "stored projection_generation");
      const receiptRef = assertIdentifier(watermark.readback_receipt_ref, "stored watermark readback_receipt_ref");
      const generationRow = await readGeneration(search, member, generation);
      if (generationRow === null || generationRow.state !== "READY") continue;
      if (
        typeof generationRow.item_count !== "number" || !Number.isSafeInteger(generationRow.item_count) ||
        generationRow.item_count < 1 || generationRow.item_count > 1024
      ) {
        laneFail("SEARCH_INCOMPLETE", "stored generation item_count is malformed");
      }
      const itemSetDigest = assertSha256(generationRow.item_set_digest, "stored item_set_digest");
      const readbackDigest = assertSha256(generationRow.readback_digest, "stored readback_digest");
      if (assertIdentifier(generationRow.receipt_ref, "stored receipt_ref") !== receiptRef) continue;
      const guard = await readGuard(search, member, generation);
      if (
        guard === null || guard.receipt_ref !== receiptRef || guard.readback_digest !== readbackDigest ||
        guard.item_count !== generationRow.item_count || guard.verified !== 1
      ) {
        continue;
      }
      const active = await readActiveItemSet(search, member, generation);
      // Superseded generations hold no live active rows and are skipped.
      // Two generations with live rows are mixed-generation exposure.
      if (active.count !== generationRow.item_count) continue;
      if (active.digest !== itemSetDigest) laneFail("SEARCH_INCOMPLETE", "active projection item set digest differs from the generation receipt");
      if (current !== null) laneFail("SEARCH_INCOMPLETE", "ambiguous current D1 Search generation for its member");
      current = {
        source_revision_ref: member,
        projection_generation: generation,
        receipt_ref: receiptRef,
        readback_digest: readbackDigest,
      };
    }
    if (current === null) {
      stale.push(member);
      continue;
    }
    pinned.push(current);
  }
  return { pinned, missing, stale };
}

function requirePinnedCoverage(
  pinned: readonly PinnedGeneration[],
  missing: readonly string[],
  stale: readonly string[],
): void {
  if (pinned.length === 0) {
    // Present-but-not-READY is incomplete authority, never an absent index.
    // Only a wholly missing watermark is unavailable.
    if (stale.length > 0) {
      throw new D1SearchLaneError(
        "SEARCH_INCOMPLETE",
        `stale D1 Search generation: ${stale.length} member(s) without a READY generation`,
      );
    }
    throw new D1SearchLaneError("SEARCH_UNAVAILABLE", "no READY D1 Search generation is pinned");
  }
  if (missing.length > 0 || stale.length > 0) {
    throw new D1SearchLaneError(
      "SEARCH_INCOMPLETE",
      `partial D1 Search coverage: ${missing.length + stale.length} member(s) without a READY generation`,
    );
  }
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

async function loadRevisionFence(
  core: D1Database, sourceRevisionRef: string,
): Promise<SourceRow | null> {
  // Revision row plus its source namespace plus the ACTIVE ownership record.
  return core
    .prepare(
      "SELECT sr.purge_state, sr.source_owner_generation, o.status AS owner_status, " +
        "o.source_owner_generation AS current_owner_generation " +
        "FROM source_revision sr JOIN source s ON s.source_id = sr.source_id " +
        "LEFT JOIN source_namespace_ownership o ON o.source_namespace_id = s.source_namespace_id " +
        "AND o.status = 'ACTIVE' WHERE sr.source_revision_ref = ?1 LIMIT 1",
    )
    .bind(sourceRevisionRef)
    .first<SourceRow>();
}

function fenceDecision(
  row: SourceRow | null,
  expectedOwnerGeneration: string,
): "ok" | "purged" | "conflict" {
  if (row === null) return "conflict";
  if (row.purge_state !== "LIVE") return "purged";
  if (row.source_owner_generation !== expectedOwnerGeneration) return "conflict";
  if (row.owner_status !== "ACTIVE" || row.current_owner_generation !== expectedOwnerGeneration) return "conflict";
  return "ok";
}

async function checkCandidateFence(
  core: D1Database,
  ownerGenerations: Readonly<Record<string, string>>,
  sourceRevisionRef: string,
): Promise<"ok" | "purged"> {
  const expected: unknown = ownerGenerations[sourceRevisionRef];
  if (typeof expected !== "string" || !IDENTIFIER.test(expected)) {
    laneFail("SEARCH_INCOMPLETE", "scope snapshot omits a valid owner generation for its member");
  }
  const fence = fenceDecision(await loadRevisionFence(core, sourceRevisionRef), expected);
  if (fence === "conflict") laneFail("SEARCH_INCOMPLETE", "source ownership authority conflicts with the scope snapshot");
  return fence;
}

async function recheckContributingPins(
  search: D1Database, core: D1Database, channel: "exact" | "lexical",
  pins: readonly PinnedGeneration[], members: readonly string[],
  ownerGenerations: Readonly<Record<string, string>>, expiresAt: string, nowMs: number,
): Promise<void> {
  // Scope, owner, purge, watermark, generation, and guard are rechecked after
  // the row reads. A fence that passed but now fails is a race: fail closed.
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) laneFail("SEARCH_INCOMPLETE", "scope expiry is malformed");
  if (nowMs >= expires) laneFail("SEARCH_INCOMPLETE", "scope snapshot expired during D1 Search read");
  if (pins.length === 0) return;
  const resettled = await pinReadyGenerations(search, channel, members, ownerGenerations);
  for (const pin of pins) {
    const match = resettled.pinned.find((row) => row.source_revision_ref === pin.source_revision_ref);
    if (
      match === undefined ||
      match.projection_generation !== pin.projection_generation ||
      match.receipt_ref !== pin.receipt_ref ||
      match.readback_digest !== pin.readback_digest
    ) {
      laneFail("SEARCH_INCOMPLETE", "D1 Search generation changed during readback");
    }
    const expectedOwner: unknown = ownerGenerations[pin.source_revision_ref];
    if (
      typeof expectedOwner !== "string" ||
      fenceDecision(await loadRevisionFence(core, pin.source_revision_ref), expectedOwner) !== "ok"
    ) {
      laneFail("SEARCH_INCOMPLETE", "source authority changed during D1 Search readback");
    }
  }
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
      const limit = validatedLimit(request);
      const identifier = validatedQuery(request);
      const members = validatedMembers(request);
      // Authority before valid-empty: expiry and pin coverage precede any
      // empty read, so neither masks an expired or incomplete scope.
      if (scopeIsExpired(request, now())) {
        throw new D1SearchLaneError("SEARCH_UNAVAILABLE", "scope snapshot is expired");
      }
      if (members.length === 0) return [];
      const ownerGenerations = request.scope_snapshot.source_owner_generations;
      const { pinned, missing, stale } = await pinReadyGenerations(search, "exact", members, ownerGenerations);
      requirePinnedCoverage(pinned, missing, stale);
      if (!IDENTIFIER.test(identifier) && !SHA256.test(identifier)) {
        // Bounded probe input that is neither identifier nor digest cannot
        // match a pinned row; authority proven above, so this is valid-empty.
        return [];
      }
      const candidates: LocatorCandidate[] = [];
      const contributing: PinnedGeneration[] = [];
      for (const pin of pinned) {
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
          if (!contributing.includes(pin)) contributing.push(pin);
          if (candidates.length >= limit) break;
        }
      }
      await recheckContributingPins(
        search, core, "exact", contributing, members, ownerGenerations,
        request.scope_snapshot.expires_at, now(),
      );
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
      const limit = validatedLimit(request);
      const trimmed = validatedQuery(request);
      const members = validatedMembers(request);
      // Authority before valid-empty, as in IDENT.
      if (scopeIsExpired(request, now())) {
        throw new D1SearchLaneError("SEARCH_UNAVAILABLE", "scope snapshot is expired");
      }
      if (members.length === 0) return [];
      const ownerGenerations = request.scope_snapshot.source_owner_generations;
      const { pinned, missing, stale } = await pinReadyGenerations(search, "lexical", members, ownerGenerations);
      requirePinnedCoverage(pinned, missing, stale);
      const phrase = sanitizeFts5Phrase(trimmed);
      const candidates: LocatorCandidate[] = [];
      const contributing: PinnedGeneration[] = [];
      for (const pin of pinned) {
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
          if (!contributing.includes(pin)) contributing.push(pin);
          if (candidates.length >= limit) break;
        }
      }
      await recheckContributingPins(
        search, core, "lexical", contributing, members, ownerGenerations,
        request.scope_snapshot.expires_at, now(),
      );
      return candidates;
    },
  };
}
