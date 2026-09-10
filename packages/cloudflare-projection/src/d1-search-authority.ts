import { projectionDigest } from "./canonical.js";
import {
  IDENTIFIER, D1SearchLaneError, laneFail, assertIdentifier, assertSha256,
  assertSearchCurrent, type ValidatedSearchInput,
} from "./d1-search-input.js";

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
  // Retain active items with no span so validation rejects them rather than
  // silently hashing a joined subset while IDENT/LEX can still return the item.
  const result = await search
    .prepare(
      "SELECT p.item_key, p.canonical_section_id, p.content_sha256, " +
        "s.normalized_start_byte, s.normalized_end_byte " +
        "FROM projection_item p LEFT JOIN projection_span s ON s.item_key = p.item_key " +
        "AND s.source_revision_ref = p.source_revision_ref AND s.projection_generation = p.projection_generation " +
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

export interface PinnedGeneration {
  readonly source_revision_ref: string;
  readonly projection_generation: string;
  readonly receipt_ref: string;
  readonly readback_digest: string;
  readonly item_set_digest: string;
  readonly item_count: number;
}

/** Pin every in-scope revision to its current READY generation: receipt, guard, and live active rows. */
export async function pinReadyGenerations(
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
        item_set_digest: itemSetDigest,
        item_count: generationRow.item_count,
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

export interface D1SearchChannelReadback {
  readonly channel: "exact" | "lexical";
  readonly pinned: readonly PinnedGeneration[];
  readonly missing: readonly string[];
  readonly stale: readonly string[];
}

export interface D1ManagedSemanticReadback {
  readonly state: "ready" | "degraded" | "not_requested";
  readonly generation?: string;
  readonly receipt_ref?: string;
  readonly reason_codes: readonly string[];
}

interface ManagedSemanticRow {
  readonly state: unknown;
  readonly semantic_instance_id: unknown;
  readonly semantic_generation: unknown;
  readonly semantic_receipt_ref: unknown;
  readonly semantic_readback_digest: unknown;
  readonly reason_codes_json: unknown;
}

function storedReasonCodes(value: unknown): readonly string[] {
  if (typeof value !== "string") return ["MANAGED_INDEX_READBACK_FAILED"];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 64 || parsed.some((entry) => typeof entry !== "string" || !IDENTIFIER.test(entry))) {
      return ["MANAGED_INDEX_READBACK_FAILED"];
    }
    return [...new Set(parsed)];
  } catch {
    return ["MANAGED_INDEX_READBACK_FAILED"];
  }
}

/** Read durable managed-index settlement fields without probing the provider. */
export async function readD1ManagedSemanticReadback(
  core: D1Database,
  sourceRevisionRef: string,
  expectedInstanceId: string,
  expectedManagedGeneration: string,
): Promise<D1ManagedSemanticReadback> {
  const row = await core.prepare(
    "SELECT state, semantic_instance_id, semantic_generation, semantic_receipt_ref, " +
      "semantic_readback_digest, reason_codes_json FROM projection_generation " +
      "WHERE source_revision_ref=?1 ORDER BY updated_at DESC, projection_generation DESC LIMIT 1",
  ).bind(sourceRevisionRef).first<ManagedSemanticRow>();
  if (row === null) return { state: "not_requested", reason_codes: ["MANAGED_SEMANTIC_UNAVAILABLE"] };
  const reasons = storedReasonCodes(row.reason_codes_json);
  if (row.state !== "COMPLETED") {
    return { state: reasons.length === 0 ? "not_requested" : "degraded", reason_codes: reasons.length === 0 ? ["MANAGED_INDEX_NOT_COMPLETED"] : reasons };
  }
  try {
    const instance = assertIdentifier(row.semantic_instance_id, "stored semantic instance");
    const generation = assertIdentifier(row.semantic_generation, "stored semantic generation");
    const receipt = assertIdentifier(row.semantic_receipt_ref, "stored semantic receipt");
    assertSha256(row.semantic_readback_digest, "stored semantic readback digest");
    if (instance !== expectedInstanceId || generation !== expectedManagedGeneration) {
      return { state: "degraded", reason_codes: ["MANAGED_INDEX_READBACK_FAILED"] };
    }
    return { state: "ready", generation, receipt_ref: receipt, reason_codes: [] };
  } catch {
    return { state: "degraded", reason_codes: ["MANAGED_INDEX_READBACK_FAILED"] };
  }
}

