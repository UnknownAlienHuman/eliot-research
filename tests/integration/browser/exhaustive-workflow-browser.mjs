import assert from "node:assert/strict";
/* global document: readonly, HTMLButtonElement: readonly */

const WORKFLOW_ID = /^exhaustive-workflow-[a-f0-9]{64}$/u;
const PROTOCOL = "eliotr.exhaustive-query.v1";

function dataOf(outcome, label) {
  assert.ok(outcome && typeof outcome.data === "object" && outcome.data !== null,
    `${label}: response must be a JSON object`);
  const data = outcome.data.data;
  assert.ok(data && typeof data === "object", `${label}: response envelope must contain data`);
  assert.equal(data.protocol, PROTOCOL, `${label}: protocol must be exhaustive workflow`);
  assert.match(data.workflow_instance_id, WORKFLOW_ID, `${label}: workflow ID must be canonical`);
  return data;
}

function recoveryPageOf(outcome, label, workflowId) {
  assert.ok(outcome && typeof outcome.data === "object" && outcome.data !== null,
    `${label}: response must be a JSON object`);
  const data = outcome.data.data;
  assert.ok(data && typeof data === "object", `${label}: response envelope must contain data`);
  assert.equal(data.protocol, "eliotr.exhaustive-workflow-page.v1", `${label}: protocol must be workflow page`);
  assert.ok(Array.isArray(data.items), `${label}: workflow page items must be an array`);
  const item = data.items.find((candidate) => candidate?.workflow_instance_id === workflowId);
  assert.ok(item, `${label}: workflow page must contain the selected workflow identity`);
  assert.equal(item.workflow_instance_id, workflowId, `${label}: discovered workflow identity must match`);
  return data;
}

/**
 * Drive one real exhaustive workflow through the built PWA and its same-origin
 * local bridge. The helper deliberately cancels the job after the UI receives
 * its server-issued workflow ID, then reloads and recovers that same identity
 * through the owner jobs list. It proves launch, status, DELETE and recovery
 * readback without claiming projection completion from a fixture.
 */
