/**
 * U3-P New Project preview environment.
 *
 * The real `createProjectCreationController` drives the real owner client, the real privacy controller and
 * one protected Query memory, so the interactions below cross the same fences production uses. Wire bodies
 * satisfy the strict decoders in `sources/projects-library/projects.ts` unchanged.
 *
 * The lost acknowledgement is a real transport failure at the seam, and the frozen identity recovers
 * through the same create receipt path before canonical readback. The empty-scope variant exercises
 * first-project bootstrap. No provider, deployment or owner account is involved; the fetch port is local.
 */

import { useEffect, useState } from 'react';
import type { ProjectSummary } from '@eliotr/owner-api-client';
import { createWorkspaceRuntime, type BoundWorkspaceApis } from './runtime';
import { createPrivacyController, type PrivacyController, type SessionContext } from './privacy';
import { clearWorkspaceQueries, createWorkspaceQueryClient } from '../query/client';
import { NewProjectPanel } from './NewProjectPanel';

const generation = 'new-project-preview';
const stamp = '2026-10-13T12:00:00.000Z';
const principal = 'new-project-owner';
export const previewTitle = 'Evidence scope for the next question';
export const previewSourceIds: readonly string[] = ['source:new-project-a', 'source:new-project-b'];
export const previewSourceLabels: readonly string[] = ['Captured evidence scope', 'Recorded evidence scope'];
const projectsPath = '/api/v1/research/projects';

/** A wire row that passes every strict decoder rule in projects.ts. */
function projectRow(id: string, rowTitle: string, sources: readonly string[], revision = 1) {
  return {
    protocol: 'eliotr.project-owner.v1',
    project_ref: { id, revision },
    title: rowTitle,
    revision,
    owner_principal_ref: principal,
    deployment_generation: generation,
    source_ids: sources,
    created_at: stamp,
  };
}

const earlierRow = projectRow('project-earlier', 'Earlier work', ['source:new-project-a']);

const json = (data: unknown, responseGeneration = generation) => new Response(JSON.stringify({
  data, trace_id: 'new-project-trace', deployment_generation: responseGeneration,
}), { headers: { 'content-type': 'application/json' } });

const foreignGeneration = generation + '-other';

export interface NewProjectPreviewCounts {
  readonly createBodies: readonly string[];
  readonly createKeys: readonly string[];
  readonly mintedKeys: readonly string[];
  readonly listReads: number;
  readonly committed: readonly ProjectSummary[];
}

export interface NewProjectPreviewProbe {
  counts(): NewProjectPreviewCounts;
  failCreate(reason: 'lost-ack' | 'unreachable' | undefined): void;
  readbackRow(kind: 'canonical' | 'foreign' | 'moved-revision' | 'renamed'): void;
  readbackGeneration(kind: 'current' | 'foreign'): void;
  closeSession(): void;
}

export interface NewProjectPreviewEnvironment {
  readonly client: ReturnType<typeof createWorkspaceQueryClient>;
  readonly privacy: PrivacyController;
  readonly runtime: ReturnType<typeof createWorkspaceRuntime>;
  readonly probe: NewProjectPreviewProbe;
  readonly context: SessionContext;
  readonly apis: BoundWorkspaceApis;
  readonly onProjectCommitted: (project: ProjectSummary) => void;
  dispose(): void;
}

