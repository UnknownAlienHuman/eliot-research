import { describe, expect, it } from 'vitest';

import type { LegacyErrorFactory } from '../../legacy/http';
import { createSessionEpoch } from '../../transport/session/epoch';
import { createLibraryApi, type LibraryHttp } from './library';

const GEN = 'dep-gen-1';

const libraryEnvelope = (overrides: {
  projects?: unknown[];
  sources?: unknown[];
  generation?: string;
  trace?: string;
  nextCursor?: string;
} = {}) => ({
  data: {
    projects: overrides.projects ?? [{ id: 'p1', title: 'Scope and evidence', generation: GEN }],
    sources: overrides.sources ?? [{ id: 'source:a', title: 'Field notes', readiness_ref: `readiness:source:a:ra1` }],
    ...(overrides.nextCursor === undefined ? {} : { next_cursor: overrides.nextCursor }),
  },
  trace_id: overrides.trace ?? 'trace-1',
  deployment_generation: overrides.generation ?? GEN,
});

const failing: LegacyErrorFactory = (details) => new Error(`${details.code}:${details.status}`);

interface RecordedCall { readonly path: string; readonly init: RequestInit | undefined }

function recorder(responder: (path: string) => unknown): { http: LibraryHttp; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    http: {
      requestApi(path: string, init?: RequestInit) {
        calls.push({ path, init });
        return Promise.resolve(responder(path));
      },
    },
  };
}

describe('createLibraryApi decode boundaries', () => {
  it('rejects a foreign deployment generation with 409', () => {
    const { http } = recorder(() => libraryEnvelope());
    const api = createLibraryApi(http, failing, createSessionEpoch());
    expect(() => api.decodeLibraryPage(libraryEnvelope(), 'dep-gen-2'))
      .toThrow('CATALOG_GENERATION_CHANGED:409');
  });

  it('accepts a page when no generation is expected', () => {
    const { http } = recorder(() => libraryEnvelope());
    const api = createLibraryApi(http, failing, createSessionEpoch());
    const page = api.decodeLibraryPage(libraryEnvelope());
    expect(page.generation).toBe(GEN);
    expect(page.trace).toBe('trace-1');
  });

  it('rejects unordered sources', () => {
    const { http } = recorder(() => libraryEnvelope());
    const api = createLibraryApi(http, failing, createSessionEpoch());
    const envelope = libraryEnvelope({ sources: [
      { id: 'source:b', title: 'Later', readiness_ref: 'readiness:source:b:rb1' },
      { id: 'source:a', title: 'Earlier', readiness_ref: 'readiness:source:a:ra1' },
    ] });
    expect(() => api.decodeLibraryPage(envelope)).toThrow('CATALOG_RESPONSE_INVALID:502');
  });

  it('rejects a readiness reference bound to another source', () => {
    const { http } = recorder(() => libraryEnvelope());
    const api = createLibraryApi(http, failing, createSessionEpoch());
    const envelope = libraryEnvelope({ sources: [
      { id: 'source:a', title: 'Field notes', readiness_ref: 'readiness:source:b:rb1' },
    ] });
    expect(() => api.decodeLibraryPage(envelope)).toThrow('CATALOG_RESPONSE_INVALID:502');
  });

  it('rejects a continuation cursor on an empty page', () => {
    const { http } = recorder(() => libraryEnvelope());
    const api = createLibraryApi(http, failing, createSessionEpoch());
    const envelope = libraryEnvelope({ projects: [], sources: [], nextCursor: 'cursor-1' });
    expect(() => api.decodeLibraryPage(envelope)).toThrow('CATALOG_RESPONSE_INVALID:502');
  });
});

describe('createLibraryApi request shape', () => {
  it('sends the page limit, the project filter and the requested cursor', async () => {
    const { http, calls } = recorder(() => libraryEnvelope());
    const api = createLibraryApi(http, failing, createSessionEpoch());
    const page = await api.readLibraryPage({ project: 'p1', cursor: 'cursor-1' });
    expect(page.projects).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/v1/research/catalog?limit=20&project_id=p1&cursor=cursor-1');
  });

  it('rejects a stale cursor that repeats the response cursor', async () => {
    const { http } = recorder(() => libraryEnvelope({ nextCursor: 'cursor-1' }));
    const api = createLibraryApi(http, failing, createSessionEpoch());
    await expect(api.readLibraryPage({ cursor: 'cursor-1' }))
      .rejects.toThrow('CATALOG_RESPONSE_INVALID:502');
  });

  it('returns a page whose continuation differs from the requested cursor', async () => {
    const { http } = recorder(() => libraryEnvelope({ nextCursor: 'cursor-2' }));
    const api = createLibraryApi(http, failing, createSessionEpoch());
    const page = await api.readLibraryPage({ cursor: 'cursor-1' });
    expect(page.next_cursor).toBe('cursor-2');
  });
});

describe('createLibraryApi shared epoch fence', () => {
  it('rejects a library read before dispatch when the shared epoch is closed', async () => {
    const epoch = createSessionEpoch(); const { http, calls } = recorder(() => ({}));
    const api = createLibraryApi(http, failing, epoch); epoch.close();
    await expect(api.readLibraryPage({})).rejects.toThrow('API_SESSION_CLOSED:503');
    expect(calls).toHaveLength(0);
  });
  it('rejects a decoded page produced after the shared epoch advanced', async () => {
    const epoch = createSessionEpoch();
    const { http } = recorder(() => libraryEnvelope());
    const api = createLibraryApi(http, failing, epoch);
    const promise = api.readLibraryPage({});
    // The response resolves and decodes cleanly; the fence alone rejects the stale result.
    epoch.advance();
    await expect(promise).rejects.toThrow('API_SESSION_CLOSED:503');
  });

  it('returns a decoded page while the shared epoch is unchanged', async () => {
    const epoch = createSessionEpoch();
    const { http } = recorder(() => libraryEnvelope());
    const api = createLibraryApi(http, failing, epoch);
    const page = await api.readLibraryPage({});
    expect(page.generation).toBe(GEN);
  });

  /** Deferred injected request port with the actual shared epoch implementation. */
  it('deferred: injected port plus real epoch rejects output that arrives stale', async () => {
    const epoch = createSessionEpoch();
    let released: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { released = resolve; });
    const http = {
      requestApi() {
        return gate.then(() => libraryEnvelope());
      },
    } as unknown as LibraryHttp;
    const api = createLibraryApi(http, failing, epoch);
    const pending = api.readLibraryPage({});
    released?.();
    await gate;
    epoch.advance();
    await expect(pending).rejects.toThrow('API_SESSION_CLOSED:503');
  });
});
