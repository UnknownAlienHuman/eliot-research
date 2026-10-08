import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { planBranchCleanup, validateBranchHygieneConfig } from "./branch-hygiene-lib.mjs";
import { conditionalDeleteArguments, runBranchHygiene } from "./branch-hygiene.mjs";

const config = { protocol: "eliotr.branch-hygiene.v2", default_branch: "main", preserve_open_pull_requests: true };
const sha = (value) => value.repeat(40);
const row = (name, value, extra = {}) => ({ name, sha: sha(value), protected: false, ...extra });
const main = row("main", "a");
const repository = "example/research";

function fixture({ mutate = () => {}, unmerged = false, protectedBranch = false, initialOpen = false } = {}) {
  const records = new Map([["main", { ...main }], ["agent/done", row("agent/done", "b", { protected: protectedBranch })]]);
  const pull = { state: "open", head: { ref: "agent/done", repo: { full_name: repository } } };
  const state = { records, pulls: initialOpen ? [pull] : [], pull, mainSha: main.sha, integrated: !unmerged,
    deletes: [], requests: [], comparisons: 0, branchReads: 0, openReads: 0, defaultName: "main" };
  const wire = (branch) => ({ name: branch.name, commit: { sha: branch.sha }, protected: branch.protected });
  const api = async (path) => {
    const url = new URL(path, "https://github.test");
    state.requests.push(path);
    if (url.pathname.includes("/compare/")) state.comparisons++;
    if (url.pathname.endsWith("/branches/agent%2Fdone")) state.branchReads++;
    if (url.pathname.endsWith("/pulls")) state.openReads++;
    mutate(state, url);
    if (url.pathname === `/repos/${repository}`) return { default_branch: state.defaultName };
    if (url.pathname.endsWith("/branches")) return [...records.values()].map(wire);
    if (url.pathname.includes("/branches/")) {
      const record = records.get(decodeURIComponent(url.pathname.split("/branches/")[1]));
      return record ? wire(record) : null;
    }
    if (url.pathname.endsWith("/pulls")) return state.pulls;
    if (url.pathname.includes("/compare/")) {
      const base = url.pathname.split("/compare/")[1].split("...")[0];
      return { base_commit: { sha: base }, status: state.integrated ? "ahead" : "diverged",
        merge_base_commit: { sha: state.integrated ? base : sha("d") }, behind_by: state.integrated ? 0 : 1 };
    }
    throw new Error(`unexpected fixture request ${path}`);
  };
  const deleteBranch = async (name, expected) => {
    assert.equal(records.get(name)?.sha, expected, "conditional deletion must reject a changed remote head");
    state.deletes.push([name, expected]); records.delete(name);
  };
  return { state, api, deleteBranch, run: () => runBranchHygiene({ repository, config, api, deleteBranch }) };
}

test("no count, timestamp, or closed PR can authorize removal of unintegrated work", () => {
  const branches = [main, ...Array.from({ length: 110 }, (_, index) => row(`agent/task-${index}`, "b", {
    integrated: false, updated_at: "2000-01-01T00:00:00Z",
  }))];
  const plan = planBranchCleanup({ config, branches, open_pr_heads: branches.slice(1, 100).map((item) => item.name),
    closed_pr_heads: ["agent/task-109"] });
  assert.equal(plan.delete.length, 0);
  assert.equal(plan.preserve.length, 111);
  assert.equal(plan.preserve.at(-1).reason, "INTEGRATION_NOT_PROVEN");
});

test("default, protected, open PR and unknown integration remain protected", () => {
  const plan = planBranchCleanup({ config, open_pr_heads: ["agent/open"], branches: [
    main, row("agent/protected", "b", { protected: true, integrated: true }),
    row("agent/open", "c", { integrated: true }), row("agent/unknown", "d"),
    row("agent/integrated", "e", { integrated: true }),
  ] });
  assert.deepEqual(plan.delete.map((item) => item.name), ["agent/integrated"]);
  assert.deepEqual(plan.preserve.map((item) => item.reason),
    ["DEFAULT_BRANCH", "PROTECTED_BRANCH", "OPEN_PULL_REQUEST", "INTEGRATION_NOT_PROVEN"]);
});

