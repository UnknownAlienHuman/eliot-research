/**
 * Studio artifact product operations: read publication, accept, and revise one section.
 *
 * Moved from packages/pwa-research-workspace/src/artifact-product-api.ts. Every strict rule is preserved,
 * including the copy-on-write proof that a COMMITTED section revise carries a child exactly one revision
 * above its parent with the same id, and that a non-COMMITTED state carries no draft at all.
 *
 * There is no regenerate operation here, because none exists on the wire.
 */

import {
  ArtifactRevisionSchema,
  Sha256Schema,
  type ArtifactRevision,
  type VersionedRef,
} from '@eliotr/contracts';
import type { ResearchArtifactDraftReauthorizationView } from '../evidence/report/manifest';
import type { StudioCollaborators } from './collaborators';

import type { EpochPort } from '../transport/client';
import type { LegacyErrorFactory, LegacyHttpAdapter } from '../legacy/http';
import {
  type ArtifactPublicationView,
  type ArtifactSectionRevisionView,
} from './wiki-types';

const ARTIFACT_PUBLICATION_PROTOCOL = 'eliotr.artifact-publication.v1' as const;
const SECTION_REVISE_PROTOCOL = 'eliotr.artifact-section-revise.v1' as const;
const SECTION_REVISE_STATUS_PROTOCOL = 'eliotr.artifact-section-revise-status.v1' as const;
const ACCEPT_PROTOCOL = 'eliotr.artifact-publication-accept.v1' as const;
const REVISE_TIMEOUT_MS = 120_000;

export type ArtifactHttp = Pick<LegacyHttpAdapter, 'requestApi' | 'requestApiWithStatuses'>;

export interface ArtifactDependencies {
  readonly http: ArtifactHttp;
  readonly errors: LegacyErrorFactory;
  readonly epoch: EpochPort;
  readonly collaborators: StudioCollaborators;
}

export interface OpenedRunArtifact {
  readonly artifact: ArtifactRevision;
  readonly publication: ArtifactPublicationView | null;
  readonly reauthorized?: ResearchArtifactDraftReauthorizationView;
}

type JsonRecord = Record<string, unknown>;

