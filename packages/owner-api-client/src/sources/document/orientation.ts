// C2-D owner-client move of packages/pwa-source-workspace/src/orientation-api.ts.
// Helper, decoder and operation bodies move here verbatim. Only the transport and epoch seams are
// injected, plus a preflight and a post-decode epoch fence. No DTO, schema, field, endpoint or retry
// rule is invented, and no idempotency key is ever read as a deployment generation.
import {
  DocumentMapRevisionSchema, IdentifierSchema, RetrievalTraceSchema, ScopeSnapshotSchema, SourceCardSchema, VersionedRefSchema,
  type DocumentMapRevision, type RetrievalTrace, type ScopeSnapshot, type SourceCard, type VersionedRef,
} from '@eliotr/contracts';
import type { LegacyErrorFactory, LegacyHttpAdapter } from '../../legacy/http.js';
import type { EpochPort } from '../../transport/client.js';

export interface OrientationView {
  readonly cards: readonly SourceCard[];
  readonly maps: readonly DocumentMapRevision[];
  readonly scope: VersionedRef;
  readonly trace: VersionedRef;
  readonly omitted: number;
  readonly generation: string;
  readonly requestTrace: string;
}

/** JSON transport only. Byte, status and header policy stays in the injected owner client. */
export type OrientationHttp = Pick<LegacyHttpAdapter, 'requestApi'>;

/** Factory-owned error construction, so legacy instanceof stays with the caller factory. */
export type OrientationErrors = LegacyErrorFactory;

export interface OrientationApi {
  readonly decodeOrientation: (value: unknown) => OrientationView;
  readonly orientationBody: (sourceIds: readonly string[], query: string) => string;
  readonly orientSources: (body: string, key: string, signal?: AbortSignal) => Promise<OrientationView>;
  readonly readOrientationTrace: (
    ref: VersionedRef,
    signal?: AbortSignal,
    expectedDeploymentGeneration?: string,
  ) => Promise<RetrievalTrace>;
  readonly readOrientationScope: (view: OrientationView, signal?: AbortSignal) => Promise<ScopeSnapshot>;
}

export interface OrientationPorts {
  readonly http: OrientationHttp;
  readonly errors: OrientationErrors;
  readonly epoch: EpochPort;
  /**
   * Identity predicate for the legacy typed error. A generic object carrying a `code` is NOT
   * equivalent to the typed class, so the gate below must use this rather than duck typing.
   */
  readonly isRequestError: (error: unknown) => boolean;
}

