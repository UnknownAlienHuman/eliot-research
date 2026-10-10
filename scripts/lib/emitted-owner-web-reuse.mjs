import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gzipSync } from "node:zlib";
import {
  aggregateClosure,
  compareReceiptArtifacts,
  inspectWebBuild,
  isJavaScriptPath,
  OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES,
  RECEIPT_PROTOCOL,
  resolveSafeEmittedArtifactPath,
  RETAINED_OWNER_WEB_REUSE_ARTIFACT_ROOT,
  runGit,
  sha256,
  SOURCE_BUDGET_DIAGNOSTIC_POLICY,
  WORKER_GZIP_BUDGET_BYTES,
} from "./emitted-build-budget-evidence.mjs";

export const RETAINED_OWNER_WEB_REUSE_PATHS = Object.freeze({
  staticBuild: ".eliotr-state/frontend-finite-composition-20261010/static-build.json",
  equivalence: ".eliotr-state/frontend-finite-composition-20261010/accepted-input-equivalence.json",
  distRoot: RETAINED_OWNER_WEB_REUSE_ARTIFACT_ROOT,
  receipt: ".eliotr-state/backend-full-20261008/owner-web-emitted-reuse282-20261010/owner-web-subreceipt.json",
});
const RETAINED_OWNER_WEB_EXPECTED_DIGESTS = Object.freeze({
  staticBuild: "08ab74c19f519911e38d48050da2e97c109da854897cf83e3ea8363cdd2ecfcf",
  equivalence: "ce427da362582a89378d1558e414445c788919b15e5339f52b3f204fa708fcee",
  manifest: "987c1633516dac6b7bd61ab54b31d4f211ae0ca882138d1966da4cee42a38c20",
});

