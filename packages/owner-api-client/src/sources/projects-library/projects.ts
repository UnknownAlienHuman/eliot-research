/**
 * C2-L projects wire/value implementation, moved from `@eliotr/pwa-source-workspace`.
 *
 * Every strict decoder rule, size limit, status set, idempotency key, generation fence and
 * `expected_revision` check is carried over unchanged. Requests go through the injected legacy
 * seam, which owns path policy, protected headers, deadlines and authorization observation.
 *
 * Extraction is not claimed complete: the original module stays in place until the manager's explicit
 * compatibility handoff, and this module owns no shared barrel.
 */

import { IdentifierSchema } from '@eliotr/contracts';
import type { LegacyErrorFactory, LegacyHttpAdapter } from '../../legacy/http';
import type { EpochPort } from '../../transport/client';

const PROJECTS_PATH = '/api/v1/research/projects';
const PROJECT_PROTOCOL = 'eliotr.project-owner.v1' as const;
const PROJECT_LIST_PROTOCOL = 'eliotr.project-owner-list.v1' as const;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MAX_TITLE_BYTES = 4 * 1024;
const MAX_SOURCE_IDS = 256;
const MAX_PROJECTS = 256;

type JsonRecord = Record<string, unknown>;

export interface ProjectSummary {
  readonly project_id: string;
  readonly title: string;
  readonly revision: number;
  readonly source_ids: readonly string[];
  readonly created_at: string;
}

export interface ProjectListView {
  readonly protocol: typeof PROJECT_LIST_PROTOCOL;
  readonly projects: readonly ProjectSummary[];
  readonly deployment_generation: string;
  readonly next_project_id?: string;
}

export type ProjectMutationState = 'CREATED' | 'UPDATED' | 'PENDING' | 'STALE' | 'DENIED';

export interface ProjectMutationView {
  readonly protocol: typeof PROJECT_PROTOCOL;
  readonly state: ProjectMutationState;
  readonly project?: ProjectSummary;
  readonly deployment_generation: string;
}

export type ProjectsHttp = Pick<LegacyHttpAdapter, 'requestApi' | 'requestApiWithStatuses'>;

/**
 * `epoch` is a required third argument, never constructed here and never inferred from the
 * deployment generation. The caller's transport fence already refuses a request that starts
 * against a closed session, but it cannot observe the microtask between a response resolving
 * and this factory returning, so each async operation captures the shared epoch before the
 * request and re-checks it after decoding, immediately before returning. Pure decode-only calls
 * stay independent of the epoch.
 */
