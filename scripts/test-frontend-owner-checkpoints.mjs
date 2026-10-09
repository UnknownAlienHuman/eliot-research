import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { checkFrontend, parseStrictJson } from "./check-frontend-owner-checkpoints.mjs";

const registryFile = "docs/agent-work/frontend-owner-checkpoints.json";
const claimFile = "docs/agent-work/frontend-owner-claims/ER-47/a.json";
const temporaryRoots = [];
let passed = 0; let failed = 0;

function test(name, run) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  try { run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}
function git(root, ...args) {
  return execFileSync("git", ["-c", "core.hooksPath=", "-C", root, ...args],
    { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function write(root, file, value) {
  const full = join(root, file); mkdirSync(resolve(full, ".."), { recursive: true });
  writeFileSync(full, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}
function commit(root, files, message = "fixture") {
  git(root, "add", "--", ...files); git(root, "commit", "--no-verify", "-m", message); return git(root, "rev-parse", "HEAD");
}
function row(id, kind, scopes, deps = []) {
  return { id, kind, packet_id: kind === "external_gate" ? "ER-00" : "ER-47", write_scopes: scopes,
    manager_only: kind !== "leaf", claim_mode: kind === "leaf" ? "single" : "none", predecessors: deps,
    required_contracts: ["fixture.md"], evidence_classes: ["fixture"], mandatory_negative_case: "fixture rejects invalid authority",
    ...(kind === "external_gate" ? { handoff_owner: "ER-00" } : {}) };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "eliotr-scheduler-")); temporaryRoots.push(root);
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Scheduler fixture");
  git(root, "config", "user.email", "scheduler@example.invalid");
  const registry = { protocol: "eliotr.frontend-owner-checkpoints.v1", checkpoints: [
    row("B-U", "external_gate", []), row("A", "leaf", ["packages/ui/src/a.ts"]),
    row("B", "leaf", ["packages/ui/src/b.ts"], ["A"]), row("D", "leaf", ["packages/ui/src/a.ts"]),
    row("G", "leaf", ["packages/ui/src/g.ts"], ["B-U"]),
    row("M", "manager_gate", ["apps/eliotr-web/package.json"]),
  ] };
  write(root, registryFile, registry);
  for (const packet of ["ER-47", "ER-48"]) write(root, `docs/agent-work/packets/${packet}.json`, {
    protocol: "eliotr.agent-work.packet.v1", packet: { id: packet, owned_paths: packet === "ER-47" ?
      ["packages/ui/**", "apps/eliotr-web/**", "tests/ui-owner/**", "docs/agent-work/frontend-owner-claims/ER-47/**"] :
      ["packages/owner-api-client/**", "docs/agent-work/frontend-owner-claims/ER-48/**"] },
  });
  const base = commit(root, [registryFile, "docs/agent-work/packets/ER-47.json", "docs/agent-work/packets/ER-48.json"]);
  const claim = { protocol: "eliotr.frontend-owner-claim.v1", claim_id: "a", checkpoint_id: "A", packet_id: "ER-47",
    manager_identity: "manager", manager_context_id: "context", leaf_identity: "leaf",
    owner_authorization_ref: "https://example.invalid/owner/1", base_sha: base, history_base_sha: base,
    write_paths: ["packages/ui/src/a.ts"], predecessor_refs: [], state: "ACTIVE", evidence_refs: [], blocker_refs: [] };
  return { root, base, registry, claim };
}
function introduce(f) { write(f.root, claimFile, f.claim); return commit(f.root, [claimFile], "prior claim"); }
function source(f, file = "packages/ui/src/a.ts") {
  write(f.root, file, `export const value = ${Date.now()};\n`); return commit(f.root, [file], "covered source");
}
function check(f, options = {}) {
  return checkFrontend({ root: f.root, historyBase: f.base, head: git(f.root, "rev-parse", "HEAD"), ...options });
}
function negative(f, code, options) { assert.throws(() => check(f, options), new RegExp(code, "u")); }
function updateClaim(f, change) {
  change(f.claim); write(f.root, claimFile, f.claim); return commit(f.root, [claimFile], "claim transition");
}
function complete(f, reason = "COMPLETED") {
  updateClaim(f, (claim) => { claim.state = "HANDED_OFF"; claim.handoff_reason = reason;
    claim.handoff_receipt_ref = "https://example.invalid/review/1";
    claim.evidence_refs.push("https://example.invalid/verification/1"); });
}

try {
  test("strict JSON rejects escaped duplicate keys", () => {
    assert.throws(() => parseStrictJson('{"a":1,"\\u0061":2}'), /DUPLICATE_JSON_KEY/u);
    assert.throws(() => parseStrictJson('{"nested":{"x":1,"x":2}}'), /DUPLICATE_JSON_KEY/u);
    assert.deepEqual(parseStrictJson('{"a":{"x":1},"b":{"x":2}}'), { a: { x: 1 }, b: { x: 2 } });
    assert.throws(() => parseStrictJson("[".repeat(65) + "]".repeat(65)), /JSON_DEPTH/u);
    assert.throws(() => parseStrictJson('"' + "x".repeat(1024 * 1024) + '"'), /JSON_LIMIT/u);
  });
  test("claim-free registry and valid prior claim/source/handoff pass", () => {
    const f = fixture(); assert.equal(checkFrontend({ root: f.root }).status, "PASS");
    introduce(f); source(f); complete(f); assert.equal(check(f).claims, 1);
    assert.equal(check(f).semantic_approval, "NOT_EVALUATED");
  });
  test("registry later generation dependency fails even without a cycle", () => {
    const f = fixture();
    f.registry.checkpoints.push(row("U1.2", "leaf", ["packages/ui/src/early.ts"], ["U2-S"]));
    f.registry.checkpoints.push(row("U2-S", "leaf", ["packages/ui/src/later.ts"]));
    write(f.root, registryFile, f.registry);
    assert.throws(() => checkFrontend({ root: f.root }), /LATER_GENERATION_DEPENDENCY/u);
  });
  const registryMutations = [
    ["unsupported protocol", "REGISTRY_PROTOCOL", (r) => { r.protocol = "future"; }],
    ["unknown load-bearing field", "UNKNOWN_FIELD", (r) => { r.override = true; }],
    ["duplicate checkpoint", "DUPLICATE_OR_BAD_CHECKPOINT", (r) => { r.checkpoints.push(r.checkpoints[1]); }],
    ["self dependency", "CHECKPOINT_CYCLE", (r) => { r.checkpoints[1].predecessors = ["A"]; }],
    ["cycle", "CHECKPOINT_CYCLE", (r) => { r.checkpoints[1].predecessors = ["B"]; }],
    ["unknown dependency", "UNKNOWN_PREDECESSOR", (r) => { r.checkpoints[1].predecessors = ["UNKNOWN"]; }],
    ["foreign product scope", "PACKET_SCOPE_ESCAPE", (r) => { r.checkpoints[1].write_scopes = ["apps/eliotr-core/**"]; }],
    ["external gate grants source", "EXTERNAL_SCOPE", (r) => { r.checkpoints[0].write_scopes = ["package.json"]; }],
    ["manager gate accepts single leaf", "GATE_MODE", (r) => { r.checkpoints[5].claim_mode = "single"; }],
  ];
  for (const [name, code, mutation] of registryMutations) test(`registry ${name}`, () => {
    const f = fixture(); mutation(f.registry); write(f.root, registryFile, f.registry);
    assert.throws(() => checkFrontend({ root: f.root }), new RegExp(code, "u"));
  });
  const claimMutations = [
    ["unknown field", "UNKNOWN_FIELD", (c) => { c.allow_override = true; }],
    ["unsupported protocol", "CLAIM_PROTOCOL", (c) => { c.protocol = "future"; }],
    ["manager gate claimed by leaf", "GATE_OR_UNKNOWN_CLAIM", (c) => { c.checkpoint_id = "M"; }],
    ["cross packet placement", "CLAIM_PLACEMENT", (c) => { c.packet_id = "ER-48"; }],
    ["filename identity mismatch", "CLAIM_PLACEMENT", (c) => { c.claim_id = "other"; }],
    ["absolute path", "BAD_PATH", (c) => { c.write_paths = ["C:/private"]; }],
    ["parent path", "BAD_PATH", (c) => { c.write_paths = ["packages/ui/../private"]; }],
    ["backslash path", "BAD_PATH", (c) => { c.write_paths = ["packages\\ui\\src\\a.ts"]; }],
    ["claim glob", "BAD_PATH", (c) => { c.write_paths = ["packages/ui/src/*.ts"]; }],
    ["scope escape", "CLAIM_SCOPE_ESCAPE", (c) => { c.write_paths = ["packages/ui/src/b.ts"]; }],
    ["duplicate physical paths", "CLAIM_PATH_COLLISION", (c) => { c.write_paths.push(c.write_paths[0]); }],
    ["malformed SHA", "CLAIM_BASE", (c) => { c.base_sha = "abcd"; }],
    ["foreign/self predecessor", "FOREIGN_PREDECESSOR", (c, f) => { c.predecessor_refs = [{ checkpoint_id: "A", commit_sha: f.base }]; }],
    ["missing prerequisite", "MISSING_PREDECESSOR", (c) => { c.checkpoint_id = "B"; c.write_paths = ["packages/ui/src/b.ts"]; }],
    ["completion without reviewed evidence", "COMPLETION_EVIDENCE_REQUIRED", (c) => {
      c.state = "HANDED_OFF"; c.handoff_reason = "COMPLETED"; c.handoff_receipt_ref = "https://example.invalid/review/1";
    }],
  ];
  for (const [name, code, mutation] of claimMutations) test(`claim ${name}`, () => {
    const f = fixture(); mutation(f.claim, f); introduce(f); negative(f, code);
  });
  test("missing history arguments fail even if claims were deleted", () => {
    const f = fixture(); introduce(f); assert.throws(() => checkFrontend({ root: f.root }), /HISTORY_ARGUMENTS_REQUIRED/u);
    rmSync(join(f.root, claimFile)); commit(f.root, [claimFile]);
    assert.throws(() => checkFrontend({ root: f.root }), /HISTORY_ARGUMENTS_REQUIRED/u);
  });
  test("unreachable history base fails", () => {
    const f = fixture(); negative(f, "UNREACHABLE_HISTORY_BASE", { historyBase: "0".repeat(40) });
  });
  test("same-commit source and first claim fail", () => {
    const f = fixture(); write(f.root, claimFile, f.claim); write(f.root, "packages/ui/src/a.ts", "export {};\n");
    commit(f.root, [claimFile, "packages/ui/src/a.ts"]); negative(f, "SOURCE_WITHOUT_SINGLE_PRIOR_CLAIM");
  });
  test("source before claim fails", () => {
    const f = fixture(); source(f); introduce(f); negative(f, "SOURCE_WITHOUT_SINGLE_PRIOR_CLAIM");
  });
  test("source outside exact committed claim fails", () => {
    const f = fixture(); introduce(f); source(f, "packages/ui/src/b.ts"); negative(f, "SOURCE_WITHOUT_SINGLE_PRIOR_CLAIM");
  });
  test("uncommitted claim cannot grant uncommitted source", () => {
    const f = fixture(); write(f.root, claimFile, f.claim); write(f.root, "packages/ui/src/a.ts", "export {};\n");
    negative(f, "UNCOMMITTED_CLAIM");
  });
  test("uncommitted source requires committed claim", () => {
    const f = fixture(); write(f.root, "packages/ui/src/a.ts", "export {};\n"); negative(f, "WORKTREE_SOURCE_WITHOUT_PRIOR_CLAIM");
  });
  test("one active claim per checkpoint", () => {
    const f = fixture(); introduce(f); write(f.root, claimFile.replace("a.json", "other.json"), { ...f.claim, claim_id: "other" });
    commit(f.root, [claimFile.replace("a.json", "other.json")]); negative(f, "DUPLICATE_ACTIVE_CHECKPOINT");
  });
  test("different checkpoints cannot overlap physical paths", () => {
    const f = fixture(); introduce(f); write(f.root, claimFile.replace("a.json", "other.json"), { ...f.claim, claim_id: "other", checkpoint_id: "D" });
    commit(f.root, [claimFile.replace("a.json", "other.json")]); negative(f, "OVERLAPPING_CLAIMS");
  });
  test("one active manager context per packet", () => {
    const f = fixture(); introduce(f);
    write(f.root, "marker", "separate ancestor\n"); const basis = commit(f.root, ["marker"]);
    write(f.root, claimFile.replace("a.json", "b.json"), { ...f.claim, claim_id: "b", checkpoint_id: "B", manager_context_id: "other",
      base_sha: basis, write_paths: ["packages/ui/src/b.ts"], predecessor_refs: [{ checkpoint_id: "A", commit_sha: f.base }] });
    commit(f.root, [claimFile.replace("a.json", "b.json")]); negative(f, "MULTIPLE_MANAGER_CONTEXTS");
  });
  test("gate approval and strict predecessor ancestry", () => {
    for (const mode of ["missing", "self", "valid"]) {
      const f = fixture(); write(f.root, "marker", "ancestor\n"); const basis = commit(f.root, ["marker"]);
      f.claim.checkpoint_id = "G"; f.claim.write_paths = ["packages/ui/src/g.ts"]; f.claim.base_sha = basis;
      f.claim.predecessor_refs = [{ checkpoint_id: "B-U", commit_sha: mode === "self" ? basis : f.base,
        ...(mode !== "missing" ? { approval_ref: "https://example.invalid/approval/1" } : {}) }];
      introduce(f);
      if (mode === "valid") assert.equal(check(f).status, "PASS");
      else negative(f, mode === "missing" ? "GATE_APPROVAL_REQUIRED" : "PREDECESSOR_ANCESTRY");
    }
  });
  test("immutable authorization and intermediate blob mutation fail", () => {
    const f = fixture(); introduce(f);
    updateClaim(f, (c) => { c.owner_authorization_ref = "https://example.invalid/forged"; });
    updateClaim(f, (c) => { c.owner_authorization_ref = "https://example.invalid/owner/1"; });
    negative(f, "IMMUTABLE_CLAIM_FIELD");
  });
  test("evidence cannot be rewritten or removed", () => {
    const f = fixture(); introduce(f); updateClaim(f, (c) => { c.evidence_refs.push("https://example.invalid/evidence/1"); });
    updateClaim(f, (c) => { c.evidence_refs = []; }); negative(f, "EVIDENCE_NOT_APPEND_ONLY");
  });
  test("handoff is irreversible and reason cannot be replaced", () => {
    for (const mode of ["reactivate", "reason"]) {
      const f = fixture(); introduce(f); source(f); complete(f);
      updateClaim(f, (c) => { if (mode === "reactivate") {
        c.state = "ACTIVE"; delete c.handoff_reason; delete c.handoff_receipt_ref;
      } else c.handoff_reason = "BLOCKED"; }); negative(f, "ILLEGAL_HANDOFF_TRANSITION");
    }
  });
  test("claim deletion, rename and delete/recreate fail", () => {
    for (const mode of ["delete", "rename", "recreate"]) {
      const f = fixture(); introduce(f); rmSync(join(f.root, claimFile)); commit(f.root, [claimFile]);
      if (mode === "rename") {
        write(f.root, claimFile.replace("a.json", "other.json"), { ...f.claim, claim_id: "other" });
        commit(f.root, [claimFile.replace("a.json", "other.json")]);
      } else if (mode === "recreate") introduce(f);
      negative(f, "CLAIM_DELETE_OR_RENAME");
    }
  });
  test("unauthorized takeover and replacement while old active fail", () => {
    const f = fixture(); introduce(f);
    write(f.root, claimFile.replace("a.json", "replacement.json"), { ...f.claim, claim_id: "replacement", supersedes_claim_id: "a" });
    commit(f.root, [claimFile.replace("a.json", "replacement.json")]); negative(f, "DUPLICATE_ACTIVE_CHECKPOINT");
    const g = fixture(); introduce(g); complete(g, "ABANDONED");
    write(g.root, claimFile.replace("a.json", "replacement.json"), { ...g.claim, claim_id: "replacement", state: "ACTIVE",
      supersedes_claim_id: "a", handoff_reason: undefined, handoff_receipt_ref: undefined });
    commit(g.root, [claimFile.replace("a.json", "replacement.json")]); negative(g, "UNAUTHORIZED_SUPERSESSION");
  });
  test("authorized recovery remains append-only and covers next source", () => {
    const f = fixture(); introduce(f); source(f);
    updateClaim(f, (c) => { c.state = "HANDED_OFF"; c.handoff_reason = "SUPERSEDED";
      c.handoff_receipt_ref = "https://example.invalid/handoff"; c.takeover_authorization_ref = "https://example.invalid/owner/2"; });
    const replacement = { ...f.claim, claim_id: "replacement", manager_context_id: "replacement-context", base_sha: git(f.root, "rev-parse", "HEAD"),
      owner_authorization_ref: "https://example.invalid/owner/2", supersedes_claim_id: "a", state: "ACTIVE",
      handoff_reason: undefined, handoff_receipt_ref: undefined, takeover_authorization_ref: undefined };
    write(f.root, claimFile.replace("a.json", "replacement.json"), replacement);
    commit(f.root, [claimFile.replace("a.json", "replacement.json")]); source(f); assert.equal(check(f).active, 1);
  });
  test("history base cannot clip first claim or intermediate history", () => {
    const f = fixture(); const intro = introduce(f); source(f);
    negative(f, "HISTORY_BASE_MISMATCH|HISTORY_BASE_CLIPS_CLAIMS", { historyBase: intro });
  });
  test("historical source uses parent registry, never a later broadened rule", () => {
    const f = fixture(); introduce(f); source(f, "packages/ui/src/unregistered.ts");
    f.registry.checkpoints.push(row("LATER", "manager_gate", ["packages/ui/src/unregistered.ts"]));
    write(f.root, registryFile, f.registry); commit(f.root, [registryFile]); negative(f, "UNREGISTERED_OWNED_PATH");
  });
  test("merge parents preserve immutable claim and permit unrelated branch", () => {
    const f = fixture(); introduce(f); source(f);
    git(f.root, "checkout", "-b", "unrelated", f.base); write(f.root, "unrelated", "non-product\n"); commit(f.root, ["unrelated"]);
    git(f.root, "checkout", "main"); git(f.root, "merge", "--no-ff", "--no-edit", "unrelated");
    assert.equal(check(f).status, "PASS");
  });
} finally {
  for (const root of temporaryRoots) {
    const tempBase = resolve(tmpdir()); const target = resolve(root); const within = relative(tempBase, target);
    if (!within || within.startsWith("..") || isAbsolute(within) || !within.startsWith("eliotr-scheduler-")) {
      failed++; console.error("FAIL unsafe temporary cleanup target refused"); continue;
    }
    rmSync(target, { recursive: true, force: true });
  }
}
console.log(`Frontend checkpoint negatives: ${passed} passed, ${failed} failed; temporary repositories removed.`);
if (failed) process.exitCode = 1;
