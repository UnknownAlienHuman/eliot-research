/** Publish this journey's declared terminal readiness on the Shell that renders the observed presentation. */
function markVisualReady(shell: HTMLElement | null | undefined): void {
  if (!shell) throw new Error('Terminal visual readiness requires the rendered workspace Shell');
  shell.setAttribute('data-play-ready', 'ready');
}
import { useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ArtifactRevisionRead, ResearchRunStatusView } from '@eliotr/owner-api-client';
import { Shell } from './Shell';
import { paneAnnouncement, announcementUntil, unchangedChannel } from './announcementAssertions';
import { createWorkspaceRuntime } from './runtime';
import { createPrivacyController } from './privacy';
import { clearWorkspaceQueries, createWorkspaceQueryClient, protectedQueryKey } from '../query/client';
import { materialSources, materialReading, materialSections } from './materialReviewData';

const stamp = '2026-10-09T12:00:00.000Z', generation = 'research-fixture';
const historyQuestion = 'How do the saved source revisions change this evidence?';
const artifactRef = { id: 'report-fixture', revision: 1 }, scopeRef = { id: 'scope-fixture', revision: 1 }, handleRef = { id: 'handle-fixture', revision: 1 };
const excerpt = 'The saved question keeps its original source scope.';
const encode = (value: string) => new TextEncoder().encode(value);
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))].map(value => value.toString(16).padStart(2, '0')).join('');

export type ResearchHistoryState = Extract<ResearchRunStatusView['execution_state'], 'ENGINE_COMPLETED' | 'CANCELLED'>;
export interface ResearchPreviewProbe {
  assertEffects(admissions: number, intents: number): void;
  assertNoIntent(): void;
  assertHistorySelected(): void;
  holdUnknownIntent(): () => void;
  assertAdmission(question: string): void;
}

