import { useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { WikiProposalReadView } from '@eliotr/owner-api-client';
import { Shell } from './Shell';
import { createWorkspaceRuntime } from './runtime';
import { createPrivacyController } from './privacy';
import { clearWorkspaceQueries, createWorkspaceQueryClient } from '../query/client';

const stamp = '2026-10-09T12:00:00.000Z', generation = 'studio-fixture';
const baseBody = 'A verified source scope stays with the saved page.';
const encode = (text: string) => new TextEncoder().encode(text);
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))].map(value => value.toString(16).padStart(2, '0')).join('');

/** Real client and protected memory; one durable edit and one publication each lose an ack. */
export function StudioPreview() {
  const [environment] = useState(() => {
    const client = createWorkspaceQueryClient(), timers = { setTimeout: () => 0, clearTimeout() {} };
    let edits = 0, publishes = 0, mints = 0, created = false, published = false;
    let originalBody: string | undefined, originalKey: string | undefined;
    const page = async (revision: number): Promise<WikiProposalReadView['page']> => ({
      page_ref: { id: 'wiki-page-fixture', revision }, page_type: 'Topic', title: 'Evidence scope in a saved page',
      scope_snapshot_ref: { id: 'wiki-scope-fixture', revision: 1 }, body_object_ref: `wiki-body-${revision}`,
      body_sha256: await digest(encode(baseBody)), statement_labels: {}, evidence_map_ref: 'wiki-map-fixture',
      counterposition_refs: [], coverage_receipt_ref: { id: 'wiki-coverage-fixture', revision: 1 }, limitations: [],
      dependency_refs: [], generator_generation: 'wiki-generator-fixture', status: revision === 2 && published ? 'PUBLISHED' : 'DRAFT',
      ...(revision === 2 ? { supersedes_ref: { id: 'wiki-page-fixture', revision: 1 } } : {}), publication_metadata: {}, created_at: stamp,
    });
    const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: 'studio-trace', deployment_generation: generation }), { headers: { 'content-type': 'application/json' } });
    const summary = (revision: number) => ({ proposal_ref: { id: `wiki-proposal-${revision}`, revision: 1 },
      page_ref: { id: 'wiki-page-fixture', revision }, title: 'Evidence scope in a saved page', page_type: 'Topic',
      risk_class: 'D2_ANALYTICAL', state: revision === 2 && published ? 'PUBLISHED' : 'PROPOSED', created_at: stamp });
    const fetchFixture: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'https://fixture.invalid');
      if (url.pathname === '/api/v1/system/health') return json({ ready: true, deployment_generation: generation, core_schema_generation: 'schema-1', search_schema_generation: 'schema-1', blocking_reason_codes: [], checked_at: stamp });
      if (url.pathname === '/api/v1/system/session') return json({ protocol: 'eliotr.owner-session.v1', principal_ref: 'studio-owner', credential_generation: 'studio-credential', client_class: 'owner_pwa', expires_at: '2027-01-01T00:00:00.000Z' });
      if (url.pathname === '/api/v1/research/projects') return json({ protocol: 'eliotr.project-owner-list.v1', projects: [] });
      if (url.pathname === '/api/v1/research/runs') return json({ protocol: 'eliotr.research-runs.v3', runs: [], saved_drafts: [], configuration_state: 'INSTALLED', checked_at: stamp });
      if (url.pathname === '/api/v1/system/research-configuration') return json({ protocol: 'eliotr.research-configuration-readiness.v1', configuration: 'present', model_transport: 'available', qualification_state: 'current', run_readiness: 'ready', readiness_reason: 'QUALIFICATION_PROOFS_CURRENT', model_route: 'research-route', qualification_expires_at: '2027-01-01T00:00:00.000Z', missing_fields: [], invalid_fields: [], checked_at: stamp });
      if (url.pathname === '/api/v1/research/wiki/proposals') return json({ protocol: 'eliotr.wiki-proposals.v1', items: created ? [summary(1), summary(2)] : [summary(1)], has_more: false });
      if (url.pathname === '/api/v1/research/wiki/proposals/from-edit' && init?.method === 'POST') {
        const body = String(init.body), headers = new Headers(init.headers), key = headers.get('idempotency-key');
        const request: unknown = JSON.parse(body);
        if (!request || typeof request !== 'object' || !('body_text' in request) || request.body_text !== baseBody ||
          !('expected_head_revision' in request) || request.expected_head_revision !== 1 ||
          !('base_proposal_ref' in request) || JSON.stringify(request.base_proposal_ref) !== JSON.stringify({ id: 'wiki-proposal-1', revision: 1 }) ||
          !key || headers.get('x-eliotr-csrf') !== '1' || mints !== 1) throw new Error('Edit changed the verified body, base, CAS or intent');
        edits++;
        if (edits === 1) { originalBody = body; originalKey = key; created = true; throw new TypeError('Synthetic lost durable edit acknowledgement'); }
        if (edits !== 2 || body !== originalBody || key !== originalKey) throw new Error('Edit recovery replaced its original request');
        return json({ protocol: 'eliotr.wiki-proposal.v1', proposal_ref: { id: 'wiki-proposal-2', revision: 1 }, page_ref: { id: 'wiki-page-fixture', revision: 2 }, risk_class: 'D2_ANALYTICAL', state: 'PROPOSED' });
      }
      if (url.pathname === '/api/v1/research/wiki/publications' && init?.method === 'POST') {
        const request: unknown = JSON.parse(String(init.body));
        if (!request || typeof request !== 'object' || !('proposal_ref' in request) ||
          JSON.stringify(request.proposal_ref) !== JSON.stringify({ id: 'wiki-proposal-2', revision: 1 }) ||
          !('expected_head_revision' in request) || request.expected_head_revision !== 1 || edits !== 2 || mints !== 2 || ++publishes !== 1) throw new Error('Publication changed CAS, duplicated an effect or crossed the edit intent');
        published = true; throw new TypeError('Synthetic lost durable publication acknowledgement');
      }
      const match = /^\/api\/v1\/research\/wiki\/proposals\/wiki-proposal-([12])(\/body)?$/u.exec(url.pathname);
      if (match) {
        const revision = Number(match[1]); if (revision === 2 && !created) throw new Error('Uncreated draft was read');
        const loaded = await page(revision);
        if (match[2]) return new Response(baseBody, { headers: {
          'content-type': 'text/plain; charset=utf-8', 'content-length': String(encode(baseBody).byteLength),
          'x-eliotr-wiki-proposal-ref': encodeURIComponent(`wiki-proposal-${revision}:1`),
          'x-eliotr-wiki-page-ref': encodeURIComponent(`wiki-page-fixture:${revision}`),
          'x-eliotr-body-sha256': loaded.body_sha256, 'x-eliotr-deployment-generation': generation,
        } });
        return json({ protocol: 'eliotr.wiki-proposal-read.v2', proposal_ref: { id: `wiki-proposal-${revision}`, revision: 1 },
          page: loaded, risk_class: 'D2_ANALYTICAL', state: revision === 2 && published ? 'PUBLISHED' : 'PROPOSED',
          source_freshness: { state: 'PREVIOUS_REVISIONS', checked_at: stamp, changed_sources: [{ source_id: 'wiki-source-fixture', saved_revision_ref: 'source-old', head_revision_ref: 'source-new' }] } });
      }
      throw new Error('Unexpected Studio fixture request: ' + url.pathname);
    };
    const runtime = createWorkspaceRuntime({ fetch: fetchFixture, baseUrl: 'https://fixture.invalid', timers, now: () => Date.parse(stamp), sha256: digest,
      mint() { mints++; return mints === 1 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222'; },
      isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); } });
    const privacy = createPrivacyController({ timers, now: () => Date.parse(stamp), mask() { runtime.close(); }, reveal() {},
      cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); }, clearProtected() { clearWorkspaceQueries(client); }, verify: signal => runtime.verify(signal) });
    return { client, runtime, privacy };
  });
  useEffect(() => {
    const unsubscribe = environment.privacy.subscribe(() => { const snapshot = environment.privacy.getSnapshot(); if (snapshot.phase === 'available') environment.runtime.bind(snapshot.context); });
    void environment.privacy.refresh();
    return () => { unsubscribe(); environment.privacy.dispose(); environment.runtime.dispose(); environment.client.clear(); };
  }, [environment]);
  return <QueryClientProvider client={environment.client}><MemoryRouter initialEntries={['/studio']}><Shell privacy={environment.privacy} runtime={environment.runtime} fixture={false} /></MemoryRouter></QueryClientProvider>;
}

