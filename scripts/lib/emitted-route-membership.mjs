import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

// Evidence is explicitly admitted from pinned bytes. JSON reports cannot
// reconstruct this process-local capability. This is a bounded network
// observation, never authority for module evaluation or complete release scope.
const observations = new WeakMap();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isJs = (path) => /\.(?:m?js|cjs)$/iu.test(path);
const isPath = (path) => typeof path === "string" && path.length > 0 &&
  !path.startsWith("/") && !path.includes("\\") && !path.includes("//") &&
  !path.split("/").some((segment) => ["", ".", ".."].includes(segment));

export function admitStartupObservation(bytes, binding) {
  if (!binding || !/^[a-f0-9]{40}$/u.test(binding.sourceCommit) ||
      ![binding.observationSha256, binding.buildSha256, binding.artifactReadbackSha256]
        .every((value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))) {
    throw new Error("Exact source/build/observation/artifact digests are required");
  }
  if (!Buffer.isBuffer(bytes) || digest(bytes) !== binding.observationSha256) {
    throw new Error("Startup observation bytes do not match the admitted digest");
  }
  const observation = JSON.parse(bytes.toString("utf8"));
  for (const [key, expected] of [
    ["source_commit", binding.sourceCommit], ["build_sha256", binding.buildSha256],
    ["artifact_readback_sha256", binding.artifactReadbackSha256],
    ["route", binding.route], ["profile", binding.profile], ["boundary", binding.boundary],
  ]) {
    if (typeof expected !== "string" || expected.length === 0 || observation[key] !== expected) {
      throw new Error("Startup observation binding mismatch: " + key);
    }
  }
  if (!isPath(binding.htmlPath) || !Array.isArray(binding.artifacts) || binding.artifacts.length === 0) {
    throw new Error("The exact HTML and full emitted artifact manifest are required");
  }
  const artifacts = new Map();
  for (const artifact of binding.artifacts) {
    if (!isPath(artifact.path) || artifacts.has(artifact.path) ||
        !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.rawBytes) || artifact.rawBytes < 0) {
      throw new Error("Invalid or duplicate startup artifact binding");
    }
    artifacts.set(artifact.path, { ...artifact });
  }
  if (!artifacts.has(binding.htmlPath)) throw new Error("Bound startup HTML is absent from the manifest");
  const token = Object.freeze({});
  observations.set(token, { observation, artifacts, htmlPath: binding.htmlPath,
    observationSha256: binding.observationSha256 });
  return token;
}

export function aggregateClosure(roots, graph, dynamic) {
  const result = new Set(), pending = [...roots];
  while (pending.length) {
    const path = pending.pop();
    if (result.has(path)) continue;
    result.add(path);
    const edges = graph.get(path);
    if (!edges) continue;
    pending.push(...edges.staticImports);
    if (dynamic) pending.push(...edges.dynamicImports);
  }
  return result;
}

export function describeHtmlEntry(htmlPath) {
  const segments = htmlPath.replace(/(^|\/)index\.html$/u, "$1").replace(/\/+$/u, "");
  const route = segments ? "/" + segments + "/" : "/";
  return { route, category: route.startsWith("/agent-inbox/") ? "agent-inbox" : "owner-web" };
}

function resources(paths, bytesByPath) {
  return [...paths].filter((path) => bytesByPath.has(path)).map((path) => {
    const bytes = bytesByPath.get(path);
    return { path, rawBytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length };
  });
}

