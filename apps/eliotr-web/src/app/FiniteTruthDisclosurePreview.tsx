import { useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ArtifactRevision } from '@eliotr/owner-api-client';
import { Shell } from './Shell';
import { createWorkspaceRuntime } from './runtime';
import { createPrivacyController } from './privacy';
import { clearWorkspaceQueries, createWorkspaceQueryClient } from '../query/client';

type Scenario = 'capability' | 'disclosure';
const origin = 'https://fixture.invalid';
const stamp = '2026-10-10T12:00:00.000Z';
const generation = 'finite-truth-fixture';
const projectId = 'project-finite-truth';
const projectTitle = 'Finite public facts';
const principal = 'finite-truth-owner';
const artifactRef = { id: 'report-safe', revision: 1 } as const;
const publicationRef = 'publication-safe';
const rawMarkers = Object.freeze({
  secret: 'U5_SYNTHETIC_REJECTED_SECRET_20261010',
  provider: 'U5_SYNTHETIC_REJECTED_PROVIDER_PAYLOAD_20261010',
  prompt: 'U5_SYNTHETIC_REJECTED_HIDDEN_PROMPT_20261010',
  transcript: 'U5_SYNTHETIC_REJECTED_TRANSCRIPT_20261010',
});
const rawMaterial = {
  secret: rawMarkers.secret, provider_payload: rawMarkers.provider,
  hidden_prompt: rawMarkers.prompt, transcript: rawMarkers.transcript,
};
const digest = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
    .map(value => value.toString(16).padStart(2, '0')).join('');

interface FixtureAudit {
  readonly scenario: Scenario;
  readonly calls: { readonly method: string; readonly path: string }[];
  readonly unexpected: string[];
  mutations: number;
  mints: number;
  providers: number;
  grants: number;
  models: number;
  readiness: number;
  diagnostics: number;
  proposals: number;
  history: number;
  manifests: number;
  publications: number;
}
// Test observations stay out of the product DOM and do not replace any client or query result.
const fixtureAudits = new WeakMap<HTMLElement, FixtureAudit>();