test("config rejects legacy eviction fields instead of silently applying them", () => {
  for (const field of ["max_non_default_branches", "ttl_hours", "bootstrap_delete_before", "reserved_open_pr_heads", "unexpected"]) {
    assert.throws(() => validateBranchHygieneConfig({ ...config, [field]: 5 }), /unknown branch hygiene field/u);
  }
  assert.throws(() => validateBranchHygieneConfig({ ...config, protocol: "eliotr.branch-hygiene.v1" }));
  assert.throws(() => validateBranchHygieneConfig({ ...config, preserve_open_pull_requests: false }));
});

test("malformed, duplicate, missing-default and missing-protection inputs fail closed", () => {
  const plan = (branches, open_pr_heads = []) => planBranchCleanup({ config, branches, open_pr_heads });
  assert.throws(() => plan([main, main]), /duplicate/u);
  assert.throws(() => plan([]), /default branch/u);
  assert.throws(() => plan([main], [null]), /invalid branch/u);
  assert.throws(() => plan([main, { ...row("agent/x", "b"), protected: undefined }]), /protection/u);
  for (const name of ["", "../main", "main.lock", "a@{b", "a//b", "a:b", "a\nb", "a\\b"]) {
    assert.throws(() => conditionalDeleteArguments(name, sha("a")), /invalid branch/u);
  }
  assert.throws(() => conditionalDeleteArguments("agent/x", "not-a-sha"), /SHA/u);
});

test("runner deletes only exact integrated head, then verifies absence", async () => {
  const f = fixture(); const result = await f.run();
  assert.deepEqual(f.state.deletes, [["agent/done", sha("b")]]);
  assert.equal(result.deleted.length, 1);
  assert.deepEqual(result.remaining, ["main"]);
  assert.equal(f.state.comparisons, 2);
  assert.equal(f.state.branchReads, 3);
  assert.equal(f.state.openReads, 2);
});

for (const options of [{ unmerged: true }, { protectedBranch: true }, { initialOpen: true }]) {
  test(`runner preserves ${JSON.stringify(options)}`, async () => {
    const f = fixture(options); const result = await f.run();
    assert.equal(result.deleted.length, 0);
    assert.equal(f.state.deletes.length, 0);
    assert.equal(f.state.records.get("agent/done").sha, sha("b"));
  });
}

test("PR opened after planning prevents deletion", async () => {
  const f = fixture({ mutate(s, url) {
    if (url.pathname.endsWith("/pulls") && s.openReads === 2) s.pulls = [s.pull];
  } });
  const result = await f.run();
  assert.equal(result.skipped[0].skip_reason, "OPEN_PULL_REQUEST");
  assert.equal(f.state.deletes.length, 0);
});

test("changed head during integration recheck prevents deletion", async () => {
  const f = fixture({ mutate(s, url) {
    if (url.pathname.includes("/compare/") && s.comparisons === 2) s.records.get("agent/done").sha = sha("c");
  } });
  const result = await f.run();
  assert.equal(result.skipped[0].skip_reason, "BRANCH_CHANGED_AFTER_RECHECK");
  assert.equal(f.state.records.get("agent/done").sha, sha("c"));
  assert.equal(f.state.deletes.length, 0);
});

test("new protection after planning prevents deletion", async () => {
  const f = fixture({ mutate(s, url) {
    if (url.pathname.includes("/branches/agent") && s.branchReads === 1) s.records.get("agent/done").protected = true;
  } });
  assert.equal((await f.run()).skipped[0].skip_reason, "PROTECTED_BRANCH");
  assert.equal(f.state.deletes.length, 0);
});

