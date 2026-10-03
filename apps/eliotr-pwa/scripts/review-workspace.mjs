import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

// Uses the existing controlled-HTTP runner unchanged on disk. Its legacy screen
// canary expects offline input erasure; this review verifies current retained-intent
// behavior, plus layout, exact source bytes, disclosure controls and keyboard focus.
// The document fixture is committed design documentation, never product demo data.
async function reviewCanary({ fixture, cdp, evaluate, wait, until, click, openSources, draftSectionText, evidenceText, evidenceSha, documentText }) {
  const after = process.env.ELIOTR_UI_REVIEW_PHASE === "after";
  const directory = process.env.ELIOTR_SCREENSHOT_DIR;
  const question = '#research-run textarea[name="query"]';
  const scope = '#research-run select[name="scope"]';
  const submit = '#research-run button[type="submit"]';
  const nav = '[data-nav-target="#research-card"]';
  const shot = async (name) => {
    await mkdir(directory, { recursive: true });
    const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(resolve(directory, `${name}.png`), Buffer.from(data, "base64"));
  };
  const viewport = (width, height) => cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const reveal = async (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); for (let p = node?.parentElement; p; p = p.parentElement) if (p instanceof HTMLDetailsElement) p.open = true; })()`);
  const act = async (selector) => { await reveal(selector); await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`); await click(selector); };
  const bounded = async (selector) => {
    const box = await evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; const r = n.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { visible: r.width > 0 && r.height > 0, bounded: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, unobscured: hit === n || n.contains(hit) }; })()`);
    assert.ok(box?.visible && box.bounded && box.unobscured, `${selector} must fit and remain reachable: ${JSON.stringify(box)}`);
  };
  try {
    await viewport(1440, 900);
    await openSources("Workspace review Library");
    await shot("documents-1440x900");
    if (after) {
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".panel--evidence")).display'), "none", "Empty evidence does not reserve a column");
      assert.equal(await evaluate('document.querySelector("#projects-card").open'), false);
      assert.equal(await evaluate('document.querySelector("#source-import-card").open'), false);
      await act("#projects [data-project-refresh]");
      await wait('document.querySelector("#projects [data-project-edit]")?.disabled === false', "Saved project editor available");
      await act("#projects [data-project-edit]");
      assert.equal(await evaluate('document.activeElement === document.querySelector("#projects [data-project-title]")'), true);
      await act("#projects [data-project-cancel]");
      assert.equal(await evaluate('document.querySelector("[data-project-editor-details]").open'), false);
      assert.equal(await evaluate('document.activeElement === document.querySelector("#projects [data-project-new]")'), true, "Closing project editor returns focus");
      await evaluate('document.querySelector("#projects-card").open = false');
    }
    await act("#library [data-source]");
    await wait('Boolean(document.querySelector("#corpus-lens [data-read-document]"))', "Selected document metadata");
    await act("#corpus-lens [data-read-document]");
    await wait('document.querySelector("[data-document-reader-body]").textContent.length > 1000', "Pinned document text");
    await wait('document.querySelector("#app").dataset.healthReady === "true"', "Document view health readback");
    assert.equal(await evaluate('document.querySelector("[data-document-reader-body]").textContent'), documentText);
    await shot("document-reader-1440x900");
    await viewport(390, 844);
    await evaluate('document.querySelector("[data-document-reader]").scrollIntoView({block:"start",behavior:"instant"})');
    await shot("document-reader-390x844");
    assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
    await viewport(1440, 900);
    await openSources("Project scope");
    await act("#library [data-project]");
    await click(nav);
    await wait('document.querySelector("#research-run [data-run-badge]").textContent === "READY"', "Research ready");
    for (const [width, height] of [[1440, 900], [390, 844], [320, 740], [768, 1024]]) {
      await viewport(width, height); await click(nav);
      for (const selector of [question, scope, submit]) await bounded(selector);
      for (const target of ["#library", "#research-card", "#wiki-card", "#connections-card"]) await bounded(`.workspace-nav [data-nav-target="${target}"]`);
      const overflow = await evaluate('({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll("body *")].filter(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.right>document.documentElement.clientWidth+1}).slice(0,12).map(n=>({tag:n.tagName,id:n.id,class:n.className,right:n.getBoundingClientRect().right,width:n.getBoundingClientRect().width}))})');
      assert.ok(overflow.scroll <= overflow.width, `No viewport overflow at ${width}: ${JSON.stringify(overflow)}`);
      await shot(`research-ready-${width}x${height}`);
    }
    await viewport(1440, 900); await click(nav);
    await evaluate(`document.querySelector(${JSON.stringify(question)}).focus()`);
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(scope)})`), true);
    await evaluate('document.querySelector("[data-research-history] > summary").focus()');
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await wait('document.querySelector("[data-research-history]").open', "Keyboard opens native history disclosure");
    await click("[data-research-history] > summary");
    await evaluate(`(() => { const q = document.querySelector(${JSON.stringify(question)}); q.value = "draft research question"; q.closest("form").requestSubmit(); })()`);
    await wait('Boolean(document.querySelector(".research-report-section"))', "Saved report metadata");
    assert.equal(fixture.state.starts.length, 1);
    if (after) assert.equal(await evaluate('[...document.querySelectorAll(".research-report-section button")].filter(n=>n.textContent === "Revise section").length'), 1, "One revision action per report section");
    await act(".research-report-section .research-report-actions > button");
    await wait('Boolean(document.querySelector(".research-section-body"))', "Saved section exact bytes");
    assert.equal(await evaluate('document.querySelector(".research-section-body").textContent'), draftSectionText);
    await act('[data-open-sources="0"]');
    await wait('document.querySelector("[data-open-citation]")?.disabled === false', "Saved citation readback");
    await act('[data-open-citation="0"]');
    await wait('document.querySelector("#evidence-detail").textContent.includes("Pinned content.")', "Verified source excerpt");
    assert.equal(await evaluate('document.querySelector("#evidence-detail pre").textContent'), evidenceText);
    assert.ok((await evaluate('document.querySelector("#evidence-detail").textContent')).includes(evidenceSha));
    assert.ok(fixture.state.seen.includes("POST /api/v1/research/verify"));
    assert.ok(fixture.state.seen.some((path) => path.startsWith("GET /api/v1/research/open/")));
    await evaluate('document.querySelector(".research-section-body").scrollIntoView({block:"start",behavior:"instant"})');
    await shot("research-report-and-source-1440x900");
    await viewport(768, 1024);
    if (after) {
      const box = await evaluate('(() => {const n=document.querySelector(".panel--evidence"),r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,overflow:getComputedStyle(n).overflowY};})()');
      assert.ok(box.top >= 0 && box.bottom <= 1024 && box.height <= 350 && box.overflow === "auto", `Tablet source is bounded and scrollable: ${JSON.stringify(box)}`);
    }
    await shot("source-excerpt-768x1024");
    await viewport(390, 844);
    await evaluate('document.querySelector(".panel--evidence").scrollIntoView({block:"start",behavior:"instant"})');
    await shot("source-excerpt-390x844");
    if (after) {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      assert.equal(await evaluate('document.querySelector("#evidence-detail").hidden'), true);
      assert.equal(await evaluate('document.activeElement === document.querySelector("[data-open-citation]")'), true, "Dismissal returns citation focus");
      await act('[data-open-citation="0"]');
      await wait('document.querySelector(".rail-status").textContent === "VERIFIED"', "Citation reopens after dismissal");
      await act("[data-close-evidence]");
      assert.equal(await evaluate('document.activeElement === document.querySelector("[data-open-citation]")'), true);
    }
    await viewport(1440, 900);
    fixture.state.holdSection = true;
    await act(".research-report-section .research-report-actions > button");
    await until(() => Boolean(fixture.state.pendingSection), "Pending section response");
    await evaluate('window.dispatchEvent(new Event("offline"))');
    fixture.release();
    await wait('document.querySelector("[data-run-result]").hidden && document.querySelector("#evidence-detail").hidden', "Offline private data clearing");
    await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(question)}).value`), "draft research question", "Temporary outage retains current intent");
    assert.equal(await evaluate('document.querySelector("[data-run-result]").textContent'), "", "Late section cannot repopulate protected responses");
    assert.equal(fixture.state.starts.length, 1, "Outage never resubmits research");
    await shot("connection-interrupted-1440x900");
    fixture.state.holdSection = false;
    await evaluate('window.dispatchEvent(new Event("online"))');
    await wait('Boolean(document.querySelector(".research-report-section"))', "Fresh owner verification reopens the same run");
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(question)}).value`), "draft research question");
    assert.equal(fixture.state.starts.length, 1, "Reconnection reads the same run without a new submission");
    await cdp("Page.reload");
    await wait('document.querySelector("[data-research-history-list] .workflow-recovery-item")?.disabled === false', "Fresh session loads saved runs after reload");
    await click(nav);
    // This fixture's September 10 entry is the saved run; its seven newer entries
    // intentionally have no answer. Identify the entry by its accessible date.
    const savedRun = await evaluate('(() => { const date = new Intl.DateTimeFormat(undefined, {dateStyle:"medium",timeStyle:"short"}).format(new Date("2026-09-10T12:00:00.000Z")); return [...document.querySelectorAll("[data-research-history-list] .workflow-recovery-item")].find(n=>n.textContent.includes(date))?.textContent; })()');
    assert.ok(savedRun, "Saved run's accessible history date is present");
    await reveal("[data-research-history-list]");
    await evaluate(`(() => { const node = [...document.querySelectorAll("[data-research-history-list] .workflow-recovery-item")].find(n=>n.textContent === ${JSON.stringify(savedRun)}); node.focus(); node.click(); })()`);
    await wait('Boolean(document.querySelector(".research-report-section"))', "Saved report reopened from history");
    await act(".research-report-section .research-report-actions > button");
    await wait('Boolean(document.querySelector(".research-section-body"))', "Reopened report section exact bytes");
    assert.equal(await evaluate('document.querySelector(".research-section-body").textContent'), draftSectionText);
    assert.equal(fixture.state.starts.length, 1, "Saved history never resubmits research");
    await shot("saved-report-reopened-1440x900");
    await evaluate(`document.querySelector(${JSON.stringify(question)}).value = "private retained intent"`);
    await evaluate('window.dispatchEvent(new Event("eliotr:authorization-cleared"))');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(question)}).value`), "", "Authorization loss clears retained intent");
    fixture.state.blocked = true;
    await cdp("Page.reload");
    await wait('Boolean(document.querySelector("[data-run-badge]"))', "Reloaded workspace"); await click(nav);
    await wait('document.querySelector("[data-run-badge]").textContent === "BLOCKED"', "Research configuration blocked");
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(submit)}).disabled`), true);
    await evaluate(`(() => { const q = document.querySelector(${JSON.stringify(question)}); q.value = "must not run"; q.closest("form").requestSubmit(); })()`);
    assert.equal(fixture.state.starts.length, 1);
    await shot("research-blocked-1440x900");
    await openSources("Library survives blocked research");
    assert.ok(await evaluate('Boolean(document.querySelector("#library [data-source]"))'));
    await shot("documents-with-research-blocked-1440x900");
    await click(nav); await act('#research-run [data-nav-target="#research-configuration-card"]');
    assert.equal(await evaluate('location.hash'), "#research-configuration-card");
    await cdp("Page.reload");
    await wait('document.querySelector("#connections-card")?.hidden === false', "Connections deep link after reload");
    await wait('document.querySelector("#app").dataset.healthReady === "true" && document.querySelector("[data-research-configuration-badge]")?.textContent === "NOT CONFIGURED"', "Connections state readback");
    await shot("connections-1440x900");
    await viewport(390, 844); await shot("connections-390x844");
    const metrics = await evaluate('({body:getComputedStyle(document.body).fontSize, font:getComputedStyle(document.body).fontFamily, reader:getComputedStyle(document.querySelector(".document-reader-body")).fontSize, line:getComputedStyle(document.querySelector(".document-reader-body")).lineHeight, color:getComputedStyle(document.body).color, canvas:getComputedStyle(document.body).backgroundColor})');
    await writeFile(resolve(directory, "metrics.json"), JSON.stringify(metrics, null, 2));
    console.log(`Workspace UI review ${after ? "after" : "before"}: PASS; desktop/mobile/tablet, keyboard, pinned document/report/source bytes, outage retention, fresh-session reconnection, saved report reopen after reload, authorization clearing, no duplicate run, blocked research + readable Library. Controlled HTTP only; live qualification NOT_EXECUTED.`);
  } catch (error) {
    await shot("failure");
    console.error("UI review failed:", error.message);
    throw error;
  }
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
const phase = process.argv.includes("--before") ? "before" : "after";
const reviewRoot = resolve(root, "../.codex-tools/ui-material-20261003");
await mkdir(resolve(reviewRoot, "tmp"), { recursive: true });
process.env.TEMP = resolve(reviewRoot, "tmp");
process.env.TMP = process.env.TEMP;
process.env.ELIOTR_SCREENSHOT_DIR = resolve(reviewRoot, phase);
process.env.ELIOTR_UI_REVIEW_PHASE = phase;
if (!process.argv.includes("--research-screen")) process.argv.push("--research-screen");
const runner = new URL("../../../scripts/test-library-browser.mjs", import.meta.url);
const document = await readFile(resolve(root, "docs/design/README.md"), "utf8");
let source = await readFile(runner, "utf8");
const replace = (from, to) => { assert.ok(source.includes(from), `Existing runner anchor changed: ${from.slice(0, 80)}`); source = source.replace(from, to); };
replace('import { createResearchScreenFixture, runResearchScreenCanary } from "./lib/browser-research-screen-fixture.mjs";', 'import { createResearchScreenFixture } from "./lib/browser-research-screen-fixture.mjs";\nconst runResearchScreenCanary = ' + reviewCanary.toString() + ';');
source = source.replaceAll(/from "(\.\/[^" ]+)"/gu, (_, relative) => `from "${new URL(relative, runner).href}"`);
replace('const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");', `const root = ${JSON.stringify(root)};\nconst reviewDocument = ${JSON.stringify(document)};`);
replace('readFile, rm', 'readFile, writeFile, rm');
replace('draftSectionText, evidenceText, evidenceSha });', 'draftSectionText, evidenceText, evidenceSha, documentText: reviewDocument });');
const sectionAnchor = source.match(/const draftSectionText = [^\n]+\r?\n/u)?.[0];
assert.ok(sectionAnchor, "Existing section fixture anchor changed");
replace(sectionAnchor, `const draftSectionText = ${JSON.stringify(document.slice(0, 2200))};\n`);
replace('    if (url.pathname === "/api/v1/research/orient") return researchReadinessFixture.handleOrientation(request, response, url);', `    if (url.pathname === "/api/v1/research/orient") {
      assert.equal(request.method, "POST"); assert.ok(request.headers["idempotency-key"]);
      const chunks = []; for await (const part of request) chunks.push(part);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")).scope_expression, { kind: "SELECTED_SOURCES", source_ids: ["source-1"] });
      const trace = { id: "orient-" + "a".repeat(64), revision: 1 };
      return json(envelope({ trace_ref: trace, evidence_pack: { pack_ref: { id: "pack-fixture", revision: 1 }, scope_snapshot_ref: { id: "scope-fixture", revision: 1 }, trace_ref: trace, resolved_evidence: [], omitted_candidates: [], total_utf8_bytes: 0 },
        navigation: { source_cards: [{ card_ref: { id: "card-fixture", revision: 1 }, source_revision_ref: "revision-1", title: "Blue workspace v2", authors: [], language: "ru", source_kind: "markdown", document_role: "design", authority_hint: "owner", abstract: "", main_topics: [], controlled_vocabulary: [], outline: [], important_section_refs: [], likely_uses: [], quality_status: "standard", generator_generation: "fixture-1", created_at: "2026-09-08T00:00:00.000Z" }], document_maps: [], represented_source_revision_refs: ["revision-1"], omitted_source_revision_refs: [], omitted_source_revision_count: 0, omissions_truncated: false, omissions: [], coverage_kind: "unknown", coverage_method: "frozen_scope_order", degraded_source_revision_refs: [], missing_source_classes: [], contradiction_refs: [], centrality: [], recommended_reading_routes: [], navigation_authority: "NAVIGATION_ONLY" } }));
    }`);
replace('    const file = resolve(dist,', `    if (url.pathname === "/api/v1/library/content") {
      assert.equal(request.method, "GET"); assert.equal(url.searchParams.get("source_revision_ref"), "revision-1");
      const bytes = Buffer.from(reviewDocument, "utf8");
      response.setHeader("content-type", "text/plain; charset=utf-8"); response.setHeader("content-length", String(bytes.length));
      response.setHeader("x-eliotr-source-revision", "revision-1"); response.setHeader("x-eliotr-deployment-generation", "browser-fixture");
      response.setHeader("x-eliotr-content-sha256", createHash("sha256").update(bytes).digest("hex")); response.end(bytes); return;
    }
    const file = resolve(dist,`);
await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`).catch((error) => {
  console.error(error.message); process.exitCode = 1;
});
