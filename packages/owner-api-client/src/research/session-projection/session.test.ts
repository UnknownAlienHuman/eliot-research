import { describe, expect, it, vi } from 'vitest';
import {
  createResearchSession,
  freezeBinding,
  type ProjectionCallClient,
  type ResearchSessionBinding,
  type ResearchSessionHostControls,
} from './session';
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
const isRequestError = (error: unknown): boolean => error instanceof OwnerClientError;

// One real callable signature, so the spy records its actual argument tuple instead of an empty one.
const defaultCall: ProjectionCallClient['call'] = async () => ({ ok: true });

const delayedCall = (milliseconds: number): ProjectionCallClient['call'] =>
  async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return { ok: true };
  };

const clientOf = (hooks: { call?: ProjectionCallClient['call']; close?: (code?: number) => void }) => ({
  call: hooks.call ?? defaultCall,
  close: hooks.close ?? (() => {}),
});

const build = (
  connect: (b: ResearchSessionBinding, c: ResearchSessionHostControls) => Promise<ProjectionCallClient>,
  epoch = createSessionEpoch(),
  hostControls: ResearchSessionHostControls = controls,
) => createResearchSession(
  { epoch, errors, now, isRequestError },
  connect,
  hostControls,
);

const failure = async (promise: Promise<unknown>): Promise<OwnerClientError> => {
  try {
    await promise;
    throw new Error('expected a typed failure');
  } catch (error) {
    return error as OwnerClientError;
  }
};

