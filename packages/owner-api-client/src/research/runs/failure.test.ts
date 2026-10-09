import { describe, expect, it } from 'vitest';
import { createResearchFailureDecoder } from './failure';
import { OwnerClientError } from '../../transport/client';

const errors = (details: { code: string; status: number; message: string }) =>
  new OwnerClientError({ code: details.code, message: details.message, status: details.status });
const decoder = createResearchFailureDecoder(errors);

const failure = (operation: () => unknown): { code: string; status: number } => {
  try {
    operation();
    throw new Error('expected a typed failure');
  } catch (error) {
    return { code: (error as OwnerClientError).code, status: (error as OwnerClientError).status };
  }
};

describe('research run failure decoder', () => {
  it('exposes the original decoder names and keeps the first cause', () => {
    expect(decoder.engineStatus('queued')).toBe('queued');
    expect(decoder.engineStatus('waitingForPause')).toBe('waitingForPause');
    expect(failure(() => decoder.engineStatus('nope')).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(decoder.researchRunFailure({ code: 'WORKFLOW_INPUT_INVALID' })).toEqual({ code: 'WORKFLOW_INPUT_INVALID' });
    const viewed = decoder.researchRunFailure({ code: 'WORKFLOW_OUTPUT_CORRUPT', consequence: { code: 'WORKFLOW_STORAGE_UNAVAILABLE' } }, true);
    expect(viewed.code).toBe('WORKFLOW_OUTPUT_CORRUPT');
    expect(viewed.consequence?.code).toBe('WORKFLOW_STORAGE_UNAVAILABLE');
  });

  it('pairs phase and stage and fences replay authorization', () => {
    expect(decoder.researchRunFailure({ code: 'WORKFLOW_PREPARATION_FAILED', stage: 'RETRIEVE_BRANCHES' }, true)).toEqual({ code: 'WORKFLOW_PREPARATION_FAILED', stage: 'RETRIEVE_BRANCHES' });
    expect(failure(() => decoder.researchRunFailure({ code: 'WORKFLOW_PREPARATION_FAILED', phase: 'PREPARATION', stage: 'RETRIEVE_BRANCHES' })).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(decoder.researchRunFailure({ code: 'WORKFLOW_STORAGE_UNAVAILABLE', phase: 'PREPARATION', retryable: true }, true))
      .toEqual({ code: 'WORKFLOW_STORAGE_UNAVAILABLE', phase: 'PREPARATION', retryable: true });
    expect(failure(() => decoder.researchRunFailure({ code: 'WORKFLOW_INPUT_INVALID', phase: 'PREPARATION', retryable: true })).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => decoder.researchRunFailure(
      { code: 'WORKFLOW_STORAGE_UNAVAILABLE', phase: 'PREPARATION', retryable: true, consequence: { code: 'WORKFLOW_STORAGE_UNAVAILABLE' } },
      true,
    )).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('rejects an unknown failure code and a non-record body', () => {
    expect(failure(() => decoder.researchRunFailure({ code: 'NOT_A_CODE' })).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => decoder.researchRunFailure(null)).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => decoder.researchRunFailure({ code: 'WORKFLOW_CANCELLED', extra: 1 })).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('accepts the versioned outcome tuple as one all-or-nothing unit', () => {
    const outcome = {
      code: 'WORKFLOW_EFFECT_UNCERTAIN',
      phase: 'RECOVERY',
      stage: 'RECONCILE',
      retryable: false,
      protocol: 'eliotr.workflow-failure-outcome.v1',
      dispatch_state: 'OUTCOME_UNKNOWN',
      references_intact: 'UNKNOWN',
      recovery_action: 'READBACK',
    };
    expect(decoder.researchRunFailure({ ...outcome }, true)).toEqual({ ...outcome });
    expect(failure(() => decoder.researchRunFailure({ ...outcome, dispatch_state: undefined }, true)).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => decoder.researchRunFailure({ ...outcome, protocol: 'eliotr.workflow-failure-outcome.v2' }, true)).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => decoder.researchRunFailure(
      { ...outcome, dispatch_state: 'OUTCOME_UNKNOWN', references_intact: 'INTACT', recovery_action: 'NONE' },
      true,
    )).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('keeps the first cause and an ordered bounded consequence list', () => {
    const first = { code: 'WORKFLOW_OUTPUT_CORRUPT', phase: 'RECOVERY', stage: 'RECONCILE', retryable: false };
    const second = { code: 'WORKFLOW_STORAGE_UNAVAILABLE', phase: 'PREPARATION', retryable: true };
    const third = { code: 'WORKFLOW_BUDGET_STOP', phase: 'STAGE', stage: 'PLAN', retryable: false };
    const view = decoder.researchRunFailure({ ...first, consequence: third, consequences: [third] }, true);
    expect(view.code).toBe('WORKFLOW_OUTPUT_CORRUPT');
    expect(view.consequence).toEqual(third);
    expect(view.consequences).toEqual([third]);
    const many = { ...first, consequences: Array.from({ length: 16 }, () => third) };
    expect(decoder.researchRunFailure(many, true).consequences).toHaveLength(16);
    expect(decoder.researchRunFailure({ ...first }, true)).toEqual(first);
    expect(failure(() => decoder.researchRunFailure({ ...first, consequence: 'x' }, true)).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => decoder.researchRunFailure({ ...first, consequences: 'x' }, true)).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(decoder.researchRunFailure({ ...first, consequence: second }, true).consequence).toEqual(second);
    expect(failure(() => decoder.researchRunFailure({ ...first, consequence: third, consequences: [second] }, true)).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });
});
