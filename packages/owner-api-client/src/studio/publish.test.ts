import { describe, expect, it } from 'vitest';

import { createSessionEpoch } from '../transport/session/epoch';
import type { LegacyErrorFactory } from '../legacy/http';
import { createWikiPublishApi, type WikiPublishDependencies } from './publish';

const GENERATION = 'deploy-1';
const DIGEST = 'a'.repeat(64);
const PROPOSAL = { id: 'proposal-1', revision: 1 };
const PAGE = { id: 'page-1', revision: 3 };

const errors: LegacyErrorFactory = (detail) => new Error(`${detail.code}:${detail.status}`);

interface RecordedCall { readonly path: string; readonly init: RequestInit | undefined }

function recorder(response: unknown): {
  readonly deps: Omit<WikiPublishDependencies, 'epoch'>;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    deps: {
      errors,
      http: {
        requestApi(path: string, init?: RequestInit) {
          calls.push({ path, init });
          return Promise.resolve(response);
        },
      },
    },
  };
}

function api(extra: Partial<Omit<WikiPublishDependencies, 'epoch'>>, epoch = createSessionEpoch()) {
  const { deps } = recorder({});
  return createWikiPublishApi({ ...deps, ...extra, epoch });
}

const publishedPage = (overrides: Record<string, unknown> = {}) => {
  // A strict DRAFT page at revision 3 that supersedes the same id at revision 2.
  return {
    page_ref: PAGE,
    page_type: 'Topic' as const,
    title: 'A proposal',
    scope_snapshot_ref: { id: 'scope-1', revision: 1 },
    body_object_ref: 'body-1',
    body_sha256: DIGEST,
    statement_labels: {},
    evidence_map_ref: 'map-1',
    counterposition_refs: [],
    coverage_receipt_ref: { id: 'coverage-1', revision: 1 },
    limitations: [],
    dependency_refs: [],
    generator_generation: 'gen-1',
    status: 'DRAFT' as const,
    supersedes_ref: { id: 'page-1', revision: 2 },
    publication_metadata: {},
    created_at: '2026-10-03T12:00:00.000Z',
    ...overrides,
  };
};

const publicationEnvelope = (overrides: Record<string, unknown> = {}) => ({
  data: {
    protocol: 'eliotr.wiki-publication.v1',
    page_ref: PAGE,
    status: 'PUBLISHED',
    reviewer_ref: 'reviewer-1',
    ...overrides,
  },
  trace_id: 'trace-1',
  deployment_generation: GENERATION,
});

describe('studio wiki publish CAS derivation', () => {
  it('yields the superseding revision for a page above revision 1', () => {
    expect(api({}).expectedWikiHeadRevision(publishedPage())).toBe(2);
  });

  it('yields 0 for a revision-1 page with no supersedes ref', () => {
    const page = publishedPage({
      page_ref: { id: 'page-1', revision: 1 },
      supersedes_ref: undefined,
    });
    expect(api({}).expectedWikiHeadRevision(page)).toBe(0);
  });

  it('rejects a revision-1 page that claims a supersedes ref', () => {
    const page = publishedPage({
      page_ref: { id: 'page-1', revision: 1 },
      supersedes_ref: { id: 'page-1', revision: 0 },
    });
    expect(() => api({}).expectedWikiHeadRevision(page)).toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a supersedes ref that names another id', () => {
    const page = publishedPage({ supersedes_ref: { id: 'other-1', revision: 2 } });
    expect(() => api({}).expectedWikiHeadRevision(page)).toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a supersedes ref that is not exactly one revision below', () => {
    const page = publishedPage({ supersedes_ref: { id: 'page-1', revision: 1 } });
    expect(() => api({}).expectedWikiHeadRevision(page)).toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a page that is not a DRAFT', () => {
    const page = publishedPage({ status: 'PUBLISHED' });
    expect(() => api({}).expectedWikiHeadRevision(page)).toThrow('WIKI_RESPONSE_INVALID:502');
  });
});
describe('studio wiki publish over the seam', () => {
  it('sends the proposal and the derived head revision', async () => {
    const { deps, calls } = recorder(publicationEnvelope());
    const publish = createWikiPublishApi({ ...deps, epoch: createSessionEpoch() });
    const view = await publish.publishWikiProposal(PROPOSAL, PAGE, 2, 'idem-1', GENERATION);
    expect(view.status).toBe('PUBLISHED');
    expect(view.page_ref.id).toBe('page-1');
    expect(calls[0]?.path).toBe('/api/v1/research/wiki/publications');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      proposal_ref: PROPOSAL,
      expected_head_revision: 2,
    });
  });

  it('rejects a head revision that is not below the page revision', async () => {
    const { deps, calls } = recorder(publicationEnvelope());
    const publish = createWikiPublishApi({ ...deps, epoch: createSessionEpoch() });
    await expect(publish.publishWikiProposal(PROPOSAL, PAGE, 3, 'idem-1', GENERATION))
      .rejects.toThrow('WIKI_INPUT_INVALID:400');
    expect(calls).toHaveLength(0);
  });

  it('rejects a publication that names a different page', async () => {
    const { deps } = recorder(publicationEnvelope({ page_ref: { id: 'other-1', revision: 3 } }));
    const publish = createWikiPublishApi({ ...deps, epoch: createSessionEpoch() });
    await expect(publish.publishWikiProposal(PROPOSAL, PAGE, 2, 'idem-1', GENERATION))
      .rejects.toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a publication that is not PUBLISHED', async () => {
    const { deps } = recorder(publicationEnvelope({ status: 'DRAFT' }));
    const publish = createWikiPublishApi({ ...deps, epoch: createSessionEpoch() });
    await expect(publish.publishWikiProposal(PROPOSAL, PAGE, 2, 'idem-1', GENERATION))
      .rejects.toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a foreign deployment generation with 409', async () => {
    const { deps } = recorder(publicationEnvelope());
    const publish = createWikiPublishApi({ ...deps, epoch: createSessionEpoch() });
    await expect(publish.publishWikiProposal(PROPOSAL, PAGE, 2, 'idem-1', 'deploy-2'))
      .rejects.toThrow('WIKI_DEPLOYMENT_CHANGED:409');
  });

  it('rejects a decoded publication produced after the shared epoch advanced', async () => {
    const epoch = createSessionEpoch();
    const { deps } = recorder(publicationEnvelope());
    const publish = createWikiPublishApi({ ...deps, epoch });
    const pending = publish.publishWikiProposal(PROPOSAL, PAGE, 2, 'idem-1', GENERATION);
    epoch.advance();
    await expect(pending).rejects.toThrow('API_SESSION_CLOSED:503');
  });

  it('refuses to publish against an already-closed session', async () => {
    const epoch = createSessionEpoch();
    epoch.close();
    const { deps, calls } = recorder(publicationEnvelope());
    const publish = createWikiPublishApi({ ...deps, epoch });
    await expect(publish.publishWikiProposal(PROPOSAL, PAGE, 2, 'idem-1', GENERATION))
      .rejects.toThrow('API_SESSION_CLOSED:503');
    expect(calls).toHaveLength(0);
  });
});
