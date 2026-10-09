import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, dirname, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gzipSync } from "node:zlib";
import ts from "typescript";

const KIB = 1024;
const BINARY_UNITS = new Map([
  ["B", 1],
  ["KIB", KIB],
  ["MIB", KIB * KIB],
  ["GIB", KIB * KIB * KIB],
]);

export const WORKER_GZIP_BUDGET_BYTES = 4 * KIB * KIB;
export const OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES = 600 * KIB;
export const RECEIPT_PROTOCOL = "eliotr.emitted-build-budget-receipt.v1";
export const DEFAULT_RECEIPT_PATH = "apps/eliotr-core/.wrangler/s90-emitted-budget-receipt.json";

const EXPECTED_BUILD_COMMANDS = Object.freeze({
  combined: "pnpm build:pwa && pnpm --filter @eliotr/core deploy:dry-run",
  emitted: "node scripts/check-emitted-budgets.mjs",
  emittedCheck: "node scripts/check-emitted-budgets.mjs --check-only",
  pwa: "node scripts/build-agent-inbox.mjs && astro build",
  worker: "wrangler deploy --dry-run --minify --outdir dist",
  types: "node ../../scripts/generate-cloudflare-types.mjs",
});
const EXPECTED_ENVIRONMENT_PROFILE =
  "local dry-run; top-level Wrangler config; no --remote; no explicit target environment";
const SOURCE_BUDGET_DIAGNOSTIC_POLICY = "separate maintainability diagnostics; not runtime metrics";
const EMITTED_ARTIFACT_ROOTS = Object.freeze([
  "apps/eliotr-core/dist",
  "apps/eliotr-pwa/dist",
]);
// This process-local identity is not serialized into receipts. Persisted multipart
// reports cannot reconstruct Wrangler's ordered module-byte input to gzip.
const freshNativeWorkerMeasurements = new WeakSet();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedPath(value) {
  return value.split(sep).join("/");
}

function isAllowedEmittedArtifactPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\") || path.startsWith("/")) {
    return false;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return false;
  return EMITTED_ARTIFACT_ROOTS.some((artifactRoot) =>
    path === artifactRoot || path.startsWith(artifactRoot + "/"));
}

async function resolveSafeEmittedArtifactPath(root, artifactPath) {
  if (!isAllowedEmittedArtifactPath(artifactPath)) {
    throw new Error("Artifact path is outside the exact emitted build locations");
  }

  const repositoryRoot = await realpath(root);
  const segments = artifactPath.split("/");
  let absolute = repositoryRoot;
  let missing = false;
  let details = null;
  for (let index = 0; index < segments.length; index += 1) {
    absolute = resolve(absolute, segments[index]);
    if (missing) continue;
    try {
      details = await lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") {
        missing = true;
        continue;
      }
      throw error;
    }
    if (details.isSymbolicLink()) throw new Error("Symbolic links are not valid build artifacts");
    if (index < segments.length - 1 && !details.isDirectory()) {
      throw new Error("An emitted artifact path crosses a non-directory entry");
    }
  }

  if (missing) {
    return { absolute: resolve(repositoryRoot, ...segments), exists: false, details: null };
  }

  const actualPath = await realpath(absolute);
  const repositoryRelative = relative(repositoryRoot, actualPath);
  if (repositoryRelative === ".." || repositoryRelative.startsWith(".." + sep)) {
    throw new Error("Artifact path resolves outside the repository");
  }
  return { absolute, exists: true, details };
}

function cleanModuleName(value) {
  let name = String(value).replaceAll("\\", "/");
  const repositoryMarker = "/eliot-research/";
  const repositoryIndex = name.toLowerCase().lastIndexOf(repositoryMarker);
  if (repositoryIndex >= 0) return "repo/" + name.slice(repositoryIndex + repositoryMarker.length);

  const packageMarker = "/node_modules/";
  const packageIndex = name.lastIndexOf(packageMarker);
  if (packageIndex >= 0) return "package/" + name.slice(packageIndex + packageMarker.length);
  if (/^[A-Za-z]:\//u.test(name) || name.startsWith("/") || name.startsWith("file:")) {
    return "external/" + name.slice(name.lastIndexOf("/") + 1);
  }
  return name.replace(/^(\.\.\/)+/u, "workspace/");
}

function runGit(root, args) {
  return execFileSync("git", args, { cwd: root });
}

export async function captureSourceIdentity(root, buildInputDigests = {}) {
  const head = runGit(root, ["rev-parse", "HEAD"]).toString("utf8").trim();
  const status = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const diff = runGit(root, ["diff", "HEAD", "--binary"]);
  const untrackedList = runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const untrackedParts = [];
  for (const path of untrackedList) {
    const absolute = resolve(root, path);
    const details = await stat(absolute);
    if (!details.isFile()) continue;
    const content = await readFile(absolute);
    untrackedParts.push(Buffer.from(path.replaceAll("\\", "/") + "\0" + sha256(content) + "\0"));
  }

  const lockfile = await readFile(resolve(root, "pnpm-lock.yaml"));
  const dirtyMaterial = Buffer.concat([status, diff, ...untrackedParts]);
  const stableBuildInputDigests = Object.fromEntries(
    Object.entries(buildInputDigests).sort(([left], [right]) => left.localeCompare(right)),
  );
  const buildInputDigestSha256 = sha256(JSON.stringify(stableBuildInputDigests));
  const statusEntries = status.toString("utf8").split("\0").filter(Boolean);
  return {
    commit: head,
    dirty: status.length > 0,
    dirtyEntryCount: statusEntries.length,
    dirtyDigest: sha256(dirtyMaterial),
    lockfileSha256: sha256(lockfile),
    buildInputDigests: stableBuildInputDigests,
    buildInputDigestSha256,
    fingerprint: sha256(Buffer.concat([
      Buffer.from(head + "\0"),
      dirtyMaterial,
      Buffer.from(sha256(lockfile)),
      Buffer.from(buildInputDigestSha256),
    ])),
  };
}

