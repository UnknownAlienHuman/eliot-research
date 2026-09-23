import { ProjectClientGrantPutSchema, type ProjectClientGrant } from "@eliotr/contracts";
import { escapeHtml } from "./html.js";

export function clientGrantMarkup(): string {
  const extra = ProjectClientGrantPutSchema.shape.allowed_operations.element.options.filter((op) => op !== "catalog");
  return `<section class="client-grant-panel" aria-labelledby="client-grant-title">
    <div class="connection-heading"><div><span class="eyebrow">Project access</span><h2 id="client-grant-title">Agent permissions</h2></div></div>
    <p>Give a service client access to one project. Enter its public Client ID, never its Client Secret. Configured permissions do not prove a client has connected.</p>
    <div class="client-grant-project"><label>Project ID<input data-grant-project list="client-grant-project-options" autocomplete="off" maxlength="256"></label>
      <datalist id="client-grant-project-options"></datalist>
      <div class="project-actions"><button class="button button--quiet" type="button" data-grant-projects>Load projects</button>
      <button class="button button--quiet" type="button" data-grant-projects-next hidden>Next projects</button>
      <button class="button" type="button" data-grant-load>Load grants</button></div></div>
    <p role="status" aria-live="polite" data-grant-status>Load projects or enter a known project ID, then load its grants.</p>
    <p data-grant-scope></p><div class="project-list" data-grant-list aria-label="Latest grant revisions"></div>
    <div class="project-actions"><button class="button button--quiet" type="button" data-grant-next hidden>Next grants</button>
      <button class="button button--quiet" type="button" data-grant-new disabled>New grant</button></div>
    <form data-grant-form autocomplete="off" hidden>
      <h3 data-grant-heading>New grant</h3><p data-grant-identity></p>
      <fieldset data-grant-fields class="client-grant-fields"><legend>Client and permissions</legend>
        <div class="client-grant-grid"><label>Access issuer<input data-grant-issuer type="url" maxlength="256" placeholder="https://team.cloudflareaccess.com" required autocomplete="off"></label>
        <label>Service Client ID<input data-grant-subject maxlength="256" placeholder="client-id.access" required autocomplete="off"></label>
        <label>Expires at (your local time)<input data-grant-expiry type="datetime-local" step="0.001" required></label></div>
        <label class="client-grant-option"><input data-grant-operation type="checkbox" value="catalog" checked>Read project catalog</label>
        <details><summary>Other declared permissions — handlers pending</summary>
          <p>These permissions can be configured, but their service handlers are not connected yet. They do not authorize paid model calls.</p>
          <div class="client-grant-options">${extra.map((op) => `<label class="client-grant-option"><input data-grant-operation type="checkbox" value="${escapeHtml(op)}">${escapeHtml(op)}</label>`).join("")}</div>
          <label>Import namespace IDs (one per line, only for import rights)<textarea data-grant-namespaces rows="3" maxlength="16448" spellcheck="false"></textarea></label>
        </details>
        <p>Spend sponsorship is not available. Read access does not grant use of the owner's model budget.</p>
      </fieldset>
      <div class="project-actions"><button class="button" type="submit" data-grant-save>Issue grant</button>
      <button class="button button--quiet" type="button" data-grant-close>Close editor</button>
      <button class="button button--quiet" type="button" data-grant-revoke hidden>Revoke grant…</button></div>
    </form>
    <section data-grant-confirm hidden aria-label="Confirm revocation"><p data-grant-confirm-copy></p>
      <div class="project-actions"><button class="button" type="button" data-grant-confirm-revoke>Confirm revocation</button>
      <button class="button button--quiet" type="button" data-grant-cancel-revoke>Keep grant</button></div></section>
    <section data-grant-pending hidden aria-label="Unresolved grant change"><p>The response is uncertain. Retry only this same request; no new mutation will be created.</p>
      <p data-grant-pending-identity></p><button class="button" type="button" data-grant-retry>Retry same request</button></section>
    <details data-grant-check hidden><summary>Check access from the actual service client</summary>
      <p>This owner page cannot prove possession of a service secret. On the agent's machine, set <code>CF_ACCESS_CLIENT_ID</code> and <code>CF_ACCESS_CLIENT_SECRET</code> in its private environment and run:</p>
      <textarea data-grant-command readonly rows="5" spellcheck="false" aria-label="Independent service read command"></textarea>
      <p>The command performs one authenticated, read-only catalog request. No models, imports or grant changes. It checks the current grant, not a historical revision, and reports a past read rather than ongoing access or agent presence. The generic MCP check below is separate and does not prove this grant.</p>
    </details>
  </section>`;
}
export function clientGrantRows(grants: readonly ProjectClientGrant[]): string {
  return grants.length === 0 ? "<p>No grants on this page.</p>" : grants.map((grant, index) => {
    const state = grant.state === "REVOKED" ? "Revoked" : Date.parse(grant.expires_at) <= Date.now() ? "Expired" : "Active at readback";
    return `<article class="client-grant-row"><strong>${escapeHtml(grant.grantee.subject)}</strong>
      <p>${escapeHtml(grant.grantee.issuer)}</p><p>${state} · revision ${grant.revision} · expires ${escapeHtml(grant.expires_at)}</p>
      <p>${escapeHtml(grant.allowed_operations.join(", "))}</p><p>Configured only — no signed client check recorded here.</p>
      <button class="button button--quiet" type="button" data-grant-edit="${index}">Inspect / ${grant.state === "REVOKED" ? "regrant" : "edit"}</button></article>`;
  }).join("");
}
export function clientGrantLocalTime(iso: string): string {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, -1);
}
export function clientGrantCheckCommand(grant: ProjectClientGrant, generation: string, origin: string): string {
  // Quotes cannot occur in any of these schema-validated locators; never interpolate user prose.
  if (!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/u.test(origin)) return "A deployed HTTPS origin is required for the independent client check.";
  return `node scripts/check-project-client.mjs --confirm-live --origin '${origin}' --project '${grant.project_id}' --grant '${grant.grant_id}' --generation '${generation}'`;
}
