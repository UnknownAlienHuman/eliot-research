// Keep the current developer route discoverable and its links valid.
// Historical audits and superseded plans are intentionally not required in the index:
// Git history is the archive, not mandatory agent context.

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const errors = [];

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function localTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/gu)) {
    const target = match[1];
    if (target === undefined || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    const clean = target.split("#", 1)[0]?.split("?", 1)[0];
    if (clean) targets.push(clean);
  }
  return targets;
}

function requireLink(file, target) {
  if (!read(file).includes(`(${target})`)) errors.push(`${file}: must link ${target}`);
}

const entrypoints = [
  ["README.md", "docs/START-HERE.md"],
  ["AGENTS.md", "docs/START-HERE.md"],
  ["IMPLEMENTATION.md", "docs/START-HERE.md"],
  ["docs/README.md", "START-HERE.md"],
  ["docs/implementation/README.md", "../START-HERE.md"],
];
for (const [file, target] of entrypoints) requireLink(file, target);

const currentImplementation = [
  "backend-entrypoints.md",
  "production-readiness-plan.md",
  "source-lifecycle.md",
  "dependency-map.md",
  "runtime-contract.md",
  "cloudflare-native-path.md",
  "research-full-answer-v1.md",
  "deep-research.md",
  "research-session-projection-protocol.md",
  "wiki-inbox.md",
  "owner-read-paths.md",
  "frontend-platform-migration.md",
  "local-launch.md",
  "toolchain.md",
  "workflow-checkpoints.md",
  "failure-model.md",
  "security-checklist.md",
  "rust-kernel-abi-versioning.md",
  "donors.md",
  "perplexity-donor.md",
  "notebooklm-donor.md",
  "edgequake-donor.md",
  "scoped-verification.md",
  "branch-discipline.md",
];
const implementationIndex = read("docs/implementation/README.md");
for (const document of currentImplementation) {
  if (!implementationIndex.includes(`(${document})`)) {
    errors.push(`docs/implementation/README.md: does not link current document ${document}`);
  }
}

const currentUi = [
  "frontend-owner-execution-map.md",
  "frontend-material-agent-playbook.md",
  "frontend-notebooklm-material-reference.md",
  "frontend-autonomous-manager-runbook.md",
];
const uiIndex = read("docs/agent-work/README.md");
for (const document of currentUi) {
  if (!uiIndex.includes(`(${document})`)) {
    errors.push(`docs/agent-work/README.md: does not link current UI document ${document}`);
  }
}
if (!uiIndex.includes("(../design/OWNER_WEB_UI.md)")) {
  errors.push("docs/agent-work/README.md: does not link current owner-web design");
}

const checkedDocuments = [
  "README.md",
  "AGENTS.md",
  "IMPLEMENTATION.md",
  "docs/README.md",
  "docs/START-HERE.md",
  "docs/architecture/ELIOT_RESEARCH.md",
  "docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md",
  "docs/implementation/README.md",
  ...currentImplementation.map((name) => `docs/implementation/${name}`),
  "docs/agent-work/README.md",
  ...currentUi.map((name) => `docs/agent-work/${name}`),
  "docs/design/README.md",
  "docs/design/OWNER_WEB_UI.md",
  "apps/eliotr-web/README.md",
  "apps/eliotr-web/AGENTS.md",
];
for (const document of checkedDocuments) {
  const directory = dirname(join(root, document));
  for (const target of localTargets(read(document))) {
    try {
      statSync(resolve(directory, target));
    } catch {
      errors.push(`${document}: broken local link ${target}`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`documentation route: ${error}`);
  console.error(`\n${errors.length} documentation route problem(s).`);
  process.exit(1);
}

console.log(`Documentation route valid: ${checkedDocuments.length} current documents checked.`);
