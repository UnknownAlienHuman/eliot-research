/**
 * U3-P New Project mutation controller.
 *
 * The mutation acknowledgement is not a commit. `createProject` returns a strict
 * `ProjectMutationView`, and this controller reports a committed project only after a canonical
 * `readProjects` page from the current deployment generation contains the same project identity,
 * revision and title. No success is derived from the acknowledgement, from a fixture, or from a
 * non-empty first page.
 *
 * The frozen operation identity (title, source ids, idempotency key) is retained across a lost
 * acknowledgement and across any refusal the shared classifier cannot bound. Recovery is an
 * explicit owner action that resends this exact request and key to the existing create receipt
 * path. No retry or replacement identity is minted automatically.
 *
 * The shared ER-335 classifier is the only outcome authority. `project.create` is not registered
 * in its `OPERATION_REJECTIONS` map and no pre-effect throw site for that operation is proven
 * here, so an awaited server refusal stays `OUTCOME_UNKNOWN` and preserves the identity. Nothing
 * is added to the shared map from this file.
 *
 * The controller owns no query client, no epoch, no privacy state and no UI. The card and the
 * LiveWorkspace wiring stay with their own owners.
 */

import { classifyMutationOutcome } from "@eliotr/owner-api-client";
import type {
  MutationOutcomeClassification,
  MutationOutcomeInput,
  ProjectListView,
  ProjectMutationView,
  ProjectSummary,
} from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "../app/privacy";
import type { BoundWorkspaceApis } from "../app/runtime";
import { protectedQueryKey, runProtectedRead } from "./client";

/** Mirrors the create guards in sources/projects-library/projects.ts so the panel sees a refusal before dispatch. */
export const PROJECT_MAX_TITLE_BYTES = 4 * 1024;
export const PROJECT_MAX_SOURCE_IDS = 256;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

const CREATE_OPERATION = "project.create";
const MAX_PROJECT_READBACK_PAGES = 32;

/**
 * The one refusal this controller treats as proven pre-effect on its own authority.
 *
 * projects.ts raises PROJECT_INPUT_INVALID from `expected`, `requestText`, `requestIdentifier`,
 * `requestSources` and `key`. Each of them runs before `epoch.capture()` and before the injected
 * seam writes a request, so no server ever saw the operation. No other code is trusted here, and
 * nothing is registered in the shared classifier.
 */
const PROVEN_PRE_EFFECT_INPUT_CODE = "PROJECT_INPUT_INVALID";

export type ProjectCreationPhase =
  | "idle"
  | "dispatching"
  | "reading"
  | "unconfirmed"
  | "refused"
  | "authorization-lost"
  | "confirmed";

/** The frozen operation identity. Same words, same bytes, same key, until the owner mints a new intent. */
export interface ProjectCreationIntent {
  readonly title: string;
  readonly sourceIds: readonly string[];
  readonly key: string;
}

export interface ProjectCreationState {
  readonly phase: ProjectCreationPhase;
  readonly title: string;
  readonly sourceIds: readonly string[];
  readonly key: string | undefined;
  /** A local input refusal message. Proven pre-effect, so the editable input survives it. */
  readonly invalid: string | undefined;
  readonly outcome: MutationOutcomeClassification | undefined;
  /** The server acknowledgement. Kept for reconciliation, never presented as a commit on its own. */
  readonly receipt: ProjectMutationView | undefined;
  /** The canonical readback row. Present only in "confirmed". */
  readonly project: ProjectSummary | undefined;
  /** The canonical page that last answered a read. Disclosure only; never the proof of a commit. */
  readonly readback: ProjectListView | undefined;
  readonly editable: boolean;
}

export interface ProjectCreationCurrentPage {
  (): ProjectListView | undefined;
}

export interface ProjectCreationOptions {
  readonly currentPage?: ProjectCreationCurrentPage;
  readonly onProjectCommitted?: (project: ProjectSummary, projects: ProjectListView) => void;
}

export interface ProjectCreationController {
  readonly getState: () => ProjectCreationState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setTitle: (value: string) => ProjectCreationState;
  readonly setSourceIds: (value: readonly string[]) => ProjectCreationState;
  readonly setKey: (value: string) => ProjectCreationState;
  readonly mintKey: () => ProjectCreationState;
  readonly submit: (signal: AbortSignal) => Promise<ProjectCreationState>;
  /** Explicitly recovers a lost create acknowledgement with the frozen request and original key. */
  readonly recoverOriginalIntent: (signal: AbortSignal) => Promise<ProjectCreationState>;
  readonly readStatus: (signal: AbortSignal) => Promise<ProjectCreationState>;
  readonly confirmReadback: (projects: ProjectListView) => ProjectCreationState;
  readonly dismiss: () => ProjectCreationState;
  /** The protected query key a panel uses to read the canonical projects page itself. */
  readonly projectsStatusQueryKey: (afterProjectId?: string) => readonly unknown[];
}

