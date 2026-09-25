import { ApiRequestError, isAuthorizationLoss } from "./api.js";
import { readOwnerSession, type OwnerSession } from "./owner-session-api.js";

export interface OwnerSessionPanelOptions {
  readonly deploymentGeneration: () => string | undefined;
  readonly healthReady: () => boolean;
}

function online(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function failureMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (isAuthorizationLoss(error)) return "Authorization changed. Sign in again to read the current owner session.";
    if (error.code === "API_GENERATION_MISMATCH" || error.status === 409) {
      return "The deployment changed. Refresh the server check, then read the owner session again.";
    }
    if (error.code === "API_UNREACHABLE" || error.code === "API_REQUEST_ABORTED") {
      return "The owner session could not be read. Check the server connection and retry.";
    }
  }
  return "The owner session could not be read. Retry when the server is ready.";
}

export function mountOwnerSessionPanel(
  element: HTMLElement,
  options: OwnerSessionPanelOptions,
): (() => void) & { clearPrivate(message?: string): void; refresh(): void } {
  element.innerHTML = `<details class="connection-details owner-session-panel">
    <summary>Owner session details</summary>
    <p class="connection-note" data-owner-session-summary>Current owner session has not been read.</p>
    <dl class="connection-facts" data-owner-session-facts hidden>
      <dt>Principal</dt><dd data-owner-session-principal></dd>
      <dt>Credential generation</dt><dd data-owner-session-credential></dd>
      <dt>Expires</dt><dd data-owner-session-expires></dd>
      <dt>Client class</dt><dd data-owner-session-client></dd>
    </dl>
    <div class="connection-actions"><button class="button button--quiet" type="button" data-owner-session-read>Read session</button></div>
    <p class="connection-note" data-owner-session-status role="status" aria-live="polite">Read the server-verified session when the owner API is ready.</p>
  </details>`;

  const details = element.querySelector<HTMLDetailsElement>(".owner-session-panel");
  const summary = element.querySelector<HTMLElement>("[data-owner-session-summary]");
  const facts = element.querySelector<HTMLElement>("[data-owner-session-facts]");
  const principal = element.querySelector<HTMLElement>("[data-owner-session-principal]");
  const credential = element.querySelector<HTMLElement>("[data-owner-session-credential]");
  const expires = element.querySelector<HTMLElement>("[data-owner-session-expires]");
  const client = element.querySelector<HTMLElement>("[data-owner-session-client]");
  const status = element.querySelector<HTMLElement>("[data-owner-session-status]");
  const readButton = element.querySelector<HTMLButtonElement>("[data-owner-session-read]");
  if (!details || !summary || !facts || !principal || !credential || !expires || !client || !status || !readButton) {
    throw new Error("Owner session panel is incomplete");
  }

  let disposed = false;
  let serial = 0;
  let controller: AbortController | undefined;
  let session: OwnerSession | undefined;
  let sessionGeneration: string | undefined;

  const currentGeneration = (): string | undefined => {
    const generation = options.deploymentGeneration();
    return generation === undefined || generation === "" || generation === "unreachable" ? undefined : generation;
  };
  const updateButton = (): void => {
    readButton.disabled = controller !== undefined || !options.healthReady() || !online() || currentGeneration() === undefined;
    readButton.setAttribute("aria-busy", controller === undefined ? "false" : "true");
  };
  const clearFields = (): void => {
    facts.hidden = true;
    principal.textContent = "";
    credential.textContent = "";
    expires.textContent = "";
    client.textContent = "";
  };
  const renderSession = (): void => {
    if (session === undefined) {
      clearFields();
    } else {
      facts.hidden = false;
      principal.textContent = session.principal_ref;
      credential.textContent = session.credential_generation;
      expires.textContent = session.expires_at;
      client.textContent = session.client_class;
    }
    updateButton();
  };
  const clearPrivate = (message = "Owner session details cleared. Read the current session when ready."): void => {
    serial += 1;
    controller?.abort();
    controller = undefined;
    session = undefined;
    sessionGeneration = undefined;
    summary.textContent = message;
    status.textContent = "";
    details.open = false;
    renderSession();
  };
  const refresh = (): void => {
    if (disposed || controller !== undefined) return;
    const generation = currentGeneration();
    if (!options.healthReady() || generation === undefined) {
      summary.textContent = "The owner API is not ready. Check the server before reading the session.";
      status.textContent = "";
      updateButton();
      return;
    }
    if (!online()) {
      clearPrivate("Offline. Owner session details are not cached.");
      return;
    }
    const mine = ++serial;
    const local = new AbortController();
    controller = local;
    summary.textContent = "Reading the current owner session…";
    status.textContent = "";
    updateButton();
    void (async () => {
      try {
        const response = await readOwnerSession(generation, local.signal);
        if (mine !== serial || disposed || currentGeneration() !== generation) return;
        session = response;
        sessionGeneration = generation;
        summary.textContent = "Current owner session is available.";
        status.textContent = "Read from the current deployment.";
        renderSession();
      } catch (error) {
        if (mine !== serial || disposed) return;
        session = undefined;
        sessionGeneration = undefined;
        summary.textContent = failureMessage(error);
        status.textContent = "";
        renderSession();
      } finally {
        if (controller === local) {
          controller = undefined;
          updateButton();
        }
      }
    })();
  };

  const offline = (): void => clearPrivate("Offline. Owner session details are not cached.");
  const authorizationCleared = (): void => clearPrivate("Authorization changed. Sign in again to read the current owner session.");
  const healthLost = (): void => clearPrivate("The server connection changed. Read the current owner session again when ready.");
  const healthUpdated = (): void => {
    if (session !== undefined && sessionGeneration !== currentGeneration()) {
      clearPrivate("The deployment changed. Read the current owner session again.");
      return;
    }
    updateButton();
  };
  readButton.onclick = refresh;
  window.addEventListener("offline", offline);
  window.addEventListener("eliotr:authorization-cleared", authorizationCleared);
  window.addEventListener("eliotr:health-lost", healthLost);
  window.addEventListener("eliotr:health-updated", healthUpdated);
  updateButton();

  const cleanup = (): void => {
    disposed = true;
    serial += 1;
    controller?.abort();
    controller = undefined;
    readButton.onclick = null;
    window.removeEventListener("offline", offline);
    window.removeEventListener("eliotr:authorization-cleared", authorizationCleared);
    window.removeEventListener("eliotr:health-lost", healthLost);
    window.removeEventListener("eliotr:health-updated", healthUpdated);
  };
  return Object.assign(cleanup, { clearPrivate, refresh });
}
