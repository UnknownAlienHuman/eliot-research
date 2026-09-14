import { ApiRequestError, isAuthorizationLoss, requestApi } from "./api.js";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CLIENT_CLASSES = new Set(["owner_pwa", "named_api_client", "trusted_agent", "federation_client"]);

interface OwnerSession {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly expires_at: string;
  readonly client_class: string;
}

export interface OwnerSessionPanelOptions {
  readonly deploymentGeneration: () => string | undefined;
  readonly healthReady: () => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaError(message: string): never {
  throw new ApiRequestError({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH", message });
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== required.length || required.some((key) => !Object.hasOwn(value, key))) {
    schemaError(`${label} has missing or unknown fields`);
  }
}

function identifier(value: unknown, label: string, pattern = SAFE_IDENTIFIER): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value !== value.trim() ||
      /[\u0000-\u001f\u007f]/u.test(value) || !pattern.test(value)) {
    schemaError(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = identifier(value, label, /^.{1,64}$/u);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) schemaError(`${label} is invalid`);
  return text;
}

function decodeOwnerSessionEnvelope(value: unknown, expectedGeneration: string): OwnerSession {
  if (!isRecord(value)) schemaError("owner session envelope is not an object");
  exactKeys(value, ["data", "trace_id", "deployment_generation"], "owner session envelope");
  const envelopeGeneration = identifier(value.deployment_generation, "envelope deployment generation");
  if (envelopeGeneration !== expectedGeneration) {
    throw new ApiRequestError({ status: 409, code: "API_GENERATION_MISMATCH", message: "Owner session belongs to another deployment" });
  }
  const trace = identifier(value.trace_id, "envelope trace id", SAFE_TRACE_ID);
  if (!SAFE_TRACE_ID.test(trace)) schemaError("envelope trace id is invalid");
  if (!isRecord(value.data)) schemaError("owner session data is not an object");
  exactKeys(value.data, ["protocol", "principal_ref", "client_class", "credential_generation", "expires_at"], "owner session data");
  if (value.data.protocol !== "eliotr.owner-session.v1") schemaError("owner session protocol is invalid");
  const clientClass = identifier(value.data.client_class, "owner session client class");
  if (!CLIENT_CLASSES.has(clientClass)) schemaError("owner session client class is invalid");
  return {
    principal_ref: identifier(value.data.principal_ref, "owner session principal"),
    credential_generation: identifier(value.data.credential_generation, "owner session credential generation"),
    expires_at: timestamp(value.data.expires_at, "owner session expiry"),
    client_class: clientClass,
  };
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
        const response = await requestApi("/api/v1/system/session", { signal: local.signal });
        if (mine !== serial || disposed || currentGeneration() !== generation) return;
        session = decodeOwnerSessionEnvelope(response, generation);
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