export function createProjectsApi(
  http: ProjectsHttp,
  errors: LegacyErrorFactory,
  epoch: EpochPort,
) {
  function invalid(message: string): never {
    throw errors({
      status: 502,
      code: 'PROJECT_RESPONSE_INVALID',
      message,
      traceId: null,
      retryable: false,
    });
  }

  function inputInvalid(message: string): never {
    throw errors({
      status: 400,
      code: 'PROJECT_INPUT_INVALID',
      message,
      traceId: null,
      retryable: false,
    });
  }

  function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string): JsonRecord {
    if (!isRecord(value) || required.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
      invalid(`${label} has missing or unknown fields`);
    }
    return value;
  }

  function text(value: unknown, label: string, maximumBytes: number): string {
    if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
        new TextEncoder().encode(value).byteLength > maximumBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
      invalid(`${label} is invalid`);
    }
    return value;
  }

  function identifier(value: unknown, label: string): string {
    const valueText = text(value, label, 256);
    if (!IdentifierSchema.safeParse(valueText).success || !SAFE_IDENTIFIER.test(valueText)) invalid(`${label} is invalid`);
    return valueText;
  }

  function generation(value: unknown, expected: string): string {
    const actual = identifier(value, 'deployment_generation');
    if (actual !== expected) {
      throw errors({
        status: 409,
        code: 'PROJECT_GENERATION_MISMATCH',
        message: 'The workspace changed; refresh Projects and try again.',
        traceId: null,
        retryable: true,
      });
    }
    return actual;
  }

  /** A result that arrived after the shared epoch advanced is stale output, never a usable view. */
  function stale(): never {
    throw errors({
      code: 'API_SESSION_CLOSED',
      status: 503,
      message: 'Response belongs to a closed owner session',
      traceId: null,
      retryable: false,
    });
  }

  function sourceIds(value: unknown, label: string): readonly string[] {
    if (!Array.isArray(value) || value.length > MAX_SOURCE_IDS) invalid(`${label} is invalid`);
    const ids = value.map((entry, index) => identifier(entry, `${label}[${index}]`));
    if (new Set(ids).size !== ids.length || ids.some((id, index) => {
      const previous = ids[index - 1];
      return index > 0 && previous !== undefined && previous >= id;
    })) {
      invalid(`${label} is not canonical`);
    }
    return ids;
  }

  function revision(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(`${label} is invalid`);
    return value;
  }

  function createdAt(value: unknown, label: string): string {
    const result = text(value, label, 64);
    const millis = Date.parse(result);
    if (!Number.isSafeInteger(millis) || new Date(millis).toISOString() !== result) invalid(`${label} is not canonical`);
    return result;
  }

  function project(value: unknown, label: string): ProjectSummary {
    const row = exactRecord(value, [
      'protocol', 'project_ref', 'title', 'revision', 'owner_principal_ref',
      'deployment_generation', 'source_ids', 'created_at',
    ], [], label);
    if (row.protocol !== PROJECT_PROTOCOL) invalid(`${label} protocol is invalid`);
    const projectRef = exactRecord(row.project_ref, ['id', 'revision'], [], `${label} project_ref`);
    const projectId = identifier(projectRef.id, `${label} project_ref.id`);
    const projectRevision = revision(projectRef.revision, `${label} project_ref.revision`);
    const currentRevision = revision(row.revision, `${label} revision`);
    if (projectRevision !== currentRevision) invalid(`${label} revision does not match project_ref`);
    identifier(row.owner_principal_ref, `${label} owner_principal_ref`);
    identifier(row.deployment_generation, `${label} deployment_generation`);
    return {
      project_id: projectId,
      title: text(row.title, `${label} title`, MAX_TITLE_BYTES),
      revision: currentRevision,
      source_ids: sourceIds(row.source_ids, `${label} source_ids`),
      created_at: createdAt(row.created_at, `${label} created_at`),
    };
  }

  function envelope(value: unknown, expectedGeneration: string, label: string): { data: JsonRecord; deployment_generation: string } {
    const outer = exactRecord(value, ['data', 'trace_id', 'deployment_generation'], [], `${label} envelope`);
    identifier(outer.trace_id, `${label} trace_id`);
    if (!isRecord(outer.data)) invalid(`${label} data is invalid`);
    return { data: outer.data, deployment_generation: generation(outer.deployment_generation, expectedGeneration) };
  }

  /** Unchanged strict decoder. Exported through the factory so callers keep the original name. */
  function decodeProjectList(value: unknown, expectedGeneration: string): ProjectListView {
    const outer = envelope(value, expectedGeneration, 'project list');
    const data = exactRecord(outer.data, ['protocol', 'projects'], ['next_project_id'], 'project list data');
    if (data.protocol !== PROJECT_LIST_PROTOCOL || !Array.isArray(data.projects) || data.projects.length > MAX_PROJECTS) {
      invalid('project list is invalid');
    }
    const projects = data.projects.map((row, index) => project(row, `project ${index}`));
    if (projects.some((item, index) => {
      const previous = projects[index - 1];
      return previous !== undefined && item.project_id <= previous.project_id;
    })) invalid('project list is not ordered');
    const nextProjectId = data.next_project_id === undefined ? undefined : identifier(data.next_project_id, 'next_project_id');
    if (nextProjectId !== undefined && projects.length === 0) invalid('project list has a continuation without projects');
    const lastProject = projects[projects.length - 1];
    if (nextProjectId !== undefined && lastProject !== undefined && nextProjectId <= lastProject.project_id) {
      invalid('project list continuation is not after the current page');
    }
    return {
      protocol: PROJECT_LIST_PROTOCOL,
      projects,
      deployment_generation: outer.deployment_generation,
      ...(nextProjectId === undefined ? {} : { next_project_id: nextProjectId }),
    };
  }

  function decodeMutation(value: unknown, expectedGeneration: string, state: ProjectMutationState): ProjectMutationView {
    const outer = envelope(value, expectedGeneration, 'project mutation');
    const result = project(outer.data, 'project mutation');
    return {
      protocol: PROJECT_PROTOCOL,
      state,
      project: result,
      deployment_generation: outer.deployment_generation,
    };
  }

  function requestText(value: string, label: string, maximumBytes: number): string {
    if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
        new TextEncoder().encode(value).byteLength > maximumBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
      inputInvalid(`${label} is invalid`);
    }
    return value;
  }

  function requestIdentifier(value: string, label: string): string {
    const result = requestText(value, label, 256);
    if (!SAFE_IDENTIFIER.test(result)) inputInvalid(`${label} is invalid`);
    return result;
  }

  function requestSources(values: readonly string[]): readonly string[] {
    if (!Array.isArray(values) || values.length > MAX_SOURCE_IDS) inputInvalid('source_ids is invalid');
    const result = values.map((value, index) => requestIdentifier(value, `source_ids[${index}]`));
    if (new Set(result).size !== result.length) inputInvalid('source_ids contains duplicates');
    return [...result].sort();
  }

  function expected(value: string): string {
    return requestIdentifier(value, 'deployment generation');
  }

  function key(value: string): string {
    return requestIdentifier(value, 'idempotency key');
  }

  async function readProjects(
    expectedDeploymentGeneration: string,
    afterProjectId?: string,
    signal?: AbortSignal,
  ): Promise<ProjectListView> {
    const expectedGeneration = expected(expectedDeploymentGeneration);
    const query = afterProjectId === undefined ? '' : `?after_project_id=${encodeURIComponent(requestIdentifier(afterProjectId, 'after_project_id'))}`;
    const captured = epoch.capture();
    if (!captured || !epoch.isCurrent(captured)) stale();
    const view = decodeProjectList(
      await http.requestApi(`${PROJECTS_PATH}${query}`, signal === undefined ? {} : { signal }),
      expectedGeneration,
    );
    if (!epoch.isCurrent(captured)) stale();
    return view;
  }

  async function createProject(
    title: string,
    sourceIds: readonly string[],
    idempotencyKey: string,
    expectedDeploymentGeneration: string,
    signal?: AbortSignal,
  ): Promise<ProjectMutationView> {
    const expectedGeneration = expected(expectedDeploymentGeneration);
    const captured = epoch.capture();
    if (!captured || !epoch.isCurrent(captured)) stale();
    const raw = await http.requestApiWithStatuses(PROJECTS_PATH, {
      method: 'POST',
      // The seam normalizes a RequestInit, and reads the operation identity only from the
      // idempotency-key header, so the header carries it across the seam unchanged.
      headers: { 'content-type': 'application/json', 'idempotency-key': key(idempotencyKey), 'x-eliotr-csrf': '1' },
      body: JSON.stringify({ title: requestText(title, 'title', MAX_TITLE_BYTES), source_ids: requestSources(sourceIds) }),
      ...(signal === undefined ? {} : { signal }),
    }, [200, 201]);
    const view = decodeMutation(raw, expectedGeneration, 'CREATED');
    if (!epoch.isCurrent(captured)) stale();
    return view;
  }

  async function updateProject(
    projectId: string,
    title: string,
    sourceIds: readonly string[],
    expectedRevision: number,
    idempotencyKey: string,
    expectedDeploymentGeneration: string,
    signal?: AbortSignal,
  ): Promise<ProjectMutationView> {
    const expectedGeneration = expected(expectedDeploymentGeneration);
    const projectIdValue = requestIdentifier(projectId, 'project id');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) inputInvalid('expected_revision is invalid');
    const captured = epoch.capture();
    if (!captured || !epoch.isCurrent(captured)) stale();
    const raw = await http.requestApiWithStatuses(`${PROJECTS_PATH}/${encodeURIComponent(projectIdValue)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': key(idempotencyKey), 'x-eliotr-csrf': '1' },
      body: JSON.stringify({
        title: requestText(title, 'title', MAX_TITLE_BYTES),
        source_ids: requestSources(sourceIds),
        expected_revision: expectedRevision,
      }),
      ...(signal === undefined ? {} : { signal }),
    }, [200]);
    const view = decodeMutation(raw, expectedGeneration, 'UPDATED');
    if (!epoch.isCurrent(captured)) stale();
    return view;
  }

  return { decodeProjectList, readProjects, createProject, updateProject };
}
