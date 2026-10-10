import { describe, expect, it } from 'vitest';
import { createResearchSessionProjectionDecoder } from './projection';
import { OwnerClientError } from '../../transport/client';

const errors = (details: { code: string; status: number; message: string }) =>
  new OwnerClientError({ code: details.code, message: details.message, status: details.status });
const decoder = createResearchSessionProjectionDecoder(errors);

const active = {
  protocol: 'eliotr.research-session-projection.v1',
  session_id: 'sess-1',
  operation_id: 'op-1',
  state: 'ACTIVE',
  investigation_ref: { id: 'inv-1', revision: 2 },
  run_status: { execution_state: 'ACTIVE', engine_status: 'running', next_stage_index: 3 },
};

const cancelled = {
  protocol: 'eliotr.research-session-projection.v1',
  session_id: 'sess-1',
  operation_id: 'op-1',
  state: 'CANCELLED',
  investigation_ref: { id: 'inv-1', revision: 2 },
  cancellation_receipt_ref: 'workflow-cancelled:wf-1',
};

const completed = {
  protocol: 'eliotr.research-session-projection.v1',
  session_id: 'sess-1',
  operation_id: 'op-1',
  state: 'ENGINE_COMPLETED',
  investigation_ref: { id: 'inv-1', revision: 2 },
  completion_receipt_ref: 'receipt-1',
  output_manifest_ref: 'manifest-1',
};

const failure = (operation: () => unknown): { code: string; status: number } => {
  try {
    operation();
    throw new Error('expected a typed failure');
  } catch (error) {
    return { code: (error as OwnerClientError).code, status: (error as OwnerClientError).status };
  }
};

describe('C3-RP projection decoder', () => {
  it('decodes each state of the strict union', () => {
    expect(decoder.decodeProjection(active).state).toBe('ACTIVE');
    expect(decoder.decodeProjection(cancelled).state).toBe('CANCELLED');
    expect(decoder.decodeProjection(completed).state).toBe('ENGINE_COMPLETED');
  });

  it('rejects an unknown field, an unknown state and a wrong nested shape', () => {
    expect(failure(() => decoder.decodeProjection({ ...active, extra: 1 })).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => decoder.decodeProjection({ ...active, state: 'RUNNING' })).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => decoder.decodeProjection({ ...active, protocol: 'eliotr.research-session-projection.v2' })).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => decoder.decodeProjection({ ...active, run_status: { execution_state: 'ACTIVE' } })).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => decoder.decodeProjection({ ...active, run_status: { ...active.run_status, engine_status: 'unknown' } })).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('requires the receipt field that belongs to each state', () => {
    const { cancellation_receipt_ref: _ignored, ...withoutReceipt } = cancelled;
    expect(failure(() => decoder.decodeProjection(withoutReceipt)).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    const { completion_receipt_ref: _drop, output_manifest_ref: _dropToo, ...incomplete } = completed;
    expect(failure(() => decoder.decodeProjection(incomplete)).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => decoder.decodeProjection({ ...cancelled, run_status: active.run_status })).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(failure(() => decoder.decodeProjection({ ...active, cancellation_receipt_ref: 'receipt' })).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('recognizes the expected 410 chat-history outcome and nothing else', () => {
    const disabled = Object.assign(new Error('disabled'), { code: 'SESSION_CHAT_HISTORY_DISABLED', status: 410 });
    expect(decoder.isChatHistoryDisabled(disabled)).toBe(true);
    expect(decoder.isChatHistoryDisabled(new Error('other'))).toBe(false);
    expect(decoder.isChatHistoryDisabled({ code: 'SESSION_CHAT_HISTORY_DISABLED' })).toBe(false);
  });
});
