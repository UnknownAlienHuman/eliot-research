import { describe, expect, it } from 'vitest';
import {
  API_PATH_INVALID_MESSAGE,
  OwnerApiPathError,
  assertSameOriginApiPath,
  isSameOriginApiPath,
} from './path.js';

/**
 * Preserves the legacy V1 transport policy and the two exact V2 model-settings resources consumed by
 * the owner UI. Other versioned paths remain denied; origin and normalization rules apply to both.
 */

const BACKSLASH = String.fromCharCode(92);
const HASH = String.fromCharCode(35);

/** A query string is legal and must survive the pathname comparison. */
const QUERY = '/api/v1/system/health?trace_id=trace-1';

describe('same-origin path policy', () => {
  it.each([
    ['a root-relative owner API path', '/api/v1/system/health'],
    ['a path with a query string', QUERY],
    ['an encoded identifier segment', '/api/v1/library/erasure/ref%2Frevision'],
    ['the versioned prefix alone', '/api/v1/'],
    ['a trailing-slash resource path', '/api/v1/system/health/'],
    ['the owner V2 provider catalog endpoint', '/api/v2/system/model-providers'],
    ['an exact V2 provider operation query', '/api/v2/system/model-providers?operation_id=11111111-1111-4111-8111-111111111111'],
    ['V2 owner visibility preferences', '/api/v2/system/model-provider-catalog-preferences?provider_id=opencode-go'],
  ])('accepts %s', (_label, path) => {
    expect(isSameOriginApiPath(path)).toBe(true);
  });

  it.each([
    ['an absolute foreign origin', 'https://elsewhere.example/api/v1/system/health'],
    ['a protocol-relative origin', '//elsewhere.example/api/v1/system/health'],
    ['a bare single slash', '/'],
    ['an unversioned API root', '/api/system/health'],
    ['a non-API route', '/docs/architecture'],
    ['a backslash separator', '/api/v1' + BACKSLASH + 'system' + BACKSLASH + 'health'],
    ['a backslash inside the query', '/api/v1/system/health?next=' + BACKSLASH + BACKSLASH],
    ['an encoded parent segment', '/api/v1/%2e%2e/system/health'],
    ['a decoded parent segment', '/api/v1/../system/health'],
    ['a fragment marker', '/api/v1/system/health#section'],
    ['a fragment marker inside the query value', '/api/v1/system/health?next=' + HASH],
    ['a NUL character', '/api/v1/system' + String.fromCharCode(0) + '/health'],
    ['a control character', '/api/v1/syst' + String.fromCharCode(0x1f) + 'em/health'],
    ['a space character', '/api/v1/sys tem/health'],
    ['a DEL character', '/api/v1/system/health' + String.fromCharCode(0x7f)],
    ['a different-case prefix', '/API/V1/system/health'],
    ['an unapproved V2 route', '/api/v2/system/health'],
    ['an unapproved V2 provider child path', '/api/v2/system/model-providers/other'],
    ['a V2 path prefix collision', '/api/v2/system/model-providers-other'],
    ['a V2 parent segment', '/api/v2/system/model-providers/../model-providers'],
    ['a V2 foreign origin', 'https://elsewhere.example/api/v2/system/model-providers'],
    ['a V2 query fragment', '/api/v2/system/model-providers?value=' + HASH],
  ])('rejects %s', (_label, path) => {
    expect(isSameOriginApiPath(path)).toBe(false);
  });

  it('rejects a non-string input rather than coercing it', () => {
    expect(isSameOriginApiPath(undefined as unknown as string)).toBe(false);
    expect(isSameOriginApiPath(null as unknown as string)).toBe(false);
    expect(isSameOriginApiPath(42 as unknown as string)).toBe(false);
  });
});

describe('assert helper', () => {
  it('does not throw for a legal path', () => {
    expect(() => assertSameOriginApiPath('/api/v1/system/health')).not.toThrow();
  });

  it('throws the typed transport error for an illegal path', () => {
    let caught: unknown;
    try {
      assertSameOriginApiPath('/api/v1/%2e%2e/system/health');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OwnerApiPathError);
    expect(caught).toMatchObject({ status: 400, code: 'API_PATH_INVALID' });
    expect((caught as Error).message).toBe(API_PATH_INVALID_MESSAGE);
    expect((caught as Error).name).toBe('OwnerApiPathError');
  });
});
