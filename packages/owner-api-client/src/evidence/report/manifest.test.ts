import { describe, expect, it, vi } from 'vitest';
import type { ArtifactRevision } from '@eliotr/contracts';
import { createManifestApi, type ManifestPorts } from './manifest';

/** Characterization of the legacy artifact manifest read and decoder, frozen before the move. */

const artifactRef = { id: 'art-one', revision: 3 };
const sectionRef = { id: 'sec-one', revision: 7 };
const specRef = { id: 'spec-one', revision: 1 };
const freezeRef = { id: 'freeze-one', revision: 2 };
const originalScopeRef = { id: 'scope-original', revision: 4 };
const authorizationScopeRef = { id: 'scope-auth', revision: 5 };
const generation = 'dep-1';
const digest = 'a'.repeat(64);
const createdAt = '2026-10-09T12:00:00.000Z';
const authorization = {
  authorization_receipt_ref: 'auth-receipt-one',
  policy_authority_ref: 'policy-authority-one',
  allowed_use: ['research'],
  disclosure_ceiling: 'internal',
  expires_at: '2026-10-10T12:00:00.000Z',
};

const artifact: ArtifactRevision = {
  artifact_ref: artifactRef,
  spec_ref: specRef,
  spec_digest: digest,
  evidence_freeze_ref: freezeRef,
  sections: [{
    section_ref: sectionRef,
    contract_id: 'contract-one',
    body_object_ref: 'obj-one',
    body_sha256: digest,
    statement_labels: {},
    evidence_ledger_ref: 'ledger-one',
    verification_receipt_ref: 'receipt-one',
  }],
  dependency_manifest_ref: 'deps-one',
  deterministic_export_refs: { markdown: 'export-one' },
  status: 'DRAFT',
  created_at: createdAt,
};

// The envelope is a typed wire shape, so the helper builds a concrete record instead of spreading an
// unknown value the compiler cannot widen.
const envelopeOf = (data: unknown): unknown => ({
  data,
  trace_id: 'trace-one',
  deployment_generation: generation,
});

const envelopeWith = (data: unknown, extra: Readonly<Record<string, unknown>>): unknown => ({
  data,
  trace_id: 'trace-one',
  deployment_generation: generation,
  ...extra,
});

interface Harness {
  readonly api: ReturnType<typeof createManifestApi>;
  readonly calls: unknown[];
}

const harness = (raw: unknown, options: { readonly current?: boolean } = {}): Harness => {
  const calls: unknown[] = [];
  const errors = (details: { code: string; status: number; message: string }) =>
    Object.assign(new Error(details.message), {
      code: details.code, status: details.status, traceId: null, retryable: false,
    });
  const http = {
    requestApi: vi.fn(async (path: string, init: RequestInit | undefined) => {
      calls.push({ path, method: init?.method });
      return raw;
    }),
  };
  const current = options.current ?? true;
  const epoch = {
    capture: () => (current ? { stamp: 'live' } : undefined),
    isCurrent: () => current,
  };
  const ports = { http: http as never, errors, epoch } as unknown as ManifestPorts;
  return { api: createManifestApi(ports), calls };
};

const failureOf = async (promise: Promise<unknown>): Promise<{ code: string; status: number }> => {
  try {
    await promise;
  } catch (error) {
    return { code: String((error as { code: unknown }).code),
      status: Number((error as { status: unknown }).status) };
  }
  throw new Error('expected a typed failure');
};

describe('readResearchArtifact', () => {
  it('returns the artifact when the envelope identity matches', async () => {
    const { api, calls } = harness(envelopeOf(artifact));
    const result = await api.readResearchArtifact(artifactRef);
    expect(result).toEqual(artifact);
    expect(calls).toEqual([{
      path: `/api/v1/research/artifact/${artifactRef.id}%3A${artifactRef.revision}`,
      method: 'GET',
    }]);
  });

  it('rejects an identity that does not match the requested ref', async () => {
    const other = { ...artifact, artifact_ref: { id: 'art-other', revision: 9 } };
    const { api } = harness(envelopeOf(other));
    expect(await failureOf(api.readResearchArtifact(artifactRef)))
      .toMatchObject({ code: 'RESEARCH_RUN_RESPONSE_INVALID', status: 502 });
  });

  it('rejects a generation change as a retryable conflict', async () => {
    const { api } = harness(envelopeOf(artifact));
    expect(await failureOf(api.readResearchArtifact(artifactRef, { expectedDeploymentGeneration: 'dep-2' })))
      .toMatchObject({ code: 'RESEARCH_RUN_DEPLOYMENT_CHANGED', status: 409 });
  });

  it('rejects an envelope with an unknown field', async () => {
    const { api } = harness(envelopeWith(artifact, { extra: 'x' }));
    expect(await failureOf(api.readResearchArtifact(artifactRef)))
      .toMatchObject({ code: 'RESEARCH_RUN_RESPONSE_INVALID', status: 502 });
  });

  it('rejects an artifact row the strict schema does not accept', async () => {
    const broken = { ...artifact, status: 'ARCHIVED' };
    const { api } = harness(envelopeOf(broken));
    expect(await failureOf(api.readResearchArtifact(artifactRef)))
      .toMatchObject({ code: 'RESEARCH_RUN_RESPONSE_INVALID', status: 502 });
  });
});