export function createOrientationApi(ports: OrientationPorts): OrientationApi {
  const { http, errors, epoch, isRequestError } = ports;

  // Function declarations, not const arrows. A never-returning call only narrows at the call site when
  // the callee is a function declaration or a const with an explicit function type annotation, so an
  // annotated arrow here would leave every guard below checking unreachable code.
  function failure(code: string, status: number, message: string, retryable = false): never {
    throw errors({ code, status, message, traceId: null, retryable });
  }

  function closed(): never {
    return failure('API_SESSION_CLOSED', 503, 'Response belongs to a closed owner session');
  }

  function mismatch(): never {
    throw errors({
      status: 502,
      code: 'API_RESPONSE_SCHEMA_MISMATCH',
      message: 'Invalid Corpus Lens response',
      traceId: null,
      retryable: false,
    });
  }

  const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key))) mismatch();
    return value as Record<string, unknown>;
  };

  const array = (value: unknown, maximum: number): unknown[] => {
    if (!Array.isArray(value) || value.length > maximum) mismatch();
    return value;
  };

  const ids = (value: unknown, maximum = 64): string[] => {
    const result = array(value, maximum).map((item) => IdentifierSchema.parse(item));
    if (new Set(result).size !== result.length) mismatch();
    return result;
  };

  const decodeOrientation = (value: unknown): OrientationView => {
    try {
      const envelope = record(value, ['data', 'trace_id', 'deployment_generation']);
      const data = record(envelope.data, ['evidence_pack', 'trace_ref', 'navigation']);
      const pack = record(data.evidence_pack, ['pack_ref', 'scope_snapshot_ref', 'resolved_evidence', 'omitted_candidates', 'trace_ref', 'total_utf8_bytes']);
      if (array(pack.resolved_evidence, 0).length || array(pack.omitted_candidates, 0).length || pack.total_utf8_bytes !== 0) mismatch();
      const trace = VersionedRefSchema.parse(data.trace_ref);
      const packTrace = VersionedRefSchema.parse(pack.trace_ref);
      if (trace.id !== packTrace.id || trace.revision !== packTrace.revision || !/^orient-[0-9a-f]{64}$/u.test(trace.id)) mismatch();
      VersionedRefSchema.parse(pack.pack_ref);
      const nav = record(data.navigation, ['source_cards', 'document_maps', 'represented_source_revision_refs', 'omitted_source_revision_refs',
        'omitted_source_revision_count', 'omissions_truncated', 'omissions', 'coverage_kind', 'coverage_method', 'degraded_source_revision_refs',
        'missing_source_classes', 'contradiction_refs', 'centrality', 'recommended_reading_routes', 'navigation_authority']);
      if (nav.navigation_authority !== 'NAVIGATION_ONLY' || nav.coverage_method !== 'frozen_scope_order' ||
          !['unknown', 'sampled_with_method'].includes(String(nav.coverage_kind)) || nav.omissions_truncated !== false ||
          !Number.isSafeInteger(nav.omitted_source_revision_count) || Number(nav.omitted_source_revision_count) < 0 ||
          Number(nav.omitted_source_revision_count) > 64) mismatch();
      const represented = ids(nav.represented_source_revision_refs, 16);
      const omitted = ids(nav.omitted_source_revision_refs);
      if (represented.some((id) => omitted.includes(id)) || omitted.length !== nav.omitted_source_revision_count) mismatch();
      const cards = array(nav.source_cards, 16).map((item) => SourceCardSchema.parse(item));
      const maps = array(nav.document_maps, 16).map((item) => DocumentMapRevisionSchema.parse(item));
      if (cards.length !== represented.length || new Set(cards.map((card) => card.source_revision_ref)).size !== cards.length ||
          cards.some((card) => !represented.includes(card.source_revision_ref)) ||
          new Set(maps.map((map) => map.source_revision_ref)).size !== maps.length ||
          maps.some((map) => !represented.includes(map.source_revision_ref))) mismatch();
      ids(nav.degraded_source_revision_refs); ids(nav.missing_source_classes); ids(nav.contradiction_refs);
      for (const value of array(nav.recommended_reading_routes, 1)) {
        const route = record(value, ['label', 'navigation_authority', 'source_revision_refs']);
        if (route.navigation_authority !== 'NAVIGATION_ONLY' || typeof route.label !== 'string' || route.label.length > 256 ||
            ids(route.source_revision_refs, 16).some((ref) => !represented.includes(ref))) mismatch();
      }
      for (const entry of array(nav.omissions, 128)) {
        const item = record(entry, ['source_revision_ref', 'reason']);
        IdentifierSchema.parse(item.source_revision_ref); IdentifierSchema.parse(item.reason);
      }
      for (const entry of array(nav.centrality, 64)) {
        const item = record(entry, ['source_revision_ref', 'score']);
        IdentifierSchema.parse(item.source_revision_ref);
        if (typeof item.score !== 'number' || !Number.isFinite(item.score)) mismatch();
      }
      return {
        cards, maps, scope: VersionedRefSchema.parse(pack.scope_snapshot_ref), trace,
        omitted: Number(nav.omitted_source_revision_count),
        generation: IdentifierSchema.parse(envelope.deployment_generation),
        requestTrace: IdentifierSchema.parse(envelope.trace_id),
      };
    } catch (error) {
      if (error instanceof Error && Object.hasOwn(error, 'code')) throw error;
      return mismatch();
    }
  };

  const orientationBody = (sourceIds: readonly string[], query: string): string => {
    if (sourceIds.length > 64 || new Set(sourceIds).size !== sourceIds.length ||
        new TextEncoder().encode(query).byteLength > 1024) {
      failure('ORIENTATION_INPUT_LIMIT', 400, 'Use at most 64 unique source IDs and a short focus');
    }
    sourceIds.forEach((id) => IdentifierSchema.parse(id));
    return JSON.stringify({ query, product: 'ORIENT',
      scope_expression: sourceIds.length
        ? { kind: 'SELECTED_SOURCES', source_ids: sourceIds }
        : { kind: 'GLOBAL_LIBRARY' },
      literals: [], evidence_grade: 'E0', budget_ref: 'orientation-metadata-v1', max_results: 16 });
  };

  const orientSources = async (
    body: string, key: string, signal?: AbortSignal,
  ): Promise<OrientationView> => {
    const capture = epoch.capture();
    // Preflight fence. A closed session must not reach the network at all.
    if (!epoch.isCurrent(capture)) closed();
    const value = await http.requestApi('/api/v1/research/orient', {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      ...(signal ? { signal } : {}),
    });
    const view = decodeOrientation(value);
    // Post-decode fence. The decode is an await boundary a stale response can cross.
    if (!epoch.isCurrent(capture)) closed();
    return view;
  };

  const readOrientationTrace = async (
    ref: VersionedRef,
    signal?: AbortSignal,
    expectedDeploymentGeneration?: string,
  ): Promise<RetrievalTrace> => {
    if (ref.revision !== 1 || !/^orient-[0-9a-f]{64}$/u.test(ref.id)) mismatch();
    try {
      const envelope = record(await http.requestApi(
        `/api/v1/research/trace/${encodeURIComponent(ref.id)}`,
        signal ? { signal } : {},
      ), ['data', 'trace_id', 'deployment_generation']);
      const deployment = IdentifierSchema.parse(envelope.deployment_generation);
      if (expectedDeploymentGeneration !== undefined && deployment !== expectedDeploymentGeneration) {
        failure('ORIENTATION_DEPLOYMENT_CHANGED', 409, 'Application changed; refresh the source view', true);
      }
      const trace = RetrievalTraceSchema.parse(envelope.data);
      if (trace.trace_ref.id !== ref.id || trace.trace_ref.revision !== ref.revision) mismatch();
      return trace;
    } catch (error) {
      // A typed deployment change must survive the catch rather than collapse into a mismatch.
      // Only an injected identity match qualifies, never a generic object carrying a code.
      if (isRequestError(error)) throw error;
      return mismatch();
    }
  };

  /** Resolve the exact scope snapshot referenced by the orientation response trace. */
  const readOrientationScope = async (
    view: OrientationView, signal?: AbortSignal,
  ): Promise<ScopeSnapshot> => {
    try {
      const trace = await readOrientationTrace(view.trace, signal, view.generation);
      const scope = ScopeSnapshotSchema.parse(trace.scope_snapshot);
      if (scope.snapshot_id !== view.scope.id || scope.revision !== view.scope.revision) {
        failure('ORIENTATION_SCOPE_CHANGED', 409, 'The source scope changed; reload sources', true);
      }
      return scope;
    } catch (error) {
      if (isRequestError(error)) throw error;
      return mismatch();
    }
  };

  return { decodeOrientation, orientationBody, orientSources, readOrientationTrace, readOrientationScope };
}