async function listFiles(root, artifactDirectory) {
  const safeDirectory = await resolveSafeEmittedArtifactPath(root, artifactDirectory);
  if (!safeDirectory.exists) return [];
  if (!safeDirectory.details.isDirectory()) throw new Error("Emitted artifact root is not a directory");
  const base = safeDirectory.absolute;
  const result = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = resolve(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Symbolic links are not valid build artifacts");
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        result.push({
          absolute,
          relative: normalizedPath(relative(base, absolute)),
        });
      }
    }
  }
  await visit(base);
  return result.sort((left, right) => left.relative.localeCompare(right.relative));
}

function isJavaScriptPath(path) {
  return [".js", ".mjs", ".cjs"].includes(extname(path).toLowerCase());
}

function parseAttributes(source) {
  const result = new Map();
  const expression = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;
  for (const match of source.matchAll(expression)) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    result.set(key, value);
  }
  return result;
}

function resolveLocalSpecifier(specifier, importerPath, distRoot) {
  const value = String(specifier).split(/[?#]/u, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("A module URL contains invalid escaping");
  }
  if (/^(?:[a-z]+:)?\/\//iu.test(decoded) || decoded.startsWith("data:")) {
    throw new Error("An emitted JavaScript module references a non-local URL");
  }
  const joined = decoded.startsWith("/")
    ? resolve(distRoot, "." + decoded)
    : resolve(distRoot, dirname(importerPath), decoded);
  const relativePath = normalizedPath(relative(distRoot, joined));
  if (relativePath === ".." || relativePath.startsWith("../") || resolve(joined) === resolve(distRoot)) {
    throw new Error("An emitted JavaScript module escapes the PWA build directory");
  }
  return relativePath;
}

function moduleEdges(source, fileName) {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics?.length) throw new Error("An emitted JavaScript asset could not be parsed");
  const edges = { staticImports: [], dynamicImports: [], workerImports: [], unresolved: [] };

  function literalText(node) {
    return node && ts.isStringLiteralLike(node) ? node.text : null;
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier === null) edges.unresolved.push("static import");
      else edges.staticImports.push(specifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier === null) edges.unresolved.push("re-export");
      else edges.staticImports.push(specifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = literalText(node.arguments[0]);
      if (specifier === null) edges.unresolved.push("dynamic import");
      else edges.dynamicImports.push(specifier);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
        ["Worker", "SharedWorker"].includes(node.expression.text)) {
      let urlNode;
      function findUrl(child) {
        if (!urlNode && ts.isNewExpression(child) && ts.isIdentifier(child.expression) &&
            child.expression.text === "URL") {
          urlNode = child;
        }
        ts.forEachChild(child, findUrl);
      }
      for (const argument of node.arguments ?? []) findUrl(argument);
      const specifier = urlNode && literalText(urlNode.arguments?.[0]);
      if (specifier === null || specifier === undefined) edges.unresolved.push("worker URL");
      else edges.workerImports.push(specifier);
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return edges;
}

function parseHtmlScripts(html, htmlPath, distRoot) {
  const roots = [];
  const inline = [];
  let scriptIndex = 0;

  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)) {
    const attributes = parseAttributes(match[1]);
    const type = (attributes.get("type") ?? "").trim().toLowerCase();
    if (["application/json", "application/ld+json", "importmap"].includes(type)) continue;
    const src = attributes.get("src");
    if (src) {
      roots.push({
        path: resolveLocalSpecifier(src, htmlPath, distRoot),
        kind: type === "module" ? "module-entry" : "classic-script",
      });
    } else if (match[2].trim()) {
      const key = "inline:" + htmlPath + "#" + scriptIndex;
      inline.push({ key, source: match[2], kind: type === "module" ? "inline-module" : "inline-script" });
    }
    scriptIndex += 1;
  }

  for (const match of html.matchAll(/<link\b([^>]*)>/giu)) {
    const attributes = parseAttributes(match[1]);
    if ((attributes.get("rel") ?? "").toLowerCase().split(/\s+/u).includes("modulepreload")) {
      const href = attributes.get("href");
      if (href) roots.push({ path: resolveLocalSpecifier(href, htmlPath, distRoot), kind: "modulepreload" });
    }
  }
  return { roots, inline };
}

function aggregateClosure(startPaths, graph, followDynamicImports) {
  const seen = new Set();
  const pending = [...startPaths];
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const edges = graph.get(current);
    if (!edges) continue;
    pending.push(...edges.staticImports);
    if (followDynamicImports) pending.push(...edges.dynamicImports);
  }
  return seen;
}

function formatPathForReceipt(prefix, path) {
  return normalizedPath(prefix + "/" + path);
}

