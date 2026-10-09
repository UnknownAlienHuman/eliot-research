import { describe, expect, it, vi } from 'vitest';
import { EvidenceHandleSchema, ResolvedEvidenceSchema } from '@eliotr/contracts';
import { createEvidenceBytesApi, MAX_EVIDENCE_BYTES } from './bytes.js';
import type { LegacyErrorDetails, LegacyErrorFactory } from '../../legacy/http.js';
import type { EpochPort } from '../../transport/client.js';

const errors: LegacyErrorFactory = (details: LegacyErrorDetails) =>
  Object.assign(new Error(details.message), details);

const rejected = async (run: () => Promise<unknown>): Promise<LegacyErrorDetails & Error> => {
  try {
    await run();
  } catch (error) {
    return error as LegacyErrorDetails & Error;
  }
  throw new Error('expected the promise to reject');
};

const EXCERPT = 'excerpt text';
const scope = { id: 'scope-1', revision: 1 };
const handle = { id: 'handle-1', revision: 1 };

/** A real sha256-shaped digest for contract fields the source fences on shape. */
const SHA_A = 'a'.repeat(64);

/** The fixed digest the injected hasher returns, satisfying `Sha256Schema` by shape. */
const INJECTED_DIGEST = 'b'.repeat(64);

const resolvedEvidence = (overrides: Record<string, unknown> = {}) => ({
  handle: {
    handle_ref: handle,
    source_namespace_id: 'namespace-1',
    source_owner_generation: 'owner-1',
    source_revision_ref: 'source-1',
    scope_snapshot_ref: scope,
    anchor: { kind: 'normalized_byte_range', start: 0, end: 13 },
    excerpt_sha256: INJECTED_DIGEST,
    excerpt_byte_length: EXCERPT.length,
    object_residency_key_digest: SHA_A,
    source_assurance_ceiling: 'EXACT',
    materializer_assurance_ceiling: 'EXACT',
    terminal_state: 'LIVE',
    created_at: '2026-10-09T12:00:00.000Z',
  },
  exact_excerpt: EXCERPT,
  verification_receipt_ref: 'verify-1',
  authorization_receipt_ref: 'auth-1',
  credential_generation: 'credential-1',
  source_revision_content_sha256: SHA_A,
  scope_snapshot_digest: SHA_A,
  instruction_taint: 'UNTRUSTED',
  allowed_effects: 'READ_ONLY',
  resolved_at: '2026-10-09T12:00:00.000Z',
  ...overrides,
});

const openHeaders = (overrides: Record<string, string> = {}) => new Headers({
  'content-type': 'text/plain; charset=utf-8',
  'content-length': String(EXCERPT.length),
  'x-eliotr-evidence-handle': 'handle-1:1',
  'x-eliotr-excerpt-sha256': INJECTED_DIGEST,
  'x-eliotr-verification-receipt': 'verify-1',
  ...overrides,
});

const build = (raw: unknown, headers: Headers, sink: { path: string; init: RequestInit | undefined }[] = []) => {
  const requestApi = vi.fn(async (path: string, init?: RequestInit) => {
    sink.push({ path, init });
    return raw;
  });
  const requestApiText = vi.fn(async (path: string) => {
    sink.push({ path, init: undefined });
    return { text: EXCERPT, headers };
  });
  const epoch: EpochPort = { capture: () => ({}), isCurrent: () => true };
  const api = createEvidenceBytesApi({
    request: { requestApi, requestApiText },
    errors,
    epoch,
    // The source hex-maps the returned bytes, so the stub returns bytes whose hex form is the
    // fixed digest, matching real subtle.digest behaviour.
    digest: async () => {
      // `INJECTED_DIGEST` is 64 lowercase hex chars, so it decodes to 32 raw bytes whose hex form is
      // itself, which is what a real subtle.digest result looks like to the source's mapper.
      const raw = new Uint8Array(INJECTED_DIGEST.length / 2);
      for (let index = 0; index < raw.length; index += 1) {
        raw[index] = Number.parseInt(INJECTED_DIGEST.slice(index * 2, index * 2 + 2), 16);
      }
      return raw.buffer;
    },
  });
  return { api, sink };
};

