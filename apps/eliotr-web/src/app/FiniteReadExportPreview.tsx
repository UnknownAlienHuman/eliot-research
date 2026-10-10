// PRIVATE, NOT EXECUTED. Relative imports target apps/eliotr-web/src/app after authorized relocation.
import { useEffect, useState } from 'react';
import { QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type {
  ArtifactRevision, ArtifactSectionResponse, OwnerSession, ResearchConfigurationView,
  ResearchRunHistoryView, ResearchRunLaunchView, ResearchRunStatusView,
  SectionCitationsView, SystemHealth, TimerPort, VersionedRef,
} from '@eliotr/owner-api-client';
import { assembleResearchDraftMarkdown } from '@eliotr/owner-api-client';
import { Shell } from './Shell';
import { createWorkspaceRuntime, WorkspaceRequestError, type WorkspaceRuntime } from './runtime';
import { createPrivacyController, type PrivacyController } from './privacy';
import { clearWorkspaceQueries, createWorkspaceQueryClient } from '../query/client';
import { researchQueryOptions } from '../query/research';
import { reportQueryOptions } from '../query/reports';

type Scenario = 'reads-no-effects' | 'failed-required-section-no-export';
const stamp = '2026-10-10T12:00:00.000Z', generation = 'finite-u4-fixture';
const artifactRef: VersionedRef = { id: 'finite-report', revision: 1 };
const scopeRef: VersionedRef = { id: 'finite-saved-scope', revision: 1 };
const launch: ResearchRunLaunchView = {
  investigation_ref: { id: 'finite-investigation', revision: 1 },
  workflow_instance_id: 'finite-workflow', deployment_generation: generation,
};
const bodyTexts = [
  '## Required alpha\n\nAlpha verified bytes remain bound to the saved report.\n',
  '## Required beta\n\nБета: точные байты второго обязательного раздела.\n',
];
const encode = (text: string) => new TextEncoder().encode(text);
const refKey = (ref: VersionedRef) => `${ref.id}:${ref.revision}`;
const digest = async (bytes: Uint8Array) => Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)),
  byte => byte.toString(16).padStart(2, '0'),
).join('');
const json = (data: unknown) => new Response(JSON.stringify({
  data, trace_id: 'finite-u4-trace', deployment_generation: generation,
}), { headers: { 'content-type': 'application/json' } });
const wireStatus = (status: ResearchRunStatusView) => ({
  protocol: 'eliotr.research-run-status.v2', workflow_instance_id: status.workflow_instance_id,
  investigation_ref: status.investigation_ref, execution_state: status.execution_state,
  engine_status: status.engine_status, next_stage_index: status.next_stage_index, answer: status.answer,
});
interface Trace {
  requests: { method: string; path: string; at: number }[];
  intentMints: number; statusReads: number; historyReads: number;
  sectionReads: string[]; failedSectionReads: number; citationReads: number;
  focusCallbacks: number; reconnectCallbacks: number; urlsCreated: number; urlsRevoked: number;
  downloads: { filename: string; href: string }[]; blobs: Blob[];
  unexpected: string[]; controlFailure: unknown;
}

