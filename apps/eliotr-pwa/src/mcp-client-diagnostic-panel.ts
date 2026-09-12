import type {
  McpDiagnosticChallengeResult,
  McpDiagnosticLatestStatus,
} from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import {
  getLatestMcpClientDiagnostic,
  issueMcpClientDiagnostic,
} from "./mcp-client-diagnostic-api.js";

type ConfirmedStatus = Extract<McpDiagnosticLatestStatus, { status: "CONFIRMED" }>;
type PanelState = "not-checked" | "checking" | "waiting" | "confirmed" | "expired" | "unavailable";

export interface McpClientDiagnosticPanelOptions {
  readonly deploymentGeneration: () => string | undefined;
  readonly healthReady: () => boolean;
}

function online(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function absoluteTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function profileLabel(value: ConfirmedStatus["auth_profile"]): string {
  return value === "managed-oauth" ? "Managed OAuth" : "Service token";
}

function apiFailure(error: unknown): {
  readonly state: PanelState;
  readonly message: string;
  readonly clear: boolean;
} {
  if (error instanceof ApiRequestError) {
    if (error.status === 401 || error.status === 403) {
      return {
        state: "not-checked",
        message: "Authorization changed. The client check was cleared; sign in again before retrying.",
        clear: true,
      };
    }
    if (error.status === 404 && error.code === "MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND") {
      return {
        state: "not-checked",
        message: "No confirmed client call is recorded for this owner and deployment.",
        clear: false,
      };
    }
    if (error.status === 409 || error.code === "API_GENERATION_MISMATCH") {
      return {
        state: "not-checked",
        message: "This client check no longer matches the current deployment. Refresh the server check and start again.",
        clear: true,
      };
    }
    return {
      state: "unavailable",
      message: error.retryable
        ? "Client check is temporarily unavailable. Try again when the server responds."
        : "Client check could not be completed.",
      clear: false,
    };
  }
  return {
    state: "unavailable",
    message: "Client check is temporarily unavailable. Try again when the server responds.",
    clear: false,
  };
}

/**
 * Manual owner flow for confirming one real MCP client call. The challenge is
 * kept only in this closure and is never fetched, persisted, or put in a URL.
 */
export function mountMcpClientDiagnosticPanel(
  element: HTMLElement,
  options: McpClientDiagnosticPanelOptions,
): (() => void) & { clearPrivate(): void } {
  element.innerHTML = `
    <section class="diagnostic-panel" aria-label="Client connection check">
      <div class="connection-heading">
        <div><span class="eyebrow">Client connection</span><h2>Client connection check</h2></div>
        <span class="connection-state connection-state--unknown" data-diagnostic-state>Not checked</span>
      </div>
      <p class="diagnostic-copy" data-diagnostic-intro>Run a manual check when you want to confirm a real authenticated MCP client call.</p>
      <div class="diagnostic-actions">
        <button class="button" type="button" data-diagnostic-start>Start client check</button>
        <button class="button button--quiet" type="button" data-diagnostic-latest>Check result</button>
      </div>
      <p class="diagnostic-status" role="status" aria-live="polite" data-diagnostic-status>Not checked. Start a client check when you are ready.</p>
      <section class="diagnostic-instruction" data-diagnostic-instruction hidden aria-label="MCP client instruction">
        <h3>Use this challenge in your MCP client</h3>
        <p>Call <code>eliotr_confirm_client_diagnostic</code> with this exact JSON:</p>
        <textarea data-diagnostic-json readonly rows="3" spellcheck="false" aria-label="Client diagnostic JSON arguments"></textarea>
        <div class="diagnostic-actions"><button class="button button--quiet" type="button" data-diagnostic-copy>Copy instruction</button></div>
        <p class="diagnostic-note">Use the challenge before it expires, then return here and choose Check result. It is valid for five minutes.</p>
        <p class="diagnostic-expiry" data-diagnostic-expiry></p>
      </section>
      <section class="diagnostic-confirmation" data-diagnostic-confirmation hidden aria-label="Last confirmed client call">
        <div class="diagnostic-confirmed-time"><span class="eyebrow">Last confirmed call</span><h3 data-diagnostic-confirmed-time></h3></div>
        <p class="diagnostic-copy" data-diagnostic-confirmed-copy>This is a historical confirmation from the selected deployment. It does not indicate current client presence.</p>
        <details class="diagnostic-details"><summary>Details</summary><dl class="diagnostic-facts">
          <dt>Observed</dt><dd data-diagnostic-observed></dd>
          <dt>Profile</dt><dd data-diagnostic-profile></dd>
          <dt>Deployment</dt><dd data-diagnostic-deployment></dd>
          <dt>Trace</dt><dd data-diagnostic-trace></dd>
        </dl></details>
      </section>
    </section>`;

  const stateNode = element.querySelector<HTMLElement>("[data-diagnostic-state]");
  const introNode = element.querySelector<HTMLElement>("[data-diagnostic-intro]");
  const statusNode = element.querySelector<HTMLElement>("[data-diagnostic-status]");
  const startButton = element.querySelector<HTMLButtonElement>("[data-diagnostic-start]");
  const latestButton = element.querySelector<HTMLButtonElement>("[data-diagnostic-latest]");
  const instruction = element.querySelector<HTMLElement>("[data-diagnostic-instruction]");
  const json = element.querySelector<HTMLTextAreaElement>("[data-diagnostic-json]");
  const copyButton = element.querySelector<HTMLButtonElement>("[data-diagnostic-copy]");
  const expiryNode = element.querySelector<HTMLElement>("[data-diagnostic-expiry]");
  const confirmation = element.querySelector<HTMLElement>("[data-diagnostic-confirmation]");
  const confirmedTimeNode = element.querySelector<HTMLElement>("[data-diagnostic-confirmed-time]");
  const observedNode = element.querySelector<HTMLElement>("[data-diagnostic-observed]");
  const profileNode = element.querySelector<HTMLElement>("[data-diagnostic-profile]");
  const deploymentNode = element.querySelector<HTMLElement>("[data-diagnostic-deployment]");
  const traceNode = element.querySelector<HTMLElement>("[data-diagnostic-trace]");
  if (!stateNode || !introNode || !statusNode || !startButton || !latestButton || !instruction || !json ||
      !copyButton || !expiryNode || !confirmation || !confirmedTimeNode || !observedNode || !profileNode || !deploymentNode || !traceNode) {
    throw new Error("MCP client diagnostic panel is incomplete");
  }

  let state: PanelState = "not-checked";
  let statusMessage = "Not checked. Start a client check when you are ready.";
  let challenge: McpDiagnosticChallengeResult | undefined;
  let latest: McpDiagnosticLatestStatus | undefined;
  let controller: AbortController | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let serial = 0;

  const canRequest = (): boolean => {
    const generation = options.deploymentGeneration();
    return generation !== undefined && generation !== "" && generation !== "unreachable" && online();
  };

  const statePresentation = (): { readonly label: string; readonly className: string; readonly intro: string } => {
    switch (state) {
      case "checking": return { label: "Checking", className: "pending", intro: "Contacting the owner API for a one-time client challenge." };
      case "waiting": return { label: "Waiting", className: "pending", intro: "Send the challenge through your MCP client, then check the result here." };
      case "confirmed": return { label: "Confirmed", className: "confirmed", intro: "A real authenticated MCP client call was confirmed for this deployment." };
      case "expired": return { label: "Expired", className: "blocked", intro: "The instruction expired. Check result for a confirmed call, or start a new check." };
      case "unavailable": return { label: "Unavailable", className: "blocked", intro: "The client check is unavailable until the owner API can be reached." };
      case "not-checked": return { label: "Not checked", className: "unknown", intro: "Run a manual check when you want to confirm a real authenticated MCP client call." };
    }
  };

  const render = (): void => {
    const presentation = statePresentation();
    stateNode.className = `connection-state connection-state--${presentation.className}`;
    stateNode.textContent = presentation.label;
    introNode.textContent = presentation.intro;
    statusNode.textContent = statusMessage;
    statusNode.setAttribute("aria-busy", state === "checking" ? "true" : "false");
    instruction.hidden = challenge === undefined;
    if (challenge !== undefined) {
      json.value = JSON.stringify({
        challenge_id: challenge.challenge_id,
        challenge_token: challenge.challenge_token,
      });
      expiryNode.textContent = `Expires ${absoluteTime(challenge.expires_at)}.`;
      expiryNode.setAttribute("aria-label", `Expires ${absoluteTime(challenge.expires_at)}`);
    } else {
      json.value = "";
      expiryNode.textContent = "";
      expiryNode.removeAttribute("aria-label");
    }
    const confirmed = latest?.status === "CONFIRMED" ? latest : undefined;
    confirmation.hidden = confirmed === undefined;
    if (confirmed !== undefined) {
      confirmedTimeNode.textContent = absoluteTime(confirmed.observed_at);
      observedNode.textContent = absoluteTime(confirmed.observed_at);
      profileNode.textContent = profileLabel(confirmed.auth_profile);
      deploymentNode.textContent = confirmed.deployment_generation;
      traceNode.textContent = confirmed.trace_id;
    } else {
      confirmedTimeNode.textContent = "";
      observedNode.textContent = "";
      profileNode.textContent = "";
      deploymentNode.textContent = "";
      traceNode.textContent = "";
    }
    const enabled = canRequest() && controller === undefined;
    startButton.disabled = !enabled;
    latestButton.disabled = !enabled;
    copyButton.disabled = challenge === undefined || controller !== undefined;
  };

  const stop = (): void => {
    serial += 1;
    controller?.abort();
    controller = undefined;
    if (expiryTimer !== undefined) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
  };

  const expireChallenge = (): void => {
    if (challenge === undefined) return;
    challenge = undefined;
    if (expiryTimer !== undefined) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
    state = "expired";
    statusMessage = "Instruction expired. Check result for a confirmed call, or start a new check.";
    render();
  };

  const scheduleExpiry = (issued: McpDiagnosticChallengeResult): void => {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    const delay = Math.max(0, Date.parse(issued.expires_at) - Date.now());
    const challengeId = issued.challenge_id;
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      if (challenge?.challenge_id === challengeId) expireChallenge();
    }, delay);
  };

  const clearPrivate = (message = "Client check state cleared. Reconnect before starting a new check."): void => {
    stop();
    challenge = undefined;
    latest = undefined;
    state = "not-checked";
    statusMessage = message;
    render();
  };

  const applyFailure = (error: unknown): void => {
    const failure = apiFailure(error);
    if (failure.clear) {
      clearPrivate(failure.message);
      return;
    }
    state = failure.state;
    statusMessage = failure.message;
    render();
  };

  const finish = (local: AbortController): void => {
    if (controller === local) {
      controller = undefined;
      render();
    }
  };

  const start = (): void => {
    if (!canRequest() || controller !== undefined) return;
    const generation = options.deploymentGeneration();
    if (generation === undefined) return;
    challenge = undefined;
    if (expiryTimer !== undefined) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
    const active = ++serial;
    const local = new AbortController();
    controller = local;
    state = "checking";
    statusMessage = "Requesting a one-time client challenge…";
    render();
    void issueMcpClientDiagnostic(generation, local.signal)
      .then((result) => {
        if (active !== serial) return;
        if (options.deploymentGeneration() !== generation) {
          clearPrivate("Deployment changed while the client check was running. Start again for the current deployment.");
          return;
        }
        challenge = result;
        latest = undefined;
        state = "waiting";
        statusMessage = "Challenge issued. Send the exact JSON to your MCP client, then choose Check result.";
        scheduleExpiry(result);
        render();
      })
      .catch((error: unknown) => { if (active === serial) applyFailure(error); })
      .finally(() => finish(local));
  };

  const applyLatest = (result: McpDiagnosticLatestStatus | null): void => {
    if (result === null) {
      latest = undefined;
      if (challenge === undefined) {
        state = "not-checked";
        statusMessage = "No confirmed client call is recorded for this owner and deployment.";
      } else {
        state = "waiting";
        statusMessage = "No confirmation yet. Send the challenge above, then check again.";
      }
      render();
      return;
    }
    latest = result;
    switch (result.status) {
      case "ISSUED":
        if (challenge?.challenge_id !== result.challenge_id) {
          challenge = undefined;
          if (expiryTimer !== undefined) {
            clearTimeout(expiryTimer);
            expiryTimer = undefined;
          }
        }
        state = "waiting";
        statusMessage = challenge === undefined
          ? "A challenge is waiting for this owner. Start a new client check to receive its JSON instruction."
          : "Challenge is waiting for a real MCP client call. Return here and choose Check result after sending it.";
        break;
      case "EXPIRED":
        challenge = undefined;
        if (expiryTimer !== undefined) {
          clearTimeout(expiryTimer);
          expiryTimer = undefined;
        }
        state = "expired";
        statusMessage = "The client challenge expired without confirmation. Start a new client check.";
        break;
      case "CONFIRMED":
        challenge = undefined;
        if (expiryTimer !== undefined) {
          clearTimeout(expiryTimer);
          expiryTimer = undefined;
        }
        state = "confirmed";
        statusMessage = "Last confirmed call read back from the selected deployment. This is historical, not a current presence signal.";
        break;
    }
    render();
  };

  const checkResult = (): void => {
    if (!canRequest() || controller !== undefined) return;
    const generation = options.deploymentGeneration();
    if (generation === undefined) return;
    const active = ++serial;
    const local = new AbortController();
    controller = local;
    state = "checking";
    statusMessage = "Reading the latest client check…";
    render();
    void getLatestMcpClientDiagnostic(generation, local.signal)
      .then((result) => {
        if (active !== serial) return;
        if (options.deploymentGeneration() !== generation) {
          clearPrivate("Deployment changed while the result was loading. Start again for the current deployment.");
          return;
        }
        applyLatest(result);
      })
      .catch((error: unknown) => {
        if (active !== serial) return;
        if (error instanceof ApiRequestError && error.status === 404 && error.code === "MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND") {
          applyLatest(null);
        } else {
          applyFailure(error);
        }
      })
      .finally(() => finish(local));
  };

  const copy = (): void => {
    if (challenge === undefined || controller !== undefined) return;
    if (Date.parse(challenge.expires_at) <= Date.now()) {
      expireChallenge();
      return;
    }
    const value = `Call eliotr_confirm_client_diagnostic with exactly this JSON:\n${json.value}`;
    const active = serial;
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
      statusMessage = "Copy is unavailable in this browser. Select the JSON and copy it explicitly.";
      render();
      return;
    }
    statusMessage = "Copying the exact client instruction…";
    render();
    void navigator.clipboard.writeText(value)
      .then(() => { if (active === serial && challenge !== undefined) { statusMessage = "JSON copied. Send it to your MCP client, then choose Check result."; render(); } })
      .catch(() => { if (active === serial && challenge !== undefined) { statusMessage = "Copy was not completed. Select the JSON and copy it explicitly."; render(); } });
  };

  const appRoot = element.closest<HTMLElement>("#app");
  const onHealthLost = (): void => {
    const hadPrivateState = challenge !== undefined || latest !== undefined || controller !== undefined;
    clearPrivate(hadPrivateState
      ? "Server or deployment state changed. The client check was cleared; refresh and start again."
      : "Check the server before starting a client check.");
  };
  const onHealthUpdated = (): void => render();
  const onAuthorizationCleared = (): void => clearPrivate("Authorization changed. The client check was cleared; sign in again before retrying.");
  const onOffline = (): void => clearPrivate("Offline. The client check was cleared; reconnect before starting again.");
  const onPagehide = (): void => clearPrivate("Page closed. The client check was cleared from memory.");

  startButton.addEventListener("click", start);
  latestButton.addEventListener("click", checkResult);
  copyButton.addEventListener("click", copy);
  appRoot?.addEventListener("eliotr:health-lost", onHealthLost);
  window.addEventListener("eliotr:health-updated", onHealthUpdated);
  window.addEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
  window.addEventListener("offline", onOffline);
  window.addEventListener("pagehide", onPagehide, { once: true });
  render();

  const cleanup = (() => {
    stop();
    startButton.removeEventListener("click", start);
    latestButton.removeEventListener("click", checkResult);
    copyButton.removeEventListener("click", copy);
    appRoot?.removeEventListener("eliotr:health-lost", onHealthLost);
    window.removeEventListener("eliotr:health-updated", onHealthUpdated);
    window.removeEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("pagehide", onPagehide);
    clearPrivate("Client check state cleared.");
  }) as (() => void) & { clearPrivate(): void };
  cleanup.clearPrivate = clearPrivate;
  return cleanup;
}
