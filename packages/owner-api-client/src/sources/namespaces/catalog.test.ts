import { createSessionEpoch, type SessionEpoch } from '../../transport/session/epoch';
import type { EpochPort } from '../../transport/client';
import { describe, expect, it, vi } from 'vitest';
import { confirmCreatedNamespaceReadback, createNamespacesApi, type NamespaceApiPorts } from './catalog';

const generation = 'dep-1';

const envelope = (data: unknown, traceId = 'trace-1') => ({
  data,
  trace_id: traceId,
  deployment_generation: generation,
});

const catalogData = (namespaces: unknown[], profiles: unknown[] = []) => ({
  protocol: 'eliotr.owner-namespaces.v1',
  profiles,
  namespaces,
});

const profile = (id: string, revision: number) => ({ profile_ref: { id, revision }, title: 'profile' });
const summary = (id: string, access: 'ACTIVE' | 'EXPIRED' = 'ACTIVE') => ({
  source_namespace_id: id,
  title: 'workspace',
  read_access: access,
  read_policy_generation: 1,
  read_expires_at: '2026-11-01T00:00:00.000Z',
});

/** Wire shape of a valid creation receipt used across the confirm fence. */
const created = () => ({
  protocol: 'eliotr.owner-namespace.v1' as const,
  source_namespace_id: 'ns-1',
  title: 'workspace',
  created_at: '2026-10-01T00:00:00.000Z',
  trace_id: 'trace-1',
  deployment_generation: generation,
});

const ports = (
  raw: unknown,
  acceptedStatuses: readonly number[],
  epoch: EpochPort,
): NamespaceApiPorts & { calls: unknown[] } => {
  const calls: unknown[] = [];
  const request = vi.fn(async (path: string, init: RequestInit | undefined, statuses: readonly number[]) => {
    calls.push({ path, init, statuses });
    if (statuses.some((status) => !acceptedStatuses.includes(status))) throw new Error('unexpected status policy');
    return raw;
  });
  const errors = (details: { code: string; status: number; message: string }) =>
    Object.assign(new Error(details.message), details);
  return { request: request as never, errors, epoch, calls };
};

const api = (raw: unknown, acceptedStatuses: readonly number[], epoch: EpochPort) => {
  const p = ports(raw, acceptedStatuses, epoch);
  return { api: createNamespacesApi(p), p };
};

/** A caller-owned shared epoch. The leaf captures it but never advances or closes it. */
const sharedEpoch = (): SessionEpoch => createSessionEpoch();

const failure = async (promise: Promise<unknown>): Promise<{ code: string; status: number }> => {
  try {
    await promise;
    throw new Error('expected a typed failure');
  } catch (error) {
    return { code: (error as { code: string }).code, status: (error as { status: number }).status };
  }
};