function createEnvironment(scenario: Scenario) {
  const client = createWorkspaceQueryClient();
  const timers = { setTimeout: () => 0, clearTimeout() {} };
  const audit: FixtureAudit = {
    scenario, calls: [], unexpected: [], mutations: 0, mints: 0,
    providers: 0, grants: 0, models: 0, readiness: 0, diagnostics: 0,
    proposals: 0, history: 0, manifests: 0, publications: 0,
  };
  const draft: ArtifactRevision = {
    artifact_ref: artifactRef, spec_ref: { id: 'spec-safe', revision: 1 },
    spec_digest: 'a'.repeat(64), evidence_freeze_ref: { id: 'freeze-safe', revision: 1 },
    sections: [{
      section_ref: { id: 'section-safe', revision: 1 }, contract_id: 'analysis/summary',
      body_object_ref: 'body-safe', body_sha256: 'a'.repeat(64), statement_labels: {},
      evidence_ledger_ref: 'ledger-safe', verification_receipt_ref: 'verification-safe',
    }],
    dependency_manifest_ref: 'dependencies-safe', deterministic_export_refs: {},
    status: 'DRAFT', created_at: stamp,
  };
  const publication = {
    protocol: 'eliotr.artifact-publication.v1',
    revision: { ...draft, status: 'ACCEPTED' },
    receipt: {
      publication_ref: publicationRef, artifact_ref: artifactRef, publication_revision: 1,
      manifest_sha256: 'a'.repeat(64), verification_set_sha256: 'b'.repeat(64),
      evidence_currentness_sha256: 'c'.repeat(64), acceptance_decision_ref: 'decision-safe',
      acceptance_provenance_ref: 'provenance-safe', acceptance_decision_sha256: 'd'.repeat(64),
      principal_ref: principal, authorization_receipt_ref: 'authorization-safe', created_at: stamp,
    },
  };
  const json = (data: unknown) => new Response(JSON.stringify({
    data, trace_id: 'finite-truth-trace', deployment_generation: generation,
  }), { headers: { 'content-type': 'application/json' } });
  const diagnosticError = (malformed: boolean) => new Response(JSON.stringify({
    type: 'urn:eliotr:problem:fixture-unavailable',
    title: Object.values(rawMarkers).join(' '), status: 503,
    code: 'FIXTURE_UNAVAILABLE', trace_id: 'finite-truth-trace', retryable: false,
    ...(malformed ? { provider_payload: rawMaterial } : {}),
  }), { status: 503, headers: { 'content-type': 'application/problem+json' } });
  const unexpected = (message: string): never => {
    audit.unexpected.push(message);
    throw new Error('Unexpected finite truth fixture request: ' + message);
  };
  const fetchFixture: typeof fetch = async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(requestUrl, origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    audit.calls.push({ method, path: url.pathname + url.search });
    if (method !== 'GET') {
      audit.mutations += 1;
      return unexpected(method + ' ' + url.pathname);
    }
    if (url.origin !== origin) return unexpected('foreign origin');
    if (init?.signal?.aborted) throw new DOMException('Fixture read aborted', 'AbortError');
    if (init?.credentials !== 'same-origin' || init.redirect !== 'manual' || init.cache !== 'no-store') {
      return unexpected('owner transport policy changed');
    }
    if (url.pathname === '/api/v1/system/health') return json({
      ready: true, deployment_generation: generation,
      core_schema_generation: 'schema-1', search_schema_generation: 'schema-1',
      google_external_transport: 'drive-exchange', blocking_reason_codes: [], checked_at: stamp,
    });
    if (url.pathname === '/api/v1/system/session') return json({
      protocol: 'eliotr.owner-session.v1', principal_ref: principal,
      credential_generation: 'finite-truth-credential', client_class: 'owner_pwa',
      expires_at: '2027-01-01T00:00:00.000Z',
    });
    if (url.pathname === '/api/v1/research/projects') return json({
      protocol: 'eliotr.project-owner-list.v1', projects: [{
        protocol: 'eliotr.project-owner.v1', project_ref: { id: projectId, revision: 1 },
        title: projectTitle, revision: 1, owner_principal_ref: principal,
        deployment_generation: generation, source_ids: [], created_at: stamp,
      }],
    });
    if (url.pathname === '/api/v1/research/catalog' && url.searchParams.get('project_id') === projectId) {
      return json({ projects: [{ id: projectId, title: projectTitle, generation }], sources: [] });
    }
    if (url.pathname === '/api/v1/system/mcp-diagnostics') {
      audit.diagnostics += 1;
      if (scenario === 'disclosure') return diagnosticError(audit.diagnostics === 1);
      return json({
        protocol: 'eliotr.mcp.client-diagnostic.v1', status: 'ISSUED',
        challenge_id: 'challenge-safe', issued_at: stamp,
        expires_at: '2026-10-10T12:05:00.000Z', deployment_generation: generation,
        auth_profile: 'managed-oauth',
      });
    }
    if (url.pathname === '/api/v1/research/projects/' + projectId + '/client-grants' && !url.search) {
      audit.grants += 1;
      return json({ protocol: 'eliotr.project-client-grants.v1', grants: [] });
    }
    if (url.pathname === '/api/v1/projects/' + projectId + '/model-provider-key' && !url.search) {
      audit.providers += 1;
      const page = {
        protocol: 'eliotr.research-provider-key-configuration.v1', project_id: projectId,
        provider_id: 'openrouter', configurations: [], truncated: false,
      };
      // Deliberately invalid: these fields do NOT belong to the accepted public contract.
      return json(scenario === 'disclosure' ? { ...page, ...rawMaterial } : page);
    }
    if (url.pathname === '/api/v1/research/projects/' + projectId + '/model-configuration' &&
      url.searchParams.get('limit') === '50' && [...url.searchParams.keys()].length === 1) {
      audit.models += 1;
      return json({
        protocol: 'eliotr.research-project-model-configuration.v1', project_id: projectId,
        selection_revision: null, selected: null, revisions: [], next_cursor: null,
      });
    }
    if (url.pathname === '/api/v1/system/research-configuration' &&
      url.searchParams.get('project_id') === projectId && [...url.searchParams.keys()].length === 1) {
      audit.readiness += 1;
      return json({
        protocol: 'eliotr.research-configuration-readiness.v1',
        configuration: 'present', model_transport: 'available', qualification_state: 'current',
        run_readiness: 'ready', readiness_reason: 'QUALIFICATION_PROOFS_CURRENT',
        model_route: 'research-route', qualification_expires_at: '2027-01-01T00:00:00.000Z',
        missing_fields: [], invalid_fields: [], checked_at: stamp,
      });
    }
    if (url.pathname === '/api/v1/research/wiki/proposals' && !url.search) {
      audit.proposals += 1;
      const page = { protocol: 'eliotr.wiki-proposals.v1', items: [], has_more: false };
      return json(scenario === 'disclosure' ? { ...page, ...rawMaterial } : page);
    }
    if (url.pathname === '/api/v1/research/runs' && !url.search) {
      audit.history += 1;
      return json({
        protocol: 'eliotr.research-runs.v3', runs: [], configuration_state: 'INSTALLED', checked_at: stamp,
        saved_drafts: scenario === 'disclosure' ? [{ created_at: stamp, artifact_ref: artifactRef }] : [],
      });
    }
    const reportPath = '/api/v1/research/artifact/' + encodeURIComponent(artifactRef.id + ':' + artifactRef.revision);
    if (scenario === 'disclosure' && url.pathname === reportPath && !url.search) {
      audit.manifests += 1;
      return json(draft);
    }
    if (scenario === 'disclosure' && url.pathname === reportPath + '/publication' && !url.search) {
      audit.publications += 1;
      // First read exposes bounded public receipt facts; second read exercises strict rejection.
      if (audit.publications === 1) return json(publication);
      if (audit.publications === 2) return json({ ...publication, ...rawMaterial });
    }
    return unexpected(method + ' ' + url.pathname + url.search);
  };
  const runtime = createWorkspaceRuntime({
    fetch: fetchFixture, baseUrl: origin, timers, now: () => Date.parse(stamp), sha256: digest,
    mint() { audit.mints += 1; throw new Error('This read-only composition must not mint an intent'); },
    isCurrent: context => privacy.isCurrent(context),
    onAuthorizationLoss() { privacy.close(); },
  });
  const privacy = createPrivacyController({
    timers, now: () => Date.parse(stamp), mask() { runtime.close(); }, reveal() {},
    cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); },
    clearProtected() { clearWorkspaceQueries(client); },
    verify: signal => runtime.verify(signal),
  });
  return { client, runtime, privacy, audit };
}

