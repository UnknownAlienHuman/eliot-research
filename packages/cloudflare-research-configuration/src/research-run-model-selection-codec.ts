import { WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
import { APPLICATION_MODEL_ROUTES } from "@eliotr/platform-cloudflare";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const MODEL_SELECTION_KEYS = new Set(["candidate_kind", "stage", "route_ref", "route_version", "candidate_ref", "candidate_sha256",
  "qualification_ref", "qualification_sha256", "transport_policy"]);
const LEGACY_MODEL_SELECTION_KEYS = new Set(["stage", "route_ref", "route_version", "candidate_ref", "candidate_sha256",
  "qualification_ref", "qualification_sha256", "transport_policy"]);

export interface ResearchRunModelSelection {
  readonly candidate_kind?: "provider-native-v1";
  readonly stage: string;
  readonly route_ref: string;
  readonly route_version: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly qualification_ref: string;
  readonly qualification_sha256: string;
  readonly transport_policy: Readonly<Record<string, unknown>>;
}

function checkpoint(): never {
  throw new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_INVALID");
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) checkpoint();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) checkpoint();
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID_RE.test(value)) checkpoint();
  return value;
}

function routeReference(value: unknown): string {
  if (typeof value !== "string" || !(APPLICATION_MODEL_ROUTES as readonly string[]).includes(value)) checkpoint();
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) checkpoint();
  return value;
}

export function parseResearchRunModelSelections(value: unknown): readonly ResearchRunModelSelection[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 32) checkpoint();
  const stages = new Set<string>();
  const routes = new Set<string>();
  return Object.freeze(value.map((raw) => {
    const item = object(raw);
    const candidateKind = item.candidate_kind;
    if (Object.keys(item).length === LEGACY_MODEL_SELECTION_KEYS.size) exactKeys(item, LEGACY_MODEL_SELECTION_KEYS);
    else exactKeys(item, MODEL_SELECTION_KEYS);
    if (candidateKind !== undefined && candidateKind !== "provider-native-v1") checkpoint();
    const stage = identifier(item.stage);
    const routeRef = routeReference(item.route_ref);
    const routeVersion = identifier(item.route_version);
    const candidateRef = identifier(item.candidate_ref);
    const candidateSha = digest(item.candidate_sha256);
    const qualificationRef = identifier(item.qualification_ref);
    const qualificationSha = digest(item.qualification_sha256);
    const selectionKey = `${stage}\u0000${routeRef}`;
    if (stages.has(stage) || routes.has(selectionKey)) checkpoint();
    stages.add(stage);
    routes.add(selectionKey);
    const transportPolicy = object(item.transport_policy);
    return Object.freeze({ ...(candidateKind === undefined ? {} : { candidate_kind: candidateKind }),
      stage, route_ref: routeRef, route_version: routeVersion, candidate_ref: candidateRef,
      candidate_sha256: candidateSha, qualification_ref: qualificationRef, qualification_sha256: qualificationSha,
      transport_policy: Object.freeze({ ...transportPolicy }) });
  }));
}
