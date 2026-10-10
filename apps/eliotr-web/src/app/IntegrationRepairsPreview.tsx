import { useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { Shell } from './Shell';
import { createWorkspaceRuntime } from './runtime';
import { createPrivacyController } from './privacy';
import { createWorkspaceQueryClient, clearWorkspaceQueries, protectedQueryKey } from '../query/client';
import type { LibraryPage } from '@eliotr/owner-api-client';
import type { playResearchJourney } from './ResearchPreview';
import { paneAnnouncement, announcementUntil, unchangedChannel } from './announcementAssertions';

/** Synthetic contract fixture. Only stories import it; every interaction uses the real workspace. */
export function IntegrationRepairsPreview({ stalePage = false }: { readonly stalePage?: boolean }) {
  const [environment] = useState(() => {
    const client = createWorkspaceQueryClient();
    const generation = 'integration-fixture', stamp = '2026-10-09T12:00:00.000Z';
    let mints = 0, starts = 0, originalBody = '', originalKey = '', catalogReads = 0;
    const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: 'integration-trace', deployment_generation: generation }), { headers: { 'content-type': 'application/json' } });
    const launch = { investigation_ref: { id: 'integration-investigation', revision: 1 }, workflow_instance_id: 'integration-workflow' };
    const fetchFixture: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'https://fixture.invalid');
      if (url.pathname === '/api/v1/system/health') return json({ ready: true, deployment_generation: generation, core_schema_generation: 'schema-1', search_schema_generation: 'schema-1', blocking_reason_codes: [], checked_at: stamp });
      if (url.pathname === '/api/v1/system/session') return json({ protocol: 'eliotr.owner-session.v1', principal_ref: 'integration-owner', credential_generation: 'integration-credential', client_class: 'owner_pwa', expires_at: '2027-01-01T00:00:00.000Z' });
      if (url.pathname === '/api/v1/research/projects') return json({ protocol: 'eliotr.project-owner-list.v1', projects: [{ protocol: 'eliotr.project-owner.v1', project_ref: { id: 'integration-project', revision: 1 }, title: 'Sources across pages', revision: 1, owner_principal_ref: 'integration-owner', deployment_generation: generation, source_ids: ['integration-source-1', 'integration-source-2'], created_at: stamp }] });
      if (url.pathname === '/api/v1/research/catalog') {
        catalogReads++;
        const second = url.searchParams.get('cursor') === 'page_two';
        return json({ projects: [{ id: 'integration-project', title: 'Sources across pages', generation }], sources: [{ id: `integration-source-${second ? 2 : 1}`, title: second ? 'Second selected source' : 'First selected source', readiness_ref: `readiness:integration-source-${second ? 2 : 1}:observation-1` }], ...(second ? {} : { next_cursor: 'page_two' }) });
      }
      if (url.pathname === '/api/v1/system/research-configuration') return json({ protocol: 'eliotr.research-configuration-readiness.v1', configuration: 'present', model_transport: 'available', qualification_state: 'current', run_readiness: 'ready', readiness_reason: 'QUALIFICATION_PROOFS_CURRENT', model_route: 'integration-route', qualification_expires_at: '2027-01-01T00:00:00.000Z', missing_fields: [], invalid_fields: [], checked_at: stamp });
      // History failure must not prevent same-key recovery of the independently acknowledged run.
      if (url.pathname === '/api/v1/research/runs') throw new TypeError('Synthetic history read failure');
      if (url.pathname === '/api/v1/research/run' && init?.method === 'POST') {
        const body = String(init.body), key = new Headers(init.headers).get('idempotency-key') ?? '';
        if (mints !== 1 || !key) throw new Error('Request identity was not minted exactly once');
        const request = JSON.parse(body) as { scope_expression?: { source_ids?: unknown } };
        if (JSON.stringify(request.scope_expression?.source_ids) !== JSON.stringify(['integration-source-1', 'integration-source-2'])) throw new Error('Cross-page source selection was lost');
        starts++;
        if (starts === 1) { originalBody = body; originalKey = key; throw new TypeError('Synthetic lost admission acknowledgement'); }
        if (starts !== 2 || body !== originalBody || key !== originalKey) throw new Error('Recovery changed the original request');
        return json(launch);
      }
      if (url.pathname === '/api/v1/research/run/integration-workflow') return json({ ...launch, protocol: 'eliotr.research-run-status.v2', execution_state: 'ENGINE_COMPLETED', engine_status: 'complete', next_stage_index: 18, answer: { availability: 'draft', artifact_ref: { id: 'integration-report', revision: 1 } } });
      throw new TypeError('Unsupported synthetic route: ' + url.pathname);
    };
    const timers = { setTimeout: () => 0, clearTimeout() {} };
    const runtime = createWorkspaceRuntime({ fetch: fetchFixture, baseUrl: 'https://fixture.invalid', timers, now: () => Date.parse(stamp),
      sha256: async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))].map(value => value.toString(16).padStart(2, '0')).join(''),
      mint: () => { mints++; return '11111111-1111-4111-8111-111111111111'; }, onAuthorizationLoss: () => privacy.close(), isCurrent: context => privacy.isCurrent(context) });
    const privacy = createPrivacyController({ now: () => Date.parse(stamp), timers, mask() { runtime.close(); }, reveal() {}, cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); },
      clearProtected: () => clearWorkspaceQueries(client), verify: signal => runtime.verify(signal) });
    const replace = () => {
      const snapshot = privacy.getSnapshot(); if (snapshot.phase !== 'available') return;
      const key = [...protectedQueryKey(snapshot.context, 'sources'), 'library', 'integration-project', null];
      const page = client.getQueryData<LibraryPage>(key);
      if (!page) throw new Error('Selected first page was garbage-collected');
      client.setQueryData<LibraryPage>(key, { ...page, sources: page.sources.map(source => ({ ...source, title: source.title + ' changed' })) });
    };
    return { client, privacy, runtime, replace, counts: () => `${catalogReads}/${mints}/${starts}` };
  });
  useEffect(() => {
    const unsubscribe = environment.privacy.subscribe(() => { const snapshot = environment.privacy.getSnapshot(); if (snapshot.phase === 'available') environment.runtime.bind(snapshot.context); });
    void environment.privacy.refresh();
    return () => { unsubscribe(); environment.privacy.dispose(); environment.runtime.dispose(); environment.client.clear(); };
  }, [environment]);
  return <QueryClientProvider client={environment.client}><MemoryRouter initialEntries={['/sources']}>
    <Shell privacy={environment.privacy} runtime={environment.runtime} fixture={false} />
    {stalePage && <button type="button" onClick={environment.replace}>Replace selected first page</button>}
    <button type="button" onClick={event => { event.currentTarget.textContent = environment.counts(); }}>Read fixture request counts</button>
  </MemoryRouter></QueryClientProvider>;
}