/** Actual runtime/Query/components; only the default recovery mode loses a durable ack. */
export function ResearchPreview({ designReview = false, historyState, onProbe }: {
  readonly designReview?: boolean;
  readonly historyState?: ResearchHistoryState;
  readonly onProbe?: (probe: ResearchPreviewProbe) => void;
} = {}) {
  const [environment] = useState(() => {
    const client = createWorkspaceQueryClient(), timers = { setTimeout: () => 0, clearTimeout() {} };
    let starts = 0, mints = 0, sectionsRead = 0, verifications = 0, opened = 0;
    let admissionPosts = 0, cancellations = 0, otherMutations = 0;
    let originalBody: string | undefined, originalKey: string | undefined;
    const sectionTexts = designReview ? materialSections : Array.from({ length: 40 }, (_, index) => `## Section ${index + 1}\n\nA saved draft keeps the question and its evidence together.\n`);
    const sectionTitles = sectionTexts.map(value => /^## ([^\r\n]+)/u.exec(value)?.[1] ?? '');
    const sourceRows = (designReview ? [...materialSources] : [{ id: 'source-fixture', title: 'How source versions preserve evidence' }]).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const readingHash = digest(encode(materialReading));
    const readyManifest: Promise<ArtifactRevisionRead> = Promise.all(sectionTexts.map(text => digest(encode(text)))).then(hashes => ({
      artifact_ref: artifactRef, spec_ref: { id: 'spec-fixture', revision: 1 }, spec_digest: 'a'.repeat(64),
      evidence_freeze_ref: { id: 'freeze-fixture', revision: 1 }, title: 'Research findings', sections: hashes.map((hash, index) => {
        const title = sectionTitles[index];
        if (title === undefined || title.length === 0) throw new Error(`Report section ${index + 1} has no fixture title`);
        return {
          section_ref: { id: `section-${index + 1}`, revision: 1 }, contract_id: `contract-${index + 1}`, title,
          body_object_ref: `body-${index + 1}`, body_sha256: hash, statement_labels: {},
          evidence_ledger_ref: 'ledger-fixture', verification_receipt_ref: 'verification-section',
        };
      }), dependency_manifest_ref: 'dependencies-fixture', deterministic_export_refs: {}, status: 'DRAFT', created_at: stamp,
    }));
    const excerptHash = digest(encode(excerpt));
    const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: 'research-trace', deployment_generation: generation }), { headers: { 'content-type': 'application/json' } });
    const launch = { investigation_ref: { id: 'investigation-fixture', revision: 1 }, workflow_instance_id: 'workflow-fixture' };
    const status = { ...launch, protocol: 'eliotr.research-run-status.v2', execution_state: 'ENGINE_COMPLETED', engine_status: 'complete', next_stage_index: 18, answer: { availability: 'draft', artifact_ref: artifactRef } };
    const historyLaunch = { investigation_ref: { id: 'investigation-history-fixture', revision: 1 }, workflow_instance_id: 'workflow-history-fixture' };
    const historyStatus = historyState === 'CANCELLED'
      ? { ...status, ...historyLaunch, execution_state: 'CANCELLED', engine_status: 'terminated',
        answer: { availability: 'unavailable' }, cancellation_receipt_ref: 'workflow-cancelled:workflow-history-fixture' }
      : { ...status, ...historyLaunch };
    const fetchFixture: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'https://fixture.invalid');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        if (url.pathname === '/api/v1/research/run' && method === 'POST') admissionPosts++;
        else if (/\/cancel(?:\/|$)/u.test(url.pathname)) cancellations++;
        else otherMutations++;
      }
      if (url.pathname === '/api/v1/system/health') return json({ ready: true, deployment_generation: generation, core_schema_generation: 'schema-1', search_schema_generation: 'schema-1', blocking_reason_codes: [], checked_at: stamp });
      if (url.pathname === '/api/v1/system/session') return json({ protocol: 'eliotr.owner-session.v1', principal_ref: 'research-owner', credential_generation: 'research-credential', client_class: 'owner_pwa', expires_at: '2027-01-01T00:00:00.000Z' });
      if (url.pathname === '/api/v1/research/projects') return json({ protocol: 'eliotr.project-owner-list.v1', projects: [{ protocol: 'eliotr.project-owner.v1', project_ref: { id: 'project-fixture', revision: 1 }, title: 'Evidence in context', revision: 1, owner_principal_ref: 'research-owner', deployment_generation: generation, source_ids: sourceRows.map(source => source.id).sort(), created_at: stamp }] });
      if (url.pathname === '/api/v1/research/catalog') return json({ projects: [{ id: 'project-fixture', title: 'Evidence in context', generation }], sources: sourceRows.map(source => ({ ...source, readiness_ref: `readiness:${source.id}:observation-1` })) });
      if (designReview && url.pathname === '/api/v1/library/readiness') {
        const source = url.searchParams.get('source_id'), revision = `${source}-revision-1`;
        return json({ protocol: 'eliotr.library-readiness.v1', source_id: source, source_revision_ref: revision,
          deployment_generation: generation, catalog_generation: '1', observed_at: stamp, quality_state: 'high_fidelity', readiness_basis: 'ACTIVE_VERIFIED',
          currentness: { verification: 'VERIFIED', value: { source_revision_ref: revision, owner_system_id: 'review-owner-system', source_owner_generation: 'review-owner-generation', source_view_ref: 'review-source-view', observation_freshness: 'current_confirmed', observed_at: stamp, gap_refs: [] } },
          channels: ['exact_ready', 'lexical_ready', 'semantic_ready'].map(channel => ({ channel, state: 'ready', source_revision_ref: revision, reason_codes: [], observed_at: stamp, generation: 'channel-1', receipt_ref: 'readiness-review' })) });
      }
      if (designReview && url.pathname === '/api/v1/library/revisions') {
        const source = url.searchParams.get('source_id'), revision = `${source}-revision-1`;
        return json({ protocol: 'eliotr.source-revisions.v1', source_id: source, head_revision_ref: revision, observed_at: stamp, readiness_basis: 'RECORDED_ONLY', revisions: [{ source_revision_ref: revision, content_sha256: await readingHash, captured_at: stamp, admitted_at: stamp, quality_state: 'high_fidelity', currentness_state: 'current_confirmed', readiness: [] }] });
      }
      if (designReview && url.pathname === '/api/v1/library/content') return new Response(materialReading, { headers: { 'content-type': 'text/plain', 'content-length': String(encode(materialReading).byteLength), 'x-eliotr-source-revision': url.searchParams.get('source_revision_ref') ?? '', 'x-eliotr-deployment-generation': generation, 'x-eliotr-content-sha256': await readingHash } });
      if (designReview && url.pathname === '/api/v1/system/mcp-diagnostics') return json({ protocol: 'eliotr.mcp.client-diagnostic.v1', status: 'ISSUED', challenge_id: 'review-challenge', issued_at: stamp, expires_at: '2026-10-09T12:05:00.000Z', deployment_generation: generation, auth_profile: 'managed-oauth' });
      if (designReview && url.pathname.endsWith('/client-grants')) return json({ protocol: 'eliotr.project-client-grants.v1', grants: [] });
      if (designReview && url.pathname.endsWith('/model-provider-key')) return json({ protocol: 'eliotr.research-provider-key-configuration.v1', project_id: 'project-fixture', provider_id: 'openrouter', configurations: [], truncated: false });
      if (designReview && url.pathname.endsWith('/model-configuration')) return json({ protocol: 'eliotr.research-project-model-configuration.v1', project_id: 'project-fixture', selection_revision: null, selected: null, revisions: [], next_cursor: null });
      if (url.pathname === '/api/v1/system/research-configuration') return json({ protocol: 'eliotr.research-configuration-readiness.v1', configuration: 'present', model_transport: 'available', qualification_state: 'current', run_readiness: 'ready', readiness_reason: 'QUALIFICATION_PROOFS_CURRENT', model_route: 'research-route', qualification_expires_at: '2027-01-01T00:00:00.000Z', missing_fields: [], invalid_fields: [], checked_at: stamp });
      if (url.pathname === '/api/v1/research/runs') return json({ protocol: 'eliotr.research-runs.v5',
        runs: [...(historyState || designReview ? [{ created_at: stamp, query: historyQuestion, status: historyStatus }] : []), ...(starts ? [{ created_at: stamp, query: historyQuestion, status }] : [])],
        saved_drafts: starts || designReview || historyState ? [{ created_at: stamp, artifact_ref: artifactRef, workflow_instance_id: historyState || designReview ? historyLaunch.workflow_instance_id : launch.workflow_instance_id }] : [],
        configuration_state: 'INSTALLED', checked_at: stamp });
      if (url.pathname === '/api/v1/research/wiki/proposals') return json({ protocol: 'eliotr.wiki-proposals.v1', items: [], has_more: false });
      if (url.pathname === '/api/v1/research/run' && init?.method === 'POST') {
        const headers = new Headers(init.headers), body = String(init.body), key = headers.get('idempotency-key');
        if (!key || headers.get('x-eliotr-csrf') !== '1' || (!designReview && mints !== 1)) throw new Error('Run intent or CSRF changed');
        starts++;
        if (designReview || historyState) {
          if (historyState) {
            if (starts !== 1 || mints !== 1) throw new Error('History return repeated admission or intent');
            originalBody = body; originalKey = key;
          }
          return json(launch);
        }
        if (starts === 1) { originalBody = body; originalKey = key; throw new TypeError('Synthetic lost launch acknowledgement after durable admission'); }
        if (starts !== 2 || body !== originalBody || key !== originalKey) throw new Error('Recovery replaced the original question or request identity');
        return json(launch);
      }
      if (url.pathname === '/api/v1/research/run/workflow-fixture') return json(status);
      if (url.pathname === '/api/v1/research/run/workflow-history-fixture') return json(historyStatus);
      const prefix = '/api/v1/research/artifact/report-fixture%3A1';
      if (url.pathname === prefix) return json(await readyManifest);
      if (url.pathname.startsWith(prefix + '/sections/')) {
        const part = decodeURIComponent(url.pathname.slice((prefix + '/sections/').length).split('/')[0] ?? '');
        const artifact = await readyManifest, index = artifact.sections.findIndex(section => `${section.section_ref.id}:${section.section_ref.revision}` === part);
        const section = artifact.sections[index]; if (!section) throw new Error('Undeclared section request');
        if (url.pathname.endsWith('/citations')) return json({ protocol: 'eliotr.artifact-section-citations.v1', artifact_ref: artifactRef, section_ref: section.section_ref, scope_snapshot_ref: scopeRef, verification_receipt_ref: section.verification_receipt_ref, semantic_verification: 'NOT_EXECUTED', cited_evidence: [{ handle_ref: handleRef, excerpt_sha256: await excerptHash }] });
        sectionsRead++; if (!designReview && index !== sectionsRead - 1) throw new Error('Report read its sections out of order or more than once');
        const bytes = encode(sectionTexts[index] ?? '');
        return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength), 'x-eliotr-artifact-ref': encodeURIComponent('report-fixture:1'), 'x-eliotr-section-ref': encodeURIComponent(part), 'x-eliotr-section-object-ref': encodeURIComponent(section.body_object_ref), 'x-eliotr-section-sha256': section.body_sha256, 'x-eliotr-deployment-generation': generation } });
      }
      if (url.pathname === '/api/v1/research/verify') {
        verifications++; if (!designReview && (sectionsRead < 1 || starts !== 2 || mints !== 1)) throw new Error('Evidence opened before the exact lazy section or recovery');
        const body: unknown = JSON.parse(String(init?.body));
        if (!body || typeof body !== 'object' || !('scope_snapshot_ref' in body) || !('handle_ref' in body) || JSON.stringify(body.scope_snapshot_ref) !== JSON.stringify(scopeRef) || JSON.stringify(body.handle_ref) !== JSON.stringify(handleRef)) throw new Error('Evidence scope or handle changed');
        const handle = { handle_ref: handleRef, source_namespace_id: 'namespace-fixture', source_owner_generation: 'source-owner-fixture', source_revision_ref: 'source-revision-fixture', scope_snapshot_ref: scopeRef,
          anchor: { kind: 'normalized_byte_range', start: 0, end: encode(excerpt).byteLength }, excerpt_sha256: await excerptHash, excerpt_byte_length: encode(excerpt).byteLength, object_residency_key_digest: 'b'.repeat(64), source_assurance_ceiling: 'EXACT', materializer_assurance_ceiling: 'EXACT', terminal_state: 'LIVE', created_at: stamp };
        return json({ handle, resolved_evidence: { handle, exact_excerpt: excerpt, verification_receipt_ref: 'evidence-verification', authorization_receipt_ref: 'evidence-authorization', credential_generation: 'research-credential', source_revision_content_sha256: 'c'.repeat(64), scope_snapshot_digest: 'd'.repeat(64), instruction_taint: 'UNTRUSTED', allowed_effects: 'READ_ONLY', resolved_at: stamp } });
      }
      if (url.pathname === '/api/v1/research/open/handle-fixture%3A1') {
        opened++; if (!designReview && (opened !== 1 || verifications !== 1 || sectionsRead < 1 || starts !== 2)) throw new Error('Evidence requests repeated or escaped lazy selection');
        return new Response(excerpt, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(encode(excerpt).byteLength), 'x-eliotr-evidence-handle': 'handle-fixture:1', 'x-eliotr-excerpt-sha256': await excerptHash, 'x-eliotr-verification-receipt': 'evidence-verification' } });
      }
      throw new Error('Unexpected research fixture request: ' + url.pathname);
    };
    const runtime = createWorkspaceRuntime({ fetch: fetchFixture, baseUrl: 'https://fixture.invalid', timers, now: () => Date.parse(stamp), sha256: digest,
      mint() { mints++; return designReview ? crypto.randomUUID() : '11111111-1111-4111-8111-111111111111'; }, isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); } });
    const privacy = createPrivacyController({ timers, now: () => Date.parse(stamp), mask() { runtime.close(); }, reveal() {}, cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); }, clearProtected() { clearWorkspaceQueries(client); }, verify: signal => runtime.verify(signal) });
    const memory = () => {
      const snapshot = privacy.getSnapshot();
      if (snapshot.phase !== 'available') throw new Error('Research fixture context is unavailable');
      return client.getQueryData<Record<string, unknown>>([...protectedQueryKey(snapshot.context, 'research'), 'local-intent']);
    };
    const probe: ResearchPreviewProbe = {
      assertEffects(admissions, intents) {
        if (admissionPosts !== admissions || mints !== intents || cancellations !== 0 || otherMutations !== 0)
          throw new Error('Research effect counts changed: ' + [admissionPosts, mints, cancellations, otherMutations].join('/'));
      },
      assertNoIntent() { if (memory()?.intent !== undefined) throw new Error('History observation allocated a local intent'); },
      assertHistorySelected() {
        probe.assertNoIntent();
        const observed = memory()?.observedLaunch;
        if (!observed || typeof observed !== 'object' || !('workflow_instance_id' in observed) ||
          observed.workflow_instance_id !== historyLaunch.workflow_instance_id ||
          !('investigation_ref' in observed) || JSON.stringify(observed.investigation_ref) !== JSON.stringify(historyLaunch.investigation_ref))
          throw new Error('Navigation or report return replaced the observed history run');
      },
      holdUnknownIntent() {
        const intent = memory()?.intent;
        if (!intent || typeof intent !== 'object' || !('phase' in intent) || intent.phase !== 'unknown')
          throw new Error('The original unknown local intent is missing');
        const held = JSON.stringify(intent);
        return () => {
          probe.assertEffects(1, 1);
          if (memory()?.intent !== intent || JSON.stringify(memory()?.intent) !== held)
            throw new Error('Navigation or history changed the original unknown intent');
        };
      },
      assertAdmission(question) {
        probe.assertEffects(1, 1);
        const intent = memory()?.intent;
        if (!intent || typeof intent !== 'object' || !('phase' in intent) || intent.phase !== 'admitted' ||
          !('body' in intent) || intent.body !== originalBody || !('key' in intent) || intent.key !== originalKey)
          throw new Error('Explicit Ask did not preserve its one acknowledged admission intent');
        const request: unknown = JSON.parse(originalBody ?? 'null');
        const expectedScope = {
          kind: 'INTERSECT',
          left: { kind: 'PROJECT', project_id: 'project-fixture' },
          right: { kind: 'SELECTED_SOURCES', source_ids: ['source-fixture'] },
        };
        if (!request || typeof request !== 'object' || !('query' in request) || request.query !== question ||
          !('scope_expression' in request) || JSON.stringify(request.scope_expression) !== JSON.stringify(expectedScope))
          throw new Error('Explicit Ask lost its held draft or selected project/source scope');
      },
    };
    return { client, runtime, privacy, probe };
  });
  useEffect(() => { onProbe?.(environment.probe); }, [environment, onProbe]);
  useEffect(() => {
    const unsubscribe = environment.privacy.subscribe(() => { const snapshot = environment.privacy.getSnapshot(); if (snapshot.phase === 'available') environment.runtime.bind(snapshot.context); });
    void environment.privacy.refresh();
    return () => { unsubscribe(); environment.privacy.dispose(); environment.runtime.dispose(); environment.client.clear(); };
  }, [environment]);
  return <QueryClientProvider client={environment.client}><MemoryRouter initialEntries={['/sources']}><Shell privacy={environment.privacy} runtime={environment.runtime} fixture={designReview} /></MemoryRouter></QueryClientProvider>;
}
export const playResearchJourney = async ({ canvas, userEvent }: {
  readonly canvas: { findByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): Promise<HTMLElement>;
    getByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): HTMLElement;
    queryByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): HTMLElement | null;
    getAllByRole(role: string, options: { readonly name: string }): HTMLElement[];
    findByText(text: string | RegExp, options?: { readonly selector: string }): Promise<HTMLElement>; queryByText(text: string): HTMLElement | null };
  readonly userEvent: { click(element: HTMLElement): Promise<void>; type(element: HTMLElement, text: string): Promise<void>; selectOptions(element: HTMLElement, value: string): Promise<void> };
}, probe: ResearchPreviewProbe) => {
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: 'Project', exact: true }), 'project-fixture');
  await userEvent.click(await canvas.findByText('Sources for your next question'));
  await userEvent.click(await canvas.findByRole('checkbox', { name: 'How source versions preserve evidence' }));
  await userEvent.click(canvas.getByRole('link', { name: 'Research', exact: true }));
  await userEvent.type(await canvas.findByRole('textbox', { name: 'Research question' }), 'How does a saved question preserve its evidence?');
  const ask = await canvas.findByRole('button', { name: 'Ask', exact: true }); ask.click(); ask.click();
  await canvas.findByText('The launch outcome is unknown. The original question and request identity are preserved.', { selector: '.er-status > span' });
  const unknownUnchanged = probe.holdUnknownIntent();
  if (canvas.queryByRole('button', { name: 'Ask another question', exact: true })) throw new Error('Unknown local intent exposed history dismissal');
  await userEvent.click(canvas.getByRole('button', { name: 'Refresh recent research' }));
  const historyRun = await canvas.findByRole('button', { name: 'Read this run' });
  if (!(historyRun instanceof HTMLButtonElement) || !historyRun.disabled) throw new Error('Unknown intent allowed history to replace its run');
  await userEvent.click(historyRun);
  unknownUnchanged();
  await userEvent.click(canvas.getByRole('link', { name: 'Studio', exact: true }));
  await canvas.findByRole('heading', { name: 'Studio', exact: true });
  await userEvent.click(canvas.getByRole('link', { name: 'Research', exact: true }));
  await canvas.findByRole('button', { name: 'Reconcile this question' });
  if (canvas.queryByRole('button', { name: 'Ask another question', exact: true })) throw new Error('Navigation exposed dismissal of an unknown local intent');
  unknownUnchanged();
  await userEvent.click(await canvas.findByRole('button', { name: 'Reconcile this question' }));
  await canvas.findByText('Research finished.');
  await userEvent.click(canvas.getAllByRole('button', { name: 'Open saved report' })[0] as HTMLElement);
  await canvas.findByText('40 sections');
  // The report reads itself in order; the first section opens with its quotes once it is read.
  await userEvent.click(await canvas.findByRole('button', { name: 'Open · Section 1' }));
  await canvas.findByText('A saved draft keeps the question and its evidence together.');
  await userEvent.click(await canvas.findByRole('button', { name: 'Open cited excerpt 1' }));
  await canvas.findByText(excerpt);
  if (canvas.queryByText('Supported')) throw new Error('Verified citation was promoted to semantic claim support');
  // Terminal visual readiness: the excerpt reached the actual citation surface with no promotion to support.
  markVisualReady(document.querySelector<HTMLElement>('.er-shell'));
};

