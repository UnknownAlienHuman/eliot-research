// U1.4 pinned local UI qualification. Pure preflight exports never launch a browser.
/* global document: readonly, innerWidth: readonly, axe: readonly */

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

import {
  CANONICAL_STATES,
  TERMINAL_READY_MARKERS,
  DETERMINISM_FIELDS,
  requireDistinctSameShaBaseline,
  requireTerminalReadyMarker,
  requireCanonicalStates,
  compareDeterministicObservations
} from "./visual-determinism.mjs";
export * from "./visual-determinism.mjs";

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
  const allowed = new Set(["base-url", "scenario", "story", "output", "baseline", "browser", "browser-version", "run-attempt"]);
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

function requireBrowserVersion(options) {
  const version = options["browser-version"] ?? "155.0.8059.40";
  if (!/^\d+\.\d+\.\d+\.\d+$/u.test(version)) throw new TypeError(`Invalid browser version pin: ${version}`);
  return version;
}

async function sourceInputs() {
  const files = ["scripts/ui-owner/verify.mjs", "tests/ui-owner/harness/layout-observer.test.mjs"];
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

/**
 * Read the rendered application root, never Storybook's outer document. The harness must
 * observe the locale and the real Material scroll owners, and report a shell that declares
 * no owner instead of passing it vacuously.
 */
export function observeShellLayout(document = globalThis.document, computedStyle = globalThis.getComputedStyle) {
  const shell = document.querySelector(".er-shell");
  const visible = node => !node.hidden && computedStyle(node).display !== "none"
    && computedStyle(node).visibility !== "hidden" && node.getClientRects?.().length !== 0;
  const ownsScroll = node => ["auto", "scroll"].includes(computedStyle(node).overflowY);
  const panes = [...document.querySelectorAll(".er-pane, .er-shell-sources, .er-shell-reading")]
    .filter(visible).map(node => {
      const rootScrollOwners = ownsScroll(node) ? [node.className] : [];
      const nested = [...node.querySelectorAll("*:not(textarea):not(input):not(select)")]
        .filter(child => visible(child) && ownsScroll(child) && child.scrollHeight > child.clientHeight);
      return { class: node.className, overflow: computedStyle(node).overflowY,
        height: node.clientHeight, scrollHeight: node.scrollHeight, rootScrollOwners,
        nestedScrollOwners: nested.length, nestedScrollOwnerClasses: nested.map(child => child.className) };
    });
  const scrollOwners = panes.flatMap(pane => [...pane.rootScrollOwners, ...pane.nestedScrollOwnerClasses]);
  return {
    locale: (shell ?? document.querySelector("[lang]"))?.getAttribute("lang") ?? null,
    shellPresent: shell !== null,
    panes,
    scrollOwners,
    ownerObservation: scrollOwners.length ? "OWNERS_PRESENT" : "NONE_DECLARED",
  };
}

export function hasScrollOwnerFailure(layout) {
  return (layout.shellPresent && !layout.panes.length) || layout.panes.some(pane =>
    pane.nestedScrollOwners > 0 || (layout.shellPresent && pane.rootScrollOwners.length !== 1));
}

// Playwright serializes this self-contained observer; regressions exercise that same function.
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
  const expectedBrowser = requireBrowserVersion(options);
  const runAttempt = Number.isInteger(Number(options["run-attempt"])) && Number(options["run-attempt"]) > 0 ? Number(options["run-attempt"]) : 1;
  try {
    if (browser.version() !== expectedBrowser) throw new Error(`Browser version drift: ${browser.version()} expected ${expectedBrowser}`);
    for (const width of [1440, 1024, 768, 390, 320]) {
      for (const story of stories) {
        const declaredMarker = TERMINAL_READY_MARKERS.get(story);
        const canonical = CANONICAL_STATES.get(story);
        // A declared terminal composition and its declared readiness travel together. A story that declares one
        // without the other, or declares a marker the source never emits, is a harness/source defect and must fail
        // closed rather than falling back to the pre-journey root marker or a clock.
        if ((canonical === undefined) !== (declaredMarker === undefined)) {
          throw new Error(`Declared canonical state and terminal marker disagree for ${story}`);
        }
        const readyMarker = declaredMarker === undefined ? null : requireTerminalReadyMarker(declaredMarker);
        const canonicalStates = canonical === undefined ? null : requireCanonicalStates(story, canonical);
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
        // Declared readiness only: the story's own play function publishes its terminal marker after its terminal
        // assertions settle, and the harness waits for that marker before observing theme, locale, layout or pixels.
        // A missing, late, or wrong-root marker is a failure. No clock, frame allowance or network-idle check is
        // substituted for declared readiness, because those are not evidence that the journey finished.
        let readiness = "NO_PLAY_DECLARED";
        if (readyMarker !== null) {
          readyMarker.split(" ").length === 1 || (() => { throw new Error("Ready marker must be a single attribute"); })();
          await page.waitForSelector(`[${readyMarker}="ready"]`, { state: "attached", timeout: 30000 });
          readiness = await page.evaluate(marker => {
            const owner = document.querySelector(`.er-shell[${marker}="ready"]`) ?? document.querySelector(`[${marker}="ready"]`);
            if (!owner) return "MISSING";
            // The marker must sit on the element that carries the observed presentation, so a story wrapper or an
            // unrelated ancestor cannot satisfy readiness for a frame it does not own. A workspace journey renders a
            // Shell with `lang` and `data-theme`; a standalone feature story renders its own root, which carries its
            // declared locale on the section it owns and deliberately no theme. Neither may fake the other's seed.
            const presentation = owner.closest(".er-shell");
            if (presentation !== null) {
              if (owner !== presentation) return "MARKER_FOREIGN_ROOT";
              return presentation.getAttribute("lang") && presentation.getAttribute("data-theme") ? "MARKER_TERMINAL" : "MARKER_INCOMPLETE";
            }
            const standalone = owner.closest("[lang]");
            if (standalone === null) return "MARKER_INCOMPLETE";
            // The marker must be the standalone root itself, not a wrapper Storybook inserted above it.
            return owner.matches(".eliot-token-story") ? "MARKER_TERMINAL" : "MARKER_FOREIGN_ROOT";
          }, readyMarker);
          if (readiness !== "MARKER_TERMINAL") throw new Error(`Declared readiness did not settle for ${story} at ${width}: ${readiness}`);
        }
        await page.addScriptTag({ path: uiRequire.resolve("axe-core/axe.min.js") });
        const violations = await page.evaluate(async () => (await axe.run(document.getElementById("storybook-root"))).violations.map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) })));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        // Reset and assert the declared seed identity: theme, locale and route must come from the story's own
        // declaration, so an asynchronous change in one story cannot leak into another observation.
        const seed = await page.evaluate(() => {
          const shell = document.querySelector(".er-shell");
          // A standalone feature story renders no Shell, so its presentation root is the element that owns the
          // render. The locale is read from wherever the story actually declares it, never from an invented Shell.
          const standalone = shell === null ? document.querySelector(".eliot-token-story [lang]") : null;
          const root = document.getElementById("storybook-root");
          return {
            theme: shell?.getAttribute("data-theme") ?? null,
            locale: (shell ?? standalone)?.getAttribute("lang") ?? null,
            destination: shell?.getAttribute("data-destination") ?? null,
            rootChildren: root ? root.childElementCount : 0,
            rootFirstRole: root?.firstElementChild ? (root.firstElementChild.getAttribute("role") ?? root.firstElementChild.tagName.toLowerCase()) : null,
          };
        });
        if (seed.rootFirstRole === null) throw new Error(`Content seed missing for ${story} at ${width}`);
        // The observed presentation must be the one the story declares. An earlier `theme` assertion compared
        // against a substring of the story id, which the journeys that intentionally end dark could never
        // satisfy. The declared canonical state is the authority for what the terminal frame must show.
        if (canonicalStates !== null) {
          const declaredTheme = canonicalStates.theme, declaredDestination = canonicalStates.destination;
          const declaredLocale = canonicalStates.locale;
          const locales = Array.isArray(declaredLocale) ? declaredLocale : [declaredLocale];
          // `unknown` is declared only where the presentation root carries no such seed, so that field is skipped.
          // Skipping is explicit and local: the locale and the terminal marker are still mandatory, and a theme
          // the story does declare is still asserted.
          if (declaredTheme !== "unknown" && seed.theme !== declaredTheme) {
            throw new Error(`Canonical theme seed mismatch for ${story} at ${width}: observed ${seed.theme}, declared ${declaredTheme}`);
          }
          if (!locales.includes(seed.locale)) {
            throw new Error(`Canonical locale seed mismatch for ${story} at ${width}: observed ${seed.locale}, declared ${locales.join("/")}`);
          }
          if (declaredDestination !== "unknown" && seed.destination !== declaredDestination) {
            throw new Error(`Canonical destination seed mismatch for ${story} at ${width}: observed ${seed.destination}, declared ${declaredDestination}`);
          }
        }
        const layout = { overflow, theme: seed.theme, ...await page.evaluate(observeShellLayout) };
        // A standalone feature story carries no `data-theme`, so its layout observation reports no theme. Record
        // the declared `unknown` rather than a null that reads like an unread observation.
        if (layout.theme === null && canonicalStates?.theme === "unknown") layout.theme = "unknown";
        if ((layout.locale ?? null) !== null && layout.locale !== seed.locale) throw new Error(`Locale observation disagreed with the seed for ${story} at ${width}`);
        // Capture the declared canonical composition, which is the terminal one for a declared journey.
        const screenshot = `${width}-${story}.png`;
        await page.screenshot({ path: resolve(output, screenshot), animations: "disabled" });
        const screenshot_sha256 = sha256(await readFile(resolve(output, screenshot)));
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
        // `state` carries the declared canonical presentation the frame shows, and the same key is declared in
        // DETERMINISM_FIELDS, so the determinism comparison cannot silently skip a changed presentation.
        results.push({ width, story, state: canonicalStates === null ? "undeclared" : canonicalStates.state, run_attempt: runAttempt,
          // A seed the declared state marks `unknown` is recorded as `unknown`, never as a null observation, so a
          // receipt cannot imply the harness read a theme or destination the presentation root does not carry.
          locale: seed.locale, ...layout, focus, violations, errors,
          destination: seed.destination ?? (canonicalStates?.destination === "unknown" ? "unknown" : null),
          network, screenshot, screenshot_sha256, canonical_state: canonicalStates === null ? null : canonicalStates,
          declared_theme: canonicalStates === null ? null : canonicalStates.theme,
          declared_locale: canonicalStates === null ? null : canonicalStates.locale,
          declared_destination: canonicalStates === null ? null : canonicalStates.destination,
          marked_terminal: canonicalStates !== null });
        await context.close();
      }
    }
    const after = await sourceInputs();
    const receipt = { protocol: "eliotr.ui-browser-review.v2", command, scenario, source_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), run_attempt: runAttempt, run_attempts_required: 2, inputs, inputs_stable: JSON.stringify(inputs) === JSON.stringify(after), browser: browser.version(), expected_browser: expectedBrowser, playwright: "1.63.0", storybook: "10.6.1", os: [os.platform(), os.release()], determinism: { protocol: "eliotr.ui-determinism.v1", fields: DETERMINISM_FIELDS, tolerance: "NONE", auto_accept: "FORBIDDEN" }, results, baseline: "PENDING_NAMED_REVIEW", csp: "Storybook development only; isolated native CSP receipt separate", pending: ["native screenreader", "actual native200percent zoom", "full product CSP and performance", "native/staging/live/release", "second-run same-SHA determinism comparison"] };
    if (options.baseline) {
      const baseline = JSON.parse(await readFile(resolve(ROOT, options.baseline), "utf8"));
      if (baseline.browser !== receipt.browser || baseline.scenario !== scenario) throw new Error("Baseline environment/scenario mismatch");
      const sameSource = baseline.source_commit === receipt.source_commit;
      // Same SHA is a determinism claim about two runs of one build, so the two receipts must be genuinely
      // different capture attempts. A self-baseline compares a run against itself and proves nothing; two
      // attempts that share an id are the same attempt reported twice. Both fail closed here, before any
      // observation is compared.
      if (sameSource) {
      // The exported guard is the single implementation the CLI and its regressions both exercise.
      receipt.determinism.attempt_binding = requireDistinctSameShaBaseline(baseline, receipt, runAttempt);
      }
      // Same SHA: two runs of one build are a determinism claim, so every compared row must declare every
      // determinism field and a missing field fails closed rather than reading as two equal undefined values.
      // Older SHA: a reviewed baseline against an earlier accepted source is an ordinary regression review, so
      // only declared fields are compared and a difference is what that review is for.
      const comparison = compareDeterministicObservations(baseline.results, results, { requireFields: sameSource });
      const changes = comparison.changed;
      receipt.baseline = comparison.deterministic ? "MATCH" : "CHANGED_REVIEW_REQUIRED";
      receipt.changed_baselines = changes;
      receipt.determinism.comparison = comparison;
      receipt.determinism.mode = sameSource ? "SAME_SHA_TWO_RUNS" : "REVIEWED_BASELINE_OTHER_SHA";
      receipt.determinism.require_fields = sameSource;
      receipt.determinism.baseline_source_commit = baseline.source_commit;
      receipt.determinism.input_manifest_compared = sameSource
        ? "both run_attempt ids are distinct, both inputs_stable are true, and both source-input manifests are equal"
        : "declared observation fields compared; source-input manifest not compared across declared sources";
      receipt.determinism.input_manifest_equality = sameSource
        ? { checked: true, baseline_entries: baseline.inputs.length, current_entries: receipt.inputs.length, equal: JSON.stringify(baseline.inputs) === JSON.stringify(receipt.inputs) }
        : { checked: false, reason: "reviewed baseline against another declared source; observation fields decide" };
    } else if (command === "visual") throw new Error("Visual comparison requires an explicitly reviewed --baseline receipt");
    await writeFile(resolve(output, "review.json"), JSON.stringify(receipt, null, 2) + "\n");
    const failed = results.filter(row => row.overflow || row.violations.length || row.errors.length || row.network.length || hasScrollOwnerFailure(row));
    if (failed.length || !receipt.inputs_stable || receipt.baseline === "CHANGED_REVIEW_REQUIRED") throw new Error(`UI review failed: ${failed.length} cases; receipt ${relative(ROOT, output)}/review.json`);
    return { cases: results.length, run_attempt: runAttempt, receipt: relative(ROOT, output).replaceAll("\\", "/") + "/review.json", baseline: receipt.baseline };
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
  const expectedBrowser = requireBrowserVersion(options);
  try {
    browser = await chromium.launch({ executablePath: options.browser ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    if (browser.version() !== expectedBrowser) throw new Error(`Pinned CSP browser changed: ${browser.version()} expected ${expectedBrowser}`);
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
    await writeFile(resolve(output, "review.json"), JSON.stringify({ protocol: "eliotr.ui-csp-review.v1", source_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), scope: "Isolated native-control production bundle; full product pending", policy, browser: browser.version(), expected_browser: expectedBrowser, known_build_warning: "@theme is ignored in this non-Tailwind isolation; full application uses the pinned Tailwind plugin", results }, null, 2) + "\n");
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
  throw new Error("Usage: node scripts/ui-owner/verify.mjs design|props|history|stories|browser|a11y|visual|receipt|csp [--base-url URL --scenario ID --story ID --output PRIVATE_PATH --baseline REVIEWED_RECEIPT --browser PINNED_EXECUTABLE --browser-version EXACT_VERSION]");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(result => console.log(typeof result === "string" ? result : JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
}
