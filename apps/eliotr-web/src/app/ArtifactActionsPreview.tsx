import { paneAnnouncement, announcementUntil, unchangedChannel } from './announcementAssertions';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Button } from '@eliotr/ui';
import type { ArtifactRevision, VersionedRef } from '@eliotr/owner-api-client';
import { ArtifactActions } from './ArtifactActions';
import { createPrivacyController } from './privacy';
import { createWorkspaceRuntime } from './runtime';
import { clearWorkspaceQueries, createWorkspaceQueryClient } from '../query/client';
import type { playResearchJourney } from './ResearchPreview';

const stamp = '2026-10-09T12:00:00.000Z', generation = 'artifact-fixture', digest = 'a'.repeat(64);
const draft = (id: string): ArtifactRevision => ({ artifact_ref: { id, revision: 1 },
  spec_ref: { id: 'spec', revision: 1 }, spec_digest: digest, evidence_freeze_ref: { id: 'freeze', revision: 1 },
  sections: [{ section_ref: { id: 'section-ref', revision: 1 }, contract_id: 'analysis/summary',
    body_object_ref: 'body', body_sha256: digest, statement_labels: {}, evidence_ledger_ref: 'ledger',
    verification_receipt_ref: 'verified-section' }], dependency_manifest_ref: 'dependencies',
  deterministic_export_refs: {}, status: 'DRAFT', created_at: stamp });
const first = draft('report-a'), second = draft('report-b');

/** Real runtime/client/Query and action component; synthetic HTTP loses one acknowledgement. */
export function ArtifactActionsPreview() {
  const [environment] = useState(() => {
    const client = createWorkspaceQueryClient(), timers = { setTimeout: () => 0, clearTimeout() {} };
    let acceptancePosts = 0, revisionPosts = 0, accepted = false, originalRevisionKey: string | null;
    const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: 'artifact-trace', deployment_generation: generation }),
      { headers: { 'content-type': 'application/json' } });
    const fetchFixture: typeof fetch = async (input, init) => {
      const path = new URL(String(input), 'https://fixture.invalid').pathname;
      if (path.endsWith('/publication') || path.endsWith('/publication/current')) {
        if (!accepted) return new Response(JSON.stringify({ type: 'urn:eliotr:problem:artifact-publication-not-found',
          title: 'No publication is recorded', status: 404, code: 'ARTIFACT_PUBLICATION_NOT_FOUND', trace_id: 'artifact-trace', retryable: false }),
          { status: 404, headers: { 'content-type': 'application/json' } });
        if (!path.includes('report-a%3A1') || acceptancePosts !== 1) throw new Error('Recovery changed the accepted artifact or repeated acceptance');
        return json({ protocol: 'eliotr.artifact-publication.v1', revision: { ...first, status: 'ACCEPTED' },
          receipt: { publication_ref: 'publication', artifact_ref: first.artifact_ref, publication_revision: 1,
            manifest_sha256: digest, verification_set_sha256: digest, evidence_currentness_sha256: digest,
            acceptance_decision_ref: 'decision', acceptance_provenance_ref: 'provenance', acceptance_decision_sha256: digest,
            principal_ref: 'owner', authorization_receipt_ref: 'authorization', created_at: stamp } });
      }
      if (path === '/api/v1/research/artifact/report-a%3A1/accept' && init?.method === 'POST') {
        const headers = new Headers(init.headers);
        if (!headers.get('idempotency-key') || headers.get('x-eliotr-csrf') !== '1' || init.body !== JSON.stringify({
          protocol: 'eliotr.artifact-publication-accept.v1', expected_draft_head_revision: 1, expected_publication_revision: null })) {
          throw new Error('Acceptance lost its original publication CAS or transport identity');
        }
        acceptancePosts++; if (acceptancePosts !== 1) throw new Error('Acceptance was repeated after accepted readback');
        accepted = true; throw new TypeError('Synthetic lost acknowledgement after acceptance');
      }
      if (path === '/api/v1/research/artifact/report-b%3A1/sections/analysis%2Fsummary/revise' && init?.method === 'POST') {
        const key = new Headers(init.headers).get('idempotency-key');
        if (!key || init.body !== JSON.stringify({ protocol: 'eliotr.artifact-section-revise.v1', expected_artifact_revision: 1 })) {
          throw new Error('Section revise lost the original contract or parent revision');
        }
        revisionPosts++;
        if (revisionPosts === 1) originalRevisionKey = key;
        else if (revisionPosts !== 2 || key !== originalRevisionKey) throw new Error('Section recovery replaced its original identity');
        return json({ protocol: 'eliotr.artifact-section-revise-status.v1', operation_id: 'operation', attempt_ref: 'attempt',
          state: revisionPosts === 1 ? 'STARTED' : 'COMMITTED', parent_artifact_ref: second.artifact_ref,
          section_id: 'analysis/summary', disposition: revisionPosts === 1 ? 'CREATED' : 'EXISTING',
          ...(revisionPosts === 1 ? {} : { draft: { artifact_ref: { id: 'report-b', revision: 2 }, manifest_sha256: digest } }) });
      }
      throw new Error('Unexpected fixture request: ' + path);
    };
    const runtime = createWorkspaceRuntime({ fetch: fetchFixture, baseUrl: 'https://fixture.invalid', timers, now: () => Date.parse(stamp),
      mint: () => '11111111-1111-4111-8111-111111111111',
      async sha256(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
        .map(value => value.toString(16).padStart(2, '0')).join(''); },
      isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); } });
    const privacy = createPrivacyController({ timers, now: () => Date.parse(stamp), mask() { runtime.close(); }, reveal() {},
      cancelReads() { void client.cancelQueries(undefined, { revert: false, silent: true }); },
      clearProtected() { clearWorkspaceQueries(client); }, async verify() { return { principal: 'owner', credentialGeneration: 'credential',
        deploymentGeneration: generation, expiresAt: '2027-01-01T00:00:00.000Z' }; } });
    return { runtime, privacy, client };
  });
  const [selected, setSelected] = useState(first), [opened, setOpened] = useState<VersionedRef>();
  const snapshot = useSyncExternalStore(environment.privacy.subscribe, environment.privacy.getSnapshot);
  useEffect(() => {
    const unsubscribe = environment.privacy.subscribe(() => {
      const next = environment.privacy.getSnapshot(); if (next.phase === 'available') environment.runtime.bind(next.context);
    });
    void environment.privacy.refresh();
    return () => { unsubscribe(); environment.privacy.close(); environment.runtime.close(); };
  }, [environment]);
  const apis = snapshot.phase === 'available' ? environment.runtime.read(snapshot.context) : undefined;
  return <QueryClientProvider client={environment.client}><main className="er-live-workspace">
    <h1>Report action recovery</h1>
    <h2>{selected === first ? 'First report' : 'Other draft'}</h2>
    <Button variant="text" onClick={() => setSelected(selected === first ? second : first)}>
      {selected === first ? 'Open other draft' : 'Back to first report'}</Button>
    {snapshot.phase === 'available' && apis && <ArtifactActions key={selected.artifact_ref.id} apis={apis}
      privacy={environment.privacy} context={snapshot.context} locale="en" artifact={selected}
      currentArtifact={() => selected} sectionId="analysis/summary" onOpenDraft={ref => {
        if (ref.id !== 'report-b' || ref.revision !== 2) throw new Error('A different child was opened'); setOpened(ref);
      }} />}
    {opened && <output>Opened child revision {opened.revision}</output>}
  </main></QueryClientProvider>;
}

