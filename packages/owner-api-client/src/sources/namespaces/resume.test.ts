import { describe, expect, it, vi } from 'vitest';
import type { NamespaceApi } from './catalog';
import { createOwnerNamespaceResumeCoordinator, type OwnerNamespaceResumePorts } from './resume';

const deploymentGeneration = 'dep-1';
const session = {
  principal_ref: 'principal-1',
  credential_generation: 'cred-1',
  expires_at: '2026-12-01T00:00:00.000Z',
  client_class: 'owner_pwa',
};

const namespace = (id: string, generationValue: number, expiresAt: string, access: 'ACTIVE' | 'EXPIRED' = 'ACTIVE') => ({
  source_namespace_id: id,
  title: 'workspace',
  read_access: access,
  read_policy_generation: generationValue,
  read_expires_at: expiresAt,
});

const catalog = (namespaces: ReturnType<typeof namespace>[]) => ({
  protocol: 'eliotr.owner-namespaces.v1' as const,
  profiles: [],
  namespaces,
  trace_id: 'trace-1',
  deployment_generation: deploymentGeneration,
});

const renewed = (id: string, generationValue: number, expiresAt: string) => ({
  protocol: 'eliotr.owner-namespace-renewal.v1' as const,
  source_namespace_id: id,
  title: 'workspace',
  read_policy_generation: generationValue,
  read_expires_at: expiresAt,
  read_access: 'ACTIVE' as const,
  trace_id: 'trace-1',
  deployment_generation: deploymentGeneration,
});

const port = (overrides: Partial<NamespaceApi>): NamespaceApi => ({
  readSourceNamespaces: vi.fn(async () => catalog([])),
  createSourceNamespace: vi.fn(),
  renewSourceNamespace: vi.fn(async () => renewed('ns-1', 2, session.expires_at)),
  ...overrides,
}) as unknown as NamespaceApi;

const isRequestError: OwnerNamespaceResumePorts['isRequestError'] = (error): error is Error & { code: string; status: number } => error instanceof Error && 'code' in error && 'status' in error;

const coordinator = (ports: OwnerNamespaceResumePorts) => createOwnerNamespaceResumeCoordinator(ports);