type Journey = Parameters<typeof playResearchJourney>[0];
export async function playIntegrationRepairs({ canvas, userEvent }: Journey) {
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: 'Project', exact: true }), 'integration-project');
  await userEvent.click(await canvas.findByText('Sources for your next question'));
  await userEvent.click(await canvas.findByRole('checkbox', { name: 'First selected source' }));
  await userEvent.click(canvas.getByRole('button', { name: 'Next page', exact: true }));
  await userEvent.click(await canvas.findByRole('checkbox', { name: 'Second selected source' }));
  await userEvent.click(canvas.getByRole('link', { name: 'Research', exact: true }));
  const question = await canvas.findByRole('textbox', { name: 'Research question' });
  const root = question.closest<HTMLElement>('main');
  if (!root) throw new Error('Actual Research root absent');
  const region = paneAnnouncement(root);
  await userEvent.type(question, 'Compare the two selected sources.');
  await userEvent.click(canvas.getByRole('button', { name: 'Ask', exact: true }));
  await canvas.findByText('The launch outcome is unknown. The original question and request identity are preserved.', { selector: '.er-status > span' });
  await announcementUntil(() => unchangedChannel(root, region, 'The launch outcome is unknown. The original question and request identity are preserved.'));
  await userEvent.click(canvas.getByRole('button', { name: 'Reconcile this question', exact: true }));
  await canvas.findByText('The run finished. Review the draft answer.');
  await announcementUntil(() => unchangedChannel(root, region, 'The engine finished. Review its result.'));
  const count = canvas.getByRole('button', { name: 'Read fixture request counts', exact: true });
  await userEvent.click(count);
  if (count.textContent !== '2/1/2') throw new Error('Unexpected reads or duplicated run identity: ' + count.textContent);
}

export async function playReplacedSelection({ canvas, userEvent }: Journey) {
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: 'Project', exact: true }), 'integration-project');
  await userEvent.click(await canvas.findByText('Sources for your next question'));
  await userEvent.click(await canvas.findByRole('checkbox', { name: 'First selected source' }));
  await userEvent.click(canvas.getByRole('button', { name: 'Next page', exact: true }));
  await userEvent.click(await canvas.findByRole('checkbox', { name: 'Second selected source' }));
  await userEvent.click(canvas.getByRole('button', { name: 'Replace selected first page', exact: true }));
  await userEvent.click(canvas.getByRole('link', { name: 'Research', exact: true }));
  await userEvent.type(await canvas.findByRole('textbox', { name: 'Research question' }), 'Do not submit stale source observations.');
  const ask = canvas.getByRole('button', { name: 'Ask', exact: true });
  if (!(ask instanceof HTMLButtonElement) || !ask.disabled) throw new Error('Replaced selected page still admitted a question');
  const count = canvas.getByRole('button', { name: 'Read fixture request counts', exact: true });
  await userEvent.click(count);
  if (count.textContent !== '2/0/0') throw new Error('Stale source caused a remote mutation: ' + count.textContent);
}
