// U1.4 pinned local UI qualification. Pure preflight exports never launch a browser.
/* global document: readonly, innerWidth: readonly, getComputedStyle: readonly, axe: readonly */

import { readFile, readdir, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { resolve, relative, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";
import { assertSemanticVisualValues } from "../../packages/ui/src/catalog/design-literals.ts";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const ROOT = resolve(import.meta.dirname, "../..");
const uiRequire = createRequire(resolve(ROOT, "packages/ui/package.json"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A UI target must be plain HTTP on loopback, with no credentials, query or hash. */
export function requireLocalBaseUrl(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new TypeError("base url must be a non-empty string");
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError(`base url is not a valid URL: ${input}`);
  }
  if (url.protocol !== "http:") {
    throw new TypeError(`base url must be http:, got ${url.protocol}`);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new TypeError(`base url host must be loopback, got ${url.hostname}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("base url must not carry credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new TypeError("base url must not carry query or hash");
  }
  return url;
}

/**
 * A story must be listed in the manager-owned catalog manifest and also exist in the live
 * Storybook index as a story. A docs entry or an unknown catalog id is not a renderable story.
 */
export function requireKnownStory(id, catalog, index) {
  const scenarios = Array.isArray(catalog?.scenarios) ? catalog.scenarios : Object.values(catalog?.scenarios ?? {}).flat();
  if (!Array.isArray(scenarios) || !scenarios.includes(id)) {
    throw new RangeError(`unknown catalog story id: ${id}`);
  }
  const entry = index?.entries?.[id];
  if (entry === undefined || entry === null) {
    throw new RangeError(`story id absent from live index: ${id}`);
  }
  if (entry.type !== "story") {
    throw new RangeError(`index entry is not a story (${entry.type}): ${id}`);
  }
  return entry;
}

/**
 * Visual baselines are evidence only. Nobody may auto-accept a baseline through this harness;
 * a changed rendering stays PENDING for named review.
 */
export function rejectBaselineAcceptance(options) {
  const flags = ["acceptBaseline", "accept_baseline", "accept-baseline"];
  for (const flag of flags) {
    if (options?.[flag]) {
      throw new TypeError(`baseline auto-acceptance is forbidden: ${flag}`);
    }
  }
  return true;
}

/** Only known switches are allowed; a misspelled safety flag cannot be ignored. */
export function parseOptions(args) {
  const options = {};
  const allowed = new Set(["base-url", "scenario", "story", "output", "baseline", "browser"]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (name?.includes("accept") || name?.includes("update-snapshot")) throw new Error("Baseline auto-acceptance is forbidden");
    if (!name?.startsWith("--") || !allowed.has(name.slice(2)) || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error(`Unknown or incomplete option: ${name}`);
    }
    if (Object.hasOwn(options, name.slice(2))) throw new Error(`Duplicate option: ${name}`);
    options[name.slice(2)] = args[index + 1];
  }
  return options;
}

async function sourceInputs() {
  const files = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = resolve(folder, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (/\.(?:css|tsx?|json)$/u.test(entry.name)) files.push(relative(ROOT, file).replaceAll("\\", "/"));
    }
  }
  await visit(resolve(ROOT, "packages/ui/src"));
  await visit(resolve(ROOT, "apps/eliotr-web/src"));
  return Promise.all(files.sort().map(async (path) => ({ path, sha256: sha256(await readFile(resolve(ROOT, path))) })));
}

export async function checkDesign() {
  const inputs = await sourceInputs();
  for (const { path } of inputs) {
    if (/\.(?:css|tsx?)$/u.test(path)) assertSemanticVisualValues(await readFile(resolve(ROOT, path), "utf8"), path);
  }
  // The same gate must reject a seeded violation, not merely scan clean input.
  let negative = false;
  try { assertSemanticVisualValues(".seed { color: #123456; }", "packages/ui/src/seed.css"); }
  catch { negative = true; }
  if (!negative) throw new Error("Semantic visual-value negative did not reject");
  return { files: inputs.length, negative: "PASS" };
}

/** Require the intended prop diagnostic, rather than accepting any compiler failure. */
export async function checkUndocumentedProp() {
  const folder = await mkdtemp(resolve(ROOT, ".eliotr-state/ui-prop-negative-"));
  const path = resolve(folder, "negative.tsx");
  try {
    await writeFile(path, 'import { Button } from "../../packages/ui/src/index";\nconst invalid = <Button undocumentedDesignProp="yes">Research</Button>;\nvoid invalid;\n');
    try {
      execFileSync(process.execPath, [resolve(ROOT, "node_modules/typescript/bin/tsc"), "--ignoreConfig", "--noEmit", "--jsx", "react-jsx", "--moduleResolution", "bundler", "--module", "esnext", "--target", "es2024", "--strict", "--skipLibCheck", path], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      const diagnostic = String(error.stdout);
      if (diagnostic.includes("TS2322") && diagnostic.includes("undocumentedDesignProp")) return { undocumented_prop: "REJECTED_BY_TYPESCRIPT" };
      throw new Error(`Undocumented-prop fixture failed for an unrelated compiler error: ${diagnostic.slice(0, 1600)}`, { cause: error });
    }
    throw new Error("Undocumented prop unexpectedly compiled");
  } finally { await rm(folder, { recursive: true }); }
}

async function runBrowser(command, options) {
  const base = requireLocalBaseUrl(options["base-url"] ?? "http://127.0.0.1:6006");
  const catalog = JSON.parse(await readFile(resolve(ROOT, "packages/ui/src/catalog/catalog.json"), "utf8"));
  const indexResponse = await fetch(new URL("/index.json", base), { redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!indexResponse.ok) throw new Error(`Storybook index unavailable: ${indexResponse.status}`);
  const index = await indexResponse.json();
  const scenario = options.scenario ?? "u1-direction";
  const stories = options.story ? [options.story] : catalog.scenarios[scenario];
  if (!Array.isArray(stories) || !stories.length) throw new Error(`Unknown scenario: ${scenario}`);
  for (const story of stories) requireKnownStory(story, catalog, index);
  const output = resolve(ROOT, options.output ?? `.eliotr-state/ui-owner/${scenario}`);
  const privateRoot = resolve(ROOT, ".eliotr-state");
  if (!output.startsWith(privateRoot + "/") && !output.startsWith(privateRoot + "\\")) throw new Error("Evidence output must stay in .eliotr-state");
  await mkdir(output, { recursive: true });
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: options.browser ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const inputs = await sourceInputs();
  const results = [];
  const expectedBrowser = "155.0.8059.40";
  try {
    if (browser.version() !== expectedBrowser) throw new Error(`Browser version drift: ${browser.version()} expected ${expectedBrowser}`);
    for (const width of [1440, 1024, 768, 390, 320]) {
      for (const story of stories) {
        const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, deviceScaleFactor: 1, reducedMotion: "reduce", colorScheme: story.includes("dark") ? "dark" : "light" });
        const page = await context.newPage();
        const errors = [], network = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
        page.on("response", response => { if (response.status() >= 400) network.push({ url: response.url(), status: response.status() }); });
        page.on("requestfailed", request => network.push({ url: request.url(), failure: request.failure()?.errorText }));
        page.on("request", request => { if (new URL(request.url()).origin !== base.origin) network.push({ remote: new URL(request.url()).origin }); });
        await page.goto(new URL(`/iframe.html?id=${encodeURIComponent(story)}&viewMode=story`, base).href);
        await page.locator("#storybook-root > *").first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.addScriptTag({ path: uiRequire.resolve("axe-core/axe.min.js") });
        const violations = await page.evaluate(async () => (await axe.run(document.getElementById("storybook-root"))).violations.map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) })));
        const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, theme: document.querySelector("[data-theme]")?.getAttribute("data-theme"), locale: document.querySelector("[lang]")?.getAttribute("lang"), panes: [...document.querySelectorAll(".er-pane")].filter(node => getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden").map(node => ({ class: node.className, overflow: getComputedStyle(node).overflowY, height: node.clientHeight, scrollHeight: node.scrollHeight, nestedScrollOwners: [...node.querySelectorAll("*:not(textarea):not(input):not(select)")].filter(child => ["auto", "scroll"].includes(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight).length })) }));
        // Capture the initial canonical composition; journey screenshots are separate evidence.
        const screenshot = `${width}-${story}.png`;
        await page.screenshot({ path: resolve(output, screenshot), animations: "disabled" });
        let focus = "NOT_APPLICABLE";
        if (story.startsWith("direction-workspace--") && !story.endsWith("loading")) {
          const citation = page.getByRole("button", { name: /^(?:Open citation 1|Открыть цитату 1)$/u });
          await citation.click();
          await page.waitForFunction(() => /Back to report|Вернуться к отчёту/u.test(document.activeElement?.textContent ?? ""));
          await page.keyboard.press("Escape");
          await page.waitForFunction(() => /Open citation 1|Открыть цитату 1/u.test(document.activeElement?.getAttribute("aria-label") ?? ""));
          await citation.click();
          await page.getByRole("button", { name: /^(?:View source context|Открыть контекст источника)$/u }).click();
          await page.waitForFunction(() => document.activeElement?.id === "direction-sources");
          focus = "PASS citation-open/Escape/return/source-context";
        }
        results.push({ width, story, ...layout, focus, violations, errors, network, screenshot, screenshot_sha256: sha256(await readFile(resolve(output, screenshot))) });
        await context.close();
      }
    }
    const after = await sourceInputs();
    const receipt = { protocol: "eliotr.ui-browser-review.v1", command, scenario, source_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), inputs, inputs_stable: JSON.stringify(inputs) === JSON.stringify(after), browser: browser.version(), playwright: "1.63.0", storybook: "10.6.1", os: [os.platform(), os.release()], results, baseline: "PENDING_NAMED_REVIEW", csp: "Storybook development only; isolated native CSP receipt separate", pending: ["native screenreader", "actual native200percent zoom", "full product CSP and performance", "native/staging/live/release"] };
    if (options.baseline) {
      const baseline = JSON.parse(await readFile(resolve(ROOT, options.baseline), "utf8"));
      if (baseline.browser !== receipt.browser || baseline.scenario !== scenario) throw new Error("Baseline environment/scenario mismatch");
      const changes = results.filter(row => baseline.results.find(previous => previous.width === row.width && previous.story === row.story)?.screenshot_sha256 !== row.screenshot_sha256);
      receipt.baseline = changes.length ? "CHANGED_REVIEW_REQUIRED" : "MATCH";
      receipt.changed_baselines = changes.map(row => ({ width: row.width, story: row.story }));
    } else if (command === "visual") throw new Error("Visual comparison requires an explicitly reviewed --baseline receipt");
    await writeFile(resolve(output, "review.json"), JSON.stringify(receipt, null, 2) + "\n");
    const failed = results.filter(row => row.overflow || row.violations.length || row.errors.length || row.network.length || row.panes.some(pane => pane.nestedScrollOwners > 0));
    if (failed.length || !receipt.inputs_stable || receipt.baseline === "CHANGED_REVIEW_REQUIRED") throw new Error(`UI review failed: ${failed.length} cases; receipt ${relative(ROOT, output)}/review.json`);
    return { cases: results.length, receipt: relative(ROOT, output).replaceAll("\\", "/") + "/review.json", baseline: receipt.baseline };
  } finally { await browser.close(); }
}

/** Qualify real native Escape/remount behavior in an isolated production bundle with HTTP CSP. */
async function runCsp(options) {
  const output = resolve(ROOT, ".eliotr-state/ui-owner/native-csp");
  await mkdir(output, { recursive: true });
  const web = createRequire(resolve(ROOT, "apps/eliotr-web/package.json"));
  const { build } = await import(pathToFileURL(web.resolve("vite")).href);
  await build({ root: resolve(ROOT, "packages/ui"), configFile: false, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: false, cssCodeSplit: false, rollupOptions: { input: resolve(ROOT, "packages/ui/.storybook/qualification.tsx"), output: { entryFileNames: "main.js", assetFileNames: "[name][extname]" } } } });
  const files = await readdir(output);
  const css = files.find(name => name.endsWith(".css"));
  if (!css) throw new Error("Qualification stylesheet missing");
  const policy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Material controls</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/${css}"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>`;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Security-Policy", policy);
    response.setHeader("X-Content-Type-Options", "nosniff");
    const name = request.url?.slice(1);
    try {
      if (!name) { response.setHeader("Content-Type", "text/html"); response.end(html); }
      else if (name === "favicon.svg") { response.setHeader("Content-Type", "image/svg+xml"); response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text x="5" y="19">e</text></svg>'); }
      else if (files.includes(name) && /\.(?:js|css)$/u.test(name)) { response.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : "text/javascript"); response.end(await readFile(resolve(output, name))); }
      else { response.writeHead(404); response.end(); }
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise(ready => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = await import("playwright-core");
  let browser;
  const results = [];
  try {
    browser = await chromium.launch({ executablePath: options.browser ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    if (browser.version() !== "155.0.8059.40") throw new Error("Pinned CSP browser changed");
    for (const scheme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: scheme, reducedMotion: "reduce" });
      const errors = [], network = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      page.on("request", request => { if (new URL(request.url()).origin !== base) network.push(request.url()); });
      await page.goto(base);
      const opener = page.getByRole("button", { name: "Review source", exact: true });
      const dialog = page.getByRole("dialog", { name: "Review source", exact: true });
      for (const close of ["escape", "explicit", "unmount", "escape"]) {
        await opener.click();
        await dialog.waitFor({ state: "visible" });
        if (close === "escape") await page.getByRole("button", { name: "Back to research", exact: true }).press("Escape");
        else await page.getByRole("button", { name: close === "unmount" ? "Leave review" : "Back to research", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        if (!await opener.evaluate(node => node === document.activeElement)) throw new Error(`Native ${close} focus return failed`);
      }
      await page.evaluate(await readFile(uiRequire.resolve("axe-core/axe.min.js"), "utf8"));
      const violations = await page.evaluate(async () => (await axe.run(document.querySelector("main"))).violations.map(item => item.id));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      const positiveErrors = [...errors];
      // Seed an actual policy violation after the positive qualification and prove it is observable.
      await page.evaluate(() => { const script = document.createElement("script"); script.textContent = 'document.documentElement.dataset.cspNegative = "executed"'; document.body.append(script); });
      if (await page.evaluate(() => document.documentElement.dataset.cspNegative === "executed") || !errors.slice(positiveErrors.length).some(error => error.includes("Content Security Policy"))) throw new Error("CSP failure negative was not detected");
      const screenshot = `${scheme}.png`;
      await page.screenshot({ path: resolve(output, screenshot), animations: "disabled" });
      results.push({ scheme, errors: positiveErrors, violations, overflow, network, focus: "PASS physical Escape/Back/unmount/StrictMode remount", csp_negative: "BLOCKED_AND_DETECTED", screenshot, screenshot_sha256: sha256(await readFile(resolve(output, screenshot))) });
      await page.close();
    }
    await writeFile(resolve(output, "review.json"), JSON.stringify({ protocol: "eliotr.ui-csp-review.v1", source_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), scope: "Isolated native-control production bundle; full product pending", policy, browser: browser.version(), known_build_warning: "@theme is ignored in this non-Tailwind isolation; full application uses the pinned Tailwind plugin", results }, null, 2) + "\n");
    if (results.some(row => row.errors.length || row.violations.length || row.overflow || row.network.length)) throw new Error("Native CSP qualification failed; inspect private review.json");
    return { cases: results.length, csp_negative: "BLOCKED_AND_DETECTED", receipt: ".eliotr-state/ui-owner/native-csp/review.json" };
  } finally { if (browser) await browser.close(); await new Promise(done => server.close(done)); }
}

async function main(args) {
  const [command, ...rest] = args;
  const options = parseOptions(rest);
  rejectBaselineAcceptance(options);
  if (command === "design") return checkDesign();
  if (command === "props") return checkUndocumentedProp();
  if (command === "csp") return runCsp(options);
  if (command === "history") {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    return execFileSync(process.execPath, [resolve(ROOT, "scripts/check-frontend-owner-checkpoints.mjs"), "--history-base", "c37e56e0ebdfc7f6d294879008a4036d1b95b985", "--head", head], { cwd: ROOT, encoding: "utf8" });
  }
  if (["browser", "a11y", "visual", "receipt"].includes(command)) return runBrowser(command, options);
  if (command === "stories") {
    const base = requireLocalBaseUrl(options["base-url"] ?? "http://127.0.0.1:6006");
    const catalog = JSON.parse(await readFile(resolve(ROOT, "packages/ui/src/catalog/catalog.json"), "utf8"));
    const indexResponse = await fetch(new URL("/index.json", base), { redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!indexResponse.ok) throw new Error("Storybook index unavailable");
    const index = await indexResponse.json();
    const stories = options.story ? [options.story] : catalog.scenarios[options.scenario ?? "u1-direction"];
    if (!Array.isArray(stories) || !stories.length) throw new Error("Unknown story scenario");
    const paths = [...new Set(stories.map(story => requireKnownStory(story, catalog, index).importPath))];
    for (const path of paths) if (typeof path !== "string" || !/^\.\/src\/[\w/-]+\.stories\.tsx$/u.test(path) || path.includes("..")) throw new Error("Unsafe live story import path");
    const names = stories.map(story => requireKnownStory(story, catalog, index).name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "$" ).join("|");
    return execFileSync(process.execPath, [resolve(dirname(uiRequire.resolve("vitest/package.json")), "vitest.mjs"), "run", "--config", ".storybook/vitest.config.ts", "--testNamePattern", names, ...paths], { cwd: resolve(ROOT, "packages/ui"), encoding: "utf8" });
  }
  throw new Error("Usage: node scripts/ui-owner/verify.mjs design|props|history|stories|browser|a11y|visual|receipt|csp [--base-url URL --scenario ID --story ID --output PRIVATE_PATH --baseline REVIEWED_RECEIPT --browser PINNED_EXECUTABLE]");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(result => console.log(typeof result === "string" ? result : JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
}
