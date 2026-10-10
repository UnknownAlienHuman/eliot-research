import { describe, expect, it } from 'vitest';
import type { ArtifactRevision, VersionedRef } from '@eliotr/contracts';
import type { ManifestApi, ResearchArtifactDraftReauthorizationView } from '../evidence/report/manifest';

import { createSessionEpoch } from '../transport/session/epoch';
import type { LegacyErrorFactory } from '../legacy/http';
import { createArtifactApi, type ArtifactDependencies } from './artifact';
import { unavailableManifest, type StudioCollaborators } from './collaborators';

const GENERATION = 'deploy-1';
const DIGEST = 'a'.repeat(64);
const SPEC_DIGEST = 'b'.repeat(64);
const REF = { id: 'artifact-1', revision: 4 };
const CHILD = { id: 'artifact-1', revision: 5 };

const errors: LegacyErrorFactory = (detail) => new Error(`${detail.code}:${detail.status}`);

const collaborators: StudioCollaborators = {
  digestBytes: () => Promise.resolve(DIGEST),
  manifest: unavailableManifest(),
};

interface RecordedCall {
  readonly path: string;
  readonly init: RequestInit | undefined;
  readonly statuses: readonly number[] | undefined;
  readonly timeoutMs: number | undefined;
}

function recorder(response: unknown): {
  readonly deps: Omit<ArtifactDependencies, 'epoch'>;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    deps: {
      errors,
      collaborators,
      http: {
        requestApi(path: string) {
          calls.push({ path, init: undefined, statuses: undefined, timeoutMs: undefined });
          return Promise.resolve(response);
        },
        requestApiWithStatuses(path: string, init: RequestInit | undefined, statuses: readonly number[], timeoutMs?: number) {
          calls.push({ path, init, statuses, timeoutMs });
          return Promise.resolve(response);
        },
      },
    },
  };
}

const revision = (overrides: Record<string, unknown> = {}) => ({
  artifact_ref: REF,
  spec_ref: { id: 'spec-1', revision: 1 },
  spec_digest: SPEC_DIGEST,
  evidence_freeze_ref: { id: 'freeze-1', revision: 1 },
  sections: [],
  dependency_manifest_ref: 'manifest-1',
  deterministic_export_refs: {},
  status: 'ACCEPTED',
  created_at: '2026-10-03T12:00:00.000Z',
  ...overrides,
});

const receipt = {
  publication_ref: 'publication-1',
  artifact_ref: REF,
  publication_revision: 2,
  manifest_sha256: DIGEST,
  verification_set_sha256: DIGEST,
  evidence_currentness_sha256: DIGEST,
  acceptance_decision_ref: 'decision-1',
  acceptance_provenance_ref: 'provenance-1',
  acceptance_decision_sha256: DIGEST,
  principal_ref: 'principal-1',
  authorization_receipt_ref: 'authorization-1',
  created_at: '2026-10-03T12:00:00.000Z',
};

const publicationEnvelope = (overrides: Record<string, unknown> = {}) => ({
  data: {
    protocol: 'eliotr.artifact-publication.v1',
    revision: revision(),
    receipt,
    ...overrides,
  },
  trace_id: 'trace-1',
  deployment_generation: GENERATION,
});

const reviseEnvelope = (overrides: Record<string, unknown> = {}) => ({
  data: {
    protocol: 'eliotr.artifact-section-revise-status.v1',
    operation_id: 'operation-1',
    attempt_ref: 'attempt-1',
    state: 'STARTED',
    parent_artifact_ref: REF,
    section_id: 'section-1',
    disposition: 'CREATED',
    ...overrides,
  },
  trace_id: 'trace-1',
  deployment_generation: GENERATION,
});

