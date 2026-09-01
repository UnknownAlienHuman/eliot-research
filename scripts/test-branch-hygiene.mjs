import assert from "node:assert/strict";
import { planBranchCleanup, validateBranchHygieneConfig } from "./branch-hygiene-lib.mjs";

const config = validateBranchHygieneConfig({
  protocol: "eliotr.branch-hygiene.v1",
  default_branch: "main",
  max_non_default_branches: 5,
  ttl_hours: 24,
  bootstrap_delete_before: "2026-09-02T00:00:00.000Z",
  preserve_open_pull_requests: true,
});
const now = Date.parse("2026-09-03T12:00:00.000Z");

const plan = planBranchCleanup({
  now_ms: now,
  config,
  open_pr_heads: ["agent/open-pr"],
  branches: [
    { name: "main", updated_at: "2026-09-03T11:00:00.000Z" },
    { name: "agent/open-pr", updated_at: "2026-08-01T00:00:00.000Z" },
    { name: "agent/legacy", updated_at: "2026-09-01T07:00:00.000Z" },
    { name: "agent/stale", updated_at: "2026-09-02T08:00:00.000Z" },
    { name: "agent/recent", updated_at: "2026-09-03T08:00:00.000Z" },
  ],
});

assert.deepEqual(
  plan.delete.map((item) => [item.name, item.reason]),
  [
    ["agent/legacy", "PRE_CONTRACT_LEGACY_BRANCH"],
    ["agent/stale", "TTL_EXPIRED_WITHOUT_OPEN_PR"],
  ],
);
assert.deepEqual(
  plan.preserve.map((item) => [item.name, item.reason]),
  [
    ["main", "DEFAULT_BRANCH"],
    ["agent/open-pr", "OPEN_PULL_REQUEST"],
    ["agent/recent", "RECENT_UNMERGED_BRANCH"],
  ],
);

assert.throws(
  () => planBranchCleanup({
    now_ms: now,
    config: { ...config, max_non_default_branches: 1 },
    open_pr_heads: ["agent/a", "agent/b"],
    branches: [
      { name: "main", updated_at: "2026-09-03T11:00:00.000Z" },
      { name: "agent/a", updated_at: "2026-09-03T11:00:00.000Z" },
      { name: "agent/b", updated_at: "2026-09-03T11:00:00.000Z" },
    ],
  }),
  /branch ceiling exceeded/u,
);

assert.throws(
  () => validateBranchHygieneConfig({ ...config, unexpected: true }),
  /unknown branch hygiene field/u,
);

console.log("branch hygiene deterministic fixtures: PASS");
