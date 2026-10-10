import { describe, expect, it } from 'vitest';

import { createSessionEpoch } from '../transport/session/epoch';
import type { LegacyBytesResponse, LegacyErrorFactory } from '../legacy/http';
import { createWikiReadApi, type WikiReadDependencies } from './wiki-read';
import { unavailableManifest, type StudioCollaborators } from './collaborators';

const GENERATION = 'deploy-1';
const PROPOSAL = { id: 'proposal-1', revision: 1 };
const PAGE = { id: 'page-1', revision: 1 };
const DIGEST = 'a'.repeat(64);

const errors: LegacyErrorFactory = (detail) => new Error(`${detail.code}:${detail.status}`);

const collaborators: StudioCollaborators = {
  digestBytes: () => Promise.resolve(DIGEST),
  manifest: unavailableManifest(),
};

interface RecordedCall {
  readonly path: string;
  readonly init: RequestInit | undefined;
  readonly maximumBytes: number | undefined;
  readonly contentType: string | undefined;
}

function recorder(response: unknown, bytesResponse?: LegacyBytesResponse): {
  readonly deps: Omit<WikiReadDependencies, 'epoch'>;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    deps: {
      errors,
      collaborators,
      http: {
        requestApi(path: string, init?: RequestInit) {
          calls.push({ path, init, maximumBytes: undefined, contentType: undefined });
          return Promise.resolve(response);
        },
        requestApiBytes(path: string, _signal?: AbortSignal, maximumBytes?: number, expectedContentType?: string) {
          calls.push({ path, init: undefined, maximumBytes, contentType: expectedContentType });
          return Promise.resolve(bytesResponse ?? { bytes: new Uint8Array(), headers: new Headers() });
        },
      },
    },
  };
}

function api(extra: Partial<Omit<WikiReadDependencies, 'epoch'>>, epoch = createSessionEpoch()) {
  const { deps } = recorder({});
  return createWikiReadApi({ ...deps, ...extra, epoch });
}

const listEnvelope = (items: unknown[] = [], hasMore = false) => ({
  data: { protocol: 'eliotr.wiki-proposals.v1', items, has_more: hasMore },
  trace_id: 'trace-1',
  deployment_generation: GENERATION,
});

const summary = {
  proposal_ref: PROPOSAL,
  page_ref: PAGE,
  title: 'A proposal',
  page_type: 'Topic',
  risk_class: 'D2_ANALYTICAL',
  state: 'PROPOSED',
  created_at: '2026-10-03T12:00:00.000Z',
};

const page = {
  page_ref: PAGE,
  page_type: 'Topic',
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
  status: 'DRAFT',
  publication_metadata: {},
  created_at: '2026-10-03T12:00:00.000Z',
};

function bodyHeaders(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    'x-eliotr-wiki-proposal-ref': encodeURIComponent('proposal-1:1'),
    'x-eliotr-wiki-page-ref': encodeURIComponent('page-1:1'),
    'x-eliotr-deployment-generation': GENERATION,
    'x-eliotr-body-sha256': DIGEST,
    ...overrides,
  });
}