/** One preexisting terminal history row, no local intent; only explicit Ask admits new work. */
export async function playResearchHistoryReturn({ canvas, userEvent }: Parameters<typeof playResearchJourney>[0],
  probe: ResearchPreviewProbe, historyState: ResearchHistoryState) {
  const sourceName = 'How source versions preserve evidence', draft = 'Which source revisions should the next question keep?';
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: 'Project', exact: true }), 'project-fixture');
  await userEvent.click(await canvas.findByText('Sources for your next question'));
  await userEvent.click(await canvas.findByRole('checkbox', { name: sourceName }));
  await userEvent.click(canvas.getByRole('link', { name: 'Research', exact: true }));
  await canvas.findByText(historyQuestion);
  const read = await canvas.findByRole('button', { name: 'Read this run' });
  probe.assertNoIntent(); probe.assertEffects(0, 0);
  await userEvent.click(read);
  await canvas.findByText(historyState === 'CANCELLED'
    ? 'The research was cancelled.' : 'Research finished.');
  await canvas.findByRole('button', { name: 'Ask another question', exact: true });
  probe.assertHistorySelected(); probe.assertEffects(0, 0);
  await userEvent.click(canvas.getByRole('link', { name: 'Sources', exact: true }));
  const source = await canvas.findByRole('checkbox', { name: sourceName });
  if (!(source instanceof HTMLInputElement) || !source.checked) throw new Error('History navigation cleared next-question source selection');
  await userEvent.click(canvas.getByRole('link', { name: 'Research', exact: true }));
  await canvas.findByRole('button', { name: 'Ask another question', exact: true });
  probe.assertHistorySelected(); probe.assertEffects(0, 0);
  await userEvent.click(canvas.getAllByRole('button', { name: 'Open saved report' })[0] as HTMLElement);
  await canvas.findByText('40 sections');
  probe.assertHistorySelected(); probe.assertEffects(0, 0);
  await userEvent.click(canvas.getByRole('button', { name: 'Close report', exact: true }));
  const held = await canvas.findByRole('textbox', { name: 'Next question', exact: true });
  await userEvent.type(held, draft);
  probe.assertHistorySelected(); probe.assertEffects(0, 0);
  if (canvas.queryByRole('button', { name: 'Ask', exact: true })) throw new Error('Viewed history exposed admission before release');
  await userEvent.click(canvas.getByRole('button', { name: 'Ask another question', exact: true }));
  const question = await canvas.findByRole('textbox', { name: 'Research question', exact: true });
  await announcementUntil(() => document.activeElement === question);
  if (!(question instanceof HTMLTextAreaElement) || question.value !== draft) throw new Error('History release lost the held next-question draft');
  probe.assertNoIntent(); probe.assertEffects(0, 0);
  if (canvas.queryByRole('button', { name: 'Ask another question', exact: true })) throw new Error('History release kept the old run selected');
  const details = canvas.getByRole('heading', { name: 'Question sources', exact: true }).closest('details');
  if (!(details instanceof HTMLDetailsElement)) throw new Error('Next-question source scope is missing');
  if (!details.open) await userEvent.click(canvas.getByRole('heading', { name: 'Question sources', exact: true }));
  const labels = details.querySelectorAll('li');
  if (labels.length !== 1 || labels[0]?.textContent !== sourceName) throw new Error('History release changed the next-question source scope');
  const ask = canvas.getByRole('button', { name: 'Ask', exact: true });
  if (!(ask instanceof HTMLButtonElement) || ask.disabled) throw new Error('Released history did not enable the held question');
  probe.assertEffects(0, 0);
  await userEvent.click(ask);
  await canvas.findByText('Research finished.');
  probe.assertAdmission(draft);
  if (canvas.queryByRole('button', { name: 'Reconcile this question' })) throw new Error('History fixture simulated a lost launch acknowledgement');
}

