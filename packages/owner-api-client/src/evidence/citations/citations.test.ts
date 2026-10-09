import { describe, expect, it, vi } from 'vitest';
import { createResearchRunWire } from '../../research/runs/wire.js';
import { createCitationAuditHelpers } from './audit.js';
import { createCitationApi } from './citations.js';
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
const scope = { id: 'scope-1', revision: 1 };
const cite = (id: string) => ({ handle_ref: { id, revision: 1 }, excerpt_sha256: SHA_A });
const resolutionItem = (id: string) => ({ handle_ref: { id, revision: 1 }, excerpt_sha256: SHA_A, verification_receipt_ref: 'verify-1' });

const citationsEnvelope = (data: Record<string, unknown>) => ({
  data,
  trace_id: 'trace-1',
  deployment_generation: 'dep-1',
});

const citationsData = (overrides: Record<string, unknown> = {}) => ({
  protocol: 'eliotr.artifact-section-citations.v1',
  artifact_ref: artifact,
  section_ref: section,
  scope_snapshot_ref: scope,
  verification_receipt_ref: 'verify-1',
  semantic_verification: 'NOT_EXECUTED',
  cited_evidence: [cite('handle-1')],
  ...overrides,
});

const decodeOnly = () => createCitationApi({
  request: (async () => {
    throw new Error('decode-only call must not touch the transport');
  }) as unknown as ResearchRunRequest,
  errors,
  epoch,
}, { wire, audit });

