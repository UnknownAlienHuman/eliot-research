import { useEffect, useLayoutEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router';
import type { LibraryPage, SourceRevisionPage } from '@eliotr/owner-api-client';
import { Shell } from './Shell';
import { paneAnnouncement, announcementUntil, unchangedChannel } from './announcementAssertions';
import { createWorkspaceRuntime } from './runtime';
import { createPrivacyController, type SessionContext } from './privacy';
import { clearWorkspaceQueries, createWorkspaceQueryClient, protectedQueryKey } from '../query/client';

const generation = 'live-fixture', stamp = '2026-10-09T12:00:00.000Z';
const project = 'project-live-1', source = 'source-live-1', revision = 'revision-live-1';
const sourceTitle = 'How source versions preserve evidence';
const refusedText = 'Late reader bytes must never be admitted.';
const documentText = '# Reader race fixture\n\n' + refusedText + '\n';
const encode = (text: string) => new TextEncoder().encode(text);
const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)), value => value.toString(16).padStart(2, '0')).join('');
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function deferred() {
  let complete = () => {};
  const promise = new Promise<void>(resolve => { complete = () => resolve(); });
  return { promise, release: () => complete() };
}
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, label: string) {
  for (let count = 0; count < 120; count++) { if (predicate()) return; await frame(); }
  throw new Error('Finite reader fixture timed out: ' + label);
}