export async function inspectPwaBuild(root, buildStartedAt) {
  const distRoot = resolve(root, "apps/eliotr-pwa/dist");
  const files = (await listFiles(root, "apps/eliotr-pwa/dist")).filter((entry) =>
    !entry.relative.split("/").some((part) => part.startsWith(".")),
  );
  const assets = [];
  const bytesByPath = new Map();
  for (const file of files) {
    const content = await readFile(file.absolute);
    const compressedBytes = gzipSync(content, { level: 9 }).byteLength;
    const artifact = {
      path: formatPathForReceipt("apps/eliotr-pwa/dist", file.relative),
      sha256: sha256(content),
      rawBytes: content.byteLength,
      gzipBytes: compressedBytes,
      kind: isJavaScriptPath(file.relative) ? "javascript" :
        extname(file.relative).toLowerCase() === ".css" ? "css" : "asset",
    };
    assets.push(artifact);
    bytesByPath.set(file.relative, content);
  }

  const htmlFiles = files.filter((file) => file.relative.toLowerCase().endsWith(".html"));
  const graph = new Map();
  const routeScripts = [];
  const issues = [];
  const graphFiles = files.filter((file) => isJavaScriptPath(file.relative));
  for (const file of graphFiles) {
    try {
      const source = (await readFile(file.absolute)).toString("utf8");
      const unresolved = moduleEdges(source, file.relative);
      const resolveAll = (values) => values
        .map((value) => resolveLocalSpecifier(value, file.relative, distRoot))
        .filter(isJavaScriptPath);
      graph.set(file.relative, {
        staticImports: resolveAll(unresolved.staticImports),
        dynamicImports: resolveAll(unresolved.dynamicImports),
        workerImports: resolveAll(unresolved.workerImports),
        unresolved: unresolved.unresolved,
      });
    } catch (error) {
      issues.push((error?.message ?? "JavaScript graph parse failed") + ": " + file.relative);
    }
  }

  for (const htmlFile of htmlFiles) {
    const html = (await readFile(htmlFile.absolute)).toString("utf8");
    try {
      const scripts = parseHtmlScripts(html, htmlFile.relative, distRoot);
      const entryPaths = [...new Set(scripts.roots.map((rootEntry) => rootEntry.path))];
      for (const rootEntry of scripts.roots) {
        if (!bytesByPath.has(rootEntry.path)) issues.push("HTML references missing JavaScript: " + htmlFile.relative);
        else if (!isJavaScriptPath(rootEntry.path)) issues.push("HTML script reference is not a JavaScript asset: " + htmlFile.relative);
      }
      const routeSegments = htmlFile.relative
        .replace(/(^|\/)index\.html$/u, "$1")
        .replace(/\/+$/u, "");
      const routePath = routeSegments ? "/" + routeSegments + "/" : "/";
      routeScripts.push({
        htmlPath: htmlFile.relative,
        routePath,
        isInbox: routePath.startsWith("/agent-inbox/"),
        entryPaths,
        inline: scripts.inline,
      });
    } catch (error) {
      issues.push((error?.message ?? "HTML entry parse failed") + ": " + htmlFile.relative);
    }
  }

  const ownerRoutes = routeScripts.filter((route) => !route.isInbox);
  const inboxRoutes = routeScripts.filter((route) => route.isInbox);
  if (ownerRoutes.length === 0) issues.push("No owner-web HTML entry was emitted");
  if (inboxRoutes.length === 0) issues.push("The independent agent-inbox HTML entry is missing");

  const assetByPath = new Map(assets.map((asset) => [
    asset.path.replace("apps/eliotr-pwa/dist/", ""),
    asset,
  ]));
  const ownerRouteClosures = [];
  const usageCounts = new Map();
  const routeSummaries = [];
  const workerAll = new Set();
  for (const route of [...ownerRoutes, ...inboxRoutes]) {
    if (route.entryPaths.length === 0 && route.inline.length === 0) {
      issues.push("HTML entry has no executable JavaScript: " + route.htmlPath);
      continue;
    }
    for (const inline of route.inline) {
      const result = moduleEdges(inline.source, inline.key + ".js");
      if (result.unresolved.length) issues.push("Inline script has unresolved imports: " + route.htmlPath);
      const resolved = {
        staticImports: result.staticImports
          .map((value) => resolveLocalSpecifier(value, route.htmlPath, distRoot))
          .filter(isJavaScriptPath),
        dynamicImports: result.dynamicImports
          .map((value) => resolveLocalSpecifier(value, route.htmlPath, distRoot))
          .filter(isJavaScriptPath),
        workerImports: result.workerImports
          .map((value) => resolveLocalSpecifier(value, route.htmlPath, distRoot))
          .filter(isJavaScriptPath),
        unresolved: result.unresolved,
      };
      graph.set(inline.key, resolved);
      const inlineBytes = Buffer.from(inline.source, "utf8");
      bytesByPath.set(inline.key, inlineBytes);
    }

    const initial = aggregateClosure([
      ...route.entryPaths.filter((path) => bytesByPath.has(path)),
      ...route.inline.map((item) => item.key),
    ], graph, false);
    const pendingDynamic = [...initial];
    const dynamicSeen = new Set();
    const processedDynamic = new Set();
    const routeWorkers = new Set();
    while (pendingDynamic.length > 0) {
      const current = pendingDynamic.pop();
      if (processedDynamic.has(current)) continue;
      processedDynamic.add(current);
      const edges = graph.get(current);
      if (!edges) continue;
      if (edges.unresolved.length > 0) {
        issues.push("Reachable JavaScript has an unresolved import: " + route.htmlPath);
      }
      for (const target of [...edges.staticImports, ...edges.dynamicImports, ...edges.workerImports]) {
        if (!bytesByPath.has(target)) issues.push("Reachable JavaScript references a missing asset: " + route.htmlPath);
      }
      for (const target of edges.workerImports) {
        workerAll.add(target);
        routeWorkers.add(target);
      }
      for (const target of edges.dynamicImports) {
        const closure = aggregateClosure([target], graph, true);
        for (const item of closure) {
          if (!initial.has(item)) dynamicSeen.add(item);
          pendingDynamic.push(item);
        }
      }
    }

    if (!route.isInbox) {
      ownerRouteClosures.push({ route, initial });
      for (const path of initial) usageCounts.set(path, (usageCounts.get(path) ?? 0) + 1);
    }
    const initialRecords = [...initial].map((path) => {
      const content = bytesByPath.get(path);
      return {
        path: path.startsWith("inline:") ? path : formatPathForReceipt("apps/eliotr-pwa/dist", path),
        rawBytes: content.byteLength,
        gzipBytes: gzipSync(content, { level: 9 }).byteLength,
      };
    });
    const initialPaths = new Set(initial);
    const dynamicRecords = [...dynamicSeen]
      .filter((path) => !initialPaths.has(path) && bytesByPath.has(path))
      .map((path) => ({
        path: formatPathForReceipt("apps/eliotr-pwa/dist", path),
        rawBytes: bytesByPath.get(path).byteLength,
        gzipBytes: gzipSync(bytesByPath.get(path), { level: 9 }).byteLength,
      }));
    routeSummaries.push({
      route: route.routePath,
      category: route.isInbox ? "agent-inbox" : "owner-web",
      initialJavaScript: {
        rawBytes: initialRecords.reduce((sum, item) => sum + item.rawBytes, 0),
        gzipBytes: initialRecords.reduce((sum, item) => sum + item.gzipBytes, 0),
        resources: initialRecords,
      },
      lazyJavaScript: {
        rawBytes: dynamicRecords.reduce((sum, item) => sum + item.rawBytes, 0),
        gzipBytes: dynamicRecords.reduce((sum, item) => sum + item.gzipBytes, 0),
        resources: dynamicRecords,
      },
      workerJavaScript: [...routeWorkers]
        .filter((path) => assetByPath.has(path))
        .map((path) => assetByPath.get(path)),
    });
  }

  const sharedInitialPaths = new Set(
    [...usageCounts].filter(([, count]) => count > 1).map(([path]) => path),
  );
  const ownerEntries = routeSummaries.filter((route) => route.category === "owner-web");
  const mainRoute = ownerEntries.find((route) => route.route === "/") ?? null;
  if (!mainRoute) issues.push("The required root owner-web route is missing");

  const sharedRecords = [...sharedInitialPaths]
    .filter((path) => assetByPath.has(path))
    .map((path) => assetByPath.get(path));
  const workerRecords = [...workerAll]
    .filter((path) => assetByPath.has(path))
    .map((path) => assetByPath.get(path));
  const initialGzipBytes = mainRoute?.initialJavaScript.gzipBytes ?? null;
  const initialRawBytes = mainRoute?.initialJavaScript.rawBytes ?? null;
  const inbox = routeSummaries.find((route) => route.category === "agent-inbox") ?? null;
  const allJavaScriptPaths = new Set(graphFiles.map((file) => file.relative));
  const referencedPaths = new Set();
  for (const route of routeScripts) {
    for (const item of route.entryPaths) referencedPaths.add(item);
  }
  for (const route of routeSummaries) {
    for (const item of [
      ...route.initialJavaScript.resources,
      ...route.lazyJavaScript.resources,
    ]) {
      if (!item.path.startsWith("inline:")) referencedPaths.add(item.path.replace("apps/eliotr-pwa/dist/", ""));
    }
  }
  for (const item of workerAll) referencedPaths.add(item);
  const independentJavaScript = [...allJavaScriptPaths]
    .filter((path) => !referencedPaths.has(path))
    .map((path) => assetByPath.get(path))
    .filter(Boolean);

  const requiredFreshPaths = new Set([
    "index.html",
    "agent-inbox/index.html",
    ...routeScripts.flatMap((route) => route.entryPaths),
  ]);
  let buildOutputFresh = true;
  for (const path of requiredFreshPaths) {
    const file = files.find((entry) => entry.relative === path);
    if (!file) {
      buildOutputFresh = false;
      continue;
    }
    if ((await stat(file.absolute)).mtimeMs < Date.parse(buildStartedAt) - 1500) buildOutputFresh = false;
  }
  const inboxApp = files.find((entry) => entry.relative === "agent-inbox/app.js");
  if (inboxApp && (await stat(inboxApp.absolute)).mtimeMs < Date.parse(buildStartedAt) - 1500) {
    buildOutputFresh = false;
  }
  if (!buildOutputFresh) issues.push("A required PWA entry artifact predates this build");

  const status = issues.length > 0
    ? "NOT_MEASURED"
    : initialGzipBytes > OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES ? "FAIL" : "PASS";
  return {
    status,
    threshold: {
      gzipBytes: OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES,
      unit: "bytes",
      display: "600 KiB gzip",
    },
    initialOwnerWebJavaScript: {
      route: mainRoute?.route ?? null,
      rawBytes: initialRawBytes,
      gzipBytes: initialGzipBytes,
      method: "sum gzip level 9 bytes per distinct eager JS resource in the route static import graph",
      status: !mainRoute || issues.length > 0
        ? "NOT_MEASURED"
        : initialGzipBytes > OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES ? "FAIL" : "PASS",
    },
    routes: routeSummaries,
    sharedInitialChunks: sharedRecords,
    lazyJavaScript: {
      rawBytes: mainRoute?.lazyJavaScript.rawBytes ?? null,
      gzipBytes: mainRoute?.lazyJavaScript.gzipBytes ?? null,
      resources: mainRoute?.lazyJavaScript.resources ?? [],
    },
    workerJavaScript: workerRecords,
    agentInbox: inbox,
    otherIndependentJavaScript: independentJavaScript,
    allDistAssets: assets,
    artifactFiles: assets.map((asset) => ({
      path: asset.path,
      sha256: asset.sha256,
      rawBytes: asset.rawBytes,
    })),
    issues,
    buildOutputFresh,
  };
}

