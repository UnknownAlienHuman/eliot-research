import assert from "node:assert/strict";

const PATH = "/api/v1/system/mcp-diagnostics";
const GENERATION = "browser-fixture";
const PROFILE = "managed-oauth";

function envelope(data) {
  return { data, deployment_generation: GENERATION, trace_id: "browser-diagnostic-trace" };
}

function problem(status, code, title) {
  return { type: "urn:eliotr:problem:mcp-diagnostic", title, status, code,
    trace_id: "browser-diagnostic-error", retryable: false };
}

function sendJson(response, body, status = 200) {
  if (response.destroyed) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    assert.ok(bytes <= 1024, "diagnostic fixture body must stay within the owner limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createBrowserMcpDiagnosticFixture() {
  const calls = [];
  const waiters = { issue: [], latest: [] };
  let scenario = "normal";
  let challengeNumber = 0;
  let current;
  let latest;
  let pendingIssue;
  let pendingLatest;

  const notify = (kind) => {
    const listeners = waiters[kind].splice(0);
    listeners.forEach((resolve) => resolve());
  };

  const waitForPending = (kind, timeoutMs = 5000) => {
    if (kind === "issue" ? pendingIssue !== undefined : pendingLatest !== undefined) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const listeners = waiters[kind];
        const index = listeners.indexOf(done);
        if (index >= 0) listeners.splice(index, 1);
        reject(new Error(`Diagnostic fixture did not receive delayed ${kind} request`));
      }, timeoutMs);
      const done = () => { clearTimeout(timer); resolve(); };
      waiters[kind].push(done);
    });
  };

  const issued = () => {
    const now = Date.now();
    const short = scenario === "local-expiry";
    const issuedAt = new Date(short ? now - 100 : now).toISOString();
    const expiresAt = new Date(now + (short ? 250 : 5 * 60 * 1000)).toISOString();
    const number = ++challengeNumber;
    current = {
      protocol: "eliotr.mcp.client-diagnostic.v1", status: "ISSUED",
      challenge_id: `browser-diagnostic-challenge-${number}`,
      challenge_token: `browser-diagnostic-token-${number}`,
      issued_at: issuedAt, expires_at: expiresAt,
      deployment_generation: GENERATION, auth_profile: PROFILE,
    };
    latest = { ...current, challenge_token: undefined };
    delete latest.challenge_token;
    return current;
  };

  const confirmed = () => {
    assert.ok(current, "diagnostic fixture needs an issued challenge before confirmation");
    const now = Date.now();
    const expires = Date.parse(current.expires_at);
    const observedAt = new Date(Math.min(now, expires - 1)).toISOString();
    latest = {
      protocol: current.protocol, status: "CONFIRMED", challenge_id: current.challenge_id,
      issued_at: current.issued_at, expires_at: current.expires_at,
      deployment_generation: current.deployment_generation, auth_profile: current.auth_profile,
      observation_ref: `browser-diagnostic-observation-${challengeNumber}`,
      observed_at: observedAt, trace_id: `browser-diagnostic-confirmed-${challengeNumber}`,
    };
    return latest;
  };

  const handle = async (request, response, url) => {
    assert.equal(url.pathname, PATH);
    assert.equal(url.search, "");
    if (request.method === "POST") {
      const body = await readJson(request);
      assert.deepEqual(body, {}, "diagnostic issue must send the empty strict body");
      assert.equal(request.headers["x-eliotr-csrf"], "1", "diagnostic issue must carry CSRF");
      calls.push({ method: "POST", path: PATH, csrf: request.headers["x-eliotr-csrf"], body });
      const result = issued();
      const send = () => sendJson(response, envelope(result), 201);
      if (scenario === "delayed-issue") { pendingIssue = send; notify("issue"); return; }
      return send();
    }
    assert.equal(request.method, "GET");
    assert.equal(request.headers["x-eliotr-csrf"], undefined, "latest GET must not require a browser CSRF header");
    calls.push({ method: "GET", path: PATH, csrf: null, body: null });
    if (latest === undefined) return sendJson(response, problem(404, "MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND", "Client diagnostic challenge does not exist"), 404);
    const result = scenario === "local-expiry" ? confirmed() : latest;
    const send = () => sendJson(response, envelope(result), 200);
    if (scenario === "delayed-latest" || scenario === "local-expiry") { pendingLatest = send; notify("latest"); return; }
    return send();
  };

  return {
    calls,
    handle,
    setScenario(next) { scenario = next; },
    confirmCurrent() { return confirmed(); },
    waitForPending,
    releaseIssue() { const send = pendingIssue; pendingIssue = undefined; send?.(); },
    releaseLatest() { const send = pendingLatest; pendingLatest = undefined; send?.(); },
  };
}