function textProblem(value: string, label: string, maximumBytes: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    new TextEncoder().encode(value).byteLength > maximumBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    return `${label} is invalid`;
  }
  return undefined;
}

function identifierProblem(value: string, label: string): string | undefined {
  return textProblem(value, label, 256) ?? (SAFE_IDENTIFIER.test(value) ? undefined : `${label} is invalid`);
}

function sourceIdsProblem(values: readonly string[]): string | undefined {
  if (!Array.isArray(values) || values.length > PROJECT_MAX_SOURCE_IDS) return "source_ids is invalid";
  const sorted = [...values].sort();
  for (const [index, value] of values.entries()) {
    const problem = identifierProblem(value, `source_ids[${index}]`);
    if (problem !== undefined) return `source_ids[${index}] is invalid`;
  }
  if (new Set(values).size !== values.length) return "source_ids contains duplicates";
  return values.every((value, index) => value === sorted[index]) ? undefined : "source_ids is not canonical";
}

function typedFailure(error: unknown): { readonly code?: string; readonly status?: number } {
  if (typeof error !== "object" || error === null) return {};
  const record = error as { readonly code?: unknown; readonly status?: unknown };
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.status === "number" ? { status: record.status } : {}),
  };
}

/** Reads a strict identity, revision, title and source set out of a canonical page. */
function canonicalMatch(project: ProjectSummary, page: ProjectListView): ProjectSummary | undefined {
  return page.projects.find(row =>
    row.project_id === project.project_id &&
    row.revision === project.revision &&
    row.title === project.title &&
    row.source_ids.length === project.source_ids.length &&
    row.source_ids.every((value, index) => value === project.source_ids[index]));
}

