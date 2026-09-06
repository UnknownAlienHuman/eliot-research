// Test-only standin for lib/cloudflare-usage-collection.mjs, loaded solely
// in children spawned with --import test-usage-gate-shim.mjs (see that
// file). Behavior is identical to production except runUsagePreflight also
// honors ELIOTR_TEST_SPAWN_SNAPSHOT_JSON — a variable production never reads
// and which has no effect without this standin (proven by each suite's
// poisoned-env denial test, including the FIX9WC NODE_OPTIONS-only injection
// case: the hooks refuse to redirect under ambient loader configuration, so
// this standin never loads and production seals). The snapshot still flows through the real
// envelope AFTER identity verification; nothing is weakened.
export * from "./lib/cloudflare-usage-collection.mjs";
import { runUsagePreflight as realPreflight } from "./lib/cloudflare-usage-collection.mjs";

export async function runUsagePreflight(options = {}) {
  const injected = process.env.ELIOTR_TEST_SPAWN_SNAPSHOT_JSON;
  if (injected !== undefined && injected !== "") {
    return realPreflight({ ...options, snapshot: injected });
  }
  return realPreflight(options);
}
