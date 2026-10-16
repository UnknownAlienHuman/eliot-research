import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertOwnerWebNativeRoutes, readOwnerWebNativeSourceIdentity } from "./lib/deployment-owner-web-native.mjs";

const temporaryRoot = path.resolve(tmpdir());
const fixturePrefix = "eliotr-native-source-";
async function replaceMetadata(filename, bytes) {
  // Git marks .git files hidden on Windows; opening them with "w" fails.
  const handle = await open(filename, "r+");
  try { await handle.truncate(0); await handle.writeFile(bytes); }
  finally { await handle.close(); }
}

function git(root, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" });
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-C", root, ...args],
  { env, shell: false, windowsHide: true, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(run) {
  const directory = await mkdtemp(path.join(temporaryRoot, fixturePrefix));
  const base = path.join(directory, "base"), release = path.join(directory, "release # Ü");
  try {
    await mkdir(base);
    await writeFile(path.join(base, ".gitignore"), ".eliotr-state/\ndist/\n");
    await writeFile(path.join(base, "source.txt"), "committed release bytes\n");
    git(base, "init", "--quiet", "--initial-branch=main");
    git(base, "add", "--all");
    git(base, "commit", "--quiet", "-m", "fixture source");
    const head = git(base, "rev-parse", "HEAD");
    git(base, "worktree", "add", "--quiet", "--detach", release, head);
    const gitDirectory = path.resolve(git(release, "rev-parse", "--absolute-git-dir"));
    await run({ directory, base, release, head, gitDirectory, commonDirectory: path.join(base, ".git") });
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert(path.basename(directory).startsWith(fixturePrefix));
    await rm(directory, { recursive: true, force: true });
  }
}

test("accepts an independent clean checkout with loose and packed branch refs", async () => {
  await fixture(async ({ base, head, commonDirectory }) => {
    assert.equal((await readOwnerWebNativeSourceIdentity(base)).source_head, head);
    git(base, "pack-refs", "--all");
    const identity = await readOwnerWebNativeSourceIdentity(base);
    assert.equal(identity.source_head, head);
    assert.equal(identity.git_directory, commonDirectory);
    assert.equal(identity.common_directory, commonDirectory);
  });
});

test("pins the linked checkout's commit despite a newer dirty base and poisoned ambient Git routing", async () => {
  await fixture(async ({ base, release, head, gitDirectory, commonDirectory }) => {
    await writeFile(path.join(base, "source.txt"), "different committed base bytes\n");
    git(base, "commit", "--quiet", "-am", "base descendant");
    assert.notEqual(git(base, "rev-parse", "HEAD"), head);
    await writeFile(path.join(base, "source.txt"), "protected dirty base bytes\n");
    await writeFile(path.join(base, "base-only.txt"), "must never enter release capture\n");
    const poison = { GIT_DIR: commonDirectory, GIT_WORK_TREE: base, GIT_COMMON_DIR: commonDirectory,
      GIT_INDEX_FILE: path.join(commonDirectory, "index"), GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: base };
    const prior = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, poison);
      const identity = await readOwnerWebNativeSourceIdentity(release);
      assert.equal(identity.root, release);
      assert.equal(identity.git_directory, gitDirectory);
      assert.equal(identity.common_directory, commonDirectory);
      assert.equal(identity.source_head, head);
      await assert.rejects(readOwnerWebNativeSourceIdentity(base), /DIRTY_SOURCE_WORKTREE/u);
      assert.equal(await readFile(path.join(release, "source.txt"), "utf8"), "committed release bytes\n");
      assert.equal(await readFile(path.join(base, "source.txt"), "utf8"), "protected dirty base bytes\n");
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test("rejects unstaged, staged and untracked files in the selected worktree", async () => {
  await fixture(async ({ release }) => {
    const source = path.join(release, "source.txt"), untracked = path.join(release, "untracked.txt");
    await writeFile(source, "dirty release\n");
    await assert.rejects(readOwnerWebNativeSourceIdentity(release), /DIRTY_SOURCE_WORKTREE/u);
    git(release, "add", "source.txt");
    await assert.rejects(readOwnerWebNativeSourceIdentity(release), /DIRTY_SOURCE_WORKTREE/u);
    git(release, "restore", "--source=HEAD", "--staged", "--worktree", "--", "source.txt");
    await writeFile(untracked, "uncommitted source\n");
    await assert.rejects(readOwnerWebNativeSourceIdentity(release), /DIRTY_SOURCE_WORKTREE/u);
    await unlink(untracked);
    await mkdir(path.join(release, "dist"));
    await writeFile(path.join(release, "dist", "prepared.js"), "ignored prepared output\n");
    assert.equal((await readOwnerWebNativeSourceIdentity(release)).source_head, git(release, "rev-parse", "HEAD"));
  });
});

test("rejects index flags that can hide modified tracked source", async () => {
  await fixture(async ({ release }) => {
    git(release, "update-index", "--assume-unchanged", "source.txt");
    await assert.rejects(readOwnerWebNativeSourceIdentity(release), /SOURCE_INDEX_FLAGS_UNSUPPORTED/u);
    git(release, "update-index", "--no-assume-unchanged", "source.txt");
    git(release, "update-index", "--skip-worktree", "source.txt");
    await writeFile(path.join(release, "source.txt"), "hidden dirty bytes\n");
    await assert.rejects(readOwnerWebNativeSourceIdentity(release), /SOURCE_INDEX_FLAGS_UNSUPPORTED/u);
  });
});

test("rejects forged worktree pointers, wrong common directories and wrong reciprocal registration", async () => {
  await fixture(async ({ base, release, gitDirectory, commonDirectory }) => {
    const pointer = path.join(release, ".git"), original = await readFile(pointer);
    await replaceMetadata(pointer, "gitdir: " + commonDirectory + "\n");
    await assert.rejects(readOwnerWebNativeSourceIdentity(release));
    await replaceMetadata(pointer, original);
    const common = path.join(gitDirectory, "commondir"), commonBytes = await readFile(common);
    await replaceMetadata(common, "../../..\n");
    await assert.rejects(readOwnerWebNativeSourceIdentity(release), /INVALID_SOURCE_WORKTREE_LAYOUT/u);
    await replaceMetadata(common, commonBytes);
    const backlink = path.join(gitDirectory, "gitdir"), backlinkBytes = await readFile(backlink);
    await replaceMetadata(backlink, path.join(base, ".git") + "\n");
    await assert.rejects(readOwnerWebNativeSourceIdentity(release), /SOURCE_WORKTREE_BACKLINK_MISMATCH/u);
    await replaceMetadata(backlink, backlinkBytes);
    await replaceMetadata(path.join(gitDirectory, "HEAD"), "0".repeat(40) + "\n");
    await assert.rejects(readOwnerWebNativeSourceIdentity(release), /SOURCE_GIT_READ_FAILED/u);
  });
});

test("rejects repository configuration that redirects Git to a different source root", async () => {
  await fixture(async ({ base, release }) => {
    git(base, "config", "core.worktree", release);
    await assert.rejects(readOwnerWebNativeSourceIdentity(base), /SOURCE_WORKTREE_IDENTITY_MISMATCH/u);
  });
});

test("refuses parent discovery and redirected source roots", async t => {
  await fixture(async ({ directory, base, release }) => {
    const subdirectory = path.join(base, "nested");
    await mkdir(subdirectory);
    await assert.rejects(readOwnerWebNativeSourceIdentity(subdirectory), /SOURCE_GIT_ENTRY_REQUIRED/u);
    const alias = path.join(directory, "redirected-release");
    try { await symlink(release, alias, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") { t.skip("directory link creation unavailable"); return; }
      throw error;
    }
    await assert.rejects(readOwnerWebNativeSourceIdentity(alias), /SOURCE_ROOT_REDIRECTED/u);
  });
});

test("native capture rejects dirty source before reading prepared artifacts or starting a process", async () => {
  await fixture(async ({ release }) => {
    await writeFile(path.join(release, "source.txt"), "dirty source\n");
    let failure;
    try { await assertOwnerWebNativeRoutes({ root: release, environment: {} }); }
    catch (error) { failure = error; }
    assert.match(failure?.message ?? "", /DIRTY_SOURCE_WORKTREE/u);
    const receipt = JSON.parse(await readFile(path.join(release, failure.evidence.path), "utf8"));
    assert.equal(receipt.source_head, null);
    assert.equal(receipt.process.pid, null);
    assert.deepEqual(receipt.process.argv, []);
    assert.deepEqual(receipt.pins, {});
  });
});
