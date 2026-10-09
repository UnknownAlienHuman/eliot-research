/** Header normalization and protected-header policy.
 *
 * The legacy transport in `packages/pwa-http-client/src/api.ts` builds request headers two ways:
 *
 *   the JSON transport merges caller input:  headers: { accept: 'application/json', ...init.headers }
 *   the binary transport ignores caller input: headers: { accept: expectedContentType }
 *
 * A record input merges as expected. The other two legal HeadersInit forms do not survive the legacy
 * spread: a `Headers` instance contributes no own enumerable keys, and an iterable of pairs contributes
 * numeric index keys. This module preserves all three forms. The legacy spread also lets a caller
 * override `accept`; here a conflicting protected header is rejected instead of silently replaced.
 */

export interface ProtectedHeader {
  readonly name: string;
  readonly value: string;
}

/** Thrown when a caller supplies a value for a header this transport owns.
 *
 * C1.3 owns errors shared across the package. This is a transport-local error because it is raised by
 * a transport-local policy, and it is exported so callers can match on it without importing a shared
 * hierarchy that does not exist yet.
 */
export class HeaderConflictError extends Error {
  public readonly status = 400;
  public readonly code = 'API_HEADER_CONFLICT';
  public readonly header: string;

  public constructor(header: string) {
    super(`Caller must not set the protected header ${header}`);
    this.name = 'HeaderConflictError';
    this.header = header;
  }
}

/**
 * Every accepted HeadersInit form, normalized to lowercased name and value pairs in first-seen order.
 *
 * A blank value is preserved, not dropped. An intentionally empty header is a real caller value and
 * removing it would change request meaning. `Headers.forEach` already folds duplicate names with a comma,
 * matching the legacy object-merge behavior for repeated record keys.
 */
export function normalizeHeadersInit(init: HeadersInit | undefined): readonly (readonly [string, string])[] {
  if (init === undefined || init === null) return [];

  if (typeof Headers !== 'undefined' && init instanceof Headers) {
    return pairsFromHeaders(init);
  }

  const iterable = init as Iterable<readonly [string, string]>;
  if (typeof iterable === 'object' && iterable !== null && typeof iterable[Symbol.iterator] === 'function') {
    return pairsFromEntries(iterable);
  }

  return pairsFromRecord(init as Record<string, string>);
}

function pairsFromHeaders(headers: Headers): readonly (readonly [string, string])[] {
  const pairs: [string, string][] = [];
  headers.forEach((value, name) => { pairs.push([name.toLowerCase(), value]); });
  return pairs;
}

function pairsFromEntries(entries: Iterable<readonly [string, string]>): readonly (readonly [string, string])[] {
  const pairs: [string, string][] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError('Header entries must be name and value pairs');
    }
    const name = entry[0];
    const value = entry[1];
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw new TypeError('Header entries must be name and value pairs');
    }
    pairs.push([name.toLowerCase(), value]);
  }
  return pairs;
}

function pairsFromRecord(record: Record<string, string>): readonly (readonly [string, string])[] {
  const pairs: [string, string][] = [];
  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== 'string') {
      // A caller may pass a record carrying a non-string value from untyped code at runtime. Silently
      // skipping it would let the request proceed without a header the caller intended to send.
      throw new TypeError(`Header ${name} must be a string`);
    }
    pairs.push([name.toLowerCase(), value]);
  }
  return pairs;
}

/**
 * Merge caller headers with the headers this transport protects.
 *
 * A caller who supplies a value for a protected header gets a rejection, never a silent overwrite: a
 * caller who believes their `accept` was honored would otherwise debug a request that was quietly
 * changed. Non-protected caller headers are appended as given.
 */
export function mergeProtectedHeaders(
  init: HeadersInit | undefined,
  protectedHeaders: readonly ProtectedHeader[],
): Headers {
  const caller = normalizeHeadersInit(init);
  for (const entry of protectedHeaders) {
    const wanted = entry.name.toLowerCase();
    // Every occurrence must agree, not only the first. An iterable form may repeat a name, and a
    // matching first occurrence followed by a conflicting second would otherwise let a hostile caller
    // choose which value the transport observes while appearing to honor the protected header.
    for (const [name, value] of caller) {
      if (name === wanted && value !== entry.value) throw new HeaderConflictError(wanted);
    }
  }
  const merged = new Headers();
  for (const [name, value] of caller) merged.append(name, value);
  for (const entry of protectedHeaders) merged.set(entry.name.toLowerCase(), entry.value);
  return merged;
}
