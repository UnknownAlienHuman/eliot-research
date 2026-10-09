const EXPECTED_WORKER_FIRST_ROUTES = Object.freeze([
  "/healthz",
  "/mcp",
  "/agent-inbox",
  "/agent-inbox/*",
  "/agents",
  "/agents/*",
  "/api/*",
  "/federation/*",
  "/oauth/*",
]);

const EXPECTED_ASSET_SETTINGS = Object.freeze({
  directory: "../eliotr-pwa/dist",
  binding: "ASSETS",
  not_found_handling: "single-page-application",
});

function requireWorkerFirstRoutes(config, label) {
  const assets = config?.assets;
  if (assets === null || typeof assets !== "object" || Array.isArray(assets)) {
    throw new Error(`${label} is missing the Core static asset configuration`);
  }
  for (const [key, expected] of Object.entries(EXPECTED_ASSET_SETTINGS)) {
    if (assets[key] !== expected) {
      throw new Error(`${label} changed the Core static asset fallback configuration`);
    }
  }
  const routes = assets.run_worker_first;
  if (!Array.isArray(routes) || routes.some((route) => typeof route !== "string")) {
    throw new Error(`${label} must keep selective Worker-first routing enabled`);
  }
  const actual = [...routes].sort();
  const expected = [...EXPECTED_WORKER_FIRST_ROUTES].sort();
  if (actual.length !== expected.length || actual.some((route, index) => route !== expected[index])) {
    throw new Error(`${label} does not contain the required Core Worker-first route family`);
  }
  return actual;
}

/** Assert generated deployment routing preserves the canonical Core asset policy. */
export function assertCoreWorkerRouteParity(canonicalConfig, generatedConfig) {
  const canonicalRoutes = requireWorkerFirstRoutes(canonicalConfig, "Canonical Wrangler config");
  const generatedRoutes = requireWorkerFirstRoutes(generatedConfig, "Generated Wrangler config");
  if (canonicalRoutes.some((route, index) => route !== generatedRoutes[index])) {
    throw new Error("Generated Wrangler config diverges from canonical Worker-first routing");
  }
  return generatedConfig;
}