function createEnvironment(scenario: Scenario) {
  const client = createWorkspaceQueryClient();
  const trace: Trace = {
    requests: [], intentMints: 0, statusReads: 0, historyReads: 0, sectionReads: [],
    failedSectionReads: 0, citationReads: 0, focusCallbacks: 0, reconnectCallbacks: 0,
    urlsCreated: 0, urlsRevoked: 0, downloads: [], blobs: [], unexpected: [], controlFailure: undefined,
  };
  let failNextAlpha = false;
  const timers: TimerPort = {
    setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
    clearTimeout(handle) { if (typeof handle === 'number') window.clearTimeout(handle); },
  };
  const manifest: Promise<ArtifactRevision> = Promise.all(bodyTexts.map(text => digest(encode(text)))).then(hashes => ({
    artifact_ref: artifactRef, spec_ref: { id: 'finite-spec', revision: 1 }, spec_digest: 'a'.repeat(64),
    evidence_freeze_ref: { id: 'finite-freeze', revision: 1 },
    sections: hashes.map((hash, index) => ({
      section_ref: { id: index === 0 ? 'required-alpha' : 'required-beta', revision: 1 },
      contract_id: `finite-contract-${index + 1}`, body_object_ref: `finite-body-${index + 1}`,
      body_sha256: hash, statement_labels: {}, evidence_ledger_ref: 'finite-ledger',
      verification_receipt_ref: `finite-verification-${index + 1}`,
    })),
    dependency_manifest_ref: 'finite-dependencies', deterministic_export_refs: {}, status: 'DRAFT', created_at: stamp,
  }));
  function statusView(): ResearchRunStatusView {
    const complete = scenario === 'failed-required-section-no-export' || trace.statusReads >= 2;
    return { ...launch, execution_state: complete ? 'ENGINE_COMPLETED' : 'ACTIVE',
      engine_status: complete ? 'complete' : 'running', next_stage_index: complete ? 18 : 3,
      answer: complete ? { availability: 'draft', artifact_ref: artifactRef } : { availability: 'unavailable' } };
  }
  const fetchFixture: typeof fetch = async (input, init) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    trace.requests.push({ method: request.method, path, at: performance.now() });
    if (request.method !== 'GET') {
      trace.unexpected.push(`${request.method} ${path}`);
      throw new Error('Read-only fixture observed an HTTP effect');
    }
    if (path === '/api/v1/system/health') {
      const health: SystemHealth = { ready: true, deployment_generation: generation,
        core_schema_generation: 'schema-1', search_schema_generation: 'schema-1', blocking_reason_codes: [], checked_at: stamp };
      return json(health);
    }
    if (path === '/api/v1/system/session') {
      const session: OwnerSession = { principal_ref: 'finite-owner', credential_generation: 'finite-credential',
        client_class: 'owner_pwa', expires_at: '2027-01-01T00:00:00.000Z' };
      return json({ protocol: 'eliotr.owner-session.v1', ...session });
    }
    if (path === '/api/v1/research/projects') return json({ protocol: 'eliotr.project-owner-list.v1', projects: [] });
    if (path === '/api/v1/system/research-configuration') {
      const configuration: Omit<ResearchConfigurationView, 'trace_id' | 'deployment_generation'> = {
        protocol: 'eliotr.research-configuration-readiness.v1', configuration: 'present',
        model_transport: 'available', qualification_state: 'current', run_readiness: 'ready',
        readiness_reason: 'QUALIFICATION_PROOFS_CURRENT', model_route: 'finite-model-route',
        qualification_expires_at: '2027-01-01T00:00:00.000Z', missing_fields: [], invalid_fields: [], checked_at: stamp,
      };
      return json(configuration);
    }
    if (path === '/api/v1/research/runs') {
      trace.historyReads++;
      const history: ResearchRunHistoryView = {
        protocol: 'eliotr.research-runs.v3', configuration_state: 'INSTALLED', checked_at: stamp,
        deployment_generation: generation,
        runs: scenario === 'reads-no-effects' ? [{ created_at: stamp, status: statusView() }] : [],
        saved_drafts: scenario === 'failed-required-section-no-export'
          ? [{ created_at: stamp, artifact_ref: artifactRef, workflow_instance_id: launch.workflow_instance_id }] : [],
      };
      return json({ protocol: history.protocol, configuration_state: history.configuration_state,
        checked_at: history.checked_at, saved_drafts: history.saved_drafts,
        runs: history.runs.map(entry => ({ created_at: entry.created_at, status: wireStatus(entry.status) })) });
    }
    if (path === '/api/v1/research/run/finite-workflow') { trace.statusReads++; return json(wireStatus(statusView())); }
    const artifactPath = `/api/v1/research/artifact/${encodeURIComponent(refKey(artifactRef))}`;
    if (path === artifactPath) return json(await manifest);
    const artifact = await manifest;
    for (const [index, declared] of artifact.sections.entries()) {
      const sectionPath = `${artifactPath}/sections/${encodeURIComponent(refKey(declared.section_ref))}`;
      if (path === `${sectionPath}/citations`) {
        trace.citationReads++;
        const citations: Omit<Extract<SectionCitationsView, { semantic_verification: 'NOT_EXECUTED' }>, 'deployment_generation'> = {
          protocol: 'eliotr.artifact-section-citations.v1', semantic_verification: 'NOT_EXECUTED',
          artifact_ref: artifactRef, section_ref: declared.section_ref, scope_snapshot_ref: scopeRef,
          verification_receipt_ref: declared.verification_receipt_ref, cited_evidence: [],
        };
        return json(citations);
      }
      if (path !== sectionPath) continue;
      trace.sectionReads.push(refKey(declared.section_ref));
      const bytes = encode(bodyTexts[index] ?? '');
      if (failNextAlpha && index === 0) {
        failNextAlpha = false; trace.failedSectionReads++;
        bytes[0] = 36; // Same length/UTF-8 and all valid headers; exact SHA-256 verification must fail.
      }
      return new Response(new Uint8Array(bytes).buffer, { status: 200, headers: {
        'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength),
        'x-eliotr-artifact-ref': encodeURIComponent(refKey(artifactRef)),
        'x-eliotr-section-ref': encodeURIComponent(refKey(declared.section_ref)),
        'x-eliotr-section-object-ref': encodeURIComponent(declared.body_object_ref),
        'x-eliotr-section-sha256': declared.body_sha256, 'x-eliotr-deployment-generation': generation,
      } });
    }
    trace.unexpected.push(`${request.method} ${path}`);
    throw new Error('Unexpected finite fixture request: ' + path);
  };
  const runtime: WorkspaceRuntime = createWorkspaceRuntime({ fetch: fetchFixture, baseUrl: 'https://fixture.invalid',
    timers, now: () => Date.parse(stamp), sha256: digest,
    mint() { trace.intentMints++; return '11111111-1111-4111-8111-111111111111'; },
    isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); } });
  const privacy: PrivacyController = createPrivacyController({ timers, now: () => Date.parse(stamp),
    mask() { runtime.close(); }, reveal() {},
    cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); },
    clearProtected() { clearWorkspaceQueries(client); }, verify: signal => runtime.verify(signal) });
  function bound() {
    const snapshot = privacy.getSnapshot();
    if (snapshot.phase !== 'available') throw new Error('Actual privacy verification has not completed');
    const apis = runtime.read(snapshot.context);
    if (!apis) throw new Error('Actual runtime is not bound to the verified context');
    return { apis, context: snapshot.context };
  }
  function report() {
    const { apis, context } = bound();
    let manifestKey: readonly (string | number)[] = [];
    const current = () => client.getQueryState(manifestKey)?.status === 'success' &&
      client.getQueryState(manifestKey)?.fetchStatus !== 'fetching'
      ? client.getQueryData<ArtifactRevision>(manifestKey) : undefined;
    const options = reportQueryOptions(apis, privacy, context, current);
    manifestKey = options.manifest(artifactRef).queryKey;
    const artifact = current();
    if (!artifact) throw new Error('The actual report manifest is not current');
    const declared = artifact.sections[0];
    if (!declared) throw new Error('Required alpha is absent from the decoded manifest');
    return { artifact, options, key: options.section(artifact, declared).queryKey };
  }
  function readStatus() {
    const { apis, context } = bound();
    const options = researchQueryOptions({ ...apis.research, configuration: apis.connections.configuration }, privacy, context);
    return client.getQueryData<ResearchRunStatusView>(options.status(launch).queryKey);
  }
  async function failRequiredRead() {
    const { key } = report();
    const query = client.getQueryCache().find({ queryKey: key, exact: true });
    if (!query || !query.isActive() || query.state.status !== 'success' || query.state.fetchStatus !== 'idle') {
      throw new Error('Fresh failure requires the already successful, currently selected section Query');
    }
    failNextAlpha = true;
    await client.refetchQueries({ queryKey: key, exact: true, type: 'active' }, { throwOnError: false });
  }
  function installProbes() {
    const cache = client.getQueryCache(), originalFocus = cache.onFocus, originalOnline = cache.onOnline;
    const onFocus = () => { trace.focusCallbacks++; originalFocus.call(cache); };
    const onOnline = () => { trace.reconnectCallbacks++; originalOnline.call(cache); };
    cache.onFocus = onFocus; cache.onOnline = onOnline;
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL, click = HTMLAnchorElement.prototype.click;
    const createUrl: typeof URL.createObjectURL = object => {
      trace.urlsCreated++; if (object instanceof Blob) trace.blobs.push(object);
      return create.call(URL, object);
    };
    const revokeUrl: typeof URL.revokeObjectURL = url => { trace.urlsRevoked++; revoke.call(URL, url); };
    function clickAnchor(this: HTMLAnchorElement) {
      if (this.download) {
        trace.downloads.push({ filename: this.download, href: this.href });
        return; // Count the real ReportPanel activation; intentionally suppress the OS file save.
      }
      click.call(this);
    }
    URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl; HTMLAnchorElement.prototype.click = clickAnchor;
    return () => {
      if (cache.onFocus === onFocus) cache.onFocus = originalFocus;
      if (cache.onOnline === onOnline) cache.onOnline = originalOnline;
      if (URL.createObjectURL === createUrl) URL.createObjectURL = create;
      if (URL.revokeObjectURL === revokeUrl) URL.revokeObjectURL = revoke;
      if (HTMLAnchorElement.prototype.click === clickAnchor) HTMLAnchorElement.prototype.click = click;
    };
  }
  return { scenario, client, runtime, privacy, trace, report, readStatus, failRequiredRead, installProbes };
}
type Environment = ReturnType<typeof createEnvironment>;
const fixtures = new WeakMap<HTMLElement, Environment>();

