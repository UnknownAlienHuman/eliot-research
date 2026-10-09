import { describe, expect, it, vi } from 'vitest';
import { createOrientationApi, type OrientationPorts } from './orientation';

/** Characterization of the legacy orientation module, frozen before the move.
 *
 * Fixtures follow the canonical `@eliotr/contracts` shapes for ScopeSnapshot, SourceCard and
 * DocumentMapRevision, so a decoder rejection means a decoder defect rather than a fixture mismatch.
 */

const generation = 'dep-1';
const traceId = 'orient-' + 'a'.repeat(64);
const revisionRef = 'rev-1';
const at = '2026-09-08T00:00:00.000Z';
const until = '2026-09-09T00:00:00.000Z';

const envelope = (data: unknown): unknown => ({
  data,
  trace_id: 'trace-1',
  deployment_generation: generation,
});

const scopeSnapshot = (): unknown => ({
  snapshot_id: 'snap-1',
  revision: 1,
  resolved_scope_expression: { kind: 'GLOBAL_LIBRARY' },
  participant_generations: { 'rev-1': 'gen-1' },
  member_source_revision_refs: [revisionRef],
  source_owner_generations: { 'rev-1': 'gen-1' },
  policy_authority_ref: 'policy-1',
  disclosure_closure_digest: 'a'.repeat(64),
  purge_ledger_revision: 0,
  digest: 'b'.repeat(64),
  created_at: at,
  expires_at: until,
});

const sourceCard = (): unknown => ({
  card_ref: { id: 'card-1', revision: 1 },
  source_revision_ref: revisionRef,
  title: 'Normalized source',
  authors: ['Author'],
  language: 'en',
  source_kind: 'normalized',
  document_role: 'report',
  authority_hint: 'owner-provided',
  abstract: 'Summary',
  main_topics: [],
  controlled_vocabulary: [],
  outline: [],
  important_section_refs: [],
  likely_uses: [],
  quality_status: 'qualified',
  generator_generation: 'gen-1',
  created_at: at,
});

const documentMap = (): unknown => ({
  map_ref: { id: 'map-1', revision: 1 },
  source_revision_ref: revisionRef,
  section_hierarchy: [],
  page_ranges: [],
  figures: [],
  tables: [],
  named_entities: [],
  dates_and_versions: [],
  external_citations: [],
  key_terms: [],
  high_information_section_refs: ['sec-1'],
  unresolved_structure: [],
  generator_generation: 'gen-1',
  created_at: at,
});

const orientationData = (): unknown => ({
  evidence_pack: {
    pack_ref: { id: 'pack-1', revision: 1 },
    scope_snapshot_ref: { id: 'snap-1', revision: 1 },
    resolved_evidence: [],
    omitted_candidates: [],
    trace_ref: { id: traceId, revision: 1 },
    total_utf8_bytes: 0,
  },
  trace_ref: { id: traceId, revision: 1 },
  navigation: {
    source_cards: [sourceCard()],
    document_maps: [documentMap()],
    represented_source_revision_refs: [revisionRef],
    omitted_source_revision_refs: [],
    omitted_source_revision_count: 0,
    omissions_truncated: false,
    omissions: [],
    coverage_kind: 'unknown',
    coverage_method: 'frozen_scope_order',
    degraded_source_revision_refs: [],
    missing_source_classes: [],
    contradiction_refs: [],
    centrality: [],
    recommended_reading_routes: [],
    navigation_authority: 'NAVIGATION_ONLY',
  },
});

const traceData = (): unknown => ({
  trace_ref: { id: traceId, revision: 1 },
  raw_query: 'what changed?',
  scope_snapshot: scopeSnapshot(),
  query_product: 'ORIENT',
  lanes_used: ['EXACT'],
  lanes_skipped: [],
  exact_probes: [],
  index_generations: [],
  context_expansion: 0,
  // z.record over the lane enum requires every lane key, not only those used.
  candidates_by_lane: Object.fromEntries(
    ['IDENT', 'EXACT', 'LEX', 'SEM', 'LITERAL', 'SOURCECARD', 'ATLAS', 'ATOM', 'ARGUMENT',
      'WIKI', 'ARTIFACT', 'STRUCTURE', 'CODE', 'WEB', 'EXHAUSTIVE', 'VERIFY'].map((lane) => [lane, 0]),
  ),
  expansion_refs: [],
  represented_source_refs: [revisionRef],
  omitted_sources: [],
  stale_or_degraded_channels: [],
  budget_receipt_ref: 'budget-1',
});

