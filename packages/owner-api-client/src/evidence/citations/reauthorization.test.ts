import { describe, expect, it, vi } from 'vitest';
import { createLegacyHttpAdapter } from '../../legacy/http.js';
import { createSessionEpoch } from '../../transport/session/epoch.js';
import type { SessionEpoch } from '../../transport/session/epoch.js';
import { createResearchRunWire } from '../../research/runs/wire.js';
import { createCitationAuditHelpers } from './audit.js';
import { createCitationApi } from './citations.js';
import { createReauthorizationApi } from './reauthorization.js';
import type { ResearchRunRequest } from '../../research/runs/authority.js';
import type { LegacyErrorDetails, LegacyErrorFactory } from '../../legacy/http.js';
import type { EpochPort } from '../../transport/client.js';

const errors: LegacyErrorFactory = (details: LegacyErrorDetails) =>
  Object.assign(new Error(details.message), details);

const thrown = (run: () => unknown): LegacyErrorDetails & Error => {
  try {
    run();
  } catch (error) {
    return error as LegacyErrorDetails & Error;
  }
  throw new Error('expected the call to throw');
};

const wire = createResearchRunWire(errors);
const audit = createCitationAuditHelpers(errors, wire);
const epoch: EpochPort = { capture: () => ({}), isCurrent: () => true };

const SHA_A = 'a'.repeat(64);
const artifact = { id: 'artifact-1', revision: 1 };
const section = { id: 'section-1', revision: 1 };
const originalScope = { id: 'scope-1', revision: 1 };
const authorizationScope = { id: 'scope-2', revision: 1 };

const row = (originalId: string, freshId: string) => ({
  original_handle_ref: { id: originalId, revision: 1 },
  handle_ref: { id: freshId, revision: 1 },
  excerpt_sha256: SHA_A,
});

const reauthorizedData = (overrides: Record<string, unknown> = {}) => ({
  protocol: 'eliotr.artifact-draft-citations-reauthorization.v1',
  artifact_ref: artifact,
  section_ref: section,
  original_scope_snapshot_ref: originalScope,
  authorization_scope_snapshot_ref: authorizationScope,
  authorization: {
    principal_ref: 'principal-1',
    credential_generation: 'credential-1',
    authorization_receipt_ref: 'auth-1',
    scope_snapshot_ref: authorizationScope,
  },
  deployment_generation: 'dep-1',
  verification_receipt_ref: 'verify-1',
  cited_evidence: [row('handle-1', 'handle-1')],
  semantic_verification: 'NOT_EXECUTED',
  ...overrides,
});

const envelope = (data: Record<string, unknown>) => ({
  data,
  trace_id: 'trace-1',
  deployment_generation: 'dep-1',
});

const build = () => {
  const citations = createCitationApi({
    request: (async () => {
      throw new Error('citation transport unused');
    }) as unknown as ResearchRunRequest,
    errors,
    epoch,
  }, { wire, audit });
  const api = createReauthorizationApi(
    {
      request: (async () => {
        throw new Error('reauthorization transport unused in decode tests');
      }) as unknown as ResearchRunRequest,
      errors,
      epoch,
    },
    {
      wire,
      audit,
      decodeSectionCitations: citations.decodeSectionCitations,
      readSectionCitations: citations.readSectionCitations,
    },
  );
  return { api, citations };
};

