import { ApiRequestError } from "./api.js";
import { beginGoogleOAuth, newGoogleOAuthOperationRef } from "./google-oauth-api.js";
import { escapeHtml } from "./html.js";

/**
 * Minimal G1 owner-only begin surface: shows connector status and the
 * server-admitted Google authorization link. The operation reference lives
 * only in memory for stable retry; no token, secret, or code enters the app
 * URL, logs, or browser storage.
 */
export function mountGoogleOAuthPanel(root: HTMLElement): () => void {
  const controller = new AbortController();
  let operationRef: string | null = null;
  let busy = false;

  const status = (text: string, tone: "pending" | "ready" | "blocked"): void => {
    const node = root.querySelector("[data-oauth-status]");
    if (node) {
      node.innerHTML = `<span class="status status--${tone}">${escapeHtml(text)}</span>`;
    }
  };

  const render = (inner: string): void => {
    root.innerHTML = `
      <section aria-label="Google Drive exchange">
        <h2>Google Drive exchange</h2>
        <p data-oauth-status><span class="status status--pending">not connected</span></p>
        <div data-oauth-result>${inner}</div>
        <button class="button button--google" type="button" data-oauth-begin>Connect Google Drive</button>
      </section>
    `;
  };

  const onClick = async (): Promise<void> => {
    if (busy || controller.signal.aborted) return;
    busy = true;
    try {
      // Mint before the first network attempt and retain across every failure,
      // so timeout/lost/invalid responses retry with the same ref (no new
      // intent). Cleared only by the explicit lifecycle reset below.
      if (operationRef === null) operationRef = newGoogleOAuthOperationRef();
      const outcome = await beginGoogleOAuth(operationRef, controller.signal);
      operationRef = outcome.operationRef;
      const result = root.querySelector("[data-oauth-result]");
      if (result) {
        result.innerHTML = `
          <p>Authorization required before any exchange use:</p>
          <p><a href="${escapeHtml(outcome.begin.authorizationUrl)}" rel="noopener">Continue with Google</a></p>
          <dl>
            <dt>Intent</dt><dd>${escapeHtml(outcome.begin.intentId)}</dd>
            <dt>Expires</dt><dd>${escapeHtml(outcome.begin.expiresAt)}</dd>
          </dl>
        `;
      }
      status("authorization pending", "pending");
    } catch (error) {
      const message = error instanceof ApiRequestError
        ? `${error.code}${error.retryable ? " (retryable)" : ""}`
        : "request failed";
      const result = root.querySelector("[data-oauth-result]");
      if (result) result.innerHTML = `<p>Connect failed: ${escapeHtml(message)}</p>`;
      status("connect failed", "blocked");
    } finally {
      busy = false;
    }
  };

  render("");
  root.querySelector("[data-oauth-begin]")?.addEventListener("click", () => void onClick(), { signal: controller.signal });
  const clear = (): void => {
    controller.abort();
    operationRef = null;
    root.innerHTML = "";
  };
  window.addEventListener("pagehide", clear, { once: true });
  return clear;
}
