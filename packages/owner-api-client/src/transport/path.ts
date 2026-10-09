const CONTROL_CHARACTERS = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x20) + String.fromCharCode(0x7f) + ']',
  'u',
);
const API_PREFIX = '/api/v1/';
const NOMINAL_ORIGIN = 'https://nominal.invalid';
const BACKSLASH = String.fromCharCode(92);
const HASH = String.fromCharCode(35);

export const API_PATH_INVALID_MESSAGE = 'Invalid API path';

/** Typed path error.
 *
 * The owner client cannot depend on the legacy ApiRequestError class, because that would pair two error
 * hierarchies. `code` is the stable contract the legacy code already exposes and the value call sites
 * match on. Errors shared across this package belong to C1.3 and are deliberately not defined here.
 */
export class OwnerApiPathError extends Error {
  public readonly status = 400;
  public readonly code = 'API_PATH_INVALID';

  public constructor(message: string = API_PATH_INVALID_MESSAGE) {
    super(message);
    this.name = 'OwnerApiPathError';
  }
}

/**
 * Legal only when all of the following hold:
 *
 * - the path is root-relative and stays under the versioned owner API prefix;
 * - it carries no hash marker, no backslash, and no character from NUL through space or DEL;
 * - resolving it against a nominal origin yields a pathname identical to its pre-query portion.
 *
 * The last condition defeats encoded and decoded parent segments before any credential is attached. The
 * explicit backslash and hash checks are not redundant with pathname comparison: a query string survives
 * that comparison, so without them a backslash or a hash marker inside the query would pass here while
 * the legacy guard rejects it.
 */
export function isSameOriginApiPath(path: string): boolean {
  if (typeof path !== 'string') return false;
  if (!path.startsWith(API_PREFIX)) return false;
  if (path.includes(BACKSLASH) || path.includes(HASH)) return false;
  if (CONTROL_CHARACTERS.test(path)) return false;
  try {
    return new URL(path, NOMINAL_ORIGIN).pathname === path.split('?')[0];
  } catch {
    return false;
  }
}

/** Throws the typed error call sites already understand. */
export function assertSameOriginApiPath(path: string): void {
  if (!isSameOriginApiPath(path)) throw new OwnerApiPathError();
}
