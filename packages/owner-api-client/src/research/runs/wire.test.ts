import { describe, expect, it } from 'vitest';
import { createResearchRunWire } from './wire';
import { OwnerClientError } from '../../transport/client';

const errors = (details: { code: string; status: number; message: string; traceId: string | null; retryable: boolean }) =>
  new OwnerClientError({ code: details.code, message: details.message, status: details.status, ...(details.traceId === null ? {} : { traceId: details.traceId }), retryable: details.retryable });
const wire = createResearchRunWire(errors);
const envelope = (data: unknown, deploymentGeneration = 'dep-1', traceId = 'trace-1') => ({
  data,
  trace_id: traceId,
  deployment_generation: deploymentGeneration,
});

const failure = (operation: () => unknown): { code: string; status: number; retryable: boolean } => {
  try {
    operation();
    throw new Error('expected a typed failure');
  } catch (error) {
    return { code: (error as OwnerClientError).code, status: (error as OwnerClientError).status, retryable: (error as OwnerClientError).retryable };
  }
};

describe('research run wire', () => {
  it('accepts a well-formed envelope and exposes every original helper name', () => {
    const parsed = wire.envelope(envelope({ ok: true }));
    expect(parsed.deployment_generation).toBe('dep-1');
    expect(parsed.data).toEqual({ ok: true });
    for (const name of ['invalid', 'objectRecord', 'record', 'boundedString', 'isoTimestamp', 'identifier', 'versionedRef', 'sameRef', 'envelope', 'checkGeneration']) {
      expect(wire).toHaveProperty(name);
    }
  });

  it('rejects unknown, missing and non-record shapes with the original code', () => {
    expect(wire.record({ a: 1 }, ['a'], [])).toEqual({ a: 1 });
    expect(failure(() => wire.record({ a: 1, b: 2 }, ['a'], [])).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => wire.envelope({ data: {} })).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => wire.boundedString(' x ', 'label')).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => wire.isoTimestamp('2026-10-09T00:00:00', 'label')).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(wire.isoTimestamp('2026-10-09T00:00:00.000Z', 'label')).toBe('2026-10-09T00:00:00.000Z');
  });

  it('carries the trace and generation rules unchanged', () => {
    expect(failure(() => wire.envelope(envelope({}, 'dep-1', 'bad trace'))).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    wire.checkGeneration('dep-1', undefined);
    wire.checkGeneration('dep-1', 'dep-1');
    const changed = failure(() => wire.checkGeneration('dep-2', 'dep-1'));
    expect(changed.code).toBe('RESEARCH_RUN_DEPLOYMENT_CHANGED');
    expect(changed.status).toBe(409);
    expect(changed.retryable).toBe(true);
  });
});