export const playStudioJourney = async ({ canvas, userEvent }: {
  readonly canvas: { findByRole(role: string, options: { readonly name: string | RegExp; readonly exact?: boolean }): Promise<HTMLElement>;
    getByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): HTMLElement;
    findByText(text: string, options?: { readonly selector: string }): Promise<HTMLElement>; queryByRole(role: string, options: { readonly name: string }): HTMLElement | null };
  readonly userEvent: { click(element: HTMLElement): Promise<void> };
}) => {
  await userEvent.click(await canvas.findByRole('button', { name: /Evidence scope in a saved page/u }));
  await canvas.findByText(baseBody, { selector: '.er-studio-live__body' });
  const edit = await canvas.findByRole('button', { name: 'Create a new draft from this page' }); edit.click(); edit.click();
  await canvas.findByText('The last action has no confirmed outcome. Its original draft, content and request identity are preserved.');
  await userEvent.click(canvas.getByRole('link', { name: 'Research', exact: true }));
  await canvas.findByRole('heading', { name: 'Research', exact: true });
  await userEvent.click(canvas.getByRole('link', { name: 'Studio', exact: true }));
  await userEvent.click(await canvas.findByRole('button', { name: 'Check the same action' }));
  await canvas.findByText('A new draft revision was returned. The previous page was preserved.');
  await canvas.findByText(baseBody, { selector: '.er-studio-live__body' });
  await userEvent.click(await canvas.findByRole('button', { name: 'Publish page' }));
  const publish = await canvas.findByRole('button', { name: 'Confirm publication' }); publish.click(); publish.click();
  await canvas.findByText('The last action has no confirmed outcome. Its original draft, content and request identity are preserved.');
  await userEvent.click(canvas.getByRole('link', { name: 'Research', exact: true }));
  await canvas.findByRole('heading', { name: 'Research', exact: true });
  await userEvent.click(canvas.getByRole('link', { name: 'Studio', exact: true }));
  await userEvent.click(await canvas.findByRole('button', { name: 'Check the same action' }));
  await canvas.findByText('PUBLISHED');
  if (canvas.queryByRole('button', { name: 'Publish page' }) || canvas.queryByRole('button', { name: 'Confirm publication' })) throw new Error('Canonical published readback exposed another publication');
};
