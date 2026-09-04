from pathlib import Path

branch_hygiene_lib = r'''const HOUR_MS = 60 * 60 * 1000;

function parseTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return timestamp;
}

function branchNameSet(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const output = new Set();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${label} entries must be non-empty strings`);
    }
    output.add(value);
  }
  return output;
}

export function validateBranchHygieneConfig(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("branch hygiene config must be an object");
  }
  const allowed = new Set([
    "protocol",
    "default_branch",
    "max_non_default_branches",
    "ttl_hours",
    "bootstrap_delete_before",
    "preserve_open_pull_requests",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`unknown branch hygiene field: ${key}`);
  }
  if (raw.protocol !== "eliotr.branch-hygiene.v1") {
    throw new Error("unsupported branch hygiene protocol");
  }
  if (typeof raw.default_branch !== "string" || raw.default_branch.length === 0) {
    throw new Error("default_branch is required");
  }
  if (!Number.isSafeInteger(raw.max_non_default_branches) || raw.max_non_default_branches < 0) {
    throw new Error("max_non_default_branches must be a non-negative integer");
  }
  if (!Number.isSafeInteger(raw.ttl_hours) || raw.ttl_hours < 1 || raw.ttl_hours > 24 * 30) {
    throw new Error("ttl_hours must be an integer in [1, 720]");
  }
  parseTimestamp(raw.bootstrap_delete_before, "bootstrap_delete_before");
  if (raw.preserve_open_pull_requests !== true) {
    throw new Error("open pull requests must be preserved");
  }
  return Object.freeze({
    protocol: raw.protocol,
    default_branch: raw.default_branch,
    max_non_default_branches: raw.max_non_default_branches,
    ttl_hours: raw.ttl_hours,
    bootstrap_delete_before: raw.bootstrap_delete_before,
    preserve_open_pull_requests: true,
  });
}

export function classifyBranch(branch, context) {
  if (typeof branch?.name !== "string" || branch.name.length === 0) {
    throw new Error("branch name is required");
  }
  if (typeof branch.sha !== "string" || branch.sha.length === 0) {
    throw new Error(`branch ${branch.name} sha is required`);
  }
  if (branch.name === context.config.default_branch) {
    return { action: "PRESERVE", reason: "DEFAULT_BRANCH" };
  }
  if (context.openPrHeads.has(branch.name)) {
    return { action: "PRESERVE", reason: "OPEN_PULL_REQUEST" };
  }
  if (context.closedPrHeads.has(branch.name)) {
    return { action: "DELETE", reason: "CLOSED_PULL_REQUEST" };
  }

  const updatedAt = parseTimestamp(branch.updated_at, `branch ${branch.name} updated_at`);
  const bootstrapCutoff = parseTimestamp(
    context.config.bootstrap_delete_before,
    "bootstrap_delete_before",
  );
  if (updatedAt <= bootstrapCutoff) {
    return { action: "DELETE", reason: "PRE_CONTRACT_LEGACY_BRANCH" };
  }

  const ageMs = context.now_ms - updatedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    throw new Error(`branch ${branch.name} has a future updated_at`);
  }
  if (ageMs >= context.config.ttl_hours * HOUR_MS) {
    return { action: "DELETE", reason: "TTL_EXPIRED_WITHOUT_OPEN_PR" };
  }
  return { action: "PRESERVE", reason: "RECENT_UNMERGED_BRANCH" };
}

function newestFirst(left, right) {
  const timestampDifference =
    parseTimestamp(right.updated_at, `branch ${right.name} updated_at`) -
    parseTimestamp(left.updated_at, `branch ${left.name} updated_at`);
  return timestampDifference === 0
    ? left.name.localeCompare(right.name)
    : timestampDifference;
}

export function planBranchCleanup({
  branches,
  open_pr_heads,
  closed_pr_heads = [],
  now_ms,
  config: rawConfig,
}) {
  const config = validateBranchHygieneConfig(rawConfig);
  if (!Array.isArray(branches)) throw new Error("branches must be an array");
  if (!Number.isSafeInteger(now_ms) || now_ms < 0) {
    throw new Error("now_ms must be a non-negative safe integer");
  }
  const openPrHeads = branchNameSet(open_pr_heads, "open_pr_heads");
  const closedPrHeads = branchNameSet(closed_pr_heads, "closed_pr_heads");
  const seen = new Set();
  const provisional = [];

  for (const branch of branches) {
    if (seen.has(branch.name)) throw new Error(`duplicate branch: ${branch.name}`);
    seen.add(branch.name);
    provisional.push({
      name: branch.name,
      sha: branch.sha,
      updated_at: branch.updated_at,
      ...classifyBranch(branch, { config, openPrHeads, closedPrHeads, now_ms }),
    });
  }

  if (!seen.has(config.default_branch)) {
    throw new Error(`default branch ${config.default_branch} is absent`);
  }

  const fixedNonDefault = provisional.filter(
    (item) =>
      item.name !== config.default_branch &&
      item.action === "PRESERVE" &&
      item.reason !== "RECENT_UNMERGED_BRANCH",
  );
  const recent = provisional
    .filter((item) => item.reason === "RECENT_UNMERGED_BRANCH")
    .sort(newestFirst);
  const recentCapacity = Math.max(
    0,
    config.max_non_default_branches - fixedNonDefault.length,
  );
  const recentToPreserve = new Set(
    recent.slice(0, recentCapacity).map((item) => item.name),
  );
  const decisions = provisional.map((item) =>
    item.reason === "RECENT_UNMERGED_BRANCH" &&
    !recentToPreserve.has(item.name)
      ? {
          ...item,
          action: "DELETE",
          reason: "QUARANTINE_CEILING_EVICTION",
        }
      : item,
  );
  const deleteItems = decisions.filter((item) => item.action === "DELETE");
  const preserveItems = decisions.filter((item) => item.action === "PRESERVE");
  const projectedNonDefault = preserveItems.filter(
    (item) => item.name !== config.default_branch,
  ).length;

  return Object.freeze({
    config,
    decisions: Object.freeze(decisions),
    delete: Object.freeze(deleteItems),
    preserve: Object.freeze(preserveItems),
    projected_non_default_branches: projectedNonDefault,
    ceiling_satisfied:
      projectedNonDefault <= config.max_non_default_branches,
  });
}
'''
Path("scripts/branch-hygiene-lib.mjs").write_text(
    branch_hygiene_lib,
    encoding="utf-8",
)

