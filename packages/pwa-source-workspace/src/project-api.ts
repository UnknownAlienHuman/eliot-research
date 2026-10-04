import { IdentifierSchema } from "@eliotr/contracts";
import { ApiRequestError, requestApi, requestApiWithStatuses } from "./api.js";

const PROJECTS_PATH = "/api/v1/research/projects";
const PROJECT_PROTOCOL = "eliotr.project-owner.v1" as const;
const PROJECT_LIST_PROTOCOL = "eliotr.project-owner-list.v1" as const;
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

export type ProjectMutationState = "CREATED" | "UPDATED" | "PENDING" | "STALE" | "DENIED";

export interface ProjectMutationView {
  readonly protocol: typeof PROJECT_PROTOCOL;
  readonly state: ProjectMutationState;
  readonly project?: ProjectSummary;
  readonly deployment_generation: string;
}

function invalid(message: string): never {
  throw new ApiRequestError({ status: 502, code: "PROJECT_RESPONSE_INVALID", message });
}

function inputInvalid(message: string): never {
  throw new ApiRequestError({ status: 400, code: "PROJECT_INPUT_INVALID", message });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string): JsonRecord {
  if (!isRecord(value) || required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    invalid(`${label} has missing or unknown fields`);
  }
  return value;
}

function text(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
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
  const actual = identifier(value, "deployment_generation");
  if (actual !== expected) {
    throw new ApiRequestError({
      status: 409,
      code: "PROJECT_GENERATION_MISMATCH",
      message: "The workspace changed; refresh Projects and try again.",
      retryable: true,
    });
  }
  return actual;
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(`${label} is invalid`);
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
    "protocol", "project_ref", "title", "revision", "owner_principal_ref",
    "deployment_generation", "source_ids", "created_at",
  ], [], label);
  if (row.protocol !== PROJECT_PROTOCOL) invalid(`${label} protocol is invalid`);
  const projectRef = exactRecord(row.project_ref, ["id", "revision"], [], `${label} project_ref`);
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
  const outer = exactRecord(value, ["data", "trace_id", "deployment_generation"], [], `${label} envelope`);
  identifier(outer.trace_id, `${label} trace_id`);
  if (!isRecord(outer.data)) invalid(`${label} data is invalid`);
  return { data: outer.data, deployment_generation: generation(outer.deployment_generation, expectedGeneration) };
}

export function decodeProjectList(value: unknown, expectedGeneration: string): ProjectListView {
  const outer = envelope(value, expectedGeneration, "project list");
  const data = exactRecord(outer.data, ["protocol", "projects"], ["next_project_id"], "project list data");
  if (data.protocol !== PROJECT_LIST_PROTOCOL || !Array.isArray(data.projects) || data.projects.length > MAX_PROJECTS) {
    invalid("project list is invalid");
  }
  const projects = data.projects.map((row, index) => project(row, `project ${index}`));
  if (projects.some((item, index) => {
    const previous = projects[index - 1];
    return previous !== undefined && item.project_id <= previous.project_id;
  })) invalid("project list is not ordered");
  const nextProjectId = data.next_project_id === undefined ? undefined : identifier(data.next_project_id, "next_project_id");
  if (nextProjectId !== undefined && projects.length === 0) invalid("project list has a continuation without projects");
  const lastProject = projects[projects.length - 1];
  if (nextProjectId !== undefined && lastProject !== undefined && nextProjectId <= lastProject.project_id) {
    invalid("project list continuation is not after the current page");
  }
  return {
    protocol: PROJECT_LIST_PROTOCOL,
    projects,
    deployment_generation: outer.deployment_generation,
    ...(nextProjectId === undefined ? {} : { next_project_id: nextProjectId }),
  };
}

function decodeMutation(value: unknown, expectedGeneration: string, state: ProjectMutationState): ProjectMutationView {
  const outer = envelope(value, expectedGeneration, "project mutation");
  const result = project(outer.data, "project mutation");
  return {
    protocol: PROJECT_PROTOCOL,
    state,
    project: result,
    deployment_generation: outer.deployment_generation,
  };
}

function requestText(value: string, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      new TextEncoder().encode(value).byteLength > maximumBytes || /[\u0000-\u001f\u007f]/u.test(value)) inputInvalid(`${label} is invalid`);
  return value;
}

function requestIdentifier(value: string, label: string): string {
  const result = requestText(value, label, 256);
  if (!SAFE_IDENTIFIER.test(result)) inputInvalid(`${label} is invalid`);
  return result;
}

function requestSources(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > MAX_SOURCE_IDS) inputInvalid("source_ids is invalid");
  const result = values.map((value, index) => requestIdentifier(value, `source_ids[${index}]`));
  if (new Set(result).size !== result.length) inputInvalid("source_ids contains duplicates");
  return [...result].sort();
}

function expected(value: string): string {
  return requestIdentifier(value, "deployment generation");
}

function key(value: string): string {
  return requestIdentifier(value, "idempotency key");
}

export async function readProjects(expectedDeploymentGeneration: string, afterProjectId?: string, signal?: AbortSignal): Promise<ProjectListView> {
  const expectedGeneration = expected(expectedDeploymentGeneration);
  const query = afterProjectId === undefined ? "" : `?after_project_id=${encodeURIComponent(requestIdentifier(afterProjectId, "after_project_id"))}`;
  return decodeProjectList(await requestApi(`${PROJECTS_PATH}${query}`, signal === undefined ? {} : { signal }), expectedGeneration);
}

export async function createProject(
  title: string,
  sourceIds: readonly string[],
  idempotencyKey: string,
  expectedDeploymentGeneration: string,
  signal?: AbortSignal,
): Promise<ProjectMutationView> {
  const expectedGeneration = expected(expectedDeploymentGeneration);
  const raw = await requestApiWithStatuses(PROJECTS_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key(idempotencyKey), "x-eliotr-csrf": "1" },
    body: JSON.stringify({ title: requestText(title, "title", MAX_TITLE_BYTES), source_ids: requestSources(sourceIds) }),
    ...(signal === undefined ? {} : { signal }),
  }, [200, 201]);
  return decodeMutation(raw, expectedGeneration, "CREATED");
}

export async function updateProject(
  projectId: string,
  title: string,
  sourceIds: readonly string[],
  expectedRevision: number,
  idempotencyKey: string,
  expectedDeploymentGeneration: string,
  signal?: AbortSignal,
): Promise<ProjectMutationView> {
  const expectedGeneration = expected(expectedDeploymentGeneration);
  const projectIdValue = requestIdentifier(projectId, "project id");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) inputInvalid("expected_revision is invalid");
  const raw = await requestApiWithStatuses(`${PROJECTS_PATH}/${encodeURIComponent(projectIdValue)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "idempotency-key": key(idempotencyKey), "x-eliotr-csrf": "1" },
    body: JSON.stringify({
      title: requestText(title, "title", MAX_TITLE_BYTES),
      source_ids: requestSources(sourceIds),
      expected_revision: expectedRevision,
    }),
    ...(signal === undefined ? {} : { signal }),
  }, [200]);
  return decodeMutation(raw, expectedGeneration, "UPDATED");
}
