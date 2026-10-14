import { describe, expect, it } from 'vitest';

import type { LegacyErrorFactory } from '../../legacy/http';
import { createSessionEpoch, type SessionEpoch } from '../../transport/session/epoch';
import { createProjectsApi, type ProjectsHttp } from './projects';

const GEN = 'dep-gen-1';

/** Builds a wire project row that passes every strict decoder rule. */
const projectRow = (id: string) => ({
  protocol: 'eliotr.project-owner.v1',
  project_ref: { id, revision: 3 },
  title: 'Scope and evidence',
  revision: 3,
  owner_principal_ref: 'principal:1',
  deployment_generation: GEN,
  source_ids: ['source:a', 'source:b'],
  created_at: '2026-10-09T12:00:00.000Z',
});

const listEnvelope = (projects: unknown[], nextProjectId?: string) => ({
  data: {
    protocol: 'eliotr.project-owner-list.v1',
    projects,
    ...(nextProjectId === undefined ? {} : { next_project_id: nextProjectId }),
  },
  trace_id: 'trace-1',
  deployment_generation: GEN,
});

const mutationEnvelope = (id: string) => ({
  data: projectRow(id),
  trace_id: 'trace-2',
  deployment_generation: GEN,
});

const failing: LegacyErrorFactory = (details) => new Error(`${details.code}:${details.status}`);

interface RecordedCall {
  readonly path: string;
  readonly init: RequestInit | undefined;
  readonly statuses: readonly number[];
}

function recorder(responder: (path: string) => unknown): { http: ProjectsHttp; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    http: {
      requestApi(path: string, init?: RequestInit) {
        calls.push({ path, init, statuses: [200] });
        return Promise.resolve(responder(path));
      },
      requestApiWithStatuses(path: string, init: RequestInit | undefined, statuses: readonly number[]) {
        calls.push({ path, init, statuses });
        return Promise.resolve(responder(path));
      },
    },
  };
}

describe('createProjectsApi decode boundaries', () => {
  it('rejects a foreign deployment generation with 409', () => {
    const { http } = recorder(() => listEnvelope([projectRow('p1')]));
    const api = createProjectsApi(http, failing, createSessionEpoch());
    expect(() => api.decodeProjectList(listEnvelope([projectRow('p1')]), 'dep-gen-2')).toThrow('PROJECT_GENERATION_MISMATCH:409');
  });

  it('rejects an unordered project page', () => {
    const { http } = recorder(() => ({}));
    const api = createProjectsApi(http, failing, createSessionEpoch());
    const envelope = listEnvelope([projectRow('p2'), projectRow('p1')]);
    expect(() => api.decodeProjectList(envelope, GEN)).toThrow('PROJECT_RESPONSE_INVALID:502');
  });

  it('decodes the producer exclusive cursor across 257 projects without omission or duplication', async () => {
    const producerRows = Array.from({ length: 257 }, (_, index) => projectRow(`project-${String(index).padStart(3, '0')}`));
    const producerPage = (afterProjectId?: string) => {
      // Pair the server contract: read 256 + 1, return 256, and continue strictly after the last returned ID.
      const fetched = producerRows
        .filter((row) => afterProjectId === undefined || row.project_ref.id > afterProjectId)
        .slice(0, 257);
      const projects = fetched.slice(0, 256);
      const hasMore = fetched.length === 257;
      return listEnvelope(projects, hasMore ? projects.at(-1)?.project_ref.id : undefined);
    };
    const { http, calls } = recorder((path) => {
      const afterProjectId = new URL(path, 'https://owner.invalid').searchParams.get('after_project_id') ?? undefined;
      return producerPage(afterProjectId);
    });
    const api = createProjectsApi(http, failing, createSessionEpoch());

    const firstPage = await api.readProjects(GEN);
    expect(firstPage.projects).toHaveLength(256);
    expect(firstPage.next_project_id).toBe('project-255');
    const secondPage = await api.readProjects(GEN, firstPage.next_project_id);
    expect(secondPage.projects).toHaveLength(1);
    expect(secondPage.next_project_id).toBeUndefined();

    const actualIds = [...firstPage.projects, ...secondPage.projects].map((project) => project.project_id);
    expect(actualIds).toEqual(producerRows.map((row) => row.project_ref.id));
    expect(new Set(actualIds).size).toBe(257);
    expect(calls.map((call) => call.path)).toEqual([
      '/api/v1/research/projects',
      '/api/v1/research/projects?after_project_id=project-255',
    ]);
  });

  it('rejects a continuation cursor that is not after the last project', () => {
    const { http } = recorder(() => ({}));
    const api = createProjectsApi(http, failing, createSessionEpoch());
    const envelope = listEnvelope([projectRow('p1')], 'p0');
    expect(() => api.decodeProjectList(envelope, GEN)).toThrow('PROJECT_RESPONSE_INVALID:502');
  });

  it('rejects a continuation cursor that skips past the last project', () => {
    const { http } = recorder(() => ({}));
    const api = createProjectsApi(http, failing, createSessionEpoch());
    const envelope = listEnvelope([projectRow('p1')], 'p2');
    expect(() => api.decodeProjectList(envelope, GEN)).toThrow('PROJECT_RESPONSE_INVALID:502');
  });

  it('rejects a continuation without any project on the page', () => {
    const { http } = recorder(() => ({}));
    const api = createProjectsApi(http, failing, createSessionEpoch());
    const envelope = listEnvelope([], 'p9');
    expect(() => api.decodeProjectList(envelope, GEN)).toThrow('PROJECT_RESPONSE_INVALID:502');
  });
});