export function createArtifactApi(deps: ArtifactDependencies) {
  const { http, errors, epoch, collaborators } = deps;

  function invalid(message?: string): never {
    throw errors({
      status: 502,
      code: 'API_RESPONSE_SCHEMA_MISMATCH',
      message: message ?? 'Artifact response is invalid; reload the publication',
      traceId: null,
      retryable: false,
    });
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

  function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): JsonRecord {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
    const candidate = value as JsonRecord;
    const allowed = new Set([...keys, ...optional]);
    if (Object.keys(candidate).some((key) => !allowed.has(key)) || keys.some((key) => !Object.hasOwn(candidate, key))) invalid();
    return candidate;
  }

  function versionedRef(value: unknown, label: string): VersionedRef {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} is invalid`);
    const candidate = value as JsonRecord;
    if (!['id', 'revision'].every((key) => Object.hasOwn(candidate, key))) invalid(`${label} is incomplete`);
    if (typeof candidate.id !== 'string' || candidate.id.length === 0 || candidate.id.length > 512) invalid(`${label} id is invalid`);
    if (!Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 0) invalid(`${label} revision is invalid`);
    return Object.freeze({ id: candidate.id, revision: candidate.revision as number });
  }

  function sameRef(left: VersionedRef, right: VersionedRef): boolean {
    return left.id === right.id && left.revision === right.revision;
  }

  function identifier(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512) invalid(`${label} is invalid`);
    return value;
  }

  function sha(value: unknown): string {
    const parsed = Sha256Schema.safeParse(value);
    if (!parsed.success) invalid();
    return parsed.data;
  }

  function positive(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
    return value;
  }

  function isoTimestamp(value: unknown, label: string): string {
    if (typeof value !== 'string') invalid(`${label} is invalid`);
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid(`${label} is not canonical`);
    return value;
  }

  function checkGeneration(actual: unknown, expected: string): void {
    if (actual !== expected) {
      throw errors({
        status: 409,
        code: 'API_GENERATION_MISMATCH',
        message: 'Deployment changed. Refresh the artifact publication.',
        traceId: null,
        retryable: true,
      });
    }
  }

  function disposition(value: unknown): void {
    if (value !== 'CREATED' && value !== 'EXISTING') invalid();
  }

  function envelope(raw: unknown): { readonly data: JsonRecord; readonly deployment_generation: unknown } {
    const parsed = record(raw, ['data', 'trace_id', 'deployment_generation']);
    if (typeof parsed.trace_id !== 'string') invalid('trace_id is invalid');
    if (typeof parsed.data !== 'object' || parsed.data === null || Array.isArray(parsed.data)) invalid('data is invalid');
    return { data: parsed.data as JsonRecord, deployment_generation: parsed.deployment_generation };
  }

  const basePath = (ref: VersionedRef): string => {
    const parsed = versionedRef(ref, 'artifact reference');
    return '/api/v1/research/artifact/' + encodeURIComponent(parsed.id + ':' + parsed.revision);
  };

  /**
   * Deterministic across reload and retry, so an uncertain effect retains the same transport identity.
   * A pure function of its inputs; no randomness is consulted.
   */
  async function mutationKey(kind: string, ref: VersionedRef, expected: string | number | null): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify({
      kind,
      artifact_ref: versionedRef(ref, 'artifact reference'),
      expected,
    }));
    return 'artifact-' + kind + '-' + await collaborators.digestBytes(bytes);
  }
  function decodePublication(
    raw: unknown,
    ref: VersionedRef,
    generation: string,
    mutation: boolean,
    current: boolean,
  ): ArtifactPublicationView {
    const outer = envelope(raw);
    checkGeneration(outer.deployment_generation, generation);
    const data = record(outer.data, ['protocol', 'revision', 'receipt', ...(mutation ? ['disposition'] : [])]);
    if (data.protocol !== ARTIFACT_PUBLICATION_PROTOCOL) invalid();
    if (mutation) disposition(data.disposition);
    const parsed = ArtifactRevisionSchema.safeParse(data.revision);
    if (!parsed.success) invalid();
    const receipt = record(data.receipt, ['publication_ref', 'artifact_ref', 'publication_revision', 'manifest_sha256',
      'verification_set_sha256', 'evidence_currentness_sha256', 'acceptance_decision_ref', 'acceptance_provenance_ref',
      'acceptance_decision_sha256', 'principal_ref', 'authorization_receipt_ref', 'created_at']);
    const artifactRef = versionedRef(receipt.artifact_ref, 'publication artifact');
    if (!sameRef(artifactRef, parsed.data.artifact_ref) || artifactRef.id !== ref.id ||
        (!current && !sameRef(artifactRef, ref)) || (current && artifactRef.revision > ref.revision)) invalid();
    return {
      revision: parsed.data as ArtifactRevision,
      receipt: {
        publication_ref: identifier(receipt.publication_ref, 'publication reference'),
        artifact_ref: artifactRef,
        publication_revision: positive(receipt.publication_revision),
        manifest_sha256: sha(receipt.manifest_sha256),
        verification_set_sha256: sha(receipt.verification_set_sha256),
        evidence_currentness_sha256: sha(receipt.evidence_currentness_sha256),
        acceptance_decision_ref: identifier(receipt.acceptance_decision_ref, 'acceptance decision'),
        acceptance_provenance_ref: identifier(receipt.acceptance_provenance_ref, 'acceptance provenance'),
        acceptance_decision_sha256: sha(receipt.acceptance_decision_sha256),
        principal_ref: identifier(receipt.principal_ref, 'principal'),
        authorization_receipt_ref: identifier(receipt.authorization_receipt_ref, 'authorization receipt'),
        created_at: isoTimestamp(receipt.created_at, 'publication timestamp'),
      },
    };
  }

  /**
   * A missing publication is a typed 404 and returns null. That absence stays distinct from both a
   * transport failure and an unpublished artifact.
   */
  async function readArtifactPublication(
    ref: VersionedRef,
    generation: string,
    signal?: AbortSignal,
    current = false,
  ): Promise<ArtifactPublicationView | null> {
    const captured = currentOrStale();
    const path = basePath(ref) + '/publication' + (current ? '/current' : '');
    try {
      const view = decodePublication(
        await http.requestApi(path, signal === undefined ? {} : { signal }),
        ref,
        generation,
        false,
        current,
      );
      if (!epoch.isCurrent(captured)) stale();
      return view;
    } catch (error) {
      if (isArtifactNotFound(error)) return null;
      throw error;
    }
  }

  function isArtifactNotFound(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { status?: unknown; code?: unknown };
    return candidate.status === 404 && candidate.code === 'ARTIFACT_PUBLICATION_NOT_FOUND';
  }

  async function acceptArtifact(
    ref: VersionedRef,
    expectedPublicationRevision: number | null,
    generation: string,
    signal?: AbortSignal,
  ): Promise<ArtifactPublicationView> {
    const captured = currentOrStale();
    if (expectedPublicationRevision !== null) positive(expectedPublicationRevision);
    const raw = await http.requestApiWithStatuses(basePath(ref) + '/accept', {
      method: 'POST',
      ...(signal === undefined ? {} : { signal }),
      headers: {
        'content-type': 'application/json',
        'idempotency-key': await mutationKey('accept', ref, expectedPublicationRevision),
      },
      body: JSON.stringify({
        protocol: ACCEPT_PROTOCOL,
        expected_draft_head_revision: ref.revision,
        expected_publication_revision: expectedPublicationRevision,
      }),
    }, [200, 201]);
    const result = decodePublication(raw, ref, generation, true, false);
    if (result.revision.status !== 'ACCEPTED') invalid('Acceptance readback did not confirm ACCEPTED');
    if (!epoch.isCurrent(captured)) stale();
    return result;
  }

  /**
   * Section-scoped revise of one artifact revision, distinct from whole-publication accept. A COMMITTED
   * state must carry a child exactly one revision above the parent with the same id; any other state must
   * carry no draft at all, so a partial result can never be read as a completed copy-on-write.
   */
  async function reviseArtifactSection(
    ref: VersionedRef,
    sectionId: string,
    generation: string,
    signal?: AbortSignal,
  ): Promise<ArtifactSectionRevisionView> {
    const captured = currentOrStale();
    const section = identifier(sectionId, 'section contract');
    const raw = await http.requestApiWithStatuses(
      basePath(ref) + '/sections/' + encodeURIComponent(section) + '/revise',
      {
        method: 'POST',
        ...(signal === undefined ? {} : { signal }),
        headers: {
          'content-type': 'application/json',
          'idempotency-key': await mutationKey('revise', ref, section),
        },
        body: JSON.stringify({
          protocol: SECTION_REVISE_PROTOCOL,
          expected_artifact_revision: ref.revision,
        }),
      },
      [200, 201],
      REVISE_TIMEOUT_MS,
    );
    const outer = envelope(raw);
    checkGeneration(outer.deployment_generation, generation);
    const data = record(outer.data, ['protocol', 'operation_id', 'attempt_ref', 'state', 'parent_artifact_ref', 'section_id', 'disposition'], ['draft']);
    if (data.protocol !== SECTION_REVISE_STATUS_PROTOCOL ||
        !sameRef(versionedRef(data.parent_artifact_ref, 'parent artifact'), ref) ||
        data.section_id !== section) invalid();
    disposition(data.disposition);
    const state = data.state;
    if (state !== 'STARTED' && state !== 'OUTPUT_RECORDED' && state !== 'COMMITTED' &&
        state !== 'UNKNOWN' && state !== 'CANCELLED') invalid();
    let draft: ArtifactSectionRevisionView['draft'];
    if (data.draft !== undefined) {
      const value = record(data.draft, ['artifact_ref', 'manifest_sha256']);
      const child = versionedRef(value.artifact_ref, 'child artifact');
      if (state !== 'COMMITTED' || child.id !== ref.id || child.revision !== ref.revision + 1) invalid();
      draft = { artifact_ref: child, manifest_sha256: sha(value.manifest_sha256) };
    }
    if (state === 'COMMITTED' && draft === undefined) invalid();
    const view: ArtifactSectionRevisionView = {
      operation_id: identifier(data.operation_id, 'operation'),
      attempt_ref: identifier(data.attempt_ref, 'attempt'),
      state,
      ...(draft === undefined ? {} : { draft }),
    };
    if (!epoch.isCurrent(captured)) stale();
    return view;
  }

  /**
   * Opens a saved report draft, preserving the legacy two-tier read exactly.
   *
   * The series author read stays unchanged. When that read returns the typed 404
   * `ARTIFACT_DRAFT_READ_NOT_FOUND`, a non-author owner uses the independently authorized read; a
   * denial is never treated as success, and a reauthorized read confers neither Wiki nor publication
   * authority. The 404 is discriminated on that code alone and is never widened to other statuses
   * or codes.
   */
  async function openRunArtifact(
    artifactRef: VersionedRef,
    expectedDeploymentGeneration: string,
    signal?: AbortSignal,
  ): Promise<OpenedRunArtifact> {
    const captured = currentOrStale();
    const ref = versionedRef(artifactRef, 'artifact reference');
    let artifact: ArtifactRevision;
    let reauthorized: ResearchArtifactDraftReauthorizationView | undefined;
    try {
      artifact = await collaborators.manifest.readResearchArtifact(ref, {
        expectedDeploymentGeneration,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (!isDraftReadNotFound(error)) throw error;
      if (signal?.aborted === true) throw draftReadCancelled();
      const granted = await collaborators.manifest.readReauthorizedResearchArtifact(ref, {
        expectedDeploymentGeneration,
        ...(signal === undefined ? {} : { signal }),
      });
      // A reauthorization for another artifact is never this artifact's draft, whatever the
      // collaborator returned. The grant must name exactly the requested ref.
      if (!sameRef(versionedRef(granted.artifact_ref, 'granted artifact_ref'), ref)) {
        invalid('artifact reauthorization identity does not match the requested ref');
      }
      artifact = granted.artifact;
      reauthorized = granted;
    }
    const publication = await readArtifactPublication(
      artifact.artifact_ref,
      expectedDeploymentGeneration,
      signal,
    );
    const view: OpenedRunArtifact = reauthorized === undefined
      ? { artifact, publication }
      : { artifact, publication, reauthorized };
    if (!epoch.isCurrent(captured)) stale();
    return view;
  }

  /** Exactly the legacy shape: 404 plus this code. Any other failure is rethrown unchanged. */
  function isDraftReadNotFound(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { status?: unknown; code?: unknown };
    return candidate.status === 404 && candidate.code === 'ARTIFACT_DRAFT_READ_NOT_FOUND';
  }

  function draftReadCancelled(): never {
    throw errors({
      code: 'API_REQUEST_ABORTED',
      status: 503,
      message: 'Report read cancelled',
      traceId: null,
      retryable: false,
    });
  }

  return {
    readArtifactPublication,
    acceptArtifact,
    reviseArtifactSection,
    openRunArtifact,
  };
}
