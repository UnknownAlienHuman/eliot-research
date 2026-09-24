import { ProjectClientGrantPutSchema, type ProjectClientGrant } from "@eliotr/contracts";
import { escapeHtml } from "./html.js";

export function clientGrantMarkup(): string {
  const extra = ProjectClientGrantPutSchema.shape.allowed_operations.element.options.filter((op) => op !== "catalog" && op !== "query" && op !== "evidence" && op !== "report" && op !== "status" && op !== "cancel" && op !== "recover" && op !== "run" && op !== "project.attach");
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
        <label class="client-grant-option"><input data-grant-operation type="checkbox" value="project.attach">Add admitted sources to this project (no rename or removal)</label>
        <label class="client-grant-option"><input data-grant-operation type="checkbox" value="query">Search project evidence (FAST_SEARCH over HTTP / MCP)</label>
        <label class="client-grant-option"><input data-grant-operation type="checkbox" value="run">Start project Research over HTTP / MCP (explicit spend approval required)</label>
        <label class="client-grant-option"><input data-grant-operation type="checkbox" value="status">Read project run status over HTTP / MCP</label>
        <label class="client-grant-option"><input data-grant-operation type="checkbox" value="cancel">Stop owner / own machine project runs over HTTP / MCP (separate from read access)</label>
        <label class="client-grant-option"><input data-grant-operation type="checkbox" value="recover">Recover owner / own machine project runs over HTTP / MCP (explicit spend approval required)</label>
        <label class="client-grant-option"><input data-grant-operation type="checkbox" value="report">Read authorized project reports over HTTP / MCP</label>
        <label class="client-grant-option"><input data-grant-operation type="checkbox" value="evidence">Open / verify evidence from queries or saved reports</label>
        <p>Status requires a known run ID; discovering its completed report reference also requires report permission. Saved report citations require report and evidence permissions. Only reports originally scoped to this explicit project are shared; reads never start models.</p>
        <p>Machine-run controls stay bound to the client and grant revision that created the run. Select cancel / recover before creating a run; a replacement grant does not transfer control of existing machine runs.</p>
        <details><summary>Other declared permissions — handlers pending</summary>
          <p>These permissions can be configured, but their service handlers are not connected yet. They do not authorize paid model calls.</p>
          <div class="client-grant-options">${extra.map((op) => `<label class="client-grant-option"><input data-grant-operation type="checkbox" value="${escapeHtml(op)}">${escapeHtml(op)}</label>`).join("")}</div>
          <label>Import namespace IDs (one per line, only for import rights)<textarea data-grant-namespaces rows="3" maxlength="16448" spellcheck="false"></textarea></label>
        </details>
        <label>Optional installed spend policy ID<input data-grant-spend-policy maxlength="256" autocomplete="off" spellcheck="false"></label>
        <p>Recovery may resume remaining paid stages of the same authorized owner or machine run; it does not renew expired execution. To permit it, explicitly select recover and name the installed, approved owner spend template. Its exact version, deployment and expiry are bound to this grant revision; grant expiry cannot exceed approval expiry. Changing the template requires an explicit new grant revision. Read access alone cannot spend. Starting machine Research also requires run and this explicit approval. Machine-created run reads accept a refreshed token for the original client while the original grant revision remains active. Machine controls retain their original execution deadline. Project attachment does not grant import, model spending or broader project editing rights.</p>
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
