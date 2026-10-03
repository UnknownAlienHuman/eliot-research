import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudflaredOwnerFetch } from "./lib/cloudflare-owner-http.mjs";
import { readAuthenticatedCapabilities } from "./lib/deployment-maintenance.mjs";
import { readDeploymentJson, verifyDeploymentSmoke } from "./lib/deployment-verification.mjs";
import { readDeploymentAssetManifest, verifyDeploymentAssets } from "./lib/deployment-assets.mjs";
import { readCompositionCapabilityProfile } from "./check-launch-code.mjs";

const origin = "https://owner.example.test";
const input = { origin, cookie: null, ownerHttpTransport: "cloudflared" };
const generation = "git-fixture";
const now = Date.now();
const candidate = await readCompositionCapabilityProfile();
const capabilities = { protocol: candidate.protocol, deployment_generation: generation,
  google_external_transport: "disabled", enabled_slices: candidate.enabled_slices,
  partial_slices: candidate.partial_slices, disabled_slices: candidate.disabled_slices,
  federation_configured: false, orientation_profile: candidate.orientation_profile,
  orientation_max_sources: candidate.orientation_max_sources,
  orientation_max_results: candidate.orientation_max_results, routes: candidate.routes, ...candidate.safety_invariants };
const responses = new Map([
  ["/healthz", { ready: true, deployment_generation: generation, checked_at: new Date(now).toISOString() }],
  ["/api/v1/system/capabilities", { trace_id: "fixture", deployment_generation: generation, data: capabilities }],
]);
let requests = 0;
const result = (body, status = 200, type = "application/json") => ({
  stdout: Buffer.concat([Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)),
    Buffer.from(`\nELIOTR_OWNER_HTTP:${status}:${type}\n`)]), stderr: Buffer.alloc(0),
});
const fetchImpl = createCloudflaredOwnerFetch({ origin, environment: { CLOUDFLARE_API_TOKEN: "fixture-secret" },
  execute: async (binary, args, options) => {
    requests += 1;
    assert.equal(binary, "cloudflared");
    assert.deepEqual(args.slice(0, 2), ["access", "curl"]);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 15_000);
    assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
    assert.ok(args.includes("--no-location"));
    assert.ok(!args.some((arg) => /fixture-secret|CF_Authorization|allow-request|verbose/u.test(arg)));
    return result(responses.get(new URL(args[2]).pathname));
  } });
assert.equal((await readAuthenticatedCapabilities({ input, fetchImpl })).generation, generation);
assert.equal((await verifyDeploymentSmoke({ ELIOTR_DEPLOYMENT_GENERATION: generation }, input, { fetchImpl, now: () => now })).state, "PASS");
const before = requests;
for (const [url, init] of [["https://other.example.test/healthz", {}], [`${origin}/healthz?x=1`, {}],
  [`${origin}/api/v1/projects`, {}], [`${origin}/healthz`, { method: "POST" }],
  [`${origin}/healthz`, { headers: { Cookie: "fixture-secret" } }]]) {
  await assert.rejects(fetchImpl(url, init), /exact-origin readbacks only/u);
}
assert.equal(requests, before);
for (const response of [result({}, 302), result("login", 200, "text/html"),
  { stdout: Buffer.from("incomplete"), stderr: Buffer.alloc(0) }]) {
  const badFetch = createCloudflaredOwnerFetch({ origin, execute: async () => response });
  await assert.rejects(readAuthenticatedCapabilities({ input, fetchImpl: badFetch }));
}
const failedFetch = createCloudflaredOwnerFetch({ origin, execute: async () => { throw new Error("fixture-secret"); } });
await assert.rejects(failedFetch(`${origin}/healthz`), (error) => !error.message.includes("fixture-secret"));
responses.set("/healthz", { ...responses.get("/healthz"), deployment_generation: "git-stale" });
await assert.rejects(verifyDeploymentSmoke({ ELIOTR_DEPLOYMENT_GENERATION: generation }, input, { fetchImpl, now: () => now }));
const controller = new globalThis.AbortController();
controller.abort();
await assert.rejects(fetchImpl(`${origin}/healthz`, { signal: controller.signal }), /aborted/u);
let cancelled = false;
const stalled = createCloudflaredOwnerFetch({ origin, execute: async (_binary, _args, options) =>
  new Promise((_, reject) => options.signal.addEventListener("abort", () => {
    cancelled = true; reject(new Error("fixture-secret"));
  }, { once: true })) });
await assert.rejects(readDeploymentJson(`${origin}/healthz`, {}, { fetchImpl: stalled, timeoutMs: 5 }));
assert.equal(cancelled, true);

const root = await mkdtemp(join(tmpdir(), "eliotr-owner-http-"));
try {
  const dist = join(root, "apps", "eliotr-pwa", "dist");
  await mkdir(dist, { recursive: true });
  const bytes = Buffer.from([0, 1, 255, 2]);
  await writeFile(join(dist, "index.html"), bytes);
  const manifest = await readDeploymentAssetManifest({ assets: { directory: "../eliotr-pwa/dist" } }, { root });
  responses.set("/", bytes);
  assert.equal((await verifyDeploymentAssets(manifest, input, { fetchImpl })).state, "PASS");
  responses.set("/", Buffer.from([0, 1, 254, 2]));
  await assert.rejects(verifyDeploymentAssets(manifest, input, { fetchImpl }), /content mismatch/u);
} finally {
  assert.ok(root.startsWith(join(tmpdir(), "eliotr-owner-http-")), "cleanup stays in the owned temporary fixture");
  await rm(root, { recursive: true, force: true });
}
console.log("Official cloudflared owner HTTP: PASS (strict capability/health/assets fixtures, no live effects)");
