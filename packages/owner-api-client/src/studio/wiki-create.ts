/**
 * Studio/Wiki proposal creation.
 *
 * Moved from packages/pwa-research-workspace/src/wiki-proposal-create-api.ts (create-from-run) and
 * apps/eliotr-pwa/src/wiki-edit-api.ts (create-from-edit). Both decode into the same
 * eliotr.wiki-proposal.v1 shape, and both stay copy-on-write: a decoded result whose page revision is not
 * exactly base + 1 is rejected, so an edit can never be read as an in-place overwrite.
 */

import { IdentifierSchema, VersionedRefSchema, type VersionedRef } from '@eliotr/contracts';

import type { EpochPort } from '../transport/client';
import type { LegacyErrorFactory, LegacyHttpAdapter } from '../legacy/http';
import {
  MAX_EDIT_NOTE_CHARS,
  MAX_TITLE_CHARS,
  MAX_WIKI_BODY_BYTES,
  MAX_WIKI_EDIT_REQUEST_BYTES,
  WIKI_EDIT_TIMEOUT_MS,
  WIKI_PROPOSAL_PROTOCOL,
  type WikiEditProposalView,
  type WikiProposalFromRunView,
  type WikiProposalRiskClass,
} from './wiki-types';

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RISK_CLASSES: readonly WikiProposalRiskClass[] = [
  'D0_MECHANICAL', 'D1_LOW_RISK_ADDITIVE', 'D2_ANALYTICAL', 'D3_AUTHORITY_SENSITIVE',
];

export type WikiCreateHttp = Pick<LegacyHttpAdapter, 'requestApi'>;

export interface WikiCreateDependencies {
  readonly http: WikiCreateHttp;
  readonly errors: LegacyErrorFactory;
  readonly epoch: EpochPort;
}

type JsonRecord = Record<string, unknown>;

