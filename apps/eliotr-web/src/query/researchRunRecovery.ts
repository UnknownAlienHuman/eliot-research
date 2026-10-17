import type { ResearchRunLaunchView, ResearchRunStatusView } from "@eliotr/owner-api-client";
import { isWorkspaceRequestError, type BoundWorkspaceApis } from "../app/runtime";
import type { PrivacyController, SessionContext } from "../app/privacy";
import { ProtectedReadClosedError, runProtectedRead } from "./client";
import { matchesResearchRunLaunch } from "./research";

type RunsApi = Pick<BoundWorkspaceApis["research"]["runs"], "recoverResearchRun" | "readResearchRunStatus">;
type StopRunsApi = Pick<BoundWorkspaceApis["research"]["runs"], "cancelResearchRun" | "readResearchRunStatus">;
export interface ResearchRunRecoveryMemory {
  readonly workflowInstanceId: string;
  readonly phase: "recovering" | "reading" | "unknown" | "checked" | "blocked" | "observed";
  readonly firstCause?: NonNullable<ResearchRunStatusView["failure"]>;
  readonly failedRunObserved?: true;
}
export interface ResearchRunStopMemory {
  readonly workflowInstanceId: string;
  readonly phase: "stopping" | "reading" | "unknown" | "checked";
  readonly cancel_dispatched?: true;
}

/** This offers an owner control, not permission to restart a stage. The server decides safety. */
export function canRequestResearchRecovery(status: ResearchRunStatusView | undefined, launch: ResearchRunLaunchView): boolean {
  return status !== undefined && matchesResearchRunLaunch(status, launch) &&
    status.deployment_generation === launch.deployment_generation && status.execution_state === "ACTIVE" &&
    ["errored", "terminated", "paused"].includes(status.engine_status);
}

/** Prefer canonical appended consequences while retaining the first cause if a later failure replaces it. */
export function researchRecoveryFirstCause(memory: ResearchRunRecoveryMemory | undefined, status: ResearchRunStatusView | undefined) {
  const first = memory?.firstCause, latest = status?.failure;
  if (first === undefined || latest === undefined) return latest ?? first;
  if (first.code !== latest.code || first.stage !== latest.stage || first.phase !== latest.phase) return first;
  return { ...latest, ...first,
    ...(latest.consequence === undefined ? {} : { consequence: latest.consequence }),
    ...(latest.consequences === undefined ? {} : { consequences: latest.consequences }) };
}

/** Keep the first exact failed-run observation when later engine status reads detach or go unknown. */
export function rememberFailedResearchRun(
  memory: ResearchRunRecoveryMemory | undefined,
  launch: ResearchRunLaunchView,
  status: ResearchRunStatusView | undefined,
): ResearchRunRecoveryMemory | undefined {
  const held = memory?.workflowInstanceId === launch.workflow_instance_id ? memory : undefined;
  if (status === undefined || !matchesResearchRunLaunch(status, launch) ||
      status.deployment_generation !== launch.deployment_generation || status.execution_state !== "ACTIVE" ||
      (status.failure === undefined && status.engine_status !== "errored" && status.engine_status !== "terminated")) {
    return held;
  }
  const firstCause = held?.firstCause ?? status.failure;
  if (held?.failedRunObserved === true && held.firstCause === firstCause) return held;
  return Object.freeze({ workflowInstanceId: launch.workflow_instance_id, phase: held?.phase ?? "observed",
    failedRunObserved: true as const, ...(firstCause === undefined ? {} : { firstCause }) });
}

export function canStopFailedResearchRun(
  status: ResearchRunStatusView | undefined,
  launch: ResearchRunLaunchView,
  failedRunObserved: boolean,
): boolean {
  if (status === undefined) return failedRunObserved;
  return matchesResearchRunLaunch(status, launch) && status.deployment_generation === launch.deployment_generation &&
    status.execution_state === "ACTIVE" && (failedRunObserved || status.failure !== undefined ||
      status.engine_status === "errored" || status.engine_status === "terminated");
}

export function hasCanonicalResearchCancellation(
  status: ResearchRunStatusView | undefined,
  launch: ResearchRunLaunchView,
): boolean {
  return status !== undefined && matchesResearchRunLaunch(status, launch) &&
    status.deployment_generation === launch.deployment_generation && status.execution_state === "CANCELLED" &&
    status.cancellation_receipt_ref === `workflow-cancelled:${launch.workflow_instance_id}`;
}