branch_hygiene = r'''import { readFile, appendFile } from "node:fs/promises";
import { planBranchCleanup } from "./branch-hygiene-lib.mjs";

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com";

if (typeof repository !== "string" || !/^[^/]+\/[^/]+$/u.test(repository)) {
  throw new Error("GITHUB_REPOSITORY must be owner/repository");
}
if (typeof token !== "string" || token.length < 20) {
  throw new Error("GITHUB_TOKEN is missing");
}

const config = JSON.parse(
  await readFile(
    new URL("../infra/github/branch-hygiene.json", import.meta.url),
    "utf8",
  ),
);

async function api(path, init = {}) {
  const {
    ignore_not_found: ignoreNotFound = false,
    ...requestInit
  } = init;
  const response = await fetch(`${apiBase}${path}`, {
    ...requestInit,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "eliotr-branch-hygiene",
      ...requestInit.headers,
    },
  });
  if (response.status === 204) return null;
  const text = await response.text();
  if (response.status === 404 && ignoreNotFound) return null;
  if (!response.ok) {
    throw new Error(
      `GitHub API ${requestInit.method ?? "GET"} ${path} failed: ` +
      `${response.status} ${text.slice(0, 512)}`,
    );
  }
  return text.length === 0 ? null : JSON.parse(text);
}

async function paged(path) {
  const output = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await api(`${path}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`expected array from ${path}`);
    output.push(...batch);
    if (batch.length < 100) return output;
  }
}

function localPullHead(pullRequest) {
  if (pullRequest?.head?.repo?.full_name !== repository) return null;
  return typeof pullRequest?.head?.ref === "string"
    ? pullRequest.head.ref
    : null;
}

function pullRequestHeads(pullRequests, state) {
  return pullRequests
    .filter((pullRequest) => pullRequest?.state === state)
    .map(localPullHead)
    .filter((value) => typeof value === "string");
}

const [branchRows, pullRequests] = await Promise.all([
  paged(`/repos/${repository}/branches`),
  paged(`/repos/${repository}/pulls?state=all&sort=updated&direction=desc`),
]);
const openPrHeads = pullRequestHeads(pullRequests, "open");
const closedPrHeads = pullRequestHeads(pullRequests, "closed");

async function branchRecord(row) {
  const name = row?.name;
  const sha = row?.commit?.sha;
  if (typeof name !== "string" || typeof sha !== "string") {
    throw new Error("malformed branch list response");
  }
  const commit = await api(`/repos/${repository}/commits/${sha}`);
  const updatedAt = commit?.commit?.committer?.date ??
    commit?.commit?.author?.date;
  if (typeof updatedAt !== "string") {
    throw new Error(`branch ${name} commit has no timestamp`);
  }
  return { name, updated_at: updatedAt, sha };
}

const branches = [];
for (let index = 0; index < branchRows.length; index += 8) {
  branches.push(...await Promise.all(
    branchRows.slice(index, index + 8).map(branchRecord),
  ));
}

const plan = planBranchCleanup({
  branches,
  open_pr_heads: openPrHeads,
  closed_pr_heads: closedPrHeads,
  now_ms: Date.now(),
  config,
});

const deleted = [];
const skipped = [];
const alreadyAbsent = [];
for (const item of plan.delete) {
  const latestOpenPullRequests = await paged(
    `/repos/${repository}/pulls?state=open&sort=updated&direction=desc`,
  );
  const latestOpenHeads = new Set(
    pullRequestHeads(latestOpenPullRequests, "open"),
  );
  if (latestOpenHeads.has(item.name)) {
    skipped.push({ ...item, skip_reason: "OPEN_PULL_REQUEST_AFTER_PLAN" });
    continue;
  }

  const encoded = encodeURIComponent(item.name);
  const ref = await api(
    `/repos/${repository}/git/ref/heads/${encoded}`,
    { ignore_not_found: true },
  );
  if (ref === null) {
    alreadyAbsent.push(item);
    continue;
  }
  const currentSha = ref?.object?.sha;
  if (typeof currentSha !== "string") {
    throw new Error(`branch ${item.name} ref has no commit SHA`);
  }
  if (currentSha !== item.sha) {
    skipped.push({ ...item, skip_reason: "BRANCH_ADVANCED_AFTER_PLAN" });
    continue;
  }
  await api(
    `/repos/${repository}/git/refs/heads/${encoded}`,
    { method: "DELETE", ignore_not_found: true },
  );
  deleted.push(item);
  console.log(`deleted ${item.name}: ${item.reason}`);
}

const remainingRows = await paged(`/repos/${repository}/branches`);
const remaining = remainingRows
  .map((row) => row?.name)
  .filter((value) => typeof value === "string")
  .sort();
if (!remaining.includes(config.default_branch)) {
  throw new Error("default branch disappeared during cleanup");
}
const nonDefault = remaining.filter(
  (name) => name !== config.default_branch,
);
const actualCeilingSatisfied =
  nonDefault.length <= config.max_non_default_branches;

const summary = [
  "# Eliot Research branch hygiene",
  "",
  `- repository: \`${repository}\``,
  `- planned deletions: **${plan.delete.length}**`,
  `- deleted: **${deleted.length}**`,
  `- already absent: **${alreadyAbsent.length}**`,
  `- skipped after recheck: **${skipped.length}**`,
  `- remaining non-default branches: **${nonDefault.length}**`,
  `- ceiling: **${config.max_non_default_branches}**`,
  `- projected ceiling satisfied: **${plan.ceiling_satisfied}**`,
  `- actual ceiling satisfied: **${actualCeilingSatisfied}**`,
  "",
  "## Deleted branches",
  "",
  ...(deleted.length === 0
    ? ["None."]
    : deleted.map((item) => `- \`${item.name}\` — ${item.reason}`)),
  "",
  "## Skipped after authoritative recheck",
  "",
  ...(skipped.length === 0
    ? ["None."]
    : skipped.map(
        (item) => `- \`${item.name}\` — ${item.skip_reason}`,
      )),
  "",
  "## Remaining branches",
  "",
  ...remaining.map((name) => `- \`${name}\``),
  "",
].join("\n");

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (typeof summaryPath === "string" && summaryPath.length > 0) {
  await appendFile(summaryPath, summary, "utf8");
}
console.log(summary);

if (!actualCeilingSatisfied) {
  throw new Error(
    `branch ceiling still exceeded: ${nonDefault.length} > ` +
    `${config.max_non_default_branches}`,
  );
}
'''
Path("scripts/branch-hygiene.mjs").write_text(
    branch_hygiene,
    encoding="utf-8",
)