describe('readReauthorizedResearchArtifact', () => {
  const reauthorizedBase = {
    protocol: 'eliotr.artifact-draft-reauthorization.v1',
    artifact_ref: artifactRef,
    artifact,
    original_scope_snapshot_ref: originalScopeRef,
    authorization_scope_snapshot_ref: authorizationScopeRef,
    authorization,
    deployment_generation: generation,
  };

  it('returns the v1 draft without source freshness', async () => {
    const { api, calls } = harness(envelopeOf(reauthorizedBase));
    const result = await api.readReauthorizedResearchArtifact(artifactRef);
    expect(result.protocol).toBe('eliotr.artifact-draft-reauthorization.v1');
    expect(result.artifact).toEqual(artifact);
    expect(result.source_freshness).toEqual({ state: 'UNKNOWN', changed_sources: [] });
    expect(calls).toEqual([{
      path: `/api/v1/research/artifact/${artifactRef.id}%3A${artifactRef.revision}/reauthorize`,
      method: 'POST',
    }]);
  });

  it('accepts v2 with a current source freshness row', async () => {
    const raw = {
      ...reauthorizedBase,
      protocol: 'eliotr.artifact-draft-reauthorization.v2',
      source_freshness: {
        state: 'CURRENT_REVISIONS',
        checked_at: createdAt,
        changed_sources: [],
      },
    };
    const { api } = harness(envelopeOf(raw));
    const result = await api.readReauthorizedResearchArtifact(artifactRef);
    expect(result.protocol).toBe('eliotr.artifact-draft-reauthorization.v2');
    expect(result.source_freshness.state).toBe('CURRENT_REVISIONS');
  });

  it('rejects v1 that carries source freshness', async () => {
    const raw = {
      ...reauthorizedBase,
      source_freshness: { state: 'UNKNOWN', changed_sources: [] },
    };
    const { api } = harness(envelopeOf(raw));
    expect(await failureOf(api.readReauthorizedResearchArtifact(artifactRef)))
      .toMatchObject({ code: 'RESEARCH_RUN_RESPONSE_INVALID', status: 502 });
  });

  it('rejects a generation mismatch between envelope and data', async () => {
    const raw = { ...reauthorizedBase, deployment_generation: 'dep-other' };
    const { api } = harness(envelopeOf(raw));
    expect(await failureOf(api.readReauthorizedResearchArtifact(artifactRef)))
      .toMatchObject({ code: 'RESEARCH_RUN_RESPONSE_INVALID', status: 502 });
  });

  it('rejects a reauthorized identity that does not match the request', async () => {
    const raw = { ...reauthorizedBase, artifact_ref: { id: 'art-other', revision: 8 } };
    const { api } = harness(envelopeOf(raw));
    expect(await failureOf(api.readReauthorizedResearchArtifact(artifactRef)))
      .toMatchObject({ code: 'RESEARCH_RUN_RESPONSE_INVALID', status: 502 });
  });

  it('rejects a non-DRAFT reauthorized artifact', async () => {
    const raw = { ...reauthorizedBase, artifact: { ...artifact, status: 'ACCEPTED' } };
    const { api } = harness(envelopeOf(raw));
    expect(await failureOf(api.readReauthorizedResearchArtifact(artifactRef)))
      .toMatchObject({ code: 'RESEARCH_RUN_RESPONSE_INVALID', status: 502 });
  });

  it('rejects an unknown authorization field', async () => {
    const raw = { ...reauthorizedBase, authorization: { ...authorization, extra: 'x' } };
    const { api } = harness(envelopeOf(raw));
    expect(await failureOf(api.readReauthorizedResearchArtifact(artifactRef)))
      .toMatchObject({ code: 'RESEARCH_RUN_RESPONSE_INVALID', status: 502 });
  });
});

describe('manifest epoch fence', () => {
  it('does not dispatch when the captured session is already closed', async () => {
    const { api, calls } = harness(envelopeOf(artifact), { current: false });
    expect(await failureOf(api.readResearchArtifact(artifactRef)))
      .toMatchObject({ code: 'API_SESSION_CLOSED', status: 503 });
    expect(calls).toHaveLength(0);
  });
});