export function createProjectCreationController(
  apis: BoundWorkspaceApis["sources"],
  privacy: PrivacyController,
  context: SessionContext,
  options: ProjectCreationOptions = {},
): ProjectCreationController {
  const generation = context.deploymentGeneration;
  const projects = apis.projects;
  let title = "";
  let sourceIds: readonly string[] = [];
  let key: string | undefined;
  let phase: ProjectCreationPhase = "idle";
  let invalid: string | undefined;
  let outcome: MutationOutcomeClassification | undefined;
  let receipt: ProjectMutationView | undefined;
  let project: ProjectSummary | undefined;
  let readback: ProjectListView | undefined;
  let creationIntent: ProjectCreationIntent | undefined;
  let notifiedIntentKey: string | undefined;
  const listeners = new Set<() => void>();

  function snapshot(): ProjectCreationState {
    return Object.freeze({
      phase, title, sourceIds, key, invalid, outcome, receipt, project, readback,
      editable: phase === "idle" || phase === "refused",
    });
  }

  function publish(): ProjectCreationState {
    const state = snapshot();
    for (const listener of listeners) listener();
    return state;
  }

  function replace(next: {
    readonly phase: ProjectCreationPhase;
    readonly invalid?: string | undefined;
    readonly outcome?: MutationOutcomeClassification | undefined;
    readonly receipt?: ProjectMutationView | undefined;
    readonly project?: ProjectSummary | undefined;
    readonly readback?: ProjectListView | undefined;
  }): ProjectCreationState {
    phase = next.phase;
    invalid = next.invalid;
    outcome = next.outcome;
    receipt = next.receipt;
    project = next.project;
    readback = next.readback;
    return publish();
  }

  function classificationOf(error: unknown): MutationOutcomeClassification {
    const failure = typedFailure(error);
    const input: MutationOutcomeInput = {
      operation: CREATE_OPERATION,
      // Dispatch provenance is deliberately true: a failure this controller observes always
      // happened after the seam wrote the request, so only a proven pre-effect code may clear an
      // intent, and the only such code is the local input guard below.
      dispatched: true,
      ...(failure.code === undefined ? {} : { code: failure.code }),
      ...(failure.status === undefined ? {} : { status: failure.status }),
    };
    return classifyMutationOutcome(input);
  }

  /** A guard that ran before the request was written. The editable input survives it. */
  function provenPreEffect(error: unknown): MutationOutcomeClassification | undefined {
    return typedFailure(error).code === PROVEN_PRE_EFFECT_INPUT_CODE ? classificationOf(error) : undefined;
  }

  function refuseBeforeEffect(message: string): ProjectCreationState {
    return replace({ phase: "refused", invalid: message, receipt: undefined, readback: undefined, project: undefined });
  }

  /** An owner session that is no longer current cannot dispatch, read back or commit. */
  function isCurrentSession(): boolean {
    return privacy.isCurrent(context);
  }

  /**
   * The canonical page must belong to the current deployment generation, must still be the page
   * the caller held when the read was requested, and must be answered inside a live session.
   */
  function assertReadback(page: ProjectListView, held: ProjectListView | undefined): void {
    if (held !== undefined && options.currentPage !== undefined && options.currentPage() !== held) {
      throw new Error("The projects page changed while the project was being read back");
    }
    if (!isCurrentSession()) throw new Error("The owner session changed before the project was read back");
    if (page.deployment_generation !== generation) {
      throw new Error("The projects readback belongs to another deployment generation");
    }
  }

  async function readbackPages(
    signal: AbortSignal,
    held: ProjectListView | undefined,
    targetProjectId: string,
  ): Promise<ProjectListView> {
    let afterProjectId: string | undefined;
    const visitedCursors = new Set<string>();
    for (let pageNumber = 0; pageNumber < MAX_PROJECT_READBACK_PAGES; pageNumber += 1) {
      const cursor = afterProjectId;
      const page = await runProtectedRead(privacy, context, signal, readSignal =>
        projects.readProjects(generation, cursor, readSignal).then(value => {
          assertReadback(value, held);
          return value;
        }));
      if (cursor !== undefined && page.projects.some(row => row.project_id <= cursor)) {
        throw new Error("The projects readback cursor moved backward");
      }
      if (page.projects.some(row => row.project_id === targetProjectId)) return page;

      const next = page.next_project_id;
      if (next === undefined) return page;
      const last = page.projects[page.projects.length - 1];
      if (last === undefined || next < last.project_id ||
          (cursor !== undefined && next <= cursor) || visitedCursors.has(next)) {
        throw new Error("The projects readback cursor did not advance");
      }
      if (targetProjectId <= next) throw new Error("The projects readback cursor passed the acknowledged project");
      visitedCursors.add(next);
      afterProjectId = next;
    }
    throw new Error("The projects readback exceeded its page limit");
  }

  /** The one commit path: an acknowledgement plus a canonical row that matches it exactly. */
  function commit(page: ProjectListView): ProjectCreationState {
    const acknowledged = receipt?.project;
    const intent = creationIntent;
    if (acknowledged === undefined || intent === undefined || intent.key !== key) {
      return replace({ phase: "unconfirmed", receipt, readback: page, project: undefined });
    }
    const matched = canonicalMatch(acknowledged, page);
    if (matched === undefined) return replace({ phase: "unconfirmed", receipt, readback: page, project: undefined });
    project = matched;
    readback = page;
    invalid = undefined;
    phase = "confirmed";
    if (notifiedIntentKey !== intent.key) {
      notifiedIntentKey = intent.key;
      options.onProjectCommitted?.(matched, page);
    }
    return publish();
  }

  /**
   * An awaited refusal or a failed read. A lost session is reported as an authorization loss, not
   * as an unknown effect, because the privacy controller already observed the loss and the caller
   * must not clear protected state from an out-of-date outcome.
   */
  function unconfirmed(error: unknown, acknowledged: ProjectMutationView | undefined): ProjectCreationState {
    if (!isCurrentSession()) {
      return replace({ phase: "authorization-lost", receipt: acknowledged, readback: undefined, project: undefined });
    }
    const proven = provenPreEffect(error);
    if (proven !== undefined && acknowledged === undefined) {
      return refuseBeforeEffect(error instanceof Error ? error.message : "The new project request was refused");
    }
    return replace({ phase: "unconfirmed", outcome: classificationOf(error), receipt: acknowledged, readback: undefined, project: undefined });
  }

  function invalidInput(message: string): ProjectCreationState {
    return refuseBeforeEffect(message);
  }

  function intentProblem(operationKey: string): string | undefined {
    return textProblem(title, "title", PROJECT_MAX_TITLE_BYTES) ??
      sourceIdsProblem(sourceIds) ??
      identifierProblem(operationKey, "idempotency key");
  }

  return {
    getState: snapshot,

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    setTitle(value: string) {
      if (phase !== "idle" && phase !== "refused") return publish();
      title = value;
      invalid = undefined;
      return publish();
    },

    setSourceIds(value: readonly string[]) {
      if (phase !== "idle" && phase !== "refused") return publish();
      sourceIds = [...value];
      invalid = undefined;
      return publish();
    },

    setKey(value: string) {
      if (phase !== "idle" && phase !== "refused") return publish();
      key = value;
      invalid = undefined;
      return publish();
    },

    /** Mint only on an explicit new owner intent. Never called by a retry or a reconciliation. */
    mintKey() {
      if (phase !== "idle" && phase !== "refused") return publish();
      key = apis.mintIntent();
      invalid = undefined;
      return publish();
    },

    async submit(signal: AbortSignal): Promise<ProjectCreationState> {
      if (!isCurrentSession()) {
        return replace({ phase: "authorization-lost", receipt: undefined, readback: undefined, project: undefined });
      }
      // Create dispatch is single-shot; only the explicit recovery method may resend uncertainty.
      if (phase === "dispatching" || phase === "reading" || phase === "unconfirmed" || phase === "confirmed") return publish();
      const operationKey = key;
      if (operationKey === undefined) return invalidInput("idempotency key is invalid");
      const problem = intentProblem(operationKey);
      if (problem !== undefined) return invalidInput(problem);
      // The identity is frozen here. Any uncertain outcome keeps this exact title, key and source set;
      // only the explicit recovery action may resend it through the existing create receipt path.
      const intent: ProjectCreationIntent = Object.freeze({
        title, sourceIds: Object.freeze([...sourceIds]), key: operationKey,
      });
      creationIntent = intent;
      phase = "dispatching";
      invalid = undefined;
      publish();
      let acknowledged: ProjectMutationView;
      try {
        acknowledged = await projects.createProject(intent.title, intent.sourceIds, intent.key, generation, signal);
      } catch (error) {
        return unconfirmed(error, undefined);
      }
      if (!isCurrentSession()) {
        return replace({ phase: "authorization-lost", receipt: acknowledged, readback: undefined, project: undefined });
      }
      receipt = acknowledged;
      phase = "reading";
      publish();
      try {
        const projectId = acknowledged.project?.project_id;
        if (projectId === undefined) throw new Error("The create acknowledgement has no project identity");
        return commit(await readbackPages(signal, options.currentPage?.(), projectId));
      } catch (error) {
        return unconfirmed(error, acknowledged);
      }
    },

    /** Replays only the frozen operation identity, and only after the owner explicitly asks. */
    async recoverOriginalIntent(signal: AbortSignal): Promise<ProjectCreationState> {
      if (!isCurrentSession()) {
        return replace({ phase: "authorization-lost", receipt, readback: undefined, project: undefined });
      }
      const intent = creationIntent;
      if (phase !== "unconfirmed" || intent === undefined || intent.key !== key ||
          intent.title !== title || intent.sourceIds.length !== sourceIds.length ||
          intent.sourceIds.some((sourceId, index) => sourceId !== sourceIds[index])) return publish();

      phase = "dispatching";
      publish();
      let acknowledged: ProjectMutationView;
      try {
        acknowledged = await projects.createProject(intent.title, intent.sourceIds, intent.key, generation, signal);
      } catch (error) {
        return unconfirmed(error, receipt);
      }
      if (!isCurrentSession()) {
        return replace({ phase: "authorization-lost", receipt: acknowledged, readback: undefined, project: undefined });
      }
      receipt = acknowledged;
      phase = "reading";
      publish();
      try {
        const projectId = acknowledged.project?.project_id;
        if (projectId === undefined) throw new Error("The create receipt has no project identity");
        return commit(await readbackPages(signal, options.currentPage?.(), projectId));
      } catch (error) {
        return unconfirmed(error, acknowledged);
      }
    },

    /** An explicit reconciliation read of the canonical page. It never dispatches a mutation. */
    async readStatus(signal: AbortSignal): Promise<ProjectCreationState> {
      if (!isCurrentSession()) {
        return replace({ phase: "authorization-lost", readback: undefined, project: undefined });
      }
      if (phase === "dispatching" || phase === "reading") return publish();
      const projectId = receipt?.project?.project_id;
      if (projectId === undefined || creationIntent === undefined) return publish();
      phase = "reading";
      publish();
      try {
        return commit(await readbackPages(signal, options.currentPage?.(), projectId));
      } catch (error) {
        return unconfirmed(error, receipt);
      }
    },

    /** Confirms a canonical page the panel already read through the shared projects query. */
    confirmReadback(page: ProjectListView): ProjectCreationState {
      try {
        assertReadback(page, page);
      } catch (error) {
        return unconfirmed(error, receipt);
      }
      return commit(page);
    },

    dismiss(): ProjectCreationState {
      // An unresolved attempt keeps its identity, so it is never dropped silently.
      if (phase === "dispatching" || phase === "reading" || phase === "unconfirmed") return publish();
      title = "";
      sourceIds = [];
      key = undefined;
      creationIntent = undefined;
      return replace({ phase: "idle", receipt: undefined, readback: undefined, project: undefined });
    },

    projectsStatusQueryKey(afterProjectId?: string) {
      return [...protectedQueryKey(context, "projects"), afterProjectId ?? null];
    },
  };
}