function projectRetainedOwnerWebAnalysis({ report, graph, bytesByPath, files, routeScripts, issues }) {
  const routeForHtml = (htmlPath) => {
    const segments = htmlPath.replace(/(^|\/)index\.html$/u, "$1").replace(/\/+$/u, "");
    const route = segments ? "/" + segments + "/" : "/";
    return {
      route,
      category: route === "/agent-inbox/" || route.startsWith("/agent-inbox/")
        ? "agent-inbox" : "owner-web",
    };
  };
  const scriptsByHtml = new Map(routeScripts.map((script) => [script.htmlPath, script]));
  const initialUsage = new Map();
  const routeSummaries = report.routes.map((summary) => {
    const script = scriptsByHtml.get(summary.htmlPath);
    const { route, category } = routeForHtml(summary.htmlPath);
    const initial = aggregateClosure(script?.entryPaths ?? [], graph, false);
    if (category !== "agent-inbox") {
      for (const path of initial) initialUsage.set(path, (initialUsage.get(path) ?? 0) + 1);
    }

    const pendingDynamic = [...initial];
    const processedDynamic = new Set();
    const dynamicPaths = new Set();
    while (pendingDynamic.length > 0) {
      const current = pendingDynamic.pop();
      if (processedDynamic.has(current)) continue;
      processedDynamic.add(current);
      const edges = graph.get(current);
      if (!edges) continue;
      for (const target of edges.dynamicImports) {
        for (const path of aggregateClosure([target], graph, true)) {
          if (!initial.has(path)) dynamicPaths.add(path);
          pendingDynamic.push(path);
        }
      }
    }
    const lazyResources = [...dynamicPaths]
      .filter((path) => bytesByPath.has(path))
      .map((path) => ({
        path,
        rawBytes: bytesByPath.get(path).byteLength,
        gzipBytes: gzipSync(bytesByPath.get(path), { level: 9 }).byteLength,
      }));
    return {
      ...summary,
      route,
      category,
      initialJavaScript: {
        ...summary.initialJavaScript,
        status: issues.length === 0 ? "MEASURED" : "NOT_MEASURED",
        unit: "bytes",
      },
      lazyJavaScript: {
        status: issues.length === 0 ? "MEASURED" : "NOT_MEASURED",
        unit: "bytes",
        rawBytes: lazyResources.reduce((sum, item) => sum + item.rawBytes, 0),
        gzipBytes: lazyResources.reduce((sum, item) => sum + item.gzipBytes, 0),
        resources: lazyResources,
      },
    };
  });
  report.routes = routeSummaries;
  const rootRoute = routeSummaries.find((route) => route.category === "owner-web" && route.route === "/") ?? null;
  const inboxRoute = routeSummaries.find((route) => route.category === "agent-inbox") ?? null;
  const sharedPaths = [...initialUsage].filter(([, count]) => count > 1).map(([path]) => path);
  const sharedResources = sharedPaths.filter((path) => bytesByPath.has(path)).map((path) => ({
    path,
    rawBytes: bytesByPath.get(path).byteLength,
    gzipBytes: gzipSync(bytesByPath.get(path), { level: 9 }).byteLength,
  }));
  const allJavaScriptResources = files.filter((file) => isJavaScriptPath(file.relative)).map((file) => {
    const content = bytesByPath.get(file.relative);
    return {
      path: file.relative,
      rawBytes: content.byteLength,
      gzipBytes: gzipSync(content, { level: 9 }).byteLength,
    };
  });
  report.metric.unit = "bytes";
  Object.assign(report, {
    initialOwnerWebJavaScript: {
      status: !rootRoute || issues.length > 0 ? "NOT_MEASURED" :
        rootRoute.initialJavaScript.gzipBytes > OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES ? "FAIL" : "PASS",
      route: rootRoute?.route ?? null,
      rawBytes: rootRoute?.initialJavaScript.rawBytes ?? null,
      gzipBytes: rootRoute?.initialJavaScript.gzipBytes ?? null,
      unit: "bytes",
      method: "gzip level 9 per distinct resource in the root entry static-import closure",
      resources: rootRoute?.initialJavaScript.resources ?? [],
    },
    sharedInitialJavaScript: {
      status: issues.length === 0 ? "MEASURED" : "NOT_MEASURED",
      unit: "bytes",
      rawBytes: sharedResources.reduce((sum, item) => sum + item.rawBytes, 0),
      gzipBytes: sharedResources.reduce((sum, item) => sum + item.gzipBytes, 0),
      resources: sharedResources,
    },
    agentInbox: inboxRoute,
    agentInboxJavaScript: inboxRoute?.initialJavaScript ?? {
      status: "NOT_MEASURED",
      unit: "bytes",
      rawBytes: null,
      gzipBytes: null,
      resources: [],
      issue: "No independent agent-inbox HTML entry exists in this owner-web artifact set",
    },
    lazyJavaScript: rootRoute?.lazyJavaScript ?? {
      status: "NOT_MEASURED",
      unit: "bytes",
      rawBytes: null,
      gzipBytes: null,
      resources: [],
    },
    allDistJavaScript: {
      status: "MEASURED",
      unit: "bytes",
      rawBytes: allJavaScriptResources.reduce((sum, item) => sum + item.rawBytes, 0),
      gzipBytes: allJavaScriptResources.reduce((sum, item) => sum + item.gzipBytes, 0),
      resources: allJavaScriptResources,
    },
    allAssets: files.map((file) => {
      const content = bytesByPath.get(file.relative);
      const isJavaScript = isJavaScriptPath(file.relative);
      const isCss = extname(file.relative).toLowerCase() === ".css";
      return {
        path: file.relative,
        status: "MEASURED",
        kind: isJavaScript ? "javascript" : isCss ? "css" : "asset",
        unit: "bytes",
        sha256: sha256(content),
        rawBytes: content.byteLength,
        gzipBytes: isJavaScript || isCss ? gzipSync(content, { level: 9 }).byteLength : null,
      };
    }),
    moduleGraph: [...graph].map(([path, edges]) => ({
      path,
      staticImports: edges.staticImports,
      dynamicImports: edges.dynamicImports,
      workerImports: edges.workerImports,
      unresolved: edges.unresolved,
    })),
  });
  // Preserve the inspector's referencedJavaScript static-import-only contract.
  return report;
}

