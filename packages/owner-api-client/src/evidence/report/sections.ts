// C3-EM owner-client move of the section byte half of
// packages/pwa-research-workspace/src/research-run-api.ts.
// Wire/value implementation moves here; only the transport, digest and epoch seams are injected.
// Status, budget, header and content-type policy stays in this module, never in the injected client.
import { IdentifierSchema, Sha256Schema, VersionedRefSchema, type VersionedRef } from '@eliotr/contracts';
import type { LegacyErrorFactory, LegacyHttpAdapter } from '../../legacy/http.js';
import type { EpochPort } from '../../transport/client.js';

/** Exact response budget of a report section. Never widened, never taken from the transport default. */
export const MAX_SECTION_BYTES = 1024 * 1024;

/** Control characters are never legal in an identity header value. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/** A content-length is decimal ASCII, never an exponent or a signed value. */
const DECIMAL = /^(0|[1-9][0-9]*)$/u;

/** A declared section row, the only manifest facts this module is allowed to compare against. */
export interface DeclaredSection {
  readonly section_ref: VersionedRef;
  readonly body_object_ref: string;
  readonly body_sha256: string;
}

export interface ArtifactSectionResponse {
  readonly artifact_ref: VersionedRef;
  readonly section_ref: VersionedRef;
  readonly body_object_ref: string;
  readonly body_sha256: string;
  readonly size_bytes: number;
  /** Exact verified response bytes, retained for lossless export assembly. */
  readonly bytes: Uint8Array;
}

/** Byte transport only. Status, budget, header and content-type policy stays in this module. */
export type SectionHttp = Pick<LegacyHttpAdapter, 'requestApiBytes' | 'requestReauthorizedSectionBytes'>

/**
 * Digest is injected rather than acquired from an ambient crypto global, so this module imports under
 * Node and a worker, a test or a future runtime supplies its own. The bytes are the caller's, not
 * the module's.
 */
export type SectionDigest = (bytes: Uint8Array) => Promise<string>;

export interface SectionReadOptions {
  readonly expectedDeploymentGeneration?: string;
  readonly signal?: AbortSignal;
}

export interface SectionApi {
  readonly readResearchArtifactSection: (
    artifactRef: { readonly id: string; readonly revision: number },
    section: DeclaredSection,
    options?: SectionReadOptions,
  ) => Promise<ArtifactSectionResponse>;
  readonly readReauthorizedResearchArtifactSection: (
    artifactRef: { readonly id: string; readonly revision: number },
    section: DeclaredSection,
    options?: SectionReadOptions,
  ) => Promise<ArtifactSectionResponse>;
}

export interface SectionPorts {
  readonly http: SectionHttp;
  readonly errors: LegacyErrorFactory;
  readonly epoch: EpochPort;
  readonly sha256: SectionDigest;
}

