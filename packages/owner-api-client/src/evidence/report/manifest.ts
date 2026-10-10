// C3-EM owner-client move of the artifact manifest half of
// packages/pwa-research-workspace/src/research-run-api.ts.
// Wire/value implementation moves here; only the transport, error and epoch seams are injected.
// The decoder is strict about protocol, generation, identity and DRAFT status, so a caller can never
// build an export from a manifest it did not verify.
import { ArtifactRevisionSchema, type ArtifactRevision, type VersionedRef } from '@eliotr/contracts';
import type { LegacyErrorFactory, LegacyHttpAdapter } from '../../legacy/http.js';
import type { EpochPort } from '../../transport/client.js';

/** A trace id is a bounded token, never a free-form string. */
const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** An identifier is a bounded token with a restricted character set. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;

/** Control characters are never legal in a decoded string value. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export type ResearchSourceFreshnessState = 'CURRENT_REVISIONS' | 'PREVIOUS_REVISIONS' | 'UNKNOWN';

export interface ResearchSourceFreshnessChange {
  readonly source_id: string;
  readonly saved_revision_ref: string;
  readonly head_revision_ref: string;
}

export interface ResearchSourceFreshness {
  readonly state: ResearchSourceFreshnessState;
  readonly checked_at?: string;
  readonly changed_sources: readonly ResearchSourceFreshnessChange[];
}

export interface ResearchScopeAuthorizationView {
  readonly authorization_receipt_ref: string;
  readonly policy_authority_ref: string;
  readonly allowed_use: readonly string[];
  readonly disclosure_ceiling: string;
  readonly expires_at: string;
}

export interface ResearchArtifactDraftReauthorizationView {
  readonly protocol: 'eliotr.artifact-draft-reauthorization.v1' | 'eliotr.artifact-draft-reauthorization.v2';
  readonly artifact_ref: VersionedRef;
  readonly artifact: ArtifactRevision;
  readonly original_scope_snapshot_ref: VersionedRef;
  readonly authorization_scope_snapshot_ref: VersionedRef;
  readonly authorization: ResearchScopeAuthorizationView;
  readonly source_freshness: ResearchSourceFreshness;
  readonly deployment_generation: string;
}

export interface ManifestReadOptions {
  readonly expectedDeploymentGeneration?: string;
  readonly signal?: AbortSignal;
}

export interface ManifestApi {
  readonly readResearchArtifact: (
    artifactRef: { readonly id: string; readonly revision: number },
    options?: ManifestReadOptions,
  ) => Promise<ArtifactRevision>;
  readonly readReauthorizedResearchArtifact: (
    artifactRef: { readonly id: string; readonly revision: number },
    options?: ManifestReadOptions,
  ) => Promise<ResearchArtifactDraftReauthorizationView>;
}

export interface ManifestPorts {
  readonly http: Pick<LegacyHttpAdapter, 'requestApi'>;
  readonly errors: LegacyErrorFactory;
  readonly epoch: EpochPort;
}

export function createManifestApi(ports: ManifestPorts): ManifestApi {
  const { http, errors, epoch } = ports;

  const failure: (code: string, status: number, message: string, retryable?: boolean) => never =
    (code, status, message, retryable = false) => {
      throw errors({ code, status, message, traceId: null, retryable });
    };


  const closed = (): never => failure('API_SESSION_CLOSED', 503, 'Response belongs to a closed owner session');

  const invalid = (message: string): never => failure('RESEARCH_RUN_RESPONSE_INVALID', 502, message);

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const record = (value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
    if (!isRecord(value)) invalid('research artifact response is invalid');
    const object = value as Record<string, unknown>;
    const allowed = new Set([...required, ...optional]);
    if (required.some((key) => !Object.hasOwn(object, key)) ||
        Object.keys(object).some((key) => !allowed.has(key))) {
      invalid('research artifact response is invalid');
    }
    return object;
  };

  const boundedString = (value: unknown, label: string, maximum = 256): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximum ||
        value !== value.trim() || CONTROL_CHARS.test(value)) {
      invalid(`${label} is invalid`);
    }
    return value as string;
  };

  const isoTimestamp = (value: unknown, label: string): string => {
    const timestamp = boundedString(value, label, 64);
    if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
      invalid(`${label} is invalid`);
    }
    return timestamp;
  };

  const identifier = (value: unknown, label: string): string => {
    const text = boundedString(value, label, 128);
    if (!IDENTIFIER.test(text)) invalid(`${label} is invalid`);
    return text;
  };

  const versionedRef = (value: unknown, label: string): VersionedRef => {
    if (!isRecord(value) || !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'revision')) {
      invalid(`${label} is invalid`);
    }
    const fields = value as Record<string, unknown>;
    const id = identifier(fields.id, `${label}.id`);
    const revision = fields.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) {
      invalid(`${label}.revision is invalid`);
    }
    return { id, revision: revision as number };
  };

  const sameRef = (left: VersionedRef, right: VersionedRef): boolean =>
    left.id === right.id && left.revision === right.revision;

  const envelope = (value: unknown): { readonly data: Record<string, unknown>; readonly deployment_generation: string } => {
    const outer = record(value, ['data', 'trace_id', 'deployment_generation']);
    const trace = boundedString(outer.trace_id, 'trace_id', 128);
    if (!TRACE_ID_PATTERN.test(trace)) invalid('trace_id is invalid');
    return {
      data: outer.data as Record<string, unknown>,
      deployment_generation: identifier(outer.deployment_generation, 'deployment_generation'),
    };
  };

  const checkGeneration = (actual: string, expected: string | undefined): void => {
    if (expected !== undefined && actual !== expected) {
      failure('RESEARCH_RUN_DEPLOYMENT_CHANGED', 409, 'Application changed; refresh the Research run', true);
    }
  };

  const artifactRevision = (value: unknown): ArtifactRevision => {
    try {
      return ArtifactRevisionSchema.parse(value);
    } catch {
      invalid('research artifact response is invalid');
    }
    throw new Error('unreachable');
  };

  const scopeAuthorization = (value: unknown): ResearchScopeAuthorizationView => {
    const authorization = record(value, [
      'authorization_receipt_ref', 'policy_authority_ref', 'allowed_use', 'disclosure_ceiling', 'expires_at',
    ]);
    if (!Array.isArray(authorization.allowed_use) || authorization.allowed_use.length > 32) {
      invalid('authorization allowed_use is invalid');
    }
    return {
      authorization_receipt_ref: boundedString(authorization.authorization_receipt_ref, 'authorization_receipt_ref'),
      policy_authority_ref: boundedString(authorization.policy_authority_ref, 'policy_authority_ref'),
      allowed_use: (authorization.allowed_use as unknown[]).map((use: unknown, index: number) =>
        boundedString(use, `authorization.allowed_use[${index}]`, 128)),
      disclosure_ceiling: boundedString(authorization.disclosure_ceiling, 'authorization.disclosure_ceiling', 128),
      expires_at: isoTimestamp(authorization.expires_at, 'authorization.expires_at'),
    };
  };

  const MAX_SOURCE_FRESHNESS_SOURCES = 64;

  const sourceFreshness = (value: unknown): ResearchSourceFreshness => {
    const data = record(value, ['state', 'checked_at', 'changed_sources']);
    if (data.state !== 'CURRENT_REVISIONS' && data.state !== 'PREVIOUS_REVISIONS') {
      invalid('source_freshness.state is invalid');
    }
    const checkedAt = isoTimestamp(data.checked_at, 'source_freshness.checked_at');
    if (!Array.isArray(data.changed_sources) || data.changed_sources.length > MAX_SOURCE_FRESHNESS_SOURCES) {
      invalid('source_freshness.changed_sources is invalid');
    }
    const seen = new Set<string>();
    const changedSources = (data.changed_sources as unknown[]).map((item: unknown, index: number) => {
      const row = record(item, ['source_id', 'saved_revision_ref', 'head_revision_ref']);
      const sourceId = identifier(row.source_id, `source_freshness.changed_sources[${index}].source_id`);
      const savedRevision = identifier(
        row.saved_revision_ref, `source_freshness.changed_sources[${index}].saved_revision_ref`);
      const headRevision = identifier(
        row.head_revision_ref, `source_freshness.changed_sources[${index}].head_revision_ref`);
      if (seen.has(sourceId)) invalid('source_freshness.changed_sources contains duplicate sources');
      seen.add(sourceId);
      if (data.state === 'CURRENT_REVISIONS' && savedRevision !== headRevision) {
        invalid('current source revisions do not match');
      }
      if (data.state === 'PREVIOUS_REVISIONS' && savedRevision === headRevision) {
        invalid('previous source revisions must differ');
      }
      return { source_id: sourceId, saved_revision_ref: savedRevision, head_revision_ref: headRevision };
    });
    if (data.state === 'CURRENT_REVISIONS' && changedSources.length !== 0) {
      invalid('current source revisions must have no changed sources');
    }
    if (data.state === 'PREVIOUS_REVISIONS' && changedSources.length === 0) {
      invalid('previous source revisions must identify a changed source');
    }
    return { state: data.state as ResearchSourceFreshnessState, checked_at: checkedAt, changed_sources: changedSources };
  };

  const decodeDraftReauthorization = (
    raw: unknown,
    expectedArtifact: VersionedRef,
    expectedDeploymentGeneration?: string,
  ): ResearchArtifactDraftReauthorizationView => {
    const parsed = envelope(raw);
    checkGeneration(parsed.deployment_generation, expectedDeploymentGeneration);
    const data = record(parsed.data, [
      'protocol', 'artifact_ref', 'artifact', 'original_scope_snapshot_ref',
      'authorization_scope_snapshot_ref', 'authorization', 'deployment_generation',
    ], ['source_freshness']);
    if (data.protocol !== 'eliotr.artifact-draft-reauthorization.v1' &&
        data.protocol !== 'eliotr.artifact-draft-reauthorization.v2') {
      invalid('artifact reauthorization protocol is invalid');
    }
    const freshness = data.protocol === 'eliotr.artifact-draft-reauthorization.v2'
      ? sourceFreshness(data.source_freshness)
      : Object.hasOwn(data, 'source_freshness')
        ? invalid('v1 artifact reauthorization cannot include source freshness')
        : { state: 'UNKNOWN' as const, changed_sources: [] as const };
    const generation = identifier(data.deployment_generation, 'data.deployment_generation');
    if (generation !== parsed.deployment_generation) invalid('artifact reauthorization generations differ');
    const artifactRef = versionedRef(data.artifact_ref, 'artifact_ref');
    if (!sameRef(artifactRef, expectedArtifact)) {
      invalid('artifact reauthorization identity does not match the request');
    }
    const artifact = artifactRevision(data.artifact);
    if (!sameRef(artifact.artifact_ref, artifactRef) || artifact.status !== 'DRAFT') {
      invalid('artifact reauthorization returned an invalid draft');
    }
    return {
      protocol: data.protocol as ResearchArtifactDraftReauthorizationView['protocol'],
      artifact_ref: artifactRef,
      artifact,
      original_scope_snapshot_ref: versionedRef(data.original_scope_snapshot_ref, 'original_scope_snapshot_ref'),
      authorization_scope_snapshot_ref: versionedRef(
        data.authorization_scope_snapshot_ref, 'authorization_scope_snapshot_ref'),
      authorization: scopeAuthorization(data.authorization),
      source_freshness: freshness,
      deployment_generation: generation,
    };
  };

  const readResearchArtifact = async (
    artifactRef: { readonly id: string; readonly revision: number },
    options: ManifestReadOptions = {},
  ): Promise<ArtifactRevision> => {
    const ref = versionedRef(artifactRef, 'artifact_ref');
    const capture = epoch.capture();
    // Preflight fence. A session that is already closed must never reach the network at all.
    if (!epoch.isCurrent(capture)) closed();
    const path = `/api/v1/research/artifact/${encodeURIComponent(`${ref.id}:${ref.revision}`)}`;
    const raw = await http.requestApi(path, {
      method: 'GET',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    // Final fence after the transport read, before any decode of manifest bytes.
    if (!epoch.isCurrent(capture)) closed();
    const parsed = envelope(raw);
    checkGeneration(parsed.deployment_generation, options.expectedDeploymentGeneration);
    const artifact = artifactRevision(parsed.data);
    if (artifact.artifact_ref.id !== ref.id || artifact.artifact_ref.revision !== ref.revision) {
      invalid('research artifact identity does not match the requested ref');
    }
    return artifact;
  };

  const readReauthorizedResearchArtifact = async (
    artifactRef: { readonly id: string; readonly revision: number },
    options: ManifestReadOptions = {},
  ): Promise<ResearchArtifactDraftReauthorizationView> => {
    const ref = versionedRef(artifactRef, 'artifact_ref');
    const capture = epoch.capture();
    // Preflight fence. A session that is already closed must never reach the network at all.
    if (!epoch.isCurrent(capture)) closed();
    const path = `/api/v1/research/artifact/${encodeURIComponent(`${ref.id}:${ref.revision}`)}/reauthorize`;
    const raw = await http.requestApi(path, {
      method: 'POST',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    // Final fence after the transport read, before any decode of manifest bytes.
    if (!epoch.isCurrent(capture)) closed();
    return decodeDraftReauthorization(raw, ref, options.expectedDeploymentGeneration);
  };

  return { readResearchArtifact, readReauthorizedResearchArtifact };
}