export function FiniteReadExportPreview({ scenario = 'reads-no-effects' }: { readonly scenario?: Scenario }) {
  const [environment] = useState(() => createEnvironment(scenario));
  useEffect(() => {
    const restore = environment.installProbes();
    const unsubscribe = environment.privacy.subscribe(() => {
      const snapshot = environment.privacy.getSnapshot();
      if (snapshot.phase === 'available') environment.runtime.bind(snapshot.context);
    });
    void environment.privacy.refresh();
    return () => {
      unsubscribe(); environment.privacy.dispose(); environment.runtime.dispose(); environment.client.clear(); restore();
    };
  }, [environment]);
  return <div data-finite-read-export ref={node => { if (node) fixtures.set(node, environment); }}>
    <QueryClientProvider client={environment.client}><MemoryRouter initialEntries={['/research']}>
      <Shell privacy={environment.privacy} runtime={environment.runtime} fixture={false} />
    </MemoryRouter></QueryClientProvider>
    {scenario === 'failed-required-section-no-export' && <button type="button" onClick={() => {
      void environment.failRequiredRead().catch((error: unknown) => { environment.trace.controlFailure = error; });
    }}>Fixture: fail a fresh required-section read</button>}
  </div>;
}
interface PlayContext {
  readonly canvasElement: HTMLElement;
  readonly canvas: {
    findByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): Promise<HTMLElement>;
    getByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): HTMLElement;
    findByText(text: string): Promise<HTMLElement>; queryByText(text: string): HTMLElement | null;
  };
  readonly userEvent: { click(element: HTMLElement): Promise<void> };
}
function check(condition: boolean, message: string) { if (!condition) throw new Error(message); }
function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message); return value;
}
const delay = (milliseconds: number) => new Promise<void>(resolve => { window.setTimeout(resolve, milliseconds); });
async function until(predicate: () => boolean, message: string, timeout = 2000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) { if (performance.now() >= deadline) throw new Error(message); await delay(20); }
}
function environmentFor(canvasElement: HTMLElement, scenario: Scenario) {
  const root = canvasElement.querySelector<HTMLElement>('[data-finite-read-export]');
  if (!root) throw new Error('Finite read/export fixture was not mounted');
  const environment = required(fixtures.get(root), 'Unmounted finite scenario');
  check(environment.scenario === scenario, 'Wrong finite scenario');
  return { root, environment };
}
function assertNoEffects(environment: Environment) {
  const { trace } = environment;
  check(trace.requests.filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method)).length === 0,
    'HTTP mutation dispatched during read-only interactions');
  check(trace.requests.filter(request => request.path === '/api/v1/research/run' && request.method === 'POST').length === 0,
    'An additional run admission was dispatched');
  check(trace.intentMints === 0 && environment.client.getMutationCache().getAll().length === 0,
    'A read minted intent or entered the mutation cache');
  check(trace.unexpected.length === 0, 'Unexpected HTTP operation: ' + trace.unexpected.join(', '));
}