describe('C3-RP research session socket', () => {
  it('sends exactly one no-argument call with the caller deadline', async () => {
    const call = vi.fn<ProjectionCallClient['call']>(defaultCall);
    const socket = build(async () => clientOf({ call }));
    await socket.callProjection(binding());
    expect(call).toHaveBeenCalledTimes(1);
    const [method, args, options] = call.mock.calls[0] ?? [];
    expect(method).toBe('readResearchSessionProjection');
    expect(args).toEqual([]);
    expect(options).toEqual({ timeout: 5_000 });
  });

  it('freezes the caller tuple before the first await', async () => {
    const mutable = binding();
    const frozen = freezeBinding(mutable);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.investigation_ref)).toBe(true);
    // Mutating the caller object after freezing cannot change the frozen tuple.
    (mutable as { session_id: string }).session_id = 'sess-9';
    (mutable.investigation_ref as { id: string }).id = 'inv-9';
    expect(frozen.session_id).toBe('sess-1');
    expect(frozen.investigation_ref.id).toBe('inv-1');
  });

  it('marks a mutable caller object stale without touching the frozen binding', async () => {
    const connect = vi.fn(async () => clientOf({}));
    const socket = build(connect);
    const live = binding();
    const first = socket.callProjection(live);
    // The caller mutates its own object while the read is in flight.
    (live as { authority_expires_at: number }).authority_expires_at = 1;
    await first.catch(() => undefined);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight read between concurrent calls and connects once', async () => {
    const call = vi.fn<ProjectionCallClient['call']>(delayedCall(5));
    const connect = vi.fn(async () => clientOf({ call }));
    const socket = build(connect);
    const [first, second] = await Promise.all([
      socket.callProjection(binding()),
      socket.callProjection(binding()),
    ]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it('refuses a foreign tuple instead of opening a second socket', async () => {
    const connect = vi.fn(async () => clientOf({}));
    const socket = build(connect);
    await socket.callProjection(binding());
    const changed = await failure(socket.callProjection(binding({ session_id: 'sess-2' })));
    expect(changed.code).toBe('API_SESSION_CLOSED');
    const renamed = await failure(socket.callProjection(binding({ investigation_ref: { id: 'inv-2', revision: 1 } })));
    expect(renamed.code).toBe('API_SESSION_CLOSED');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('settles a hung connect immediately on dispose and closes a late socket once', async () => {
    const call = vi.fn<ProjectionCallClient['call']>(defaultCall);
    const close = vi.fn();
    let resolveConnect: (value: ProjectionCallClient) => void = () => {};
    const socket = build(() => new Promise<ProjectionCallClient>((resolve) => {
      resolveConnect = resolve;
    }));
    const pending = socket.callProjection(binding());
    socket.dispose();
    const error = await failure(pending);
    expect(error.code).toBe('API_SESSION_CLOSED');
    // The connect that finally resolves is closed instead of being used.
    resolveConnect(clientOf({ call, close }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(close).toHaveBeenCalledTimes(1);
    expect(call).not.toHaveBeenCalled();
  });

  it('settles a pending RPC immediately on dispose', async () => {
    const call = vi.fn<ProjectionCallClient['call']>(delayedCall(50));
    const close = vi.fn();
    const socket = build(async () => clientOf({ call, close }));
    const pending = socket.callProjection(binding());
    await new Promise((resolve) => setTimeout(resolve, 5));
    socket.dispose();
    expect((await failure(pending)).code).toBe('API_SESSION_CLOSED');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rechecks disposal, epoch and expiry after the awaited connect', async () => {
    const call = vi.fn<ProjectionCallClient['call']>(defaultCall);
    const close = vi.fn();
    let release = (): void => {};
    const held = new Promise<ProjectionCallClient>((resolve) => {
      release = () => resolve(clientOf({ call, close }));
    });
    const socket = build(async () => held);
    const pending = socket.callProjection(binding());
    socket.dispose();
    release();
    expect((await failure(pending)).code).toBe('API_SESSION_CLOSED');
    expect(call).not.toHaveBeenCalled();
  });

  it('rechecks the epoch after the awaited connect', async () => {
    const epoch = createSessionEpoch();
    const call = vi.fn<ProjectionCallClient['call']>(defaultCall);
    let release = (): void => {};
    const held = new Promise<ProjectionCallClient>((resolve) => {
      release = () => resolve(clientOf({ call }));
    });
    const socket = build(async () => held, epoch);
    const pending = socket.callProjection(binding());
    epoch.close();
    release();
    expect((await failure(pending)).code).toBe('API_SESSION_CLOSED');
    expect(call).not.toHaveBeenCalled();
  });

  it('rechecks expiry after the awaited connect', async () => {
    const call = vi.fn<ProjectionCallClient['call']>(defaultCall);
    let release = (): void => {};
    const held = new Promise<ProjectionCallClient>((resolve) => {
      release = () => resolve(clientOf({ call }));
    });
    const clock = { value: 1_700_000_000_000 };
    const socket = createResearchSession(
      { epoch: createSessionEpoch(), errors, now: () => clock.value, isRequestError },
      async () => held,
      controls,
    );
    const pending = socket.callProjection(binding({ authority_expires_at: 1_700_000_000_500 }));
    clock.value = 1_700_000_001_000;
    release();
    expect((await failure(pending)).code).toBe('API_SESSION_CLOSED');
    expect(call).not.toHaveBeenCalled();
  });

  it('rechecks disposal after the RPC settles', async () => {
    const call = vi.fn<ProjectionCallClient['call']>(delayedCall(5));
    const socket = build(async () => clientOf({ call }));
    const pending = socket.callProjection(binding());
    await Promise.resolve();
    socket.dispose();
    expect((await failure(pending)).code).toBe('API_SESSION_CLOSED');
  });

  it('fails closed on a NaN or infinite clock instead of bypassing the expiry', async () => {
    const connect = vi.fn(async () => clientOf({}));
    const socket = createResearchSession(
      { epoch: createSessionEpoch(), errors, now: () => Number.NaN, isRequestError },
      connect,
      controls,
    );
    expect((await failure(socket.callProjection(binding()))).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    const infinite = createResearchSession(
      { epoch: createSessionEpoch(), errors, now: () => Number.POSITIVE_INFINITY, isRequestError },
      connect,
      controls,
    );
    expect((await failure(infinite.callProjection(binding()))).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(connect).not.toHaveBeenCalled();
  });

  it('fails closed on a NaN clock after the awaited connect', async () => {
    const call = vi.fn<ProjectionCallClient['call']>(defaultCall);
    const clock = { value: 1_700_000_000_000 };
    let release = (): void => {};
    const held = new Promise<ProjectionCallClient>((resolve) => {
      release = () => resolve(clientOf({ call }));
    });
    const socket = createResearchSession(
      { epoch: createSessionEpoch(), errors, now: () => clock.value, isRequestError },
      async () => held,
      controls,
    );
    const pending = socket.callProjection(binding());
    clock.value = Number.NaN;
    release();
    expect((await failure(pending)).code).toBe('API_SESSION_CLOSED');
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects unqualified host controls before any import or connect', async () => {
    const connect = vi.fn(async () => clientOf({}));
    const ambient = build(connect, createSessionEpoch(), {
      transport: 'cf-websocket',
      host: '',
      protocol: 'ws',
    });
    expect((await failure(ambient.callProjection(binding()))).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    const smuggled = build(connect, createSessionEpoch(), {
      transport: 'cf-websocket',
      host: '127.0.0.1:6006 extra',
      protocol: 'ws',
    });
    expect((await failure(smuggled.callProjection(binding()))).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    const unknown = build(connect, createSessionEpoch(), {
      transport: 'cf-websocket',
      host: '127.0.0.1:6006',
      protocol: 'ws',
      authorization: 'Bearer x',
    } as unknown as ResearchSessionHostControls);
    expect((await failure(unknown.callProjection(binding()))).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects an invalid expiry or deadline bound before connecting', async () => {
    const connect = vi.fn(async () => clientOf({}));
    const socket = build(connect);
    expect((await failure(socket.callProjection(binding({ authority_expires_at: 1.5 })))).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect((await failure(socket.callProjection(binding({ timeoutMs: 0 })))).code)
      .toBe('RESEARCH_RUN_RESPONSE_INVALID');
    expect((await failure(socket.callProjection(binding({ authority_expires_at: 1 })))).code)
      .toBe('API_SESSION_CLOSED');
    expect(connect).not.toHaveBeenCalled();
  });

  it('disposes once and never touches the shared caller epoch', async () => {
    const epoch = createSessionEpoch();
    const close = vi.fn();
    const socket = build(async () => clientOf({ close }), epoch);
    await socket.callProjection(binding());
    const before = epoch.capture();
    socket.dispose();
    socket.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(1000, 'owner-client-disposed');
    expect(epoch.isCurrent(before)).toBe(true);
    expect(epoch.capture()).toBeDefined();
  });
});