async function readSafeRepositoryFile(root, repositoryPath) {
  if (typeof repositoryPath !== "string" || repositoryPath.includes("\\") ||
      repositoryPath.startsWith("/") || repositoryPath.split("/").some((segment) =>
        segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("Evidence path is not a normalized repository-relative path");
  }
  const repositoryRoot = await realpath(root);
  let absolute = repositoryRoot;
  const segments = repositoryPath.split("/");
  let details = null;
  for (let index = 0; index < segments.length; index += 1) {
    absolute = resolve(absolute, segments[index]);
    details = await lstat(absolute);
    if (details.isSymbolicLink()) throw new Error("Evidence files cannot resolve through symbolic links");
    if (index < segments.length - 1 && !details.isDirectory()) {
      throw new Error("Evidence path crosses a non-directory entry");
    }
  }
  if (!details?.isFile()) throw new Error("Evidence path is not a regular file");
  const actual = await realpath(absolute);
  const repositoryRelative = relative(repositoryRoot, actual);
  if (repositoryRelative === ".." || repositoryRelative.startsWith(".." + sep)) {
    throw new Error("Evidence file resolves outside the repository");
  }
  return readFile(absolute);
}

function readGitTreeBlobMap(root, commit, paths) {
  const output = runGit(root, ["ls-tree", "-r", "--full-tree", commit, "--", ...paths]).toString("utf8");
  const blobs = new Map();
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    const match = /^(\d{6}) blob ([0-9a-f]{40})\t(.+)$/u.exec(line);
    if (!match) throw new Error("Selected source tree contains an unsupported Git entry");
    blobs.set(match[3], match[2]);
  }
  return blobs;
}

function validInputRecords(records) {
  if (!Array.isArray(records) || records.length === 0) return false;
  const paths = new Set();
  return records.every((record) => {
    if (!record || typeof record.path !== "string" || record.path.includes("\\") ||
        record.path.startsWith("/") || record.path.split("/").some((part) =>
          part.length === 0 || part === "." || part === "..") ||
        !/^[0-9a-f]{40}$/u.test(record.git_blob ?? "") || paths.has(record.path)) return false;
    paths.add(record.path);
    return true;
  });
}

