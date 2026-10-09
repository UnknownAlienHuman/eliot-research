import { describe, expect, it } from 'vitest';
import { decodeProblemBody, isProblemStatus, problemBudget, readProblemBody } from './problem.js';

/**
 * Field set, bounds and the HTTP status match are frozen from `decodeApiProblem` in
 * `packages/pwa-http-client/src/api.ts`. Any drift in shape is a rejection, not a normalization.
 */

function problem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'urn:eliotr:problem:denied',
    title: 'Read denied',
    status: 403,
    code: 'DENIED',
    trace_id: 'trace-1',
    retryable: false,
    ...overrides,
  };
}

describe('bounded problem reader', () => {
  it('a document-sized declared problem fails before consuming the body', async () => {
    const response = new Response(JSON.stringify(problem()), { status: 403, headers: { 'content-type': 'application/json', 'content-length': '20000' } });
    await expect(readProblemBody(response)).rejects.toMatchObject({ code: 'API_RESPONSE_TOO_LARGE' });
    expect(response.bodyUsed).toBe(false);
  });
  it('rejects HTML before reading and accepts only exact typed problem JSON', async () => {
    const html = new Response('<html>denied</html>', { status: 403, headers: { 'content-type': 'text/html' } });
    await expect(readProblemBody(html)).rejects.toMatchObject({ code: 'API_RESPONSE_SCHEMA_MISMATCH' });
    expect(html.bodyUsed).toBe(false);
    expect(await readProblemBody(new Response(JSON.stringify(problem()), { status: 403, headers: { 'content-type': 'application/json' } }))).toMatchObject({ code: 'DENIED', status: 403 });
  });
});

describe('problem decoder', () => {
  it('accepts the exact field set', () => {
    expect(decodeProblemBody(problem(), 403)).toEqual({
      type: 'urn:eliotr:problem:denied',
      title: 'Read denied',
      status: 403,
      code: 'DENIED',
      traceId: 'trace-1',
      retryable: false,
    });
  });

  it.each([
    ['an unknown extra field', { unexpected: true }],
    ['a missing field', undefined],
  ])('rejects %s', (_label, override) => {
    const body = problem();
    if (override !== undefined) {
      for (const [key, value] of Object.entries(override)) body[key] = value;
    } else {
      delete body.retryable;
    }
    expect(() => decodeProblemBody(body, 403)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_API_PROBLEM' }),
    );
  });

  it('rejects a non-object body', () => {
    expect(() => decodeProblemBody('text', 403)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_API_PROBLEM' }),
    );
    expect(() => decodeProblemBody([], 403)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_API_PROBLEM' }),
    );
    expect(() => decodeProblemBody(null, 403)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_API_PROBLEM' }),
    );
  });

  it('rejects a problem type outside the Eliot namespace', () => {
    expect(() => decodeProblemBody(problem({ type: 'urn:other:problem:denied' }), 403)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_API_PROBLEM' }),
    );
  });

  it('rejects a problem status that disagrees with the HTTP status', () => {
    expect(() => decodeProblemBody(problem({ status: 500 }), 503)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_API_PROBLEM' }),
    );
  });

  it('rejects a status outside the error range', () => {
    expect(() => decodeProblemBody(problem({ status: 200 }), 200)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_API_PROBLEM' }),
    );
  });

  it('rejects a missing retryable flag', () => {
    const body = problem();
    delete body.retryable;
    expect(() => decodeProblemBody(body, 403)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_API_PROBLEM' }),
    );
  });

  it('rejects an invalid trace id', () => {
    expect(() => decodeProblemBody(problem({ trace_id: 'bad trace' }), 403)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_API_PROBLEM' }),
    );
  });

  it('preserves a retryable problem flag', () => {
    expect(decodeProblemBody(problem({ retryable: true }), 403).retryable).toBe(true);
  });
});

describe('problem helpers', () => {
  it('keeps the problem budget fixed and independent of the success budget', () => {
    expect(problemBudget()).toBe(16 * 1024);
  });

  it('recognizes only statuses that may carry a problem body', () => {
    expect(isProblemStatus(400)).toBe(true);
    expect(isProblemStatus(599)).toBe(true);
    expect(isProblemStatus(200)).toBe(false);
    expect(isProblemStatus(600)).toBe(false);
    expect(isProblemStatus(399)).toBe(false);
  });
});