/**
 * PRIVATE, UNEXECUTED proposal. Relative imports target eventual app-directory relocation.
 * Actual Shell -> LiveWorkspace -> Connections/Studio -> ReportPanel -> ArtifactActions.
 */
export function FiniteTruthDisclosurePreview({ scenario = 'capability' }: { readonly scenario?: Scenario }) {
  const [environment] = useState(() => createEnvironment(scenario));
  useEffect(() => {
    const unsubscribe = environment.privacy.subscribe(() => {
      const snapshot = environment.privacy.getSnapshot();
      if (snapshot.phase === 'available') environment.runtime.bind(snapshot.context);
    });
    void environment.privacy.refresh();
    return () => {
      unsubscribe(); environment.privacy.dispose(); environment.runtime.dispose(); environment.client.clear();
    };
  }, [environment]);
  return <div data-finite-truth-preview={environment.audit.scenario} ref={node => {
    if (node) fixtureAudits.set(node, environment.audit);
  }}>
    <QueryClientProvider client={environment.client}><MemoryRouter initialEntries={['/connections']}>
      <Shell privacy={environment.privacy} runtime={environment.runtime} fixture={false} />
    </MemoryRouter></QueryClientProvider>
  </div>;
}

interface PlayContext {
  readonly canvas: {
    findByRole(role: string, options: { readonly name: string | RegExp; readonly exact?: boolean; readonly level?: number }): Promise<HTMLElement>;
    getByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): HTMLElement;
  };
  readonly userEvent: {
    click(element: HTMLElement): Promise<void>;
    selectOptions(element: HTMLElement, value: string): Promise<void>;
  };
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function fixtureRoot(heading: HTMLElement, scenario: Scenario) {
  const root = heading.closest<HTMLElement>('[data-finite-truth-preview]');
  assert(root && root.dataset.finiteTruthPreview === scenario, 'Wrong finite truth preview scenario');
  assert(fixtureAudits.has(root), 'Fixture request observation is unavailable');
  return root;
}
async function waitForState(root: HTMLElement, check: () => void) {
  const view = root.ownerDocument.defaultView;
  assert(view, 'Fixture rendering window is unavailable');
  let lastFailure: unknown;
  for (let frame = 0; frame < 120; frame += 1) {
    try { check(); return; } catch (error) { lastFailure = error; }
    await new Promise<void>(resolve => view.requestAnimationFrame(() => resolve()));
  }
  if (lastFailure instanceof Error) throw lastFailure;
  throw new Error('Expected finite truth state did not commit');
}
function row(root: HTMLElement, label: string) {
  const entry = [...root.querySelectorAll('.connections-feature__row')]
    .find(item => item.querySelector('.connections-feature__label')?.textContent === label);
  assert(entry, 'Missing Connections fact: ' + label);
  return entry.querySelector('.connections-feature__detail')?.textContent ?? '';
}
function noRawMaterial(root: HTMLElement) {
  const controlValues = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')]
    .map(control => control.value).join('\n');
  const rendered = (root.textContent ?? '') + root.innerHTML + controlValues;
  for (const marker of Object.values(rawMarkers)) {
    assert(!rendered.includes(marker), 'A synthetic raw marker appeared in ordinary, hidden or disclosed DOM');
  }
}
function onlyButtons(root: HTMLElement, allowed: readonly string[]) {
  const main = root.querySelector('.er-shell-reading');
  assert(main, 'Actual Shell reading surface is missing');
  for (const button of main.querySelectorAll('button')) {
    const label = button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '';
    assert(allowed.includes(label), 'An unsupported composition control was rendered: ' + label);
  }
}
function readOnlyAudit(root: HTMLElement) {
  const audit = fixtureAudits.get(root);
  assert(audit, 'Fixture request observation is unavailable');
  assert(audit.mutations === 0 && audit.mints === 0, 'Composition started an automatic operation or minted an intent');
  assert(audit.unexpected.length === 0, 'Composition called an unlisted endpoint or changed owner transport policy');
  assert(audit.calls.every(call => call.method === 'GET'), 'A non-read transport call was attempted');
  return audit;
}
async function chooseProject(root: HTMLElement, userEvent: PlayContext['userEvent']) {
  const select = root.querySelector<HTMLSelectElement>('.er-shell-reading select');
  assert(select && select.value === '', 'Connections must begin with no automatically chosen project');
  await waitForState(root, () => {
    assert([...select.options].some(option => option.value === projectId), 'Decoded owner project is not available');
  });
  await userEvent.selectOptions(select, projectId);
}
function commonFacts(root: HTMLElement) {
  assert(row(root, 'Server and API') === 'Server answered', 'Health did not remain an independent positive fact');
  assert(row(root, 'Owner session') === 'Signed in as owner', 'The exact owner session was not verified');
  assert(row(root, 'Selected model') === 'No model selected', 'Empty model selection was inferred');
  assert(row(root, 'Research configuration readiness') === 'Ready to run', 'Readiness was replaced by another row');
  assert(row(root, 'Google transport routing') === 'Routing: drive-exchange', 'Routing was promoted into a connection');
  assert(row(root, 'Project access grant') === 'Active grants: 0', 'Empty grants were inferred as access');
  assert(!/\bConnected\b/iu.test(root.querySelector('.connections-feature')?.textContent ?? ''), 'Unobserved connectivity was inferred');
}

