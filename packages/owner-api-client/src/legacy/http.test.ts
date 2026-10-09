import { describe, expect, it, vi } from 'vitest';
import { bindAuthorizationCleared } from './browser';
import { createLegacyHttpAdapter, type LegacyErrorFactory, type LegacyHttpPorts } from './http';
import { OwnerClientError, type AuthorizationLoss } from '../transport/client';
import { createSessionEpoch } from '../transport/session/epoch';

class LegacyError extends OwnerClientError {
  public constructor(details: { code: string; status: number; message: string }) {
    super({ code: details.code, message: details.message, status: details.status, traceId: 'legacy-trace' });
    this.name = 'LegacyError';
  }
}

const legacyError: LegacyErrorFactory = (details) => new LegacyError(details);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, code: string) =>
  new Response(JSON.stringify({
    type: 'urn:eliotr:problem:access-denied',
    title: 'Access denied',
    status,
    code,
    trace_id: 'trace-1',
    retryable: false,
  }), { status, headers: { 'content-type': 'application/json' } });

type Epoch = ReturnType<typeof createSessionEpoch>;

const build = (fetchImpl: typeof fetch, epoch: Epoch, sink: AuthorizationLoss[] = []) => {
  const ports: LegacyHttpPorts = {
    fetch: fetchImpl,
    baseUrl: 'https://owner.test/',
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    epoch,
    onAuthorizationLoss: (observation) => sink.push(observation),
  };
  return { adapter: createLegacyHttpAdapter(ports, legacyError), sink };
};

const binderFor = (epoch: Epoch) => {
  const target = new EventTarget();
  const events: Event[] = [];
  target.addEventListener('eliotr:authorization-cleared', (event) => events.push(event as Event));
  const binding = bindAuthorizationCleared({
    epoch,
    target,
    createEvent: () => new Event('eliotr:authorization-cleared'),
  });
  return { binding, events };
};

const loss = (epoch: object, status: number, code: string, current: boolean): AuthorizationLoss =>
  ({ epoch, status, code, current });