/**
 * Stop the original failed run. An ambiguous cancel is readback-only until a fresh status proves
 * it remains active; the caller may then offer a new explicit stop action using the same run ID.
 */
export async function stopFailedResearchRun(input: {
  readonly runs: StopRunsApi;
  readonly privacy: PrivacyController;
  readonly context: SessionContext;
  readonly launch: ResearchRunLaunchView;
  readonly status?: ResearchRunStatusView;
  readonly failedRunObserved: boolean;
  readonly action: "stop" | "readback";
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly readMemory: () => ResearchRunStopMemory | undefined;
  readonly writeMemory: (memory: ResearchRunStopMemory) => void;
  readonly onStatus: (status: ResearchRunStatusView) => Promise<void>;
}): Promise<ResearchRunStatusView | undefined> {
  const assertCurrent = () => {
    if (input.signal.aborted || !input.privacy.isCurrent(input.context) || !input.isCurrent()) throw new ProtectedReadClosedError();
  };
  assertCurrent();
  if (!input.failedRunObserved) return undefined;
  const old = input.readMemory();
  const held = old?.workflowInstanceId === input.launch.workflow_instance_id ? old : undefined;
  let cancelDispatched = held?.cancel_dispatched === true;
  let revisionFloor = Math.max(input.launch.investigation_ref.revision,
    input.status?.investigation_ref.id === input.launch.investigation_ref.id
      ? input.status.investigation_ref.revision : input.launch.investigation_ref.revision);
  let stageFloor = input.status?.workflow_instance_id === input.launch.workflow_instance_id
    ? input.status.next_stage_index : 0;
  const validate = (view: ResearchRunStatusView) => {
    if (!matchesResearchRunLaunch(view, input.launch) || view.deployment_generation !== input.context.deploymentGeneration ||
        view.investigation_ref.revision < revisionFloor || view.next_stage_index < stageFloor) {
      throw new Error("Stop status does not belong to the held research revision");
    }
    revisionFloor = view.investigation_ref.revision;
    stageFloor = view.next_stage_index;
    return view;
  };
  const publish = (phase: ResearchRunStopMemory["phase"], dispatched = cancelDispatched) => {
    assertCurrent();
    cancelDispatched ||= dispatched;
    input.writeMemory({ workflowInstanceId: input.launch.workflow_instance_id, phase,
      ...(cancelDispatched ? { cancel_dispatched: true as const } : {}) });
  };
  const read = async () => {
    assertCurrent();
    const view = validate(await runProtectedRead(input.privacy, input.context, input.signal, signal =>
      input.runs.readResearchRunStatus(input.launch.workflow_instance_id, input.context.deploymentGeneration, signal)));
    assertCurrent();
    await input.onStatus(view);
    assertCurrent();
    return view;
  };
  const readOnly = input.action === "readback" || cancelDispatched || held?.phase === "stopping" ||
    held?.phase === "reading" || held?.phase === "unknown";
  if (input.status !== undefined) validate(input.status);
  publish(readOnly ? "reading" : "stopping");
  try {
    const before = await read();
    if (hasCanonicalResearchCancellation(before, input.launch)) {
      publish("checked");
      return before;
    }
    if (before.execution_state !== "ACTIVE" || readOnly) {
      publish(before.execution_state === "ACTIVE" ? cancelDispatched ? "unknown" : "checked" : "unknown");
      return undefined;
    }
    // Persist the dispatch fact before the request can lose its acknowledgement. An ACTIVE
    // readback cannot prove that an already-dispatched cancel will not commit later.
    publish("stopping", true);
    try {
      validate(await runProtectedRead(input.privacy, input.context, input.signal, signal =>
        input.runs.cancelResearchRun(input.launch.workflow_instance_id, input.context.deploymentGeneration, signal)));
      assertCurrent();
    } catch {
      assertCurrent();
      // The original identity stays held; the following GET decides whether the cancel committed.
    }
    const after = await read();
    if (hasCanonicalResearchCancellation(after, input.launch)) {
      publish("checked");
      return after;
    }
    publish("unknown", true);
    return undefined;
  } catch {
    assertCurrent();
    publish("unknown");
    return undefined;
  }
}

