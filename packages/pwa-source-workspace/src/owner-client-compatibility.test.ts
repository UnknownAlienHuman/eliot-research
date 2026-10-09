import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from './api';
import { decodeLibraryPage, readLibraryPage } from './library-api';
import { readProjects } from './project-api';
import { bindSourceWorkspaceClientLifecycle, legacySourceEpoch } from './owner-client-ports';

const envelope = (data: unknown) => ({ data, trace_id: 'trace-1', deployment_generation: 'dep-1' });
const library = envelope({ projects: [], sources: [{ id: 'source-1', title: 'A source', readiness_ref: 'readiness:source-1:dep-1' }] });
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); legacySourceEpoch.advance(); });

describe('legacy Sources facades over the owner client', () => {
  it('keeps the legacy error class and accepted library shape', () => {
    expect(decodeLibraryPage(library, 'dep-1').sources[0]?.title).toBe('A source');
    expect(() => decodeLibraryPage({ ...library, extra: true })).toThrow(ApiRequestError);
  });

  it('rejects a held old-epoch read while allowing a fresh epoch read', async () => {
    const target = new EventTarget();
    const unbind = bindSourceWorkspaceClientLifecycle(target, new EventTarget());
    let release!: (value: Response) => void;
    const held = new Promise<Response>(resolve => { release = resolve; });
    const fetchPort = vi.fn().mockReturnValueOnce(held).mockResolvedValueOnce(response(library));
    vi.stubGlobal('fetch', fetchPort);
    try {
      const old = readLibraryPage({ generation: 'dep-1' });
      target.dispatchEvent(new Event('eliotr:authorization-cleared'));
      release(response(library));
      await expect(old).rejects.toMatchObject({ name: 'ApiRequestError', code: 'API_SESSION_CLOSED', status: 503 });
      await expect(readLibraryPage({ generation: 'dep-1' })).resolves.toMatchObject({ generation: 'dep-1' });
      expect(fetchPort).toHaveBeenCalledTimes(2);
    } finally { unbind(); }
  });

  it('does not dispatch protected reads after pagehide', async () => {
    const target = new EventTarget();
    const unbind = bindSourceWorkspaceClientLifecycle(target, new EventTarget());
    const fetchPort = vi.fn();
    vi.stubGlobal('fetch', fetchPort);
    try {
      target.dispatchEvent(new Event('pagehide'));
      await expect(readProjects('dep-1')).rejects.toMatchObject({ code: 'API_SESSION_CLOSED', status: 503 });
      expect(fetchPort).not.toHaveBeenCalled();
    } finally { unbind(); }
  });
});
