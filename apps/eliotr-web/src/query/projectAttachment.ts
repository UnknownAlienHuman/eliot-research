import type { ProjectListView, ProjectMutationView, ProjectSummary } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "../app/runtime";
import type { PrivacyController, SessionContext } from "../app/privacy";
import { runProtectedRead } from "./client";

const MAX_READBACK_PAGES = 32;

export interface ProjectAttachmentTarget {
  readonly projectId: string;
  readonly title: string;
  readonly revision: number;
  readonly sourceIds: readonly string[];
  readonly generation: string;
}

export interface ProjectAttachmentIntent extends ProjectAttachmentTarget {
  readonly sourceId: string;
  readonly nextSourceIds: readonly string[];
  readonly idempotencyKey?: string;
}

export type ProjectAttachmentPhase = "dispatching" | "unknown" | "conflict" | "authorization-lost" | "confirmed";

export interface ProjectAttachmentState {
  readonly phase: ProjectAttachmentPhase;
  readonly intent: ProjectAttachmentIntent;
  readonly receipt?: ProjectMutationView;
  readonly project?: ProjectSummary;
}

export interface ProjectAttachmentStore {
  readonly read: () => ProjectAttachmentState | undefined;
  readonly write: (state: ProjectAttachmentState) => void;
}

export function freezeProjectAttachmentTarget(project: ProjectSummary, generation: string): ProjectAttachmentTarget {
  return Object.freeze({
    projectId: project.project_id,
    title: project.title,
    revision: project.revision,
    sourceIds: Object.freeze([...project.source_ids]),
    generation,
  });
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

function includesIntent(row: ProjectSummary, intent: ProjectAttachmentIntent): boolean {
  return row.project_id === intent.projectId && row.title === intent.title &&
    intent.nextSourceIds.every(id => row.source_ids.includes(id)) && row.revision > intent.revision;
}

function failureStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/** One frozen membership PUT, followed only by canonical project-list readback. */
export function createExistingProjectAttachmentController(
  apis: BoundWorkspaceApis["sources"],
  privacy: PrivacyController,
  context: SessionContext,
  target: ProjectAttachmentTarget | undefined,
  store: ProjectAttachmentStore,
) {
  const generation = context.deploymentGeneration;

  async function readProject(signal: AbortSignal, intent: ProjectAttachmentIntent): Promise<ProjectSummary | undefined> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < MAX_READBACK_PAGES; pageNumber += 1) {
      const page: ProjectListView = await runProtectedRead(privacy, context, signal,
        readSignal => apis.projects.readProjects(generation, cursor, readSignal));
      if (page.deployment_generation !== generation) throw new Error("Projects changed during membership readback");
      const match = page.projects.find(project => project.project_id === intent.projectId);
      if (match) return match;
      const next = page.next_project_id;
      if (next === undefined) return undefined;
      const last = page.projects.at(-1);
      if (!last || next < last.project_id || (cursor !== undefined && next <= cursor) || seen.has(next)) {
        throw new Error("Projects readback did not advance");
      }
      seen.add(next);
      cursor = next;
    }
    throw new Error("Projects readback exceeded its page limit");
  }

  function finishReadback(row: ProjectSummary | undefined, previous: ProjectAttachmentState): ProjectAttachmentState {
    const duplicate = previous.intent.idempotencyKey === undefined;
    const confirmed = row && (duplicate
      ? row.project_id === previous.intent.projectId && row.title === previous.intent.title &&
        row.revision >= previous.intent.revision && row.source_ids.includes(previous.intent.sourceId)
      : includesIntent(row, previous.intent));
    if (row && confirmed) {
      const state: ProjectAttachmentState = { phase: "confirmed", intent: previous.intent, ...("receipt" in previous ? { receipt: previous.receipt } : {}), project: row };
      store.write(state);
      return state;
    }
    const state: ProjectAttachmentState = { ...previous, phase: duplicate && row ? "conflict" : "unknown" };
    store.write(state);
    return state;
  }

  return {
    async attach(sourceId: string, signal: AbortSignal): Promise<ProjectAttachmentState | undefined> {
      if (target === undefined || !privacy.isCurrent(context) || target.generation !== generation) return undefined;
      const existing = store.read();
      if (existing !== undefined) {
        // A remount or repeated canonical import read never repeats an in-flight/unknown PUT.
        if (existing.phase === "dispatching") {
          const unknown = { ...existing, phase: "unknown" as const };
          store.write(unknown);
          return unknown;
        }
        return existing;
      }
      const sourceIds = [...new Set(target.sourceIds)].sort();
      if (sourceIds.length !== target.sourceIds.length || sourceIds.some((id, index) => id !== target.sourceIds[index])) {
        return undefined;
      }
      const nextSourceIds = sourceIds.includes(sourceId) ? sourceIds : [...sourceIds, sourceId].sort();
      const intent: ProjectAttachmentIntent = Object.freeze({
        ...target,
        sourceIds: Object.freeze(sourceIds),
        nextSourceIds: Object.freeze(nextSourceIds),
        sourceId,
        ...(sourceIds.includes(sourceId) ? {} : { idempotencyKey: apis.mintIntent() }),
      });
      if (sourceIds.includes(sourceId)) {
        // The captured project may have lost this source during upload. Verify membership now;
        // this path never mints a mutation key or re-adds a concurrently removed source.
        const state: ProjectAttachmentState = { phase: "unknown", intent };
        store.write(state);
        try {
          return finishReadback(await readProject(signal, intent), state);
        } catch {
          return state;
        }
      }
      const pending: ProjectAttachmentState = { phase: "dispatching", intent };
      // Persist the exact project snapshot, source set and idempotency key before the first PUT.
      store.write(pending);
      if (!privacy.isCurrent(context)) {
        const lost = { ...pending, phase: "authorization-lost" as const };
        store.write(lost);
        return lost;
      }
      let receipt: ProjectMutationView;
      try {
        const idempotencyKey = intent.idempotencyKey;
        if (idempotencyKey === undefined) return undefined;
        receipt = await runProtectedRead(privacy, context, signal, readSignal => apis.projects.updateProject(
          intent.projectId, intent.title, intent.nextSourceIds, intent.revision, idempotencyKey, generation, readSignal));
      } catch (error) {
        const phase = !privacy.isCurrent(context) ? "authorization-lost" : failureStatus(error) === 409 ? "conflict" : "unknown";
        const state: ProjectAttachmentState = { ...pending, phase };
        store.write(state);
        return state;
      }
      if (!privacy.isCurrent(context)) {
        const state: ProjectAttachmentState = { ...pending, phase: "authorization-lost", receipt };
        store.write(state);
        return state;
      }
      const acknowledged = receipt.project;
      const validReceipt = receipt.state === "UPDATED" && receipt.deployment_generation === generation &&
        acknowledged?.project_id === intent.projectId && acknowledged.title === intent.title &&
        acknowledged.revision > intent.revision && sameIds(acknowledged.source_ids, intent.nextSourceIds);
      const acknowledgedState: ProjectAttachmentState = { ...pending, phase: "unknown", receipt };
      store.write(acknowledgedState);
      if (!validReceipt) return acknowledgedState;
      try {
        const row = await readProject(signal, intent);
        return finishReadback(row, acknowledgedState);
      } catch {
        return acknowledgedState;
      }
    },

    async readStatus(signal: AbortSignal): Promise<ProjectAttachmentState | undefined> {
      const existing = store.read();
      if (existing === undefined || existing.phase === "confirmed" || !privacy.isCurrent(context)) return existing;
      try {
        return finishReadback(await readProject(signal, existing.intent), existing);
      } catch {
        return existing;
      }
    },
  };
}
