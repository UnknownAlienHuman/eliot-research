import type { ProjectClientGrant } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import { clientGrantIdentifier, prepareClientGrantMutation, readClientGrants,
  sendClientGrantMutation, type ClientGrantMutation } from "./client-grant-api.js";
import { clientGrantCheckCommand, clientGrantLocalTime, clientGrantMarkup, clientGrantRows } from "./client-grant-view.js";
import { readProjects } from "./project-api.js";

interface ClientGrantPanelOptions {
  readonly deploymentGeneration: () => string | undefined;
  readonly healthReady: () => boolean;
}

/** Owner management only. Service credentials never enter this form or browser storage. */
export function mountClientGrantPanel(element: HTMLElement, options: ClientGrantPanelOptions): () => void {
  element.innerHTML = clientGrantMarkup();
  const get = <T extends Element>(selector: string): T => {
    const value = element.querySelector<T>(selector);
    if (!value) throw new Error(`Missing grant control: ${selector}`);
    return value;
  };
  const project = get<HTMLInputElement>("[data-grant-project]");
  const suggestions = get<HTMLDataListElement>("#client-grant-project-options");
  const status = get<HTMLElement>("[data-grant-status]");
  const scope = get<HTMLElement>("[data-grant-scope]");
  const rows = get<HTMLElement>("[data-grant-list]");
  const form = get<HTMLFormElement>("[data-grant-form]");
  const fields = get<HTMLFieldSetElement>("[data-grant-fields]");
  const issuer = get<HTMLInputElement>("[data-grant-issuer]");
  const subject = get<HTMLInputElement>("[data-grant-subject]");
  const expiry = get<HTMLInputElement>("[data-grant-expiry]");
  const spendPolicy = get<HTMLInputElement>("[data-grant-spend-policy]");
  const namespaces = get<HTMLTextAreaElement>("[data-grant-namespaces]");
  const confirmation = get<HTMLElement>("[data-grant-confirm]");
  const unresolved = get<HTMLElement>("[data-grant-pending]");
  const check = get<HTMLDetailsElement>("[data-grant-check]");
  const command = get<HTMLTextAreaElement>("[data-grant-command]");
  const host = element.closest("#app") ?? element;
  const button = (name: string) => get<HTMLButtonElement>(`[data-grant-${name}]`);
  let projectId: string | undefined;
  let projectCursor: string | undefined;
  let grantCursor: string | undefined;
  let grants: readonly ProjectClientGrant[] = [];
  let editing: ProjectClientGrant | undefined;
  let pending: ClientGrantMutation | undefined;
  let controller: AbortController | undefined;
  let serial = 0;
  let busy = false;
  let disposed = false;
  let seenGeneration = options.deploymentGeneration();

  function ready(): boolean {
    return !disposed && element.isConnected && navigator.onLine && options.healthReady() &&
      options.deploymentGeneration() !== undefined && seenGeneration === options.deploymentGeneration();
  }
  function availability(): void {
    const blocked = !ready() || busy;
    for (const control of element.querySelectorAll<HTMLButtonElement>("button")) control.disabled = blocked || pending !== undefined;
    fields.disabled = blocked || pending !== undefined;
    project.disabled = blocked || pending !== undefined;
    button("retry").disabled = blocked || pending === undefined;
    button("new").disabled ||= projectId === undefined;
    button("save").disabled ||= projectId === undefined;
    button("load").disabled ||= project.value.length === 0;
    button("revoke").hidden = !editing || editing.state !== "ACTIVE";
    button("projects-next").hidden = projectCursor === undefined;
    button("next").hidden = grantCursor === undefined;
    unresolved.hidden = pending === undefined;
    get<HTMLElement>("[data-grant-pending-identity]").textContent = pending
      ? `${pending.method} · grant ${pending.grantId} · idempotency key ${pending.key}. Kept only in this page session.` : "";
  }
  function resetEditor(): void {
    editing = undefined; form.reset(); form.hidden = true; confirmation.hidden = true;
    check.hidden = true; check.open = false; command.value = "";
    get<HTMLElement>("[data-grant-confirm-copy]").textContent = "";
    get<HTMLElement>("[data-grant-identity]").textContent = "";
  }
  function clear(message: string): void {
    const uncertain = pending !== undefined;
    serial++; controller?.abort(); controller = undefined; busy = false; pending = undefined;
    grants = []; projectId = undefined; projectCursor = undefined; grantCursor = undefined;
    project.value = ""; suggestions.replaceChildren(); rows.replaceChildren(); scope.textContent = "";
    resetEditor(); seenGeneration = options.deploymentGeneration();
    status.textContent = message + (uncertain ? " The previous change may have committed; inspect current grants before issuing another change." : "");
    availability();
  }
  function begin(): { readonly token: number; readonly signal: AbortSignal; readonly generation: string } {
    if (!ready() || busy) throw new Error("Grant controls are unavailable");
    const generation = clientGrantIdentifier(options.deploymentGeneration() ?? "");
    serial++; controller?.abort(); controller = new AbortController(); busy = true; availability();
    return { token: serial, signal: controller.signal, generation };
  }
  function current(job: { readonly token: number; readonly generation: string }): boolean {
    return job.token === serial && ready() && job.generation === options.deploymentGeneration();
  }
  function finish(token: number): void { if (token === serial && !disposed) { busy = false; availability(); } }
  function failure(error: unknown): string {
    return error instanceof ApiRequestError ? `${error.message} [${error.code}${error.traceId ? ` · ${error.traceId}` : ""}]`
      : "The operation could not be confirmed. Reload grants or retry the same pending request.";
  }
  function accessLost(error: unknown): boolean {
    return error instanceof ApiRequestError && (error.status === 401 || error.status === 403 ||
      error.code.includes("GENERATION_CHANGED") || error.code.includes("GENERATION_MISMATCH") ||
      error.code === "CLIENT_GRANT_PROJECT_UNAVAILABLE");
  }
  function showPage(page: Awaited<ReturnType<typeof readClientGrants>>): void {
    grants = page.grants; grantCursor = page.next_grant_id; rows.innerHTML = clientGrantRows(grants);
    scope.textContent = `Project: ${projectId ?? ""}. This page shows the latest revision read for each grant, not a live connection status.`;
  }
  async function loadProjects(next = false): Promise<void> {
    if (!ready() || busy || pending || (next && !projectCursor)) return;
    const job = begin();
    try {
      const result = await readProjects(job.generation, next ? projectCursor : undefined, job.signal);
      if (!current(job)) return;
      suggestions.replaceChildren(...result.projects.map((item) => {
        const option = document.createElement("option"); option.value = item.project_id; option.label = item.title; return option;
      }));
      projectCursor = result.next_project_id;
      status.textContent = `${result.projects.length} project choices loaded. Select or enter a project ID and load grants.`;
    } catch (error) {
      if (job.token !== serial || disposed) return;
      if (accessLost(error)) clear(failure(error)); else status.textContent = failure(error);
    } finally { finish(job.token); }
  }
  async function loadGrants(next = false): Promise<void> {
    if (!ready() || busy || pending || (next && !grantCursor)) return;
    let selected: string;
    try { selected = clientGrantIdentifier(project.value.trim()); } catch (error) { status.textContent = failure(error); return; }
    const cursor = next && selected === projectId ? grantCursor : undefined;
    const job = begin(); projectId = selected; project.value = selected; grants = []; grantCursor = undefined;
    rows.replaceChildren(); scope.textContent = ""; resetEditor(); status.textContent = "Reading current grants…";
    try {
      const page = await readClientGrants(selected, job.generation, cursor, job.signal);
      if (!current(job) || project.value !== selected) return;
      showPage(page); status.textContent = `${page.grants.length} grant revisions loaded. New grants default to catalog read only.`;
    } catch (error) {
      if (job.token !== serial || disposed) return;
      if (accessLost(error)) clear(failure(error)); else { projectId = undefined; status.textContent = failure(error); }
    } finally { finish(job.token); }
  }
  function edit(grant?: ProjectClientGrant): void {
    if (!ready() || busy || pending || !projectId || (grant && grant.project_id !== projectId)) return;
    resetEditor(); editing = grant; form.hidden = false;
    issuer.value = grant?.grantee.issuer ?? ""; subject.value = grant?.grantee.subject ?? "";
    issuer.readOnly = grant !== undefined; subject.readOnly = grant !== undefined;
    expiry.value = grant ? clientGrantLocalTime(grant.expires_at) : "";
    namespaces.value = grant?.ingest_namespace_ids.join("\n") ?? "";
    spendPolicy.value = grant?.spend_policy_ref ?? "";
    for (const option of form.querySelectorAll<HTMLInputElement>("[data-grant-operation]")) {
      option.checked = (grant?.allowed_operations ?? ["catalog"]).some((value) => value === option.value);
    }
    get<HTMLElement>("[data-grant-heading]").textContent = grant ? "Edit existing grant" : "New grant";
    get<HTMLElement>("[data-grant-identity]").textContent = grant
      ? `${grant.grant_id} · expected revision ${grant.revision} · ${grant.state}. Identity cannot be reassigned.` : "A new grant ID is assigned when you submit.";
    button("save").textContent = grant?.state === "REVOKED" ? "Explicitly regrant access" : grant ? "Save new revision" : "Issue grant";
    if (grant) {
      check.hidden = false; command.value = clientGrantCheckCommand(grant, options.deploymentGeneration() ?? "", window.location.origin);
      form.querySelector<HTMLDetailsElement>("details")?.toggleAttribute("open", grant.allowed_operations.some((op) => op !== "catalog") || grant.ingest_namespace_ids.length > 0);
    }
    availability(); (grant ? expiry : issuer).focus();
  }
  async function send(): Promise<void> {
    const attempt = pending;
    if (!attempt || !ready() || busy) return;
    if (attempt.generation !== options.deploymentGeneration()) { clear("Deployment changed. Reload current grants."); return; }
    const job = begin(); let acknowledged = false;
    status.textContent = "Saving the exact grant change…";
    try {
      const receipt = await sendClientGrantMutation(attempt, job.signal);
      if (!current(job) || pending !== attempt) return;
      acknowledged = true; pending = undefined; grants = []; grantCursor = undefined; rows.replaceChildren(); resetEditor();
      status.textContent = `Receipt acknowledged for ${receipt.grant_id}, revision ${receipt.revision}. Reading the latest grant list…`;
      const page = await readClientGrants(attempt.projectId, job.generation, undefined, job.signal);
      if (!current(job)) return;
      showPage(page); status.textContent = `Change acknowledged at revision ${receipt.revision}. Current list reloaded; use Next grants if needed. This is not a signed client connection check.`;
    } catch (error) {
      if (job.token !== serial || disposed) return;
      if (accessLost(error)) clear(failure(error));
      else if (acknowledged) status.textContent = "Mutation receipt acknowledged, but the current grant list is unavailable. Reload grants. " + failure(error);
      else if (error instanceof ApiRequestError && [400, 409, 413, 415].includes(error.status) &&
          error.code.startsWith("CLIENT_GRANT_")) {
        pending = undefined; grants = []; rows.replaceChildren(); resetEditor();
        status.textContent = "Change rejected; load current grants before editing. " + failure(error);
        projectId = undefined; grantCursor = undefined;
      } else status.textContent = "Outcome unknown. Use Retry same request, without changing its identity. " + failure(error);
    } finally { finish(job.token); }
  }
  function submit(event: Event): void {
    event.preventDefault();
    if (!ready() || busy || pending || !projectId || form.hidden || !form.reportValidity()) return;
    try {
      const expiresAt = editing && expiry.value === clientGrantLocalTime(editing.expires_at)
        ? editing.expires_at : new Date(expiry.value).toISOString();
      pending = prepareClientGrantMutation(projectId, options.deploymentGeneration() ?? "", {
        grantee: { issuer: issuer.value.trim(), authentication_method: "service_token", subject: subject.value.trim() },
        allowed_operations: [...form.querySelectorAll<HTMLInputElement>("[data-grant-operation]:checked")].map((input) => input.value),
        ingest_namespace_ids: namespaces.value.split(/\r?\n/u).map((id) => id.trim()).filter(Boolean), expires_at: expiresAt,
        expected_revision: editing?.revision ?? 0,
        ...(spendPolicy.value.trim() === "" ? {} : { spend_policy_ref: spendPolicy.value.trim() }),
      }, editing);
      confirmation.hidden = true; void send();
    } catch (error) { status.textContent = failure(error); availability(); }
  }
  function click(event: Event): void {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (!target || !element.contains(target) || target.disabled || !ready() || busy) return;
    if (target.hasAttribute("data-grant-retry")) { void send(); return; }
    if (pending) return;
    if (target.hasAttribute("data-grant-load")) void loadGrants();
    else if (target.hasAttribute("data-grant-next")) void loadGrants(true);
    else if (target.hasAttribute("data-grant-projects")) void loadProjects();
    else if (target.hasAttribute("data-grant-projects-next")) void loadProjects(true);
    else if (target.hasAttribute("data-grant-new")) edit();
    else if (target.hasAttribute("data-grant-close")) { resetEditor(); availability(); }
    else if (target.hasAttribute("data-grant-edit")) {
      const index = Number(target.dataset.grantEdit);
      if (Number.isSafeInteger(index) && grants[index]) edit(grants[index]);
    } else if (target.hasAttribute("data-grant-revoke") && editing?.state === "ACTIVE") {
      confirmation.hidden = false;
      get<HTMLElement>("[data-grant-confirm-copy]").textContent = `Revoke ${editing.grantee.subject} in ${editing.project_id} at revision ${editing.revision}? Old execution rights must not be revived by a later regrant.`;
      button("confirm-revoke").focus();
    } else if (target.hasAttribute("data-grant-cancel-revoke")) confirmation.hidden = true;
    else if (target.hasAttribute("data-grant-confirm-revoke") && !confirmation.hidden && editing?.state === "ACTIVE" && projectId) {
      try {
        pending = prepareClientGrantMutation(projectId, options.deploymentGeneration() ?? "", { expected_revision: editing.revision }, editing, true);
        confirmation.hidden = true; void send();
      } catch (error) { status.textContent = failure(error); }
    }
  }
  const projectChanged = (): void => {
    if (pending) { project.value = pending.projectId; return; }
    if (projectId !== undefined && project.value !== projectId) {
      serial++; controller?.abort(); busy = false; projectId = undefined; grantCursor = undefined;
      grants = []; rows.replaceChildren(); scope.textContent = ""; resetEditor();
      status.textContent = "Load grants for the newly selected project.";
    }
    availability();
  };
  const health = (): void => {
    if (!options.healthReady() || seenGeneration !== options.deploymentGeneration()) clear("Workspace readiness or deployment changed. Reload grants when available.");
    else availability();
  };
  const offline = (): void => clear("Offline. Private grant state cleared.");
  const denied = (): void => clear("Authorization changed. Private grant state cleared.");
  element.addEventListener("click", click); form.addEventListener("submit", submit); project.addEventListener("input", projectChanged);
  host.addEventListener("eliotr:health-updated", health); host.addEventListener("eliotr:health-lost", health);
  window.addEventListener("offline", offline); window.addEventListener("online", health);
  window.addEventListener("eliotr:authorization-cleared", denied);
  availability();
  return () => {
    disposed = true; clear("Grant panel closed.");
    element.removeEventListener("click", click); form.removeEventListener("submit", submit); project.removeEventListener("input", projectChanged);
    host.removeEventListener("eliotr:health-updated", health); host.removeEventListener("eliotr:health-lost", health);
    window.removeEventListener("offline", offline); window.removeEventListener("online", health);
    window.removeEventListener("eliotr:authorization-cleared", denied);
  };
}
