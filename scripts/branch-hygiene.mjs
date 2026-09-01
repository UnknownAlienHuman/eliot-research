import { readFile, appendFile } from "node:fs/promises";
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
  await readFile(new URL("../infra/github/branch-hygiene.json", import.meta.url), "utf8"),
);

async function api(path, init = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "eliotr-branch-hygiene",
      ...init.headers,
    },
  });
  if (response.status === 204) return null;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API ${init.method ?? "GET"} ${path} failed: ${response.status} ${text.slice(0, 512)}`);
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

const [branchRows, pullRequests] = await Promise.all([
  paged(`/repos/${repository}/branches`),
  paged(`/repos/${repository}/pulls?state=open`),
]);

const openPrHeads = pullRequests.map((pr) => pr?.head?.ref).filter((value) => typeof value === "string");

async function branchRecord(row) {
  const name = row?.name;
  const sha = row?.commit?.sha;
  if (typeof name !== "string" || typeof sha !== "string") {
    throw new Error("malformed branch list response");
  }
  const commit = await api(`/repos/${repository}/commits/${sha}`);
  const updatedAt = commit?.commit?.committer?.date ?? commit?.commit?.author?.date;
  if (typeof updatedAt !== "string") throw new Error(`branch ${name} commit has no timestamp`);
  return { name, updated_at: updatedAt, sha };
}

const branches = [];
for (let index = 0; index < branchRows.length; index += 8) {
  branches.push(...await Promise.all(branchRows.slice(index, index + 8).map(branchRecord)));
}

const plan = planBranchCleanup({
  branches,
  open_pr_heads: openPrHeads,
  now_ms: Date.now(),
  config,
});

for (const item of plan.delete) {
  const encoded = encodeURIComponent(item.name);
  await api(`/repos/${repository}/git/refs/heads/${encoded}`, { method: "DELETE" });
  console.log(`deleted ${item.name}: ${item.reason}`);
}

const remainingRows = await paged(`/repos/${repository}/branches`);
const remaining = remainingRows.map((row) => row?.name).filter((value) => typeof value === "string").sort();

if (!remaining.includes(config.default_branch)) {
  throw new Error("default branch disappeared during cleanup");
}
const nonDefault = remaining.filter((name) => name !== config.default_branch);
if (nonDefault.length > config.max_non_default_branches) {
  throw new Error(`branch ceiling still exceeded: ${nonDefault.length}`);
}

const summary = [
  "# Eliot Research branch hygiene",
  "",
  `- repository: \`${repository}\``,
  `- deleted: **${plan.delete.length}**`,
  `- remaining non-default branches: **${nonDefault.length}**`,
  `- ceiling: **${config.max_non_default_branches}**`,
  "",
  "## Deleted branches",
  "",
  ...(plan.delete.length === 0
    ? ["None."]
    : plan.delete.map((item) => `- \`${item.name}\` — ${item.reason}`)),
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