function parseByteQuantity(value, unit) {
  const multiplier = BINARY_UNITS.get(String(unit).toUpperCase());
  if (!multiplier) throw new Error("Wrangler reported an unsupported size unit");
  const decimalPlaces = String(value).split(".")[1]?.length ?? 0;
  return { bytes: Number(value) * multiplier, precisionBytes: multiplier * (10 ** -decimalPlaces) / 2 };
}

function sourceMapModules(sourceMap) {
  if (sourceMap?.version !== 3 || !Array.isArray(sourceMap.sources) || sourceMap.sources.length === 0) {
    throw new Error("Wrangler emitted no usable source-map module manifest");
  }
  const sourceContents = Array.isArray(sourceMap.sourcesContent) ? sourceMap.sourcesContent : [];
  return sourceMap.sources.map((source, index) => ({
    source: cleanModuleName(source),
    sourceSha256: typeof sourceContents[index] === "string" ? sha256(sourceContents[index]) : null,
  }));
}

export function parseWranglerBundleReport(output) {
  const clean = output.replace(/\u001B\[[0-9;]*m/gu, "");
  const matches = [...clean.matchAll(/Total Upload:\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KiB|MiB|GiB)\s*\/\s*gzip:\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KiB|MiB|GiB)/giu)];
  const version = clean.match(/wrangler\s+([0-9]+\.[0-9]+\.[0-9]+)(?:[^\d]|$)/iu)?.[1] ?? null;
  const assetReadCount = clean.match(/Read\s+([0-9]+)\s+files from the assets directory/iu)?.[1];
  const completedDryRun = /--dry-run:\s*exiting now\./iu.test(clean);
  if (matches.length !== 1 || !version || !completedDryRun) {
    return {
      status: "NOT_MEASURED",
      issues: ["Wrangler output did not match the supported dry-run report shape"],
      version,
      assetReadEntryCount: assetReadCount === undefined ? null : Number(assetReadCount),
    };
  }
  const match = matches[0];
  const raw = parseByteQuantity(match[1], match[2]);
  const gzip = parseByteQuantity(match[3], match[4]);
  if ([raw, gzip].some((quantity) => !Number.isFinite(quantity.bytes) ||
      quantity.bytes > Number.MAX_SAFE_INTEGER || quantity.precisionBytes <= 0)) {
    return {
      status: "NOT_MEASURED",
      issues: ["Wrangler size report exceeds supported numeric precision"],
      version,
      assetReadEntryCount: assetReadCount === undefined ? null : Number(assetReadCount),
    };
  }
  return {
    status: "MEASURED",
    version,
    completedDryRun,
    assetReadEntryCount: assetReadCount === undefined ? null : Number(assetReadCount),
    raw: { reported: match[1] + " " + match[2], ...raw },
    gzip: { reported: match[3] + " " + match[4], ...gzip },
  };
}

