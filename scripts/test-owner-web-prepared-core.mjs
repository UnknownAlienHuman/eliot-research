import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPreparedCoreRuntimeProof } from "./lib/deployment-owner-web-prepared-core.mjs";
import { readOwnerWebStartup, observeOwnerWebStartup } from "./lib/deployment-owner-web-startup.mjs";

// Reader fixtures test rejection and byte custody only; they never qualify runtime execution.
const root = await mkdtemp(path.join(tmpdir(), "eliotr-startup-reader-"));
const worker = "apps/eliotr-web/dist/eliotr_core", client = "apps/eliotr-web/dist/client";
const source = "a".repeat(40), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const directory = ".eliotr-state/owner-web-startup-" + randomUUID();
async function file(relative, value) {
  const bytes = Buffer.from(value);
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), bytes);
  return { path: relative, byte_length: bytes.length, sha256: hash(bytes) };
}
let cases = 0;
try {
  const pins = [];
  pins.push(await file(worker + "/wrangler.json", JSON.stringify({ name: "eliotr-core", main: "index.js", no_bundle: true,
    vars: { DEPLOYMENT_GENERATION: "git-" + source.slice(0, 12) },
    assets: { directory: "../client", binding: "ASSETS", run_worker_first: ["/api/*"] } })));
  pins.push(await file(worker + "/owner-worker-graph.json", JSON.stringify({ chunks: [{ fileName: "index.js" }, { fileName: "assets/nested.js" }] })));
  pins.push(await file(worker + "/index.js", "export default {};"));
  pins.push(await file(worker + "/assets/nested.js", "export const nested = true;"));
  pins.push(await file("infra/d1/core/migrations/0001.sql", "SELECT 1;"));
  pins.push(await file("infra/d1/search/migrations/0001.sql", "SELECT 1;"));
  const proof = { protocol: "eliotr.local-prepared-core-startup-runtime.v1", source_commit: source,
    scope: "LOCAL_PREPARED_CORE_EMPTY_D1_R2_SIGNED_JWT_ONLY_NOT_LIVE", pins,
    migrations: [{ binding: "CORE_DB", count: 1, files: ["0001.sql"] }, { binding: "SEARCH_DB", count: 1, files: ["0001.sql"] }],
    auth: { missing: 401, invalid_signature: 401, jwks_requests: 1 }, run_and_draft_tables_empty: true,
    local_overlay: { ENVIRONMENT: "development", DEPLOYMENT_GENERATION: "local-prepared-startup-" + randomUUID(),
      ACCESS_TEAM_DOMAIN: ["https://owner-e2e", ".cloudflareaccess.com"].join(""), ACCESS_AUDIENCE: "owner-e2e-audience",
      ACCESS_SERVICE_PRINCIPALS: "", ACCESS_TEST_JWKS_URL: "http://127.0.0.1:1234/cdn-cgi/access/certs",
      AI_GATEWAY_REASONING_URL: "https://provider-disabled.invalid/reasoning", AI_GATEWAY_RETRIEVAL_URL: "https://provider-disabled.invalid/retrieval" },
    provider_execution: "NOT_RUN", remote_mutations: 0 };
  const persist = value => file(directory + "/native-core.json", JSON.stringify(value));
  const good = await persist(proof);
  assert.deepEqual(await readPreparedCoreRuntimeProof(root, good, source), proof); cases++;
  for (const mutate of [
    p => { p.source_commit = "b".repeat(40); }, p => { p.remote_mutations = 1; },
    p => { p.provider_execution = "PASS"; }, p => { p.auth.invalid_signature = 200; },
    p => { p.auth.jwks_requests = 0; }, p => { p.run_and_draft_tables_empty = false; },
    p => { p.local_overlay.ENVIRONMENT = "production"; },
    p => { p.local_overlay.ACCESS_TEAM_DOMAIN = "https://other-example.cloudflareaccess.com"; },
    p => { p.local_overlay.ACCESS_TEST_JWKS_URL = "https://remote.invalid/cdn-cgi/access/certs"; },
    p => { p.pins = p.pins.filter(pin => !pin.path.endsWith("nested.js")); },
    p => { p.pins.push(p.pins[0]); }, p => { p.migrations[0].count = 2; },
    p => { p.migrations[0].files = ["unapplied.sql"]; },
    p => { p.pins[0].path = "../outside.json"; }, p => { p.scope = "LIVE"; },
  ]) {
    const altered = structuredClone(proof); mutate(altered);
    await assert.rejects(readPreparedCoreRuntimeProof(root, await persist(altered), source)); cases++;
  }
  await persist(proof);
  await assert.rejects(readPreparedCoreRuntimeProof(root, { ...good, sha256: "0".repeat(64) }, source)); cases++;
  await file(worker + "/assets/nested.js", "export const nested = false;");
  await assert.rejects(readPreparedCoreRuntimeProof(root, good, source)); cases++;
  await file(worker + "/assets/nested.js", "export const nested = true;");
  const artifacts = [];
  for (const name of ["_headers", "index.html", "agent-inbox/index.html"]) {
    const pin = await file(client + "/" + name, "reader fixture");
    artifacts.push({ path: name, rawBytes: pin.byte_length, sha256: pin.sha256 });
  }
  const args = { root, sourceCommit: source, buildSha256: "c".repeat(64), artifacts,
    artifactReadbackSha256: hash(Buffer.from(JSON.stringify(artifacts))) };
  const local = "LOCAL_PREPARED_CLIENT_CORE_SIGNED_JWT_EMPTY_D1_READONLY";
  await assert.rejects(readOwnerWebStartup({ ...args, evidence: [{ profile: local }, { profile: "UNKNOWN" }] }), /mixed startup profile/u); cases++;
  await assert.rejects(readOwnerWebStartup({ ...args, evidence: [{ profile: local, native_runtime: good },
    { profile: local, native_runtime: { ...good, sha256: "d".repeat(64) } }] }), /same native Core proof/u); cases++;
  await assert.rejects(observeOwnerWebStartup({ ...args, environment: { ELIOTR_OWNER_WEB_STARTUP_PROFILE: "unknown" } }), /unknown startup profile selection/u); cases++;
  console.log(JSON.stringify({ state: "PASS_READER_ONLY_NOT_NATIVE", cases }));
} finally {
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert(path.basename(root).startsWith("eliotr-startup-reader-"));
  await rm(root, { recursive: true });
}
