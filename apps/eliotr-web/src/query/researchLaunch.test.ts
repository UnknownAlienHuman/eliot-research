import { describe, expect, it, vi } from 'vitest';
import { createResearchRunsApi, createSessionEpoch } from '@eliotr/owner-api-client';
import { createPrivacyController } from '../app/privacy';
import { WorkspaceRequestError } from '../app/runtime';
import { researchLaunchFailureMessage, safeResearchLaunchFailure, submitResearchLaunchOnce } from './researchLaunch';

const key = '11111111-1111-4111-8111-111111111111';
const launch = { workflow_instance_id: 'run-same-question', investigation_ref: { id: 'investigation-1', revision: 1 } };
const typedError = (code: string) => new WorkspaceRequestError({ code, status: 503, message: 'raw-secret-provider-payload',
  traceId: 'raw-trace', retryable: true });

async function fixture() {
  let current = true;
  const privacy = createPrivacyController({ mask() {}, reveal() {}, cancelReads() {}, clearProtected() {},
    now: () => Date.parse('2026-10-16T12:00:00.000Z'), timers: { setTimeout: () => 0, clearTimeout() {} },
    verify: async () => ({ principal: 'owner-1', credentialGeneration: 'credential-1', deploymentGeneration: 'deployment-1',
      expiresAt: '2027-01-01T00:00:00.000Z' }) });
  await privacy.refresh();
  const snapshot = privacy.getSnapshot();
  if (snapshot.phase !== 'available') throw new Error('Launch fixture authority unavailable');
  let reply = async (): Promise<unknown> => ({ data: launch, trace_id: 'launch-trace', deployment_generation: 'deployment-1' });
  const request = vi.fn(async (_path: string, _init: RequestInit | undefined, _statuses: readonly number[]) => reply());
  const runs = createResearchRunsApi({ request, epoch: createSessionEpoch(), errors: details => new WorkspaceRequestError(details) });
  const body = runs.researchRunBodyV4({ query: 'Compare selected sources', output_language: 'en',
    scope_expression: { kind: 'PROJECT', project_id: 'project-1' }, selection: { configuration_project_id: 'project-1',
      configuration_ref: `rpmc-${'a'.repeat(64)}`, configuration_sha256: 'a'.repeat(64), selection_revision: 3 } });
  const controller = new AbortController();
  const invoke = () => submitResearchLaunchOnce({ runs, privacy, context: snapshot.context, body, key,
    signal: controller.signal, isCurrent: () => current });
  return { invoke, request, body, privacy, controller, reply: (next: typeof reply) => { reply = next; }, loseCurrentness: () => { current = false; } };
}

describe('safe research admission failure diagnostics', () => {
  it.each(['RESEARCH_AUTHORITY_STALE', 'RESEARCH_AGENT_NOT_CONFIGURED', 'RESEARCH_SETTLEMENT_UNCERTAIN',
    'RESEARCH_CONFLICT', 'RESEARCH_INPUT_LIMIT', 'RESEARCH_RUN_RESPONSE_INVALID'])('retains only approved code %s with plain EN/RU copy', code => {
    const failure = safeResearchLaunchFailure(typedError(code));
    expect(failure).toEqual({ code });
    const en = researchLaunchFailureMessage(failure, 'en'), ru = researchLaunchFailureMessage(failure, 'ru');
    expect(en.length).toBeGreaterThan(20); expect(ru).toMatch(/[А-Яа-я]/u);
    expect(en + ru + JSON.stringify(failure)).not.toContain('raw-secret-provider-payload');
    expect(JSON.stringify(failure)).not.toContain('raw-trace');
  });

  it('does not expose raw messages, arbitrary codes, or untyped error objects', () => {
    for (const error of [typedError('raw-secret-code'), new Error('raw-secret-provider-payload'),
      { code: 'RESEARCH_CONFLICT', message: 'raw-secret-provider-payload' }]) {
      const failure = safeResearchLaunchFailure(error);
      expect(failure).toEqual({});
      expect(researchLaunchFailureMessage(failure, 'en')).toBe('The launch response could not be confirmed.');
    }
  });

  it('keeps a typed failure UNKNOWN and uses the identical body/key only on another explicit reconciliation', async () => {
    const test = await fixture(); test.reply(async () => { throw typedError('RESEARCH_SETTLEMENT_UNCERTAIN'); });
    expect(await test.invoke()).toEqual({ phase: 'unknown', failure: { code: 'RESEARCH_SETTLEMENT_UNCERTAIN' } });
    expect(test.request).toHaveBeenCalledTimes(1);
    test.reply(async () => ({ data: launch, trace_id: 'launch-trace', deployment_generation: 'deployment-1' }));
    const reconciled = await test.invoke();
    expect(reconciled).toEqual({ phase: 'admitted', launch: { ...launch, deployment_generation: 'deployment-1' } });
    expect(reconciled).not.toHaveProperty('failure');
    expect(test.request).toHaveBeenCalledTimes(2);
    expect(test.request.mock.calls.map(([path, init]) => ({ path, body: init?.body,
      key: new Headers(init?.headers).get('idempotency-key') }))).toEqual([
      { path: '/api/v1/research/run', body: test.body, key },
      { path: '/api/v1/research/run', body: test.body, key },
    ]);
    test.privacy.dispose();
  });

  it('keeps an untyped transport failure UNKNOWN without a second POST or unsafe details', async () => {
    const test = await fixture(); test.reply(async () => { throw new TypeError('raw-secret-provider-payload'); });
    expect(await test.invoke()).toEqual({ phase: 'unknown', failure: {} });
    expect(test.request).toHaveBeenCalledTimes(1);
    test.privacy.dispose();
  });

  it.each(['privacy', 'project/intent', 'abort'])('rejects late launch diagnostics after %s loss', async loss => {
    const test = await fixture(); let finish: (() => void) | undefined;
    test.reply(() => new Promise((_resolve, reject) => { finish = () => reject(typedError('RESEARCH_CONFLICT')); }));
    const pending = test.invoke();
    await vi.waitFor(() => expect(finish).toBeDefined());
    if (loss === 'privacy') test.privacy.close();
    else if (loss === 'project/intent') test.loseCurrentness();
    else test.controller.abort();
    finish?.();
    await expect(pending).rejects.toThrow('Protected read is no longer current');
    expect(test.request).toHaveBeenCalledTimes(1);
    test.privacy.dispose();
  });
});