export function createWikiCreateApi(deps: WikiCreateDependencies) {
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
    if (!IdentifierSchema.safeParse(value).success || typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) invalid(`${label} is invalid`);
    return value;
  }

  function ref(value: unknown, label: string): VersionedRef {
    const parsed = VersionedRefSchema.safeParse(value);
    if (!parsed.success) invalid(`${label} is invalid`);
    return parsed.data;
  }

  function inputRef(value: VersionedRef, label: string): VersionedRef {
    const parsed = VersionedRefSchema.safeParse(value);
    if (!parsed.success) inputInvalid(`${label} is invalid`);
    return parsed.data;
  }

  function requestId(value: string, label: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) {
      inputInvalid(`${label} is invalid`);
    }
    return value;
  }

  function title(value: string): string {
    if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TITLE_CHARS || value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
      inputInvalid('title is invalid');
    }
    return value;
  }

  function editText(value: string, label: string, maximum: number, allowEmpty = false): string {
    if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.trim().length === 0) ||
        /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
      inputInvalid(`${label} is invalid`);
    }
    return value;
  }

  /**
   * Shared decode for both create paths. Enforces the copy-on-write lineage directly: the returned page
   * must be exactly one revision above its base, and the proposal stays at revision 1.
   */
  function decodeProposal(raw: unknown, expectedGeneration: string): WikiProposalFromRunView {
    const envelope = record(raw, ['data', 'trace_id', 'deployment_generation'], 'Wiki proposal response');
    const trace = identifier(envelope.trace_id, 'trace_id');
    if (!SAFE_TRACE_ID.test(trace)) invalid('trace_id is invalid');
    const generation = identifier(envelope.deployment_generation, 'deployment_generation');
    if (generation !== expectedGeneration) {
      throw errors({
        status: 409,
        code: 'WIKI_DEPLOYMENT_CHANGED',
        message: 'The application changed; refresh the research workspace.',
        traceId: null,
        retryable: true,
      });
    }
    const data = record(envelope.data, ['protocol', 'proposal_ref', 'page_ref', 'risk_class', 'state'], 'Wiki proposal data');
    if (data.protocol !== WIKI_PROPOSAL_PROTOCOL || typeof data.risk_class !== 'string' ||
        !RISK_CLASSES.includes(data.risk_class as WikiProposalRiskClass) || data.state !== 'PROPOSED') {
      invalid('Wiki proposal response is invalid');
    }
    const proposalRef = ref(data.proposal_ref, 'proposal_ref');
    const pageRef = ref(data.page_ref, 'page_ref');
    if (proposalRef.revision !== 1) invalid('Wiki edit proposal revision is invalid');
    return {
      protocol: WIKI_PROPOSAL_PROTOCOL,
      proposal_ref: proposalRef,
      page_ref: pageRef,
      risk_class: data.risk_class as WikiProposalRiskClass,
      state: 'PROPOSED',
      deployment_generation: generation,
    };
  }
  /**
   * Copy-on-write gate, applied by both create paths before returning: the returned page must be exactly one
   * revision above the base page, and the proposal stays at revision 1. A same-revision result would read as
   * an in-place overwrite and is rejected here.
   */
  function assertCow(view: WikiProposalFromRunView, basePage: VersionedRef): WikiProposalFromRunView {
    if (view.page_ref.id !== basePage.id || view.page_ref.revision !== basePage.revision + 1) {
      invalid('Wiki proposal page revision does not match the base page');
    }
    if (view.proposal_ref.revision !== 1) invalid('Wiki proposal revision is invalid');
    return view;
  }

  async function createWikiProposalFromRun(
    operationId: string,
    idempotencyKey: string,
    expectedDeploymentGeneration: string,
    signal?: AbortSignal,
  ): Promise<WikiProposalFromRunView> {
    const captured = currentOrStale();
    const operation = identifier(operationId, 'operation_id');
    const idem = requestId(idempotencyKey, 'idempotency-key');
    const generation = identifier(expectedDeploymentGeneration, 'deployment generation');
    const raw = await http.requestApi('/api/v1/research/wiki/proposals/from-run', {
      method: 'POST',
      body: JSON.stringify({ operation_id: operation }),
      headers: { 'content-type': 'application/json', 'idempotency-key': idem },
      ...(signal === undefined ? {} : { signal }),
    });
    // The from-run path names no base page, so the original applies no lineage check here; only the
    // proposal-at-revision-1 rule holds.
    const view = decodeProposal(raw, generation);
    if (view.proposal_ref.revision !== 1) invalid('Wiki proposal revision is invalid');
    if (!epoch.isCurrent(captured)) stale();
    return view;
  }

  async function createWikiEditProposal(
    baseProposalRef: VersionedRef,
    basePageRef: VersionedRef,
    expectedHeadRevision: number,
    titleText: string,
    bodyText: string,
    editNote: string,
    expectedDeploymentGeneration: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WikiEditProposalView> {
    const captured = currentOrStale();
    const baseProposal = inputRef(baseProposalRef, 'base_proposal_ref');
    if (baseProposal.revision !== 1) inputInvalid('base_proposal_ref revision is unsupported');
    const basePage = inputRef(basePageRef, 'base_page_ref');
    if (basePage.revision >= Number.MAX_SAFE_INTEGER) inputInvalid('base_page_ref revision is too large');
    if (!Number.isSafeInteger(expectedHeadRevision) || expectedHeadRevision !== basePage.revision) {
      inputInvalid('expected head revision does not match the base page');
    }
    const titleValue = title(titleText);
    const bodyValue = editText(bodyText, 'body_text', MAX_WIKI_BODY_BYTES);
    const bodyBytes = new TextEncoder().encode(bodyValue);
    if (bodyBytes.byteLength === 0 || bodyBytes.byteLength > MAX_WIKI_BODY_BYTES) inputInvalid('body_text exceeds the Wiki body bound');
    const noteValue = editText(editNote, 'edit_note', MAX_EDIT_NOTE_CHARS, true);
    const generation = identifier(expectedDeploymentGeneration, 'deployment generation');
    const idem = requestId(idempotencyKey, 'idempotency-key');
    const requestBody = JSON.stringify({
      base_proposal_ref: baseProposal,
      expected_head_revision: expectedHeadRevision,
      title: titleValue,
      body_text: bodyValue,
      edit_note: noteValue,
    });
    if (new TextEncoder().encode(requestBody).byteLength > MAX_WIKI_EDIT_REQUEST_BYTES) {
      throw errors({
        status: 413,
        code: 'WIKI_INPUT_INVALID',
        message: 'This edit is too large to save as a Wiki draft. Shorten the page and try again.',
        traceId: null,
        retryable: false,
      });
    }
    const raw = await http.requestApi('/api/v1/research/wiki/proposals/from-edit', {
      method: 'POST',
      body: requestBody,
      headers: { 'content-type': 'application/json', 'x-eliotr-csrf': '1', 'idempotency-key': idem },
      ...(signal === undefined ? {} : { signal }),
    }, WIKI_EDIT_TIMEOUT_MS);
    const view = assertCow(decodeProposal(raw, generation), basePage);
    if (!epoch.isCurrent(captured)) stale();
    return view;
  }

  return { createWikiProposalFromRun, createWikiEditProposal };
}
