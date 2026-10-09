import { describe, expect, it } from 'vitest';
import {
  HeaderConflictError,
  mergeProtectedHeaders,
  normalizeHeadersInit,
  type ProtectedHeader,
} from './headers.js';

/**
 * Protected headers are the accepted media type of the GET transport plus the mutation identity names
 * the legacy call sites actually send: `content-type`, `x-eliotr-csrf`, `idempotency-key` and
 * `x-eliotr-content-sha256` in project-api.ts, source-namespace-api.ts, erasure-api.ts and
 * raw-file-api.ts. No name is invented; anything C1.2 or C1.3 needs is added against a real call site.
 */

const ACCEPT_JSON: readonly ProtectedHeader[] = [
  { name: 'accept', value: 'application/json' },
];
const MUTATION: readonly ProtectedHeader[] = [
  ...ACCEPT_JSON,
  { name: 'content-type', value: 'application/json' },
  { name: 'x-eliotr-csrf', value: '1' },
  { name: 'idempotency-key', value: 'raw-upload-key' },
  { name: 'x-eliotr-content-sha256', value: 'a'.repeat(64) },
];

describe('HeadersInit normalization', () => {
  it('treats a missing init as no caller headers', () => {
    expect(normalizeHeadersInit(undefined)).toEqual([]);
    expect(normalizeHeadersInit(null as unknown as HeadersInit)).toEqual([]);
  });

  it('lowercases record names and keeps values', () => {
    expect(normalizeHeadersInit({ 'Content-Type': 'application/json' }))
      .toEqual([['content-type', 'application/json']]);
  });

  it('preserves an empty caller value, because empty is not absence', () => {
    expect(normalizeHeadersInit({ 'x-eliotr-trace': '' }))
      .toEqual([['x-eliotr-trace', '']]);
    expect(normalizeHeadersInit(new Headers({ 'x-eliotr-trace': '' })))
      .toEqual([['x-eliotr-trace', '']]);
  });

  it('preserves every header carried by a Headers instance', () => {
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    headers.set('x-eliotr-csrf', '1');
    expect(normalizeHeadersInit(headers)).toEqual([
      ['content-type', 'application/json'],
      ['x-eliotr-csrf', '1'],
    ]);
  });

  it('preserves header tuples instead of corrupting them into indices', () => {
    const tuples: [string, string][] = [
      ['content-type', 'application/json'],
      ['x-eliotr-csrf', '1'],
    ];
    expect(normalizeHeadersInit(tuples)).toEqual([
      ['content-type', 'application/json'],
      ['x-eliotr-csrf', '1'],
    ]);
  });

  it('folds duplicate names the way Headers does', () => {
    const headers = new Headers();
    headers.append('accept', 'text/plain');
    headers.append('accept', 'text/html');
    expect(normalizeHeadersInit(headers)).toEqual([['accept', 'text/plain, text/html']]);
  });

  it('rejects entries that are not name and value pairs', () => {
    expect(() => normalizeHeadersInit([['only-a-name'] as unknown as [string, string]])).toThrow(TypeError);
    expect(() => normalizeHeadersInit([['x-a', 7] as unknown as [string, string]])).toThrow(TypeError);
  });

  it('rejects a record carrying a non-string value instead of dropping it', () => {
    // Unreachable through the type signature, reachable through untyped runtime input. Dropping the
    // entry would let a request proceed without a header the caller meant to send.
    expect(() => normalizeHeadersInit({ 'x-eliotr-trace': 7 as unknown as string })).toThrow(TypeError);
  });
});

describe('protected header merge', () => {
  it('applies protected headers when the caller sends none', () => {
    const merged = mergeProtectedHeaders(undefined, ACCEPT_JSON);
    expect(merged.get('accept')).toBe('application/json');
  });

  it('lets a caller add a header that is not protected', () => {
    const merged = mergeProtectedHeaders({ 'x-eliotr-note': 'keep' }, ACCEPT_JSON);
    expect(merged.get('x-eliotr-note')).toBe('keep');
    expect(merged.get('accept')).toBe('application/json');
  });

  it.each([
    ['a record', { accept: 'text/html' }],
    ['a Headers instance', (() => {
      const hostile = new Headers();
      hostile.set('accept', 'text/html');
      return hostile;
    })()],
    ['header tuples', [['accept', 'text/html']]],
  ])('rejects a conflicting protected accept sent through %s', (_label, init) => {
    expect(() => mergeProtectedHeaders(init as HeadersInit, ACCEPT_JSON)).toThrow(HeaderConflictError);
  });

  it('rejects a conflicting protected content-type and idempotency-key', () => {
    expect(() => mergeProtectedHeaders({ 'content-type': 'text/plain' }, MUTATION))
      .toThrow(HeaderConflictError);
    expect(() => mergeProtectedHeaders({ 'idempotency-key': 'raw-upload-key-2' }, MUTATION))
      .toThrow(HeaderConflictError);
    expect(() => mergeProtectedHeaders({ 'x-eliotr-csrf': '0' }, MUTATION))
      .toThrow(HeaderConflictError);
  });

  it('accepts a caller who repeats the protected value unchanged', () => {
    const merged = mergeProtectedHeaders({ accept: 'application/json' }, ACCEPT_JSON);
    expect(merged.get('accept')).toBe('application/json');
  });

  it('names the conflicting header and exposes the transport code', () => {
    let caught: unknown;
    try {
      mergeProtectedHeaders({ accept: 'text/html' }, ACCEPT_JSON);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HeaderConflictError);
    expect(caught).toMatchObject({ status: 400, code: 'API_HEADER_CONFLICT', header: 'accept' });
    expect((caught as Error).name).toBe('HeaderConflictError');
  });

  it('rejects a conflicting second occurrence even when the first occurrence matches', () => {
    // A tuple form may repeat a name. Checking only the first occurrence would let a matching value
    // disguise a conflicting one behind it, so the transport would observe the hostile value while
    // appearing to honor the protected header.
    const spoofed: [string, string][] = [
      ['Accept', 'application/json'],
      ['accept', 'text/html'],
    ];
    expect(() => mergeProtectedHeaders(spoofed, ACCEPT_JSON)).toThrow(HeaderConflictError);
  });

  it('rejects a duplicate idempotency key whose second value differs', () => {
    const spoofed: [string, string][] = [
      ['idempotency-key', 'raw-upload-key'],
      ['idempotency-key', 'raw-upload-other'],
    ];
    expect(() => mergeProtectedHeaders(spoofed, MUTATION)).toThrow(HeaderConflictError);
  });

  it('applies every protected header with no caller conflict', () => {
    const merged = mergeProtectedHeaders(undefined, MUTATION);
    expect(merged.get('accept')).toBe('application/json');
    expect(merged.get('content-type')).toBe('application/json');
    expect(merged.get('x-eliotr-csrf')).toBe('1');
    expect(merged.get('idempotency-key')).toBe('raw-upload-key');
    expect(merged.get('x-eliotr-content-sha256')).toBe('a'.repeat(64));
  });

  it('looks up a protected header case-insensitively when the value agrees', () => {
    const merged = mergeProtectedHeaders({ Accept: 'application/json' }, ACCEPT_JSON);
    expect(merged.get('Accept')).toBe('application/json');
    expect(merged.has('ACCEPT')).toBe(true);
  });
});