export async function playReadsNoEffects({ canvasElement, canvas, userEvent }: PlayContext) {
  const { environment } = environmentFor(canvasElement, 'reads-no-effects'), { trace } = environment;
  await userEvent.click(await canvas.findByRole('button', { name: 'Read this run', exact: true }));
  await until(() => environment.readStatus()?.execution_state === 'ACTIVE' && environment.client.isFetching() === 0,
    'Initial canonical status did not settle');
  check(trace.statusReads === 1, 'Initial observed run did not perform exactly one status read');
  // No refetch API, fake clock, focus or gesture here: the actual ResearchPanel 5000ms interval must dispatch.
  await until(() => trace.statusReads === 2 && environment.readStatus()?.execution_state === 'ENGINE_COMPLETED' &&
    environment.client.isFetching() === 0, 'The actual active-status poll did not complete', 8000);
  const polls = trace.requests.filter(request => request.path === '/api/v1/research/run/finite-workflow');
  const first = required(polls[0], 'Initial status GET absent'), second = required(polls[1], 'Owning poll GET absent');
  check(second.at - first.at >= 4500, 'Status was refreshed without the owning poll interval');
  const view = required(environment.readStatus(), 'Canonical status absent after poll');
  check(view.workflow_instance_id === launch.workflow_instance_id && view.investigation_ref.id === launch.investigation_ref.id &&
    view.investigation_ref.revision === launch.investigation_ref.revision && view.deployment_generation === generation,
    'Canonical read lost workflow/investigation/deployment authority');
  assertNoEffects(environment);
  const beforeStatus = trace.statusReads;
  await userEvent.click(await canvas.findByRole('button', { name: 'Read status', exact: true }));
  await until(() => trace.statusReads === beforeStatus + 1 && environment.client.isFetching() === 0, 'Explicit status read did not settle');
  const beforeHistory = trace.historyReads;
  await userEvent.click(canvas.getByRole('button', { name: 'Refresh recent research', exact: true }));
  await until(() => trace.historyReads === beforeHistory + 1 && environment.client.isFetching() === 0, 'Explicit history read did not settle');
  const requests = trace.requests.length, focuses = trace.focusCallbacks, reconnects = trace.reconnectCallbacks;
  const wasOnline = onlineManager.isOnline();
  check(document.visibilityState === 'visible' && wasOnline, 'Lifecycle case requires a visible, online browser document');
  try {
    focusManager.setFocused(false);
    focusManager.setFocused(undefined); // Actual public manager regains the browser's visible state.
    window.dispatchEvent(new Event('visibilitychange')); // Also exercises its installed DOM listener.
    window.dispatchEvent(new Event('offline'));
    check(!onlineManager.isOnline(), 'The actual offline listener was not reached');
    window.dispatchEvent(new Event('online'));
    await until(() => trace.focusCallbacks > focuses && trace.reconnectCallbacks > reconnects,
      'Mounted QueryClient did not deliver focus/reconnect to its actual QueryCache');
    await delay(100);
    check(environment.client.isFetching() === 0 && trace.requests.length === requests,
      'Focus/reconnect bypassed the current no-auto-refetch policy');
    assertNoEffects(environment);
    check(trace.urlsCreated === 0 && trace.urlsRevoked === 0 && trace.downloads.length === 0, 'A canonical read attempted export delivery');
  } finally { focusManager.setFocused(undefined); onlineManager.setOnline(wasOnline); }
}

