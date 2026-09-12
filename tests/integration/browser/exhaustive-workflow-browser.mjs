import assert from "node:assert/strict";
/* global document: readonly, HTMLButtonElement: readonly, URL: readonly */

const WORKFLOW_ID = /^exhaustive-workflow-[a-f0-9]{64}$/u;
const PROTOCOL = "eliotr.exhaustive-query.v1";
const CANCELLATION_DIAGNOSTIC_CODES = new Set([
  "INTERNAL_ERROR", "LOCAL_REQUEST_FAILED", "LOCAL_REDIRECT_DENIED",
  "RESEARCH_AUTHORITY_STALE", "RESEARCH_BUDGET_STOP", "RESEARCH_CANCELLED",
  "RESEARCH_CONFLICT", "RESEARCH_OWNER_REQUIRED", "RESEARCH_SETTLEMENT_UNCERTAIN",
  "RESEARCH_WORKFLOW_NOT_FOUND", "RESEARCH_WORKFLOW_UNAVAILABLE", "RESEARCH_INPUT_INVALID",
]);

async function showResearchView(page, label) {
  const nav = page.locator('.workspace-nav [data-nav-target="#research-card"]');
  await nav.waitFor({ state: "visible", timeout: 15000 });
  await nav.click();
  await page.waitForFunction(() => {
    const view = document.querySelector("#research-view");
    const active = document.querySelector('.workspace-nav [data-nav-target="#research-card"]');
    return view !== null && view.hidden === false && active?.getAttribute("aria-current") === "page";
  }, null, { timeout: 15000 });
  assert.equal(await nav.getAttribute("aria-current"), "page", `${label}: Research navigation must be current`);
}

function cancellationDiagnosticCode(value) {
  const candidate = value?.code ?? value?.data?.code;
  return typeof candidate === "string" && candidate.length <= 96 &&
    CANCELLATION_DIAGNOSTIC_CODES.has(candidate) ? candidate : undefined;
}

async function readCancellationResponseCode(response) {
  try {
    const contentLength = response.headers()["content-length"];
    if (typeof contentLength !== "string" || !/^\d+$/u.test(contentLength) || Number(contentLength) > 64 * 1024) return undefined;
    const text = await response.text();
    if (text.length > 64 * 1024) return undefined;
    return cancellationDiagnosticCode(JSON.parse(text));
  } catch { return undefined; }
}

async function cancellationPanelState(panel) {
  return panel.evaluate((root) => {
    const text = (selector) => root.querySelector(selector)?.textContent?.trim().slice(0, 160) ?? null;
    const disabled = (selector) => {
      const button = root.querySelector(selector);
      return button instanceof HTMLButtonElement ? button.disabled : null;
    };
    return {
      workflowId: root.getAttribute("data-workflow-id"),
      badge: text("[data-workflow-badge]"),
      status: text(".workflow-status"),
      cancelDisabled: disabled("[data-cancel]"),
      refreshDisabled: disabled("[data-refresh]"),
    };
  }).catch(() => ({ panel: "unavailable" }));
}