/** Missing U5 case #4 only: empty configuration and independent capability facts through Shell. */
export async function playCapabilityConnectionTruth({ canvas, userEvent }: PlayContext) {
  const root = fixtureRoot(await canvas.findByRole('heading', { name: 'Connections', exact: true, level: 1 }), 'capability');
  await chooseProject(root, userEvent);
  await waitForState(root, () => {
    commonFacts(root);
    assert(row(root, 'Model provider configuration') === 'Not configured', 'Valid empty provider configuration became a failed read');
    assert(row(root, 'Observed client call') === 'Challenge issued, awaiting callback', 'Issued diagnostic became an observed connection');
    assert(row(root, 'Saved model operation') === 'Not checked yet', 'An unrequested saved operation was read');
  });
  onlyButtons(root, ['Refresh', 'Check again', 'Show diagnostics', 'Details', 'Read saved status']);
  noRawMaterial(root);
  await userEvent.click(canvas.getByRole('link', { name: 'Studio', exact: true }));
  await canvas.findByRole('heading', { name: 'Studio', exact: true });
  await waitForState(root, () => {
    const audit = readOnlyAudit(root);
    assert(audit.proposals > 0 && audit.history > 0, 'Studio did not read its actual public lists');
    assert(root.querySelector('.er-studio-live__list')?.textContent?.includes('No saved drafts or proposals are available yet.'), 'Valid empty Studio list was not retained');
    onlyButtons(root, ['Refresh saved work']);
  });
  const audit = readOnlyAudit(root);
  assert(audit.providers > 0 && audit.grants > 0 && audit.models > 0 && audit.readiness > 0, 'Connections truth checks were vacuous');
  assert(audit.publications === 0 && audit.manifests === 0, 'Empty Studio automatically opened or operated on a report');
  noRawMaterial(root);
}

