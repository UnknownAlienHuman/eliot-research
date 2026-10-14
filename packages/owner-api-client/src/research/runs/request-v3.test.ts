import { describe, expect, it } from 'vitest';
import { createResearchRunsApi, RESEARCH_RUN_REQUEST_V3, type ResearchRunConfigurationSelection, type ResearchRunV3Request } from './authority';
import { OwnerClientError } from '../../transport/client';
import { createSessionEpoch } from '../../transport/session/epoch';
import type { LegacyErrorDetails, LegacyErrorFactory } from '../../legacy/http';

/**
 * Owner research.run v3 configuration selector transport.
 *
 * The selector is owner transport metadata: it rides beside the seven canonical QueryRequest keys,
 * never inside the canonical request itself. `researchRunBodyV3` takes the caller's own validated
 * ScopeExpression - including a bounded multi-project UNION or INTERSECT that the four-argument
 * legacy form cannot express - plus its explicit configuration selection, and transmits both.
 */

const errors: LegacyErrorFactory = (details: LegacyErrorDetails) =>
  new OwnerClientError({ code: details.code, message: details.message, status: details.status,
    ...(details.traceId === null ? {} : { traceId: details.traceId }), retryable: details.retryable });

let dispatched = 0;
const api = createResearchRunsApi({
  request: (() => {
    dispatched += 1;
    throw new Error('the selector transport is decided before dispatch');
  }) as never,
  errors,
  epoch: createSessionEpoch(),
});

const selection: ResearchRunConfigurationSelection = {
  request_version: RESEARCH_RUN_REQUEST_V3,
  configuration_project_id: 'project-gamma',
};

/** The caller's own explicit multi-project union: PROJECT + PROJECT, not selected source ids. */
const callerUnion = {
  kind: 'UNION' as const,
  left: { kind: 'PROJECT' as const, project_id: 'project-alpha' },
  right: { kind: 'PROJECT' as const, project_id: 'project-beta' },
};

const thrown = (run: () => unknown): OwnerClientError => {
  try {
    run();
  } catch (error) {
    return error as OwnerClientError;
  }
  throw new Error('expected the call to be rejected before dispatch');
};