/** The injected identity predicate: a real class, never a duck-typed object. */
class LegacyRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly traceId: string | null;
  readonly retryable: boolean;

  constructor(details: { code: string; status: number; message: string; traceId?: string | null; retryable?: boolean }) {
    super(details.message);
    this.name = 'ApiRequestError';
    this.code = details.code;
    this.status = details.status;
    this.traceId = details.traceId ?? null;
    this.retryable = details.retryable ?? false;
  }
}

const isRequestError = (error: unknown): boolean => error instanceof LegacyRequestError;

interface Harness {
  readonly api: ReturnType<typeof createOrientationApi>;
  readonly calls: { path: string; init: RequestInit }[];
}

const harness = (raw: unknown, options: { readonly current?: boolean } = {}): Harness => {
  const calls: { path: string; init: RequestInit }[] = [];
  const errors = (details: { code: string; status: number; message: string }) =>
    new LegacyRequestError({ code: details.code, status: details.status, message: details.message });
  const current = options.current ?? true;
  const epoch = {
    capture: () => (current ? { stamp: 'live' } : undefined),
    isCurrent: () => current,
  };
  const requestApi = vi.fn(async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return raw;
  });
  const ports = { http: { requestApi }, errors, epoch, isRequestError } as unknown as OrientationPorts;
  return { api: createOrientationApi(ports), calls };
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

const decode = (): ReturnType<ReturnType<typeof createOrientationApi>['decodeOrientation']> =>
  harness({}).api.decodeOrientation(envelope(orientationData()));

describe('decodeOrientation', () => {
  it('decodes the navigation-only orientation response', () => {
    const decoded = decode();
    expect(decoded.generation).toBe(generation);
    expect(decoded.requestTrace).toBe('trace-1');
    expect(decoded.omitted).toBe(0);
    expect(decoded.cards).toHaveLength(1);
    expect(decoded.scope.id).toBe('snap-1');
    expect(decoded.trace.id).toBe(traceId);
  });

  it('rejects a response whose trace id is not an orientation trace', () => {
    const bad = orientationData() as Record<string, unknown>;
    (bad.evidence_pack as Record<string, unknown>).trace_ref = { id: 'other-1', revision: 1 };
    bad.trace_ref = { id: 'other-1', revision: 1 };
    expect(() => harness({}).api.decodeOrientation(envelope(bad))).toThrowError(
      expect.objectContaining({ code: 'API_RESPONSE_SCHEMA_MISMATCH' }),
    );
  });

  it('rejects a response carrying resolved evidence', () => {
    const bad = orientationData() as Record<string, unknown>;
    (bad.evidence_pack as Record<string, unknown>).resolved_evidence = [{ handle_ref: 'h1' }];
    expect(() => harness({}).api.decodeOrientation(envelope(bad))).toThrowError(
      expect.objectContaining({ code: 'API_RESPONSE_SCHEMA_MISMATCH' }),
    );
  });

  it('rejects an unknown field in the envelope', () => {
    const extra = envelope(orientationData()) as Record<string, unknown>;
    extra.unexpected = true;
    expect(() => harness({}).api.decodeOrientation(extra)).toThrowError(
      expect.objectContaining({ code: 'API_RESPONSE_SCHEMA_MISMATCH' }),
    );
  });
});

describe('orientationBody', () => {
  it('serialises the selected source scope', () => {
    const body = JSON.parse(harness({}).api.orientationBody([revisionRef], 'what changed?')) as Record<string, unknown>;
    expect(body.query).toBe('what changed?');
    expect(body.product).toBe('ORIENT');
    expect(body.max_results).toBe(16);
    expect(body.scope_expression).toEqual({ kind: 'SELECTED_SOURCES', source_ids: [revisionRef] });
  });

  it('serialises the global library when no source is selected', () => {
    const body = JSON.parse(harness({}).api.orientationBody([], '')) as Record<string, unknown>;
    expect(body.scope_expression).toEqual({ kind: 'GLOBAL_LIBRARY' });
  });
});

describe('orientSources', () => {
  it('posts the orientation body with the caller idempotency key', async () => {
    const { api, calls } = harness(envelope(orientationData()));
    await api.orientSources('{"q":1}', 'key-1');
    expect(calls[0]?.path).toBe('/api/v1/research/orient');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"q":1}');
    expect(calls[0]?.init.headers).toEqual({
      'content-type': 'application/json',
      'idempotency-key': 'key-1',
    });
  });

  it('does not read the idempotency key as a deployment generation', async () => {
    const { api } = harness(envelope(orientationData()));
    await expect(api.orientSources('{}', 'key-1')).resolves.toMatchObject({ generation });
  });
});

