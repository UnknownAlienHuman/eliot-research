import { useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ArtifactRevision } from '@eliotr/owner-api-client';
import { Shell } from './Shell';
import { createWorkspaceRuntime } from './runtime';
import { createPrivacyController } from './privacy';
import { clearWorkspaceQueries, createWorkspaceQueryClient } from '../query/client';

const stamp = '2026-10-09T12:00:00.000Z', generation = 'research-fixture';
const artifactRef = { id: 'report-fixture', revision: 1 }, scopeRef = { id: 'scope-fixture', revision: 1 }, handleRef = { id: 'handle-fixture', revision: 1 };
const excerpt = 'The saved question keeps its original source scope.';
const encode = (value: string) => new TextEncoder().encode(value);
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))].map(value => value.toString(16).padStart(2, '0')).join('');

/** Production runtime, Query and components; the synthetic HTTP boundary loses one durable ack. */
export function ResearchPreview() {
  const [environment] = useState(() => {
    const client = createWorkspaceQueryClient(), timers = { setTimeout: () => 0, clearTimeout() {} };
    let starts = 0, mints = 0, sectionsRead = 0, verifications = 0, opened = 0;
    let originalBody: string | undefined, originalKey: string | undefined;
    const sectionTexts = Array.from({ length: 40 }, (_, index) => `## Section ${index + 1}\n\nA saved draft keeps the question and its evidence together.\n`);
    const readyManifest: Promise<ArtifactRevision> = Promise.all(sectionTexts.map(text => digest(encode(text)))).then(hashes => ({
      artifact_ref: artifactRef, spec_ref: { id: 'spec-fixture', revision: 1 }, spec_digest: 'a'.repeat(64),
      evidence_freeze_ref: { id: 'freeze-fixture', revision: 1 }, sections: hashes.map((hash, index) => ({
        section_ref: { id: `section-${index + 1}`, revision: 1 }, contract_id: `contract-${index + 1}`,
        body_object_ref: `body-${index + 1}`, body_sha256: hash, statement_labels: {},
        evidence_ledger_ref: 'ledger-fixture', verification_receipt_ref: 'verification-section',
      })), dependency_manifest_ref: 'dependencies-fixture', deterministic_export_refs: {}, status: 'DRAFT', created_at: stamp,
    }));
    const excerptHash = digest(encode(excerpt));
    const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: 'research-trace', deployment_generation: generation }), { headers: { 'content-type': 'application/json' } });
    const launch = { investigation_ref: { id: 'investigation-fixture', revision: 1 }, workflow_instance_id: 'workflow-fixture' };
    const status = { ...launch, protocol: 'eliotr.research-run-status.v2', execution_state: 'ENGINE_COMPLETED', engine_status: 'complete', next_stage_index: 18, answer: { availability: 'draft', artifact_ref: artifactRef } };
    const fetchFixture: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'https://fixture.invalid');
      if (url.pathname === '/api/v1/system/health') return json({ ready: true, deployment_generation: generation, core_schema_generation: 'schema-1', search_schema_generation: 'schema-1', blocking_reason_codes: [], checked_at: stamp });
      if (url.pathname === '/api/v1/system/session') return json({ protocol: 'eliotr.owner-session.v1', principal_ref: 'research-owner', credential_generation: 'research-credential', client_class: 'owner_pwa', expires_at: '2027-01-01T00:00:00.000Z' });
      if (url.pathname === '/api/v1/research/projects') return json({ protocol: 'eliotr.project-owner-list.v1', projects: [{ protocol: 'eliotr.project-owner.v1', project_ref: { id: 'project-fixture', revision: 1 }, title: 'Evidence in context', revision: 1, owner_principal_ref: 'research-owner', deployment_generation: generation, source_ids: ['source-fixture'], created_at: stamp }] });
      if (url.pathname === '/api/v1/research/catalog') return json({ projects: [{ id: 'project-fixture', title: 'Evidence in context', generation }], sources: [{ id: 'source-fixture', title: 'How source versions preserve evidence', readiness_ref: 'readiness:source-fixture:observation-1' }] });
      if (url.pathname === '/api/v1/system/research-configuration') return json({ protocol: 'eliotr.research-configuration-readiness.v1', configuration: 'present', model_transport: 'available', qualification_state: 'current', run_readiness: 'ready', readiness_reason: 'QUALIFICATION_PROOFS_CURRENT', model_route: 'research-route', qualification_expires_at: '2027-01-01T00:00:00.000Z', missing_fields: [], invalid_fields: [], checked_at: stamp });
      if (url.pathname === '/api/v1/research/runs') return json({ protocol: 'eliotr.research-runs.v3', runs: starts ? [{ created_at: stamp, status }] : [], saved_drafts: starts ? [{ created_at: stamp, artifact_ref: artifactRef, workflow_instance_id: launch.workflow_instance_id }] : [], configuration_state: 'INSTALLED', checked_at: stamp });
      if (url.pathname === '/api/v1/research/wiki/proposals') return json({ protocol: 'eliotr.wiki-proposals.v1', items: [], has_more: false });
      if (url.pathname === '/api/v1/research/run' && init?.method === 'POST') {
        const headers = new Headers(init.headers), body = String(init.body), key = headers.get('idempotency-key');
        if (!key || headers.get('x-eliotr-csrf') !== '1' || mints !== 1) throw new Error('Run intent or CSRF changed');
        starts++;
        if (starts === 1) { originalBody = body; originalKey = key; throw new TypeError('Synthetic lost launch acknowledgement after durable admission'); }
        if (starts !== 2 || body !== originalBody || key !== originalKey) throw new Error('Recovery replaced the original question or request identity');
        return json(launch);
      }
      if (url.pathname === '/api/v1/research/run/workflow-fixture') return json(status);
      const prefix = '/api/v1/research/artifact/report-fixture%3A1';
      if (url.pathname === prefix) return json(await readyManifest);
      if (url.pathname.startsWith(prefix + '/sections/')) {
        const part = decodeURIComponent(url.pathname.slice((prefix + '/sections/').length).split('/')[0] ?? '');
        const artifact = await readyManifest, index = artifact.sections.findIndex(section => `${section.section_ref.id}:${section.section_ref.revision}` === part);
        const section = artifact.sections[index]; if (!section) throw new Error('Undeclared section request');
        if (url.pathname.endsWith('/citations')) return json({ protocol: 'eliotr.artifact-section-citations.v1', artifact_ref: artifactRef, section_ref: section.section_ref, scope_snapshot_ref: scopeRef, verification_receipt_ref: section.verification_receipt_ref, semantic_verification: 'NOT_EXECUTED', cited_evidence: [{ handle_ref: handleRef, excerpt_sha256: await excerptHash }] });
        sectionsRead++; if (sectionsRead !== 1 || index !== 0) throw new Error('Report eagerly fetched an unrequested required section');
        const bytes = encode(sectionTexts[index] ?? '');
        return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength), 'x-eliotr-artifact-ref': encodeURIComponent('report-fixture:1'), 'x-eliotr-section-ref': encodeURIComponent(part), 'x-eliotr-section-object-ref': encodeURIComponent(section.body_object_ref), 'x-eliotr-section-sha256': section.body_sha256, 'x-eliotr-deployment-generation': generation } });
      }
      if (url.pathname === '/api/v1/research/verify') {
        verifications++; if (sectionsRead !== 1 || starts !== 2 || mints !== 1) throw new Error('Evidence opened before the exact lazy section or recovery');
        const body: unknown = JSON.parse(String(init?.body));
        if (!body || typeof body !== 'object' || !('scope_snapshot_ref' in body) || !('handle_ref' in body) || JSON.stringify(body.scope_snapshot_ref) !== JSON.stringify(scopeRef) || JSON.stringify(body.handle_ref) !== JSON.stringify(handleRef)) throw new Error('Evidence scope or handle changed');
        const handle = { handle_ref: handleRef, source_namespace_id: 'namespace-fixture', source_owner_generation: 'source-owner-fixture', source_revision_ref: 'source-revision-fixture', scope_snapshot_ref: scopeRef,
          anchor: { kind: 'normalized_byte_range', start: 0, end: encode(excerpt).byteLength }, excerpt_sha256: await excerptHash, excerpt_byte_length: encode(excerpt).byteLength, object_residency_key_digest: 'b'.repeat(64), source_assurance_ceiling: 'EXACT', materializer_assurance_ceiling: 'EXACT', terminal_state: 'LIVE', created_at: stamp };
        return json({ handle, resolved_evidence: { handle, exact_excerpt: excerpt, verification_receipt_ref: 'evidence-verification', authorization_receipt_ref: 'evidence-authorization', credential_generation: 'research-credential', source_revision_content_sha256: 'c'.repeat(64), scope_snapshot_digest: 'd'.repeat(64), instruction_taint: 'UNTRUSTED', allowed_effects: 'READ_ONLY', resolved_at: stamp } });
      }
      if (url.pathname === '/api/v1/research/open/handle-fixture%3A1') {
        opened++; if (opened !== 1 || verifications !== 1 || sectionsRead !== 1 || starts !== 2) throw new Error('Evidence requests repeated or escaped lazy selection');
        return new Response(excerpt, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(encode(excerpt).byteLength), 'x-eliotr-evidence-handle': 'handle-fixture:1', 'x-eliotr-excerpt-sha256': await excerptHash, 'x-eliotr-verification-receipt': 'evidence-verification' } });
      }
      throw new Error('Unexpected research fixture request: ' + url.pathname);
    };
    const runtime = createWorkspaceRuntime({ fetch: fetchFixture, baseUrl: 'https://fixture.invalid', timers, now: () => Date.parse(stamp), sha256: digest,
      mint() { mints++; return '11111111-1111-4111-8111-111111111111'; }, isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); } });
    const privacy = createPrivacyController({ timers, now: () => Date.parse(stamp), mask() { runtime.close(); }, reveal() {}, cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); }, clearProtected() { clearWorkspaceQueries(client); }, verify: signal => runtime.verify(signal) });
    return { client, runtime, privacy };
  });
  useEffect(() => {
    const unsubscribe = environment.privacy.subscribe(() => { const snapshot = environment.privacy.getSnapshot(); if (snapshot.phase === 'available') environment.runtime.bind(snapshot.context); });
    void environment.privacy.refresh();
    return () => { unsubscribe(); environment.privacy.dispose(); environment.runtime.dispose(); environment.client.clear(); };
  }, [environment]);
  return <QueryClientProvider client={environment.client}><MemoryRouter initialEntries={['/sources']}><Shell privacy={environment.privacy} runtime={environment.runtime} fixture={false} /></MemoryRouter></QueryClientProvider>;
}
export const playResearchJourney = async ({ canvas, userEvent }: {
  readonly canvas: { findByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): Promise<HTMLElement>;
    getByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): HTMLElement;
    getAllByRole(role: string, options: { readonly name: string }): HTMLElement[];
    findByText(text: string | RegExp): Promise<HTMLElement>; queryByText(text: string): HTMLElement | null };
  readonly userEvent: { click(element: HTMLElement): Promise<void>; type(element: HTMLElement, text: string): Promise<void> };
}) => {
  await userEvent.click(await canvas.findByRole('button', { name: 'Evidence in context' }));
  await userEvent.click(await canvas.findByText('Sources for your next question'));
  await userEvent.click(await canvas.findByRole('checkbox', { name: 'How source versions preserve evidence' }));
  await userEvent.click(canvas.getByRole('link', { name: 'Research', exact: true }));
  await userEvent.type(await canvas.findByRole('textbox', { name: 'Research question' }), 'How does a saved question preserve its evidence?');
  const ask = await canvas.findByRole('button', { name: 'Ask', exact: true }); ask.click(); ask.click();
  await canvas.findByText('The launch outcome is unknown. The original question and request identity are preserved.');
  await userEvent.click(canvas.getByRole('link', { name: 'Studio', exact: true }));
  await canvas.findByRole('heading', { name: 'Studio', exact: true });
  await userEvent.click(canvas.getByRole('link', { name: 'Research', exact: true }));
  await userEvent.click(await canvas.findByRole('button', { name: 'Reconcile this question' }));
  await canvas.findByText('The run finished. Review the draft answer.');
  await userEvent.click(canvas.getAllByRole('button', { name: 'Open saved report' })[0] as HTMLElement);
  await canvas.findByText('40 declared');
  const exportButton = canvas.getByRole('button', { name: 'Export report' });
  if (!(exportButton instanceof HTMLButtonElement) || !exportButton.disabled) throw new Error('Unread required sections permitted export');
  await userEvent.click(canvas.getAllByRole('button', { name: 'Read section' })[0] as HTMLElement);
  await canvas.findByText('A saved draft keeps the question and its evidence together.');
  if (!exportButton.disabled) throw new Error('One of forty sections incorrectly completed the report');
  await userEvent.click(await canvas.findByRole('button', { name: 'Open cited excerpt 1' }));
  await canvas.findByText(excerpt);
  if (canvas.queryByText('Supported')) throw new Error('Verified citation was promoted to semantic claim support');
};
