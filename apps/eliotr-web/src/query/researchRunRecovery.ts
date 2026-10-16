import type { ResearchRunLaunchView, ResearchRunStatusView } from "@eliotr/owner-api-client";
import { isWorkspaceRequestError, type BoundWorkspaceApis } from "../app/runtime";
import type { PrivacyController, SessionContext } from "../app/privacy";
import { ProtectedReadClosedError, runProtectedRead } from "./client";
import { matchesResearchRunLaunch } from "./research";

type RunsApi = Pick<BoundWorkspaceApis["research"]["runs"], "recoverResearchRun" | "readResearchRunStatus">;
export interface ResearchRunRecoveryMemory {
  readonly workflowInstanceId: string;
  readonly phase: "recovering" | "reading" | "unknown" | "checked" | "blocked" | "observed";
  readonly firstCause?: NonNullable<ResearchRunStatusView["failure"]>;
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
  return first && latest && (first.code !== latest.code || first.stage !== latest.stage || first.phase !== latest.phase)
    ? first : latest ?? first;
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
