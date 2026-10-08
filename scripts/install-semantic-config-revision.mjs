#!/usr/bin/env node
// S29 explicit migration: install the legacy semantic configuration as one
// immutable D1 revision and print the revision identity for the environment.
//
// This script never writes anywhere. It prints:
//   1. the exact SQL INSERT to run against the Core D1 database, and
//   2. the ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF / _SHA256 values to set.
//
// The operator runs the SQL deliberately (via wrangler d1 execute or the
// dashboard), sets the two vars in the research runtime envelope, and
// redeploys. The Worker read path never installs revisions by itself.
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalResearchSemanticConfiguration,
  loadResearchRuntimeEnvironment,
  RESEARCH_RUNTIME_SEMANTIC_CONFIGURATION_KEY,
} from "./lib/research-runtime-config.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL = "eliotr.research-semantic-config.v1";

function fail(message) {
  console.error(`install-semantic-config-revision: ${message}`);
  process.exit(1);
}

function sqlQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

const createdBy = process.argv[2];
if (typeof createdBy !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(createdBy)) {
  fail("usage: install-semantic-config-revision.mjs <created-by-principal-ref>");
}

const environment = await loadResearchRuntimeEnvironment(process.env, repositoryRoot);
const raw = environment[RESEARCH_RUNTIME_SEMANTIC_CONFIGURATION_KEY];
if (typeof raw !== "string") {
  fail("research runtime envelope has no ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON to migrate");
}
const canonical = canonicalResearchSemanticConfiguration(raw);
const parsed = JSON.parse(canonical);
if (parsed.protocol !== PROTOCOL) fail(`semantic configuration protocol is not ${PROTOCOL}`);
const bytes = Buffer.from(canonical, "utf8");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const revisionRef = `scr-${sha256.slice(0, 12)}`;
const createdAt = new Date().toISOString();

console.log(`revision_ref:        ${revisionRef}`);
console.log(`config_sha256:      ${sha256}`);
console.log(`byte_length:        ${bytes.byteLength}`);
console.log("");
console.log("-- Run against the Core D1 database (migration 0096 must be applied):");
console.log(
  `INSERT INTO research_semantic_config_revision ` +
  `(revision_ref,config_sha256,config_json,byte_length,protocol,created_at,created_by_principal_ref) VALUES (` +
  `${sqlQuote(revisionRef)},${sqlQuote(sha256)},${sqlQuote(canonical)},${bytes.byteLength},` +
  `${sqlQuote(PROTOCOL)},${sqlQuote(createdAt)},${sqlQuote(createdBy)});`,
);
console.log("");
console.log("# Set in the research runtime envelope, then redeploy:");
console.log(`ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF=${revisionRef}`);
console.log(`ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256=${sha256}`);
