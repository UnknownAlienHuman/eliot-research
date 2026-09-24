import { ApiRequestError, isAuthorizationLoss, requestApi } from "./api.js";
import {
  decodeResearchRunStatus, readResearchArtifact, readReauthorizedResearchArtifact,
  type ResearchArtifactDraftReauthorizationView, type ResearchRunStatusView,
} from "./research-run-api.js";
import type { ArtifactRevision } from "@eliotr/contracts";

export interface OpenedRunArtifact {
  readonly artifact: ArtifactRevision;
  readonly reauthorized?: ResearchArtifactDraftReauthorizationView;
}

/** Legacy author GET stays unchanged. A non-author owner uses the existing
 * independently authorized POST reader; a denial is never treated as success. */
export async function openRunArtifact(view: ResearchRunStatusView, signal: AbortSignal): Promise<OpenedRunArtifact | undefined> {
  if (view.answer.availability !== "draft") return undefined;
  try {
    return { artifact: await readResearchArtifact(view.answer.artifact_ref, view.deployment_generation, signal) };
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.status !== 404 || error.code !== "ARTIFACT_DRAFT_READ_NOT_FOUND") throw error;
    if (signal.aborted) throw new DOMException("Report read cancelled", "AbortError");
    const reauthorized = await readReauthorizedResearchArtifact(view.answer.artifact_ref, view.deployment_generation, signal);
    return { artifact: reauthorized.artifact, reauthorized };
  }
}

/** A reauthorized read does not confer Wiki/publication authority. */
export function runArtifactRenderOptions(view: ResearchRunStatusView, opened: OpenedRunArtifact, renderSerial: number) {
  const reauthorized = opened.reauthorized;
  return { renderSerial, deploymentGeneration: view.deployment_generation, historical: reauthorized !== undefined,
    ...(reauthorized === undefined ? { workflowInstanceId: view.workflow_instance_id }
      : { authorizationScopeSnapshotRef: reauthorized.authorization_scope_snapshot_ref, sourceFreshness: reauthorized.source_freshness }),
    investigationRef: `${view.investigation_ref.id}:${view.investigation_ref.revision}` };
}

type Action = "cancel" | "recover";
interface ControlHooks {
  available(): boolean;
  generation(): string | undefined;
  changed(): void;
  confirmed(view: ResearchRunStatusView): void;
  refreshStatus(id: string): void;
  clearPrivate(): void;
}

/** Thin UI over the same run and action-key protocol as HTTP/MCP. Pending means
 * unconfirmed, including after abort. No state is optimistically cancelled. */
export function mountResearchRunControls(element: HTMLElement, notice: HTMLElement, hooks: ControlHooks) {
  const cancel = element.querySelector<HTMLButtonElement>("[data-run-cancel]");
  const recover = element.querySelector<HTMLButtonElement>("[data-run-resume]");
  if (!cancel || !recover) throw new Error("Research controls are incomplete");
  let target: ResearchRunStatusView | undefined;
  let request: AbortController | undefined;
  let serial = 0;
  let disposed = false;
  const pending = new Map<string, string>();
  const refresh = () => {
    const available = !disposed && hooks.available() && !request && target?.execution_state === "ACTIVE" &&
      target.deployment_generation === hooks.generation();
    cancel.disabled = !available;
    recover.disabled = !available || !["paused", "errored", "terminated", "unknown"].includes(target?.engine_status ?? "");
    cancel.setAttribute("aria-busy", String(request !== undefined));
    recover.setAttribute("aria-busy", String(request !== undefined));
  };
  const interrupt = () => {
    if (request !== undefined) {
      serial += 1; request.abort(); request = undefined;
      notice.textContent = "The control response was interrupted; the request may have succeeded. Refresh status or retry the same action.";
    }
    refresh();
  };
  const run = async (action: Action) => {
    const selected = target;
    if (disposed || request || !hooks.available() || selected?.execution_state !== "ACTIVE" ||
        selected.deployment_generation !== hooks.generation()) return;
    const identity = JSON.stringify([selected.deployment_generation, selected.workflow_instance_id, action]);
    if (!pending.has(identity)) {
      if (pending.size >= 16) {
        notice.textContent = "Several control outcomes are unconfirmed. Reconcile those runs before issuing another action."; return;
      }
      pending.set(identity, crypto.randomUUID());
    }
    const key = pending.get(identity);
    if (key === undefined) return;
    const active = ++serial;
    const local = new AbortController(); request = local;
    notice.textContent = action === "cancel" ? "Requesting stop; waiting for durable confirmation…"
      : "Requesting recovery of the same run; remaining model work may use its original budget…";
    hooks.changed(); refresh();
    let confirmed = false;
    try {
      const raw = await requestApi(`/api/v1/research/run/${encodeURIComponent(selected.workflow_instance_id)}/${action}`, {
        method: "POST", body: "{}", signal: local.signal,
        headers: { "content-type": "application/json", "idempotency-key": key },
      });
      if (active !== serial || disposed || local.signal.aborted || hooks.generation() !== selected.deployment_generation) return;
      const view = decodeResearchRunStatus(raw, selected.deployment_generation);
      if (view.workflow_instance_id !== selected.workflow_instance_id || view.investigation_ref.id !== selected.investigation_ref.id ||
          (action === "cancel" && view.execution_state !== "CANCELLED")) {
        throw new ApiRequestError({ status: 502, code: "RESEARCH_CONTROL_UNCONFIRMED", message: "Control response did not confirm the requested run" });
      }
      pending.delete(identity); target = view; confirmed = true; hooks.confirmed(view);
      notice.textContent = action === "cancel" ? "Stop confirmed in the run journal." : "Recovery request confirmed. Reading the current run state…";
    } catch (error) {
      if (active !== serial || disposed) return;
      if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.status === 403 ||
          error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) { hooks.clearPrivate(); return; }
      // Keep the original key even for an aborted or rejected response: it is not
      // proof that a previously dispatched command had no effect.
      const code = error instanceof ApiRequestError ? ` (${error.code})` : "";
      notice.textContent = `Control outcome is not confirmed${code}. Refresh status or retry the same action; do not start a replacement run.`;
    } finally {
      if (request === local) request = undefined;
      if (active === serial && !disposed) {
        refresh(); hooks.changed();
        if (confirmed) hooks.refreshStatus(selected.workflow_instance_id);
      }
    }
  };
  cancel.onclick = () => { void run("cancel"); };
  recover.onclick = () => { void run("recover"); };
  refresh();
  return {
    get busy() { return request !== undefined; }, refresh, interrupt,
    show(view?: ResearchRunStatusView) { target = view; refresh(); },
    clear() { interrupt(); target = undefined; pending.clear(); refresh(); },
    dispose() { disposed = true; interrupt(); pending.clear(); target = undefined; cancel.onclick = null; recover.onclick = null; },
  };
}
