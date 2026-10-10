import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceRuntime } from './runtime';
import type { SessionContext } from './privacy';

const health = { ready: false, deployment_generation: 'deployment-1', core_schema_generation: null, search_schema_generation: null, blocking_reason_codes: ['SCHEMA_NOT_READY'], checked_at: '2026-10-09T12:00:00.000Z' };
const owner = { protocol: 'eliotr.owner-session.v1', principal_ref: 'principal-1', credential_generation: 'credentials-1', client_class: 'owner_pwa', expires_at: '2026-10-10T12:00:00.000Z' };
const envelope = (data: unknown) => ({ data, trace_id: 'trace-1', deployment_generation: 'deployment-1' });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const timers = { setTimeout: () => 0, clearTimeout() {} };
const context: SessionContext = { principal: 'principal-1', credentialGeneration: 'credentials-1', deploymentGeneration: 'deployment-1', expiresAt: owner.expires_at, cacheEpoch: 1 };
const clock = () => Date.parse('2026-10-09T12:00:00.000Z');
function runtimeFor(fetch: typeof globalThis.fetch, loss = vi.fn()) {
  const runtime = createWorkspaceRuntime({ fetch, timers, baseUrl: 'https://owner.example/', now: clock, sha256: async () => 'a'.repeat(64), mint: () => '11111111-1111-4111-8111-111111111111', isCurrent: candidate => candidate === context, onAuthorizationLoss: loss });
  return { runtime, loss };
}
describe('real owner bootstrap and protected runtime lifetime', () => {
  it('verifies actual health then exact owner session, preserving readiness as a separate fact', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async input => response(envelope(String(input).endsWith('/health') ? health : owner)));
    const { runtime } = runtimeFor(fetch);
    expect(await runtime.verify(new AbortController().signal)).toEqual({ principal: owner.principal_ref, credentialGeneration: owner.credential_generation, deploymentGeneration: 'deployment-1', expiresAt: owner.expires_at });
    expect(fetch.mock.calls.map(call => String(call[0]))).toEqual(['/api/v1/system/health', '/api/v1/system/session']);
    expect(runtime.read(context)).toBeUndefined();
    runtime.dispose();
  });
  it('returns unavailable on bootstrap access denial without invalidation recursion', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ type: 'urn:eliotr:problem:ACCESS_SESSION_REQUIRED', title: 'Access required', status: 401, code: 'ACCESS_SESSION_REQUIRED', trace_id: 'trace-1', retryable: false }, 401));
    const { runtime, loss } = runtimeFor(fetch);
    expect(await runtime.verify(new AbortController().signal)).toBeUndefined();
    expect(loss).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });
  it('rejects an expired session and a session for another client class', async () => {
    for (const patch of [{ expires_at: '2026-10-08T12:00:00.000Z' }, { client_class: 'trusted_agent' }]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async input => response(envelope(String(input).endsWith('/health') ? health : { ...owner, ...patch })));
      const { runtime } = runtimeFor(fetch);
      expect(await runtime.verify(new AbortController().signal)).toBeUndefined();
      runtime.dispose();
    }
  });
  it('closes old API handles synchronously when protected context is masked', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(envelope(health)));
    const { runtime } = runtimeFor(fetch); runtime.bind(context);
    const old = runtime.read(context); if (!old) throw Error('No bound runtime');
    runtime.close(); runtime.bind(context);
    expect(runtime.read({ ...context })).toBeUndefined();
    await expect(old.health.getSystemHealth()).rejects.toMatchObject({ code: 'API_SESSION_CLOSED' });
    expect(fetch).not.toHaveBeenCalled(); runtime.dispose();
  });
  it('emits current authorization loss only for protected requests after binding', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ type: 'urn:eliotr:problem:ACCESS_SESSION_REQUIRED', title: 'Access required', status: 401, code: 'ACCESS_SESSION_REQUIRED', trace_id: 'trace-1', retryable: false }, 401));
    const { runtime, loss } = runtimeFor(fetch); runtime.bind(context);
    await expect(runtime.read(context)?.health.getSystemHealth()).rejects.toMatchObject({ code: 'ACCESS_SESSION_REQUIRED' });
    expect(loss).toHaveBeenCalledTimes(1); runtime.dispose();
  });
});
