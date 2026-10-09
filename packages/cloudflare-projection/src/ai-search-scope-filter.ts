/** Projection-owned scope narrowing; exact evidence authorization still runs after retrieval. */
export interface AiSearchScopeFilter {
  readonly source_revision_ref: Readonly<{ readonly $in: readonly string[] }>;
  readonly projection_generation: string;
}

// AI Search indexes only the first 64 UTF-8 bytes of each string. Its Vectorize-style
// filter must fit strictly below 2048 compact JSON bytes. Never truncate an identity
// or silently omit a filter to accommodate a larger application scope.
// https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/
// https://developers.cloudflare.com/vectorize/reference/metadata-filtering/
const MAX_INDEXED_STRING_BYTES = 64;
const MAX_FILTER_BYTES = 2048;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;

function filterIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_INDEXED_STRING_BYTES || !IDENTIFIER.test(value)) {
    throw new RangeError("AI Search scope requires complete ASCII identifiers of 1 to 64 bytes");
  }
  return value;
}

/**
 * Compile only server-authorized frozen revision IDs and the selected index generation.
 * Empty membership is an empty $in, never a wildcard; callers must skip provider I/O.
 * A nonrepresentable scope is refused, not partitioned into unbudgeted provider calls.
 */
export function createAiSearchScopeFilter(
  sourceRevisionRefs: readonly string[],
  projectionGeneration: string,
): AiSearchScopeFilter {
  const generation = filterIdentifier(projectionGeneration);
  if (!Array.isArray(sourceRevisionRefs)) throw new RangeError("AI Search scope must be an array");
  const members: string[] = [];
  const seen = new Set<string>();
  const filter = { source_revision_ref: { $in: members }, projection_generation: generation };
  // All accepted identifiers are ASCII and need no JSON escaping. Count the complete
  // serialized envelope incrementally so oversized inputs fail without building a large filter.
  let bytes = JSON.stringify(filter).length;
  for (const value of sourceRevisionRefs) {
    const member = filterIdentifier(value);
    if (seen.has(member)) throw new RangeError("AI Search scope contains duplicate revisions");
    bytes += member.length + 2 + (members.length === 0 ? 0 : 1);
    if (bytes >= MAX_FILTER_BYTES) {
      throw new RangeError("AI Search scope filter must be smaller than 2048 bytes; no query was dispatched");
    }
    seen.add(member);
    members.push(member);
  }
  members.sort();
  return Object.freeze({
    source_revision_ref: Object.freeze({ $in: Object.freeze(members) }),
    projection_generation: generation,
  });
}
