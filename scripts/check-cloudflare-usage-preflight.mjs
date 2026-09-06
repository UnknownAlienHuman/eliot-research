// Cloudflare usage preflight: Layer-1 admission gate before any remote
// mutation (FIX1 section B). Thin CLI over runUsagePreflight() in
// lib/cloudflare-usage-collection.mjs (shared with the in-process
// provisioner/deploy gates).
//
// Exit 0: ADMITTED or SEALED (sealed still allows zero/metadata-only
// provisioning; heavy operations stay disabled).
// Exit 2: BLOCKED. The caller must abort before its first remote mutation,
// so a block performs zero provisioning/deployment/API mutations.
//
// Modes:
//   non-OAuth auth mode - SEALED without any network call (CI metadata-only
//       path; never falls back to the static API token). No environment
//       variable selects fixture admission: ELIOTR_TEST_USAGE_SNAPSHOT_JSON
//       and ELIOTR_TEST_WRANGLER_WHOAMI_OUTPUT are never read here.
//   wrangler-oauth mode - live profile verification plus collection; metrics
//       Cloudflare does not expose stay `unknown` and seal heavy work.
//   --check-only - evaluate and print without writing any receipt file.
//   ELIOTR_USAGE_RECEIPT_PATH overrides the default ignored receipt path
//       (.eliotr-state/cloudflare-usage-admission-receipt.json).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runUsagePreflight } from "./lib/cloudflare-usage-collection.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check-only");
const receiptPath = process.env.ELIOTR_USAGE_RECEIPT_PATH ??
  resolve(repositoryRoot, ".eliotr-state/cloudflare-usage-admission-receipt.json");

try {
  const gate = await runUsagePreflight({
    env: process.env,
    nowMs: Date.now(),
    writeReceipt: !checkOnly,
    receiptPath,
    cwd: repositoryRoot,
  });
  console.log(JSON.stringify(gate.receipt, null, 2));
  if (gate.decision === "BLOCKED") {
    console.error(`Cloudflare usage preflight BLOCKED: ${gate.evaluation.reasons.join("; ")}. Zero remote mutations were performed.`);
    process.exit(2);
  }
  if (gate.decision === "SEALED") {
    console.error(`Cloudflare usage preflight SEALED: ${gate.evaluation.reasons.join("; ")}. Metadata-only provisioning may proceed; heavy operations stay disabled.`);
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(2);
}
