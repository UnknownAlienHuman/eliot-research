import { describe, expect, it, vi } from 'vitest';
import type { ArtifactRevision, ArtifactSectionResponse, ResearchArtifactDraftReauthorizationView,
  ReauthorizedSectionCitationsView, VerifiedEvidence } from '@eliotr/owner-api-client';
import { createPrivacyController } from '../app/privacy';
import { createWorkspaceRuntime } from '../app/runtime';
import { createWorkspaceQueryClient } from './client';
import { reportQueryOptions } from './reports';

const stamp = '2026-10-09T12:00:00.000Z', digest = 'a'.repeat(64);
const section = { section_ref: { id: 'section-1', revision: 1 }, contract_id: 'summary',
  body_object_ref: 'body-1', body_sha256: digest, statement_labels: {},
  evidence_ledger_ref: 'ledger', verification_receipt_ref: 'verified-section' };
const artifact: ArtifactRevision = { artifact_ref: { id: 'report', revision: 1 },
  spec_ref: { id: 'spec', revision: 1 }, spec_digest: digest, evidence_freeze_ref: { id: 'freeze', revision: 1 },
  sections: [section], dependency_manifest_ref: 'dependencies', deterministic_export_refs: {}, status: 'DRAFT', created_at: stamp };
const savedScope = { id: 'saved-scope', revision: 1 };
const grant = { authorization_receipt_ref: 'grant-1', policy_authority_ref: 'policy',
  allowed_use: ['research'], disclosure_ceiling: 'PRIVATE', expires_at: '2027-01-01T00:00:00.000Z' };
const view: ResearchArtifactDraftReauthorizationView = { protocol: 'eliotr.artifact-draft-reauthorization.v2',
  artifact_ref: artifact.artifact_ref, artifact, original_scope_snapshot_ref: savedScope,
  authorization_scope_snapshot_ref: { id: 'scope-grant-1', revision: 1 }, authorization: grant,
  source_freshness: { state: 'UNKNOWN', changed_sources: [] }, deployment_generation: 'deployment' };
const sectionBytes: ArtifactSectionResponse = { artifact_ref: artifact.artifact_ref, ...section,
  size_bytes: 4, bytes: new TextEncoder().encode('body') };

async function fixture() {
  const timers = { setTimeout: () => 0, clearTimeout() {} }, now = () => Date.parse(stamp);
  const privacy = createPrivacyController({ timers, now, mask() {}, reveal() {}, cancelReads() {}, clearProtected() {},
    async verify() { return { principal: 'owner', credentialGeneration: 'credential', deploymentGeneration: 'deployment',
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
  const held = { artifact };
  const client = createWorkspaceQueryClient();
  const options = () => reportQueryOptions(bound, privacy, snapshot.context, () => held.artifact);
  const close = () => { runtime.dispose(); privacy.dispose(); client.clear(); };
  return { bound, held, client, options, close };
}

describe('protected report reads', () => {
  it('refuses identical-ref replacement holders before and after a section read', async () => {
    const test = await fixture();
    try {
      const read = vi.fn(async () => sectionBytes);
      vi.spyOn(test.bound.evidence.sections, 'readResearchArtifactSection').mockImplementation(read);
      const options = test.options().section(artifact, section);
      test.held.artifact = { ...artifact };
      await expect(test.client.fetchQuery(options)).rejects.toThrow('no longer the current manifest');
      expect(read).not.toHaveBeenCalled();
      test.held.artifact = artifact;
      read.mockImplementationOnce(async () => { test.held.artifact = { ...artifact }; return sectionBytes; });
      await expect(test.client.fetchQuery(options)).rejects.toThrow('no longer the current manifest');
      expect(read).toHaveBeenCalledTimes(1);
      expect(test.client.getQueryData(options.queryKey)).toBeUndefined();
    } finally { test.close(); }
  });

  it('preserves a citations read independent fresh authorization and refuses a changed saved scope', async () => {
    const test = await fixture();
    try {
      const fresh: ReauthorizedSectionCitationsView = { protocol: 'eliotr.artifact-draft-citations-reauthorization.v1',
        artifact_ref: artifact.artifact_ref, section_ref: section.section_ref, verification_receipt_ref: section.verification_receipt_ref,
        original_scope_snapshot_ref: savedScope, authorization_scope_snapshot_ref: { id: 'scope-grant-2', revision: 2 },
        authorization: { authorization_receipt_ref: 'grant-2', principal_ref: 'owner',
          credential_generation: 'credential', scope_snapshot_ref: { id: 'scope-grant-2', revision: 2 } },
        deployment_generation: 'deployment', semantic_verification: 'NOT_EXECUTED', cited_evidence: [] };
      const read = vi.fn(async () => fresh);
      vi.spyOn(test.bound.evidence.reauthorization, 'readReauthorizedSectionCitations').mockImplementation(read);
      const options = test.options().reauthorizedCitations(view, section);
      expect(await test.client.fetchQuery(options)).toBe(fresh);
      expect(read).toHaveBeenCalledWith(artifact.artifact_ref, section.section_ref, 'deployment', expect.any(AbortSignal), 'verified-section');
      expect(fresh.authorization).not.toEqual(view.authorization);
      read.mockResolvedValueOnce({ ...fresh, original_scope_snapshot_ref: { id: 'foreign-saved-scope', revision: 1 } });
      await expect(test.client.fetchQuery(options)).rejects.toThrow('changed the original saved scope');
      expect(test.client.getQueryState(options.queryKey)?.status).toBe('error');
    } finally { test.close(); }
  });

  it('never caches an opened excerpt whose decoded digest differs from its citation', async () => {
    const test = await fixture();
    try {
      const wrong = 'b'.repeat(64), handleRef = { id: 'handle', revision: 1 };
      const opened: VerifiedEvidence = { text: 'body', handleRef, excerptSha256: wrong, verificationReceiptRef: 'readback',
        evidence: { handle: { handle_ref: handleRef, source_namespace_id: 'namespace', source_owner_generation: 'owner-generation',
          source_revision_ref: 'source-revision', scope_snapshot_ref: savedScope,
          anchor: { kind: 'normalized_byte_range', start: 0, end: 4 }, excerpt_sha256: wrong, excerpt_byte_length: 4,
          object_residency_key_digest: digest, source_assurance_ceiling: 'EXACT', materializer_assurance_ceiling: 'EXACT',
          terminal_state: 'LIVE', created_at: stamp }, exact_excerpt: 'body', verification_receipt_ref: 'readback',
          authorization_receipt_ref: 'evidence-grant', credential_generation: 'credential',
          source_revision_content_sha256: digest, scope_snapshot_digest: digest, instruction_taint: 'UNTRUSTED',
          allowed_effects: 'READ_ONLY', resolved_at: stamp } };
      const read = vi.fn(async () => opened);
      vi.spyOn(test.bound.evidence.bytes, 'verifyAndOpenEvidence').mockImplementation(read);
      const options = test.options().evidence(savedScope, { handle_ref: handleRef, excerpt_sha256: digest });
      await expect(test.client.fetchQuery(options)).rejects.toThrow('differs from the cited excerpt digest');
      expect(read).toHaveBeenCalledTimes(1);
      expect(test.client.getQueryData(options.queryKey)).toBeUndefined();
    } finally { test.close(); }
  });
});