async function inspectWorkerBuildWithReport(root, buildStartedAt, report) {
  const issues = [...(report.issues ?? [])];
  const [entryLocation, mapLocation] = await Promise.all([
    resolveSafeEmittedArtifactPath(root, "apps/eliotr-core/dist/index.js"),
    resolveSafeEmittedArtifactPath(root, "apps/eliotr-core/dist/index.js.map"),
  ]);
  const entryPath = entryLocation.absolute;
  const mapPath = mapLocation.absolute;
  let entryContent;
  let sourceMapContent;
  let entryStat;
  let mapStat;
  try {
    [entryContent, sourceMapContent, entryStat, mapStat] = await Promise.all([
      readFile(entryPath),
      readFile(mapPath, "utf8"),
      stat(entryPath),
      stat(mapPath),
    ]);
  } catch {
    issues.push("Wrangler entry bundle or source-map module manifest is missing");
  }

  const freshSince = Date.parse(buildStartedAt) - 1500;
  if (entryStat && entryStat.mtimeMs < freshSince) issues.push("Wrangler entry bundle predates this dry-run");
  if (mapStat && mapStat.mtimeMs < freshSince) issues.push("Wrangler module manifest predates this dry-run");
  let modules = [];
  let moduleManifestSha256 = null;
  if (sourceMapContent) {
    try {
      const sourceMap = JSON.parse(sourceMapContent);
      modules = sourceMapModules(sourceMap);
      moduleManifestSha256 = sha256(JSON.stringify(modules));
      if (modules.some((module) => module.sourceSha256 === null)) {
        issues.push("Wrangler module manifest omits source content for one or more modules");
      }
    } catch (error) {
      issues.push(error?.message ?? "Wrangler source-map module manifest is invalid");
    }
  }

  const outputFiles = await listFiles(root, "apps/eliotr-core/dist");
  const wasmFiles = [];
  for (const file of outputFiles.filter((entry) => extname(entry.relative).toLowerCase() === ".wasm")) {
    const content = await readFile(file.absolute);
    wasmFiles.push({
      path: formatPathForReceipt("apps/eliotr-core/dist", file.relative),
      sha256: sha256(content),
      rawBytes: content.byteLength,
      gzipBytes: gzipSync(content).byteLength,
      freshSinceBuild: (await stat(file.absolute)).mtimeMs >= freshSince,
    });
  }

  const entry = entryContent ? {
    path: "apps/eliotr-core/dist/index.js",
    sha256: sha256(entryContent),
    rawBytes: entryContent.byteLength,
    gzipBytes: gzipSync(entryContent).byteLength,
  } : null;
  const sourceMapArtifact = sourceMapContent ? {
    path: "apps/eliotr-core/dist/index.js.map",
    sha256: sha256(sourceMapContent),
    rawBytes: Buffer.byteLength(sourceMapContent),
  } : null;
  const wasmRawBytes = wasmFiles.reduce((sum, item) => sum + item.rawBytes, 0);
  const knownAggregateRawBytes = entry ? entry.rawBytes + wasmRawBytes : null;
  let rawReconciliation = "NOT_MEASURED";
  let rawDeltaBytes = null;
  if (knownAggregateRawBytes !== null && report.raw?.bytes !== undefined) {
    rawDeltaBytes = report.raw.bytes - knownAggregateRawBytes;
    if (rawDeltaBytes > report.raw.precisionBytes) {
      rawReconciliation = "UNSUPPORTED_EXTERNAL_MODULES";
      issues.push("Wrangler Total Upload contains external module bytes not represented by the entry or Wasm artifacts");
    } else if (rawDeltaBytes < -report.raw.precisionBytes) {
      rawReconciliation = "RAW_TOTAL_MISMATCH";
      issues.push("Wrangler raw Total Upload is smaller than the emitted entry and Wasm artifacts");
    } else {
      rawReconciliation = wasmFiles.length > 0 ? "ENTRY_PLUS_WASM_MATCHED" : "ENTRY_MATCHED";
    }
  }
  if (entry && wasmFiles.length === 0 && rawReconciliation === "ENTRY_MATCHED" && report.gzip?.bytes !== undefined &&
      Math.abs(entry.gzipBytes - report.gzip.bytes) > report.gzip.precisionBytes) {
    issues.push("Wrangler gzip Total Upload does not reconcile with the single emitted entry bundle");
  }
  for (const wasm of wasmFiles) {
    if (!wasm.freshSinceBuild) issues.push("A Worker Wasm artifact predates this dry-run");
  }

  const measuredGzipBytes = report.gzip?.bytes ?? null;
  const gzipPrecisionBytes = report.gzip?.precisionBytes ?? null;
  const gzipLowerBoundBytes = measuredGzipBytes === null || gzipPrecisionBytes === null
    ? null
    : measuredGzipBytes - gzipPrecisionBytes;
  const gzipUpperBoundBytes = measuredGzipBytes === null || gzipPrecisionBytes === null
    ? null
    : measuredGzipBytes + gzipPrecisionBytes;
  let gzipBudgetStatus = "NOT_MEASURED";
  if (gzipLowerBoundBytes !== null && gzipUpperBoundBytes !== null) {
    if (gzipLowerBoundBytes > WORKER_GZIP_BUDGET_BYTES) {
      gzipBudgetStatus = "FAIL";
    } else if (gzipUpperBoundBytes <= WORKER_GZIP_BUDGET_BYTES) {
      gzipBudgetStatus = "PASS";
    } else {
      issues.push("Wrangler gzip Total Upload rounding interval straddles the Worker gzip budget");
    }
  }
  const status = issues.length > 0 ? "NOT_MEASURED" : gzipBudgetStatus;
  const artifactFiles = [entry, sourceMapArtifact, ...wasmFiles]
    .filter(Boolean)
    .map(({ path, sha256: digest, rawBytes }) => ({ path, sha256: digest, rawBytes }));
  return {
    status,
    threshold: {
      gzipBytes: WORKER_GZIP_BUDGET_BYTES,
      unit: "bytes",
      display: "4 MiB gzip",
    },
    metric: {
      rawBytes: report.raw?.bytes ?? entry?.rawBytes ?? null,
      rawReported: report.raw?.reported ?? null,
      gzipBytes: measuredGzipBytes,
      gzipReported: report.gzip?.reported ?? null,
      gzipPrecisionBytes,
      gzipRoundingIntervalBytes: gzipLowerBoundBytes === null || gzipUpperBoundBytes === null
        ? null
        : { lowerInclusive: gzipLowerBoundBytes, upperInclusive: gzipUpperBoundBytes },
      gzipMethod: "installed Wrangler native Total Upload aggregate over emitted modules and entry",
      rawReconciliation,
      knownAggregateRawBytes,
      rawDeltaBytes,
      wasmRawBytes,
      wasmGzipBytes: wasmFiles.reduce((sum, item) => sum + item.gzipBytes, 0),
      status,
    },
    externalModuleAccounting: {
      status: rawReconciliation === "ENTRY_MATCHED" ? "NO_EXTERNAL_MODULES_DETECTED" :
        rawReconciliation === "ENTRY_PLUS_WASM_MATCHED" ? "WASM_INCLUDED_IN_NATIVE_AGGREGATE" :
          rawReconciliation,
      nativeRawBytes: report.raw?.bytes ?? null,
      knownEntryAndWasmRawBytes: knownAggregateRawBytes,
      unexplainedRawBytes: knownAggregateRawBytes === null || report.raw?.bytes === undefined
        ? null
        : Math.max(0, rawDeltaBytes),
      rawDeltaBytes,
      wasmFileCount: wasmFiles.length,
      gzipAuthority: "Wrangler native Total Upload; per-file gzip values are diagnostics only",
    },
    wrangler: {
      version: report.version,
      nativeDryRun: report.completedDryRun === true,
      assetReadEntryCount: report.assetReadEntryCount ?? null,
      outputUnits: { raw: report.raw?.reported ?? null, gzip: report.gzip?.reported ?? null },
    },
    entry,
    modules,
    moduleManifestSha256,
    wasm: wasmFiles,
    artifactFiles,
    issues,
  };
}

