import assert from "node:assert/strict";
/* global document: readonly, HTMLButtonElement: readonly, URL: readonly */

const WORKFLOW_ID = /^exhaustive-workflow-[a-f0-9]{64}$/u;
const JOB_ID = /^exhaustive-job-[a-f0-9]{48}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const PROTOCOL = "eliotr.exhaustive-query.v1";
const RECEIPT_KEYS = [
  "job_id", "idempotency_key", "request_digest", "scope_snapshot_id", "scope_snapshot_revision",
  "coverage_claim", "coverage_denominator_ref", "denominator_shards", "settled_shards",
  "total_scanned_sections", "total_matches", "result_artifact_ref", "coverage_receipt_ref",
];

function objectOf(value, label) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const object = objectOf(value, label);
  assert.deepEqual(Object.keys(object).sort(), [...expected].sort(), `${label} must have its exact fields`);
  return object;
}

function boundedText(value, label, maximum = 256) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.length > 0 && value.length <= maximum, `${label} must be bounded and non-empty`);
  assert.equal(value.trim(), value, `${label} must not contain surrounding whitespace`);
  assert.ok(![...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  }), `${label} must not contain control characters`);
  return value;
}

function positiveInteger(value, label) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, label) {
  assert.ok(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative integer`);
  return value;
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function launchDataOf(value, expectedGeneration) {
  const envelope = exactKeys(value, ["data", "trace_id", "deployment_generation"], "launch response");
  assert.equal(envelope.deployment_generation, expectedGeneration, "launch response must retain deployment generation");
  boundedText(envelope.trace_id, "launch trace", 128);
  const data = objectOf(envelope.data, "launch data");
  assert.ok(["protocol", "workflow_instance_id", "workflow_status"].every((key) => Object.hasOwn(data, key)),
    "launch data must contain its required fields");
  assert.ok(Object.keys(data).every((key) => ["protocol", "workflow_instance_id", "workflow_status", "job"].includes(key)),
    "launch data must not contain unknown fields");
  assert.equal(data.protocol, PROTOCOL, "launch protocol must be exhaustive workflow");
  assert.match(boundedText(data.workflow_instance_id, "workflow instance", 128), WORKFLOW_ID);
  assert.ok(["queued", "running", "paused", "waiting", "waitingForPause", "complete"].includes(data.workflow_status),
    "launch status must be a valid non-error workflow state");
  if (Object.hasOwn(data, "job")) assert.fail("launch must not claim a terminal job before status readback");
  return data;
}

function completeDataOf(value, expectedGeneration, workflowId) {
  const envelope = exactKeys(value, ["data", "trace_id", "deployment_generation"], "complete response");
  assert.equal(envelope.deployment_generation, expectedGeneration, "complete response must retain deployment generation");
  boundedText(envelope.trace_id, "complete trace", 128);
  const data = exactKeys(envelope.data, ["protocol", "workflow_instance_id", "workflow_status", "job"], "complete data");
  assert.equal(data.protocol, PROTOCOL, "complete protocol must be exhaustive workflow");
  assert.equal(data.workflow_instance_id, workflowId, "complete response must retain the launched workflow identity");
  assert.equal(data.workflow_status, "complete", "workflow must be terminal complete");
  const job = exactKeys(data.job, ["status", "receipt"], "complete job");
  assert.equal(job.status, "COMPLETE", "job must be terminal COMPLETE");
  const receipt = exactKeys(job.receipt, RECEIPT_KEYS, "complete receipt");
  assert.match(boundedText(receipt.job_id, "receipt job id", 128), JOB_ID);
  boundedText(receipt.idempotency_key, "receipt idempotency key");
  assert.match(boundedText(receipt.request_digest, "receipt request digest", 64), DIGEST);
  boundedText(receipt.scope_snapshot_id, "receipt scope snapshot", 256);
  positiveInteger(receipt.scope_snapshot_revision, "receipt scope snapshot revision");
  assert.equal(receipt.coverage_claim, "COMPLETE", "receipt must claim complete coverage");
  boundedText(receipt.coverage_denominator_ref, "receipt denominator ref");
  const denominator = positiveInteger(receipt.denominator_shards, "receipt denominator shards");
  assert.equal(receipt.settled_shards, denominator, "every denominator shard must be settled");
  nonNegativeInteger(receipt.total_scanned_sections, "receipt scanned sections");
  nonNegativeInteger(receipt.total_matches, "receipt matches");
  boundedText(receipt.result_artifact_ref, "receipt result artifact");
  boundedText(receipt.coverage_receipt_ref, "receipt coverage receipt");
  return { data, receipt };
}

async function readCompletedD1({ paths, d1Query, workflowId, receipt, idempotencyKey, sourceRevisionRef }) {
  const rows = await d1Query(paths, "CORE_DB",
    "SELECT w.workflow_id,w.job_id,w.principal_ref,w.client_class,w.credential_generation," +
    "w.deployment_generation,w.request_identity_digest,w.state AS binding_state," +
    "j.idempotency_key,j.request_digest,j.scope_snapshot_id,j.scope_snapshot_revision," +
    "j.coverage_denominator_ref,j.denominator_shards,j.settled_shards,j.total_scanned_sections," +
    "j.total_matches,j.result_artifact_ref,j.coverage_receipt_ref,j.state AS job_state " +
    `FROM retrieval_exhaustive_workflow w JOIN retrieval_exhaustive_job j ON j.job_id=w.job_id WHERE w.workflow_id=${sqlText(workflowId)} LIMIT 2`);
  assert.equal(rows.length, 1, "D1 must retain exactly one completed workflow/job binding");
  const row = rows[0];
  assert.equal(row.workflow_id, workflowId);
  assert.match(boundedText(row.job_id, "D1 job id", 128), JOB_ID);
  assert.equal(row.principal_ref, "e2e-owner", "D1 binding must retain the authenticated owner");
  assert.equal(row.client_class, "owner_pwa", "D1 binding must retain the owner client class");
  assert.equal(row.credential_generation, "credential-1", "D1 binding must retain the credential generation");
  assert.equal(row.deployment_generation, paths.generation, "D1 binding must retain the active deployment");
  assert.match(boundedText(row.request_identity_digest, "D1 request identity digest", 64), DIGEST);
  assert.equal(row.binding_state, "BOUND", "completed workflow binding must remain BOUND");
  assert.equal(row.job_state, "COMPLETE", "D1 job must remain COMPLETE");
  assert.equal(row.idempotency_key, idempotencyKey, "D1 job must retain the browser idempotency key");
  assert.equal(row.request_digest, receipt.request_digest, "D1 job request digest must match the terminal receipt");
  assert.equal(row.job_id, receipt.job_id, "D1 job identity must match the terminal receipt");
  assert.equal(row.scope_snapshot_id, receipt.scope_snapshot_id, "D1 scope snapshot must match the receipt");
  assert.equal(row.scope_snapshot_revision, receipt.scope_snapshot_revision, "D1 scope revision must match the receipt");
  assert.equal(row.coverage_denominator_ref, receipt.coverage_denominator_ref, "D1 denominator must match the receipt");
  assert.equal(row.denominator_shards, receipt.denominator_shards, "D1 denominator count must match the receipt");
  assert.equal(row.settled_shards, receipt.settled_shards, "D1 settled count must match the receipt");
  assert.equal(row.total_scanned_sections, receipt.total_scanned_sections, "D1 scanned count must match the receipt");
  assert.equal(row.total_matches, receipt.total_matches, "D1 match count must match the receipt");
  assert.equal(row.result_artifact_ref, receipt.result_artifact_ref, "D1 result artifact must match the receipt");
  assert.equal(row.coverage_receipt_ref, receipt.coverage_receipt_ref, "D1 coverage receipt must match the receipt");
  assert.ok(typeof sourceRevisionRef === "string" && sourceRevisionRef.length > 0, "raw source revision must remain bound by the selected request");
  return {
    workflow_id: row.workflow_id,
    job_id: row.job_id,
    principal_ref: row.principal_ref,
    client_class: row.client_class,
    credential_generation: row.credential_generation,
    deployment_generation: row.deployment_generation,
    binding_state: row.binding_state,
    job_state: row.job_state,
    scope_snapshot_id: row.scope_snapshot_id,
    scope_snapshot_revision: row.scope_snapshot_revision,
    source_revision_ref: sourceRevisionRef,
  };
}

/**
 * Submit one real PWA EXHAUSTIVE_JOB against the source selected by the raw
 * projection checkpoint, then read its server-issued COMPLETE receipt and the
 * persisted owner-bound D1 rows. The existing cancellation helper remains a
 * separate lifecycle proof and is intentionally not reused here.
 */
export async function runExhaustiveWorkflowCompleteBrowser({
  page, browserJson, ledger, paths, d1Query, sourceId, sourceRevisionRef, expectedGeneration,
  query = "Recorded raw owner fixture", deadlineMs = 120_000,
}) {
  boundedText(sourceId, "selected raw source id");
  boundedText(sourceRevisionRef, "selected raw source revision");
  boundedText(expectedGeneration, "expected deployment generation");
  assert.equal(typeof d1Query, "function", "Q8 completion must receive the existing owner D1 readback port");
  const panel = page.locator("#exhaustive-workflow");
  const submit = panel.locator('button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#exhaustive-workflow [data-workflow-badge]")
    ?.textContent?.trim() === "READY", null, { timeout: 15000 });
  assert.equal(await panel.locator('select[name="scope"]').inputValue(), "selected",
    "Q8 completion must use the raw source selected by the readiness checkpoint");
  await panel.locator('input[name="query"]').fill(query);
  await page.waitForFunction(() => {
    const root = document.querySelector("#exhaustive-workflow");
    const button = root?.querySelector('button[type="submit"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, null, { timeout: 15000 });

  const postRequestPromise = page.waitForRequest((request) => request.method() === "POST" &&
    new URL(request.url()).pathname === "/api/v1/research/query", { timeout: 30000 });
  const postResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/v1/research/query", { timeout: 30000 });
  await submit.click();
  const [postRequest, postResponse] = await Promise.all([postRequestPromise, postResponsePromise]);
  assert.ok([200, 202].includes(postResponse.status()), "Q8 PWA launch must return 200 or 202");
  const body = JSON.parse(postRequest.postData() ?? "{}");
  assert.deepEqual(Object.keys(body).sort(), ["budget_ref", "evidence_grade", "literals", "max_results", "product", "query", "scope_expression"].sort(),
    "Q8 request must use the exact exhaustive wire shape");
  assert.equal(body.query, query);
  assert.equal(body.product, "EXHAUSTIVE_JOB");
  assert.deepEqual(body.scope_expression, { kind: "SELECTED_SOURCES", source_ids: [sourceId] });
  assert.deepEqual(body.literals, []);
  assert.equal(body.evidence_grade, "E0");
  assert.equal(body.budget_ref, "exhaustive-job-v1");
  assert.equal(body.max_results, 16);
  const idempotencyKey = postRequest.headers()["idempotency-key"];
  boundedText(idempotencyKey, "PWA idempotency key");
  const launched = launchDataOf(await postResponse.json(), expectedGeneration);
  const workflowId = launched.workflow_instance_id;
  ledger.record({ client: "browser", method: "POST", path: "/api/v1/research/query", status: postResponse.status(),
    correlation: "e2e-exhaustive-complete/launch", token_present: false });

  const deadline = Date.now() + deadlineMs;
  let completed;
  let attempts = 0;
  while (completed === undefined) {
    attempts += 1;
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, `Q8 completion did not reach COMPLETE within ${deadlineMs}ms`);
    const status = await browserJson(page, ledger, `/api/v1/research/query/${workflowId}`, {
      correlation: `e2e-exhaustive-complete/status-${attempts}`,
    });
    assert.equal(status.status, 200, "Q8 status readback must be HTTP 200");
    const envelope = objectOf(status.data, "status response");
    const statusData = objectOf(envelope.data, "status response data");
    if (statusData.workflow_status === "errored" || statusData.workflow_status === "terminated") {
      assert.fail(`Q8 workflow became ${String(statusData.workflow_status)}`);
    }
    if (statusData.workflow_status === "complete" && statusData.job?.status === "COMPLETE") {
      completed = completeDataOf(status.data, expectedGeneration, workflowId);
      break;
    }
    const waitMs = Math.min(1500, Math.max(1, deadline - Date.now()));
    await new Promise((resolve) => globalThis.setTimeout(resolve, waitMs));
  }

  await page.waitForFunction(() => document.querySelector("#exhaustive-workflow [data-workflow-badge]")
    ?.textContent?.trim() === "COMPLETE", null, { timeout: 15000 });
  const d1 = await readCompletedD1({ paths, d1Query, workflowId, receipt: completed.receipt,
    idempotencyKey, sourceRevisionRef });
  return {
    workflowId,
    jobId: completed.receipt.job_id,
    sourceId,
    sourceRevisionRef,
    idempotencyKey,
    launchStatus: postResponse.status(),
    status: completed.data.workflow_status,
    receipt: completed.receipt,
    d1,
    api: [
      { method: "POST", path: "/api/v1/research/query", status: postResponse.status() },
      { method: "GET", path: `/api/v1/research/query/${workflowId}`, status: 200 },
    ],
    mutations: ["/api/v1/research/query"],
  };
}