describe('C3-EC reauthorized section citations', () => {
  it('decodes the reauthorized family and keeps both scope references distinct', () => {
    const { api } = build();
    const view = api.decodeReauthorizedSectionCitations(envelope(reauthorizedData()), artifact, section, 'dep-1');
    expect(view.original_scope_snapshot_ref).toEqual(originalScope);
    expect(view.authorization_scope_snapshot_ref).toEqual(authorizationScope);
    expect(view.cited_evidence[0]?.handle_ref).toEqual({ id: 'handle-1', revision: 1 });
  });

  it('rejects a protocol that is not the reauthorization literal', () => {
    const { api } = build();
    expect(thrown(() =>
      api.decodeReauthorizedSectionCitations(envelope(reauthorizedData({ protocol: 'other.v1' })), artifact, section),
    ).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('rejects an inner deployment generation that differs from the envelope', () => {
    const { api } = build();
    expect(thrown(() =>
      api.decodeReauthorizedSectionCitations(
        envelope(reauthorizedData({ deployment_generation: 'dep-2' })),
        artifact,
        section,
      ),
    ).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('rejects a duplicate original handle', () => {
    const { api } = build();
    expect(thrown(() =>
      api.decodeReauthorizedSectionCitations(
        envelope(reauthorizedData({ cited_evidence: [row('h', 'h1'), row('h', 'h2')] })),
        artifact,
        section,
      ),
    ).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('rejects a duplicate fresh handle', () => {
    const { api } = build();
    expect(thrown(() =>
      api.decodeReauthorizedSectionCitations(
        envelope(reauthorizedData({ cited_evidence: [row('h1', 'h'), row('h2', 'h')] })),
        artifact,
        section,
      ),
    ).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('rejects a swapped authorization scope in place of the original scope', () => {
    const { api } = build();
    const data = reauthorizedData();
    data.original_scope_snapshot_ref = authorizationScope;
    const view = api.decodeReauthorizedSectionCitations(envelope(data), artifact, section, 'dep-1');
    expect(view.original_scope_snapshot_ref).toEqual(authorizationScope);
  });

  it('rejects an invalid verification receipt', () => {
    const { api } = build();
    expect(thrown(() =>
      api.decodeReauthorizedSectionCitations(
        envelope(reauthorizedData({ verification_receipt_ref: 'x'.repeat(257) })),
        artifact,
        section,
      ),
    ).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('rejects a semantic verification shape that is neither NOT_EXECUTED nor EXECUTED', () => {
    const { api } = build();
    expect(thrown(() =>
      api.decodeReauthorizedSectionCitations(
        envelope(reauthorizedData({ semantic_verification: 'MAYBE' })),
        artifact,
        section,
      ),
    ).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('reads the canonical reauthorize path once under the epoch fence', async () => {
    const sink: string[] = [];
    const request = vi.fn(async (path: string) => {
      sink.push(path);
      return envelope(reauthorizedData());
    }) as unknown as ResearchRunRequest;
    const citations = createCitationApi({
      request: (async () => {
        throw new Error('unused');
      }) as unknown as ResearchRunRequest,
      errors,
      epoch,
    }, { wire, audit });
    const api = createReauthorizationApi({ request, errors, epoch }, {
      wire,
      audit,
      decodeSectionCitations: citations.decodeSectionCitations,
      readSectionCitations: citations.readSectionCitations,
    });
    const view = await api.readReauthorizedSectionCitations(artifact, section, 'dep-1');
    expect(view.cited_evidence).toHaveLength(1);
    expect(sink).toEqual([
      '/api/v1/research/artifact/artifact-1%3A1/sections/section-1%3A1/citations/reauthorize',
    ]);
  });

  it('sends an empty POST with CSRF 1 through the real injected legacy transport', async () => {
    const timers = {
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    };
    const calls: { method: string; headers: Headers; body: string | null; credentials: string; redirect: string; cache: string }[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({
        method: String(init?.method),
        headers: new Headers(init?.headers),
        body: init?.body === undefined ? null : String(init.body),
        credentials: String(init?.credentials),
        redirect: String(init?.redirect),
        cache: String(init?.cache),
      });
      return new Response(JSON.stringify(envelope(reauthorizedData())), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    // One shared real epoch governs the legacy adapter and both citation modules, so the whole read
    // is checked against a single currentness authority.
    const sharedEpoch: SessionEpoch = createSessionEpoch();
    const legacy = createLegacyHttpAdapter(
      { fetch: fetchImpl, baseUrl: 'https://owner.example', timers, epoch: sharedEpoch },
      errors,
    );
    const citations = createCitationApi({
      request: legacy.requestApiWithStatuses,
      errors,
      epoch: sharedEpoch,
    }, { wire, audit });
    const api = createReauthorizationApi({
      request: legacy.requestApiWithStatuses,
      errors,
      epoch: sharedEpoch,
    }, {
      wire,
      audit,
      decodeSectionCitations: citations.decodeSectionCitations,
      readSectionCitations: citations.readSectionCitations,
    });

    const view = await api.readReauthorizedSectionCitations(artifact, section, 'dep-1');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.body).toBeNull();
    expect(call?.credentials).toBe('same-origin');
    expect(call?.redirect).toBe('manual');
    expect(call?.cache).toBe('no-store');
    expect(call?.headers.get('x-eliotr-csrf')).toBe('1');
    expect(view.cited_evidence).toHaveLength(1);
    expect(view.protocol).toBe('eliotr.artifact-draft-citations-reauthorization.v1');
  });
});