export function buildNewProjectPreviewEnvironment(options: { readonly emptyScope?: boolean } = {}): NewProjectPreviewEnvironment {
  const client = createWorkspaceQueryClient();
  const timers = { setTimeout: () => 0, clearTimeout() {} };
  const createBodies: string[] = [], createKeys: string[] = [], mintedKeys: string[] = [];
  const committed: ProjectSummary[] = [];
  const projectSources = options.emptyScope ? [] : previewSourceIds;
  const rowForIntent = projectRow('project-new', previewTitle, projectSources);
  let listReads = 0;
  let failure: 'lost-ack' | 'unreachable' | undefined;
  let lostAcknowledgementReturned = false;
  let rowKind: 'canonical' | 'foreign' | 'moved-revision' | 'renamed' = 'canonical';
  let readbackGenerationValue = generation;
  const health = json({ ready: true, deployment_generation: generation, core_schema_generation: 'schema-1',
    search_schema_generation: 'schema-1', blocking_reason_codes: [], checked_at: stamp });
  const session = json({ protocol: 'eliotr.owner-session.v1', principal_ref: principal,
    credential_generation: 'credentials-1', client_class: 'owner_pwa', expires_at: '2027-01-01T00:00:00.000Z' });
  const acknowledgedRow = () => {
    if (rowKind === 'moved-revision') return projectRow('project-new', previewTitle, projectSources, 3);
    if (rowKind === 'renamed') return projectRow('project-new', 'Renamed by the server', projectSources);
    return rowForIntent;
  };
  const canonicalRow = () => rowKind === 'foreign' ? projectRow('project-someone-else', previewTitle, projectSources) : acknowledgedRow();
  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(String(input), 'https://preview.invalid');
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    if (url.pathname === '/api/v1/system/health') return health;
    if (url.pathname === '/api/v1/system/session') return session;
    if (url.pathname === projectsPath && method === 'POST') {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      createBodies.push(String((init as RequestInit | undefined)?.body));
      createKeys.push(headers.get('idempotency-key') ?? '');
      if (failure === 'lost-ack' && !lostAcknowledgementReturned) {
        lostAcknowledgementReturned = true;
        throw new TypeError('Synthetic lost acknowledgement after durable create');
      }
      if (failure === 'unreachable') throw new TypeError('Synthetic unreachable owner response');
      return json(acknowledgedRow());
    }
    if (url.pathname === projectsPath) {
      listReads += 1;
      return json({ protocol: 'eliotr.project-owner-list.v1',
        projects: [earlierRow, canonicalRow()] }, readbackGenerationValue);
    }
    throw new Error('Unexpected New Project preview request: ' + method + ' ' + url.pathname);
  };
  const runtime = createWorkspaceRuntime({ fetch: fetchFixture, baseUrl: 'https://preview.invalid', timers,
    now: () => Date.parse(stamp),
    sha256: async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice())),
      value => value.toString(16).padStart(2, '0')).join(''),
    mint() { const key = '44444444-4444-4444-8444-' + String(mintedKeys.length).padStart(12, '0'); mintedKeys.push(key); return key; },
    isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); } });
  const privacy = createPrivacyController({ timers, now: () => Date.parse(stamp), mask() { runtime.close(); }, reveal() {},
    cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); },
    clearProtected() { clearWorkspaceQueries(client); }, verify: signal => runtime.verify(signal) });
  const probe: NewProjectPreviewProbe = {
    counts: () => ({ createBodies: [...createBodies], createKeys: [...createKeys], mintedKeys: [...mintedKeys],
      listReads, committed: [...committed] }),
    failCreate: reason => { failure = reason; },
    readbackRow: kind => { rowKind = kind; },
    readbackGeneration: kind => { readbackGenerationValue = kind === 'foreign' ? foreignGeneration : generation; },
    closeSession: () => privacy.close(),
  };
  const context = (): SessionContext => {
    const snapshot = privacy.getSnapshot();
    if (snapshot.phase !== 'available') throw new Error('New Project preview owner authority is unavailable');
    runtime.bind(snapshot.context);
    return snapshot.context;
  };
  return { client, privacy, runtime, probe,
    get context() { return context(); },
    get apis(): BoundWorkspaceApis {
      const current = context();
      const apis = runtime.read(current);
      if (!apis) throw new Error('New Project preview runtime did not bind');
      return apis;
    },
    onProjectCommitted: project => committed.push(project),
    dispose() { runtime.dispose(); privacy.dispose(); client.clear(); },
  };
}

const environments = new WeakMap<HTMLElement, WeakRef<NewProjectPreviewEnvironment>>();

export interface NewProjectPreviewProps { readonly emptyScope?: boolean }

export function NewProjectPreview({ emptyScope = false }: NewProjectPreviewProps) {
  const [environment] = useState(() => buildNewProjectPreviewEnvironment({ emptyScope }));
  const [open, setOpen] = useState(false);
  const [, refresh] = useState(0);
  useEffect(() => {
    const unsubscribe = environment.privacy.subscribe(() => { const snapshot = environment.privacy.getSnapshot();
      if (snapshot.phase === 'available') environment.runtime.bind(snapshot.context);
      refresh(value => value + 1); });
    void environment.privacy.refresh();
    return () => { unsubscribe(); environment.dispose(); };
  }, [environment]);
  return <div data-new-project-preview ref={node => { if (node) environments.set(node, new WeakRef(environment)); }}>
    {environment.privacy.getSnapshot().phase === 'available' && <>
      <button type="button" onClick={() => setOpen(true)}>New project</button>
      <NewProjectPanel locale="en" apis={environment.apis} privacy={environment.privacy} context={environment.context}
        scope={(emptyScope ? [] : previewSourceIds).map((id, index) => ({ id, label: previewSourceLabels[index] ?? id }))}
        open={open} onClose={() => setOpen(false)} onProjectCommitted={environment.onProjectCommitted} />
    </>}
  </div>;
}

export function newProjectPreviewEnvironment(root: HTMLElement): NewProjectPreviewEnvironment | undefined {
  return environments.get(root)?.deref();
}

