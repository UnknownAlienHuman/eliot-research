import { describe, expect, it, vi } from 'vitest';
import type { WikiProposalBodyView, WikiProposalReadView } from '@eliotr/owner-api-client';
import { createPrivacyController } from '../app/privacy';
import { createWorkspaceRuntime } from '../app/runtime';
import { createWorkspaceQueryClient } from './client';
import { studioQueryOptions } from './studio';

const stamp = '2026-10-09T12:00:00.000Z', generation = 'deployment', digest = 'a'.repeat(64);
const view: WikiProposalReadView = {
  protocol: 'eliotr.wiki-proposal-read.v2', proposal_ref: { id: 'proposal', revision: 1 },
  page: { page_ref: { id: 'page', revision: 1 }, page_type: 'Topic', title: 'Saved source scope',
    scope_snapshot_ref: { id: 'scope', revision: 1 }, body_object_ref: 'body', body_sha256: digest,
    statement_labels: {}, evidence_map_ref: 'map', counterposition_refs: [],
    coverage_receipt_ref: { id: 'coverage', revision: 1 }, limitations: [], dependency_refs: [],
    generator_generation: 'generator', status: 'DRAFT', publication_metadata: {}, created_at: stamp },
  risk_class: 'D2_ANALYTICAL', state: 'PROPOSED', source_freshness: { state: 'UNKNOWN', changed_sources: [] },
  deployment_generation: generation,
};
const body: WikiProposalBodyView = { text: 'body', body_sha256: digest, byte_length: 4, deployment_generation: generation };

async function fixture() {
  const timers = { setTimeout: () => 0, clearTimeout() {} }, now = () => Date.parse(stamp);
  const privacy = createPrivacyController({ timers, now, mask() {}, reveal() {}, cancelReads() {}, clearProtected() {},
    async verify() { return { principal: 'owner', credentialGeneration: 'credential', deploymentGeneration: generation,
      expiresAt: '2027-01-01T00:00:00.000Z' }; } });
  await privacy.refresh();
  const snapshot = privacy.getSnapshot();
  if (snapshot.phase !== 'available') throw new Error('Fixture session unavailable');
  const runtime = createWorkspaceRuntime({ timers, now, baseUrl: 'https://fixture.invalid',
    fetch: () => Promise.reject(new Error('Unexpected fixture transport')), sha256: () => Promise.resolve(digest),
    mint: () => '11111111-1111-4111-8111-111111111111', isCurrent: context => privacy.isCurrent(context),
    onAuthorizationLoss() { privacy.close(); } });
  runtime.bind(snapshot.context);
  const bound = runtime.read(snapshot.context);
  if (!bound) throw new Error('Fixture runtime unavailable');
  const holder = { proposal: view };
  const client = createWorkspaceQueryClient();
  const options = studioQueryOptions(bound.studio, privacy, snapshot.context, () => holder.proposal);
  const read = vi.spyOn(bound.studio.read, 'readWikiProposalBody').mockResolvedValue(body);
  const close = () => { runtime.dispose(); privacy.dispose(); client.clear(); };
  return { holder, client, options, read, close };
}

describe('Studio body holder identity', () => {
  it('refuses a distinct same-reference proposal before dispatch', async () => {
    const test = await fixture();
    try {
      test.holder.proposal = { ...view };
      await expect(test.client.fetchQuery(test.options.body(view))).rejects.toThrow('exact current proposal');
      expect(test.read).not.toHaveBeenCalled();
    } finally { test.close(); }
  });
  it('refuses a distinct same-reference replacement after the awaited read', async () => {
    const test = await fixture();
    try {
      test.read.mockImplementationOnce(async () => { test.holder.proposal = { ...view }; return body; });
      const options = test.options.body(view);
      await expect(test.client.fetchQuery(options)).rejects.toThrow('changed during the body read');
      expect(test.read).toHaveBeenCalledOnce();
      expect(test.client.getQueryData(options.queryKey)).toBeUndefined();
    } finally { test.close(); }
  });
});