describe('legacy http seam', () => {
  it('emits authorization-cleared once for concurrent 401 observations', async () => {
    const epoch = createSessionEpoch();
    const { adapter, sink } = build((async () => problem(401, 'ACCESS_SESSION_REQUIRED')) as typeof fetch, epoch);
    const { binding, events } = binderFor(epoch);
    await Promise.all([
      adapter.requestApi('/api/v1/one').catch(() => undefined),
      adapter.requestApi('/api/v1/two').catch(() => undefined),
    ]);
    for (const observation of sink) binding.dispatch(observation);
    for (const observation of sink) binding.dispatch(observation);
    expect(events).toHaveLength(1);
  });

  it('an old-epoch failure never clears the new session', () => {
    const epoch = createSessionEpoch();
    const stale = epoch.capture() as object;
    const fresh = epoch.advance();
    const { binding, events } = binderFor(epoch);
    binding.dispatch(loss(stale, 401, 'ACCESS_SESSION_REQUIRED', false));
    expect(events).toHaveLength(0);
    binding.dispatch(loss(fresh, 401, 'ACCESS_SESSION_REQUIRED', true));
    expect(events).toHaveLength(1);
  });

  it('a new epoch emits its own event once', () => {
    const epoch = createSessionEpoch();
    const first = epoch.capture() as object;
    const second = epoch.advance();
    const { binding, events } = binderFor(epoch);
    binding.dispatch(loss(first, 401, 'ACCESS_SESSION_REQUIRED', false));
    binding.dispatch(loss(second, 401, 'ACCESS_SESSION_REQUIRED', true));
    binding.dispatch(loss(second, 401, 'ACCESS_SESSION_REQUIRED', true));
    expect(events).toHaveLength(1);
  });

  it('a policy 403 without ACCESS_ code emits nothing', async () => {
    const epoch = createSessionEpoch();
    const { adapter, sink } = build((async () => problem(403, 'SOURCE_QUARANTINED')) as typeof fetch, epoch);
    const { binding, events } = binderFor(epoch);
    const error = await adapter.requestApi('/api/v1/policy').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LegacyError);
    expect((error as OwnerClientError).code).toBe('SOURCE_QUARANTINED');
    for (const observation of sink) binding.dispatch(observation);
    expect(events).toHaveLength(0);
  });

  it('body parser failures keep legacy instanceof through the factory', async () => {
    const epoch = createSessionEpoch();
    const { adapter } = build((async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch, epoch);
    const error = await adapter.requestApi('/api/v1/broken').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LegacyError);
    expect((error as OwnerClientError).code).toBe('MALFORMED_JSON_RESPONSE');
  });

  it('preserves the idempotency header and status policy across init normalization', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(201, { ok: true }));
    const epoch = createSessionEpoch();
    const { adapter } = build(fetchImpl as unknown as typeof fetch, epoch);
    const value = await adapter.requestApiWithStatuses(
      '/api/v1/item',
      { method: 'post', body: '{}', headers: { 'idempotency-key': 'op-1' }, credentials: 'same-origin', cache: 'no-store', redirect: 'manual', mode: 'same-origin' },
      [201],
    );
    expect(value).toEqual({ ok: true });
    const init = fetchImpl.mock.calls[0]?.[1];
    if (init === undefined) throw new Error('Expected a captured request');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('op-1');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('manual');
  });

  it('rejects hostile init fields before any fetch happens', async () => {
    const fetchImpl = vi.fn(async () => json(200, { ok: true }));
    const epoch = createSessionEpoch();
    const { adapter } = build(fetchImpl as unknown as typeof fetch, epoch);
    await expect(adapter.requestApi('/api/v1/x', { keepalive: true } as unknown as RequestInit)).rejects.toThrow(TypeError);
    await expect(adapter.requestApi('/api/v1/x', { mode: 'cors' })).rejects.toThrow(TypeError);
    await expect(adapter.requestApi('/api/v1/x', { credentials: 'include' })).rejects.toThrow(TypeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('decodes whole-200 text with fatal UTF-8 and preserved headers', async () => {
    const epoch = createSessionEpoch();
    const fetchImpl = vi.fn(async () => new Response(new TextEncoder().encode('evidence'), {
      status: 200,
      headers: { 'content-type': 'text/plain', 'x-trace': 'abc' },
    }));
    const { adapter } = build(fetchImpl as unknown as typeof fetch, epoch);
    const { requestApiText } = adapter;
    const response = await requestApiText('/api/v1/evidence', undefined, 1024);
    expect(response.text).toBe('evidence');
    expect(response.headers.get('x-trace')).toBe('abc');
  });

  it('rejects invalid UTF-8 evidence as a legacy typed failure', async () => {
    const epoch = createSessionEpoch();
    const broken = new Uint8Array([0xff, 0xfe, 0x00]);
    const { adapter } = build((async () => new Response(broken, { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch, epoch);
    const error = await adapter.requestApiText('/api/v1/evidence').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LegacyError);
    expect((error as OwnerClientError).code).toBe('API_RESPONSE_SCHEMA_MISMATCH');
  });

  it('preserves the legacy bytes signature and whole-200 policy', async () => {
    const epoch = createSessionEpoch();
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }));
    const { adapter } = build(fetchImpl as unknown as typeof fetch, epoch);
    const response = await adapter.requestApiBytes('/api/v1/bytes', controller.signal, 1024);
    expect(Array.from(response.bytes)).toEqual([1, 2, 3]);
    const partial = build((async () => new Response(new Uint8Array([1]), { status: 206, headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-0/1' } })) as typeof fetch, createSessionEpoch());
    const error = await partial.adapter.requestApiBytes('/api/v1/bytes').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LegacyError);
    expect((error as OwnerClientError).code).toBe('API_STATUS_INVALID');
  });

  it('disposes only the client and leaves the external epoch untouched', async () => {
    const epoch = createSessionEpoch();
    const { adapter } = build((async () => json(200, { ok: true })) as typeof fetch, epoch);
    expect(epoch.capture()).toBeDefined();
    adapter.dispose();
    expect(epoch.capture()).toBeDefined();
    expect(epoch.isCurrent(epoch.capture())).toBe(true);
    const error = await adapter.requestApi('/api/v1/after').catch((caught: unknown) => caught);
    expect((error as OwnerClientError).code).toBe('API_SESSION_CLOSED');
  });
});

describe("reauthorized section legacy error identity", () => {
  it("retains the caller's typed failure and exact transport without direct fetch", async () => {
    const epoch = createSessionEpoch();
    const ports: LegacyHttpPorts = { fetch: async () => new Response(new Uint8Array([42]), { status: 206, headers: { "content-type": "application/octet-stream" } }), baseUrl: "https://owner.test", epoch, timers: { setTimeout: () => 0, clearTimeout() {} } };
    const api = createLegacyHttpAdapter(ports, legacyError);
    await expect(api.requestReauthorizedSectionBytes("/api/v1/research/artifact/artifact-1%3A1/sections/section-1%3A1/reauthorize")).rejects.toBeInstanceOf(LegacyError);
    api.dispose();
  });
});