describe('studio wiki list decoder', () => {
  it('rejects duplicate proposals', () => {
    const read = api({});
    const envelope = listEnvelope([summary, summary]);
    expect(() => read.decodeWikiProposalList(envelope)).toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('enforces the proposal page bound', () => {
    const read = api({});
    const many = Array.from({ length: 21 }, (_, index) => ({
      ...summary,
      proposal_ref: { id: `proposal-${index}`, revision: 1 },
    }));
    expect(() => read.decodeWikiProposalList(listEnvelope(many))).toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a read protocol that is neither v1 nor v2', () => {
    const read = api({});
    const envelope = {
      data: { protocol: 'eliotr.wiki-proposal-read.v3', proposal_ref: PROPOSAL, page, risk_class: 'D2_ANALYTICAL', state: 'PROPOSED' },
      trace_id: 'trace-1',
      deployment_generation: GENERATION,
    };
    expect(() => read.decodeWikiProposalRead(envelope)).toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a v1 body that carries source freshness', () => {
    const read = api({});
    const envelope = {
      data: {
        protocol: 'eliotr.wiki-proposal-read.v1',
        proposal_ref: PROPOSAL,
        page,
        risk_class: 'D2_ANALYTICAL',
        state: 'PROPOSED',
        source_freshness: { state: 'UNKNOWN', checked_at: '2026-10-03T12:00:00.000Z', changed_sources: [] },
      },
      trace_id: 'trace-1',
      deployment_generation: GENERATION,
    };
    expect(() => read.decodeWikiProposalRead(envelope)).toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a foreign deployment generation with 409', () => {
    const read = api({});
    expect(() => read.decodeWikiProposalList(listEnvelope([summary]), 'deploy-2'))
      .toThrow('WIKI_DEPLOYMENT_CHANGED:409');
  });
});
describe('studio wiki reads over the seam', () => {
  it('requests the proposal list and returns the decoded view', async () => {
    const { deps, calls } = recorder(listEnvelope([summary]));
    const read = createWikiReadApi({ ...deps, epoch: createSessionEpoch() });
    const view = await read.readWikiProposals(GENERATION);
    expect(view.items).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/v1/research/wiki/proposals');
  });

  it('requests a single proposal by encoded id', async () => {
    const envelope = {
      data: { protocol: 'eliotr.wiki-proposal-read.v1', proposal_ref: PROPOSAL, page, risk_class: 'D2_ANALYTICAL', state: 'PROPOSED' },
      trace_id: 'trace-1',
      deployment_generation: GENERATION,
    };
    const { deps, calls } = recorder(envelope);
    const read = createWikiReadApi({ ...deps, epoch: createSessionEpoch() });
    const view = await read.readWikiProposal(PROPOSAL, GENERATION);
    expect(view.proposal_ref.id).toBe('proposal-1');
    expect(calls[0]?.path).toBe('/api/v1/research/wiki/proposals/proposal-1');
  });

  it('rejects a decoded read whose identity differs from the request', async () => {
    const envelope = {
      data: { protocol: 'eliotr.wiki-proposal-read.v1', proposal_ref: { id: 'other', revision: 1 }, page, risk_class: 'D2_ANALYTICAL', state: 'PROPOSED' },
      trace_id: 'trace-1',
      deployment_generation: GENERATION,
    };
    const { deps } = recorder(envelope);
    const read = createWikiReadApi({ ...deps, epoch: createSessionEpoch() });
    await expect(read.readWikiProposal(PROPOSAL, GENERATION)).rejects.toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a proposal revision that is not 1', async () => {
    const { deps, calls } = recorder(listEnvelope([summary]));
    const read = createWikiReadApi({ ...deps, epoch: createSessionEpoch() });
    await expect(read.readWikiProposal({ id: 'proposal-1', revision: 2 }, GENERATION))
      .rejects.toThrow('WIKI_INPUT_INVALID:400');
    expect(calls).toHaveLength(0);
  });

  it('reads a verified body through the byte seam with the real bound and content type', async () => {
    const text = 'A verified body.';
    const bytes = new TextEncoder().encode(text);
    const { deps, calls } = recorder({}, {
      bytes,
      headers: bodyHeaders({ 'content-length': String(bytes.byteLength) }),
    });
    const read = createWikiReadApi({ ...deps, epoch: createSessionEpoch() });
    const view = await read.readWikiProposalBody(PROPOSAL, PAGE, DIGEST, GENERATION);
    expect(view.text).toBe(text);
    expect(view.byte_length).toBe(bytes.byteLength);
    expect(calls[0]?.path).toBe('/api/v1/research/wiki/proposals/proposal-1/body');
    expect(calls[0]?.maximumBytes).toBe(8 * 1024 * 1024);
    expect(calls[0]?.contentType).toBe('text/plain');
  });

  it('rejects a body whose declared digest differs from the expected digest', async () => {
    const bytes = new TextEncoder().encode('A body.');
    const { deps } = recorder({}, { bytes, headers: bodyHeaders() });
    const read = createWikiReadApi({ ...deps, epoch: createSessionEpoch() });
    await expect(read.readWikiProposalBody(PROPOSAL, PAGE, 'b'.repeat(64), GENERATION))
      .rejects.toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a body whose re-hash differs from its declared digest', async () => {
    const bytes = new TextEncoder().encode('A body.');
    const mismatched: StudioCollaborators = {
      digestBytes: () => Promise.resolve('c'.repeat(64)),
      manifest: unavailableManifest(),
    };
    const read = createWikiReadApi({
      http: {
        requestApi: () => Promise.resolve({}),
        requestApiBytes: () => Promise.resolve({ bytes, headers: bodyHeaders() }),
      },
      errors,
      collaborators: mismatched,
      epoch: createSessionEpoch(),
    });
    await expect(read.readWikiProposalBody(PROPOSAL, PAGE, DIGEST, GENERATION))
      .rejects.toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a body whose identity headers name another proposal', async () => {
    const bytes = new TextEncoder().encode('A body.');
    const { deps } = recorder({}, {
      bytes,
      headers: bodyHeaders({ 'x-eliotr-wiki-proposal-ref': encodeURIComponent('other:1') }),
    });
    const read = createWikiReadApi({ ...deps, epoch: createSessionEpoch() });
    await expect(read.readWikiProposalBody(PROPOSAL, PAGE, DIGEST, GENERATION))
      .rejects.toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a body whose deployment generation is stale with 409', async () => {
    const bytes = new TextEncoder().encode('A body.');
    const { deps } = recorder({}, {
      bytes,
      headers: bodyHeaders({ 'x-eliotr-deployment-generation': 'deploy-2' }),
    });
    const read = createWikiReadApi({ ...deps, epoch: createSessionEpoch() });
    await expect(read.readWikiProposalBody(PROPOSAL, PAGE, DIGEST, GENERATION))
      .rejects.toThrow('WIKI_DEPLOYMENT_CHANGED:409');
  });

  it('rejects an expected digest that is not a SHA-256 before any request', async () => {
    const { deps, calls } = recorder({}, { bytes: new Uint8Array(), headers: bodyHeaders() });
    const read = createWikiReadApi({ ...deps, epoch: createSessionEpoch() });
    await expect(read.readWikiProposalBody(PROPOSAL, PAGE, 'not-a-digest', GENERATION))
      .rejects.toThrow('WIKI_INPUT_INVALID:400');
    expect(calls).toHaveLength(0);
  });

  it('rejects a decoded body produced after the shared epoch advanced', async () => {
    const bytes = new TextEncoder().encode('A body.');
    const epoch = createSessionEpoch();
    const { deps } = recorder({}, { bytes, headers: bodyHeaders() });
    const read = createWikiReadApi({ ...deps, epoch });
    const pending = read.readWikiProposalBody(PROPOSAL, PAGE, DIGEST, GENERATION);
    epoch.advance();
    await expect(pending).rejects.toThrow('API_SESSION_CLOSED:503');
  });

  it('refuses to start any read against an already-closed session', async () => {
    const epoch = createSessionEpoch();
    epoch.close();
    const { deps, calls } = recorder(listEnvelope([summary]));
    const read = createWikiReadApi({ ...deps, epoch });
    await expect(read.readWikiProposals(GENERATION)).rejects.toThrow('API_SESSION_CLOSED:503');
    expect(calls).toHaveLength(0);
  });
});
