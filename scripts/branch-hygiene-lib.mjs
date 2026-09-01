const HOUR_MS = 60 * 60 * 1000;

function parseTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return timestamp;
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
  if (branch.name === context.config.default_branch) {
    return { action: "PRESERVE", reason: "DEFAULT_BRANCH" };
  }
  if (context.openPrHeads.has(branch.name)) {
    return { action: "PRESERVE", reason: "OPEN_PULL_REQUEST" };
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

export function planBranchCleanup({ branches, open_pr_heads, now_ms, config: rawConfig }) {
  const config = validateBranchHygieneConfig(rawConfig);
  if (!Array.isArray(branches)) throw new Error("branches must be an array");
  if (!Array.isArray(open_pr_heads)) throw new Error("open_pr_heads must be an array");
  const openPrHeads = new Set(open_pr_heads);
  const seen = new Set();
  const decisions = [];

  for (const branch of branches) {
    if (seen.has(branch.name)) throw new Error(`duplicate branch: ${branch.name}`);
    seen.add(branch.name);
    decisions.push({
      name: branch.name,
      updated_at: branch.updated_at,
      ...classifyBranch(branch, { config, openPrHeads, now_ms }),
    });
  }

  if (!seen.has(config.default_branch)) {
    throw new Error(`default branch ${config.default_branch} is absent`);
  }
  const remaining = decisions.filter((item) => item.action === "PRESERVE" && item.name !== config.default_branch);
  if (remaining.length > config.max_non_default_branches) {
    throw new Error(
      `branch ceiling exceeded after cleanup: ${remaining.length} > ${config.max_non_default_branches}`,
    );
  }

  return Object.freeze({
    config,
    decisions: Object.freeze(decisions),
    delete: Object.freeze(decisions.filter((item) => item.action === "DELETE")),
    preserve: Object.freeze(decisions.filter((item) => item.action === "PRESERVE")),
  });
}