describe('C3-EC citation resolution', () => {
  it('decodes the v1 section citation family', () => {
    const view = decodeOnly().decodeSectionCitations(citationsEnvelope(citationsData()), artifact, section, 'dep-1');
    expect(view.protocol).toBe('eliotr.artifact-section-citations.v1');
    expect(view.semantic_verification).toBe('NOT_EXECUTED');
    expect(view.cited_evidence).toHaveLength(1);
  });

  it('rejects a deployment generation mismatch', () => {
    const failure = thrown(() =>
      decodeOnly().decodeSectionCitations(citationsEnvelope(citationsData()), artifact, section, 'dep-2'),
    );
    expect(failure.code).toBe('RESEARCH_RUN_DEPLOYMENT_CHANGED');
  });

  it('rejects an artifact identity mismatch', () => {
    const failure = thrown(() =>
      decodeOnly().decodeSectionCitations(citationsEnvelope(citationsData()), { id: 'other', revision: 1 }, section),
    );
    expect(failure.code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('rejects a section identity mismatch', () => {
    const failure = thrown(() =>
      decodeOnly().decodeSectionCitations(citationsEnvelope(citationsData()), artifact, { id: 'other', revision: 1 }),
    );
    expect(failure.code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('rejects an empty cited evidence list', () => {
    const failure = thrown(() =>
      decodeOnly().decodeSectionCitations(citationsEnvelope(citationsData({ cited_evidence: [] })), artifact, section),
    );
    expect(failure.code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('rejects a duplicate cited handle', () => {
    const failure = thrown(() =>
      decodeOnly().decodeSectionCitations(citationsEnvelope(citationsData({ cited_evidence: [cite('h'), cite('h')] })), artifact, section),
    );
    expect(failure.code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('rejects an unknown extra field on the payload', () => {
    const failure = thrown(() =>
      decodeOnly().decodeSectionCitations(citationsEnvelope(citationsData({ surprise: 1 })), artifact, section),
    );
    expect(failure.code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('rejects a v2 protocol paired with the wrong verification state', () => {
    const failure = thrown(() =>
      decodeOnly().decodeSectionCitations(
        citationsEnvelope(citationsData({ protocol: 'eliotr.artifact-section-citations.v2' })),
        artifact,
        section,
      ),
    );
    expect(failure.code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('requests the canonical citations path once under the epoch fence', async () => {
    const sink: string[] = [];
    const request = vi.fn(async (path: string) => {
      sink.push(path);
      return citationsEnvelope(citationsData());
    }) as unknown as ResearchRunRequest;
    const api = createCitationApi({ request, errors, epoch }, { wire, audit });
    const view = await api.readSectionCitations(artifact, section, 'dep-1');
    expect(view.cited_evidence).toHaveLength(1);
    expect(sink).toEqual([`/api/v1/research/artifact/artifact-1%3A1/sections/section-1%3A1/citations`]);
  });

  it('drops a response captured before the epoch advanced', async () => {
    let stamp: object | undefined = {};
    const stale: EpochPort = { capture: () => stamp, isCurrent: (capture: unknown) => capture === stamp };
    const request = (async () => {
      await Promise.resolve();
      stamp = {};
      return citationsEnvelope(citationsData());
    }) as unknown as ResearchRunRequest;
    const api = createCitationApi({ request, errors, epoch: stale }, { wire, audit });
    expect((await api.readSectionCitations(artifact, section).catch((error: unknown) => error) as LegacyErrorDetails).code)
      .toBe('API_SESSION_CLOSED');
  });

  it('decodes a strict V2 receipt whose projections follow the outcome order', () => {
    const receipt = decodeOnly().decodeReceiptV2({
      schema_version: 2,
      receipt_ref: { id: 'receipt-1', revision: 1 },
      scope_snapshot_ref: scope,
      requested_handle_refs: [{ id: 'resolved-1', revision: 1 }, { id: 'invalid-1', revision: 1 }, { id: 'quarantined-1', revision: 1 }],
      outcomes: [
        { handle_ref: { id: 'resolved-1', revision: 1 }, outcome: 'RESOLVED', excerpt_sha256: SHA_A, verification_receipt_ref: 'verify-1' },
        { handle_ref: { id: 'invalid-1', revision: 1 }, outcome: 'INVALID_REFERENCE' },
        { handle_ref: { id: 'quarantined-1', revision: 1 }, outcome: 'SOURCE_QUARANTINED' },
      ],
      resolved: [resolutionItem('resolved-1')],
      rejected: [{ handle_ref: { id: 'invalid-1', revision: 1 }, reason_code: 'INVALID_REFERENCE' }],
      requested_count: 3,
      resolved_count: 1,
      all_material_citations_resolved: false,
      created_at: '2026-10-09T12:00:00.000Z',
      receipt_digest: SHA_A,
    });
    expect(receipt.requested_count).toBe(3);
    expect(receipt.resolved).toHaveLength(1);
    expect(receipt.rejected).toEqual([{ handle_ref: { id: 'invalid-1', revision: 1 }, reason_code: 'INVALID_REFERENCE' }]);
    expect(receipt.all_material_citations_resolved).toBe(false);
  });

  it('keeps quarantine out of the rejected projection', () => {
    const receipt = decodeOnly().decodeReceiptV2({
      schema_version: 2,
      receipt_ref: { id: 'r', revision: 1 },
      scope_snapshot_ref: scope,
      requested_handle_refs: [{ id: 'q', revision: 1 }],
      outcomes: [{ handle_ref: { id: 'q', revision: 1 }, outcome: 'SOURCE_QUARANTINED' }],
      resolved: [],
      rejected: [],
      requested_count: 1,
      resolved_count: 0,
      all_material_citations_resolved: false,
      created_at: '2026-10-09T12:00:00.000Z',
      receipt_digest: SHA_A,
    });
    expect(receipt.rejected).toHaveLength(0);
    expect(receipt.resolved).toHaveLength(0);
  });

  it('rejects an unknown V2 outcome', () => {
    expect(thrown(() => decodeOnly().decodeReceiptV2({
      schema_version: 2,
      receipt_ref: { id: 'r', revision: 1 },
      scope_snapshot_ref: scope,
      requested_handle_refs: [{ id: 'q', revision: 1 }],
      outcomes: [{ handle_ref: { id: 'q', revision: 1 }, outcome: 'UNRECOGNIZED' }],
      created_at: '2026-10-09T12:00:00.000Z',
    })).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('rejects outcomes that do not cover every requested handle exactly once', () => {
    expect(thrown(() => decodeOnly().decodeReceiptV2({
      schema_version: 2,
      receipt_ref: { id: 'r', revision: 1 },
      scope_snapshot_ref: scope,
      requested_handle_refs: [{ id: 'a', revision: 1 }, { id: 'b', revision: 1 }],
      outcomes: [{ handle_ref: { id: 'a', revision: 1 }, outcome: 'RESOLVED', excerpt_sha256: SHA_A, verification_receipt_ref: 'v' }],
      created_at: '2026-10-09T12:00:00.000Z',
    })).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('rejects duplicate outcomes', () => {
    expect(thrown(() => decodeOnly().decodeReceiptV2({
      schema_version: 2,
      receipt_ref: { id: 'r', revision: 1 },
      scope_snapshot_ref: scope,
      requested_handle_refs: [{ id: 'a', revision: 1 }, { id: 'b', revision: 1 }],
      outcomes: [
        { handle_ref: { id: 'a', revision: 1 }, outcome: 'SOURCE_QUARANTINED' },
        { handle_ref: { id: 'a', revision: 1 }, outcome: 'SOURCE_QUARANTINED' },
      ],
      created_at: '2026-10-09T12:00:00.000Z',
    })).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('decodes the retained immutable V1 receipt without relabeling its members', () => {
    const v1 = decodeOnly().decodeReceiptV1({
      receipt_ref: { id: 'r', revision: 1 },
      scope_snapshot_ref: scope,
      requested_handle_refs: [{ id: 'a', revision: 1 }, { id: 'b', revision: 1 }],
      resolved: [resolutionItem('a')],
      rejected: [{ handle_ref: { id: 'b', revision: 1 }, reason_code: 'AUTHORITY_REVOKED' }],
      requested_count: 2,
      resolved_count: 1,
      all_material_citations_resolved: false,
      created_at: '2026-10-09T12:00:00.000Z',
      receipt_digest: SHA_A,
    });
    expect(v1.rejected[0]?.reason_code).toBe('AUTHORITY_REVOKED');
    expect(v1.all_material_citations_resolved).toBe(false);
  });
});
