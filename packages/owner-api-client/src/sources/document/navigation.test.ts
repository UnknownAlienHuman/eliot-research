import { describe, expect, it, vi } from 'vitest';
import { createNavigationApi, type NavigationPorts } from './navigation';

/** Characterization of the legacy Corpus Lens expansion, frozen before the move. */

const generation = 'dep-1';
const sourceRevisionRef = 'rev-1';
const at = '2026-09-08T00:00:00.000Z';

const envelope = (data: unknown): unknown => ({
  data,
  trace_id: 'trace-1',
  deployment_generation: generation,
});

const scope = {
  snapshot_id: 'snap-1',
  revision: 1,
  resolved_scope_expression: { kind: 'GLOBAL_LIBRARY' },
  participant_generations: { 'rev-1': 'gen-1' },
  member_source_revision_refs: [sourceRevisionRef],
  source_owner_generations: { 'rev-1': 'gen-1' },
  policy_authority_ref: 'policy-1',
  disclosure_closure_digest: 'a'.repeat(64),
  purge_ledger_revision: 0,
  digest: 'b'.repeat(64),
  created_at: '2026-09-08T00:00:00.000Z',
  expires_at: '2026-09-09T00:00:00.000Z',
} as never;

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

const navigationOnly = (): unknown => ({
  kind: 'NAVIGATION_ONLY',
  publication_eligible: false,
  reason_code: 'STRUCTURAL_NAVIGATION',
});