type ReadFailure = 'readiness' | 'revisions' | 'both';
function createFixture(readFailure?: ReadFailure) {
  const client = createWorkspaceQueryClient(), gate = deferred();
  const timers = { setTimeout: () => 0, clearTimeout() {} };
  const digest = sha256(encode(documentText));
  let contentCalls = 0, returned = 0, readinessCalls = 0, revisionsCalls = 0;
  const readinessGate = deferred(), revisionsGate = deferred();
  const route: { navigate: NavigateFunction | undefined; state: unknown } = { navigate: undefined, state: undefined };
  const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: 'live-trace-1', deployment_generation: generation }), { headers: { 'content-type': 'application/json' } });
  // Only this synthetic boundary ignores cancellation; runtime/client/reader remain real.
  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(String(input), 'https://fixture.invalid');
    if (init?.method && init.method !== 'GET') throw new Error('Reader fixture dispatched a mutation');
    if (url.pathname === '/api/v1/system/health') return json({ ready: true, deployment_generation: generation, core_schema_generation: 'schema-1', search_schema_generation: 'schema-1', blocking_reason_codes: [], checked_at: stamp });
    if (url.pathname === '/api/v1/system/session') return json({ protocol: 'eliotr.owner-session.v1', principal_ref: 'live-owner', credential_generation: 'live-credential', client_class: 'owner_pwa', expires_at: '2027-01-01T00:00:00.000Z' });
    if (url.pathname === '/api/v1/research/projects') return json({ protocol: 'eliotr.project-owner-list.v1', projects: [{ protocol: 'eliotr.project-owner.v1', project_ref: { id: project, revision: 1 }, title: 'Evidence in context', revision: 1, owner_principal_ref: 'live-owner', deployment_generation: generation, source_ids: [source], created_at: stamp }] });
    if (url.pathname === '/api/v1/research/catalog') return json({ projects: [{ id: project, title: 'Evidence in context', generation }], sources: [{ id: source, title: sourceTitle, readiness_ref: 'readiness:source-live-1:observation-1' }] });
    if (url.pathname === '/api/v1/library/readiness') {
      readinessCalls++;
      if (readFailure === 'readiness' || readFailure === 'both') {
        if (readinessCalls === 1) throw new TypeError('Synthetic readiness-only read failure');
        await readinessGate.promise;
      }
      return json({
      protocol: 'eliotr.library-readiness.v1', source_id: source, source_revision_ref: revision,
      deployment_generation: generation, catalog_generation: '1', observed_at: stamp, quality_state: 'high_fidelity', readiness_basis: 'ACTIVE_VERIFIED',
      currentness: { verification: 'VERIFIED', value: { source_revision_ref: revision, owner_system_id: 'owner-system', source_owner_generation: 'owner-generation', source_view_ref: 'source-view', observation_freshness: 'current_confirmed', observed_at: stamp, gap_refs: [] } },
      channels: ['exact_ready', 'lexical_ready', 'semantic_ready'].map(channel => ({ channel, state: 'ready', source_revision_ref: revision, reason_codes: [], observed_at: stamp, generation: 'channel-1', receipt_ref: 'readiness-receipt' })),
    });
    }
    if (url.pathname === '/api/v1/library/revisions') {
      revisionsCalls++;
      if (readFailure === 'revisions' || readFailure === 'both') {
        if (revisionsCalls === 1) throw new TypeError('Synthetic versions-only read failure');
        await revisionsGate.promise;
      }
      return json({ protocol: 'eliotr.source-revisions.v1', source_id: source, head_revision_ref: revision, observed_at: stamp, readiness_basis: 'RECORDED_ONLY', revisions: [{ source_revision_ref: revision, content_sha256: await digest, captured_at: stamp, admitted_at: stamp, quality_state: 'high_fidelity', currentness_state: 'current_confirmed', readiness: [] }] });
    }
    if (url.pathname === '/api/v1/library/content' && url.searchParams.get('source_revision_ref') === revision) {
      contentCalls++; if (contentCalls !== 1) throw new Error('Reader fixture repeated the document request');
      await gate.promise;
      const response = new Response(documentText, { headers: { 'content-type': 'text/plain', 'content-length': String(encode(documentText).byteLength), 'x-eliotr-source-revision': revision, 'x-eliotr-deployment-generation': generation, 'x-eliotr-content-sha256': await digest } });
      returned++; return response;
    }
    throw new Error('Unexpected finite reader request: ' + url.pathname);
  };
  const runtime = createWorkspaceRuntime({
    fetch: fetchFixture, baseUrl: 'https://fixture.invalid', timers, now: () => Date.parse(stamp), sha256,
    mint() { throw new Error('Reader fixture minted a mutation intent'); },
    isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); },
  });
  const privacy = createPrivacyController({
    now: () => Date.parse(stamp), timers, mask() { runtime.close(); }, reveal() {},
    cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); },
    clearProtected() { clearWorkspaceQueries(client); }, verify: signal => runtime.verify(signal),
  });
  const context = (): SessionContext => {
    const snapshot = privacy.getSnapshot();
    if (snapshot.phase !== 'available') throw new Error('Reader fixture is not current');
    return snapshot.context;
  };
  const documentKey = (held: SessionContext) => [...protectedQueryKey(held, 'sources'), 'document', source, revision];
  const replaceHolder = (kind: 'library' | 'revisions', held: SessionContext) => {
    const prefix = protectedQueryKey(held, 'sources');
    if (kind === 'library') {
      const key = [...prefix, 'library', project, null], old = client.getQueryData<LibraryPage>(key);
      assert(old, 'Current library page was not held');
      client.setQueryData<LibraryPage>(key, { ...old, trace: 'superseded-library-holder' });
      assert(client.getQueryData(key) !== old, 'Structural sharing retained the old library holder');
    } else {
      const key = [...prefix, 'revisions', source, null], old = client.getQueryData<SourceRevisionPage>(key);
      assert(old, 'Current revision page was not held');
      client.setQueryData<SourceRevisionPage>(key, { ...old, trace: 'superseded-revision-holder' });
      assert(client.getQueryData(key) !== old, 'Structural sharing retained the old revision holder');
    }
  };
  return { client, runtime, privacy, context, documentKey, replaceHolder, gate, route,
    readFailure, readinessGate, revisionsGate, metrics: () => ({ contentCalls, returned, readinessCalls, revisionsCalls }) };
}
type Environment = ReturnType<typeof createFixture>;
const environments = new WeakMap<HTMLElement, Environment>();
function RoutedFixture({ environment }: { readonly environment: Environment }) {
  const navigate = useNavigate(), location = useLocation();
  useLayoutEffect(() => {
    environment.route.navigate = navigate; environment.route.state = location.state;
    return () => { if (environment.route.navigate === navigate) environment.route.navigate = undefined; };
  }, [environment, navigate, location.state]);
  return <Shell privacy={environment.privacy} runtime={environment.runtime} fixture={false} />;
}
/** Relocate into src/app; private proposal, not executed qualification. */
export function FiniteReaderPreview({ readFailure }: { readonly readFailure?: ReadFailure }) {
  const [environment] = useState(() => createFixture(readFailure));
  useEffect(() => {
    const unsubscribe = environment.privacy.subscribe(() => {
      const snapshot = environment.privacy.getSnapshot();
      if (snapshot.phase === 'available') environment.runtime.bind(snapshot.context);
    });
    void environment.privacy.refresh();
    return () => { environment.gate.release(); environment.readinessGate.release(); environment.revisionsGate.release(); unsubscribe(); environment.privacy.dispose(); environment.runtime.dispose(); environment.client.clear(); };
  }, [environment]);
  return <div data-finite-reader ref={node => { if (node) environments.set(node, environment); }}>
    <QueryClientProvider client={environment.client}><MemoryRouter initialEntries={['/sources']}>
      <RoutedFixture environment={environment} />
    </MemoryRouter></QueryClientProvider>
  </div>;
}
export interface ReaderPlayContext {
  readonly canvasElement: HTMLElement;
  readonly canvas: {
    findByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): Promise<HTMLElement>;
    findByText(text: string | RegExp): Promise<HTMLElement>;
    queryByRole(role: string): HTMLElement | null;
  };
  readonly userEvent: { click(element: HTMLElement): Promise<void>; selectOptions(element: HTMLElement, value: string): Promise<void> };
}
function environmentFor(canvasElement: HTMLElement): Environment {
  // Fixture-only registration lookup; no product selection/state comes from the DOM.
  const host = canvasElement.querySelector<HTMLElement>('[data-finite-reader]');
  const environment = host && environments.get(host);
  assert(environment, 'Finite reader fixture was not registered');
  return environment;
}
function assertNoDocument(test: ReaderPlayContext, environment: Environment, held: SessionContext) {
  assert(!test.canvasElement.textContent?.includes(refusedText), 'Late document text reached the composed reader');
  assert(environment.client.getQueryData(environment.documentKey(held)) === undefined, 'Refused document reached protected Query data');
}
async function selectCurrentSource(test: ReaderPlayContext) {
  const environment = environmentFor(test.canvasElement);
  await test.userEvent.selectOptions(await test.canvas.findByRole('combobox', { name: 'Project', exact: true }), project);
  await test.userEvent.click(await test.canvas.findByRole('button', { name: sourceTitle, exact: true }));
  const read = await test.canvas.findByRole('button', { name: 'Read version 1', exact: true });
  return { environment, held: environment.context(), read };
}
async function openPendingDocument(test: ReaderPlayContext) {
  const selected = await selectCurrentSource(test);
  await test.userEvent.click(selected.read);
  await test.canvas.findByRole('dialog', { name: sourceTitle });
  await until(() => selected.environment.metrics().contentCalls === 1, 'pending whole-document request');
  assertNoDocument(test, selected.environment, selected.held);
  return selected;
}
async function staleHolder(test: ReaderPlayContext, kind: 'library' | 'revisions') {
  const { environment, held } = await openPendingDocument(test);
  try {
    environment.replaceHolder(kind, held); environment.gate.release();
    await until(() => environment.client.getQueryState(environment.documentKey(held))?.status === 'error', 'stale holder refusal');
    await test.canvas.findByText('The document could not be read.');
    assert(environment.metrics().contentCalls === 1 && environment.metrics().returned === 1, 'Race did not exercise exactly one completed synthetic response');
    assertNoDocument(test, environment, held);
  } finally { environment.gate.release(); }
}
export const playStaleLibraryHolder = (test: ReaderPlayContext) => staleHolder(test, 'library');
export const playStaleRevisionHolder = (test: ReaderPlayContext) => staleHolder(test, 'revisions');
export async function playPrivacyLateHistoryReplay(test: ReaderPlayContext) {
  const { environment, held } = await openPendingDocument(test);
  try {
    const oldState = environment.route.state;
    assert(oldState !== null && typeof oldState === 'object' && 'cacheEpoch' in oldState && oldState.cacheEpoch === held.cacheEpoch, 'Original reader history did not hold the actual epoch');
    environment.privacy.close(); environment.gate.release();
    await until(() => environment.metrics().returned === 1 && environment.client.getQueryCache().getAll().length === 0 && test.canvas.queryByRole('dialog') === null, 'late response after privacy close');
    assertNoDocument(test, environment, held);
    const navigate = environment.route.navigate; assert(navigate, 'Router bridge unavailable');
    await navigate(-1); await frame(); await navigate(1); await frame();
    assert(environment.route.state === oldState, 'MemoryRouter did not replay the original reader entry');
    assert(test.canvas.queryByRole('dialog') === null, 'Closed privacy reopened the old reader');
    assertNoDocument(test, environment, held);
    await environment.privacy.refresh();
    await test.canvas.findByRole('combobox', { name: 'Project', exact: true });
    const next = environment.context(); assert(next.cacheEpoch !== held.cacheEpoch, 'Refresh reused the old privacy epoch');
    const selected = await selectCurrentSource(test); await frame();
    assert(selected.held === next, 'Source setup did not use the new current context');
    assert(test.canvas.queryByRole('dialog') === null && environment.metrics().contentCalls === 1, 'Old history replay dispatched or displayed a second document');
    assertNoDocument(test, environment, held); assertNoDocument(test, environment, next);
    assert(environment.client.getQueryCache().getAll().every(query => query.queryKey[1] !== held.cacheEpoch), 'Old protected Query entries survived refresh');
  } finally { environment.gate.release(); }
}
async function foreignRoute(test: ReaderPlayContext, field: 'projectId' | 'sourceId') {
  const { environment, held } = await selectCurrentSource(test);
  const navigate = environment.route.navigate; assert(navigate, 'Router bridge unavailable');
  const state = { sourceDocument: revision, sourceId: source, projectId: project, cacheEpoch: held.cacheEpoch,
    [field]: field === 'projectId' ? 'project-live-foreign' : 'source-live-foreign' };
  await navigate('/sources', { state, preventScrollReset: true });
  await until(() => environment.route.state === state, 'same-epoch foreign route commit'); await frame();
  assert(environment.privacy.isCurrent(held), 'Foreign route case accidentally tested a stale epoch');
  assert(test.canvas.queryByRole('dialog') === null && environment.metrics().contentCalls === 0, 'Same-epoch foreign route opened or fetched a document');
  assertNoDocument(test, environment, held);
}
export const playSameEpochForeignProject = (test: ReaderPlayContext) => foreignRoute(test, 'projectId');
export const playSameEpochForeignSource = (test: ReaderPlayContext) => foreignRoute(test, 'sourceId');

