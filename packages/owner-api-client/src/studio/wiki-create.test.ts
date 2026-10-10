import { describe, expect, it } from 'vitest';

import { createSessionEpoch } from '../transport/session/epoch';
import type { LegacyErrorFactory } from '../legacy/http';
import { createWikiCreateApi, type WikiCreateDependencies } from './wiki-create';

const GENERATION = 'deploy-1';
const PROPOSAL = { id: 'proposal-1', revision: 1 };

const errors: LegacyErrorFactory = (detail) => new Error(`${detail.code}:${detail.status}`);

interface RecordedCall { readonly path: string; readonly init: RequestInit | undefined }

function recorder(response: unknown): {
  readonly deps: Omit<WikiCreateDependencies, 'epoch'>;
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

const proposalEnvelope = (overrides: Record<string, unknown> = {}, envelopeOverrides: Record<string, unknown> = {}) => ({
  data: {
    protocol: 'eliotr.wiki-proposal.v1',
    proposal_ref: PROPOSAL,
    page_ref: { id: 'page-1', revision: 2 },
    risk_class: 'D2_ANALYTICAL',
    state: 'PROPOSED',
    ...overrides,
  },
  trace_id: 'trace-1',
  deployment_generation: GENERATION,
  ...envelopeOverrides,
});

describe('studio wiki create from run', () => {
  it('sends exactly the operation id with an idempotency key', async () => {
    const { deps, calls } = recorder(proposalEnvelope());
    const create = createWikiCreateApi({ ...deps, epoch: createSessionEpoch() });
    const view = await create.createWikiProposalFromRun('operation-1', 'idem-1', GENERATION);
    expect(view.state).toBe('PROPOSED');
    expect(calls[0]?.path).toBe('/api/v1/research/wiki/proposals/from-run');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ operation_id: 'operation-1' });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('idem-1');
  });

  it('rejects a foreign deployment generation with 409', async () => {
    // The generation fence reads the envelope field, so a foreign generation lives there.
    const { deps } = recorder(proposalEnvelope({}, { deployment_generation: 'deploy-2' }));
    const create = createWikiCreateApi({ ...deps, epoch: createSessionEpoch() });
    await expect(create.createWikiProposalFromRun('operation-1', 'idem-1', GENERATION))
      .rejects.toThrow('WIKI_DEPLOYMENT_CHANGED:409');
  });

  it('rejects a response that is not PROPOSED', async () => {
    const { deps } = recorder(proposalEnvelope({ state: 'PUBLISHED' }));
    const create = createWikiCreateApi({ ...deps, epoch: createSessionEpoch() });
    await expect(create.createWikiProposalFromRun('operation-1', 'idem-1', GENERATION))
      .rejects.toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a decoded result produced after the shared epoch advanced', async () => {
    const epoch = createSessionEpoch();
    const { deps } = recorder(proposalEnvelope());
    const create = createWikiCreateApi({ ...deps, epoch });
    const pending = create.createWikiProposalFromRun('operation-1', 'idem-1', GENERATION);
    epoch.advance();
    await expect(pending).rejects.toThrow('API_SESSION_CLOSED:503');
  });
});

describe('studio wiki create from edit', () => {
  const baseProposal = { id: 'proposal-1', revision: 1 };
  const basePage = { id: 'page-1', revision: 1 };

  it('sends the base lineage, the expected head revision and the sanitized edit', async () => {
    const { deps, calls } = recorder(proposalEnvelope());
    const create = createWikiCreateApi({ ...deps, epoch: createSessionEpoch() });
    await create.createWikiEditProposal(
      baseProposal, basePage, 1, 'A title', 'A body.', 'A note.', GENERATION, 'idem-2',
    );
    expect(calls[0]?.path).toBe('/api/v1/research/wiki/proposals/from-edit');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      base_proposal_ref: baseProposal,
      expected_head_revision: 1,
      title: 'A title',
      body_text: 'A body.',
      edit_note: 'A note.',
    });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['x-eliotr-csrf']).toBe('1');
  });

  it('rejects an expected head revision that does not match the base page', async () => {
    const { deps, calls } = recorder(proposalEnvelope());
    const create = createWikiCreateApi({ ...deps, epoch: createSessionEpoch() });
    await expect(create.createWikiEditProposal(
      baseProposal, basePage, 5, 'A title', 'A body.', 'A note.', GENERATION, 'idem-2',
    )).rejects.toThrow('WIKI_INPUT_INVALID:400');
    expect(calls).toHaveLength(0);
  });

  it('rejects a decoded page that is not exactly one revision above the base', async () => {
    // Copy-on-write proof: a same-revision result would read as an in-place overwrite.
    const { deps } = recorder(proposalEnvelope({ page_ref: { id: 'page-1', revision: 1 } }));
    const create = createWikiCreateApi({ ...deps, epoch: createSessionEpoch() });
    await expect(create.createWikiEditProposal(
      baseProposal, basePage, 1, 'A title', 'A body.', 'A note.', GENERATION, 'idem-2',
    )).rejects.toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a decoded page that belongs to another page id', async () => {
    const { deps } = recorder(proposalEnvelope({ page_ref: { id: 'other-1', revision: 2 } }));
    const create = createWikiCreateApi({ ...deps, epoch: createSessionEpoch() });
    await expect(create.createWikiEditProposal(
      baseProposal, basePage, 1, 'A title', 'A body.', 'A note.', GENERATION, 'idem-2',
    )).rejects.toThrow('WIKI_RESPONSE_INVALID:502');
  });

  it('rejects a serialized request that exceeds the 8.5 MiB request ceiling', async () => {
    // The body bound measures raw UTF-8 length while the request ceiling measures the serialized
    // request, and JSON escaping doubles a backslash. A body of backslashes therefore passes the
    // 8 MiB body check and crosses the tighter serialized ceiling, which is the only way that
    // 413 guard becomes reachable.
    const { deps, calls } = recorder(proposalEnvelope());
    const create = createWikiCreateApi({ ...deps, epoch: createSessionEpoch() });
    const body = '\\'.repeat(4_400_000);
    await expect(create.createWikiEditProposal(
      baseProposal, basePage, 1, 'A title', body, '', GENERATION, 'idem-2',
    )).rejects.toThrow('WIKI_INPUT_INVALID:413');
    expect(calls).toHaveLength(0);
  });

  it('rejects a body that exceeds the 8 MiB body bound', async () => {
    const { deps, calls } = recorder(proposalEnvelope());
    const create = createWikiCreateApi({ ...deps, epoch: createSessionEpoch() });
    const body = 'x'.repeat(9 * 1024 * 1024);
    await expect(create.createWikiEditProposal(
      baseProposal, basePage, 1, 'A title', body, '', GENERATION, 'idem-2',
    )).rejects.toThrow('WIKI_INPUT_INVALID:400');
    expect(calls).toHaveLength(0);
  });
});
