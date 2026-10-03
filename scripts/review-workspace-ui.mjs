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
function reviewCanary({fixture,cdp,evaluate,wait,until,draftSectionText,evidenceText,evidenceSha,documentText,setReaderText}) {
  return (async () => {
    const dir=process.env.ELIOTR_SCREENSHOT_DIR;
    const nav='[data-nav-target="#research-card"]', query='#research-run textarea[name="query"]';
    const viewport=(width,height)=>cdp("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
    const click=async(selector)=>{
      const point=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:"nearest",behavior:"instant"});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,hit:n.contains(document.elementFromPoint(x,y)),width:r.width,height:r.height};})()`);
      assert.ok(point.width>0&&point.height>0&&point.hit,`${selector}: real pointer target is visible`);
      await cdp("Input.dispatchMouseEvent",{type:"mouseMoved",x:point.x,y:point.y});
      await cdp("Input.dispatchMouseEvent",{type:"mousePressed",x:point.x,y:point.y,button:"left",clickCount:1});
      await cdp("Input.dispatchMouseEvent",{type:"mouseReleased",x:point.x,y:point.y,button:"left",clickCount:1});
    };
    const openSources=async(label)=>{
      await wait('Boolean(document.querySelector("[data-nav-target=\\"#library\\"]"))',`${label}: navigation`);
      await click('[data-nav-target="#library"]');
      const visible=(selector)=>evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`);
      if(!await visible("#library [data-first]"))await click("[data-source-chooser-toggle]");
      if(!await visible("#library [data-source]"))await click("#library [data-first]");
      await wait('Boolean(document.querySelector("#library [data-source]"))',`${label}: source controls`);
    };
    const reveal=(selector)=>evaluate(`(()=>{for(let n=document.querySelector(${JSON.stringify(selector)})?.parentElement;n;n=n.parentElement)if(n instanceof HTMLDetailsElement)n.open=true;})()`);
    const act=async(selector)=>{await reveal(selector);await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:"center",behavior:"instant"});n.focus({preventScroll:true});})()`);await click(selector);};
    const shot=async(name)=>{
      await mkdir(dir,{recursive:true});
      for(const theme of ["dark","light"]){
        await evaluate(`(()=>{if(document.documentElement.dataset.theme!==${JSON.stringify(theme)})document.querySelector("[data-theme-toggle]").click();})()`);
        await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        const {data}=await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
        await writeFile(resolve(dir,`${name}-${theme}.png`),Buffer.from(data,"base64"));
      }
      await evaluate('document.querySelector("[data-theme-toggle]").click()');
    };
    const bounded=async(selector)=>{
      await wait(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`,`${selector} settles inside viewport`);
      const box=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();return{width:r.width,height:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()`);
      assert.ok(box.width>0&&box.height>0&&box.left>=0&&box.right<=await evaluate('innerWidth')&&box.top>=0&&box.bottom<=await evaluate('innerHeight'),`${selector} fits viewport: ${JSON.stringify(box)}`);
    };
    try {
      await viewport(1440,900);await openSources("UI review Library");await shot("documents-1440x900");
      await act("#projects [data-project-refresh]");
      await wait('document.querySelector("#projects [data-project-edit]")?.disabled===false',"Project editor available");
      await act("#projects [data-project-edit]");
      assert.equal(await evaluate('document.activeElement===document.querySelector("#projects [data-project-title]")'),true,"Edit focuses project title");
      await act("#projects [data-project-cancel]");
      assert.equal(await evaluate('document.activeElement===document.querySelector("#projects [data-project-new]")'),true,"Cancel returns project focus");
      await evaluate('document.querySelector("#projects-card").open=false');
      await evaluate('document.querySelector("#source-import-card").open=true');
      await shot("add-documents-1440x900");
      await evaluate('document.querySelector("#source-import-card").open=false;document.querySelector(".workspace-menu").open=true');
      await shot("workspace-menu-1440x900");
      await evaluate('document.querySelector(".workspace-menu > summary").focus()');
      await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      assert.equal(await evaluate('document.querySelector(".workspace-menu").open'),false,"Escape closes workspace menu");
      await act("#library [data-source]");
      await wait('document.querySelector("[data-document-reader-body]").textContent.length>1000',"Auto-read pinned source");
      await wait('Boolean(document.querySelector("[data-document-formatted] h1"))',"Markdown headings rendered");
      assert.equal(await evaluate('document.querySelector("[data-document-reader-body]").textContent'),documentText);
      await shot("document-reader-1440x900");
      await viewport(390,844);await evaluate('document.querySelector("[data-document-reader]").scrollIntoView({block:"start",behavior:"instant"})');
      assert.equal(await evaluate('getComputedStyle(document.querySelector("#document-reader-title")).outlineStyle'),"none","Ordinary source click has no heading focus frame");
      await shot("document-reader-390x844");
      await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
      await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
      await evaluate('document.querySelector("#document-reader-title").focus({preventScroll:true})');
      assert.notEqual(await evaluate('getComputedStyle(document.querySelector("#document-reader-title")).outlineStyle'),"none","Keyboard reader focus remains visible");
      await shot("document-reader-keyboard-390x844");
      assert.equal(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),true);
      const downloaded=await evaluate(`(async()=>{
        const create=URL.createObjectURL,activate=HTMLAnchorElement.prototype.click;let blob;
        URL.createObjectURL=value=>{blob=value;return create(value);};HTMLAnchorElement.prototype.click=()=>{};
        try{document.querySelector("[data-download-document]").click();return [...new Uint8Array(await blob.arrayBuffer())];}
        finally{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=activate;}
      })()`);
      assert.deepEqual(downloaded,[...Buffer.from(documentText,"utf8")],"Original download preserves exact admitted bytes");
      await act("[data-source-chooser-toggle]");await shot("sources-drawer-390x844");
      assert.equal(await evaluate('document.querySelector("dialog.library-drawer").open'),true);
      await act("[data-close-library]");
      assert.equal(await evaluate('document.activeElement===document.querySelector("[data-source-chooser-toggle]")'),true,"Source drawer returns focus");
      await viewport(1440,900);await act("[data-close-document]");await openSources("Project scope");
      await act("#library [data-project]");await click(nav);
      await wait('document.querySelector("[data-run-badge]").textContent==="READY"',"Research ready");
      for(const [width,height] of [[1440,900],[390,844],[320,740],[768,1024]]){
        await viewport(width,height);await click(nav);
        for(const selector of [query,'.research-question-form select[name="scope"]','.research-question-form button[type="submit"]'])await bounded(selector);
        assert.equal(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),true,`No overflow at ${width}`);
        assert.equal(await evaluate('getComputedStyle(document.querySelector("#research-view")).outlineStyle'),"none","Ordinary navigation has no workspace frame");
        await shot(`research-ready-${width}x${height}`);
      }
      await viewport(1440,900);await click(nav);
      await click(".research-actions-menu > summary");await shot("research-tools-menu-1440x900");
      await evaluate('document.querySelector(".research-actions-menu").open=false');
      await evaluate(`document.querySelector(${JSON.stringify(query)}).focus()`);
      await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
      await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
      assert.equal(await evaluate('document.activeElement===document.querySelector(".research-question-form select")'),true,"Question tabs to scope");
      assert.notEqual(await evaluate('getComputedStyle(document.activeElement).outlineStyle'),"none","Keyboard scope indicator remains visible");
      await shot("research-scope-keyboard-1440x900");
      await evaluate('document.querySelector("[data-research-history] > summary").focus()');
      await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13,text:"\r"});
      await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
      assert.equal(await evaluate('document.querySelector("[data-research-history]").open'),true);
      await evaluate('document.querySelector("[data-research-history]").open=false');
      await evaluate(`(()=>{const q=document.querySelector(${JSON.stringify(query)});q.value="draft research question";q.closest("form").requestSubmit();})()`);
      await wait('Boolean(document.querySelector(".research-section-reading .reading-view h1"))',"Report automatically reads and formats");
      assert.equal(fixture.state.starts.length,1);
      assert.equal(await evaluate('document.querySelector(".research-section-body").textContent'),draftSectionText);
      assert.equal(await evaluate('[...document.querySelectorAll(".research-report-section button")].filter(n=>n.textContent==="Revise section").length'),1);
      await evaluate('document.querySelector(".research-report-heading").scrollIntoView({block:"start",behavior:"instant"})');
      await shot("research-report-1440x900");
      await viewport(390,844);await shot("research-report-390x844");await viewport(1440,900);
      await act('[data-open-sources="0"]');
      await wait('document.querySelector("[data-open-citation]")?.disabled===false',"Citation readback");
      await act('[data-open-citation="0"]');
      await wait('document.querySelector(".rail-status").textContent==="VERIFIED"',"Exact excerpt verifies");
      await wait('Boolean(document.querySelector(".evidence-excerpt h1"))',"Verified excerpt receives safe reading typography");
      assert.equal(await evaluate('document.querySelector("#evidence-detail pre").textContent'),evidenceText);
      assert.ok((await evaluate('document.querySelector("#evidence-detail").textContent')).includes(evidenceSha));
      assert.equal(await evaluate('document.querySelector("dialog.panel--evidence").matches(":modal")'),false,"Desktop excerpt is nonmodal");
      assert.notEqual(await evaluate('getComputedStyle(document.body).overflow'),"hidden","Desktop answer remains scrollable");
      assert.ok(await evaluate('document.querySelector("dialog.panel--evidence").getBoundingClientRect().height<innerHeight*.8'),"Desktop inspector fits by content below viewport height");
      await evaluate('document.querySelector("#research-view").focus({preventScroll:true})');
      assert.equal(await evaluate('document.activeElement===document.querySelector("#research-view")'),true,"Desktop answer can receive focus while excerpt is open");
      await shot("research-report-and-source-1440x900");
      await viewport(768,1024);await shot("source-excerpt-768x1024");
      await viewport(390,844);await shot("source-excerpt-390x844");
      assert.equal(await evaluate('document.querySelector("dialog.panel--evidence").matches(":modal")'),true,"Narrow excerpt remains a modal sheet");
      await act(".evidence-source-actions button");
      await wait('Boolean(document.querySelector(".evidence-full-source .reading-view h1"))',"Full source formats");
      assert.equal(await evaluate('document.querySelector(".evidence-full-source pre").textContent'),documentText);
      await shot("citation-full-source-390x844");
      await act("#evidence-detail > button");
      assert.equal(await evaluate('document.querySelector(".evidence-source").textContent'),evidenceText);
      await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      assert.equal(await evaluate('document.activeElement===document.querySelector("[data-open-citation]")'),true,"Citation dismissal returns focus");
      await viewport(1440,900);
      const position=await evaluate('(()=>{const n=document.querySelector("[data-open-citation]");n.focus({preventScroll:true});n.click();return scrollY;})()');
      await wait('document.querySelector(".rail-status").textContent==="VERIFIED"',"Citation reopens");
      await act("[data-close-evidence]");
      assert.equal(await evaluate('scrollY'),position,"Closing citation preserves answer position");
      fixture.state.holdSection=true;await act('[data-read-report-section="0"]');
      await until(()=>Boolean(fixture.state.pendingSection),"Delayed section response");
      await evaluate('window.dispatchEvent(new Event("offline"))');fixture.release();
      await wait('document.querySelector("[data-run-result]").hidden&&document.querySelector("#evidence-detail").hidden',"Private bytes cleared on outage");
      assert.equal(await evaluate('document.querySelector("[data-run-result]").textContent'),"");
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(query)}).value`),"draft research question");
      assert.equal(fixture.state.starts.length,1);
      await shot("connection-interrupted-1440x900");
      fixture.state.holdSection=false;await evaluate('window.dispatchEvent(new Event("online"))');
      await wait('Boolean(document.querySelector(".research-section-reading"))',"Fresh session reopens same report");
      assert.equal(fixture.state.starts.length,1);
      await cdp("Page.reload");
      await wait('document.querySelector("[data-research-history-list] .workflow-recovery-item")?.disabled===false',"History ready after reload");
      await click(nav);await reveal("[data-research-history-list]");
      await evaluate('(()=>{const date=new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date("2026-09-10T12:00:00.000Z"));[...document.querySelectorAll(".workflow-recovery-item")].find(n=>n.textContent.includes(date)).click();})()');
      await wait('Boolean(document.querySelector(".research-section-reading"))',"Saved report reread without new run");
      assert.equal(await evaluate('document.querySelector(".research-section-body").textContent'),draftSectionText);
      assert.equal(fixture.state.starts.length,1);await shot("saved-report-reopened-1440x900");
      await openSources("Safe Markdown test");
      const unsafe='# Чтение\n\n<script>window.__readingInjected=true</script>\n\n[unsafe](javascript:alert(1)) [svg](data:image/svg+xml,evil) ![Картинка](https://example.invalid/image.png)\n\n**Русский текст** и `READY SHA-256 <img onerror=alert(1)>`\n\n| Заголовок | Значение |\n| --- | --- |\n| READY | SHA-256 |';
      setReaderText(unsafe);await act("#library [data-source]");
      await wait('Boolean(document.querySelector("[data-document-formatted] table"))',"Safe semantic table");
      assert.equal(await evaluate('document.querySelector("[data-document-reader-body]").textContent'),unsafe);
      assert.equal(await evaluate('document.querySelector("[data-document-formatted]").querySelector("script,img,svg,iframe")'),null);
      assert.equal(await evaluate('Boolean(window.__readingInjected)'),false);
      assert.equal(await evaluate('[...document.querySelectorAll("[data-document-formatted] a")].some(a=>/^(javascript|data):/i.test(a.href))'),false);
      assert.ok((await evaluate('document.querySelector("[data-document-formatted]").textContent')).includes('READY SHA-256 <img onerror=alert(1)>'));
      await act("[data-close-document]");setReaderText(documentText);
      await evaluate('document.querySelector("[data-theme-toggle]").click()');await cdp("Page.reload");
      await wait('document.documentElement.dataset.theme==="light"',"Theme persists");await evaluate('document.querySelector("[data-theme-toggle]").click()');
      await evaluate(`document.querySelector(${JSON.stringify(query)}).value="private retained intent";window.dispatchEvent(new Event("eliotr:authorization-cleared"))`);
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(query)}).value`),"");
      fixture.state.blocked=true;await cdp("Page.reload");await wait('Boolean(document.querySelector("[data-run-badge]"))',"Workspace reload");await click(nav);
      await wait('document.querySelector("[data-run-badge]").textContent==="BLOCKED"',"Blocked readiness remains visible");
      assert.equal(await evaluate('document.querySelector(".research-question-form button[type=submit]").disabled'),true);
      await evaluate(`(()=>{const q=document.querySelector(${JSON.stringify(query)});q.value="must not run";q.closest("form").requestSubmit();})()`);
      assert.equal(fixture.state.starts.length,1);await shot("research-blocked-1440x900");
      await openSources("Library readable when research blocked");await shot("documents-with-research-blocked-1440x900");
      await click(nav);await act('#research-run [data-nav-target="#research-configuration-card"]');
      assert.equal(await evaluate('location.hash'),"#research-configuration-card");await cdp("Page.reload");
      await wait('document.querySelector("#connections-card")?.hidden===false',"Connections deep link");
      await wait('document.querySelector("#app").dataset.healthReady==="true"',"Connections health readback");await shot("connections-1440x900");
      await viewport(390,844);await shot("connections-390x844");
      console.log("UI V2 PASS: dark/light desktop/mobile/tablet, Markdown and safe fallback, exact original download, menus/keyboard, citation/full source/focus/position, session/readback, delayed-response clearing, no duplicate research, blocked readiness and readable Library. Controlled HTTP; live qualification NOT_EXECUTED.");
    } catch(error){await shot("failure");console.error("UI V2 failure:",error.message);throw error;}
  })();
}

const root = fileURLToPath(new URL("../", import.meta.url));
const phase = "v2";
const reviewRoot = resolve(root, "../.codex-tools/ui-material-20261003");
await mkdir(resolve(reviewRoot, "tmp"), { recursive: true });
process.env.TEMP = resolve(reviewRoot, "tmp");
process.env.TMP = process.env.TEMP;
process.env.ELIOTR_SCREENSHOT_DIR = resolve(reviewRoot, phase);
process.env.ELIOTR_UI_REVIEW_PHASE = phase;
if (!process.argv.includes("--research-screen")) process.argv.push("--research-screen");
const runner = new URL("./test-library-browser.mjs", import.meta.url);
const document = await readFile(resolve(root, "docs/design/README.md"), "utf8");
let source = await readFile(runner, "utf8");
const replace = (from, to) => { assert.ok(source.includes(from), `Existing runner anchor changed: ${from.slice(0, 80)}`); source = source.replace(from, to); };
replace('import { createResearchScreenFixture, runResearchScreenCanary } from "./lib/browser-research-screen-fixture.mjs";', 'import { createResearchScreenFixture } from "./lib/browser-research-screen-fixture.mjs";\nconst runResearchScreenCanary = ' + reviewCanary.toString() + ';');
source = source.replaceAll(/from "(\.\/[^" ]+)"/gu, (_, relative) => `from "${new URL(relative, runner).href}"`);
replace('const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");', `const root = ${JSON.stringify(root)};\nconst reviewDocument = ${JSON.stringify(document)};\nconst reviewReaderState={text:reviewDocument};`);
replace('readFile, rm', 'readFile, writeFile, rm');
replace('draftSectionText, evidenceText, evidenceSha });', 'draftSectionText, evidenceText, evidenceSha, documentText: reviewDocument, setReaderText:text=>{reviewReaderState.text=text;} });');
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
      const bytes = Buffer.from(reviewReaderState.text, "utf8");
      response.setHeader("content-type", "text/plain; charset=utf-8"); response.setHeader("content-length", String(bytes.length));
      response.setHeader("x-eliotr-source-revision", "revision-1"); response.setHeader("x-eliotr-deployment-generation", "browser-fixture");
      response.setHeader("x-eliotr-content-sha256", createHash("sha256").update(bytes).digest("hex")); response.end(bytes); return;
    }
    const file = resolve(dist,`);
await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`).catch((error) => {
  console.error(error.message); process.exitCode = 1;
});