/** Actual root/query retries: only the failed panel refetches, with the same source/project. */
export async function playSourceStatusRetry(test: ReaderPlayContext) {
  const environment = environmentFor(test.canvasElement), mode = environment.readFailure;
  assert(mode === 'readiness' || mode === 'revisions', 'Retry story must own one failed panel');
  const select = await test.canvas.findByRole('combobox', { name: 'Project', exact: true });
  await test.userEvent.selectOptions(select, project);
  const sourceButton = await test.canvas.findByRole('button', { name: sourceTitle, exact: true });
  await test.userEvent.click(sourceButton);
  const panel = test.canvasElement.querySelectorAll<HTMLElement>('.er-projects-library__panel')[mode === 'readiness' ? 0 : 1];
  assert(panel, 'Owning source panel missing');
  await until(() => environment.metrics().readinessCalls === 1 && environment.metrics().revisionsCalls === 1 && !!panel.querySelector('button.er-button--text'), 'owning panel error');
  const region = paneAnnouncement(test.canvasElement);
  const failure = mode === 'readiness' ? 'Search readiness could not be read.' : 'Saved versions could not be read.';
  await announcementUntil(() => region.textContent?.includes(failure) === true);
  const retry = panel.querySelector<HTMLButtonElement>('button.er-button--text'); assert(retry, 'Targeted retry missing');
  await test.userEvent.click(retry);
  const loading = mode === 'readiness' ? 'Reading search readiness.' : 'Reading saved versions.';
  await announcementUntil(() => region.textContent?.includes(loading) === true);
  assert(paneAnnouncement(test.canvasElement) === region, 'Retry replaced the operation region');
  const pending = environment.metrics();
  assert(pending.readinessCalls === (mode === 'readiness' ? 2 : 1) && pending.revisionsCalls === (mode === 'revisions' ? 2 : 1), 'Retry refreshed the unrelated panel');
  if (mode === 'readiness') environment.readinessGate.release(); else environment.revisionsGate.release();
  await announcementUntil(() => unchangedChannel(test.canvasElement, region, 'Search readiness loaded. Saved versions loaded.'));
  const currentSelect = await test.canvas.findByRole('combobox', { name: 'Project', exact: true });
  const currentSource = await test.canvas.findByRole('button', { name: sourceTitle, exact: true });
  assert(currentSelect instanceof HTMLSelectElement && currentSelect.value === project && currentSource.getAttribute('aria-pressed') === 'true', 'Retry changed project/source identity');
  assert(environment.metrics().contentCalls === 0, 'Status retry opened a document');
}

