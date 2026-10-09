import { describe, expect, it, vi } from 'vitest';
import { createResearchRunsApi, type ResearchRunRequest } from './authority';
import { OwnerClientError } from '../../transport/client';
import { createSessionEpoch, type SessionEpoch } from '../../transport/session/epoch';

const errors = (details: { code: string; status: number; message: string; retryable?: boolean }) =>
  new OwnerClientError({ code: details.code, message: details.message, status: details.status, retryable: details.retryable ?? false });

const status = (overrides: Record<string, unknown> = {}) => ({
  data: {
    protocol: 'eliotr.research-run-status.v2',
    workflow_instance_id: 'wf-1',
    investigation_ref: { id: 'inv-1', revision: 2 },
    execution_state: 'ACTIVE',
    next_stage_index: 3,
    answer: { availability: 'unavailable' },
    ...overrides,
  },
  trace_id: 'trace-1',
  deployment_generation: 'dep-1',
});

const build = (raw: unknown, statuses: readonly number[], epoch: SessionEpoch, sink: { path: string; init: RequestInit | undefined }[] = []) => {
  const request: ResearchRunRequest = vi.fn(async (path: string, init: RequestInit | undefined, accepted: readonly number[]) => {
    sink.push({ path, init });
    if (!accepted.some((value) => statuses.includes(value))) throw new Error('unexpected status policy');
    return raw;
  });
  return { api: createResearchRunsApi({ request, errors, epoch }), sink };
};

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
    throw new Error('expected a typed failure');
  } catch (error) {
    return error as OwnerClientError;
  }
};

const launch = (workflowId = 'wf-1') => ({
  data: {
    investigation_ref: { id: 'inv-1', revision: 1 },
    workflow_instance_id: workflowId,
  },
  trace_id: 'trace-1',
  deployment_generation: 'dep-1',
});

describe('C3-RR run authority', () => {
  it('builds the admission body with the original scope rules', () => {
    const { api } = build(null, [200], createSessionEpoch());
    const body = api.researchRunBody('what changed?', ['src-1', 'src-2'], 8);
    expect(JSON.parse(body)).toEqual({
      query: 'what changed?',
      product: 'RESEARCH',
      scope_expression: { kind: 'SELECTED_SOURCES', source_ids: ['src-1', 'src-2'] },
      literals: [],
      evidence_grade: 'E0',
      budget_ref: 'research-budget-v1',
      max_results: 8,
    });
    expect(JSON.parse(api.researchRunBody('q', [], 4, 'proj-1')).scope_expression).toEqual({ kind: 'PROJECT', project_id: 'proj-1' });
    expect(JSON.parse(api.researchRunBody('q', [])).scope_expression).toEqual({ kind: 'GLOBAL_LIBRARY' });
    expect(() => api.researchRunBody('q', [], 17)).toThrow();
    expect(() => api.researchRunBody('q', ['a', 'a'])).toThrow();
    expect(() => api.researchRunBody('q', ['a'], 4, 'proj-1')).toThrow();
  });

  it('rejects a bare carriage return and an oversized UTF-8 body', () => {
    const { api } = build(null, [200], createSessionEpoch());
    expect(() => api.researchRunBody('line\rnext', [])).toThrow();
    const oversized = 'x'.repeat(300_000);
    const error = (() => {
      try {
        api.researchRunBody(oversized, []);
        throw new Error('expected a typed failure');
      } catch (caught) {
        return caught as OwnerClientError;
      }
    })();
    expect(error.code).toBe('RESEARCH_INPUT_LIMIT');
    expect(error.status).toBe(413);
  });

  it('preserves the status fences, headers and identity check', async () => {
    const epoch = createSessionEpoch();
    const { api, sink } = build(status(), [200], epoch);
    const view = await api.readResearchRunStatus('wf-1', 'dep-1');
    expect(view.execution_state).toBe('ACTIVE');
    expect(view.engine_status).toBe('unknown');
    expect(sink[0]?.path).toBe('/api/v1/research/run/wf-1');
    expect(status({ execution_state: 'COMPLETE' }));
    expect(api.decodeResearchRunStatus(status(), 'dep-1').execution_state).toBe('ACTIVE');
  });

  it('rejects a mismatched run identity and a changed deployment generation', async () => {
    const epoch = createSessionEpoch();
    const mismatch = build(status({ workflow_instance_id: 'wf-2' }), [200], epoch);
    expect((await failure(mismatch.api.readResearchRunStatus('wf-1'))).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    const changed = build(status(), [200], createSessionEpoch());
    const error = await failure(changed.api.readResearchRunStatus('wf-1', 'dep-2'));
    expect(error.code).toBe('RESEARCH_RUN_DEPLOYMENT_CHANGED');
    expect(error.status).toBe(409);
  });

  it('observes cancellation as an exact receipt, never as a cancel verb', async () => {
    const cancelled = build(status({ execution_state: 'CANCELLED', cancellation_receipt_ref: 'workflow-cancelled:wf-1', next_stage_index: 18 }), [200], createSessionEpoch());
    const view = await cancelled.api.readResearchRunStatus('wf-1');
    expect(view.execution_state).toBe('CANCELLED');
    const foreign = build(status({ execution_state: 'CANCELLED', cancellation_receipt_ref: 'workflow-cancelled:wf-9' }), [200], createSessionEpoch());
    expect((await failure(foreign.api.readResearchRunStatus('wf-1'))).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    const wrongState = build(status({ cancellation_receipt_ref: 'workflow-cancelled:wf-1' }), [200], createSessionEpoch());
    expect((await failure(wrongState.api.readResearchRunStatus('wf-1'))).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('requires an errored active run before a failure view is accepted', async () => {
    const withFailure = build(status({ engine_status: 'errored', failure: { code: 'WORKFLOW_OUTPUT_CORRUPT' } }), [200], createSessionEpoch());
    const view = await withFailure.api.readResearchRunStatus('wf-1');
    expect(view.failure?.code).toBe('WORKFLOW_OUTPUT_CORRUPT');
    const idle = build(status({ engine_status: 'running', failure: { code: 'WORKFLOW_OUTPUT_CORRUPT' } }), [200], createSessionEpoch());
    expect((await failure(idle.api.readResearchRunStatus('wf-1'))).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('fences admission on the shared epoch before and after the request', async () => {
    const epoch = createSessionEpoch();
    const admission = build(launch(), [200, 201], epoch);
    const launched = await admission.api.startResearchRun(api_body(), 'op-1', 'dep-1');
    expect(launched.workflow_instance_id).toBe('wf-1');
    expect(new Headers(admission.sink[0]?.init?.headers).get('idempotency-key')).toBe('op-1');
    const stale = build(launch(), [200, 201], epoch);
    const request = stale.api;
    const pending = request.startResearchRun(api_body(), 'op-1', 'dep-1');
    epoch.advance();
    const error = await failure(pending);
    expect(error.code).toBe('API_SESSION_CLOSED');
    expect(error.status).toBe(503);
  });
});

function api_body(): string {
  return JSON.stringify({ question: 'q', scope: { kind: 'GLOBAL_LIBRARY' }, max_results: 4 });
}
