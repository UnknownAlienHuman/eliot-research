import { describe, expect, it } from 'vitest';
import { Sha256Schema } from '@eliotr/contracts';
import { createResearchRunWire } from '../../research/runs/wire.js';
import { createCitationAuditHelpers } from './audit.js';
import type { LegacyErrorDetails, LegacyErrorFactory } from '../../legacy/http.js';

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
const helpers = createCitationAuditHelpers(errors, wire);

const SHA_A = 'a'.repeat(64);
const validAudit = (overrides: Record<string, unknown> = {}) => ({
  stage_attempt_ref: 'attempt-1',
  stage_request_sha256: SHA_A,
  output_sha256: SHA_A,
  synthesis_output_sha256: SHA_A,
  normalization_binding_sha256: SHA_A,
  verifier_ref: 'verifier-1',
  verifier_schema_generation: 'gen-1',
  model_receipt_ref: 'model-1',
  claims: [
    {
      claim_ref: { id: 'claim-1', revision: 1 },
      claim_text: 'A claim sentence.',
      claim_text_digest: SHA_A,
      disposition: 'SUPPORTED',
      support_handle_refs: [{ id: 'handle-1', revision: 1 }],
      counterevidence_handle_refs: [],
    },
  ],
  ...overrides,
});

describe('C3-EC citation audit helpers', () => {
  it('decodes a well-formed audit and exposes its claims once', () => {
    const view = helpers.decodeCitationAudit(validAudit());
    expect(view.claims).toHaveLength(1);
    expect(helpers.auditClaims(view)).toEqual(view.claims);
    expect(view.claims[0]?.disposition).toBe('SUPPORTED');
  });

  it('rejects an unknown disposition', () => {
    const raw = validAudit();
    (raw.claims[0] as Record<string, unknown>).disposition = 'DEFINITELY_TRUE';
    expect(thrown(() => helpers.decodeCitationAudit(validAudit({ surprise: 1 }))).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('rejects a claim whose support and counterevidence share one handle', () => {
    const raw = validAudit();
    (raw.claims[0] as Record<string, unknown>).counterevidence_handle_refs = [{ id: 'handle-1', revision: 1 }];
    expect(thrown(() => helpers.decodeCitationAudit(raw)).code).toBe('EVIDENCE_RESPONSE_INVALID');
  });

  it('rejects duplicate claim references', () => {
    const claim = validAudit().claims[0];
    if (claim === undefined) throw new Error('fixture claim is missing');
    const raw = validAudit();
    raw.claims = [claim, claim];
    expect(thrown(() => helpers.decodeCitationAudit(raw)).code).toBe('EVIDENCE_RESPONSE_INVALID');
  });

  it('rejects an empty claim list', () => {
    expect(thrown(() => helpers.decodeCitationAudit(validAudit({ claims: [] }))).code).toBe('EVIDENCE_RESPONSE_INVALID');
  });

  it('rejects a digest that is not a sha256', () => {
    const raw = validAudit();
    (raw.claims[0] as Record<string, unknown>).claim_text_digest = 'abc';
    expect(thrown(() => helpers.decodeCitationAudit(raw)).code).toBe('EVIDENCE_RESPONSE_INVALID');
  });

  it('rejects an unknown extra field on the audit', () => {
    expect(thrown(() => helpers.decodeCitationAudit(validAudit({ surprise: 1 }))).code).toBe('RESEARCH_RUN_RESPONSE_INVALID');
  });

  it('accepts a sha256 digest through the shared helper', () => {
    expect(Sha256Schema.safeParse(helpers.sha256Digest(SHA_A, 'digest')).success).toBe(true);
  });

  it('decodes an authorization view without collapsing its scope', () => {
    const view = helpers.scopeAuthorization({
      principal_ref: 'principal-1',
      credential_generation: 'credential-1',
      authorization_receipt_ref: 'auth-1',
      scope_snapshot_ref: { id: 'scope-1', revision: 2 },
    });
    expect(view.scope_snapshot_ref).toEqual({ id: 'scope-1', revision: 2 });
  });
});