export const researchRecoveryCopy = {
  en: { recover: "Recover this research", check: "Check recovery status",
    recovering: "Requesting recovery of this research.", reading: "Checking this research’s saved status.",
    unknown: "The recovery outcome is unknown. Check its saved status before trying again.",
    checked: "Status checked. This research is still stopped; recovery has not been confirmed.",
    blocked: "The recovery request was refused. The original failure is retained." },
  ru: { recover: "Восстановить это исследование", check: "Проверить восстановление",
    recovering: "Запрашиваем восстановление этого исследования.", reading: "Проверяем сохранённый статус исследования.",
    unknown: "Результат восстановления неизвестен. Проверьте сохранённый статус перед повторной попыткой.",
    checked: "Статус проверен. Исследование всё ещё остановлено; восстановление не подтверждено.",
    blocked: "Запрос восстановления отклонён. Первоначальная ошибка сохранена." },
} as const;

/**
 * One control operation on the held run, using the typed client's deterministic recovery identity.
 * An interrupted/unknown operation can only read back; it never automatically posts again.
 * The protected parent owns this memory and its single pane announcement channel.
 */
export async function recoverExistingResearchRun(input: {
  readonly runs: RunsApi; readonly privacy: PrivacyController; readonly context: SessionContext;
  readonly launch: ResearchRunLaunchView; readonly status: ResearchRunStatusView;
  readonly action: "recover" | "readback"; readonly signal: AbortSignal; readonly isCurrent: () => boolean;
  readonly readMemory: () => ResearchRunRecoveryMemory | undefined;
  readonly writeMemory: (memory: ResearchRunRecoveryMemory) => void;
  readonly onStatus: (status: ResearchRunStatusView) => Promise<void>;
}): Promise<void> {
  const assertCurrent = () => {
    if (input.signal.aborted || !input.privacy.isCurrent(input.context) || !input.isCurrent()) throw new ProtectedReadClosedError();
  };
  assertCurrent();
  const old = input.readMemory();
  const held = old?.workflowInstanceId === input.launch.workflow_instance_id ? old : undefined;
  if (held?.phase === "recovering" || held?.phase === "reading") return;
  let firstCause = held?.firstCause ?? input.status.failure;
  const publish = (phase: ResearchRunRecoveryMemory["phase"]) => {
    assertCurrent();
    input.writeMemory({ workflowInstanceId: input.launch.workflow_instance_id, phase,
      ...((held?.failedRunObserved === true || firstCause !== undefined) ? { failedRunObserved: true as const } : {}),
      ...(firstCause === undefined ? {} : { firstCause }) });
  };
  let revisionFloor = input.status.investigation_ref.revision;
  let stageFloor = input.status.next_stage_index;
  const validate = (view: ResearchRunStatusView) => {
    if (!matchesResearchRunLaunch(view, input.launch) || view.deployment_generation !== input.context.deploymentGeneration ||
        view.investigation_ref.revision < revisionFloor || view.next_stage_index < stageFloor) {
      throw new Error("Recovery status does not belong to the held research revision");
    }
    revisionFloor = view.investigation_ref.revision;
    stageFloor = view.next_stage_index;
    return view;
  };
  const read = async () => {
    assertCurrent();
    const view = validate(await runProtectedRead(input.privacy, input.context, input.signal, signal =>
      input.runs.readResearchRunStatus(input.launch.workflow_instance_id, input.context.deploymentGeneration, signal)));
    assertCurrent();
    firstCause ??= view.failure;
    await input.onStatus(view);
    assertCurrent();
    return view;
  };
  const readOnly = input.action === "readback" || held?.phase === "unknown" || held?.phase === "blocked";
  validate(input.status);
  publish(readOnly ? "reading" : "recovering");
  let refused = false;
  try {
    // Re-read even on the first click: a cached failure cannot authorize a restart.
    const before = await read();
    if (readOnly || !canRequestResearchRecovery(before, input.launch)) {
      publish(canRequestResearchRecovery(before, input.launch) ? held?.phase === "blocked" ? "blocked" : "checked" : "observed");
      return;
    }
    try {
      validate(await runProtectedRead(input.privacy, input.context, input.signal, signal =>
        input.runs.recoverResearchRun(input.launch.workflow_instance_id, input.context.deploymentGeneration, signal)));
      assertCurrent();
    } catch (error) {
      assertCurrent();
      refused = isWorkspaceRequestError(error) && error.status >= 400 && error.status < 500;
      // A lost acknowledgement is never a reason to repeat this POST.
    }
    const after = await read();
    publish(refused ? "blocked" : canRequestResearchRecovery(after, input.launch) ? "checked" : "observed");
  } catch {
    assertCurrent();
    publish("unknown");
  }
}
