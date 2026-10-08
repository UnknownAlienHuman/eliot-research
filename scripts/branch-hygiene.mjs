import { readFile, appendFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  classifyBranch,
  planBranchCleanup,
  validateBranchHygieneConfig,
  validateBranchName,
  validateBranchSha,
} from "./branch-hygiene-lib.mjs";

const exec = promisify(execFile);

export function conditionalDeleteArguments(name, sha) {
  validateBranchName(name);
  validateBranchSha(sha);
  const ref = `refs/heads/${name}`;
  // REST DELETE has no expected-head precondition. This exact lease guards a
  // single deletion; it does not force-update main or rewrite branch history.
  return ["-c", "push.followTags=false", "-c", "remote.origin.mirror=false", "push",
    "--porcelain", `--force-with-lease=${ref}:${sha}`, "origin", `:${ref}`];
}

/** Read-only API observations and conditional deletion are injected for tests. */
export async function runBranchHygiene({ repository, config: rawConfig, api, deleteBranch }) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/repository");
  }
  const config = validateBranchHygieneConfig(rawConfig);
  const root = `/repos/${repository}`;
  async function paged(path) {
    const result = [];
    for (let page = 1; ; page += 1) {
      const batch = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error("malformed GitHub list response");
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  }
  async function defaultBranch() {
    const metadata = await api(root);
    if (metadata?.default_branch !== config.default_branch) {
      throw new Error("configured default branch differs from repository");
    }
    const branch = await readBranch(config.default_branch);
    if (branch === null) throw new Error("default branch is absent");
    return branch;
  }
  async function openHeads() {
    const pulls = await paged(`${root}/pulls?state=open`);
    const heads = new Set();
    for (const pull of pulls) {
      if (pull?.state !== "open" || typeof pull?.head?.repo?.full_name !== "string") {
        throw new Error("malformed open pull request response");
      }
      if (pull.head.repo.full_name === repository) heads.add(validateBranchName(pull.head.ref));
    }
    return heads;
  }
  function decodeBranch(row) {
    const name = validateBranchName(row?.name);
    const sha = validateBranchSha(row?.commit?.sha);
    if (typeof row?.protected !== "boolean") throw new Error("branch protection state is required");
    return { name, sha, protected: row.protected };
  }
  async function readBranch(name) {
    const row = await api(`${root}/branches/${encodeURIComponent(name)}`, { ignore_not_found: true });
    if (row === null) return null;
    const branch = decodeBranch(row);
    if (branch.name !== name) throw new Error("branch readback identity mismatch");
    return branch;
  }
  async function isIntegrated(sha, mainSha) {
    const comparison = await api(`${root}/compare/${sha}...${mainSha}`);
    if (comparison?.base_commit?.sha !== sha ||
        !["ahead", "behind", "diverged", "identical"].includes(comparison?.status) ||
        !Number.isSafeInteger(comparison?.behind_by) || comparison.behind_by < 0 ||
        typeof comparison?.merge_base_commit?.sha !== "string") {
      throw new Error("malformed exact-head integration evidence");
    }
    return ["ahead", "identical"].includes(comparison.status) && comparison.behind_by === 0 &&
      comparison.merge_base_commit.sha === sha;
  }
  const main = await defaultBranch();
  const open = await openHeads();
  const branches = (await paged(`${root}/branches`)).map(decodeBranch);
  for (const branch of branches) {
    if (branch.name !== config.default_branch && !branch.protected && !open.has(branch.name)) {
      branch.integrated = await isIntegrated(branch.sha, main.sha);
    }
  }
  const plan = planBranchCleanup({ config, branches, open_pr_heads: [...open] });
  const deleted = [], skipped = [], alreadyAbsent = [];
  for (const item of plan.delete) {
    const latestMain = await defaultBranch();
    const latest = await readBranch(item.name);
    if (latest === null) { alreadyAbsent.push(item); continue; }
    if (latest.sha !== item.sha) {
      skipped.push({ ...item, skip_reason: "BRANCH_CHANGED_AFTER_PLAN" }); continue;
    }
    if (latest.protected) {
      skipped.push({ ...item, skip_reason: "PROTECTED_BRANCH" }); continue;
    }
    const integrated = await isIntegrated(item.sha, latestMain.sha);
    // Read again after the comparison await; the deletion lease additionally
    // rejects a head change after these observations at the Git server.
    const settled = await readBranch(item.name);
    if (settled === null) { alreadyAbsent.push(item); continue; }
    if (settled.sha !== item.sha) {
      skipped.push({ ...item, skip_reason: "BRANCH_CHANGED_AFTER_RECHECK" }); continue;
    }
    const decision = classifyBranch({ ...settled, integrated }, { config, openPrHeads: await openHeads() });
    if (decision.action !== "DELETE") {
      skipped.push({ ...item, skip_reason: decision.reason }); continue;
    }
    await deleteBranch(item.name, item.sha);
    const readback = await readBranch(item.name);
    if (readback !== null) throw new Error("branch deletion not confirmed; do not retry without a new plan");
    deleted.push(item);
  }
  await defaultBranch();
  const remaining = (await paged(`${root}/branches`)).map(decodeBranch).map((row) => row.name).sort();
  if (!remaining.includes(config.default_branch)) throw new Error("default branch disappeared during cleanup");
  return { plan, deleted, skipped, alreadyAbsent, remaining };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com";
  if (typeof token !== "string" || token.length < 20) throw new Error("GITHUB_TOKEN is missing");
  const config = JSON.parse(await readFile(new URL("../infra/github/branch-hygiene.json", import.meta.url), "utf8"));
  async function api(path, { ignore_not_found: ignoreNotFound = false } = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28", "user-agent": "eliotr-branch-hygiene" },
    });
    if (response.status === 404 && ignoreNotFound) return null;
    if (!response.ok) throw new Error(`GitHub observation failed: HTTP ${response.status}`);
    return response.json();
  }
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const { stdout: origin } = await exec("git", ["remote", "get-url", "--push", "origin"]);
  if (![`${server}/${repository}`, `${server}/${repository}.git`].includes(origin.trim())) {
    throw new Error("cleanup push remote does not match the observed repository");
  }
  const result = await runBranchHygiene({ repository, config, api,
    async deleteBranch(name, sha) {
      try { await exec("git", conditionalDeleteArguments(name, sha)); }
      catch { throw new Error("conditional branch deletion failed; re-observe before retrying"); }
    },
  });
  const summary = ["# Eliot Research branch hygiene", "",
    `- planned integrated heads: **${result.plan.delete.length}**`,
    `- confirmed deleted: **${result.deleted.length}**`,
    `- already absent: **${result.alreadyAbsent.length}**`,
    `- skipped after recheck: **${result.skipped.length}**`,
    `- remaining non-default branches: **${result.remaining.length - 1}**`, "",
    "No branch-count or age limit applies. Unproven integration is preserved.", "",
    "## Confirmed deletions", "",
    ...result.deleted.map((item) => `- \`${item.name}\` at \`${item.sha}\``), "",
    "## Skipped after recheck", "",
    ...result.skipped.map((item) => `- \`${item.name}\` — ${item.skip_reason}`), "",
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  console.log(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