/** Missing U5 case #5 only: strict rejection and bounded disclosure; no publication/revision effect. */
export async function playBoundedRootDisclosure({ canvas, userEvent }: PlayContext) {
  const root = fixtureRoot(await canvas.findByRole('heading', { name: 'Connections', exact: true, level: 1 }), 'disclosure');
  await chooseProject(root, userEvent);
  await waitForState(root, () => {
    commonFacts(root);
    assert(row(root, 'Model provider configuration') === 'Check could not complete', 'Unknown provider fields were accepted as public configuration');
    assert(row(root, 'Observed client call') === 'Check could not complete', 'Malformed diagnostic problem did not stay unavailable');
  });
  noRawMaterial(root);
  await userEvent.click(await canvas.findByRole('button', { name: 'Details', exact: true }));
  await waitForState(root, () => {
    assert(root.querySelector('.connections-feature__diagnostic-value')?.textContent === 'Unknown', 'Details fabricated a diagnostic observation');
    noRawMaterial(root);
  });
  const savedOperation = root.querySelector<HTMLElement>('.er-live-connection-operation > summary');
  assert(savedOperation, 'Actual saved-operation disclosure is missing');
  await userEvent.click(savedOperation);
  assert(savedOperation.parentElement?.hasAttribute('open'), 'Saved-operation details did not open');
  noRawMaterial(root);
  // First response was malformed; the explicit refetch returns an exact typed problem whose title
  // contains synthetic markers. The panel must still render its local safe copy, not error.message.
  const diagnostics = root.querySelectorAll<HTMLButtonElement>('.connections-feature button');
  const diagnosticButton = [...diagnostics].find(button => button.textContent?.trim() === 'Show diagnostics');
  assert(diagnosticButton, 'Actual diagnostic read callback is missing');
  await userEvent.click(diagnosticButton);
  await waitForState(root, () => {
    assert(readOnlyAudit(root).diagnostics === 2, 'Explicit diagnostic read was duplicated or did not occur');
    assert(row(root, 'Observed client call') === 'Check could not complete', 'Remote problem title replaced safe local copy');
    noRawMaterial(root);
  });
  onlyButtons(root, ['Refresh', 'Check again', 'Show diagnostics', 'Details', 'Read saved status']);
  await userEvent.click(canvas.getByRole('link', { name: 'Studio', exact: true }));
  await canvas.findByRole('heading', { name: 'Studio', exact: true });
  await waitForState(root, () => {
    assert(root.querySelector('.er-studio-live__list')?.textContent?.includes('Saved proposals could not be read. Nothing was shown.'), 'Rejected Wiki list did not render the bounded public error');
    assert(readOnlyAudit(root).proposals > 0 && readOnlyAudit(root).history > 0, 'Studio rejection checks were vacuous');
    onlyButtons(root, ['Refresh saved work', 'Open saved report']);
    noRawMaterial(root);
  });
  await userEvent.click(await canvas.findByRole('button', { name: 'Open saved report', exact: true }));
  const review = await canvas.findByRole('button', { name: 'Read acceptance status', exact: true });
  assert(readOnlyAudit(root).publications === 0, 'Entering a report automatically read or changed acceptance');
  noRawMaterial(root);
  await userEvent.click(review);
  await waitForState(root, () => {
    assert(root.textContent?.includes('Owner acceptance is confirmed for this revision.'), 'Bounded publication read did not reach actual ArtifactActions');
    assert(readOnlyAudit(root).publications === 1, 'Explicit publication status read was duplicated');
  });
  const receipt = [...root.querySelectorAll<HTMLDetailsElement>('.er-live-report details')]
    .find(details => details.querySelector('summary')?.textContent === 'Acceptance receipt');
  const receiptSummary = receipt?.querySelector<HTMLElement>('summary');
  assert(receipt && receiptSummary, 'Actual receipt disclosure is missing');
  await userEvent.click(receiptSummary);
  assert(receipt.open, 'Receipt disclosure did not open');
  const permitted = [...receipt.querySelectorAll('p')].map(paragraph => paragraph.textContent);
  assert(permitted.length === 2 && permitted[0] === publicationRef && permitted[1] === 'report-safe:1', 'Receipt serialized more than its permitted public identity facts');
  noRawMaterial(root);
  await userEvent.click(review);
  await waitForState(root, () => {
    assert(readOnlyAudit(root).publications === 2, 'Rejected publication read did not occur exactly once');
    assert(root.textContent?.includes('The action could not be confirmed. Read its status before continuing.'), 'Rejected publication did not render the bounded action error');
    noRawMaterial(root);
  });
  const audit = readOnlyAudit(root);
  assert(audit.providers > 0 && audit.manifests > 0, 'Provider/report disclosure checks were vacuous');
  // Status reads must not infer a section action or expose a second publication from raw material.
  const reportButtons = [...root.querySelectorAll('.er-live-report button')].map(button => button.textContent?.trim());
  assert(!reportButtons.includes('Revise this section') && !reportButtons.includes('Confirm owner acceptance'), 'Unrequested section or acceptance controls appeared');
  noRawMaterial(root);
}
