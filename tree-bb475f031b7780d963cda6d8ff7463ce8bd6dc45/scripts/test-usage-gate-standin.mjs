// Test-only standin for lib/cloudflare-usage-admission.mjs (and re-export of
// lib/cloudflare-usage-collection.mjs), loaded solely in children spawned
// with --import test-usage-gate-shim.mjs (see that file). Behavior is
// identical to production except:
//   (a) runUsagePreflight also honors ELIOTR_TEST_SPAWN_SNAPSHOT_JSON — a
//       variable production never reads and which has no effect without this
//       standin (proven by each suite's poisoned-env denial test, including
//       the FIX9WC NODE_OPTIONS-only injection case: the hooks refuse to
//       redirect under ambient loader configuration, so this standin never
//       loads and production seals). The snapshot still flows through the
//       real envelope AFTER identity verification; nothing is weakened.
//   (b) on an ADMITTED result the standin mints a TEST capability from its
//       OWN module-private registry and returns it as `capability`, and its
//       isUsageAdmissionCapability override accepts production capabilities OR
//       test capabilities minted in this redirected process. Test gates
//       therefore exercise the full capability mechanics without any
//       production-reachable mint: production code never imports this module,
//       and the production predicate never consults the test registry.
//   (c) ELIOTR_TEST_SPAWN_SUPPRESS_CAPABILITY=1 (standin-only; production
//       never reads it) skips test minting, so a child can hold an ADMITTED
//       evaluation with no capability to prove ADMITTED-alone denial.
export * from "./lib/cloudflare-usage-collection.mjs";
import {
  isUsageAdmissionCapability as realIsCapability,
  runUsagePreflight as realPreflight,
} from "./lib/cloudflare-usage-admission.mjs";

// Module-PRIVATE test capability registry: test capability object identity
// for --import-redirected processes only. Populated solely by the standin
// mint below; production modules never import this file, so this registry is
// mechanically unreachable from production entry paths.
const TEST_CAPABILITIES = new WeakSet();

export function isUsageAdmissionCapability(capability) {
  return realIsCapability(capability) || TEST_CAPABILITIES.has(capability);
}

function mintTestCapability() {
  const capability = Object.freeze({ testAdmission: true });
  TEST_CAPABILITIES.add(capability);
  return capability;
}

const SUPPRESS_TEST_CAPABILITY = process.env.ELIOTR_TEST_SPAWN_SUPPRESS_CAPABILITY === "1";

export async function runUsagePreflight(options = {}) {
  const injected = process.env.ELIOTR_TEST_SPAWN_SNAPSHOT_JSON;
  const result = await realPreflight(
    injected !== undefined && injected !== "" ? { ...options, snapshot: injected } : options,
  );
  if (result.decision === "ADMITTED" && !SUPPRESS_TEST_CAPABILITY) {
    return { ...result, capability: mintTestCapability() };
  }
  return result;
}