branch_hygiene_test = r'''import assert from "node:assert/strict";
import {
  planBranchCleanup,
  validateBranchHygieneConfig,
} from "./branch-hygiene-lib.mjs";

const config = validateBranchHygieneConfig({
  protocol: "eliotr.branch-hygiene.v1",
  default_branch: "main",
  max_non_default_branches: 3,
  ttl_hours: 24,
  bootstrap_delete_before: "2026-09-02T00:00:00.000Z",
  preserve_open_pull_requests: true,
});
const now = Date.parse("2026-09-03T12:00:00.000Z");
const branch = (name, updated_at, sha) => ({ name, updated_at, sha });

const plan = planBranchCleanup({
  now_ms: now,
  config,
  open_pr_heads: ["agent/open-pr"],
  closed_pr_heads: ["agent/closed-pr"],
  branches: [
    branch("main", "2026-09-03T11:00:00.000Z", "main-sha"),
    branch("agent/open-pr", "2026-08-01T00:00:00.000Z", "open-sha"),
    branch("agent/closed-pr", "2026-09-03T11:30:00.000Z", "closed-sha"),
    branch("agent/legacy", "2026-09-01T07:00:00.000Z", "legacy-sha"),
    branch("agent/stale", "2026-09-02T08:00:00.000Z", "stale-sha"),
    branch("agent/recent-new", "2026-09-03T11:00:00.000Z", "new-sha"),
    branch("agent/recent-mid", "2026-09-03T10:00:00.000Z", "mid-sha"),
    branch("agent/recent-old", "2026-09-03T09:00:00.000Z", "old-sha"),
  ],
});

assert.deepEqual(
  plan.delete.map((item) => [item.name, item.reason]),
  [
    ["agent/closed-pr", "CLOSED_PULL_REQUEST"],
    ["agent/legacy", "PRE_CONTRACT_LEGACY_BRANCH"],
    ["agent/stale", "TTL_EXPIRED_WITHOUT_OPEN_PR"],
    ["agent/recent-old", "QUARANTINE_CEILING_EVICTION"],
  ],
);
assert.deepEqual(
  plan.preserve.map((item) => [item.name, item.reason]),
  [
    ["main", "DEFAULT_BRANCH"],
    ["agent/open-pr", "OPEN_PULL_REQUEST"],
    ["agent/recent-new", "RECENT_UNMERGED_BRANCH"],
    ["agent/recent-mid", "RECENT_UNMERGED_BRANCH"],
  ],
);
assert.equal(plan.projected_non_default_branches, 3);
assert.equal(plan.ceiling_satisfied, true);

const openWins = planBranchCleanup({
  now_ms: now,
  config: { ...config, max_non_default_branches: 1 },
  open_pr_heads: ["agent/reused"],
  closed_pr_heads: ["agent/reused"],
  branches: [
    branch("main", "2026-09-03T11:00:00.000Z", "main-sha"),
    branch("agent/reused", "2026-08-01T00:00:00.000Z", "reused-sha"),
  ],
});
assert.deepEqual(
  openWins.preserve.map((item) => [item.name, item.reason]),
  [
    ["main", "DEFAULT_BRANCH"],
    ["agent/reused", "OPEN_PULL_REQUEST"],
  ],
);

const protectedOverflow = planBranchCleanup({
  now_ms: now,
  config: { ...config, max_non_default_branches: 1 },
  open_pr_heads: ["agent/a", "agent/b"],
  closed_pr_heads: [],
  branches: [
    branch("main", "2026-09-03T11:00:00.000Z", "main-sha"),
    branch("agent/a", "2026-09-03T11:00:00.000Z", "a-sha"),
    branch("agent/b", "2026-09-03T10:00:00.000Z", "b-sha"),
    branch("agent/recent", "2026-09-03T09:00:00.000Z", "recent-sha"),
  ],
});
assert.deepEqual(
  protectedOverflow.delete.map((item) => [item.name, item.reason]),
  [["agent/recent", "QUARANTINE_CEILING_EVICTION"]],
);
assert.equal(protectedOverflow.projected_non_default_branches, 2);
assert.equal(protectedOverflow.ceiling_satisfied, false);

assert.throws(
  () => planBranchCleanup({
    now_ms: now,
    config,
    open_pr_heads: [],
    closed_pr_heads: [null],
    branches: [
      branch("main", "2026-09-03T11:00:00.000Z", "main-sha"),
    ],
  }),
  /closed_pr_heads entries/u,
);
assert.throws(
  () => validateBranchHygieneConfig({ ...config, unexpected: true }),
  /unknown branch hygiene field/u,
);

console.log("branch hygiene deterministic fixtures: PASS");
'''
Path("scripts/test-branch-hygiene.mjs").write_text(
    branch_hygiene_test,
    encoding="utf-8",
)

