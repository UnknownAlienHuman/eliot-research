const HOUR_MS = 60 * 60 * 1000;

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
    "reserved_open_pr_heads",
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
  const reserved = raw.reserved_open_pr_heads ?? [];
  const reservedSet = branchNameSet(reserved, "reserved_open_pr_heads");
  if (reserved.length > 9 || reservedSet.size !== reserved.length ||
      reserved.some((name) => name === raw.default_branch ||
        !/^agent\/launch-[0-9]{2}-[a-z-]+-20260905$/u.test(name))) {
    throw new Error("reserved_open_pr_heads must name at most nine unique launch PR branches");
  }
  return Object.freeze({
    reserved_open_pr_heads: Object.freeze([...reserved]),
    protocol: raw.protocol,
    default_branch: raw.default_branch,
    max_non_default_branches: raw.max_non_default_branches,
    ttl_hours: raw.ttl_hours,
    bootstrap_delete_before: raw.bootstrap_delete_before,
    preserve_open_pull_requests: true,
  });
}

/** Exact owner-approved planning reservations count only while their PR is open. */
export function branchCeiling(branchNames, openPrHeads, rawConfig) {
  const config = validateBranchHygieneConfig(rawConfig);
  const open = branchNameSet(openPrHeads, "open_pr_heads");
  const reserved = new Set(config.reserved_open_pr_heads);
  const nonDefault = [...branchNameSet(branchNames, "branches")].filter((name) => name !== config.default_branch);
  const exempt = nonDefault.filter((name) => reserved.has(name) && open.has(name));
  const counted = nonDefault.length - exempt.length;
  return { total: nonDefault.length, reserved: exempt.length, counted,
    satisfied: counted <= config.max_non_default_branches };
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
    config.max_non_default_branches - branchCeiling(
      fixedNonDefault.map((item) => item.name), [...openPrHeads], config,
    ).counted,
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

  const ceiling = branchCeiling(preserveItems.map((item) => item.name), [...openPrHeads], config);
  return Object.freeze({
    config,
    decisions: Object.freeze(decisions),
    delete: Object.freeze(deleteItems),
    preserve: Object.freeze(preserveItems),
    projected_non_default_branches: projectedNonDefault,
    reserved_open_pr_branches: ceiling.reserved,
    counted_non_default_branches: ceiling.counted,
    ceiling_satisfied: ceiling.satisfied,
  });
}
