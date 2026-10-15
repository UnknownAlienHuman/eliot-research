import {
  decodeUnresolvedLocatorCandidates,
  type RetrievalRequest,
  type UnresolvedLocatorCandidate,
} from "@eliotr/retrieval";

const MAX_RESULTS = 50;
const MAX_PREVIEW_BYTES = 64 * 1024;
const MAX_ITEM_KEY_BYTES = 256;
const TAINTS = new Set(["CLEARED", "DATA_ONLY", "UNTRUSTED", "COMMAND_LIKE"]);

export class AiSearchLocatorDecodeError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AiSearchLocatorDecodeError";
  }
}

/** Decodes provider locators only after the project-scoped adapter has attached canonical D1 metadata. */

export function decodeAiSearchSearchResult(
  request: RetrievalRequest,
  rawResult: unknown,
  maxResults = MAX_RESULTS,
): readonly UnresolvedLocatorCandidate[] {
  if (!isRecord(rawResult) || !Array.isArray(rawResult.chunks)) {
    fail("Cloudflare AI Search result must contain a chunks array");
  }
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    fail("Cloudflare AI Search result limit is invalid");
  }
  if (rawResult.chunks.length > maxResults) {
    fail("Cloudflare AI Search returned more chunks than requested");
  }

  const seen = new Set<string>();
  const candidates = rawResult.chunks.map((raw, index) => {
    const candidate = mapAiSearchChunkToLocator(request, raw, index + 1);
    if (seen.has(candidate.candidate_id)) fail("Cloudflare AI Search returned duplicate chunk ids");
    seen.add(candidate.candidate_id);
    return candidate;
  });
  return Object.freeze(candidates);
}

function mapAiSearchChunkToLocator(
  request: RetrievalRequest,
  rawChunk: unknown,
  rank: number,
): UnresolvedLocatorCandidate {
  if (!isRecord(rawChunk) || !isRecord(rawChunk.item) || !isRecord(rawChunk.item.metadata)) {
    fail("Cloudflare AI Search chunk is malformed");
  }
  const metadata = rawChunk.item.metadata;
  const id = requiredString(rawChunk.id, "chunk id", 256);
  const itemKey = requiredString(rawChunk.item.key, "item key", MAX_ITEM_KEY_BYTES);
  const canonicalSectionId = requiredString(metadata.canonical_section_id, "canonical section id", 256);
  const sourceRevisionRef = requiredString(metadata.source_revision_ref, "source revision", 256);
  const projectionGeneration = requiredString(metadata.projection_generation, "projection generation", 256);
  const contentSha256 = requiredString(metadata.content_sha256, "content digest", 64);
  const instructionTaint = requiredString(metadata.instruction_taint, "instruction taint", 32);
  const text = requiredString(rawChunk.text, "chunk text", MAX_PREVIEW_BYTES);
  if (rawChunk.type !== "text" || typeof rawChunk.score !== "number" ||
      !Number.isFinite(rawChunk.score) || rawChunk.score < 0 || rawChunk.score > 1) {
    fail("Cloudflare AI Search chunk type or score is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(contentSha256) || !TAINTS.has(instructionTaint)) {
    fail("Cloudflare AI Search section metadata is invalid");
  }
  if (!request.scope_snapshot.member_source_revision_refs.includes(sourceRevisionRef)) {
    fail("Cloudflare AI Search result is outside the frozen source scope");
  }
  const itemLeaf = itemKey.slice(itemKey.lastIndexOf("/") + 1);
  const canonicalItemKey = itemLeaf.endsWith(".md") ? itemLeaf.slice(0, -3) : itemLeaf;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,124}$/u.test(canonicalItemKey)) {
    fail("Cloudflare AI Search item key is invalid");
  }

  const value = {
    candidate_id: id,
    lane: "SEM",
    source_revision_ref: sourceRevisionRef,
    canonical_section_id: canonicalSectionId,
    preview: text,
    raw_score: rawChunk.score,
    rank,
    index_generation: projectionGeneration,
    metadata: {
      content_sha256: contentSha256,
      instruction_taint: instructionTaint,
      item_key: canonicalItemKey,
      projection_generation: projectionGeneration,
      provider: "cloudflare_ai_search",
      provider_chunk_type: "text",
      provider_item_key: itemKey,
    },
  };
  try {
    const decoded = decodeUnresolvedLocatorCandidates([value], {
      max_results: 1,
      max_preview_bytes: MAX_PREVIEW_BYTES,
    })[0];
    if (decoded === undefined) fail("Cloudflare AI Search locator decoding returned no candidate");
    return decoded;
  } catch (cause) {
    if (cause instanceof AiSearchLocatorDecodeError) throw cause;
    throw new AiSearchLocatorDecodeError("Cloudflare AI Search locator is invalid", cause);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 ||
      new TextEncoder().encode(value).byteLength > maxBytes) {
    fail(`Cloudflare AI Search ${label} is invalid`);
  }
  return value;
}

function fail(message: string): never {
  throw new AiSearchLocatorDecodeError(message);
}
