/**
 * Studio/Wiki read operations.
 *
 * Moved from apps/eliotr-pwa/src/wiki-api.ts. Every strict decoder rule, bound and generation fence is
 * preserved. The body read keeps the original byte, header and digest verification inside this factory,
 * using the accepted seam requestApiBytes for the payload and the injected digestBytes collaborator for the
 * re-hash, so no caller can supply text that skipped the verification path.
 */

import {
  IdentifierSchema,
  IsoDateTimeSchema,
  Sha256Schema,
  VersionedRefSchema,
  WikiPageRevisionSchema,
  WikiPageTypeSchema,
  type VersionedRef,
  type WikiPageRevision,
} from '@eliotr/contracts';

import type { EpochPort } from '../transport/client';
import type { LegacyErrorFactory, LegacyHttpAdapter } from '../legacy/http';
import type { StudioCollaborators } from './collaborators';
import {
  MAX_WIKI_BODY_BYTES,
  MAX_WIKI_PROPOSALS,
  WIKI_PROPOSAL_LIST_PROTOCOL,
  WIKI_PROPOSAL_READ_PROTOCOLS,
  type WikiProposalBodyView,
  type WikiProposalListView,
  type WikiProposalReadView,
  type WikiProposalRiskClass,
  type WikiSourceFreshness,
  type WikiSourceFreshnessState,
} from './wiki-types';

const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RISK_CLASSES: readonly WikiProposalRiskClass[] = [
  'D0_MECHANICAL', 'D1_LOW_RISK_ADDITIVE', 'D2_ANALYTICAL', 'D3_AUTHORITY_SENSITIVE',
];

export type WikiReadHttp = Pick<LegacyHttpAdapter, 'requestApi' | 'requestApiBytes'>;

export interface WikiReadDependencies {
  readonly http: WikiReadHttp;
  readonly errors: LegacyErrorFactory;
  readonly epoch: EpochPort;
  readonly collaborators: StudioCollaborators;
}

type JsonRecord = Record<string, unknown>;