describe('createProjectsApi request shape', () => {
  it('captures the request body, idempotency and status set for create', async () => {
    const { http, calls } = recorder(() => mutationEnvelope('p1'));
    const api = createProjectsApi(http, failing, createSessionEpoch());
    const view = await api.createProject('Scope and evidence', ['source:b', 'source:a'], 'idem-key-1', GEN);
    expect(view.state).toBe('CREATED');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/v1/research/projects');
    // Idempotency and CSRF travel as headers through the seam; sources are canonicalized by sorting.
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('idem-key-1');
    expect(headers['x-eliotr-csrf']).toBe('1');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      title: 'Scope and evidence',
      source_ids: ['source:a', 'source:b'],
    });
    expect(calls[0]?.statuses).toEqual([200, 201]);
  });

  it('captures the expected revision and 200-only status for update', async () => {
    const { http, calls } = recorder(() => mutationEnvelope('p1'));
    const api = createProjectsApi(http, failing, createSessionEpoch());
    const view = await api.updateProject('p1', 'Renamed', ['source:a'], 3, 'idem-key-2', GEN);
    expect(view.state).toBe('UPDATED');
    expect(calls[0]?.path).toBe('/api/v1/research/projects/p1');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      title: 'Renamed',
      source_ids: ['source:a'],
      expected_revision: 3,
    });
    expect(calls[0]?.statuses).toEqual([200]);
  });

  it('rejects an out-of-range expected revision before any request', async () => {
    const { http, calls } = recorder(() => mutationEnvelope('p1'));
    const api = createProjectsApi(http, failing, createSessionEpoch());
    await expect(api.updateProject('p1', 'Renamed', ['source:a'], 0, 'idem-key-3', GEN))
      .rejects.toThrow('PROJECT_INPUT_INVALID:400');
    expect(calls).toHaveLength(0);
  });
});

describe('createProjectsApi shared epoch fence', () => {
  it('rejects all project operations before dispatch when the shared epoch is closed', async () => {
    const epoch = createSessionEpoch(); const { http, calls } = recorder(() => ({}));
    const api = createProjectsApi(http, failing, epoch); epoch.close();
    await expect(api.readProjects(GEN)).rejects.toThrow('API_SESSION_CLOSED:503');
    await expect(api.createProject('Title', ['source:a'], 'key-1', GEN)).rejects.toThrow('API_SESSION_CLOSED:503');
    await expect(api.updateProject('p1', 'Title', ['source:a'], 1, 'key-2', GEN)).rejects.toThrow('API_SESSION_CLOSED:503');
    expect(calls).toHaveLength(0);
  });
  it('rejects a decoded list produced after the shared epoch advanced', async () => {
    const epoch = createSessionEpoch();
    const { http } = recorder(() => listEnvelope([projectRow('p1')]));
    const api = createProjectsApi(http, failing, epoch);
    const promise = api.readProjects(GEN);
    // Advancing before the awaited microtask drains proves the fence, not the transport, rejects
    // stale output: the response resolves and decodes cleanly, then is discarded.
    epoch.advance();
    await expect(promise).rejects.toThrow('API_SESSION_CLOSED:503');
  });

  it('rejects a decoded mutation produced after the shared epoch advanced', async () => {
    const epoch = createSessionEpoch();
    const { http } = recorder(() => mutationEnvelope('p1'));
    const api = createProjectsApi(http, failing, epoch);
    const promise = api.createProject('Scope and evidence', ['source:a'], 'idem-key-4', GEN);
    epoch.advance();
    await expect(promise).rejects.toThrow('API_SESSION_CLOSED:503');
  });

  it('returns a decoded list while the shared epoch is unchanged', async () => {
    const epoch = createSessionEpoch();
    const { http } = recorder(() => listEnvelope([projectRow('p1')]));
    const api = createProjectsApi(http, failing, epoch);
    const view = await api.readProjects(GEN);
    expect(view.projects.map((row) => row.project_id)).toEqual(['p1']);
    expect(view.deployment_generation).toBe(GEN);
  });

  /** Deferred injected request port with the actual shared epoch implementation. */
  it('deferred: injected port plus real epoch rejects output that arrives stale', async () => {
    const epoch: SessionEpoch = createSessionEpoch();
    let released: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { released = resolve; });
    const http = {
      requestApi() {
        return gate.then(() => listEnvelope([projectRow('p1')]));
      },
      requestApiWithStatuses() {
        return gate.then(() => mutationEnvelope('p1'));
      },
    } as unknown as ProjectsHttp;
    const api = createProjectsApi(http, failing, epoch);
    const pending = api.readProjects(GEN);
    released?.();
    await gate;
    epoch.advance();
    await expect(pending).rejects.toThrow('API_SESSION_CLOSED:503');
  });
});