const sourceCard = (): unknown => ({
  card_ref: { id: 'card-1', revision: 1 },
  source_revision_ref: sourceRevisionRef,
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

const section = (): unknown => ({
  section_ref: 'sec-1',
  source_revision_ref: sourceRevisionRef,
  label: 'Findings',
  metadata: {},
});

const documentMap = (): unknown => ({
  map_ref: { id: 'map-1', revision: 1 },
  source_revision_ref: sourceRevisionRef,
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

interface Harness {
  readonly api: ReturnType<typeof createNavigationApi>;
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
  const readOrientationScope = vi.fn(async () => scope);
  const ports = { http: { requestApi }, errors, epoch, readOrientationScope, isRequestError } as unknown as NavigationPorts;
  return { api: createNavigationApi(ports), calls };
};

type Failure = { code: string; status: number };

  const callFailure = async (call: () => unknown): Promise<Failure> => {
    try {
      const result = call();
      if (result instanceof Promise) await result;
    } catch (error) {
      return { code: String((error as { code: unknown }).code),
        status: Number((error as { status: unknown }).status) };
    }
    throw new Error('expected a typed failure');
  };

const failureOfCall = async (call: () => unknown): Promise<Failure> => {
  try {
    const result = call();
    if (result instanceof Promise) await result;
  } catch (error) {
    return { code: String((error as { code: unknown }).code),
      status: Number((error as { status: unknown }).status) };
  }
  throw new Error('expected a typed failure');
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

const decodeFailure = (api: Harness['api'], raw: unknown): Promise<{ code: string; status: number }> =>
  failureOfCall(() => api.decodeNavigationExpansion(raw, generation, scope));

describe('navigationExpansionBody', () => {
  it('serialises the requested target with its scope', () => {
    const body = JSON.parse(harness({}).api.navigationExpansionBody(scope, {
      kind: 'DOCUMENT_MAP', sourceRevisionRef,
    })) as Record<string, unknown>;
    expect(body.kind).toBe('DOCUMENT_MAP');
    expect(body.source_revision_ref).toBe(sourceRevisionRef);
    expect(body.scope_snapshot).toMatchObject({ snapshot_id: 'snap-1' });
  });

  it('serialises a section target', () => {
    const body = JSON.parse(harness({}).api.navigationExpansionBody(scope, {
      kind: 'SECTION', sourceRevisionRef, sectionRef: 'sec-1',
    })) as Record<string, unknown>;
    expect(body.section_ref).toBe('sec-1');
  });
});

describe('decodeNavigationExpansion', () => {
  it('decodes a document map with its sections', () => {
    const result = harness({}).api.decodeNavigationExpansion(
      envelope({
        kind: 'DOCUMENT_MAP',
        source_card: sourceCard(),
        document_map: documentMap(),
        sections: [section()],
        support: navigationOnly(),
      }),
      generation, scope, { kind: 'DOCUMENT_MAP', sourceRevisionRef },
    );
    expect(result.kind).toBe('DOCUMENT_MAP');
    expect(result.kind === 'DOCUMENT_MAP' && result.sections).toHaveLength(1);
    expect(result.support.publication_eligible).toBe(false);
  });

  it('decodes a source card', () => {
    const result = harness({}).api.decodeNavigationExpansion(
      envelope({ kind: 'SOURCE_CARD', source_card: sourceCard(), support: navigationOnly() }),
      generation, scope, { kind: 'SOURCE_CARD', sourceRevisionRef },
    );
    expect(result.kind).toBe('SOURCE_CARD');
  });

  it('preserves the typed deployment change through the catch', async () => {
    const { api } = harness({});
    // A matching envelope decodes without throwing, which is what makes the catch below observable.
    expect(api.decodeNavigationExpansion(
      envelope({ kind: 'SOURCE_CARD', source_card: sourceCard(), support: navigationOnly() }),
      generation, scope, { kind: 'SOURCE_CARD', sourceRevisionRef },
    ).kind).toBe('SOURCE_CARD');
    expect(await callFailure(() => api.decodeNavigationExpansion(
      envelope({ kind: 'SOURCE_CARD', source_card: sourceCard(), support: navigationOnly() }),
      'dep-other', scope, { kind: 'SOURCE_CARD', sourceRevisionRef },
    ))).toMatchObject({ code: 'NAVIGATION_DEPLOYMENT_CHANGED', status: 409 });
  });

  it('rejects metadata that carries evidence authority', async () => {
    const leaked = section() as Record<string, unknown>;
    leaked.metadata = { evidence_handle: 'leaked' };
    expect(await decodeFailure(harness({}).api, envelope({
      kind: 'DOCUMENT_MAP',
      source_card: sourceCard(),
      document_map: documentMap(),
      sections: [leaked],
      support: navigationOnly(),
    }))).toMatchObject({ code: 'API_RESPONSE_SCHEMA_MISMATCH', status: 502 });
  });

  it('rejects support that claims publication eligibility', async () => {
    const eligible = navigationOnly() as Record<string, unknown>;
    eligible.publication_eligible = true;
    expect(await decodeFailure(harness({}).api, envelope({
      kind: 'SOURCE_CARD', source_card: sourceCard(), support: eligible,
    }))).toMatchObject({ code: 'API_RESPONSE_SCHEMA_MISMATCH', status: 502 });
  });

  it('rejects an unknown field in the expansion envelope', async () => {
    const extra = envelope({ kind: 'SOURCE_CARD', source_card: sourceCard(), support: navigationOnly() }) as Record<string, unknown>;
    extra.unexpected = true;
    expect(await decodeFailure(harness({}).api, extra))
      .toMatchObject({ code: 'API_RESPONSE_SCHEMA_MISMATCH', status: 502 });
  });

  it('rejects an expansion kind that does not match the request', async () => {
    const decoy = envelope({
      kind: 'SECTION',
      document_map_ref: { id: 'map-1', revision: 1 },
      section: section(),
      support: navigationOnly(),
    });
    // Without a target the kind is legal; the mismatch only appears once a target is declared.
    expect(harness({}).api.decodeNavigationExpansion(decoy, generation, scope).kind).toBe('SECTION');
    expect(await callFailure(() => harness({}).api.decodeNavigationExpansion(
      decoy, generation, scope, { kind: 'SOURCE_CARD', sourceRevisionRef },
    ))).toMatchObject({ code: 'API_RESPONSE_SCHEMA_MISMATCH', status: 502 });
  });
});

describe('expandNavigation', () => {
  const view = {
    cards: [],
    maps: [],
    scope: { id: 'snap-1', revision: 1 },
    trace: { id: 'trace-1', revision: 1 },
    omitted: 0,
    generation,
    requestTrace: 'trace-1',
  } as never;

  it('resolves the scope through the injected dependency and posts the expansion', async () => {
    const { api, calls } = harness(envelope({
      kind: 'SOURCE_CARD', source_card: sourceCard(), support: navigationOnly(),
    }));
    await api.expandNavigation(view, { kind: 'SOURCE_CARD', sourceRevisionRef });
    expect(calls[0]?.path).toBe('/api/v1/research/navigation/expand');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('decodes with the view generation', async () => {
    const { api } = harness(envelope({
      kind: 'SOURCE_CARD', source_card: sourceCard(), support: navigationOnly(),
    }));
    // The envelope carries the same generation as the view, so this resolves rather than conflicting.
    await expect(api.expandNavigation(view, { kind: 'SOURCE_CARD', sourceRevisionRef })).resolves.toMatchObject({
      kind: 'SOURCE_CARD',
    });
  });

  it('refuses to contact the transport when the session is already closed', async () => {
    const { api, calls } = harness({}, { current: false });
    expect(await failureOf(api.expandNavigation(view, { kind: 'SOURCE_CARD', sourceRevisionRef })))
      .toMatchObject({ code: 'API_SESSION_CLOSED', status: 503 });
    expect(calls).toHaveLength(0);
  });

  it('rejects a response whose session closed before the decode fence', async () => {
    let current = true;
    const errors = (details: { code: string; status: number; message: string }) =>
      new LegacyRequestError({ code: details.code, status: details.status, message: details.message });
    const epoch = {
      capture: () => (current ? { stamp: 'live' } : undefined),
      isCurrent: () => current,
    };
    const requestApi = vi.fn(async () => {
      current = false;
      return envelope({ kind: 'SOURCE_CARD', source_card: sourceCard(), support: navigationOnly() });
    });
    const readOrientationScope = vi.fn(async () => scope);
    const ports = { http: { requestApi }, errors, epoch, readOrientationScope, isRequestError } as unknown as NavigationPorts;
    const api = createNavigationApi(ports);
    expect(await failureOf(api.expandNavigation(view, { kind: 'SOURCE_CARD', sourceRevisionRef })))
      .toMatchObject({ code: 'API_SESSION_CLOSED', status: 503 });
  });
});