describe('C2-N namespace resume coordinator', () => {
  it('confirms a concurrent renewal by readback without another mutation', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(catalog([namespace('ns-short', 1, '2026-11-01T00:00:00.000Z')]))
      .mockResolvedValueOnce(catalog([namespace('ns-short', 2, session.expires_at)]));
    const renew = vi.fn(async () => { throw Object.assign(new Error('conflict'), { code: 'REVISION_CONFLICT', status: 409 }); });
    const api = port({ readSourceNamespaces: read, renewSourceNamespace: renew });
    const result = await coordinator({ api, isAuthorizationLoss: () => false, isCurrent: () => true, isRequestError }).run(session, deploymentGeneration);
    expect(result.confirmedNamespaceIds).toEqual(['ns-short']);
    expect(result.renewedNamespaceIds).toEqual([]);
    expect(result.unresolvedNamespaceIds).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('does not interpret an untyped conflict object as request authority', async () => {
    const read = vi.fn(async () => catalog([namespace('ns-short', 1, '2026-11-01T00:00:00.000Z')]));
    const api = port({ readSourceNamespaces: read, renewSourceNamespace: vi.fn(async () => { throw { code: 'REVISION_CONFLICT', status: 409 }; }) });
    const result = await coordinator({ api, isAuthorizationLoss: () => false, isCurrent: () => true, isRequestError }).run(session, deploymentGeneration);
    expect(result.unresolvedNamespaceIds).toEqual(['ns-short']);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reports renewed and confirmed namespaces separately', async () => {
    const api = port({
      readSourceNamespaces: vi.fn(async () => catalog([
        namespace('ns-short', 1, '2026-11-01T00:00:00.000Z'),
        namespace('ns-long', 5, '2026-12-01T00:00:00.000Z'),
      ])),
    });
    const result = await coordinator({ api, isAuthorizationLoss: () => false, isCurrent: () => true, isRequestError }).run(session, deploymentGeneration);
    expect(result.stale).toBe(false);
    expect(result.renewedNamespaceIds).toEqual(['ns-short']);
    expect(result.confirmedNamespaceIds).toEqual([]);
    expect(result.unresolvedNamespaceIds).toEqual([]);
  });

  it('returns a stale result when the binding stops being current after an await', async () => {
    let current = true;
    const api = port({
      readSourceNamespaces: vi.fn(async () => {
        current = false;
        return catalog([namespace('ns-short', 1, '2026-11-01T00:00:00.000Z')]);
      }),
    });
    const result = await coordinator({ api, isAuthorizationLoss: () => false, isCurrent: () => current, isRequestError }).run(session, deploymentGeneration);
    expect(result).toEqual({ stale: true, renewedNamespaceIds: [], confirmedNamespaceIds: [], unresolvedNamespaceIds: [] });
  });

  it('propagates a generation mismatch instead of collapsing it into unresolved', async () => {
    const conflict = Object.assign(new Error('generation'), { code: 'API_GENERATION_MISMATCH', status: 409 });
    const api = port({
      readSourceNamespaces: vi.fn(async () => catalog([namespace('ns-short', 1, '2026-11-01T00:00:00.000Z')])),
      renewSourceNamespace: vi.fn(async () => { throw conflict; }),
    });
    await expect(
      coordinator({ api, isAuthorizationLoss: () => false, isCurrent: () => true, isRequestError }).run(session, deploymentGeneration),
    ).rejects.toThrow(/generation/u);
  });

  it('propagates an authorization loss without renewing further', async () => {
    const loss = Object.assign(new Error('loss'), { code: 'ACCESS_SESSION_REQUIRED', status: 401 });
    const renew = vi.fn(async () => { throw loss; });
    const api = port({
      readSourceNamespaces: vi.fn(async () => catalog([
        namespace('ns-a', 1, '2026-11-01T00:00:00.000Z'),
        namespace('ns-b', 1, '2026-11-01T00:00:00.000Z'),
      ])),
      renewSourceNamespace: renew,
    });
    await expect(
      coordinator({ api, isAuthorizationLoss: (error) => error === loss, isCurrent: () => true, isRequestError }).run(session, deploymentGeneration),
    ).rejects.toThrow(/loss/u);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('marks an out-of-policy renewal unresolved', async () => {
    const api = port({
      readSourceNamespaces: vi.fn(async () => catalog([namespace('ns-short', 1, '2026-11-01T00:00:00.000Z')])),
      renewSourceNamespace: vi.fn(async () => renewed('ns-short', 1, '2026-12-05T00:00:00.000Z')),
    });
    const result = await coordinator({ api, isAuthorizationLoss: () => false, isCurrent: () => true, isRequestError }).run(session, deploymentGeneration);
    expect(result.renewedNamespaceIds).toEqual([]);
    expect(result.unresolvedNamespaceIds).toEqual(['ns-short']);
  });

  it('coalesces one concurrent run and clears on demand', async () => {
    const read = vi.fn(async () => catalog([namespace('ns-short', 1, '2026-11-01T00:00:00.000Z')]));
    const api = port({ readSourceNamespaces: read });
    const run = coordinator({ api, isAuthorizationLoss: () => false, isCurrent: () => true, isRequestError });
    const [first, second] = await Promise.all([
      run.run(session, deploymentGeneration),
      run.run(session, deploymentGeneration),
    ]);
    expect(first).toEqual(second);
    expect(read).toHaveBeenCalledTimes(1);
    run.clear();
    await run.run(session, deploymentGeneration);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('rejects a stale binding before any catalog read', async () => {
    const read = vi.fn(async () => catalog([]));
    const result = await coordinator({
      api: port({ readSourceNamespaces: read }),
      isAuthorizationLoss: () => false,
      isCurrent: () => false,
      isRequestError,
    }).run(session, deploymentGeneration);
    expect(result).toMatchObject({ stale: true });
    expect(read).not.toHaveBeenCalled();
  });
});