function sameCoverage(
  left: Awaited<ReturnType<typeof pinReadyGenerations>>,
  right: Awaited<ReturnType<typeof pinReadyGenerations>>,
): boolean {
  const refs = (values: readonly string[]) => [...values].sort();
  if (JSON.stringify(refs(left.missing)) !== JSON.stringify(refs(right.missing)) ||
      JSON.stringify(refs(left.stale)) !== JSON.stringify(refs(right.stale)) ||
      left.pinned.length !== right.pinned.length) return false;
  const byRef = new Map(right.pinned.map((pin) => [pin.source_revision_ref, pin]));
  return left.pinned.every((pin) => {
    const match = byRef.get(pin.source_revision_ref);
    return match !== undefined && match.projection_generation === pin.projection_generation &&
      match.receipt_ref === pin.receipt_ref && match.readback_digest === pin.readback_digest &&
      match.item_set_digest === pin.item_set_digest && match.item_count === pin.item_count;
  });
}

/** Read active channel authority with a final generation and owner fence comparison. */
export async function readD1SearchChannelReadback(
  search: D1Database,
  core: D1Database,
  channel: "exact" | "lexical",
  members: readonly string[],
  ownerGenerations: Readonly<Record<string, string>>,
): Promise<D1SearchChannelReadback> {
  const first = await pinReadyGenerations(search, channel, members, ownerGenerations);
  for (const pin of first.pinned) {
    if (await checkCandidateFence(core, ownerGenerations, pin.source_revision_ref) !== "ok") {
      laneFail("SEARCH_INCOMPLETE", "source authority changed during readiness read");
    }
  }
  const final = await pinReadyGenerations(search, channel, members, ownerGenerations);
  if (!sameCoverage(first, final)) {
    laneFail("SEARCH_INCOMPLETE", "D1 Search generation changed during readiness read");
  }
  for (const pin of final.pinned) {
    if (await checkCandidateFence(core, ownerGenerations, pin.source_revision_ref) !== "ok") {
      laneFail("SEARCH_INCOMPLETE", "source authority changed during readiness read");
    }
  }
  return { channel, pinned: final.pinned, missing: final.missing, stale: final.stale };
}

export function requirePinnedCoverage(
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

export async function checkCandidateFence(
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

/** A purged source is excluded, but a purge or owner change during a read is not valid-empty. */
export async function captureSourceFences(
  core: D1Database, pins: readonly PinnedGeneration[], input: ValidatedSearchInput,
): Promise<ReadonlyMap<string, "ok" | "purged">> {
  const fences = new Map<string, "ok" | "purged">();
  for (const pin of pins) {
    fences.set(pin.source_revision_ref,
      await checkCandidateFence(core, input.owner_generations, pin.source_revision_ref));
  }
  return fences;
}

/** Settle every pin, including zero-hit members and members beyond the result limit. */
export async function settleSearchRead(
  search: D1Database, core: D1Database, channel: "exact" | "lexical",
  pins: readonly PinnedGeneration[], input: ValidatedSearchInput,
  fences: ReadonlyMap<string, "ok" | "purged">, now: () => number,
): Promise<void> {
  assertSearchCurrent(input, now);
  const current = await pinReadyGenerations(search, channel, input.members, input.owner_generations);
  for (const pin of pins) {
    const match = current.pinned.find((row) => row.source_revision_ref === pin.source_revision_ref);
    if (
      match === undefined || match.projection_generation !== pin.projection_generation ||
      match.receipt_ref !== pin.receipt_ref || match.readback_digest !== pin.readback_digest ||
      match.item_set_digest !== pin.item_set_digest || match.item_count !== pin.item_count
    ) {
      laneFail("SEARCH_INCOMPLETE", "D1 Search generation changed during readback");
    }
    const fence = await checkCandidateFence(core, input.owner_generations, pin.source_revision_ref);
    if (fence !== fences.get(pin.source_revision_ref)) {
      laneFail("SEARCH_INCOMPLETE", "source authority changed during D1 Search readback");
    }
  }
  // A clock value captured before awaited D1/digest work is not a completion-time fence.
  assertSearchCurrent(input, now);
}