export async function runBrowserMcpDiagnosticCanary({ fixture, click, evaluate, wait, assertVisible, assertView, openSources }) {
  assert.equal(fixture.calls.length, 0, "mounting Connections must not fetch diagnostic state");
  await click('[data-nav-target="#connections-card"]');
  await assertView("connections", "#connections-card");
  await assertVisible("[data-diagnostic-start]", "diagnostic start");
  assert.equal(await evaluate('document.querySelector("[data-diagnostic-state]").textContent'), "Not checked");

  await click("[data-diagnostic-start]");
  await wait('document.querySelector("[data-diagnostic-state]")?.textContent === "Waiting" && document.querySelector("[data-diagnostic-json]")?.value !== "" && !document.querySelector("[data-diagnostic-start]").disabled', "diagnostic challenge issued");
  const issueCall = fixture.calls.find((call) => call.method === "POST");
  assert.deepEqual(issueCall, { method: "POST", path: PATH, csrf: "1", body: {} });
  const instruction = await evaluate(`(() => {
    const value = document.querySelector("[data-diagnostic-json]").value;
    const parsed = JSON.parse(value);
    return { raw: value, keys: Object.keys(parsed).sort(), challenge_id: parsed.challenge_id, challenge_token: parsed.challenge_token,
      copy: document.querySelector("[data-diagnostic-instruction]").textContent };
  })()`);
  assert.deepEqual(instruction.keys, ["challenge_id", "challenge_token"]);
  assert.ok(instruction.challenge_id && instruction.challenge_token);
  assert.match(instruction.copy, /eliotr_confirm_client_diagnostic/u);
  await assertVisible("[data-diagnostic-copy]", "diagnostic copy instruction");
  await click("[data-diagnostic-copy]");

  await openSources("Diagnostic source preservation");
  await assertVisible("#library [data-source]", "diagnostic source selection");
  await click("#library [data-source]");
  await wait('document.querySelector("#corpus-lens [data-result]")?.textContent.includes("scope-fixture")', "diagnostic source selection");
  assert.equal(await evaluate('document.querySelector("[data-diagnostic-json]").value'), instruction.raw, "source selection must preserve the challenge");
  await evaluate("history.back()");
  await wait('location.hash === "#connections-card" && document.querySelector("#connections-card")?.hidden === false', "Back to Connections after source preservation");
  await assertView("connections", "#connections-card");
  assert.equal(await evaluate('document.querySelector("[data-diagnostic-json]").value'), instruction.raw, "navigation must preserve the challenge");

  fixture.confirmCurrent();
  await click("[data-diagnostic-latest]");
  await wait('document.querySelector("[data-diagnostic-state]")?.textContent === "Confirmed" && !document.querySelector("[data-diagnostic-confirmation]").hidden', "diagnostic confirmation");
  assert.equal(await evaluate('document.querySelector("[data-diagnostic-json]").value'), "");
  assert.equal(await evaluate('document.querySelector("[data-diagnostic-instruction]").hidden'), true);
  assert.ok(await evaluate('document.querySelector("[data-diagnostic-confirmed-time]").textContent.length > 0'));
  assert.match(await evaluate('document.querySelector("[data-diagnostic-confirmation]").textContent'), /historical/u);
  assert.equal(await evaluate(`document.body.textContent.includes(${JSON.stringify(instruction.challenge_token)})`), false);

  fixture.setScenario("delayed-issue");
  await click("[data-diagnostic-start]");
  await fixture.waitForPending("issue");
  await evaluate('window.dispatchEvent(new Event("eliotr:authorization-cleared"))');
  await wait('document.querySelector("[data-diagnostic-state]")?.textContent === "Not checked" && document.querySelector("[data-diagnostic-json]")?.value === ""', "diagnostic authorization clearing");
  fixture.releaseIssue();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate('document.querySelector("[data-diagnostic-json]")?.value'), "");
  assert.equal(await evaluate('document.querySelector("[data-diagnostic-state]")?.textContent'), "Not checked");

  fixture.setScenario("normal");
  await click("[data-diagnostic-start]");
  await wait('document.querySelector("[data-diagnostic-state]")?.textContent === "Waiting" && !document.querySelector("[data-diagnostic-latest]").disabled', "diagnostic retry after authorization clearing");
  fixture.setScenario("delayed-latest");
  await click("[data-diagnostic-latest]");
  await fixture.waitForPending("latest");
  await evaluate('document.querySelector("#app").dataset.healthGeneration = "browser-fixture-next"');
  fixture.releaseLatest();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate('document.querySelector("[data-diagnostic-state]")?.textContent'), "Not checked");
  assert.equal(await evaluate('document.querySelector("[data-diagnostic-json]")?.value'), "");
  await evaluate('document.querySelector("#app").dataset.healthGeneration = "browser-fixture"; window.dispatchEvent(new Event("eliotr:health-updated", { bubbles: true }))');

  fixture.setScenario("local-expiry");
  await click("[data-diagnostic-start]");
  await wait('document.querySelector("[data-diagnostic-state]")?.textContent === "Waiting" && document.querySelector("[data-diagnostic-json]")?.value !== "" && !document.querySelector("[data-diagnostic-latest]").disabled', "short diagnostic challenge issued");
  await click("[data-diagnostic-latest]");
  await fixture.waitForPending("latest");
  await wait('document.querySelector("[data-diagnostic-json]")?.value === "" && document.querySelector("[data-diagnostic-state]")?.textContent === "Expired"', "local expiry clears instruction");
  fixture.releaseLatest();
  await wait('document.querySelector("[data-diagnostic-state]")?.textContent === "Confirmed" && !document.querySelector("[data-diagnostic-confirmation]").hidden && document.querySelector("[data-diagnostic-json]")?.value === ""', "late confirmed result after local expiry");
}