export function reconcileRouteLoadMembership({ htmlPath, entryPaths, inlinePaths = [],
  preloadPaths = [], graph, bytesByPath, startupObservation }) {
  const staticPaths = aggregateClosure([...entryPaths, ...inlinePaths], graph, false);
  const reachablePaths = aggregateClosure([...entryPaths, ...inlinePaths], graph, true);
  const workerPaths = new Set();
  for (const path of reachablePaths) {
    for (const worker of graph.get(path)?.workerImports ?? []) workerPaths.add(worker);
  }
  const result = { status: "NOT_MEASURED", issues: [], initialPaths: new Set(),
    staticImportPaths: staticPaths, reachablePaths, workerPaths,
    staticImportJavaScript: resources(staticPaths, bytesByPath),
    preloadJavaScript: resources(new Set(preloadPaths), bytesByPath),
    initialJavaScript: { status: "NOT_MEASURED", rawBytes: null, gzipBytes: null, resources: [] },
    // Inventory candidates cannot prove that a chunk is lazy at startup.
    lazyJavaScript: { status: "NOT_MEASURED", rawBytes: null, gzipBytes: null, resources: [] },
    unobservedDynamicJavaScript: [], measurement: null };
  const admitted = startupObservation && observations.get(startupObservation);
  try {
    if (!admitted) throw new Error("No pinned startup network observation was admitted");
    if (admitted.htmlPath !== htmlPath) throw new Error("Startup observation belongs to another HTML entry");
    if (inlinePaths.length) throw new Error("Executable inline JavaScript is outside this network-byte metric");
    const { observation: o, artifacts } = admitted;
    const actualFiles = [...bytesByPath.keys()].filter((path) => !path.startsWith("inline:"));
    if (actualFiles.length !== artifacts.size || actualFiles.some((path) => {
      const expected = artifacts.get(path), bytes = bytesByPath.get(path);
      return !expected || bytes.length !== expected.rawBytes || digest(bytes) !== expected.sha256;
    })) throw new Error("Startup observation does not match the full current artifact set");
    const start = Date.parse(o.started_at), finish = Date.parse(o.finished_at), boundary = o.boundary_epoch_ms;
    if (o.protocol !== "eliotr.actual-owner-startup-observation.v1" ||
        o.status !== "BOUNDED_ACTUAL_RESEARCH_STARTUP_OBSERVED" ||
        !Number.isFinite(start) || !Number.isFinite(finish) ||
        !Number.isSafeInteger(boundary) || boundary < start || boundary > finish ||
        !Array.isArray(o.requests_at_boundary) || !Array.isArray(o.requests) ||
        !Array.isArray(o.observer_errors) || o.observer_errors.length ||
        o.browser_errors?.page_error_count !== 0 || o.browser_errors?.console_error_count !== 0 ||
        o.context?.fresh !== true || o.context?.storage_state_loaded !== false ||
        o.context?.http_cache !== "DISABLED_BY_ROUTE_INTERCEPTION" ||
        o.page_state?.service_worker_controller !== null ||
        !Array.isArray(o.service_workers_at_boundary) || o.service_workers_at_boundary.length) {
      throw new Error("Startup request window or clean-context evidence is incomplete");
    }
    const finalIds = new Set();
    for (const row of o.requests) {
      if (!Number.isSafeInteger(row.id) || finalIds.has(row.id) ||
          !Number.isFinite(row.started_epoch_ms) || row.started_epoch_ms < start || row.started_epoch_ms > finish) {
        throw new Error("Invalid final request inventory");
      }
      finalIds.add(row.id);
    }
    const ids = new Set(), observed = new Set();
    let documents = 0;
    for (const row of o.requests_at_boundary) {
      if (!Number.isSafeInteger(row.id) || ids.has(row.id)) throw new Error("Duplicate or invalid request identity");
      ids.add(row.id);
      if (!Number.isFinite(row.started_epoch_ms) || row.started_epoch_ms < start ||
          row.started_epoch_ms > boundary || row.state !== "FINISHED" ||
          !Number.isFinite(row.finished_epoch_ms) || row.finished_epoch_ms < row.started_epoch_ms ||
          row.finished_epoch_ms > boundary || row.completed_by_boundary !== true ||
          row.service_worker_request !== false || row.from_service_worker !== false) {
        throw new Error("Startup request is incomplete or outside the admitted boundary");
      }
      const final = o.requests.find((request) => request.id === row.id);
      for (const key of ["origin", "pathname", "resource_type", "state", "body_sha256",
        "decoded_body_bytes", "started_epoch_ms", "finished_epoch_ms", "status", "method"]) {
        if (!final || final[key] !== row[key]) throw new Error("Request boundary and final records disagree");
      }
      if (!["document", "script"].includes(row.resource_type)) continue;
      if (row.origin !== o.origin || row.method !== "GET" || row.status !== 200 ||
          row.query_bytes !== 0 || row.query_sha256 !== digest(Buffer.alloc(0)) ||
          row.response_role !== "PINNED_STATIC_ASSET" ||
          row.artifact_matches !== true || !isPath(row.artifact)) {
        throw new Error("Startup JavaScript/document response lacks exact local artifact binding");
      }
      const path = row.resource_type === "document" ? htmlPath : row.pathname.slice(1);
      if (row.resource_type === "document") {
        documents += 1;
        if (row.pathname !== o.route) throw new Error("The observed document route differs");
      } else if (!isJs(path) || row.pathname !== "/" + path) {
        throw new Error("Observed script has an unsupported asset URL");
      }
      const bytes = bytesByPath.get(path);
      if (row.artifact !== path || !bytes || row.body_sha256 !== digest(bytes) ||
          row.decoded_body_bytes !== bytes.length) throw new Error("Observed response bytes differ from emitted bytes");
      if (row.resource_type === "script") observed.add(path);
    }
    if (documents !== 1 || observed.size === 0) throw new Error("Startup has no single document and JavaScript membership");
    if (o.requests.some((row) => row.started_epoch_ms <= boundary && !ids.has(row.id))) {
      throw new Error("A request from the startup window is absent at the boundary");
    }
    for (const path of staticPaths) {
      if (!observed.has(path)) throw new Error("A statically imported script was not observed in the fresh context");
    }
    const measured = resources(observed, bytesByPath);
    result.status = "MEASURED";
    result.initialPaths = observed;
    result.initialJavaScript = { status: "MEASURED",
      rawBytes: measured.reduce((sum, row) => sum + row.rawBytes, 0),
      gzipBytes: measured.reduce((sum, row) => sum + row.gzipBytes, 0), resources: measured };
    result.measurement = { method: "gzip level 9 per distinct script response completed by the pinned startup boundary",
      route: o.route, profile: o.profile, boundary: o.boundary,
      observationSha256: admitted.observationSha256, moduleEvaluation: "NOT_MEASURED", fullGraph: "NOT_MEASURED" };
  } catch (error) {
    result.issues.push(error.message);
  }
  result.unobservedDynamicJavaScript = resources(new Set([...reachablePaths]
    .filter((path) => !staticPaths.has(path) && !result.initialPaths.has(path))), bytesByPath);
  return result;
}