describe('readOrientationTrace', () => {
  it('reads the trace by identifier only', async () => {
    const { api, calls } = harness(envelope(traceData()));
    const trace = await api.readOrientationTrace({ id: traceId, revision: 1 });
    expect(trace.trace_ref.id).toBe(traceId);
    expect(calls[0]?.path).toBe(`/api/v1/research/trace/${traceId}`);
  });

  it('rejects a reference that is not an orientation trace', async () => {
    const { api } = harness(envelope(traceData()));
    expect(await failureOf(api.readOrientationTrace({ id: 'nope', revision: 1 })))
      .toMatchObject({ code: 'API_RESPONSE_SCHEMA_MISMATCH', status: 502 });
  });

  it('rejects a revision other than one', async () => {
    const { api } = harness(envelope(traceData()));
    expect(await failureOf(api.readOrientationTrace({ id: traceId, revision: 2 })))
      .toMatchObject({ code: 'API_RESPONSE_SCHEMA_MISMATCH', status: 502 });
  });

  it('preserves the typed deployment change through the catch', async () => {
    const { api } = harness(envelope(traceData()));
    expect(await failureOf(api.readOrientationTrace({ id: traceId, revision: 1 }, undefined, 'dep-other')))
      .toMatchObject({ code: 'ORIENTATION_DEPLOYMENT_CHANGED', status: 409 });
  });
});

describe('readOrientationScope', () => {
  it('reads the scope snapshot from the trace rather than inventing a scope route', async () => {
    const { api, calls } = harness(envelope(traceData()));
    await api.readOrientationScope(decode());
    expect(calls[0]?.path).toBe(`/api/v1/research/trace/${traceId}`);
  });

  it('passes the view generation as the expected generation', async () => {
    const { api } = harness(envelope(traceData()));
    await expect(api.readOrientationScope(decode())).resolves.toMatchObject({ snapshot_id: 'snap-1' });
  });

  it('rejects a scope snapshot that is not the referenced one', async () => {
    const drift = envelope(traceData()) as Record<string, unknown>;
    const data = drift.data as Record<string, unknown>;
    const snapshot = data.scope_snapshot as Record<string, unknown>;
    snapshot.snapshot_id = 'snap-other';
    const { api } = harness(drift);
    expect(await failureOf(api.readOrientationScope(decode())))
      .toMatchObject({ code: 'ORIENTATION_SCOPE_CHANGED', status: 409 });
  });

  it('does not treat a duck-typed object carrying a code as the typed request error', async () => {
    // A generic object with a code is not the legacy class. The gate must reject it as a mismatch,
    // not let it escape the catch as if it were typed.
    const decoy = { code: 'ORIENTATION_SCOPE_CHANGED', status: 409, message: 'decoy' };
    const http = {
      requestApi: vi.fn(async () => decoy),
    };
    const errors = (details: { code: string; status: number; message: string }) =>
      new LegacyRequestError({ code: details.code, status: details.status, message: details.message });
    const epoch = { capture: () => ({ stamp: 'live' }), isCurrent: () => true };
    const ports = { http: http as never, errors, epoch, isRequestError } as unknown as OrientationPorts;
    const api = createOrientationApi(ports);
    expect(await failureOf(api.readOrientationScope(decode())))
      .toMatchObject({ code: 'API_RESPONSE_SCHEMA_MISMATCH', status: 502 });
  });
});

describe('epoch fences', () => {
  it('refuses to contact the transport when the session is already closed', async () => {
    const { api, calls } = harness(envelope(orientationData()), { current: false });
    expect(await failureOf(api.orientSources('{}', 'key-1')))
      .toMatchObject({ code: 'API_SESSION_CLOSED', status: 503 });
    expect(calls).toHaveLength(0);
  });

  it('rejects a response whose session closed before the decode fence', async () => {
    let current = true;
    const errors = (details: { code: string; status: number; message: string }) =>
      Object.assign(new Error(details.message), {
        code: details.code, status: details.status, traceId: null, retryable: false,
      });
    const epoch = {
      capture: () => (current ? { stamp: 'live' } : undefined),
      isCurrent: () => current,
    };
    const requestApi = vi.fn(async () => {
      current = false;
      return envelope(orientationData());
    });
    const ports = { http: { requestApi }, errors, epoch, isRequestError } as unknown as OrientationPorts;
    const api = createOrientationApi(ports);
    expect(await failureOf(api.orientSources('{}', 'key-1')))
      .toMatchObject({ code: 'API_SESSION_CLOSED', status: 503 });
  });
});
