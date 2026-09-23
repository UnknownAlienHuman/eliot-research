import { Buffer } from "node:buffer";
import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// UI acceptance only. These controlled responses do not qualify D1, Access or a model.
export function createResearchScreenFixture({ envelope, draftWorkflowId, draftArtifact, draftSectionText, draftSectionSha, evidenceSha }) {
  const artifact = draftArtifact.artifact_ref;
  const section = draftArtifact.sections[0];
  const artifactPath = `/api/v1/research/artifact/${encodeURIComponent(`${artifact.id}:${artifact.revision}`)}`;
  const sectionPath = `${artifactPath}/sections/${encodeURIComponent(`${section.section_ref.id}:${section.section_ref.revision}`)}`;
  const scope = { id: "scope-1", revision: 1 };
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const authorization = { authorization_receipt_ref: "authorization-1", policy_authority_ref: "policy-1", allowed_use: ["READ"], disclosure_ceiling: "OWNER", expires_at: expiresAt };
  const run = { protocol: "eliotr.research-run-status.v1", workflow_instance_id: draftWorkflowId, investigation_ref: { id: `research-${"d".repeat(48)}`, revision: 1 }, execution_state: "ENGINE_COMPLETED", next_stage_index: 18, answer: { availability: "draft", artifact_ref: artifact } };
  const state = { blocked: false, starts: [], sectionReads: 0, citationReads: 0, holdSection: false, pendingSection: undefined, seen: [] };
  const handle = async (request, response, url) => {
    const path = url.pathname;
    const paths = ["/api/v1/system/research-configuration", "/api/v1/research/runs", "/api/v1/research/changes", "/api/v1/research/run", `/api/v1/research/run/${draftWorkflowId}`, `${artifactPath}/reauthorize`, `${sectionPath}/reauthorize`, `${sectionPath}/citations/reauthorize`];
    state.seen.push(`${request.method} ${path}`);
    if (!paths.includes(path)) return false;
    const json = (data) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(envelope(data))); };
    if (path === "/api/v1/system/research-configuration") {
      assert.equal(request.method, "GET");
      json({ protocol: "eliotr.research-configuration-readiness.v1", configuration: state.blocked ? "missing" : "present", model_transport: "available", qualification_state: state.blocked ? "unavailable" : "current", run_readiness: state.blocked ? "blocked" : "ready", readiness_reason: state.blocked ? "CONFIGURATION_NOT_READY" : "QUALIFICATION_PROOFS_CURRENT", model_route: "fixture-model", qualification_expires_at: expiresAt, missing_fields: state.blocked ? ["RESEARCH_AGENT_CONFIG"] : [], invalid_fields: [], checked_at: new Date().toISOString() });
    } else if (path === "/api/v1/research/runs") {
      assert.equal(request.method, "GET");
      json({ protocol: "eliotr.research-runs.v3", runs: Array.from({ length: 8 }, (_, i) => ({ created_at: `2026-09-${String(10 + i).padStart(2, "0")}T12:00:00.000Z`, status: { ...run, workflow_instance_id: i === 0 ? draftWorkflowId : `run-${String(i).repeat(48)}`, answer: { availability: "unavailable" } } })), saved_drafts: [], configuration_state: state.blocked ? "MISSING" : "INSTALLED", checked_at: new Date().toISOString() });
    } else if (path === "/api/v1/research/changes") {
      assert.equal(request.method, "POST"); json({ protocol: "eliotr.research-changes.v1", items: [], next_cursor: null, has_more: false });
    } else if (path === "/api/v1/research/run") {
      assert.equal(request.method, "POST"); assert.equal(state.blocked, false, "blocked UI must never submit a run");
      assert.ok(request.headers["idempotency-key"]);
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.deepEqual(body, { query: "draft research question", product: "RESEARCH", scope_expression: { kind: "PROJECT", project_id: "project-1" }, literals: [], evidence_grade: "E0", budget_ref: "research-budget-v1", max_results: 16 });
      state.starts.push({ body, key: request.headers["idempotency-key"] });
      json({ investigation_ref: run.investigation_ref, workflow_instance_id: draftWorkflowId });
    } else if (path === `/api/v1/research/run/${draftWorkflowId}`) {
      assert.equal(request.method, "GET"); json(run);
    } else if (path === `${artifactPath}/reauthorize`) {
      assert.equal(request.method, "POST"); json({ protocol: "eliotr.artifact-draft-reauthorization.v1", artifact_ref: artifact, artifact: draftArtifact, original_scope_snapshot_ref: scope, authorization_scope_snapshot_ref: scope, authorization, deployment_generation: "browser-fixture" });
    } else if (path === `${sectionPath}/reauthorize`) {
      assert.equal(request.method, "POST"); state.sectionReads += 1;
      const send = () => {
        const bytes = Buffer.from(draftSectionText);
        response.setHeader("content-type", "application/octet-stream"); response.setHeader("content-length", String(bytes.length));
        response.setHeader("x-eliotr-artifact-ref", encodeURIComponent(`${artifact.id}:${artifact.revision}`));
        response.setHeader("x-eliotr-section-ref", encodeURIComponent(`${section.section_ref.id}:${section.section_ref.revision}`));
        response.setHeader("x-eliotr-section-object-ref", encodeURIComponent(section.body_object_ref));
        response.setHeader("x-eliotr-section-sha256", draftSectionSha); response.setHeader("x-eliotr-deployment-generation", "browser-fixture"); response.end(bytes);
      };
      if (state.holdSection) state.pendingSection = send; else send();
    } else {
      assert.equal(request.method, "POST"); state.citationReads += 1;
      json({ protocol: "eliotr.artifact-draft-citations-reauthorization.v1", artifact_ref: artifact, section_ref: section.section_ref, original_scope_snapshot_ref: scope, authorization_scope_snapshot_ref: scope, authorization, deployment_generation: "browser-fixture", verification_receipt_ref: section.verification_receipt_ref, semantic_verification: "NOT_EXECUTED", cited_evidence: [{ original_handle_ref: { id: "handle-1", revision: 1 }, handle_ref: { id: "handle-1", revision: 1 }, excerpt_sha256: evidenceSha }] });
    }
    return true;
  };
  return { state, handle, release() { state.pendingSection?.(); state.pendingSection = undefined; } };
}