export function createSectionApi(ports: SectionPorts): SectionApi {
  const { http, errors, epoch, sha256 } = ports;

  const failure: (code: string, status: number, message: string, retryable?: boolean) => never =
    (code, status, message, retryable = false) => {
      throw errors({ code, status, message, traceId: null, retryable });
    };

  const header = (headers: Headers, name: string, label: string): string => {
    const value = headers.get(name);
    if (value === null || value.length === 0 || value !== value.trim() || value.length > 1024 ||
        CONTROL_CHARS.test(value)) {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, `${label} header is invalid`);
    }
    return value;
  };

  const digest = (value: string, label: string): string => {
    if (!Sha256Schema.safeParse(value).success) {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, `${label} is invalid`);
    }
    return value;
  };

  const identifier = (value: unknown, label: string): string => {
    const parsed = IdentifierSchema.safeParse(value);
    if (!parsed.success) failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, `${label} is invalid`);
    return parsed.data;

  };

  const splitRef = (value: string, label: string): VersionedRef => {
    // The server URI-component encodes the identity ref headers, so decode before comparing.
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, `${label} is invalid`);
    }
    const separator = decoded.lastIndexOf(':');
    if (separator <= 0 || separator === decoded.length - 1) {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, `${label} is invalid`);
    }
    const revision = Number(decoded.slice(separator + 1));
    if (!/^[1-9][0-9]*$/u.test(decoded.slice(separator + 1)) || !Number.isSafeInteger(revision)) {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, `${label} is invalid`);
    }
    return { id: decoded.slice(0, separator), revision };
  };

  const decodedIdentifier = (value: string, label: string): string => {
    // The object ref header is URI-component encoded on the wire as well.
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, `${label} is invalid`);
    }
    return identifier(decoded, label);
  };

  // The canonical contract already bounds a revision to a positive integer, so the input is checked
  // against the same schema the server decodes with. A GET or POST seam therefore never dispatches a
  // zero, negative or unsafe revision that the backend would have to reject.
  const versionedRefInput = (value: { readonly id: string; readonly revision: number }): VersionedRef => {
    const parsed = VersionedRefSchema.safeParse(value);
    if (!parsed.success) {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, 'artifact or section ref is not a positive canonical versioned ref');
    }
    return parsed.data;
  };
  const closed = (): never => failure(
    'API_SESSION_CLOSED', 503, 'Response belongs to a closed owner session',
  );

  const readReauthorizedSection = async (
    path: string,
    artifactRef: VersionedRef,
    sectionRef: VersionedRef,
    options: SectionReadOptions,
  ) => {
    const capture = epoch.capture();
    // Preflight fence. A session that is already closed must never reach the network at all.
    if (!epoch.isCurrent(capture)) closed();

    // The accepted C1 seam owns the POST empty body, the canonical encoded path segments, the 1 MiB
    // budget, the octet-stream media type, the 200 completion status, the manual redirect and same-origin
    // policy, CSRF and its own abort cleanup. This module owns the identity, digest and length fences.
    const response = await http.requestReauthorizedSectionBytes(path, options.signal);

    // The response bytes are cloned before any await, so the caller always reads back the exact same
    // bytes that were verified, never a value that could be reassigned while the digest computed.
    const immutableBytes = response.bytes.slice();
    if (immutableBytes.byteLength === 0) {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, 'section response body is empty');
    }

    const returnedArtifact = splitRef(header(response.headers, 'x-eliotr-artifact-ref', 'artifact'), 'artifact ref header');
    const returnedSection = splitRef(header(response.headers, 'x-eliotr-section-ref', 'section'), 'section ref header');
    const objectRef = decodedIdentifier(
      header(response.headers, 'x-eliotr-section-object-ref', 'section object'), 'section object ref');
    const returnedSha = digest(header(response.headers, 'x-eliotr-section-sha256', 'section digest'), 'section digest header');
    if (options.expectedDeploymentGeneration !== undefined &&
        header(response.headers, 'x-eliotr-deployment-generation', 'deployment generation') !==
        options.expectedDeploymentGeneration) {
      failure('RESEARCH_RUN_DEPLOYMENT_CHANGED', 409, 'Application changed; refresh the Research run', true);
    }
    const length = header(response.headers, 'content-length', 'content length');
    if (!DECIMAL.test(length) || Number(length) !== immutableBytes.byteLength) {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, 'section content length does not match the response body');
    }
    if (returnedArtifact.id !== artifactRef.id || returnedArtifact.revision !== artifactRef.revision ||
        returnedSection.id !== sectionRef.id || returnedSection.revision !== sectionRef.revision ||
        objectRef.length === 0) {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, 'section response identity does not match the requested section');
    }

    // The digest is an await boundary a stale response can cross, so the epoch is re-checked after it.
    const actualSha = await sha256(immutableBytes);
    if (actualSha !== returnedSha) {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, 'section response digest does not match the response body');
    }
    // Final fence after the asynchronous digest, before product state.
    if (!epoch.isCurrent(capture)) closed();

    return { body_object_ref: objectRef, body_sha256: returnedSha, bytes: immutableBytes };
  };


  const readSection = async (
    path: string,
    artifactRef: VersionedRef,
    sectionRef: VersionedRef,
    options: SectionReadOptions,
  ) => {
    const capture = epoch.capture();
    // Preflight fence. A session that is already closed must never reach the network at all.
    if (!epoch.isCurrent(capture)) closed();

    const response = await http.requestApiBytes(path, options.signal, MAX_SECTION_BYTES, 'application/octet-stream');

    // The response bytes are cloned before any await, so the caller always reads back the exact same
    // bytes that were verified, never a value that could be reassigned while the digest computed.
    const immutableBytes = response.bytes.slice();

    const returnedArtifact = splitRef(header(response.headers, 'x-eliotr-artifact-ref', 'artifact'), 'artifact ref header');
    const returnedSection = splitRef(header(response.headers, 'x-eliotr-section-ref', 'section'), 'section ref header');
    const objectRef = decodedIdentifier(
      header(response.headers, 'x-eliotr-section-object-ref', 'section object'), 'section object ref');
    const returnedSha = digest(header(response.headers, 'x-eliotr-section-sha256', 'section digest'), 'section digest header');
    if (options.expectedDeploymentGeneration !== undefined &&
        header(response.headers, 'x-eliotr-deployment-generation', 'deployment generation') !==
        options.expectedDeploymentGeneration) {
      failure('RESEARCH_RUN_DEPLOYMENT_CHANGED', 409, 'Application changed; refresh the Research run', true);
    }
    const length = header(response.headers, 'content-length', 'content length');
    if (!DECIMAL.test(length) || Number(length) !== immutableBytes.byteLength) {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, 'section content length does not match the response body');
    }
    if (returnedArtifact.id !== artifactRef.id || returnedArtifact.revision !== artifactRef.revision ||
        returnedSection.id !== sectionRef.id || returnedSection.revision !== sectionRef.revision ||
        objectRef.length === 0) {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, 'section response identity does not match the requested section');
    }

    // The digest is an await boundary a stale response can cross, so the epoch is re-checked after it.
    const actualSha = await sha256(immutableBytes);
    if (actualSha !== returnedSha) {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, 'section response digest does not match the response body');
    }
    // Final fence after the asynchronous digest, before product state.
    if (!epoch.isCurrent(capture)) closed();

    return { body_object_ref: objectRef, body_sha256: returnedSha, bytes: immutableBytes };
  };

  const readResearchArtifactSection = async (
    artifactRef: { readonly id: string; readonly revision: number },
    section: DeclaredSection,
    options: SectionReadOptions = {},
  ): Promise<ArtifactSectionResponse> => {
    const artifact = versionedRefInput(artifactRef);
    const sectionRef = versionedRefInput(section.section_ref);
    const declaredObjectRef = identifier(section.body_object_ref, 'declared section object ref');
    const declaredSha = digest(section.body_sha256, 'declared section digest');
    const path = `/api/v1/research/artifact/${encodeURIComponent(`${artifact.id}:${artifact.revision}`)}` +
      `/sections/${encodeURIComponent(`${sectionRef.id}:${sectionRef.revision}`)}`;
    const readback = await readSection(path, artifact, sectionRef, options);
    // A readback that does not match the manifest row is a failed required section, so the declared
    // section bytes are never handed to the export path.
    if (readback.body_object_ref !== declaredObjectRef || readback.body_sha256 !== declaredSha) {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, 'section response identity does not match the declared section');
    }
    return {
      artifact_ref: artifact,
      section_ref: sectionRef,
      body_object_ref: readback.body_object_ref,
      body_sha256: readback.body_sha256,
      size_bytes: readback.bytes.byteLength,
      bytes: readback.bytes,
    };
  };


  const readReauthorizedResearchArtifactSection = async (
    artifactRef: { readonly id: string; readonly revision: number },
    section: DeclaredSection,
    options: SectionReadOptions = {},
  ): Promise<ArtifactSectionResponse> => {
    const artifact = versionedRefInput(artifactRef);
    const sectionRef = versionedRefInput(section.section_ref);
    const declaredObjectRef = identifier(section.body_object_ref, 'declared section object ref');
    const declaredSha = digest(section.body_sha256, 'declared section digest');
    // The reauthorized path is the accepted C1 POST empty-body seam, a distinct client call from the
    // whole-object GET read, so a reader can never mistake one for the other.
    const path = `/api/v1/research/artifact/${encodeURIComponent(`${artifact.id}:${artifact.revision}`)}` +
      `/sections/${encodeURIComponent(`${sectionRef.id}:${sectionRef.revision}`)}/reauthorize`;
    const readback = await readReauthorizedSection(path, artifact, sectionRef, options);
    // A readback that does not match the manifest row is a failed required section, so the declared
    // section bytes are never handed to the export path.
    if (readback.body_object_ref !== declaredObjectRef || readback.body_sha256 !== declaredSha) {
      failure('RESEARCH_ARTIFACT_SECTION_INVALID', 502, 'section response identity does not match the declared section');
    }
    return {
      artifact_ref: artifact,
      section_ref: sectionRef,
      body_object_ref: readback.body_object_ref,
      body_sha256: readback.body_sha256,
      size_bytes: readback.bytes.byteLength,
      bytes: readback.bytes,
    };
  };

  return { readResearchArtifactSection, readReauthorizedResearchArtifactSection };

  return { readResearchArtifactSection, readReauthorizedResearchArtifactSection };
}