workflow_path = Path(".github/workflows/branch-hygiene.yml")
workflow = workflow_path.read_text(encoding="utf-8")
workflow = workflow.replace(
    "actions/checkout@v4",
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
)
workflow = workflow.replace(
    "actions/setup-node@v4",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
)
workflow_path.write_text(workflow, encoding="utf-8")

manifest_path = Path("docs/agent-work/manifest.json")
manifest = manifest_path.read_text(encoding="utf-8")
manifest_anchor = '        ".github/**",\n        "Cargo.toml",'
manifest_replacement = (
    '        ".github/**",\n'
    '        "infra/github/branch-hygiene.json",\n'
    '        "Cargo.toml",'
)
if manifest.count(manifest_anchor) != 1:
    raise SystemExit("ER-00 infra ownership anchor missing or ambiguous")
manifest = manifest.replace(manifest_anchor, manifest_replacement)
manifest_anchor = (
    '        "scripts/check-rust-boundaries.mjs",\n'
    '        "docs/agent-work/manifest.json",'
)
manifest_replacement = (
    '        "scripts/check-rust-boundaries.mjs",\n'
    '        "scripts/branch-hygiene-lib.mjs",\n'
    '        "scripts/branch-hygiene.mjs",\n'
    '        "scripts/test-branch-hygiene.mjs",\n'
    '        "docs/agent-work/manifest.json",'
)
if manifest.count(manifest_anchor) != 1:
    raise SystemExit("ER-00 script ownership anchor missing or ambiguous")