describe('studio artifact publication reads', () => {
  it('reads a publication and returns the decoded revision and receipt', async () => {
    const { deps, calls } = recorder(publicationEnvelope());
    const artifact = createArtifactApi({ ...deps, epoch: createSessionEpoch() });
    const view = await artifact.readArtifactPublication(REF, GENERATION);
    expect(view?.revision.status).toBe('ACCEPTED');
    expect(view?.receipt.publication_ref).toBe('publication-1');
    expect(calls[0]?.path).toBe('/api/v1/research/artifact/artifact-1%3A4/publication');
  });

  it('reads the current publication from its own path', async () => {
    const { deps, calls } = recorder(publicationEnvelope());
    const artifact = createArtifactApi({ ...deps, epoch: createSessionEpoch() });
    await artifact.readArtifactPublication(REF, GENERATION, undefined, true);
    expect(calls[0]?.path).toBe('/api/v1/research/artifact/artifact-1%3A4/publication/current');
  });

  it('returns null for a typed missing publication', async () => {
    const notFound: LegacyErrorFactory = () => Object.assign(new Error('missing'), {
      status: 404,
      code: 'ARTIFACT_PUBLICATION_NOT_FOUND',
    });
    const http = {
      requestApi: () => Promise.reject(Object.assign(new Error('missing'), {
        status: 404,
        code: 'ARTIFACT_PUBLICATION_NOT_FOUND',
      })),
      requestApiWithStatuses: () => Promise.resolve({}),
    };
    const withRejection = createArtifactApi({
      http: http as unknown as ArtifactDependencies['http'],
      errors: notFound,
      collaborators,
      epoch: createSessionEpoch(),
    });
    expect(await withRejection.readArtifactPublication(REF, GENERATION)).toBeNull();
  });

  it('rejects a foreign deployment generation with 409', async () => {
    const { deps } = recorder(publicationEnvelope());
    const artifact = createArtifactApi({ ...deps, epoch: createSessionEpoch() });
    await expect(artifact.readArtifactPublication(REF, 'deploy-2'))
      .rejects.toThrow('API_GENERATION_MISMATCH:409');
  });

  it('rejects a decoded publication produced after the shared epoch advanced', async () => {
    const epoch = createSessionEpoch();
    const { deps } = recorder(publicationEnvelope());
    const artifact = createArtifactApi({ ...deps, epoch });
    const pending = artifact.readArtifactPublication(REF, GENERATION);
    epoch.advance();
    await expect(pending).rejects.toThrow('API_SESSION_CLOSED:503');
  });
});
describe('studio artifact accept', () => {
  it('accepts with a compare-and-swap publication revision and a deterministic key', async () => {
    const { deps, calls } = recorder(publicationEnvelope({ disposition: 'EXISTING' }));
    const artifact = createArtifactApi({ ...deps, epoch: createSessionEpoch() });
    const view = await artifact.acceptArtifact(REF, 2, GENERATION);
    expect(view.revision.status).toBe('ACCEPTED');
    expect(calls[0]?.path).toBe('/api/v1/research/artifact/artifact-1%3A4/accept');
    expect(calls[0]?.statuses).toEqual([200, 201]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      protocol: 'eliotr.artifact-publication-accept.v1',
      expected_draft_head_revision: 4,
      expected_publication_revision: 2,
    });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    // The key is deterministic: the same ref and same expected revision reuse one operation identity.
    expect(headers['idempotency-key']).toBe(headers['idempotency-key']);
    expect(headers['idempotency-key']).toMatch(/^artifact-accept-[0-9a-f]+$/);
  });

  it('rejects an accept readback that is not ACCEPTED', async () => {
    const { deps } = recorder(publicationEnvelope({ disposition: 'CREATED', revision: revision({ status: 'DRAFT' }) }));
    const artifact = createArtifactApi({ ...deps, epoch: createSessionEpoch() });
    await expect(artifact.acceptArtifact(REF, null, GENERATION)).rejects.toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('rejects a decoded accept produced after the shared epoch advanced', async () => {
    const epoch = createSessionEpoch();
    const { deps } = recorder(publicationEnvelope({ disposition: 'EXISTING' }));
    const artifact = createArtifactApi({ ...deps, epoch });
    const pending = artifact.acceptArtifact(REF, 2, GENERATION);
    epoch.advance();
    await expect(pending).rejects.toThrow('API_SESSION_CLOSED:503');
  });
});

describe('studio artifact section revise', () => {
  it('sends the section contract and the expected artifact revision', async () => {
    const { deps, calls } = recorder(reviseEnvelope());
    const artifact = createArtifactApi({ ...deps, epoch: createSessionEpoch() });
    const view = await artifact.reviseArtifactSection(REF, 'section-1', GENERATION);
    expect(view.state).toBe('STARTED');
    expect(calls[0]?.path).toBe('/api/v1/research/artifact/artifact-1%3A4/sections/section-1/revise');
    expect(calls[0]?.timeoutMs).toBe(120_000);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      protocol: 'eliotr.artifact-section-revise.v1',
      expected_artifact_revision: 4,
    });
  });

  it('accepts a COMMITTED revise whose child is exactly one revision above', async () => {
    const { deps } = recorder(reviseEnvelope({
      state: 'COMMITTED',
      draft: { artifact_ref: CHILD, manifest_sha256: DIGEST },
    }));
    const artifact = createArtifactApi({ ...deps, epoch: createSessionEpoch() });
    const view = await artifact.reviseArtifactSection(REF, 'section-1', GENERATION);
    expect(view.draft?.artifact_ref.revision).toBe(5);
  });

  it('rejects a COMMITTED revise with no draft at all', async () => {
    const { deps } = recorder(reviseEnvelope({ state: 'COMMITTED' }));
    const artifact = createArtifactApi({ ...deps, epoch: createSessionEpoch() });
    await expect(artifact.reviseArtifactSection(REF, 'section-1', GENERATION))
      .rejects.toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('rejects a non-COMMITTED revise that still claims a draft', async () => {
    const { deps } = recorder(reviseEnvelope({
      draft: { artifact_ref: CHILD, manifest_sha256: DIGEST },
    }));
    const artifact = createArtifactApi({ ...deps, epoch: createSessionEpoch() });
    await expect(artifact.reviseArtifactSection(REF, 'section-1', GENERATION))
      .rejects.toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('rejects a child whose revision is not exactly one above the parent', async () => {
    const { deps } = recorder(reviseEnvelope({
      state: 'COMMITTED',
      draft: { artifact_ref: { id: 'artifact-1', revision: 7 }, manifest_sha256: DIGEST },
    }));
    const artifact = createArtifactApi({ ...deps, epoch: createSessionEpoch() });
    await expect(artifact.reviseArtifactSection(REF, 'section-1', GENERATION))
      .rejects.toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('rejects a child that belongs to a different artifact id', async () => {
    const { deps } = recorder(reviseEnvelope({
      state: 'COMMITTED',
      draft: { artifact_ref: { id: 'other-1', revision: 5 }, manifest_sha256: DIGEST },
    }));
    const artifact = createArtifactApi({ ...deps, epoch: createSessionEpoch() });
    await expect(artifact.reviseArtifactSection(REF, 'section-1', GENERATION))
      .rejects.toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('rejects an unrecognized disposition', async () => {
    const { deps } = recorder(reviseEnvelope({ disposition: 'MAYBE' }));
    const artifact = createArtifactApi({ ...deps, epoch: createSessionEpoch() });
    await expect(artifact.reviseArtifactSection(REF, 'section-1', GENERATION))
      .rejects.toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('rejects a revise that names another parent artifact', async () => {
    const { deps } = recorder(reviseEnvelope({ parent_artifact_ref: { id: 'other-1', revision: 4 } }));
    const artifact = createArtifactApi({ ...deps, epoch: createSessionEpoch() });
    await expect(artifact.reviseArtifactSection(REF, 'section-1', GENERATION))
      .rejects.toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('rejects a decoded revise produced after the shared epoch advanced', async () => {
    const epoch = createSessionEpoch();
    const { deps } = recorder(reviseEnvelope());
    const artifact = createArtifactApi({ ...deps, epoch });
    const pending = artifact.reviseArtifactSection(REF, 'section-1', GENERATION);
    epoch.advance();
    await expect(pending).rejects.toThrow('API_SESSION_CLOSED:503');
  });
});

describe('studio fallback fixtures', () => {
const GENERATION = 'deploy-1';
const DIGEST = 'a'.repeat(64);
const REF: VersionedRef = { id: 'artifact-1', revision: 4 };

const errors: LegacyErrorFactory = (detail) => Object.assign(new Error(`${detail.code}:${detail.status}`), {
  status: detail.status,
  code: detail.code,
});

const collaborators: StudioCollaborators = {
  digestBytes: () => Promise.resolve(DIGEST),
  manifest: {} as ManifestApi,
};

const draft = (): ArtifactRevision => ({
  artifact_ref: REF,
  spec_ref: { id: 'spec-1', revision: 1 },
  spec_digest: DIGEST,
  evidence_freeze_ref: { id: 'freeze-1', revision: 1 },
  sections: [],
  dependency_manifest_ref: 'manifest-1',
  deterministic_export_refs: {},
  status: 'DRAFT',
  created_at: '2026-10-03T12:00:00.000Z',
} as ArtifactRevision);

const reauthorization = (
  overrides: Partial<ResearchArtifactDraftReauthorizationView> = {},
): ResearchArtifactDraftReauthorizationView => ({
  protocol: 'eliotr.artifact-draft-reauthorization.v2',
  artifact_ref: REF,
  artifact: draft(),
  original_scope_snapshot_ref: { id: 'scope-1', revision: 1 },
  authorization_scope_snapshot_ref: { id: 'scope-2', revision: 1 },
  authorization: {
    authorization_receipt_ref: 'auth-receipt-1',
    policy_authority_ref: 'policy-1',
    allowed_use: ['wiki'],
    disclosure_ceiling: 'internal',
    expires_at: '2026-10-04T12:00:00.000Z',
  },
  source_freshness: { state: 'UNKNOWN', changed_sources: [] },
  deployment_generation: GENERATION,
  ...overrides,
});

const publicationEnvelope = (overrides: Record<string, unknown> = {}) => ({
  data: {
    protocol: 'eliotr.artifact-publication.v1',
    revision: draft(),
    receipt: {
      publication_ref: 'publication-1',
      artifact_ref: REF,
      publication_revision: 2,
      manifest_sha256: DIGEST,
      verification_set_sha256: DIGEST,
      evidence_currentness_sha256: DIGEST,
      acceptance_decision_ref: 'decision-1',
      acceptance_provenance_ref: 'provenance-1',
      acceptance_decision_sha256: DIGEST,
      principal_ref: 'principal-1',
      authorization_receipt_ref: 'authorization-1',
      created_at: '2026-10-03T12:00:00.000Z',
    },
    ...overrides,
  },
  trace_id: 'trace-1',
  deployment_generation: GENERATION,
});

interface Calls {
  readonly author: number;
  readonly reauthorized: number;
}

function apiFor(behaviour: {
  readonly author?: (ref: VersionedRef) => Promise<ArtifactRevision>;
  readonly reauthorized?: (ref: VersionedRef) => Promise<ResearchArtifactDraftReauthorizationView>;
}): { readonly open: ReturnType<typeof createArtifactApi>['openRunArtifact']; readonly calls: Calls } {
  let author = 0;
  let reauthorized = 0;
  const manifest: ManifestApi = {
    readResearchArtifact: (ref: VersionedRef) => {
      author += 1;
      return behaviour.author ? behaviour.author(ref) : Promise.resolve(draft());
    },
    readReauthorizedResearchArtifact: (ref: VersionedRef) => {
      reauthorized += 1;
      if (!behaviour.reauthorized) return Promise.resolve(reauthorization());
      return behaviour.reauthorized(ref);
    },
  };
  const deps: ArtifactDependencies = {
    http: {
      requestApi: () => Promise.resolve(publicationEnvelope()),
      requestApiWithStatuses: () => Promise.resolve(publicationEnvelope()),
    },
    errors,
    collaborators: { ...collaborators, manifest },
    epoch: createSessionEpoch(),
  };
  const studio = createArtifactApi(deps);
  return { open: studio.openRunArtifact, calls: { get author() { return author; }, get reauthorized() { return reauthorized; } } };
}

const notFound = Object.assign(new Error('not found'), {
  status: 404,
  code: 'ARTIFACT_DRAFT_READ_NOT_FOUND',
});

const denied = Object.assign(new Error('denied'), {
  status: 403,
  code: 'ARTIFACT_DRAFT_READ_DENIED',
});

describe('studio openRunArtifact legacy two-tier read', () => {
  it('returns the author draft and never attempts a reauthorized read', async () => {
    const { open, calls } = apiFor({});
    const opened = await open(REF, GENERATION);
    expect(opened.artifact.artifact_ref).toEqual(REF);
    expect(opened.reauthorized).toBeUndefined();
    expect(opened.publication).not.toBeNull();
    expect(calls.author).toBe(1);
    expect(calls.reauthorized).toBe(0);
  });

  it('falls back to the independently authorized read on the exact typed 404', async () => {
    const { open, calls } = apiFor({ author: () => Promise.reject(notFound) });
    const opened = await open(REF, GENERATION);
    // A reauthorized read confers neither Wiki nor publication authority; the two remain separate.
    expect(opened.artifact.artifact_ref).toEqual(REF);
    expect(opened.reauthorized?.authorization.authorization_receipt_ref).toBe('auth-receipt-1');
    expect(opened.publication?.receipt.publication_ref).toBe('publication-1');
    expect(calls.author).toBe(1);
    expect(calls.reauthorized).toBe(1);
  });

  it('rethrows a 404 carrying any other code instead of widening the fallback', async () => {
    const other = Object.assign(new Error('other not found'), {
      status: 404,
      code: 'ARTIFACT_PUBLICATION_NOT_FOUND',
    });
    const { open, calls } = apiFor({ author: () => Promise.reject(other) });
    await expect(open(REF, GENERATION)).rejects.toMatchObject({ code: 'ARTIFACT_PUBLICATION_NOT_FOUND' });
    expect(calls.reauthorized).toBe(0);
  });

  it('rethrows a status other than 404 that carries the same code', async () => {
    const otherStatus = Object.assign(new Error('conflict'), {
      status: 409,
      code: 'ARTIFACT_DRAFT_READ_NOT_FOUND',
    });
    const { open, calls } = apiFor({ author: () => Promise.reject(otherStatus) });
    await expect(open(REF, GENERATION)).rejects.toMatchObject({ status: 409 });
    expect(calls.reauthorized).toBe(0);
  });

  it('propagates a denial from the independently authorized read instead of returning a draft', async () => {
    const { open, calls } = apiFor({ author: () => Promise.reject(notFound), reauthorized: () => Promise.reject(denied) });
    await expect(open(REF, GENERATION)).rejects.toMatchObject({ code: 'ARTIFACT_DRAFT_READ_DENIED' });
    expect(calls.author).toBe(1);
    expect(calls.reauthorized).toBe(1);
  });

  it('rejects a reauthorization granted for another artifact', async () => {
    const foreign = reauthorization({
      artifact_ref: { id: 'other-1', revision: 4 },
      artifact: draft(),
    });
    // The collaborator already enforces identity, but studio refuses to surface a grant that names
    // another artifact. A cross-authority grant is never a usable draft.
    const { open } = apiFor({ author: () => Promise.reject(notFound), reauthorized: () => Promise.resolve(foreign) });
    await expect(open(REF, GENERATION)).rejects.toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('rejects an open produced after the shared epoch advanced', async () => {
    let author = 0;
    const manifest: ManifestApi = {
      readResearchArtifact: () => {
        author += 1;
        return Promise.resolve(draft());
      },
      readReauthorizedResearchArtifact: () => Promise.resolve(reauthorization()),
    };
    const epoch = createSessionEpoch();
    const studio = createArtifactApi({
      http: {
        requestApi: () => Promise.resolve(publicationEnvelope()),
        requestApiWithStatuses: () => Promise.resolve(publicationEnvelope()),
      },
      errors,
      collaborators: { ...collaborators, manifest },
      epoch,
    });
    const pending = studio.openRunArtifact(REF, GENERATION);
    epoch.advance();
    await expect(pending).rejects.toThrow('API_SESSION_CLOSED:503');
    expect(author).toBe(1);
  });
});
});