export async function inspectRetainedOwnerWebReuse(root, sourceTreeCommit, options = {}) {
  const issues = [];
  const gitRoot = options.gitRoot ?? root;
  if (!/^[0-9a-f]{40}$/u.test(sourceTreeCommit ?? "")) {
    throw new Error("Retained owner-web reuse requires an exact 40-character source tree commit");
  }

  const paths = RETAINED_OWNER_WEB_REUSE_PATHS;
  const staticBuildBytes = await readSafeRepositoryFile(root, paths.staticBuild);
  const equivalenceBytes = await readSafeRepositoryFile(root, paths.equivalence);
  const staticBuild = JSON.parse(staticBuildBytes.toString("utf8"));
  const equivalence = JSON.parse(equivalenceBytes.toString("utf8"));
  const selectedTreeCommit = runGit(gitRoot, ["rev-parse", "--verify", `${sourceTreeCommit}^{commit}`])
    .toString("utf8").trim();

  if (sha256(staticBuildBytes) !== RETAINED_OWNER_WEB_EXPECTED_DIGESTS.staticBuild ||
      sha256(equivalenceBytes) !== RETAINED_OWNER_WEB_EXPECTED_DIGESTS.equivalence) {
    issues.push("Retained static-build or accepted-equivalence evidence digest changed");
  }
  const staticBuildIdentityValid = staticBuild.protocol === "eliotr.frontend-static-review-artifact.v1" &&
      staticBuild.status === "PASS" && staticBuild.source_inputs_stable === true &&
      /^[0-9a-f]{40}$/u.test(staticBuild.source_commit ?? "") &&
      staticBuild.source_commit === "afe4fc800ae37d24fc8e279fe4798e7754959673" &&
      staticBuild.published_base === "4e9762860800389190a77ac604b51beddd03de8d" &&
      validInputRecords(staticBuild.source_inputs) && staticBuild.source_inputs.length === 168;
  if (!staticBuildIdentityValid) {
    issues.push("Retained static build identity or its 168 source-input records are incomplete");
  }
  const equivalenceIdentityValid = equivalence.status === "PASS_FINITE_EXECUTED_INPUT_EQUIVALENCE" &&
      equivalence.static_build_source === staticBuild.source_commit &&
      equivalence.static_inputs_identical === 168 &&
      equivalence.final_source === "ddcd9096df46c360ae1244f959d7403ecd89a90d" &&
      equivalence.static_artifacts_reused_without_rebuild === true &&
      Array.isArray(equivalence.public_copy_inputs) && equivalence.public_copy_inputs.length === 2 &&
      validInputRecords(equivalence.public_copy_inputs);
  if (!equivalenceIdentityValid) {
    issues.push("Accepted-input-equivalence evidence does not bind the retained static build");
  }

  const productionInputs = Array.isArray(staticBuild.source_inputs) ? staticBuild.source_inputs : [];
  const publicCopyInputs = Array.isArray(equivalence.public_copy_inputs) ? equivalence.public_copy_inputs : [];
  const allInputs = [...productionInputs, ...publicCopyInputs];
  const pathsToCheck = [...new Set([...allInputs.map((item) => item.path), "pnpm-lock.yaml"] )];
  let buildTreeBlobs = new Map();
  let currentTreeBlobs = new Map();
  try {
    buildTreeBlobs = readGitTreeBlobMap(gitRoot, staticBuild.source_commit, pathsToCheck);
    currentTreeBlobs = readGitTreeBlobMap(gitRoot, selectedTreeCommit, pathsToCheck);
  } catch (error) {
    issues.push("Selected source tree could not be read safely: " + (error?.message ?? "unknown Git tree error"));
  }

  const buildMismatches = allInputs.filter((item) => buildTreeBlobs.get(item.path) !== item.git_blob);
  for (const item of buildMismatches) {
    issues.push(`Build input does not match its recorded source commit: ${item.path}`);
  }
  const sourceMismatches = allInputs.filter((item) => currentTreeBlobs.get(item.path) !== item.git_blob);
  const productionInputsMatched = productionInputs.filter((item) =>
    buildTreeBlobs.get(item.path) === item.git_blob && currentTreeBlobs.get(item.path) === item.git_blob).length;
  const publicCopyInputsMatched = publicCopyInputs.filter((item) =>
    buildTreeBlobs.get(item.path) === item.git_blob && currentTreeBlobs.get(item.path) === item.git_blob).length;
  const buildLockBlob = buildTreeBlobs.get("pnpm-lock.yaml") ?? null;
  const currentLockBlob = currentTreeBlobs.get("pnpm-lock.yaml") ?? null;
  const lockfileMatches = buildLockBlob !== null && currentLockBlob !== null && buildLockBlob === currentLockBlob;
  if (buildLockBlob === null || currentLockBlob === null) {
    issues.push("Source equivalence could not verify the pnpm-lock.yaml blob");
  }
  if (buildLockBlob !== currentLockBlob) sourceMismatches.push({
    path: "pnpm-lock.yaml", git_blob: buildLockBlob, current_git_blob: currentLockBlob,
  });
  if (sourceMismatches.length > 0) {
    const details = sourceMismatches.map((item) =>
      `${item.path} (build ${item.git_blob ?? "missing"}; tree ${item.current_git_blob ?? currentTreeBlobs.get(item.path) ?? "missing"})`);
    issues.push(`Freshness: STALE against source tree ${selectedTreeCommit}; ${details.join(", ")}`);
  }

  let ownerWeb = await inspectWebBuild(root, staticBuild.started, {
    artifactRoot: paths.distRoot,
    includeHidden: true,
    checkMtimeFreshness: false,
    analysisProjection: projectRetainedOwnerWebAnalysis,
  });
  const recordedArtifacts = Array.isArray(staticBuild.artifacts) ? staticBuild.artifacts : [];
  const expectedArtifacts = recordedArtifacts.map((item) => ({
    path: `${paths.distRoot}/${item.path}`,
    sha256: item.sha256,
    rawBytes: item.bytes,
  }));
  const actualByPath = new Map(ownerWeb.allAssets.map((item) => [item.path, item]));
  const expectedPaths = new Set(recordedArtifacts.map((item) => item.path));
  const artifactMembershipMatches = expectedPaths.size === recordedArtifacts.length &&
    actualByPath.size === ownerWeb.allAssets.length && expectedPaths.size === actualByPath.size &&
    [...expectedPaths].every((path) => actualByPath.has(path));
  if (!artifactMembershipMatches) {
    issues.push("Retained artifact membership differs from the recorded nine-file Vite output");
  }
  const inspectedArtifacts = recordedArtifacts.flatMap((item) => {
    const actual = actualByPath.get(item.path);
    return actual ? [{ path: `${paths.distRoot}/${item.path}`, sha256: actual.sha256, rawBytes: actual.rawBytes }] : [];
  });
  const artifactCheck = await compareReceiptArtifacts(
    root,
    { artifacts: expectedArtifacts },
    inspectedArtifacts,
  );
  if (artifactCheck.status === "STALE") {
    issues.push("Freshness: STALE retained artifact digest changed: " + artifactCheck.issues[0]);
  } else if (artifactCheck.status !== "PASS") {
    issues.push("Retained artifacts are NOT_MEASURED: " + artifactCheck.issues[0]);
  }

  for (const expected of recordedArtifacts) {
    const actual = actualByPath.get(expected.path);
    if (actual && expected.gzip_bytes !== undefined && actual.gzipBytes !== expected.gzip_bytes) {
      issues.push(`Freshness: STALE retained artifact gzip byte count changed: ${expected.path}`);
    }
  }

  let manifestSummary = null;
  const manifestPath = ".vite/manifest.json";
  const manifestAsset = actualByPath.get(manifestPath);
  if (!manifestAsset) {
    issues.push("Retained Vite manifest is missing");
  } else {
    try {
      const safeManifest = await resolveSafeEmittedArtifactPath(root, `${paths.distRoot}/${manifestPath}`);
      const manifest = JSON.parse(await readFile(safeManifest.absolute, "utf8"));
      const entries = Object.entries(manifest);
      const manifestJavaScript = entries
        .map(([, record]) => record?.file)
        .filter((file) => typeof file === "string" && isJavaScriptPath(file));
      const actualJavaScript = ownerWeb.allAssets
        .filter((asset) => asset.kind === "javascript")
        .map((asset) => asset.path);
      const uniqueManifestJavaScript = [...new Set(manifestJavaScript)].sort();
      const uniqueActualJavaScript = [...new Set(actualJavaScript)].sort();
      if (!isDeepStrictEqual(uniqueManifestJavaScript, uniqueActualJavaScript)) {
        issues.push("Vite manifest JavaScript membership differs from the retained emitted files");
      }
      const htmlEntry = manifest["index.html"];
      const rootRoute = ownerWeb.routes.find((route) => route.route === "/");
      if (htmlEntry?.isEntry !== true || typeof htmlEntry.file !== "string" ||
          !rootRoute?.initialJavaScript.resources.some((resource) => resource.path === htmlEntry.file)) {
        issues.push("Vite manifest root entry does not match the emitted HTML eager graph");
      }
      const dynamicEntries = entries.filter(([, record]) => record?.isDynamicEntry === true);
      const lazyPaths = new Set(ownerWeb.lazyJavaScript.resources.map((resource) => resource.path));
      for (const [key, record] of dynamicEntries) {
        if (!record.file || !lazyPaths.has(record.file)) {
          issues.push("Vite dynamic entry is not present in the measured lazy closure: " + key);
        }
      }
      for (const [key, record] of entries) {
        for (const target of record?.dynamicImports ?? []) {
          if (!manifest[target]?.file || !actualByPath.has(manifest[target].file)) {
            issues.push("Vite manifest dynamic import target is missing: " + key);
          }
        }
      }
      manifestSummary = {
        path: manifestPath,
        sha256: manifestAsset.sha256,
        rawBytes: manifestAsset.rawBytes,
        unit: "bytes",
        entryCount: entries.length,
        javascriptFiles: uniqueManifestJavaScript,
        dynamicEntries: dynamicEntries.map(([key, record]) => ({ key, file: record.file })),
      };
      if (manifestAsset.sha256 !== RETAINED_OWNER_WEB_EXPECTED_DIGESTS.manifest) {
        issues.push("Freshness: STALE retained Vite manifest digest changed");
      }
    } catch (error) {
      issues.push("Retained Vite manifest could not be verified: " + (error?.message ?? "invalid manifest"));
    }
  }

  const sourcePackage = JSON.parse(runGit(gitRoot, ["show", `${staticBuild.source_commit}:apps/eliotr-web/package.json`]).toString("utf8"));
  const lockfileBytes = runGit(gitRoot, ["show", `${staticBuild.source_commit}:pnpm-lock.yaml`]);
  const lockfileText = lockfileBytes.toString("utf8");
  const webImporter = /(?:^|\r?\n)  apps\/eliotr-web:\r?\n([\s\S]*?)(?=\r?\n  [^\s\r\n][^\r\n]*:\r?$|$)/u.exec(lockfileText)?.[1] ?? "";
  const viteLockMatch = /^ {8}vite:\r?\n^ {10}specifier: ([^\r\n]+)\r?\n^ {10}version: (\d+\.\d+\.\d+)/mu.exec(webImporter);
  const declaredViteVersion = sourcePackage.devDependencies?.vite;
  const viteVersion = viteLockMatch?.[2] ?? "NOT_RECORDED";
  const viteResolutionValid = viteLockMatch?.[1] === declaredViteVersion && viteVersion === declaredViteVersion;
  if (!viteResolutionValid) issues.push("Vite version could not be bound to the owner-web lockfile importer");

  const sourceTreeMatchesListedInputs = staticBuildIdentityValid && equivalenceIdentityValid && lockfileMatches &&
    sourceMismatches.length === 0 && buildMismatches.length === 0;
  const listedInputsFresh = sourceTreeMatchesListedInputs && viteResolutionValid && staticBuild.source_inputs_stable === true;
  const artifactFresh = artifactCheck.status === "PASS" &&
    !issues.some((issue) => issue.startsWith("Freshness: STALE retained artifact"));

  const inspectedOwnerWebStatus = ownerWeb.status;
  const unresolvedLoadEdges = ownerWeb.moduleGraph.flatMap((module) =>
    (module.unresolved ?? []).map((edge) => ({ path: module.path, edge })),
  );
  const wholeBuildInputStabilityProven = staticBuild.whole_build_inputs_stable === true;
  const ownerWebCanBeMeasured = listedInputsFresh && artifactFresh && issues.length === 0 &&
    inspectedOwnerWebStatus !== "NOT_MEASURED" && ownerWeb.issues.length === 0 &&
    unresolvedLoadEdges.length === 0 && wholeBuildInputStabilityProven;
  if (!ownerWebCanBeMeasured) {
    ownerWeb.status = "NOT_MEASURED";
    ownerWeb.issues = [...new Set([
      ...ownerWeb.issues,
      ...issues,
      ...(!wholeBuildInputStabilityProven
        ? ["Whole-build input stability is unproven by listed-input equivalence"]
        : []),
    ])];
  } else {
    ownerWeb.status = ownerWeb.metric.gzipBytes > OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES ? "FAIL" : "PASS";
  }

  const workerIssues = ["No current-source Worker build or native Wrangler measurement was supplied"];
  const allIssues = [...new Set([...issues, ...ownerWeb.issues, ...workerIssues])];
  const receipt = {
    protocol: RECEIPT_PROTOCOL,
    graph: "owner-web",
    purpose: "retained-vite-reuse",
    createdAt: new Date().toISOString(),
    status: "NOT_MEASURED",
    source: {
      commit: staticBuild.source_commit,
      commitAfterBuild: null,
      fingerprintBeforeBuild: null,
      fingerprintAfterBuild: null,
      stableDuringBuild: null,
      listedInputEquivalence: sourceTreeMatchesListedInputs
        ? "LISTED_INPUT_EQUIVALENCE"
        : "NOT_EQUIVALENT",
      wholeBuildInputStability: "UNPROVEN",
      captureReportedListedInputsStable: staticBuild.source_inputs_stable === true,
      unprovenBuildReads: ["Tailwind scanner/theme inputs", "external reads"],
      lockfileSha256: sha256(lockfileBytes),
      selectedSourceTree: selectedTreeCommit,
      selectedSourceTreeMatchesListedInputs: sourceTreeMatchesListedInputs,
      productionInputCount: productionInputs.length,
      productionInputsMatched,
      publicCopyInputsMatched,
      sourceInputMismatches: sourceMismatches.map((item) => ({
        path: item.path,
        buildGitBlob: item.git_blob ?? null,
        currentGitBlob: item.current_git_blob ?? currentTreeBlobs.get(item.path) ?? null,
      })),
      staticBuildSha256: sha256(staticBuildBytes),
      inputEquivalenceSha256: sha256(equivalenceBytes),
    },
    build: {
      command: "retained Vite artifact reuse; no build executed",
      attempted: false,
      commandStatus: null,
      startedAt: staticBuild.started,
      finishedAt: staticBuild.finished,
      environmentProfile: "standalone owner-web Vite review output; no Worker plugin, native bundle, route-parity, or deploy measurement",
      commands: { config: staticBuild.config, flags: "not recorded by retained static-build evidence" },
      toolVersions: {
        node: "not recorded by retained static-build evidence",
        pnpm: "not recorded by retained static-build evidence",
        vite: viteResolutionValid
          ? `${viteVersion} (apps/eliotr-web lockfile resolution; executed binary version not recorded)`
          : "NOT_RECORDED",
      },
      inputDigests: null,
      inputDigestsAfter: null,
      nativeSizeOutput: null,
    },
    thresholds: {
      workerGzipBytes: WORKER_GZIP_BUDGET_BYTES,
      ownerWebInitialJavaScriptGzipBytes: OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES,
      sourceLineAndByteBudgets: SOURCE_BUDGET_DIAGNOSTIC_POLICY,
    },
    worker: { status: "NOT_MEASURED", issues: workerIssues },
    ownerWeb: {
      ...ownerWeb,
      inspectionStatus: inspectedOwnerWebStatus,
      closureEvidence: {
        fullGraphStatus: "NOT_MEASURED",
        reason: "The retained capture does not prove whole-build input stability; manifest membership is not graph-closure evidence",
        referencedJavaScriptSemantics: "HTML entry roots plus recursive static imports only; dynamic imports are excluded",
        inspectedInitialStaticClosureStatus: ownerWeb.initialOwnerWebJavaScript?.status ?? "NOT_MEASURED",
        inspectedLazyDynamicClosureStatus: ownerWeb.lazyJavaScript?.status ?? "NOT_MEASURED",
        unresolvedLoadEdges,
        manifestUsedAsClosureAuthority: false,
      },
      sourceEquivalence: {
        listedInputEquivalence: sourceTreeMatchesListedInputs
          ? "LISTED_INPUT_EQUIVALENCE"
          : "NOT_EQUIVALENT",
        wholeBuildInputStability: "UNPROVEN",
        selectedTreeCommit,
        productionInputs: productionInputs.length,
        productionInputsMatched,
        publicCopyInputs: publicCopyInputs.length,
        publicCopyInputsMatched,
        lockfileMatches,
      },
      retainedArtifactDigests: !artifactMembershipMatches || artifactCheck.status === "STALE" ? "MISMATCH" :
        artifactCheck.status === "PASS" ? "MATCH" : "UNAVAILABLE",
      viteManifest: manifestSummary,
      sourceProfile: "Standalone Vite owner-web client graph only",
      routeParityMeasured: false,
      workerMeasured: false,
    },
    artifacts: ownerWeb.artifactFiles,
    issues: allIssues,
  };
  return receipt;
}