async function cancelAndAssertTerminated(page, panel, workflowId, label) {
  const responseDiagnostic = { status: null, code: undefined, bodyRead: null };
  const expectedPath = `/api/v1/research/query/${encodeURIComponent(workflowId)}`;
  const onResponse = (response) => {
    try {
      const request = response.request();
      if (request.method() !== "DELETE" || new URL(response.url()).pathname !== expectedPath) return;
      responseDiagnostic.status = response.status();
      responseDiagnostic.bodyRead = readCancellationResponseCode(response).then((code) => {
        if (code !== undefined) responseDiagnostic.code = code;
      }).catch(() => {});
    } catch { /* bounded diagnostics only */ }
  };
  page.on("response", onResponse);
  try {
    await panel.locator("[data-cancel]").click();
    try {
      await page.waitForFunction(() => document.querySelector("#exhaustive-workflow .workflow-status")
        ?.textContent?.includes("cancelled on the server") === true, null, { timeout: 15000 });
    } catch (error) {
      if (responseDiagnostic.bodyRead !== null) {
        await Promise.race([responseDiagnostic.bodyRead, new Promise((resolve) => globalThis.setTimeout(resolve, 500))]);
      }
      const panelState = await cancellationPanelState(panel);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${label}: cancellation did not reach terminated UI state (${reason}); ` +
        `delete_response_status=${responseDiagnostic.status ?? "unavailable"}; ` +
        `delete_response_code=${responseDiagnostic.code ?? "UNAVAILABLE"}; ` +
        `panel=${JSON.stringify(panelState)}`, { cause: error });
    }
  } finally {
    page.off("response", onResponse);
  }
}

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

async function waitForFreshWorkflowId(page, previousWorkflowId, label, launchAttempt) {
  try {
    await page.waitForFunction((previous) => {
      const value = document.querySelector("#exhaustive-workflow")?.getAttribute("data-workflow-id");
      return typeof value === "string" && value !== previous && /^exhaustive-workflow-[a-f0-9]{64}$/u.test(value);
    }, previousWorkflowId, { timeout: 15000 });
  } catch (error) {
    const panelState = await page.locator("#exhaustive-workflow").evaluate((root) => {
      const text = (selector) => root.querySelector(selector)?.textContent?.trim().slice(0, 160) ?? null;
      const buttonState = (selector) => {
        const button = root.querySelector(selector);
        return button instanceof HTMLButtonElement ? button.disabled : null;
      };
      return {
        workflowId: root.getAttribute("data-workflow-id"),
        badge: text("[data-workflow-badge]"),
        status: text(".workflow-status"),
        submitDisabled: buttonState('button[type="submit"]'),
        cancelDisabled: buttonState("[data-cancel]"),
        refreshDisabled: buttonState("[data-refresh]"),
      };
    }).catch(() => ({ panel: "unavailable" }));
    const reason = error instanceof Error ? error.message : String(error);
    const transport = launchAttempt === undefined ? null : {
      postRequests: launchAttempt.postRequests,
      postResponses: launchAttempt.postResponses,
    };
    throw new Error(`${label}: fresh workflow ID was not published (${reason}); panel=${JSON.stringify(panelState)}; transport=${JSON.stringify(transport)}`, { cause: error });
  }
}

/**
 * Drive one real exhaustive workflow through the built PWA and its same-origin
 * local bridge. The helper deliberately cancels the job after the UI receives
 * its server-issued workflow ID, then reloads and recovers that same identity
 * through the owner jobs list. It proves launch, status, DELETE and recovery
 * readback without claiming projection completion from a fixture.
 */
export async function runExhaustiveWorkflowBrowser({ page, browserJson, ledger, query = "Pinned", beforeReload, beforeRecoverySelection, beforeCancellationCheck }) {
  await showResearchView(page, "exhaustive workflow");
  const panel = page.locator("#exhaustive-workflow");
  const submit = panel.locator('button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#exhaustive-workflow [data-workflow-badge]")
    ?.textContent?.trim() === "READY", null, { timeout: 15000 });
  await panel.locator('input[name="query"]').fill(query);
  await page.waitForFunction(() => {
    const root = document.querySelector("#exhaustive-workflow");
    const button = root?.querySelector('button[type="submit"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, null, { timeout: 15000 });
  assert.equal((await panel.locator("[data-workflow-badge]").textContent())?.trim(), "READY",
    "the PWA must decode current ready health before offering the exhaustive launch");
  await submit.click();
  await page.waitForFunction(() => {
    const value = document.querySelector("#exhaustive-workflow")?.getAttribute("data-workflow-id");
    return typeof value === "string" && /^exhaustive-workflow-[a-f0-9]{64}$/u.test(value);
  }, null, { timeout: 15000 });
  const workflowId = await panel.getAttribute("data-workflow-id");
  assert.match(workflowId, WORKFLOW_ID, "UI must retain the server workflow ID for reconciliation");

  // The launch body is decoded before the ID is published, but Playwright's
  // terminal network callback can still trail that page-side completion. Settle
  // before the active witness so DELETE follows the freshest observed status.
  if (beforeCancellationCheck !== undefined) await beforeCancellationCheck();
  const status = await browserJson(page, ledger, `/api/v1/research/query/${workflowId}`, {
    correlation: "e2e-exhaustive/status-before-cancel",
  });
  const statusData = dataOf(status, "status before cancel");
  assert.equal(statusData.workflow_instance_id, workflowId);
  assert.ok(["queued", "running", "paused", "waiting", "waitingForPause", "complete", "errored", "terminated", "unknown"].includes(statusData.workflow_status),
    "status must use the backend workflow enum");
  assert.ok(["queued", "running", "paused", "waiting", "waitingForPause"].includes(statusData.workflow_status),
    `cancel acceptance requires an observed non-terminal workflow, got ${statusData.workflow_status}`);

  await page.waitForFunction(() => {
    const button = document.querySelector("#exhaustive-workflow [data-cancel]");
    return button instanceof HTMLButtonElement && !button.disabled;
  }, null, { timeout: 15000 });
  await cancelAndAssertTerminated(page, panel, workflowId, "first cancellation");

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
  await showResearchView(page, "exhaustive recovery");
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
  await page.waitForFunction((id) => {
    const root = document.querySelector("#exhaustive-workflow");
    const submit = root?.querySelector('button[type="submit"]');
    return root?.getAttribute("data-workflow-id") === id && submit instanceof HTMLButtonElement && !submit.disabled;
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
  const launchAttempt = { postRequests: 0, postResponses: [] };
  const onRequest = (request) => {
    if (request.method() !== "POST") return;
    if (new URL(request.url()).pathname === "/api/v1/research/query") launchAttempt.postRequests += 1;
  };
  const onResponse = (response) => {
    if (response.request().method() !== "POST") return;
    if (new URL(response.url()).pathname === "/api/v1/research/query") launchAttempt.postResponses.push(response.status());
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  try {
    await submit.click();
    await waitForFreshWorkflowId(page, firstWorkflowId, "terminal relaunch", launchAttempt);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("terminal relaunch:")) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`terminal relaunch submit failed (${reason}); transport=${JSON.stringify(launchAttempt)}`, { cause: error });
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
  }
  const relaunchedWorkflowId = await panel.getAttribute("data-workflow-id");
  assert.match(relaunchedWorkflowId, WORKFLOW_ID, "relaunch must retain a canonical server workflow ID");
  assert.notEqual(relaunchedWorkflowId, firstWorkflowId, "terminal relaunch must not reuse the cancelled workflow identity");
  if (beforeCancellationCheck !== undefined) await beforeCancellationCheck();
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
  await cancelAndAssertTerminated(page, panel, relaunchedWorkflowId, "relaunch cancellation");
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
    aborts: [
      `GET ${new URL(page.url()).origin}/api/v1/research/query/${firstWorkflowId} :: net::ERR_ABORTED`,
      `GET ${new URL(page.url()).origin}/api/v1/research/query/${relaunchedWorkflowId} :: net::ERR_ABORTED`,
    ],
  };
}
