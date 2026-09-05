import assert from "node:assert/strict";
import {
  planBranchCleanup,
  branchCeiling,
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

const reserved = Array.from({ length: 9 }, (_, i) => `agent/launch-${String(i + 1).padStart(2, "0")}-topic-20260905`);
const reservedConfig = { ...config, max_non_default_branches: 5, reserved_open_pr_heads: reserved };
assert.deepEqual(branchCeiling(["main", ...reserved, "agent/ordinary"], reserved, reservedConfig),
  { total: 10, reserved: 9, counted: 1, satisfied: true });
assert.equal(branchCeiling(["main", ...reserved], [], reservedConfig).satisfied, false);
assert.equal(branchCeiling(["main", ...reserved, ...Array.from({ length: 6 }, (_, i) => `agent/extra-${i}`)],
  reserved, reservedConfig).satisfied, false);
const planned = planBranchCleanup({ now_ms: now, config: reservedConfig,
  open_pr_heads: reserved, closed_pr_heads: [], branches: [
    branch("main", "2026-09-03T11:00:00.000Z", "main"),
    ...reserved.map((name) => branch(name, "2026-08-01T00:00:00.000Z", name)),
    ...Array.from({ length: 6 }, (_, i) => branch(`agent/new-${i}`, "2026-09-03T10:00:00.000Z", `new-${i}`)),
  ] });
assert.equal(planned.reserved_open_pr_branches, 9);
assert.equal(planned.counted_non_default_branches, 5);
assert.equal(planned.delete.length, 1);
assert.equal(planned.ceiling_satisfied, true);
const closedReservation = planBranchCleanup({ now_ms: now, config: reservedConfig,
  open_pr_heads: [], closed_pr_heads: [reserved[0]], branches: [
    branch("main", "2026-09-03T11:00:00.000Z", "main"),
    branch(reserved[0], "2026-09-03T11:00:00.000Z", "closed"),
  ] });
assert.equal(closedReservation.delete[0].reason, "CLOSED_PULL_REQUEST");
assert.throws(() => validateBranchHygieneConfig({ ...reservedConfig, reserved_open_pr_heads: [reserved[0], reserved[0]] }));
assert.throws(() => validateBranchHygieneConfig({ ...reservedConfig, reserved_open_pr_heads: ["main"] }));
assert.throws(() => validateBranchHygieneConfig({ ...reservedConfig, reserved_open_pr_heads: ["agent/*"] }));
assert.throws(() => validateBranchHygieneConfig({ ...reservedConfig, reserved_open_pr_heads: [...reserved, "agent/launch-10-extra-20260905"] }));
console.log("Bounded launch-PR reservations: PASS (open-only; normal quota, TTL and closed cleanup unchanged)");