export async function inspectWorkerBuild(root, buildStartedAt, output) {
  const report = parseWranglerBundleReport(output);
  const evidence = await inspectWorkerBuildWithReport(root, buildStartedAt, report);
  if (report.status === "MEASURED" && report.completedDryRun === true) {
    freshNativeWorkerMeasurements.add(evidence);
  }
  return evidence;
}

export async function compareReceiptArtifacts(root, receipt, expectedArtifacts) {
  const expected = receipt?.artifacts;
  if (!Array.isArray(expected) || expected.length === 0 ||
      !Array.isArray(expectedArtifacts) || expectedArtifacts.length === 0 ||
      [...expected, ...expectedArtifacts].some((item) =>
        !item || typeof item.path !== "string" ||
        typeof item.sha256 !== "string" || !Number.isSafeInteger(item.rawBytes) || item.rawBytes < 0)) {
    return { status: "NOT_MEASURED", issues: ["Receipt has no emitted artifact manifest"] };
  }
  const expectedPaths = new Set(expectedArtifacts.map((item) => item?.path));
  const receiptPaths = new Set(expected.map((item) => item?.path));
  if (expectedPaths.size !== expectedArtifacts.length || receiptPaths.size !== expected.length ||
      expectedPaths.size !== receiptPaths.size ||
      [...receiptPaths].some((path) => !expectedPaths.has(path))) {
    return { status: "NOT_MEASURED", issues: ["Receipt artifact membership does not match the computed emitted manifest"] };
  }
  if (expected.some((item) => !isAllowedEmittedArtifactPath(item.path))) {
    return { status: "NOT_MEASURED", issues: ["Receipt contains an artifact outside the exact emitted build locations"] };
  }

  let safePaths;
  try {
    safePaths = await Promise.all(expected.map((item) => resolveSafeEmittedArtifactPath(root, item.path)));
  } catch {
    return { status: "NOT_MEASURED", issues: ["Receipt artifact path is missing or resolves through a symbolic link"] };
  }

  const changed = [];
  const missing = [];
  for (let index = 0; index < expected.length; index += 1) {
    const item = expected[index];
    const safePath = safePaths[index];
    try {
      const content = await readFile(safePath.absolute);
      if (sha256(content) !== item.sha256 || content.byteLength !== item.rawBytes) changed.push(item.path);
    } catch (error) {
      if (error?.code === "ENOENT") missing.push(item.path);
      else return { status: "NOT_MEASURED", issues: ["Receipt artifact could not be read safely"] };
    }
  }
  if (missing.length > 0) return { status: "NOT_MEASURED", issues: ["Receipt artifact is missing: " + missing[0]] };
  if (changed.length > 0) return { status: "STALE", issues: ["Receipt artifact changed: " + changed[0]] };
  if (!isDeepStrictEqual(expected, expectedArtifacts)) {
    return { status: "NOT_MEASURED", issues: ["Receipt artifact details do not match the computed emitted manifest"] };
  }
  return { status: "PASS", issues: [] };
}

