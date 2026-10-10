import { describe, expect, it, vi } from 'vitest';
import { createResearchSessionProjectionAdapter } from './adapter';
import type { ProjectionCallClient, ResearchSessionBinding, ResearchSessionHostControls } from './session';
import { OwnerClientError } from '../../transport/client';
import { createSessionEpoch } from '../../transport/session/epoch';

const binding = (overrides: Partial<ResearchSessionBinding> = {}): ResearchSessionBinding => ({
  agent: 'ResearchSession',
  name: 'sess-1',
  session_id: 'sess-1',
  operation_id: 'op-1',
  investigation_ref: { id: 'inv-1', revision: 2 },
  handler_generation: 'gen-1',
  principal_ref: 'principal-1',
  credential_generation: 'cred-1',
  deployment_generation: 'dep-1',
  authority_expires_at: 4_102_444_800_000,
  timeoutMs: 5_000,
  ...overrides,
});

const controls: ResearchSessionHostControls = {
  transport: 'cf-websocket',
  host: '127.0.0.1:6006',
  protocol: 'ws',
};

const now = () => 1_700_000_000_000;

const errors = (details: { code: string; status: number; message: string }) =>
  new OwnerClientError({ code: details.code, message: details.message, status: details.status });

/** Only a real typed request error is a typed error; plain objects are forgeries. */
const isRequestError = (error: unknown): boolean => error instanceof OwnerClientError;

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  protocol: 'eliotr.research-session-projection.v1',
  session_id: 'sess-1',
  operation_id: 'op-1',
  state: 'ACTIVE',
  investigation_ref: { id: 'inv-1', revision: 2 },
  run_status: { execution_state: 'ACTIVE', engine_status: 'running', next_stage_index: 3 },
  ...overrides,
});

const build = (call: ProjectionCallClient['call'], epoch = createSessionEpoch()) => {
  const closed: unknown[] = [];
  const connect = vi.fn(async () => ({ call, close: (code?: number) => { closed.push(code); } }));
  const adapter = createResearchSessionProjectionAdapter({
    epoch,
    errors,
    now,
    isRequestError,
    connect: connect as unknown as (b: ResearchSessionBinding) => Promise<ProjectionCallClient>,
    controls,
  });
  return { adapter, closed, connect };
};

describe('C3-RP projection adapter', () => {
  it('returns the decoded snapshot for one no-argument call', async () => {
    const call = vi.fn<ProjectionCallClient['call']>(async () => snapshot());
    const { adapter } = build(call);
    const result = await adapter.readProjection(binding());
    expect(result.kind).toBe('PROJECTION');
    expect(call).toHaveBeenCalledTimes(1);
    const [, args] = call.mock.calls[0] ?? [];
    expect(args).toEqual([]);
  });

  it('treats the typed 410 as an expected outcome, not a failure', async () => {
    const disabled = new OwnerClientError({
      code: 'SESSION_CHAT_HISTORY_DISABLED',
      message: 'disabled',
      status: 410,
    });
    const { adapter } = build((async () => { throw disabled; }) as unknown as ProjectionCallClient['call']);
    expect(await adapter.readProjection(binding())).toEqual({ kind: 'CHAT_HISTORY_DISABLED' });
  });

  it('does not accept a forged plain 410 as the expected outcome', async () => {
    const forged = { code: 'SESSION_CHAT_HISTORY_DISABLED', status: 410, message: 'forged' };
    const { adapter } = build((async () => { throw forged; }) as unknown as ProjectionCallClient['call']);
    await expect(adapter.readProjection(binding())).rejects.toThrow();
  });

  it('does not accept a forged closed-session object as UNAVAILABLE', async () => {
    const forged = { code: 'API_SESSION_CLOSED', status: 503, message: 'forged' };
    const { adapter } = build((async () => { throw forged; }) as unknown as ProjectionCallClient['call']);
    await expect(adapter.readProjection(binding())).rejects.toThrow();
  });

  it('reports a real closed session as unavailable instead of guessing', async () => {
    const closedError = new OwnerClientError({ code: 'API_SESSION_CLOSED', message: 'closed', status: 503 });
    const { adapter } = build((async () => { throw closedError; }) as unknown as ProjectionCallClient['call']);
    expect(await adapter.readProjection(binding())).toEqual({ kind: 'UNAVAILABLE' });
  });

  it('keeps the pre-call capture so a replaced epoch cannot pass the final fence', async () => {
    const epoch = createSessionEpoch();
    const call = vi.fn((_method: string) => {
      // The caller replaces the epoch while the read is in flight, before the response returns.
      epoch.advance();
      return Promise.resolve(snapshot());
    });
    const { adapter } = build(call as unknown as ProjectionCallClient['call'], epoch);
    expect(await adapter.readProjection(binding())).toEqual({ kind: 'UNAVAILABLE' });
  });

  it('rejects a snapshot for another session, operation or investigation', async () => {
    const wrongSession = build((async () => snapshot({ session_id: 'sess-9' })) as unknown as ProjectionCallClient['call']);
    await expect(wrongSession.adapter.readProjection(binding())).rejects.toThrow(/bound session tuple/);
    const wrongOperation = build((async () => snapshot({ operation_id: 'op-9' })) as unknown as ProjectionCallClient['call']);
    await expect(wrongOperation.adapter.readProjection(binding())).rejects.toThrow(/bound session tuple/);
    const wrongInvestigation = build((async () => snapshot({
      investigation_ref: { id: 'inv-9', revision: 1 },
    })) as unknown as ProjectionCallClient['call']);
    await expect(wrongInvestigation.adapter.readProjection(binding())).rejects.toThrow(/bound session tuple/);
  });

  it('propagates a malformed snapshot as a typed failure', async () => {
    const { adapter } = build((async () => snapshot({ extra: true })) as unknown as ProjectionCallClient['call']);
    await expect(adapter.readProjection(binding())).rejects.toThrow(/projection carries an unknown field/);
  });

  it('does not convert an unrelated failure into UNAVAILABLE', async () => {
    const unavailable = new OwnerClientError({ code: 'API_UNREACHABLE', message: 'down', status: 503 });
    const { adapter } = build((async () => { throw unavailable; }) as unknown as ProjectionCallClient['call']);
    await expect(adapter.readProjection(binding())).rejects.toThrow(/down/);
  });

  it('returns UNAVAILABLE when the caller clock is not finite', async () => {
    const call = vi.fn(async () => snapshot());
    const closed: unknown[] = [];
    const connect = vi.fn(async () => ({ call, close: (code?: number) => { closed.push(code); } }));
    const adapter = createResearchSessionProjectionAdapter({
      epoch: createSessionEpoch(),
      errors,
      now: () => Number.NaN,
      isRequestError,
      connect: connect as unknown as (b: ResearchSessionBinding) => Promise<ProjectionCallClient>,
      controls,
    });
    expect(await adapter.readProjection(binding())).toEqual({ kind: 'UNAVAILABLE' });
    expect(call).not.toHaveBeenCalled();
  });

  it('disposes only its own socket', async () => {
    const { adapter, closed } = build((async () => snapshot()) as unknown as ProjectionCallClient['call']);
    await adapter.readProjection(binding());
    adapter.dispose();
    adapter.dispose();
    expect(closed).toEqual([1000]);
  });
});