/** Two failed panels still produce one channel; a late retry cannot restore protected messages. */
export async function playSourceStatusPrivacy(test: ReaderPlayContext) {
  const environment = environmentFor(test.canvasElement);
  await test.userEvent.selectOptions(await test.canvas.findByRole('combobox', { name: 'Project', exact: true }), project);
  await test.userEvent.click(await test.canvas.findByRole('button', { name: sourceTitle, exact: true }));
  const region = paneAnnouncement(test.canvasElement);
  await announcementUntil(() => unchangedChannel(test.canvasElement, region, 'Search readiness could not be read. Saved versions could not be read.'));
  const retry = test.canvasElement.querySelector<HTMLButtonElement>('.er-projects-library__panel button.er-button--text'); assert(retry, 'Readiness retry absent');
  await test.userEvent.click(retry);
  await announcementUntil(() => region.textContent?.includes('Reading search readiness.') === true);
  environment.privacy.close(); environment.readinessGate.release(); environment.revisionsGate.release();
  await until(() => !region.isConnected && environment.client.getQueryCache().getAll().length === 0, 'privacy removes status and protected cache');
  await frame(); await frame();
  assert(test.canvasElement.querySelectorAll('[role="status"], [aria-live], [role="alert"]').length === 0, 'Late read recreated an announcement');
  assert(environment.metrics().readinessCalls === 2 && environment.metrics().revisionsCalls === 1 && environment.metrics().contentCalls === 0, 'Privacy retry duplicated or widened reads');
}