function measuredBuildEnvelopeMatches(receipt, currentIdentity) {
  const { source, build } = receipt;
  if (!source || !build || typeof currentIdentity?.fingerprint !== "string") return false;

  const startedAt = Date.parse(build.startedAt);
  const finishedAt = Date.parse(build.finishedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || startedAt > finishedAt ||
      receipt.createdAt !== build.finishedAt || build.command !== "pnpm cf:dry-run" ||
      build.attempted !== true || build.commandStatus !== 0 ||
      build.environmentProfile !== EXPECTED_ENVIRONMENT_PROFILE ||
      !isDeepStrictEqual(build.commands, EXPECTED_BUILD_COMMANDS) ||
      !isDeepStrictEqual(receipt.thresholds, {
        workerGzipBytes: WORKER_GZIP_BUDGET_BYTES,
        ownerWebInitialJavaScriptGzipBytes: OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES,
        sourceLineAndByteBudgets: SOURCE_BUDGET_DIAGNOSTIC_POLICY,
      })) {
    return false;
  }

  const versions = build.toolVersions;
  if (!versions || ["node", "pnpm", "wrangler", "astro", "vite"].some((key) =>
    typeof versions[key] !== "string" || versions[key].trim().length === 0)) {
    return false;
  }
  const reportedWranglerVersion = versions.wrangler.match(/\d+\.\d+\.\d+/u)?.[0];
  if (!reportedWranglerVersion || reportedWranglerVersion !== receipt.worker?.wrangler?.version) return false;

  const sourceMatches = source.stableDuringBuild === true &&
    source.commit === source.commitAfterBuild && source.commitAfterBuild === currentIdentity.commit &&
    typeof source.dirty === "boolean" && source.dirty === source.dirtyAfterBuild &&
    source.dirtyAfterBuild === currentIdentity.dirty &&
    source.dirtyEntryCount === currentIdentity.dirtyEntryCount &&
    source.dirtyDigest === currentIdentity.dirtyDigest &&
    source.fingerprintBeforeBuild === source.fingerprintAfterBuild &&
    source.fingerprintAfterBuild === currentIdentity.fingerprint &&
    source.lockfileSha256 === currentIdentity.lockfileSha256 &&
    source.buildInputDigestSha256 === source.buildInputDigestSha256After &&
    source.buildInputDigestSha256After === currentIdentity.buildInputDigestSha256 &&
    isDeepStrictEqual(build.inputDigests, currentIdentity.buildInputDigests) &&
    isDeepStrictEqual(build.inputDigestsAfter, currentIdentity.buildInputDigests);
  return sourceMatches;
}