describe('research run v3 selector transport', () => {
  it('transmits the caller project UNION bytewise with its exact selector', () => {
    const body = api.researchRunBodyV3({ query: 'compare two projects?', scope_expression: callerUnion,
      selection, max_results: 16 });
    expect(JSON.parse(body)).toEqual({
      query: 'compare two projects?',
      product: 'RESEARCH',
      scope_expression: { kind: 'UNION', left: { kind: 'PROJECT', project_id: 'project-alpha' },
        right: { kind: 'PROJECT', project_id: 'project-beta' } },
      literals: [],
      evidence_grade: 'E0',
      budget_ref: 'research-budget-v1',
      max_results: 16,
      request_version: 'eliotr.research-run-request.v3',
      configuration_project_id: 'project-gamma',
    });
    // Bytewise: the wire body carries the union exactly as the caller supplied it.
    expect(body).toBe(JSON.stringify({
      query: 'compare two projects?',
      product: 'RESEARCH',
      scope_expression: { kind: 'UNION', left: { kind: 'PROJECT', project_id: 'project-alpha' },
        right: { kind: 'PROJECT', project_id: 'project-beta' } },
      literals: [],
      evidence_grade: 'E0',
      budget_ref: 'research-budget-v1',
      max_results: 16,
      request_version: 'eliotr.research-run-request.v3',
      configuration_project_id: 'project-gamma',
    }));
  });

  it('sends exactly the seven canonical keys plus the two transport keys', () => {
    const parsed = JSON.parse(api.researchRunBodyV3({ query: 'q', scope_expression: { kind: 'GLOBAL_LIBRARY' }, selection, max_results: 8 }));
    expect(Object.keys(parsed)).toEqual(['query', 'product', 'scope_expression', 'literals', 'evidence_grade',
      'budget_ref', 'max_results', 'request_version', 'configuration_project_id']);
    // The selector is transport metadata only: it is never an inquiry protocol reference.
    expect(Object.hasOwn(parsed, 'inquiry_protocol_ref')).toBe(false);
  });

  it('transmits a caller INTERSECT and a caller EXCEPT unchanged', () => {
    const intersect = { kind: 'INTERSECT' as const, left: callerUnion, right: { kind: 'SOURCE_CLASS' as const, source_class: 'journal' } };
    const except = { kind: 'EXCEPT' as const, left: callerUnion, right: { kind: 'PROJECT' as const, project_id: 'project-alpha' } };
    expect(JSON.parse(api.researchRunBodyV3({ query: 'q', scope_expression: intersect, selection })).scope_expression).toEqual(intersect);
    expect(JSON.parse(api.researchRunBodyV3({ query: 'q', scope_expression: except, selection })).scope_expression).toEqual(except);
  });

  it('keeps the legacy four-argument body byte-identical', () => {
    expect(api.researchRunBody('q', ['source-1'], 4, 'project-1'))
      .toBe('{"query":"q","product":"RESEARCH","scope_expression":{"kind":"INTERSECT","left":{"kind":"PROJECT","project_id":"project-1"},"right":{"kind":"SELECTED_SOURCES","source_ids":["source-1"]}},"literals":[],"evidence_grade":"E0","budget_ref":"research-budget-v1","max_results":4}');
    expect(Object.keys(JSON.parse(api.researchRunBody('q', [], 4, 'project-1'))))
      .toEqual(['query', 'product', 'scope_expression', 'literals', 'evidence_grade', 'budget_ref', 'max_results']);
    // A v1 and v2 body never carries the selector, even with a project in scope.
    expect(api.researchRunBody('q', [])).not.toContain('configuration_project_id');
  });

  it('accepts a standalone selector outside any scope authority check', () => {
    const standalone = api.researchRunBodyV3({ query: 'q', scope_expression: { kind: 'GLOBAL_LIBRARY' },
      selection: { request_version: RESEARCH_RUN_REQUEST_V3, configuration_project_id: 'unrelated-owned-project' } });
    expect(JSON.parse(standalone).configuration_project_id).toBe('unrelated-owned-project');
    expect(JSON.parse(standalone).scope_expression).toEqual({ kind: 'GLOBAL_LIBRARY' });
    // The selector never mints a project from the scope, whatever that scope names.
    expect(JSON.parse(api.researchRunBodyV3({ query: 'q', scope_expression: callerUnion, selection })).configuration_project_id)
      .toBe('project-gamma');
  });

  it('rejects known invalid or mixed input before dispatch', () => {
    const invalidSelections: readonly unknown[] = [
      { request_version: RESEARCH_RUN_REQUEST_V3 },
      { request_version: RESEARCH_RUN_REQUEST_V3, configuration_project_id: '' },
      { request_version: RESEARCH_RUN_REQUEST_V3, configuration_project_id: 'has space' },
      { request_version: RESEARCH_RUN_REQUEST_V3, configuration_project_id: 'x'.repeat(257) },
      { request_version: RESEARCH_RUN_REQUEST_V3, configuration_project_id: 'bad\u0000id' },
      { request_version: RESEARCH_RUN_REQUEST_V3, configuration_project_id: 'project-gamma', extra: 'value' },
      { request_version: 'eliotr.research-run-request.v2', configuration_project_id: 'project-gamma' },
      { request_version: 'eliotr.research-run-request.v4', configuration_project_id: 'project-gamma' },
      { configuration_project_id: 'project-gamma' },
      null,
      ['project-gamma'],
      'project-gamma',
    ];
    for (const shape of invalidSelections) {
      expect(thrown(() => api.researchRunBodyV3({ query: 'q', scope_expression: callerUnion,
        selection: shape as ResearchRunConfigurationSelection })).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    }
    // A mixed v2 field beside the selector is rejected before dispatch.
    const mixed = thrown(() => api.researchRunBodyV3({ query: 'q', scope_expression: callerUnion,
      selection, ...{ inquiry_protocol_ref: 'uninstalled:v1' } } as unknown as ResearchRunV3Request));
    expect(mixed.code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    // An unknown key on the request itself is rejected, not silently ignored.
    expect(thrown(() => api.researchRunBodyV3({ query: 'q', scope_expression: callerUnion, selection,
      extra: 'value' } as unknown as ResearchRunV3Request)).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    // An invalid or out-of-bounds scope is rejected with the same strict fence.
    expect(thrown(() => api.researchRunBodyV3({ query: 'q', scope_expression: { kind: 'PROJECT' } as never, selection })).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(thrown(() => api.researchRunBodyV3({ query: 'q', scope_expression: callerUnion, selection, max_results: 17 })).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('never falls back to a v2 body, a provider call or a re-minted selector after rejection', async () => {
    const rejected = thrown(() => api.researchRunBodyV3({ query: 'q', scope_expression: callerUnion,
      selection: { request_version: RESEARCH_RUN_REQUEST_V3 } as ResearchRunConfigurationSelection }));
    expect(rejected.code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(rejected.status).toBe(502);
    // The same call stays rejected identically, so nothing retries, downgrades or re-mints.
    expect(thrown(() => api.researchRunBodyV3({ query: 'q', scope_expression: callerUnion,
      selection: { request_version: RESEARCH_RUN_REQUEST_V3 } as ResearchRunConfigurationSelection })).message)
      .toBe(rejected.message);
    // A rejected selection never reaches the transport, and no v2 body is produced instead.
    expect(dispatched).toBe(0);
    await expect(api.startResearchRun(rejected.message, 'op-1').catch(() => 'rejected')).resolves.toBe('rejected');
  });
});