test("changed default or removed integration proof cannot delete", async () => {
  const f = fixture({ mutate(s, url) {
    if (url.pathname.includes("/compare/") && s.comparisons === 2) s.integrated = false;
  } });
  assert.equal((await f.run()).skipped[0].skip_reason, "INTEGRATION_NOT_PROVEN");
  assert.equal(f.state.deletes.length, 0);
  const changed = fixture({ mutate(s) { s.defaultName = "release"; } });
  await assert.rejects(changed.run(), /default branch/u);
  assert.equal(changed.state.deletes.length, 0);
});

test("absent candidate is not deleted again", async () => {
  const f = fixture({ mutate(s, url) {
    if (url.pathname.includes("/branches/agent") && s.branchReads === 1) s.records.delete("agent/done");
  } });
  assert.equal((await f.run()).alreadyAbsent.length, 1);
  assert.equal(f.state.deletes.length, 0);
});

test("malformed observation fails before any deletion and omits provider payload", async () => {
  const f = fixture();
  await assert.rejects(runBranchHygiene({ repository, config, deleteBranch: f.deleteBranch,
    api: async (path) => path.includes("/compare/") ? { base_commit: { sha: sha("e") } } : f.api(path),
  }), /malformed exact-head integration evidence/u);
  assert.equal(f.state.deletes.length, 0);
});

test("all PR pages are read, foreign fork names do not create local protection", async () => {
  const f = fixture();
  const foreign = { state: "open", head: { ref: "agent/done", repo: { full_name: "other/research" } } };
  const result = await runBranchHygiene({ repository, config, deleteBranch: f.deleteBranch,
    api: async (path) => {
      if (!path.includes("/pulls?")) return f.api(path);
      const page = new URL(path, "https://github.test").searchParams.get("page");
      return page === "1" ? Array.from({ length: 100 }, () => foreign) : [f.state.pull];
    },
  });
  assert.equal(result.deleted.length, 0);
  assert.equal(f.state.deletes.length, 0);
});

test("unconfirmed deletion remains an error, never a successful receipt", async () => {
  const f = fixture();
  await assert.rejects(runBranchHygiene({ repository, config, api: f.api, deleteBranch: async () => {} }),
    /deletion not confirmed/u);
  assert.equal(f.state.records.get("agent/done").sha, sha("b"));
});

test("real Git lease rejects a remote-head race and deletes only unchanged integrated ref", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eliotr-branch-hygiene-"));
  try {
    const local = join(dir, "local"), remote = join(dir, "remote.git");
    const git = (args, cwd = dir) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init", "--bare", remote]); git(["init", "--initial-branch=main", local]);
    git(["config", "user.name", "Fixture"], local); git(["config", "user.email", "fixture@example.invalid"], local);
    git(["commit", "--allow-empty", "-m", "integrated"], local);
    const integrated = git(["rev-parse", "HEAD"], local);
    git(["remote", "add", "origin", remote], local);
    git(["push", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/agent/done"], local);
    git(["commit", "--allow-empty", "-m", "unmerged"], local);
    const advanced = git(["rev-parse", "HEAD"], local);
    git(["push", "origin", "HEAD:refs/heads/agent/done"], local);
    const rejected = spawnSync("git", conditionalDeleteArguments("agent/done", integrated), { cwd: local, encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.equal(git(["rev-parse", "refs/heads/agent/done"], remote), advanced);
    assert.equal(git(["rev-parse", "refs/heads/main"], remote), integrated);
    git(["push", "origin", `${integrated}:refs/heads/agent/integrated`], local);
    git(conditionalDeleteArguments("agent/integrated", integrated), local);
    assert.notEqual(spawnSync("git", ["rev-parse", "--verify", "refs/heads/agent/integrated"], { cwd: remote }).status, 0);
    assert.equal(git(["rev-parse", "refs/heads/agent/done"], remote), advanced);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