describe('C2-N namespace catalog authority', () => {
  it('reads the catalog for the expected generation and returns every decoded field', async () => {
    const { api: subject, p } = api(envelope(catalogData([summary('ns-1')], [profile('p-1', 1)])), [200], sharedEpoch());
    const catalog = await subject.readSourceNamespaces(generation);
    expect(catalog.protocol).toBe('eliotr.owner-namespaces.v1');
    expect(catalog.deployment_generation).toBe(generation);
    expect(catalog.namespaces).toEqual([expect.objectContaining({ source_namespace_id: 'ns-1', read_access: 'ACTIVE' })]);
    expect(p.calls[0]).toMatchObject({ path: '/api/v1/library/namespaces', statuses: [200] });
  });

  it('rejects a substituted deployment generation', async () => {
    const { api: subject } = api(envelope(catalogData([])), [200], sharedEpoch());
    // The catalog carries dep-1; asking with dep-2 must fail closed instead of refreshing silently.
    const result = await failure(subject.readSourceNamespaces('dep-2'));
    expect(result.code).toBe('API_GENERATION_MISMATCH');
    expect(result.status).toBe(409);
  });

  it('rejects malformed namespace identities and overlong operation keys', async () => {
    const { api: read } = api(envelope(catalogData([{ ...summary('NS-1'), source_namespace_id: ' ' }])), [200], sharedEpoch());
    expect((await failure(read.readSourceNamespaces(generation))).code).toBe('API_RESPONSE_SCHEMA_MISMATCH');
    const { api: renew } = api(envelope(catalogData([])), [200], sharedEpoch());
    expect((await failure(renew.renewSourceNamespace('', 1, generation))).code).toBe('API_RESPONSE_SCHEMA_MISMATCH');
    const { api: create } = api(envelope(catalogData([])), [200], sharedEpoch());
    expect((await failure(create.createSourceNamespace({ id: 'p-1', revision: 1 }, 'x', 'k'.repeat(300), generation))).code).toBe('API_RESPONSE_SCHEMA_MISMATCH');
  });

  it('creates and renews over the exact frozen wire payloads', async () => {
    const { api: subject, p } = api(envelope({ protocol: 'eliotr.owner-namespace.v1', source_namespace_id: 'ns-1', title: 'workspace', created_at: '2026-10-01T00:00:00.000Z' }), [200, 201], sharedEpoch());
    await subject.createSourceNamespace({ id: 'p-1', revision: 1 }, 'workspace', 'op-1', generation);
    expect(p.calls[0]).toMatchObject({ statuses: [200, 201] });
    const init = (p.calls[0] as { init: RequestInit }).init;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-eliotr-csrf')).toBe('1');
    expect(JSON.parse(String(init.body))).toEqual({ profile_ref: { id: 'p-1', revision: 1 }, title: 'workspace', idempotency_key: 'op-1' });

    const renewedRaw = envelope({ protocol: 'eliotr.owner-namespace-renewal.v1', source_namespace_id: 'ns-1', title: 'workspace', read_policy_generation: 2, read_expires_at: '2026-11-01T00:00:00.000Z', read_access: 'ACTIVE' });
    const second = api(renewedRaw, [200], sharedEpoch());
    await second.api.renewSourceNamespace('ns-1', 1, generation);
    expect((second.p.calls[0] as { path: string }).path).toBe('/api/v1/library/namespaces/ns-1/renew');
    expect(JSON.parse(String(((second.p.calls[0] as { init: RequestInit }).init.body)))).toEqual({ expected_generation: 1 });
  });

  it('rejects a held response once the shared epoch stopped being current', async () => {
    const epoch = sharedEpoch();
    const request = vi.fn((async () => {
      // The caller advances the shared epoch while the response is still in flight.
      epoch.advance();
      return envelope(catalogData([summary('ns-1')], [profile('p-1', 1)]));
    }) as never);
    const errors = (details: { code: string; status: number; message: string }) =>
      Object.assign(new Error(details.message), { code: details.code, status: details.status });
    const subject = createNamespacesApi({ request: request as never, errors, epoch });
    const result = await failure(subject.readSourceNamespaces(generation));
    expect(result.code).toBe('API_SESSION_CLOSED');
    expect(result.status).toBe(503);
  });

  it('refuses an unconfirmed creation readback', async () => {
    const errors = (details: { code: string; status: number; message: string }) =>
      Object.assign(new Error(details.message), { code: details.code, status: details.status });
    const catalog = {
      protocol: 'eliotr.owner-namespaces.v1' as const,
      profiles: [profile('p-1', 1)],
      namespaces: [summary('ns-1')],
      trace_id: 'trace-1',
      deployment_generation: generation,
    };
    expect(confirmCreatedNamespaceReadback(errors, created(), profile('p-1', 1), catalog))
      .toEqual(expect.objectContaining({ source_namespace_id: 'ns-1' }));
    const mismatch = await failure(Promise.resolve().then(() => confirmCreatedNamespaceReadback(
      errors,
      { ...created(), title: 'other-workspace' },
      profile('p-1', 1),
      catalog,
    )));
    expect(mismatch.code).toBe('NAMESPACE_READBACK_UNCONFIRMED');
  });

  it('rejects an invented outer protocol, partial policy fields and a foreign renewal receipt', async () => {
    const extra = api({ ...envelope(catalogData([])), protocol: 'eliotr.owner-response.v1' }, [200], sharedEpoch());
    await expect(extra.api.readSourceNamespaces(generation)).rejects.toMatchObject({ code: 'API_RESPONSE_SCHEMA_MISMATCH' });
    const partial = api(envelope(catalogData([{ source_namespace_id: 'ns-1', title: 'workspace', read_policy_generation: 1 }])), [200], sharedEpoch());
    await expect(partial.api.readSourceNamespaces(generation)).rejects.toMatchObject({ code: 'API_RESPONSE_SCHEMA_MISMATCH' });
    const other = api(envelope({ protocol: 'eliotr.owner-namespace-renewal.v1', ...summary('ns-2') }), [200], sharedEpoch());
    await expect(other.api.renewSourceNamespace('ns-1', 1, generation)).rejects.toMatchObject({ code: 'API_RESPONSE_SCHEMA_MISMATCH' });
  });
});