export async function playResearchAnnouncements({ canvas, userEvent }: Parameters<typeof playResearchJourney>[0]) {
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: 'Project', exact: true }), 'project-fixture');
  await userEvent.click(await canvas.findByText('Sources for your next question'));
  await userEvent.click(await canvas.findByRole('checkbox', { name: 'How source versions preserve evidence' }));
  await userEvent.click(canvas.getByRole('link', { name: 'Research', exact: true }));
  const question = await canvas.findByRole('textbox', { name: 'Research question' });
  const root = question.closest<HTMLElement>('main'); if (!root) throw new Error('Actual Research root absent');
  const region = paneAnnouncement(root);
  await announcementUntil(() => region.textContent === 'Recent research loaded.');
  const before = region.textContent;
  await userEvent.type(question, 'How does a saved question preserve its evidence?');
  if (paneAnnouncement(root) !== region || region.textContent !== before) throw new Error('Typing created a static live region');
  const ask = await canvas.findByRole('button', { name: 'Ask', exact: true }); ask.click(); ask.click();
  await announcementUntil(() => unchangedChannel(root, region, 'The launch outcome is unknown. The original question and request identity are preserved.'));
  await userEvent.click(await canvas.findByRole('button', { name: 'Reconcile this question' }));
  await announcementUntil(() => unchangedChannel(root, region, 'The engine finished. Review its result.'));
  // Terminal visual readiness: the engine-finished announcement settled on the retained channel.
  markVisualReady(document.querySelector<HTMLElement>('.er-shell'));
}