function measuredArtifactManifestIsWellFormed(artifacts) {
  return Array.isArray(artifacts) && artifacts.length > 0 && artifacts.every((artifact) =>
    artifact && typeof artifact === "object" &&
    typeof artifact.path === "string" && artifact.path.length > 0 &&
    typeof artifact.sha256 === "string" && /^[0-9a-f]{64}$/iu.test(artifact.sha256) &&
    Number.isSafeInteger(artifact.rawBytes) && artifact.rawBytes >= 0);
}

function parseRecordedByteQuantity(value) {
  if (typeof value !== "string") return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)\s+(B|KiB|MiB|GiB)$/u.exec(value);
  if (!match) return null;
  const quantity = parseByteQuantity(match[1], match[2]);
  if (!Number.isFinite(quantity.bytes) || quantity.bytes > Number.MAX_SAFE_INTEGER ||
      quantity.precisionBytes <= 0) {
    return null;
  }
  return { reported: value, ...quantity };
}

function workerReportFromReceipt(worker) {
  // Reuse the parsed native quantities directly; no CLI output is synthesized.
  const version = worker?.wrangler?.version;
  const assetReadEntryCount = worker?.wrangler?.assetReadEntryCount;
  const rawReported = worker?.metric?.rawReported;
  const gzipReported = worker?.metric?.gzipReported;
  const raw = parseRecordedByteQuantity(rawReported);
  const gzip = parseRecordedByteQuantity(gzipReported);
  if (worker?.wrangler?.nativeDryRun !== true ||
      typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version) ||
      !(assetReadEntryCount === null || Number.isSafeInteger(assetReadEntryCount) && assetReadEntryCount >= 0) ||
      !raw || !gzip) {
    return null;
  }
  return {
    status: "MEASURED",
    version,
    completedDryRun: true,
    assetReadEntryCount,
    raw,
    gzip,
  };
}

function notMeasured(issue) {
  return { status: "NOT_MEASURED", issues: [issue] };
}

export async function validateReceipt(root, receipt, currentIdentity) {
  if (!receipt) return { status: "NOT_MEASURED", issues: ["No emitted budget receipt exists"] };
  if (receipt.protocol !== RECEIPT_PROTOCOL) {
    return { status: "NOT_MEASURED", issues: ["Receipt protocol is missing or unsupported"] };
  }
  if (!receipt.source || receipt.source.fingerprintAfterBuild !== currentIdentity.fingerprint) {
    return { status: "STALE", issues: ["Source or lockfile identity changed after the receipt was produced"] };
  }
  if (receipt.status === "STALE") return { status: "STALE", issues: ["Receipt already records a stale build"] };
  if (receipt.status === "NOT_MEASURED") return { status: "NOT_MEASURED", issues: ["Receipt did not measure all required artifacts"] };

  if (receipt.status !== "PASS" && receipt.status !== "FAIL") {
    return notMeasured("Receipt has an unsupported measurement status");
  }
  if (!measuredBuildEnvelopeMatches(receipt, currentIdentity)) {
    return notMeasured("Receipt source, build, tool, or threshold evidence is incomplete or inconsistent");
  }
  if (!measuredArtifactManifestIsWellFormed(receipt.artifacts)) {
    return notMeasured("Receipt emitted artifact manifest is incomplete or malformed");
  }

  try {
    const workerReport = workerReportFromReceipt(receipt.worker);
    if (!workerReport) return notMeasured("Receipt omits the native Wrangler size report");
    const [worker, pwa] = await Promise.all([
      inspectWorkerBuildWithReport(root, receipt.build.startedAt, workerReport),
      inspectPwaBuild(root, receipt.build.startedAt),
    ]);
    const expectedArtifacts = [...worker.artifactFiles, ...pwa.artifactFiles];
    if (receipt.artifacts.length !== expectedArtifacts.length ||
        !isDeepStrictEqual(receipt.artifacts.map((item) => item.path), expectedArtifacts.map((item) => item.path))) {
      return notMeasured("Receipt artifact manifest does not contain the complete Worker and owner-web artifact set");
    }
    const artifacts = await compareReceiptArtifacts(root, receipt, expectedArtifacts);
    if (artifacts.status !== "PASS") return artifacts;

    if (!isDeepStrictEqual(worker, receipt.worker) || !isDeepStrictEqual(pwa, receipt.pwa)) {
      return notMeasured("Receipt Worker or owner-web evidence does not match the emitted artifacts");
    }

    if (worker.wasm.length > 0 && !freshNativeWorkerMeasurements.has(receipt.worker)) {
      return notMeasured("Persisted Worker multipart gzip cannot be reconstructed from emitted artifacts and module order");
    }

    const expectedIssues = [...worker.issues, ...pwa.issues];
    if (!isDeepStrictEqual(receipt.issues, expectedIssues) || expectedIssues.length !== 0) {
      return notMeasured("A PASS/FAIL receipt contains incomplete or inconsistent measurement issues");
    }
    if (!["PASS", "FAIL"].includes(worker.status) || !["PASS", "FAIL"].includes(pwa.status)) {
      return notMeasured("Receipt does not contain complete measured Worker and owner-web contours");
    }

    const expectedStatus = worker.status === "FAIL" || pwa.status === "FAIL" ? "FAIL" : "PASS";
    if (receipt.status !== expectedStatus) {
      return notMeasured("Receipt status does not match the measured Worker and owner-web threshold outcomes");
    }
  } catch {
    return notMeasured("Receipt Worker or owner-web evidence could not be verified");
  }

  return { status: receipt.status, issues: [] };
}