export async function runExhaustiveWorkflowBrowser({ page, browserJson, ledger, query = "Pinned", beforeReload, beforeRecoverySelection }) {
  const panel = page.locator("#exhaustive-workflow");
  const submit = panel.locator('button[type="submit"]');
  await page.waitForFunction(() => {
    const root = document.querySelector("#exhaustive-workflow");
    const button = root?.querySelector('button[type="submit"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, null, { timeout: 15000 });
  assert.equal((await panel.locator("[data-workflow-badge]").textContent())?.trim(), "READY",
    "the PWA must decode current ready health before offering the exhaustive launch");
  await panel.locator('input[name="query"]').fill(query);
  await submit.click();
  await page.waitForFunction(() => {
    const value = document.querySelector("#exhaustive-workflow")?.getAttribute("data-workflow-id");
    return typeof value === "string" && /^exhaustive-workflow-[a-f0-9]{64}$/u.test(value);
  }, null, { timeout: 15000 });
  const workflowId = await panel.getAttribute("data-workflow-id");
  assert.match(workflowId, WORKFLOW_ID, "UI must retain the server workflow ID for reconciliation");

  const status = await browserJson(page, ledger, `/api/v1/research/query/${workflowId}`, {
    correlation: "e2e-exhaustive/status-before-cancel",
  });
  const statusData = dataOf(status, "status before cancel");
  assert.equal(statusData.workflow_instance_id, workflowId);
  assert.ok(["queued", "running", "paused", "waiting", "waitingForPause", "complete", "errored", "terminated", "unknown"].includes(statusData.workflow_status),
    "status must use the backend workflow enum");
  assert.ok(["queued", "running", "paused", "waiting", "waitingForPause"].includes(statusData.workflow_status),
    `cancel acceptance requires an observed non-terminal workflow, got ${statusData.workflow_status}`);

  const cancel = panel.locator("[data-cancel]");
  await page.waitForFunction(() => {
    const button = document.querySelector("#exhaustive-workflow [data-cancel]");
    return button instanceof HTMLButtonElement && !button.disabled;
  }, null, { timeout: 15000 });
  await cancel.click();
  await page.waitForFunction(() => document.querySelector("#exhaustive-workflow .workflow-status")?.textContent?.includes("cancelled on the server") === true,
    null, { timeout: 15000 });

  const canceled = await browserJson(page, ledger, `/api/v1/research/query/${workflowId}`, {
    correlation: "e2e-exhaustive/status-after-cancel",
  });
  const canceledData = dataOf(canceled, "status after cancel");
  assert.equal(canceledData.workflow_instance_id, workflowId);
  assert.equal(canceledData.workflow_status, "terminated", "server cancellation must be terminal terminated");
  const firstWorkflowId = workflowId;

  // Reload the actual PWA, discover the terminal operation through the
  // owner-only recent-jobs endpoint, then select that same server identity.
  // The page carries no query or source bytes in this recovery DTO; the
  // explicit status GET below is the only private readback claim.
  if (beforeReload !== undefined) await beforeReload();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForFunction(() => document.querySelector("#exhaustive-workflow [data-workflow-badge]")?.textContent?.trim() === "READY",
    null, { timeout: 15000 });
  assert.equal(await panel.getAttribute("data-workflow-id"), null,
    "a PWA reload must not retain the previous workflow identity in page state");
  await page.waitForFunction((id) => Array.from(document.querySelectorAll("#exhaustive-workflow [data-recovery-workflow-id]"))
    .some((node) => node.getAttribute("data-recovery-workflow-id") === id), firstWorkflowId, { timeout: 15000 });
  const discovered = await browserJson(page, ledger, "/api/v1/research/query/jobs?limit=20", {
    correlation: "e2e-exhaustive/recovery-list",
  });
  recoveryPageOf(discovered, "recovery list", firstWorkflowId);
  if (beforeRecoverySelection !== undefined) await beforeRecoverySelection();
  await panel.locator(`[data-recovery-workflow-id="${firstWorkflowId}"]`).click();
  await page.waitForFunction((id) => {
    const root = document.querySelector("#exhaustive-workflow");
    return root?.getAttribute("data-workflow-id") === id && root.querySelector("[data-workflow-badge]")?.textContent?.trim() === "CANCELLED";
  }, firstWorkflowId, { timeout: 15000 });
  const recoveredStatus = await browserJson(page, ledger, `/api/v1/research/query/${firstWorkflowId}`, {
    correlation: "e2e-exhaustive/recovered-status",
  });
  const recoveredStatusData = dataOf(recoveredStatus, "recovered status");
  assert.equal(recoveredStatusData.workflow_instance_id, firstWorkflowId);
  assert.equal(recoveredStatusData.workflow_status, "terminated",
    "recovery selection must read back the same terminal server workflow");

  // A second deliberate launch with the same visible inputs must receive a
  // fresh durable identity after the first operation became terminal. Cancel
  // it too so the browser acceptance leaves no active Workflow behind.
  await panel.locator('input[name="query"]').fill(query);
  await submit.click();
  await page.waitForFunction((previous) => {
    const value = document.querySelector("#exhaustive-workflow")?.getAttribute("data-workflow-id");
    return typeof value === "string" && value !== previous && /^exhaustive-workflow-[a-f0-9]{64}$/u.test(value);
  }, firstWorkflowId, { timeout: 15000 });
  const relaunchedWorkflowId = await panel.getAttribute("data-workflow-id");
  assert.match(relaunchedWorkflowId, WORKFLOW_ID, "relaunch must retain a canonical server workflow ID");
  assert.notEqual(relaunchedWorkflowId, firstWorkflowId, "terminal relaunch must not reuse the cancelled workflow identity");
  const relaunchedStatus = await browserJson(page, ledger, `/api/v1/research/query/${relaunchedWorkflowId}`, {
    correlation: "e2e-exhaustive/relaunch-status-before-cancel",
  });
  const relaunchedStatusData = dataOf(relaunchedStatus, "relaunch status before cancel");
  assert.ok(["queued", "running", "paused", "waiting", "waitingForPause"].includes(relaunchedStatusData.workflow_status),
    `relaunch cancellation requires an observed non-terminal workflow, got ${relaunchedStatusData.workflow_status}`);
  await page.waitForFunction(() => {
    const button = document.querySelector("#exhaustive-workflow [data-cancel]");
    return button instanceof HTMLButtonElement && !button.disabled;
  }, null, { timeout: 15000 });
  await cancel.click();
  await page.waitForFunction(() => document.querySelector("#exhaustive-workflow .workflow-status")?.textContent?.includes("cancelled on the server") === true,
    null, { timeout: 15000 });
  const relaunchedCanceled = await browserJson(page, ledger, `/api/v1/research/query/${relaunchedWorkflowId}`, {
    correlation: "e2e-exhaustive/relaunch-status-after-cancel",
  });
  const relaunchedCanceledData = dataOf(relaunchedCanceled, "relaunch status after cancel");
  assert.equal(relaunchedCanceledData.workflow_instance_id, relaunchedWorkflowId);
  assert.equal(relaunchedCanceledData.workflow_status, "terminated", "relaunch cancellation must be terminal terminated");
  return {
    workflowId: firstWorkflowId,
    workflowIds: [firstWorkflowId, relaunchedWorkflowId],
    status: statusData.workflow_status,
    canceled: canceledData.workflow_status,
    api: [
      { method: "POST", path: "/api/v1/research/query", status: 200 },
      { method: "POST", path: "/api/v1/research/query", status: 202 },
      { method: "GET", path: `/api/v1/research/query/${firstWorkflowId}`, status: 200 },
      { method: "GET", path: "/api/v1/research/catalog?limit=20", status: 200 },
      { method: "GET", path: "/api/v1/system/health", status: 200 },
      { method: "GET", path: "/api/v1/research/query/jobs?limit=20", status: 200 },
      { method: "GET", path: `/api/v1/research/query/${relaunchedWorkflowId}`, status: 200 },
      { method: "DELETE", path: `/api/v1/research/query/${firstWorkflowId}`, status: 200 },
      { method: "DELETE", path: `/api/v1/research/query/${relaunchedWorkflowId}`, status: 200 },
    ],
    mutations: ["/api/v1/research/query", `/api/v1/research/query/${firstWorkflowId}`, `/api/v1/research/query/${relaunchedWorkflowId}`],
  };
}
