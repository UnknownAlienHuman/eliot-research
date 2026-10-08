/** Branch cleanup is based on integration evidence, never count or age. */
export function validateBranchName(name) {
  if (typeof name !== "string" || name.length === 0 || name === "@" ||
      /[\s\x00-\x1f\x7f~^:?*[\\]/u.test(name) ||
      name.includes("..") || name.includes("@{") || name.endsWith(".") ||
      name.split("/").some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".lock"))) {
    throw new Error("invalid branch name");
  }
  return name;
}

export function validateBranchSha(sha) {
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/u.test(sha)) {
    throw new Error("branch commit SHA is required");
  }
  return sha;
}

export function validateBranchHygieneConfig(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("branch hygiene config must be an object");
  }
  const allowed = new Set(["protocol", "default_branch", "preserve_open_pull_requests"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`unknown branch hygiene field: ${key}`);
  }
  if (raw.protocol !== "eliotr.branch-hygiene.v2") {
    throw new Error("unsupported branch hygiene protocol");
  }
  validateBranchName(raw.default_branch);
  if (raw.preserve_open_pull_requests !== true) {
    throw new Error("open pull requests must be preserved");
  }
  return Object.freeze({
    protocol: raw.protocol,
    default_branch: raw.default_branch,
    preserve_open_pull_requests: true,
  });
}

export function classifyBranch(branch, { config, openPrHeads }) {
  validateBranchName(branch?.name);
  validateBranchSha(branch.sha);
  // Missing protection metadata cannot authorize cleanup.
  if (typeof branch.protected !== "boolean") throw new Error("branch protection state is required");
  if (branch.name === config.default_branch) return { action: "PRESERVE", reason: "DEFAULT_BRANCH" };
  if (branch.protected) return { action: "PRESERVE", reason: "PROTECTED_BRANCH" };
  if (openPrHeads.has(branch.name)) return { action: "PRESERVE", reason: "OPEN_PULL_REQUEST" };
  return branch.integrated === true
    ? { action: "DELETE", reason: "EXACT_HEAD_IN_DEFAULT_BRANCH" }
    : { action: "PRESERVE", reason: "INTEGRATION_NOT_PROVEN" };
}

export function planBranchCleanup({ branches, open_pr_heads, config: rawConfig }) {
  const config = validateBranchHygieneConfig(rawConfig);
  if (!Array.isArray(branches)) throw new Error("branches must be an array");
  if (!Array.isArray(open_pr_heads)) throw new Error("open_pr_heads must be an array");
  const openPrHeads = new Set(open_pr_heads.map(validateBranchName));
  const seen = new Set();
  const decisions = branches.map((branch) => {
    const decision = classifyBranch(branch, { config, openPrHeads });
    if (seen.has(branch.name)) throw new Error(`duplicate branch: ${branch.name}`);
    seen.add(branch.name);
    return Object.freeze({ name: branch.name, sha: branch.sha, ...decision });
  });
  if (!seen.has(config.default_branch)) throw new Error("default branch is absent");
  return Object.freeze({
    config,
    decisions: Object.freeze(decisions),
    delete: Object.freeze(decisions.filter((item) => item.action === "DELETE")),
    preserve: Object.freeze(decisions.filter((item) => item.action === "PRESERVE")),
  });
}