export async function runResearchScreenCanary({ fixture, cdp, evaluate, wait, until, click, openSources, draftSectionText, evidenceText, evidenceSha }) {
  const question = '#research-run textarea[name="query"]';
  const scope = '#research-run select[name="scope"]';
  const submit = '#research-run button[type="submit"]';
  const nav = '[data-nav-target="#research-card"]';
  const directory = process.env.ELIOTR_SCREENSHOT_DIR;
  const shot = async (name) => {
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(resolve(directory, `${name}.png`), Buffer.from(data, "base64"));
  };
  const viewport = (width, height) => cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const inViewport = async (selector) => {
    const value = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null;
      const r = node.getBoundingClientRect();
      const dx = Math.min(6, r.width / 4); const dy = Math.min(6, r.height / 4);
      const points = [[r.x + r.width / 2, r.y + r.height / 2], [r.left + dx, r.top + dy], [r.right - dx, r.top + dy], [r.left + dx, r.bottom - dy], [r.right - dx, r.bottom - dy]];
      const unobscured = points.every(([x,y]) => { const hit = document.elementFromPoint(x,y); return hit === node || node.contains(hit); });
      return { visible: r.width > 0 && r.height > 0, bounded: r.left >= 0 && r.top >= 0 && r.right <= document.documentElement.clientWidth && r.bottom <= document.documentElement.clientHeight,
        unobscured, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, viewport: [innerWidth, innerHeight] };
    })()`);
    assert.ok(value?.visible && value.bounded && value.unobscured, `${selector} must be immediately visible and unobscured: ${JSON.stringify(value)}`);
  };
  try {
  await viewport(1440, 900);
  await openSources("S26 initial Library");
  await click("#library [data-project]");
  await wait('document.querySelector("#library [data-scope]")?.textContent.includes("project-1")', "S26 project selected");
  await click(nav);
  await wait('document.querySelector("#research-run [data-run-badge]")?.textContent === "READY"', "S26 configured Research");
  await shot("research-ready-1440x900");
  for (const selector of [question, scope, submit]) await inViewport(selector);
  assert.equal(await evaluate('document.querySelectorAll("#research-run form").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll("#research-configuration").length'), 1);
  assert.equal(await evaluate('document.querySelector("#research-configuration").closest("[data-workspace-view]").dataset.workspaceView'), "connections");
  assert.equal(await evaluate('document.querySelector("#research-run [data-research-history]").open'), false);
  await wait('document.querySelectorAll("#research-run [data-research-history-list] .workflow-recovery-row").length === 8', "S26 full history loaded without pushing question");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(scope)}).value`), "project");
  // Native keyboard activation, not programmatic disclosure toggling.
  await evaluate('document.querySelector("#research-run [data-research-history] > summary").focus()');
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await wait('document.querySelector("#research-run [data-research-history]").open', "Native Enter opens history");
  await click("#research-run [data-research-history] > summary");
  await click(nav);
  await evaluate(`document.querySelector(${JSON.stringify(question)}).focus()`);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(scope)})`), true, "Question → scope keyboard order");
  for (const [width, height] of [[390, 844], [320, 740], [768, 1024]]) {
    await viewport(width, height); await click(nav);
    for (const selector of [question, scope, submit]) await inViewport(selector);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, "No horizontal overflow including scrollbar gutter");
    for (const target of ["#library", "#research-card", "#wiki-card", "#connections-card"]) await inViewport(`.workspace-nav [data-nav-target="${target}"]`);
    assert.equal(await evaluate('document.querySelector(".workspace-nav").scrollWidth <= document.querySelector(".workspace-nav").clientWidth'), true, "Every navigation label fits");
    await shot(`research-ready-${width}x${height}`);
  }
  await viewport(1440, 900); await click(nav);
  await evaluate(`document.querySelector(${JSON.stringify(question)}).value = "draft research question"`);
  await click(submit);
  await wait('document.querySelector("#research-run .research-report-heading")?.textContent.includes("DRAFT")', "S26 saved report metadata");
  assert.equal(fixture.state.starts.length, 1, "one user action → one run request");
  assert.equal(await evaluate('Boolean(document.querySelector("#research-run [data-run-result]").compareDocumentPosition(document.querySelector("#research-run [data-research-history]")) & Node.DOCUMENT_POSITION_FOLLOWING)'), true, "Answer before history");
  await click("#research-run .research-report-section .research-report-actions > button");
  await wait('Boolean(document.querySelector("#research-run .research-section-body"))', "S26 exact section bytes");
  assert.equal(await evaluate('document.querySelector("#research-run .research-section-body").textContent'), draftSectionText);
  assert.equal(await evaluate('document.querySelectorAll("#research-run .research-section-body em").length'), 0, "Saved text remains inert");
  await click('#research-run [data-open-sources="0"]');
  await wait('document.querySelector("#research-run [data-open-citation]")?.disabled === false', "S26 citations ready");
  await click('#research-run [data-open-citation="0"]');
  await wait('document.querySelector("#evidence-detail")?.textContent.includes("Pinned content.")', "S26 verified evidence rail");
  assert.equal(await evaluate('document.querySelector("#evidence-detail pre").textContent'), evidenceText);
  const detail = await evaluate('document.querySelector("#evidence-detail").textContent');
  assert.ok(detail.includes(evidenceSha) && detail.includes("revision-1"), "Exact revision and digest remain inspectable");
  assert.ok(fixture.state.seen.includes("POST /api/v1/research/verify"));
  assert.ok(fixture.state.seen.some((path) => path.startsWith("GET /api/v1/research/open/")));
  await evaluate('document.querySelector("#research-run .research-section-body").scrollIntoView({block:"center",behavior:"instant"})');
  await shot("research-answer-and-evidence-1440x900");
  // A pending section cannot repopulate a cleared view, even through an old button.
  fixture.state.holdSection = true;
  await click("#research-run .research-report-section .research-report-actions > button");
  await wait('document.querySelector("#research-run [role=status]").textContent.includes("Reading report section")', "S26 section pending");
  await until(() => Boolean(fixture.state.pendingSection), "S26 real pending HTTP response");
  await evaluate('window.dispatchEvent(new Event("offline"))');
  fixture.release();
  await wait('document.querySelector("#research-run [data-run-result]").hidden && document.querySelector("#evidence-detail").hidden', "S26 private views cleared");
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await evaluate('document.querySelector("#research-run [data-run-result]").textContent'), "");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(question)}).value`), "");
  fixture.state.blocked = true;
  await cdp("Page.reload");
  await wait('document.querySelector("#research-run [data-run-badge]")?.textContent === "BLOCKED"', "S26 missing configuration blocks run");
  await click(nav);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(submit)}).disabled`), true);
  await evaluate(`(() => { const q = document.querySelector(${JSON.stringify(question)}); q.value = "must not run"; q.closest("form").requestSubmit(); })()`);
  assert.equal(fixture.state.starts.length, 1, "Programmatic submit cannot bypass readiness");
  await shot("research-blocked-1440x900");
  await click('#research-run [data-nav-target="#research-configuration-card"]');
  await wait('document.querySelector("#connections-card").hidden === false', "S26 configuration shortcut");
  assert.equal(await evaluate('location.hash'), "#research-configuration-card");
  assert.equal(await evaluate('document.querySelector("#research-configuration [data-research-configuration-badge]").textContent'), "NOT CONFIGURED");
  await shot("research-configuration-connections-1440x900");
  await cdp("Page.reload");
  await wait('document.querySelector("#connections-card")?.hidden === false', "S26 configuration deep link after reload");
  await click(nav); await inViewport(question);
  console.log("S26 Research screen: PASS (built PWA; desktop/tablet/narrow layout, keyboard, one project-scoped run, section/citation bytes and digest, collapsed history, blocked state, Connections deep link, offline late-response clearing). Controlled HTTP fixtures; native storage and live models NOT_EXECUTED.");
  } catch (error) {
    await shot("failure");
    console.error("S26 fixture diagnostics:", JSON.stringify({ requests: fixture.state.seen, text: await evaluate('document.body.innerText.slice(0, 16000)') }));
    throw error;
  }
}