export function createWikiReadApi(deps: WikiReadDependencies) {
  const { http, errors, epoch, collaborators } = deps;

  function invalid(message: string): never {
    throw errors({ status: 502, code: 'WIKI_RESPONSE_INVALID', message, traceId: null, retryable: false });
  }

  function record(value: unknown, required: readonly string[], optional: readonly string[] = []): JsonRecord {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('Wiki response data must be an object');
    const candidate = value as JsonRecord;
    const allowed = new Set([...required, ...optional]);
    if (Object.keys(candidate).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(candidate, key))) {
      invalid('Wiki response has missing or unknown fields');
    }
    return candidate;
  }

  function identifier(value: unknown, label: string): string {
    if (!IdentifierSchema.safeParse(value).success || typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${label} is invalid`);
    return value;
  }

  function versionedRef(value: unknown, label: string): VersionedRef {
    const parsed = VersionedRefSchema.safeParse(value);
    if (!parsed.success) invalid(`${label} is invalid`);
    return parsed.data;
  }

  function timestamp(value: unknown, label: string): string {
    const parsed = IsoDateTimeSchema.safeParse(value);
    if (!parsed.success) invalid(`${label} is invalid`);
    return parsed.data;
  }

  function riskClass(value: unknown, label: string): WikiProposalRiskClass {
    if (typeof value !== 'string' || !RISK_CLASSES.includes(value as WikiProposalRiskClass)) invalid(`${label} is invalid`);
    return value as WikiProposalRiskClass;
  }

  function proposalState(value: unknown): 'PROPOSED' | 'PUBLISHED' {
    if (value !== 'PROPOSED' && value !== 'PUBLISHED') invalid('Wiki proposal state is invalid');
    return value;
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

  function refKey(ref: VersionedRef): string {
    return `${ref.id}:${ref.revision}`;
  }

  function pathRef(ref: VersionedRef, label: string): string {
    if (ref.revision !== 1) {
      throw errors({ status: 400, code: 'WIKI_INPUT_INVALID', message: `${label} revision is unsupported`, traceId: null, retryable: false });
    }
    return encodeURIComponent(ref.id);
  }

  function headerName(headers: Headers, name: string): string {
    const value = headers.get(name);
    if (value === null || value.length === 0 || value !== value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
      invalid(`Wiki response is missing a valid ${name} header`);
    }
    return value;
  }

  function sourceFreshness(value: unknown): WikiSourceFreshness {
    const data = record(value, ['state', 'checked_at', 'changed_sources']);
    if (data.state !== 'CURRENT_REVISIONS' && data.state !== 'PREVIOUS_REVISIONS') invalid('source_freshness.state is invalid');
    const checkedAt = timestamp(data.checked_at, 'source_freshness.checked_at');
    if (!Array.isArray(data.changed_sources) || data.changed_sources.length > 64) invalid('source_freshness.changed_sources is invalid');
    const seen = new Set<string>();
    const changedSources = data.changed_sources.map((entry, index) => {
      const row = record(entry, ['source_id', 'saved_revision_ref', 'head_revision_ref']);
      const sourceId = identifier(row.source_id, `source_freshness.changed_sources[${index}].source_id`);
      const savedRevision = identifier(row.saved_revision_ref, `source_freshness.changed_sources[${index}].saved_revision_ref`);
      const headRevision = identifier(row.head_revision_ref, `source_freshness.changed_sources[${index}].head_revision_ref`);
      if (seen.has(sourceId)) invalid('source_freshness.changed_sources contains duplicate sources');
      seen.add(sourceId);
      if (data.state === 'CURRENT_REVISIONS' && savedRevision !== headRevision) invalid('current source revisions do not match');
      if (data.state === 'PREVIOUS_REVISIONS' && savedRevision === headRevision) invalid('previous source revisions must differ');
      return { source_id: sourceId, saved_revision_ref: savedRevision, head_revision_ref: headRevision };
    });
    if (data.state === 'CURRENT_REVISIONS' && changedSources.length !== 0) invalid('current source revisions must have no changed sources');
    if (data.state === 'PREVIOUS_REVISIONS' && changedSources.length === 0) invalid('previous source revisions must identify a changed source');
    return { state: data.state as WikiSourceFreshnessState, checked_at: checkedAt, changed_sources: changedSources };
  }

  function envelope(raw: unknown, expectedDeploymentGeneration?: string): { readonly data: unknown; readonly deployment_generation: string } {
    const parsed = record(raw, ['data', 'trace_id', 'deployment_generation']);
    const trace = identifier(parsed.trace_id, 'trace_id');
    if (!SAFE_TRACE_ID.test(trace)) invalid('trace_id is invalid');
    const generation = identifier(parsed.deployment_generation, 'deployment_generation');
    if (expectedDeploymentGeneration !== undefined && generation !== expectedDeploymentGeneration) {
      throw errors({
        status: 409,
        code: 'WIKI_DEPLOYMENT_CHANGED',
        message: 'The application changed; refresh Wiki proposals',
        traceId: null,
        retryable: true,
      });
    }
    return { data: parsed.data, deployment_generation: generation };
  }
  function decodeWikiProposalList(raw: unknown, expectedDeploymentGeneration?: string): WikiProposalListView {
    const checked = envelope(raw, expectedDeploymentGeneration);
    const data = record(checked.data, ['protocol', 'items', 'has_more']);
    if (data.protocol !== WIKI_PROPOSAL_LIST_PROTOCOL || !Array.isArray(data.items) || data.items.length > MAX_WIKI_PROPOSALS || typeof data.has_more !== 'boolean') invalid('Wiki proposal list is invalid');
    const seen = new Set<string>();
    const items = data.items.map((value, index) => {
      const item = record(value, ['proposal_ref', 'page_ref', 'title', 'page_type', 'risk_class', 'state', 'created_at']);
      const proposalRef = versionedRef(item.proposal_ref, `items[${index}].proposal_ref`);
      const pageRef = versionedRef(item.page_ref, `items[${index}].page_ref`);
      const key = `${proposalRef.id}:${proposalRef.revision}`;
      if (seen.has(key)) invalid('Wiki proposal list contains duplicate proposals');
      seen.add(key);
      const pageType = WikiPageTypeSchema.safeParse(item.page_type);
      if (!pageType.success) invalid(`items[${index}].page_type is invalid`);
      if (typeof item.title !== 'string' || item.title.length < 1 || item.title.length > 512 || /[\u0000-\u001f\u007f]/u.test(item.title)) invalid(`items[${index}].title is invalid`);
      return {
        proposal_ref: proposalRef,
        page_ref: pageRef,
        title: item.title,
        page_type: pageType.data,
        risk_class: riskClass(item.risk_class, `items[${index}].risk_class`),
        state: proposalState(item.state),
        created_at: timestamp(item.created_at, `items[${index}].created_at`),
      };
    });
    return { protocol: WIKI_PROPOSAL_LIST_PROTOCOL, items, has_more: data.has_more, deployment_generation: checked.deployment_generation };
  }

  function decodeWikiProposalRead(raw: unknown, expectedDeploymentGeneration?: string): WikiProposalReadView {
    const checked = envelope(raw, expectedDeploymentGeneration);
    const data = record(checked.data, ['protocol', 'proposal_ref', 'page', 'risk_class', 'state'], ['source_freshness']);
    if (!WIKI_PROPOSAL_READ_PROTOCOLS.includes(data.protocol as (typeof WIKI_PROPOSAL_READ_PROTOCOLS)[number])) invalid('Wiki proposal read protocol is invalid');
    const freshness = data.protocol === 'eliotr.wiki-proposal-read.v2'
      ? sourceFreshness(data.source_freshness)
      : Object.hasOwn(data, 'source_freshness')
        ? invalid('v1 Wiki proposal read cannot include source freshness')
        : { state: 'UNKNOWN' as const, changed_sources: [] as const };
    const page = WikiPageRevisionSchema.safeParse(data.page);
    if (!page.success) invalid('Wiki proposal page is invalid');
    return {
      protocol: data.protocol as WikiProposalReadView['protocol'],
      proposal_ref: versionedRef(data.proposal_ref, 'proposal_ref'),
      page: page.data as WikiPageRevision,
      risk_class: riskClass(data.risk_class, 'risk_class'),
      state: proposalState(data.state),
      source_freshness: freshness,
      deployment_generation: checked.deployment_generation,
    };
  }

  async function readWikiProposals(
    expectedDeploymentGeneration?: string,
    signal?: AbortSignal,
  ): Promise<WikiProposalListView> {
    const captured = currentOrStale();
    const raw = await http.requestApi('/api/v1/research/wiki/proposals', signal === undefined ? {} : { signal });
    const view = decodeWikiProposalList(raw, expectedDeploymentGeneration);
    if (!epoch.isCurrent(captured)) stale();
    return view;
  }

  async function readWikiProposal(
    proposalRef: VersionedRef,
    expectedDeploymentGeneration?: string,
    signal?: AbortSignal,
  ): Promise<WikiProposalReadView> {
    const captured = currentOrStale();
    const ref = versionedRef(proposalRef, 'proposal_ref');
    const raw = await http.requestApi(`/api/v1/research/wiki/proposals/${pathRef(ref, 'proposal')}`, signal === undefined ? {} : { signal });
    const view = decodeWikiProposalRead(raw, expectedDeploymentGeneration);
    if (refKey(view.proposal_ref) !== refKey(ref)) invalid('Wiki proposal identity does not match the requested proposal');
    if (!epoch.isCurrent(captured)) stale();
    return view;
  }

  async function readWikiProposalBody(
    proposalRef: VersionedRef,
    pageRef: VersionedRef,
    expectedBodySha256: string,
    expectedDeploymentGeneration: string,
    signal?: AbortSignal,
  ): Promise<WikiProposalBodyView> {
    const captured = currentOrStale();
    const proposal = versionedRef(proposalRef, 'proposal_ref');
    const page = versionedRef(pageRef, 'page_ref');
    if (!Sha256Schema.safeParse(expectedBodySha256).success) {
      throw errors({ status: 400, code: 'WIKI_INPUT_INVALID', message: 'expected body digest is invalid', traceId: null, retryable: false });
    }
    const response = await http.requestApiBytes(
      `/api/v1/research/wiki/proposals/${pathRef(proposal, 'proposal')}/body`,
      signal,
      MAX_WIKI_BODY_BYTES,
      'text/plain',
    );
    if (headerName(response.headers, 'x-eliotr-wiki-proposal-ref') !== encodeURIComponent(refKey(proposal)) ||
        headerName(response.headers, 'x-eliotr-wiki-page-ref') !== encodeURIComponent(refKey(page))) {
      invalid('Wiki response identity does not match the requested proposal');
    }
    if (headerName(response.headers, 'x-eliotr-deployment-generation') !== expectedDeploymentGeneration) {
      throw errors({
        status: 409,
        code: 'WIKI_DEPLOYMENT_CHANGED',
        message: 'The application changed; refresh Wiki proposals',
        traceId: null,
        retryable: true,
      });
    }
    const bodySha256 = headerName(response.headers, 'x-eliotr-body-sha256');
    if (!Sha256Schema.safeParse(bodySha256).success || bodySha256 !== expectedBodySha256 ||
        await collaborators.digestBytes(response.bytes) !== bodySha256) {
      invalid('Wiki body digest does not match the response body');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (length.length === 0 || length !== length.trim() || length.length > 1024 ||
        /[\u0000-\u001f\u007f]/u.test(length) || !/^(0|[1-9][0-9]*)$/u.test(length))) {
      invalid('Wiki response has an invalid content-length header');
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes); }
    catch { invalid('Wiki body is not valid UTF-8'); }
    if (!epoch.isCurrent(captured)) stale();
    return { text, body_sha256: bodySha256, byte_length: response.bytes.byteLength, deployment_generation: expectedDeploymentGeneration };
  }

  return {
    decodeWikiProposalList,
    decodeWikiProposalRead,
    readWikiProposals,
    readWikiProposal,
    readWikiProposalBody,
  };
}