describe('C3-EC evidence byte fencing', () => {
  it('verifies the selected scope and reopens the same pinned handle', async () => {
    const sink: { path: string; init: RequestInit | undefined }[] = [];
    const verifyRaw = {
      data: { resolved_evidence: resolvedEvidence(), handle: resolvedEvidence().handle },
      trace_id: 'trace-1',
      deployment_generation: 'dep-1',
    };
    const { api } = build(verifyRaw, openHeaders(), sink);
    const result = await api.verifyAndOpenEvidence(scope, handle);
    expect(result.text).toBe(EXCERPT);
    expect(sink.map((call) => call.path)).toEqual([
      '/api/v1/research/verify',
      '/api/v1/research/open/handle-1%3A1',
    ]);
  });
  it('rejects an opened handle substituted by the server', async () => {
    const { api } = build({}, openHeaders({ 'x-eliotr-evidence-handle': 'other-handle:1' }));
    expect((await rejected(() => api.openEvidence(handle))).code).toBe('EVIDENCE_RESPONSE_INVALID');
  });

  it('rejects an opened digest that is not a sha256', async () => {
    const { api } = build({}, openHeaders({ 'x-eliotr-excerpt-sha256': 'not-a-digest' }));
    expect((await rejected(() => api.openEvidence(handle))).code).toBe('EVIDENCE_RESPONSE_INVALID');
  });

  it('rejects a content-length that disagrees with the measured byte length', async () => {
    const { api } = build({}, openHeaders({ 'content-length': '9999' }));
    expect((await rejected(() => api.openEvidence(handle))).code).toBe('EVIDENCE_RESPONSE_INVALID');
  });

  it('rejects a verification receipt that is not an identifier', async () => {
    const headers = openHeaders();
    headers.set('x-eliotr-verification-receipt', 'x'.repeat(257));
    const { api } = build({}, headers);
    expect((await rejected(() => api.openEvidence(handle))).code).toBe('EVIDENCE_RESPONSE_INVALID');
  });

  it('rejects a missing header', async () => {
    const incomplete = openHeaders();
    incomplete.delete('x-eliotr-excerpt-sha256');
    const { api } = build({}, incomplete);
    expect((await rejected(() => api.openEvidence(handle))).code).toBe('EVIDENCE_RESPONSE_INVALID');
  });

  it('rejects a malformed handle header', async () => {
    const { api } = build({}, openHeaders({ 'x-eliotr-evidence-handle': 'no-colon' }));
    expect((await rejected(() => api.openEvidence(handle))).code).toBe('EVIDENCE_RESPONSE_INVALID');
  });

  it('rejects evidence whose verified handle differs from the requested handle', async () => {
    const shifted = resolvedEvidence();
    (shifted.handle as Record<string, unknown>).handle_ref = { id: 'other-handle', revision: 1 };
    const { api } = build({ data: { resolved_evidence: shifted, handle: shifted.handle }, trace_id: 't', deployment_generation: 'dep-1' }, openHeaders());
    const failure = await api.verifyEvidence(scope, handle).catch((error: unknown) => error);
    expect((failure as LegacyErrorDetails).code).toBe('EVIDENCE_RESPONSE_INVALID');
  });

  it('keeps the client byte ceiling at 512 KiB', () => {
    expect(MAX_EVIDENCE_BYTES).toBe(512 * 1024);
  });

  it('parses the contract evidence shapes used by the verify response', () => {
    const handleValue = resolvedEvidence().handle;
    const handleParse = EvidenceHandleSchema.safeParse(handleValue);
    const resolvedParse = ResolvedEvidenceSchema.safeParse(resolvedEvidence());
    expect(handleParse.success).toBe(true);
    expect(resolvedParse.success).toBe(true);
  });

});
