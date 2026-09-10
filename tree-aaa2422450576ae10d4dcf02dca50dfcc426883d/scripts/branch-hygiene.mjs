import { readFile, appendFile } from "node:fs/promises";
import { branchCeiling, planBranchCleanup } from "./branch-hygiene-lib.mjs";

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
const finalOpenHeads = pullRequestHeads(await paged(
  `/repos/${repository}/pulls?state=open&sort=updated&direction=desc`,
), "open");
const ceiling = branchCeiling(remaining, finalOpenHeads, config);
const actualCeilingSatisfied = ceiling.satisfied;

const summary = [
  "# Eliot Research branch hygiene",
  "",
  `- repository: \`${repository}\``,
  `- planned deletions: **${plan.delete.length}**`,
  `- deleted: **${deleted.length}**`,
  `- already absent: **${alreadyAbsent.length}**`,
  `- skipped after recheck: **${skipped.length}**`,
  `- remaining non-default branches: **${nonDefault.length}**`,
  `- reserved open launch PR branches: **${ceiling.reserved}**`,
  `- counted non-default branches: **${ceiling.counted}**`,
  `- ceiling (excluding exact open reservations): **${config.max_non_default_branches}**`,
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
    `branch ceiling still exceeded: ${ceiling.counted} > ` +
    `${config.max_non_default_branches}`,
  );
}
