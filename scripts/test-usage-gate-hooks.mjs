// Test-only module hooks for the spawn gate (see test-usage-gate-shim.mjs).
// Redirects lib/cloudflare-usage-collection.mjs to the test standin, but
// ONLY when imported by a production CLI entry point (the provisioners, the
// preflight CLI, the deployer). Every other importer — including the standin
// itself importing the real module — resolves normally, so no cycle occurs.
//
// FIX9WC Layer 1 (primary, test-only): this hook REFUSES to redirect when it
// was itself loaded via ambient loader configuration — i.e. when
// process.env.NODE_OPTIONS contains any module-loader token (--import,
// --loader, --experimental-loader, --require, any dash/`=` prefix form). Node
// auto-loads such tokens at startup, so an env-only injection
// (NODE_OPTIONS=--import <shim> plus ELIOTR_TEST_SPAWN_SNAPSHOT_JSON, with no
// --import on argv) degrades to plain production code, which never reads the
// snapshot variable and seals fail-closed. Legitimate test spawns pass
// --import via argv with a scrubbed child env (loader tokens removed from
// NODE_OPTIONS), so they keep redirecting; spawn sites must keep scrubbing,
// otherwise a poisoned outer env degrades legitimate children to SEALED
// (fail-closed, never false-admit).
import { nodeOptionsHasLoaderToken } from "./lib/cloudflare-wrangler-oauth.mjs";

const AMBIENT_LOADER_REFUSED = nodeOptionsHasLoaderToken(process.env.NODE_OPTIONS);

const GATED_PARENTS = new Set([
  "provision-cloudflare-core.mjs",
  "provision-cloudflare-access.mjs",
  "provision-ai-search.mjs",
  "provision-ai-gateways.mjs",
  "check-cloudflare-usage-preflight.mjs",
  "deploy-cloudflare.mjs",
]);

export async function resolve(specifier, context, nextResolve) {
  // Layer 1 refusal: ambient loader configuration means this hook was not
  // requested by explicit spawn argv — resolve everything normally.
  if (AMBIENT_LOADER_REFUSED) return nextResolve(specifier, context);
  if (/(^|\/)cloudflare-usage-collection\.mjs$/.test(specifier)) {
    const parent = String(context?.parentURL ?? "");
    const parentFile = parent.split("/").pop().split("?")[0];
    if (GATED_PARENTS.has(parentFile)) {
      return {
        url: new URL("./test-usage-gate-standin.mjs", import.meta.url).href,
        shortCircuit: true,
      };
    }
  }
  return nextResolve(specifier, context);
}
