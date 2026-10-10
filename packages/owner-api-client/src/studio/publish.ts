/**
 * Studio/Wiki publication.
 *
 * Moved from apps/eliotr-pwa/src/wiki-publish-api.ts. The compare-and-swap target is derived from the
 * loaded page's immutable lineage, never from a caller guess, and the published receipt must name the exact
 * page that was requested.
 */

import {
  IdentifierSchema,
  VersionedRefSchema,
  WikiPageRevisionSchema,
  type VersionedRef,
  type WikiPageRevision,
} from '@eliotr/contracts';

import type { EpochPort } from '../transport/client';
import type { LegacyErrorFactory, LegacyHttpAdapter } from '../legacy/http';
import {
  WIKI_PUBLICATION_PROTOCOL,
  WIKI_PUBLICATION_TIMEOUT_MS,
  type WikiPublicationView,
} from './wiki-types';

const PATH = '/api/v1/research/wiki/publications';
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type WikiPublishHttp = Pick<LegacyHttpAdapter, 'requestApi'>;

export interface WikiPublishDependencies {
  readonly http: WikiPublishHttp;
  readonly errors: LegacyErrorFactory;
  readonly epoch: EpochPort;
}

type JsonRecord = Record<string, unknown>;

export function createWikiPublishApi(deps: WikiPublishDependencies) {
  const { http, errors, epoch } = deps;

  function invalid(message: string): never {
    throw errors({ status: 502, code: 'WIKI_RESPONSE_INVALID', message, traceId: null, retryable: false });
  }

  function inputInvalid(message: string): never {
    throw errors({ status: 400, code: 'WIKI_INPUT_INVALID', message, traceId: null, retryable: false });
  }

  function stale(): never {
    throw errors({
      code: 'API_SESSION_CLOSED',
      status: 503,
      message: 'Response belongs to a closed owner session',
      traceId: null,
      retryable: false,
    });
  }

  /** Preflight fence: an already-closed session never starts a request. */
  function currentOrStale(): ReturnType<EpochPort['capture']> {
    const captured = epoch.capture();
    if (!epoch.isCurrent(captured)) stale();
    return captured;
  }

  function record(value: unknown, keys: readonly string[], label: string): JsonRecord {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} is invalid`);
    const candidate = value as JsonRecord;
    if (Object.keys(candidate).length !== keys.length || keys.some((key) => !Object.hasOwn(candidate, key))) {
      invalid(`${label} has missing or unknown fields`);
    }
    return candidate;
  }

  function identifier(value: unknown, label: string): string {
    if (!IdentifierSchema.safeParse(value).success || typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) {
      invalid(`${label} is invalid`);
    }
    return value;
  }

  function ref(value: unknown, label: string): VersionedRef {
    const parsed = VersionedRefSchema.safeParse(value);
    if (!parsed.success) invalid(`${label} is invalid`);
    return parsed.data;
  }

  function sameRef(left: VersionedRef, right: VersionedRef): boolean {
    return left.id === right.id && left.revision === right.revision;
  }

  function requestId(value: string, label: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) {
      inputInvalid(`${label} is invalid`);
    }
    return value;
  }

  /**
   * Pure. Derives the only CAS target the loaded page's immutable lineage allows.
   *
   * A DRAFT page at revision 1 with no supersedes_ref yields 0. A page at revision N must supersede
   * the same id at revision N-1, and yields that revision. Any other lineage is invalid rather than guessed.
   */
  function expectedWikiHeadRevision(page: WikiPageRevision): number {
    const parsed = WikiPageRevisionSchema.safeParse(page);
    if (!parsed.success || parsed.data.status !== 'DRAFT') invalid('Wiki proposal is not a strict DRAFT page');
    const revision = parsed.data.page_ref.revision;
    if (revision === 1) {
      if (parsed.data.supersedes_ref !== undefined) invalid('Wiki proposal revision lineage is invalid');
      return 0;
    }
    const supersedes = parsed.data.supersedes_ref;
    if (supersedes === undefined || supersedes.id !== parsed.data.page_ref.id || supersedes.revision !== revision - 1) {
      invalid('Wiki proposal revision lineage is invalid');
    }
    return supersedes.revision;
  }

  function decode(
    raw: unknown,
    expectedDeploymentGeneration: string,
    expectedPageRef: VersionedRef,
  ): WikiPublicationView {
    const envelope = record(raw, ['data', 'trace_id', 'deployment_generation'], 'Wiki publication response');
    const trace = identifier(envelope.trace_id, 'trace_id');
    if (!SAFE_TRACE_ID.test(trace)) invalid('trace_id is invalid');
    const generation = identifier(envelope.deployment_generation, 'deployment_generation');
    if (generation !== expectedDeploymentGeneration) {
      throw errors({
        status: 409,
        code: 'WIKI_DEPLOYMENT_CHANGED',
        message: 'The application changed; refresh Wiki proposals',
        traceId: null,
        retryable: true,
      });
    }
    const data = record(envelope.data, ['protocol', 'page_ref', 'status', 'reviewer_ref'], 'Wiki publication data');
    if (data.protocol !== WIKI_PUBLICATION_PROTOCOL || data.status !== 'PUBLISHED') invalid('Wiki publication response is invalid');
    const pageRef = ref(data.page_ref, 'page_ref');
    if (!sameRef(pageRef, expectedPageRef)) invalid('Wiki publication page identity does not match the proposal');
    return {
      protocol: WIKI_PUBLICATION_PROTOCOL,
      page_ref: pageRef,
      status: 'PUBLISHED',
      reviewer_ref: identifier(data.reviewer_ref, 'reviewer_ref'),
      deployment_generation: generation,
    };
  }

  async function publishWikiProposal(
    proposalRef: VersionedRef,
    pageRef: VersionedRef,
    expectedHeadRevision: number,
    idempotencyKey: string,
    expectedDeploymentGeneration: string,
    signal?: AbortSignal,
  ): Promise<WikiPublicationView> {
    const captured = currentOrStale();
    const proposal = ref(proposalRef, 'proposal_ref');
    if (proposal.revision !== 1) {
      throw errors({ status: 400, code: 'WIKI_INPUT_INVALID', message: 'proposal_ref revision is unsupported', traceId: null, retryable: false });
    }
    const page = ref(pageRef, 'page_ref');
    if (!Number.isSafeInteger(expectedHeadRevision) || expectedHeadRevision < 0 || expectedHeadRevision >= page.revision) {
      inputInvalid('expected head revision is invalid');
    }
    const generation = identifier(expectedDeploymentGeneration, 'deployment generation');
    const idem = requestId(idempotencyKey, 'idempotency-key');
    const raw = await http.requestApi(PATH, {
      method: 'POST',
      body: JSON.stringify({ proposal_ref: proposal, expected_head_revision: expectedHeadRevision }),
      headers: { 'content-type': 'application/json', 'idempotency-key': idem },
      ...(signal === undefined ? {} : { signal }),
    }, WIKI_PUBLICATION_TIMEOUT_MS);
    const view = decode(raw, generation, page);
    if (!epoch.isCurrent(captured)) stale();
    return view;
  }

  return { expectedWikiHeadRevision, publishWikiProposal };
}