export const playArtifactActionsJourney = async ({ canvas, userEvent }: Parameters<typeof playResearchJourney>[0]) => {
  const accept = await canvas.findByRole('button', { name: 'Accept this report' });
  const actionRoot = accept.closest<HTMLElement>('section'); if (!actionRoot) throw new Error('Report action root absent');
  const firstRegion = paneAnnouncement(actionRoot);
  if (firstRegion.textContent !== '') throw new Error('Initial report facts announced');
  await userEvent.click(accept);
  await userEvent.click(canvas.getByRole('button', { name: 'Confirm owner acceptance' }));
  await canvas.findByText('The action could not be confirmed. Read its status before continuing.', { selector: '.er-status > span' });
  await userEvent.click(canvas.getByRole('button', { name: 'Reconcile the original action' }));
  await canvas.findByText('Owner acceptance is confirmed for this revision.', { selector: '.er-status > span' });
  await announcementUntil(() => unchangedChannel(actionRoot, firstRegion, 'Owner acceptance is confirmed for this revision.'));
  await userEvent.click(canvas.getByRole('button', { name: 'Open other draft' }));
  const revise = await canvas.findByRole('button', { name: 'Revise this section' });
  const otherRoot = revise.closest<HTMLElement>('section'); if (!otherRoot) throw new Error('Other report root absent');
  const otherRegion = paneAnnouncement(otherRoot);
  if (firstRegion.isConnected || otherRegion.textContent !== '') throw new Error('Another report inherited operation feedback');
  await userEvent.click(await canvas.findByRole('button', { name: 'Revise this section' }));
  await canvas.findByText('The previous action is unresolved. Its original request is preserved.', { selector: '.er-status > span' });
  await userEvent.click(canvas.getByRole('button', { name: 'Back to first report' }));
  await canvas.findByText('An action on another report is unresolved. Return to that report to reconcile it.', { selector: '.er-status > span' });
  const review = canvas.getByRole('button', { name: 'Read acceptance status' });
  if (!(review instanceof HTMLButtonElement) || !review.disabled) throw new Error('Another report could overwrite an unresolved revision identity');
  await userEvent.click(canvas.getByRole('button', { name: 'Open other draft' }));
  await userEvent.click(await canvas.findByRole('button', { name: 'Reconcile the original action' }));
  await canvas.findByText('A new section revision was saved. The previous revision is preserved.', { selector: '.er-status > span' });
  const completedRoot = canvas.getByRole('button', { name: 'Read acceptance status' }).closest<HTMLElement>('section');
  if (!completedRoot) throw new Error('Completed report root absent');
  await announcementUntil(() => paneAnnouncement(completedRoot).textContent === 'A new section revision was saved. The previous revision is preserved.');
  await canvas.findByText('Opened child revision 2');
};