manifest_path.write_text(
    manifest.replace(manifest_anchor, manifest_replacement),
    encoding="utf-8",
)

document_path = Path("docs/agent-work/ER-00-workspace-and-verification-gates.md")
document = document_path.read_text(encoding="utf-8")
document_anchor = "- `.github/**`\n- `Cargo.toml`"
document_replacement = (
    "- `.github/**`\n"
    "- `infra/github/branch-hygiene.json`\n"
    "- `Cargo.toml`"
)
if document.count(document_anchor) != 1:
    raise SystemExit("ER-00 document infra ownership anchor missing or ambiguous")
document = document.replace(document_anchor, document_replacement)
document_anchor = (
    "- `scripts/check-rust-boundaries.mjs`\n"
    "- `docs/agent-work/manifest.json`"
)
document_replacement = (
    "- `scripts/check-rust-boundaries.mjs`\n"
    "- `scripts/branch-hygiene-lib.mjs`\n"
    "- `scripts/branch-hygiene.mjs`\n"
    "- `scripts/test-branch-hygiene.mjs`\n"
    "- `docs/agent-work/manifest.json`"
)
if document.count(document_anchor) != 1:
    raise SystemExit("ER-00 document script ownership anchor missing or ambiguous")
document = document.replace(document_anchor, document_replacement)
required_anchor = (
    "- Enforce pure-core exclusions for I/O, clocks, environment, randomness and platform runtime imports.\n"
    "- Run merge-blocking format, lint, native tests, doctests, dependency policy, Wasm, size and coverage"
)
required_replacement = (
    "- Enforce pure-core exclusions for I/O, clocks, environment, randomness and platform runtime imports.\n"
    "- Preserve open PR heads, immediately remove closed PR heads, expire no-PR branches after 24 hours,\n"
    "  and evict the oldest quarantine heads before enforcing the five-branch ceiling.\n"
    "- Run merge-blocking format, lint, native tests, doctests, dependency policy, Wasm, size and coverage"
)
if document.count(required_anchor) != 1:
    raise SystemExit("ER-00 required implementation anchor missing or ambiguous")
document = document.replace(required_anchor, required_replacement)
acceptance_anchor = (
    "- `pnpm work-packets:check` rejects owned-path overlaps, unknown dependencies, duplicate IDs, and DAG cycles.\n"
    "- `pnpm boundaries:negative` injects a forbidden import"
)
acceptance_replacement = (
    "- `pnpm work-packets:check` rejects owned-path overlaps, unknown dependencies, duplicate IDs, and DAG cycles.\n"
    "- Branch hygiene preserves open PRs, deletes closed PR heads immediately, rechecks head identity before\n"
    "  deletion, and deterministically evicts the oldest recent no-PR branches above the ceiling.\n"
    "- `pnpm boundaries:negative` injects a forbidden import"
)
if document.count(acceptance_anchor) != 1:
    raise SystemExit("ER-00 acceptance anchor missing or ambiguous")
document_path.write_text(
    document.replace(acceptance_anchor, acceptance_replacement),
    encoding="utf-8",
)