async function openOutline(root: HTMLElement, userEvent: PlayContext['userEvent']) {
  const outline = required(root.querySelector<HTMLDetailsElement>('.er-live-report-outline'), 'Actual ReportPanel outline is absent');
  if (!outline.open) {
    const summary = required(outline.querySelector('summary'), 'Report outline summary is absent');
    await userEvent.click(summary);
  }
}
function rowButton(root: HTMLElement, section: string) {
  return required(root.querySelector<HTMLButtonElement>(`[data-report-section="${section}"] button`),
    'Actual declared section control is absent: ' + section);
}
function exportButton(canvas: PlayContext['canvas']) {
  const button = canvas.getByRole('button', { name: 'Export report', exact: true });
  if (!(button instanceof HTMLButtonElement)) throw new Error('Export control is not a button'); return button;
}
export async function playFailedRequiredSectionNoExport({ canvasElement, canvas, userEvent }: PlayContext) {
  const { root, environment } = environmentFor(canvasElement, 'failed-required-section-no-export'), { trace, client } = environment;
  await userEvent.click(await canvas.findByRole('button', { name: 'Open saved report', exact: true }));
  await canvas.findByText('2 declared');
  check(trace.sectionReads.length === 0 && exportButton(canvas).disabled, 'Manifest read eagerly completed required sections');
  for (const section of ['required-beta:1', 'required-alpha:1']) {
    await openOutline(root, userEvent); await userEvent.click(rowButton(root, section));
    await until(() => trace.sectionReads.includes(section) && client.isFetching() === 0, 'Required read did not settle: ' + section);
  }
  await openOutline(root, userEvent);
  const held = environment.report(), reads = held.artifact.sections.map(declared =>
    client.getQueryData<ArtifactSectionResponse>(held.options.section(held.artifact, declared).queryKey));
  check(reads.every(read => read !== undefined) && !exportButton(canvas).disabled && trace.sectionReads.length === 2,
    'Complete verified required set never became export eligible');
  const sections = reads.filter((read): read is ArtifactSectionResponse => read !== undefined);
  const expected = assembleResearchDraftMarkdown({ artifact: held.artifact, artifactRef: refKey(artifactRef), sections });
  await userEvent.click(exportButton(canvas)); // Positive instrumentation control before the new failure.
  check(trace.urlsCreated === 1 && trace.urlsRevoked === 1 && trace.downloads.length === 1 && trace.blobs.length === 1,
    'Successful calibration export did not reach the genuine object-URL/download boundary');
  const blob = required(trace.blobs[0], 'Calibration Blob absent'), download = required(trace.downloads[0], 'Calibration download absent');
  check(download.filename === 'eliot-report.md' && download.href.startsWith('blob:'), 'Unexpected export delivery metadata');
  const delivered = new Uint8Array(await blob.arrayBuffer());
  check(delivered.byteLength === expected.bytes.byteLength && delivered.every((byte, index) => byte === expected.bytes[index]),
    'Actual ReportPanel delivery changed canonical assembled Markdown bytes');
  await canvas.findByText('Alpha verified bytes remain bound to the saved report.');
  const previous = required(client.getQueryData<ArtifactSectionResponse>(held.key), 'Previously successful section absent');
  check(trace.sectionReads.length === 2, 'Selecting the cached section replaced the positive readback');
  await userEvent.click(canvas.getByRole('button', { name: 'Fixture: fail a fresh required-section read', exact: true }));
  await until(() => trace.failedSectionReads === 1 && client.getQueryState(held.key)?.status === 'error' && client.isFetching() === 0,
    'A fresh required-section verification failure was not observed');
  check(trace.controlFailure === undefined, 'Fixture could not refetch the actual selected Query');
  const error = client.getQueryState(held.key)?.error;
  check(error instanceof WorkspaceRequestError && error.status === 502 && error.code === 'RESEARCH_ARTIFACT_SECTION_INVALID',
    'The failure did not come from the actual typed section decoder');
  check(client.getQueryData(held.key) === previous, 'The negative did not retain formerly successful cached bytes');
  check(trace.sectionReads.length === 3 && trace.sectionReads[2] === 'required-alpha:1', 'Failure was not a fresh exact required-section GET');
  await canvas.findByText('This section could not be read or verified.');
  check(canvas.queryByText('Alpha verified bytes remain bound to the saved report.') === null, 'Rejected old body remained visible');
  await openOutline(root, userEvent);
  const blocked = exportButton(canvas); check(blocked.disabled, 'Failed required read left export enabled');
  await userEvent.click(blocked); blocked.click();
  await delay(100);
  check(trace.urlsCreated === 1 && trace.urlsRevoked === 1 && trace.downloads.length === 1 && trace.blobs.length === 1,
    'Failure delivered another export from stale successful bytes');
  assertNoEffects(environment);
}

// Register these objects in the current Workspace/Shell CSF only after root authorizes relocation.
export const ReadsNoEffects = { render: () => <FiniteReadExportPreview />, play: playReadsNoEffects };
export const FailedRequiredSectionNoExport = {
  render: () => <FiniteReadExportPreview scenario="failed-required-section-no-export" />,
  play: playFailedRequiredSectionNoExport,
};
